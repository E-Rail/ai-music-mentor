/**
 * What the player is doing right now — as one shape, for every input source.
 *
 * The old live layer answered "which note should they be playing?". This one
 * answers "which note did they play, where did it land, and how does it compare
 * to the page?". The played note is the subject of every field here; the score
 * target is context for it. That ordering is what lets the staff show a student
 * their own wrong note in its own place instead of colouring the note they
 * failed to play.
 */
import type { InputSource, ScoreEvent } from '../../types'
import {
  MAX_TRUSTED_BEATS_OFF, PerformanceClock, UNPLACED, absoluteBeatOf,
  type TimingLabel, type TimingVerdict,
} from './performanceClock'
import {
  buildLiveTargets, relativeBeatOf,
  type ExpectedNote, type LiveTarget,
} from './liveTargets'
import { PassageProgress, type StrikeOutcome } from './passageProgress'

/**
 * `corrected` is a match that arrived after a wrong attempt at the same place.
 * It is neither a clean hit nor an outstanding mistake, and a student watching
 * the cursor deserves to see the difference.
 */
export type LiveMatchStatus =
  | 'idle' | 'waiting' | 'match' | 'partial' | 'different' | 'corrected'

/** How many played notes the live trace keeps on screen. */
export const TRACE_LIMIT = 24

export interface PlayedPitch {
  pitch: number
  /** `matched` also appears in the score here; `extra` is the player's own. */
  role: 'matched' | 'extra'
}

export interface LiveTraceNote {
  id: string
  pitch: number
  atMs: number
  beatsFromStart: number
  status: LiveMatchStatus
  timing: TimingLabel
  deltaMs: number
}

export interface LivePerformanceState {
  status: LiveMatchStatus
  source: InputSource
  /** Exactly what sounded, each pitch classified against the score. */
  played: PlayedPitch[]
  playedAtMs: number | null
  /** Score pitches at this position that did not sound. */
  missing: number[]
  /** The same notes with the hand that wrote each one. */
  outstanding: ExpectedNote[]
  /** Holding here until a wrong note is corrected or the player skips it. */
  blocked: boolean
  /** The score position the player is on. */
  target: LiveTarget | null
  timing: TimingVerdict | null
  startedAtMs: number | null
  /** True until the player's first note lands. */
  awaitingFirstNote: boolean
}

export function idleLiveState(source: InputSource): LivePerformanceState {
  return {
    status: 'idle', source, played: [], playedAtMs: null, missing: [],
    outstanding: [], blocked: false,
    target: null, timing: null, startedAtMs: null, awaitingFirstNote: true,
  }
}

/**
 * Split what was played against what is still outstanding at this position.
 * Pure, and the single place the app decides whether a note "counts".
 *
 * `expected` is the remainder, not the whole chord: once the right hand has
 * landed, only the left hand is still owed, and replaying the right hand is
 * neither a new match nor a mistake.
 */
export function classifyStrike(
  outcome: StrikeOutcome,
): { pitches: PlayedPitch[]; missing: number[]; status: LiveMatchStatus } {
  const pitches: PlayedPitch[] = [
    ...outcome.accepted.map((pitch) => ({ pitch, role: 'matched' as const })),
    ...outcome.repeated.map((pitch) => ({ pitch, role: 'matched' as const })),
    ...outcome.wrong.map((pitch) => ({ pitch, role: 'extra' as const })),
  ].sort((left, right) => left.pitch - right.pitch)
  const missing = outcome.outstanding.map((note) => note.pitch)
  if (!pitches.length) return { pitches, missing, status: 'waiting' }
  const status: LiveMatchStatus = outcome.wrong.length
    ? (outcome.accepted.length ? 'partial' : 'different')
    : outcome.completed ? 'match' : 'partial'
  return { pitches, missing, status }
}

export interface LiveSessionOptions {
  events: ScoreEvent[]
  rangeStart: number
  rangeEnd: number
  bpm: number
  beatsPerMeasure: number
  source: InputSource
}

export interface LiveObservation {
  pitches: number[]
  atMs: number
}

/** Tempo is only re-estimated once the player has given this much to go on. */
const TEMPO_ANCHORS = 8

/**
 * Owns the live picture for one take: the player's clock, the passage, the
 * rolling trace, and the current state. One instance serves USB MIDI and the
 * microphone so the two can never disagree about where the player is.
 */
export class LivePerformanceTracker {
  private targets: LiveTarget[] = []
  private progress = new PassageProgress()
  private clock = new PerformanceClock(96, 4)
  private trace: LiveTraceNote[] = []
  private source: InputSource = 'web-midi'
  private current: LivePerformanceState = idleLiveState('web-midi')
  private sequence = 0
  /** Score beat of the last position whose timing was judged. */
  private lastJudgedBeat: number | null = null
  /** Positions already timed, so the second hand does not re-time the first. */
  private timed = new Set<number>()
  /** Positions the player got wrong before getting right. */
  private stumbled = new Set<number>()
  /** (beat, ms) pairs the player has actually produced, for their own tempo. */
  private anchors: { beat: number; atMs: number }[] = []

  /**
   * Timing is only claimed when there is a position worth measuring against.
   * A position held open by a wrong note, or completed by a second hand
   * arriving late, has no new onset to measure — reporting "late by 3251 ms"
   * there would state a fact the app does not have.
   */
  private trust(verdict: TimingVerdict, beat: number): TimingVerdict {
    if (verdict.reference === 'anchor') return verdict
    const advanced = this.lastJudgedBeat === null || beat > this.lastJudgedBeat + 1e-6
    if (!advanced) return UNPLACED
    if (Math.abs(verdict.beatsOff) > MAX_TRUSTED_BEATS_OFF) return UNPLACED
    return verdict
  }

  /**
   * The player's own tempo, from the notes they have actually produced. The
   * median of the recent beat-to-time intervals ignores one hesitant note in a
   * way a running average does not.
   */
  private updateTempo(): void {
    const recent = this.anchors.slice(-TEMPO_ANCHORS)
    if (recent.length < 3) return
    const intervals: number[] = []
    for (let index = 1; index < recent.length; index += 1) {
      const beats = recent[index].beat - recent[index - 1].beat
      const ms = recent[index].atMs - recent[index - 1].atMs
      if (beats > 0 && ms > 0) intervals.push(ms / beats)
    }
    if (intervals.length < 2) return
    intervals.sort((left, right) => left - right)
    const median = intervals[Math.floor(intervals.length / 2)]
    if (median > 0) this.clock.observeTempo(60_000 / median)
  }

  private snapshot(
    status: LiveMatchStatus, played: PlayedPitch[], playedAtMs: number | null,
    outcome: StrikeOutcome, timing: TimingVerdict | null,
  ): LivePerformanceState {
    this.current = {
      status,
      source: this.source,
      played,
      playedAtMs,
      missing: outcome.outstanding.map((note) => note.pitch),
      outstanding: outcome.outstanding,
      blocked: outcome.blocked,
      target: outcome.target,
      timing,
      startedAtMs: this.clock.startedAtMs,
      awaitingFirstNote: false,
    }
    return this.current
  }

  begin(options: LiveSessionOptions): LivePerformanceState {
    this.targets = buildLiveTargets(
      options.events, options.rangeStart, options.rangeEnd)
    this.progress = new PassageProgress(this.targets)
    this.clock = new PerformanceClock(options.bpm, options.beatsPerMeasure)
    this.trace = []
    this.sequence = 0
    this.lastJudgedBeat = null
    this.timed = new Set()
    this.stumbled = new Set()
    this.anchors = []
    this.source = options.source
    const first = this.targets[0] ?? null
    this.current = {
      ...idleLiveState(options.source),
      status: 'waiting',
      target: first,
      missing: first?.pitches ?? [],
      outstanding: first?.expected ?? [],
    }
    return this.current
  }

  reset(): void {
    this.clock.reset()
    this.progress.reset()
    this.trace = []
    this.sequence = 0
    this.lastJudgedBeat = null
    this.timed = new Set()
    this.stumbled = new Set()
    this.anchors = []
    this.current = idleLiveState(this.source)
  }

  get state(): LivePerformanceState { return this.current }
  get traceNotes(): LiveTraceNote[] { return this.trace }
  /** The tempo the player is actually holding, not the one on the page. */
  get bpm(): number { return this.clock.bpm }

  /** An outside tempo estimate, kept for input sources that carry one. */
  observeTempo(bpm: number): void { this.clock.observeTempo(bpm) }

  observe(input: LiveObservation): LivePerformanceState {
    const played = [...new Set(input.pitches)].sort((left, right) => left - right)
    if (!played.length) return this.current

    const outcome = this.progress.strike(played)
    const target = outcome.target
    const beat = target
      ? relativeBeatOf(target, this.targets, this.clock.beatsPerMeasure)
      : this.clock.elapsedBeats(input.atMs)

    // The position sounded when its first correct note landed. A second hand
    // arriving afterwards belongs to the same onset, not a later one.
    const opensPosition = outcome.accepted.length > 0 && !this.timed.has(outcome.index)
    let timing: TimingVerdict = UNPLACED
    if (opensPosition) {
      this.timed.add(outcome.index)
      timing = this.trust(this.clock.register(input.atMs, beat), beat)
      if (timing.reference !== 'unplaced') this.lastJudgedBeat = beat
      this.anchors.push({ beat, atMs: input.atMs })
      this.updateTempo()
    } else if (!this.clock.started) {
      // A wrong note can still be the player's first: the timeline starts when
      // they start, whatever they played.
      timing = this.clock.register(input.atMs, beat)
    }

    if (outcome.wrong.length) this.stumbled.add(outcome.index)
    const { pitches, status: raw } = classifyStrike(outcome)
    const status: LiveMatchStatus = raw === 'match' && this.stumbled.has(outcome.index)
      ? 'corrected' : raw

    const state = this.snapshot(status, pitches, input.atMs, outcome, timing)
    this.recordTrace(pitches, input.atMs, status, timing)
    return state
  }

  /**
   * Move past the position the player is stuck on. This is theirs to press —
   * the passage never decides on its own that a wrong note meant something
   * else, because it does not know that and guessing relocates the mistake.
   */
  skipCurrent(): LivePerformanceState {
    if (!this.targets.length) return this.current
    const outcome = this.progress.skip()
    return this.snapshot(
      'waiting', [], this.current.playedAtMs,
      { ...outcome, outstanding: this.progress.outstanding, target: this.progress.target },
      UNPLACED,
    )
  }

  private recordTrace(
    played: PlayedPitch[], atMs: number,
    status: LiveMatchStatus, timing: TimingVerdict,
  ): void {
    for (const item of played) {
      this.sequence += 1
      this.trace.push({
        id: `t${this.sequence}`,
        pitch: item.pitch,
        atMs,
        beatsFromStart: this.clock.elapsedBeats(atMs),
        status,
        timing: timing.label,
        deltaMs: timing.deltaMs,
      })
    }
    if (this.trace.length > TRACE_LIMIT) {
      this.trace = this.trace.slice(-TRACE_LIMIT)
    }
  }
}

export { absoluteBeatOf, buildLiveTargets, relativeBeatOf }
export type { ExpectedNote, LiveTarget, TimingLabel, TimingVerdict }
