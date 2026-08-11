// MIDI 采集与校准（方案 5.2 / 10.1 伪代码）
// - requestMIDIAccess + midimessage/statechange
// - velocity=0 的 Note On 视为 Note Off
// - performance.now() 单调时钟
// - 踏板 CC64 独立保存
// - 每 2 秒增量写入 IndexedDB（刷新/断网不丢整段记录）
// - 70ms 和弦窗口聚合（方案 5.3）

import type { PerformanceEvent } from '../../types'
import { t } from '../../i18n/messages'
import type {
  InputDeviceDescriptor, PerformanceCaptureResult, PerformanceInputAdapter,
} from '../input/PerformanceInputAdapter'
import type { InstrumentProfile } from '../../types'

export interface MidiGroup {
  id: string
  tOnMs: number
  tOffMs: number
  pitches: number[]
  velocities: number[]
  eventIds: string[]
}

export type GroupHandler = (g: MidiGroup) => void
export type StateHandler = (state: string) => void
export type LiveNoteHandler = (pitch: number, velocity: number, on: boolean, receivedTimeMs: number) => void
export type BatchHandler = (
  sessionId: string, batchId: string, sequence: number, events: PerformanceEvent[]
) => Promise<unknown>
export interface InputHealth {
  duplicateMessages: number
  jitterMs: number | null
  tapCount: number
}
export type HealthHandler = (health: InputHealth) => void

const NOTE_ON = 0x90
const NOTE_OFF = 0x80
const CONTROL_CHANGE = 0xb0
const CHORD_WINDOW_MS = 70

interface ActiveNote {
  id: string
  tOn: number
  receivedTimeMs: number
  velocity: number
  pitch: number
  channel: number
}

export class MidiCapture implements PerformanceInputAdapter {
  readonly source = 'web-midi' as const
  private access: MIDIAccess | null = null
  private input: MIDIInput | null = null
  private active = new Map<string, ActiveNote[]>()
  private chordBuffer: { pitch: number; tOn: number; velocity: number; id: string }[] = []
  private flushTimer: number | null = null
  private events: PerformanceEvent[] = []
  private pedals: { down: boolean; time: number }[] = []
  private noteSeq = 0
  private groupSeq = 0
  private persistTimer: number | null = null
  private sessionKey = ''
  private capturing = false
  private acknowledgedEventIds = new Set<string>()
  private remoteBatch: { id: string; sequence: number; events: PerformanceEvent[] } | null = null
  private remoteSequence = 0
  private mirrorPromise: Promise<void> | null = null
  private duplicateMessages = 0
  private tapTimes: number[] = []
  private lastRawMessage: { signature: string; time: number } | null = null

  onGroup: GroupHandler | null = null
  onStateChange: StateHandler | null = null
  onLiveNote: LiveNoteHandler | null = null
  onBatch: BatchHandler | null = null
  onHealth: HealthHandler | null = null
  onDeviceLost: ((name: string) => void) | null = null

  async connect(deviceId?: string): Promise<InputDeviceDescriptor[]> {
    const names = await this.requestAccess()
    if (deviceId) this.selectInput(deviceId)
    return names.map((name) => ({ id: name, label: name }))
  }

  start(sessionId: string, _instrument: InstrumentProfile): void {
    this.startCapture(sessionId)
  }

  stop(): PerformanceCaptureResult {
    return { events: this.stopCapture() }
  }

  async recover(sessionId: string, _instrument: InstrumentProfile):
  Promise<PerformanceCaptureResult | null> {
    const events = await MidiCapture.recover(sessionId)
    return events.length ? { events } : null
  }

  async discard(sessionId: string): Promise<void> {
    await MidiCapture.clearRecovery(sessionId)
  }

  async requestAccess(): Promise<string[]> {
    if (!navigator.requestMIDIAccess) {
      throw Object.assign(new Error(t('midiUnsupported')), { code: 'MIDI_UNSUPPORTED' })
    }
    this.access = await navigator.requestMIDIAccess({ sysex: false })
    this.access.onstatechange = (event) => {
      const port = event.port
      if (!port) {
        this.onStateChange?.(t('midiStateChanged'))
        return
      }
      const name = port.name || port.id
      this.onStateChange?.(`${name}：${port.state === 'connected' ? t('connected') : t('disconnected')}`)
      if (port.state === 'disconnected' && this.input && port.id === this.input.id) {
        this.onDeviceLost?.(name)
      }
    }
    return this.listInputs()
  }

  listInputs(): string[] {
    if (!this.access) return []
    const names: string[] = []
    this.access.inputs.forEach((input) => {
      if (input.state === 'connected') names.push(input.name || input.id)
    })
    return names
  }

  selectInput(name: string): boolean {
    if (!this.access) return false
    let found: MIDIInput | null = null
    this.access.inputs.forEach((input) => {
      if (input.state === 'connected' && (input.name || input.id) === name) found = input
    })
    if (!found) return false
    if (this.input) this.input.onmidimessage = null
    this.input = found as MIDIInput
    void this.input.open()
    ;(this.input as MIDIInput).onmidimessage = (m: MIDIMessageEvent) => this.handleMessage(m)
    return true
  }

  startCapture(sessionKey: string): void {
    if (this.persistTimer) window.clearInterval(this.persistTimer)
    if (this.flushTimer) window.clearTimeout(this.flushTimer)
    this.persistTimer = null
    this.flushTimer = null
    this.events = []
    this.pedals = []
    this.noteSeq = 0
    this.groupSeq = 0
    this.active.clear()
    this.chordBuffer = []
    this.sessionKey = sessionKey
    this.capturing = true
    this.acknowledgedEventIds.clear()
    this.remoteBatch = null
    this.remoteSequence = 0
    this.mirrorPromise = null
    this.duplicateMessages = 0
    this.tapTimes = []
    this.lastRawMessage = null
    this.persistTimer = window.setInterval(() => this.persist(), 2000)
  }

  stopCapture(options: { persist?: boolean } = {}): PerformanceEvent[] {
    if (this.persistTimer) window.clearInterval(this.persistTimer)
    this.persistTimer = null
    if (this.flushTimer) window.clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.flushChord()
    const now = performance.now()
    for (const notes of this.active.values()) {
      for (const note of notes) {
        this.finishNote(note, now)
        this.onLiveNote?.(note.pitch, 0, false, now)
      }
    }
    this.active.clear()
    this.capturing = false
    this.events.sort((a, b) => a.tOnMs - b.tOnMs || a.pitch - b.pitch)
    if (options.persist !== false) this.persist()
    return [...this.events]
  }

  dispose(): void {
    this.onGroup = null
    this.onStateChange = null
    this.onLiveNote = null
    this.onBatch = null
    this.onHealth = null
    this.onDeviceLost = null
    if (this.capturing) {
      this.stopCapture()
    } else {
      if (this.persistTimer) window.clearInterval(this.persistTimer)
      if (this.flushTimer) window.clearTimeout(this.flushTimer)
      this.persistTimer = null
      this.flushTimer = null
    }
    if (this.input) {
      this.input.onmidimessage = null
      void this.input.close()
    }
    if (this.access) this.access.onstatechange = null
    this.input = null
    this.access = null
  }

  /** 方案 10.1 MIDI 消息处理伪代码 */
  private handleMessage(message: MIDIMessageEvent): void {
    const data = message.data
    if (!data || data.length < 3) return
    const status = data[0]
    const command = status & 0xf0
    const channel = status & 0x0f
    const d1 = data[1]
    const d2 = data[2]
    const now = performance.now()
    const receivedTimeMs = (message as MIDIMessageEvent & { receivedTime?: number }).receivedTime || now
    const signature = `${status}:${d1}:${d2}`
    if (this.lastRawMessage?.signature === signature &&
        Math.abs(receivedTimeMs - this.lastRawMessage.time) < 1) {
      this.duplicateMessages += 1
      this.emitHealth()
      return
    }
    this.lastRawMessage = { signature, time: receivedTimeMs }

    if (command === NOTE_ON && d2 > 0) {
      this.tapTimes.push(receivedTimeMs)
      this.tapTimes = this.tapTimes.slice(-5)
      this.emitHealth()
      this.onLiveNote?.(d1, d2, true, receivedTimeMs)
      if (!this.capturing) return
      this.noteSeq += 1
      const id = `pe_${this.noteSeq}`
      const key = `${channel}:${d1}`
      const notes = this.active.get(key) ?? []
      notes.push({ id, tOn: now, receivedTimeMs, velocity: d2, pitch: d1, channel })
      this.active.set(key, notes)
      this.chordBuffer.push({ pitch: d1, tOn: now, velocity: d2, id })
      if (this.flushTimer) window.clearTimeout(this.flushTimer)
      this.flushTimer = window.setTimeout(() => this.flushChord(), CHORD_WINDOW_MS)
    } else if (command === NOTE_OFF || (command === NOTE_ON && d2 === 0)) {
      if (this.capturing) {
        const key = `${channel}:${d1}`
        const notes = this.active.get(key)
        const start = notes?.shift()
        if (start) this.finishNote(start, now)
        if (notes && notes.length === 0) this.active.delete(key)
      }
      this.onLiveNote?.(d1, 0, false, receivedTimeMs)
    } else if (command === CONTROL_CHANGE && d1 === 64) {
      if (this.capturing) this.pedals.push({ down: d2 >= 64, time: now })
    }
  }

  private finishNote(note: ActiveNote, tOffMs: number): void {
    this.events.push({
      id: note.id,
      tOnMs: note.tOn,
      tOffMs: Math.max(note.tOn, tOffMs),
      pitch: note.pitch,
      velocity: note.velocity,
      channel: note.channel,
      source: 'web-midi',
      pedalDown: this.isPedalDown(note.tOn),
      receivedTimeMs: note.receivedTimeMs,
    })
  }

  private flushChord(): void {
    if (!this.chordBuffer.length) return
    const buf = this.chordBuffer
    this.chordBuffer = []
    this.groupSeq += 1
    this.onGroup?.({
      id: `g_${this.groupSeq}`,
      tOnMs: Math.min(...buf.map((b) => b.tOn)),
      tOffMs: 0,
      pitches: [...new Set(buf.map((b) => b.pitch))].sort((a, b) => a - b),
      velocities: buf.map((b) => b.velocity),
      eventIds: buf.map((b) => b.id),
    })
  }

  private isPedalDown(t: number): boolean {
    let down = false
    for (const p of this.pedals) {
      if (p.time <= t) down = p.down
      else break
    }
    return down
  }

  private emitHealth(): void {
    const intervals = this.tapTimes.slice(1).map((time, index) => time - this.tapTimes[index])
    const mean = intervals.length
      ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length
      : 0
    const jitterMs = intervals.length >= 2
      ? Math.sqrt(intervals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / intervals.length)
      : null
    this.onHealth?.({
      duplicateMessages: this.duplicateMessages,
      jitterMs: jitterMs === null ? null : Math.round(jitterMs * 10) / 10,
      tapCount: Math.min(this.tapTimes.length, 5),
    })
  }

  private persist(): void {
    const sessionKey = this.sessionKey
    if (!sessionKey) return
    const events = this.events.map((event) => ({ ...event }))
    const now = performance.now()
    const eventIds = new Set(events.map((event) => event.id))
    for (const notes of this.active.values()) {
      for (const note of notes) {
        if (eventIds.has(note.id)) continue
        events.push({
          id: note.id,
          tOnMs: note.tOn,
          tOffMs: Math.max(note.tOn, now),
          pitch: note.pitch,
          velocity: note.velocity,
          channel: note.channel,
          source: 'web-midi',
          pedalDown: this.isPedalDown(note.tOn),
          receivedTimeMs: note.receivedTimeMs,
        })
      }
    }
    events.sort((a, b) => a.tOnMs - b.tOnMs || a.pitch - b.pitch)
    try {
      const req = indexedDB.open('ai-music-mentor', 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore('recordings')
      }
      req.onsuccess = () => {
        const tx = req.result.transaction('recordings', 'readwrite')
        tx.objectStore('recordings').put(
          { events, savedAt: Date.now() }, sessionKey)
      }
    } catch { /* IndexedDB 不可用时静默 */ }
    void this.mirrorPending()
  }

  /** Immediately checkpoint completed and currently-held notes locally. */
  checkpoint(): void {
    this.persist()
  }

  private mirrorPending(): Promise<void> {
    if (!this.onBatch || !this.sessionKey) return Promise.resolve()
    if (this.mirrorPromise) return this.mirrorPromise
    if (!this.remoteBatch) {
      const pending = this.events.filter((event) => !this.acknowledgedEventIds.has(event.id))
      if (!pending.length) return Promise.resolve()
      this.remoteSequence += 1
      this.remoteBatch = {
        id: `batch-${this.sessionKey}-${this.remoteSequence}`,
        sequence: this.remoteSequence,
        events: pending.map((event) => ({ ...event })),
      }
    }
    const batch = this.remoteBatch
    this.mirrorPromise = this.onBatch(this.sessionKey, batch.id, batch.sequence, batch.events)
      .then(() => {
        batch.events.forEach((event) => this.acknowledgedEventIds.add(event.id))
        if (this.remoteBatch?.id === batch.id) this.remoteBatch = null
      })
      .catch(() => { /* retry the same idempotency key on the next local flush */ })
      .finally(() => { this.mirrorPromise = null })
    return this.mirrorPromise
  }

  async flushBatches(): Promise<void> {
    this.persist()
    await this.mirrorPending()
    await this.mirrorPending()
  }

  /** 恢复未提交记录（刷新后） */
  static recover(sessionKey: string): Promise<PerformanceEvent[]> {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open('ai-music-mentor', 1)
        req.onupgradeneeded = () => { req.result.createObjectStore('recordings') }
        req.onsuccess = () => {
          const tx = req.result.transaction('recordings', 'readonly')
          const get = tx.objectStore('recordings').get(sessionKey)
          get.onsuccess = () => resolve(get.result?.events ?? [])
          get.onerror = () => resolve([])
        }
        req.onerror = () => resolve([])
      } catch { resolve([]) }
    })
  }

  static clearRecovery(sessionKey: string): Promise<void> {
    if (!sessionKey) return Promise.resolve()
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open('ai-music-mentor', 1)
        req.onupgradeneeded = () => { req.result.createObjectStore('recordings') }
        req.onsuccess = () => {
          const tx = req.result.transaction('recordings', 'readwrite')
          tx.objectStore('recordings').delete(sessionKey)
          tx.oncomplete = () => resolve()
          tx.onerror = () => resolve()
          tx.onabort = () => resolve()
        }
        req.onerror = () => resolve()
      } catch { resolve() }
    })
  }
}
