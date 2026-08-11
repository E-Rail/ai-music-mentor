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
  buildLiveTargets, relativeBeatOf, resolveTargetIndex,
  type LivePositionStrategy, type LiveTarget,
} from './liveTargets'

export type LiveMatchStatus = 'idle' | 'waiting' | 'match' | 'partial' | 'different'

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
    target: null, timing: null, startedAtMs: null, awaitingFirstNote: true,
  }
}

/**
 * Split what was played against what was written. Pure, and the single place
 * the app decides whether a note "counts".
 */
export function classifyPlayedPitches(
  played: number[], expected: number[],
): { pitches: PlayedPitch[]; missing: number[]; status: LiveMatchStatus } {
  const heard = [...new Set(played)].sort((left, right) => left - right)
  const written = new Set(expected)
  if (!heard.length) {
    return { pitches: [], missing: [...written].sort((a, b) => a - b), status: 'waiting' }
  }
  const pitches: PlayedPitch[] = heard.map((pitch) => ({
    pitch, role: written.has(pitch) ? 'matched' : 'extra',
  }))
  const matchedCount = pitches.filter((item) => item.role === 'matched').length
  const missing = [...written].filter((pitch) => !heard.includes(pitch))
    .sort((left, right) => left - right)
  if (!expected.length) return { pitches, missing, status: 'different' }
  const status: LiveMatchStatus = matchedCount === heard.length && !missing.length
    ? 'match' : matchedCount > 0 ? 'partial' : 'different'
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
  /** Score-follower onset index; only consulted by the `follower` strategy. */
  followerIndex?: number | null
}

/**
 * Owns the live picture for one take: the player's clock, the passage, the
 * rolling trace, and the current state. One instance serves USB MIDI and the
 * microphone so the two can never disagree about where the player is.
 */
export class LivePerformanceTracker {
  private targets: LiveTarget[] = []
  private clock = new PerformanceClock(96, 4)
  private trace: LiveTraceNote[] = []
  private source: InputSource = 'web-midi'
  private strategy: LivePositionStrategy = 'follower'
  private current: LivePerformanceState = idleLiveState('web-midi')
  private sequence = 0
  /** Score beat assigned to the note before the current one. */
  private previousBeat: number | null = null
  /** Score beat assigned to the current note; the follower may correct it. */
  private currentBeat: number | null = null
  /** Trace entries belonging to the current note, so a correction reaches them. */
  private currentTraceIds: string[] = []

  /**
   * Timing is only claimed when there is a position worth measuring against.
   *
   * Two notes that resolve to the same score onset mean either a repeat or a
   * follower that has lost the player; a deviation of more than a couple of
   * beats means the same thing. Reporting "late by 3251 ms" in either case
   * states a fact the app does not actually know, so it reports nothing.
   */
  private trust(verdict: TimingVerdict, beat: number): TimingVerdict {
    if (verdict.reference === 'anchor') return verdict
    const advanced = this.previousBeat === null || beat > this.previousBeat + 1e-6
    if (!advanced) return UNPLACED
    if (Math.abs(verdict.beatsOff) > MAX_TRUSTED_BEATS_OFF) return UNPLACED
    return verdict
  }

  begin(options: LiveSessionOptions): LivePerformanceState {
    this.targets = buildLiveTargets(
      options.events, options.rangeStart, options.rangeEnd)
    this.clock = new PerformanceClock(options.bpm, options.beatsPerMeasure)
    this.trace = []
    this.sequence = 0
    this.previousBeat = null
    this.currentBeat = null
    this.currentTraceIds = []
    this.source = options.source
    // Only USB MIDI reports true onsets; a microphone preview is a smoothed
    // dominant pitch and cannot drive a beam search.
    this.strategy = options.source === 'microphone' ? 'elapsed' : 'follower'
    this.current = {
      ...idleLiveState(options.source),
      status: 'waiting',
      target: this.targets[0] ?? null,
      missing: this.targets[0]?.pitches ?? [],
    }
    return this.current
  }

  reset(): void {
    this.clock.reset()
    this.trace = []
    this.sequence = 0
    this.previousBeat = null
    this.currentBeat = null
    this.currentTraceIds = []
    this.current = idleLiveState(this.source)
  }

  get state(): LivePerformanceState { return this.current }
  get traceNotes(): LiveTraceNote[] { return this.trace }

  /** Feed the follower's tempo estimate back into the player's timeline. */
  observeTempo(bpm: number): void { this.clock.observeTempo(bpm) }

  observe(input: LiveObservation): LivePerformanceState {
    const played = [...new Set(input.pitches)].sort((left, right) => left - right)
    if (!played.length) return this.current

    // Anchor before resolving position: the first note defines beat zero, so it
    // must not be located against a timeline that does not exist yet.
    const firstNote = !this.clock.started
    const index = firstNote ? 0 : resolveTargetIndex({
      targets: this.targets, strategy: this.strategy, clock: this.clock,
      atMs: input.atMs, followerIndex: input.followerIndex,
    })
    const target = this.targets[index] ?? null
    const beat = target
      ? relativeBeatOf(target, this.targets, this.clock.beatsPerMeasure)
      : this.clock.elapsedBeats(input.atMs)
    this.previousBeat = this.currentBeat
    this.currentBeat = beat
    const timing = this.trust(this.clock.register(input.atMs, beat), beat)

    const { pitches, missing, status } = classifyPlayedPitches(
      played, target?.pitches ?? [])

    this.current = {
      status, source: this.source, played: pitches, playedAtMs: input.atMs,
      missing, target, timing, startedAtMs: this.clock.startedAtMs,
      awaitingFirstNote: false,
    }
    this.currentTraceIds = []
    for (const item of pitches) {
      this.sequence += 1
      this.currentTraceIds.push(`t${this.sequence}`)
      this.trace.push({
        id: `t${this.sequence}`,
        pitch: item.pitch,
        atMs: input.atMs,
        beatsFromStart: this.clock.elapsedBeats(input.atMs),
        status,
        timing: timing.label,
        deltaMs: timing.deltaMs,
      })
    }
    if (this.trace.length > TRACE_LIMIT) {
      this.trace = this.trace.slice(-TRACE_LIMIT)
    }
    return this.current
  }

  /**
   * Correct the position once the follower has ruled on the note just played.
   *
   * The follower runs in a worker, so its verdict lands a moment after the
   * keystroke that produced it. Re-scoring the same played pitches against the
   * corrected onset keeps the panel and the staff consistent without inventing
   * input the player never produced.
   */
  syncPosition(followerIndex: number): LivePerformanceState {
    if (!this.targets.length) return this.current
    const index = Math.min(
      Math.max(Math.round(followerIndex), 0), this.targets.length - 1)
    const target = this.targets[index]
    if (!target || target === this.current.target) return this.current
    if (!this.current.played.length || this.current.playedAtMs === null) {
      this.current = { ...this.current, target }
      return this.current
    }
    const beat = relativeBeatOf(target, this.targets, this.clock.beatsPerMeasure)
    this.currentBeat = beat
    const { pitches, missing, status } = classifyPlayedPitches(
      this.current.played.map((item) => item.pitch), target.pitches)
    // Re-judge, never re-register: the clock has already seen this note, and
    // anchoring it a second time would move the player's own start line.
    const timing = this.current.timing?.reference === 'anchor'
      ? this.current.timing
      : this.trust(this.clock.judge(this.current.playedAtMs, beat), beat)
    this.current = { ...this.current, target, played: pitches, missing, status, timing }
    // The trace is the same take drawn a different way; it must not keep the
    // verdict the panel has just revised.
    const corrected = new Set(this.currentTraceIds)
    this.trace = this.trace.map((note) => corrected.has(note.id)
      ? { ...note, status, timing: timing.label, deltaMs: timing.deltaMs }
      : note)
    return this.current
  }
}

export { absoluteBeatOf, buildLiveTargets, relativeBeatOf }
export type { LiveTarget, LivePositionStrategy, TimingLabel, TimingVerdict }
