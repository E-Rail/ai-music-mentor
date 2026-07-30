// MIDI 采集与校准（方案 5.2 / 10.1 伪代码）
// - requestMIDIAccess + midimessage/statechange
// - velocity=0 的 Note On 视为 Note Off
// - performance.now() 单调时钟
// - 踏板 CC64 独立保存
// - 每 2 秒增量写入 IndexedDB（刷新/断网不丢整段记录）
// - 70ms 和弦窗口聚合（方案 5.3）

import type { PerformanceEvent } from '../../types'

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
export type LiveNoteHandler = (pitch: number, velocity: number, on: boolean) => void

const NOTE_ON = 0x90
const NOTE_OFF = 0x80
const CONTROL_CHANGE = 0xb0
const CHORD_WINDOW_MS = 70

export class MidiCapture {
  private access: MIDIAccess | null = null
  private input: MIDIInput | null = null
  private active = new Map<string, { tOn: number; velocity: number; pitch: number; channel: number }>()
  private chordBuffer: { pitch: number; tOn: number; velocity: number; id: string }[] = []
  private flushTimer: number | null = null
  private events: PerformanceEvent[] = []
  private pedals: { down: boolean; time: number }[] = []
  private noteSeq = 0
  private groupSeq = 0
  private persistTimer: number | null = null
  private sessionKey = ''

  onGroup: GroupHandler | null = null
  onStateChange: StateHandler | null = null
  onLiveNote: LiveNoteHandler | null = null

  async requestAccess(): Promise<string[]> {
    if (!navigator.requestMIDIAccess) {
      throw Object.assign(new Error('当前浏览器不支持 Web MIDI，请使用 Chromium 系浏览器'), { code: 'MIDI_UNSUPPORTED' })
    }
    this.access = await navigator.requestMIDIAccess({ sysex: false })
    this.access.onstatechange = () => {
      this.onStateChange?.('设备状态变化，请检查连接')
    }
    return this.listInputs()
  }

  listInputs(): string[] {
    if (!this.access) return []
    const names: string[] = []
    this.access.inputs.forEach((i) => names.push(i.name || i.id))
    return names
  }

  selectInput(name: string): boolean {
    if (!this.access) return false
    let found: MIDIInput | null = null
    this.access.inputs.forEach((i) => {
      if ((i.name || i.id) === name) found = i
    })
    if (!found) return false
    if (this.input) this.input.onmidimessage = null
    this.input = found as MIDIInput
    ;(this.input as MIDIInput).onmidimessage = (m: MIDIMessageEvent) => this.handleMessage(m)
    return true
  }

  startCapture(sessionKey: string): void {
    this.events = []
    this.pedals = []
    this.noteSeq = 0
    this.groupSeq = 0
    this.active.clear()
    this.chordBuffer = []
    this.sessionKey = sessionKey
    this.persistTimer = window.setInterval(() => this.persist(), 2000)
  }

  stopCapture(): PerformanceEvent[] {
    if (this.persistTimer) window.clearInterval(this.persistTimer)
    this.persistTimer = null
    this.persist()
    return [...this.events]
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

    if (command === NOTE_ON && d2 > 0) {
      this.noteSeq += 1
      const id = `pe_${this.noteSeq}`
      this.active.set(`${channel}:${d1}`, { tOn: now, velocity: d2, pitch: d1, channel })
      this.chordBuffer.push({ pitch: d1, tOn: now, velocity: d2, id })
      this.onLiveNote?.(d1, d2, true)
      if (this.flushTimer) window.clearTimeout(this.flushTimer)
      this.flushTimer = window.setTimeout(() => this.flushChord(), CHORD_WINDOW_MS)
    } else if (command === NOTE_OFF || (command === NOTE_ON && d2 === 0)) {
      const start = this.active.get(`${channel}:${d1}`)
      if (start) {
        this.active.delete(`${channel}:${d1}`)
        this.events.push({
          id: `pe_${this.events.length + 1}`, tOnMs: start.tOn, tOffMs: now,
          pitch: d1, velocity: start.velocity, channel, source: 'web-midi',
          pedalDown: this.isPedalDown(start.tOn),
        })
      }
      this.onLiveNote?.(d1, 0, false)
    } else if (command === CONTROL_CHANGE && d1 === 64) {
      this.pedals.push({ down: d2 >= 64, time: now })
    }
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

  private persist(): void {
    if (!this.sessionKey) return
    try {
      const req = indexedDB.open('ai-music-mentor', 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore('recordings')
      }
      req.onsuccess = () => {
        const tx = req.result.transaction('recordings', 'readwrite')
        tx.objectStore('recordings').put(
          { events: this.events, savedAt: Date.now() }, this.sessionKey)
      }
    } catch { /* IndexedDB 不可用时静默 */ }
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
}
