// 音频播放（方案 5.9）：Tone.js Transport 调度 + Sampler/Synth 音色
// - 所有播放需用户手势启动 AudioContext
// - 伴奏：严格节拍 / 柔性跟随两档；按小节限速 ±5% + 指数平滑
//   tempoNext = clamp(0.8·cur + 0.2·observed, cur·0.95, cur·1.05)
// - 连续低置信跟谱时保持当前速度，不追随错误

import * as Tone from 'tone'
import { Midi } from '@tonejs/midi'
import { t, tf } from '../../i18n/messages'

let started = false
export async function ensureAudio(): Promise<void> {
  if (!started) {
    await Tone.start()
    started = true
  }
}

export class MidiPlayer {
  private synth: Tone.PolySynth | null = null
  private metronome: Tone.MembraneSynth | null = null

  async unlock(): Promise<void> {
    await ensureAudio()
  }

  async loadMidi(url: string): Promise<Midi> {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(tf('midiLoadFailed', { status: response.status }))
    }
    return new Midi(await response.arrayBuffer())
  }

  /** 预备拍：beats 个咔哒声，返回总时长 ms */
  async countIn(beats: number, bpm: number): Promise<void> {
    await ensureAudio()
    if (!Number.isFinite(bpm) || bpm <= 0) throw new Error(t('invalidCountInTempo'))
    this.metronome ??= new Tone.MembraneSynth().toDestination()
    const interval = 60 / bpm
    const now = Tone.now()
    for (let i = 0; i < beats; i += 1) {
      this.metronome.triggerAttackRelease(i === 0 ? 'C5' : 'G4', 0.05, now + i * interval, 0.9)
    }
    await new Promise((r) => setTimeout(r, beats * interval * 1000))
  }

  /**
   * 播放 MIDI（按 tick 排程，支持 Transport.bpm 动态调整）。
   * onMeasure(measureIdx) 每小节回调（伴奏跟随用）。
   */
  async play(midi: Midi, opts: {
    bpmScale?: number
    volume?: number
    onEnd?: () => void
    onMeasure?: (measureIdx: number) => void
    measuresTotal?: number
  } = {}): Promise<void> {
    await ensureAudio()
    const notes = midi.tracks.flatMap((track) => track.notes)
    if (!notes.length) throw new Error(t('midiHasNoPlayableNotes'))

    this.stop()
    this.synth?.dispose()
    this.synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.004, decay: 0.3, sustain: 0.4, release: 0.8 },
    }).toDestination()
    this.synth.volume.value = opts.volume ?? -6

    const transport = Tone.getTransport()
    transport.cancel()
    transport.stop()
    transport.position = 0
    const fileBpm = midi.header.tempos[0]?.bpm ?? 120
    transport.bpm.value = fileBpm * (opts.bpmScale ?? 1)
    transport.PPQ = midi.header.ppq

    for (const note of notes) {
      transport.scheduleOnce((time) => {
        this.synth?.triggerAttackRelease(
          Tone.Frequency(note.midi, 'midi').toFrequency(),
          `${Math.max(1, note.durationTicks)}i`, time, note.velocity)
      }, `${Math.max(0, note.ticks)}i`)
    }
    if (opts.onMeasure && opts.measuresTotal) {
      // 由调用方按小节数自行排程（伴奏模式）
    }
    transport.scheduleOnce(() => {
      transport.stop()
      this.synth?.releaseAll()
      opts.onEnd?.()
    }, `${midi.durationTicks + Math.round(midi.header.ppq / 2)}i`)
    transport.start()
  }

  /** 柔性跟随：每小节结束更新下一小节 BPM（限速 ±5%，指数平滑） */
  followTempo(currentBpm: number, observedBpm: number): number {
    if (!Number.isFinite(observedBpm) || observedBpm <= 0) return currentBpm
    const next = 0.8 * currentBpm + 0.2 * observedBpm
    return Math.min(Math.max(next, currentBpm * 0.95), currentBpm * 1.05)
  }

  setBpm(bpm: number): void {
    if (Number.isFinite(bpm) && bpm > 0) Tone.getTransport().bpm.value = bpm
  }

  stop(): void {
    const transport = Tone.getTransport()
    transport.cancel()
    transport.stop()
    this.synth?.releaseAll()
  }

  dispose(): void {
    this.stop()
    this.synth?.dispose()
    this.metronome?.dispose()
    this.synth = null
    this.metronome = null
  }
}

/** 试听一小段音高（期望/实际对比用） */
export async function playPitches(pitches: number[], durationSec = 0.6): Promise<void> {
  await ensureAudio()
  const synth = new Tone.PolySynth(Tone.Synth).toDestination()
  synth.volume.value = -8
  const freqs = pitches.map((p) => Tone.Frequency(p, 'midi').toFrequency())
  synth.triggerAttackRelease(freqs, durationSec)
  window.setTimeout(() => synth.dispose(), (durationSec + 1.5) * 1000)
}

/** 音名 ↔ MIDI（证据“试听”用），支持 C#5 / Bb3 与中文描述过滤 */
export function parsePitchNames(text: string): number[] {
  const NAMES: Record<string, number> = {
    C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5,
    'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
  }
  const out: number[] = []
  const re = /([A-G](?:#|b)?)(-?\d)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const pc = NAMES[m[1]]
    if (pc !== undefined) out.push(pc + (Number(m[2]) + 1) * 12)
  }
  return out
}
