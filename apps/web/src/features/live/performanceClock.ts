/**
 * The performance timeline belongs to the player, not to the recorder.
 *
 * Recording starts when the student presses a button; the performance starts
 * when they play their first note. Those are different moments, and a student
 * is allowed to sit for ten seconds and think before the downbeat. Every live
 * timing judgement in the app is measured from the anchor set here, so the
 * first note can never be reported as late — there is nothing before it to be
 * late against.
 *
 * The clock also learns the player's own tempo. Practising a 96 BPM piece at
 * 60 BPM is a tempo choice, not a hundred late notes.
 */

export const MIN_BPM = 20
export const MAX_BPM = 300

/** A silence this long means the player stopped and started again. */
export const REANCHOR_GAP_BEATS = 8

export type TimingLabel = 'onTime' | 'early' | 'late'

/** Beyond this the note is not late, it is unplaced — the follower lost you. */
export const MAX_TRUSTED_BEATS_OFF = 2

export interface TimingVerdict {
  /** Signed milliseconds against the player's own timeline. Negative = early. */
  deltaMs: number
  beatsOff: number
  label: TimingLabel
  /**
   * `anchor`   this note defined the timeline, so it is on time by construction
   * `elapsed`  compared against the player's own earlier playing
   * `unplaced` no trustworthy score position, so no timing claim is made
   */
  reference: 'anchor' | 'elapsed' | 'unplaced'
}

export const UNPLACED: TimingVerdict = {
  deltaMs: 0, beatsOff: 0, label: 'onTime', reference: 'unplaced',
}

export interface PerformanceAnchor {
  /** Wall-clock time of the note that started the performance. */
  atMs: number
  /** Absolute score beat that note occupies. */
  beat: number
}

export function clampBpm(bpm: number): number {
  if (!Number.isFinite(bpm)) return 96
  return Math.min(MAX_BPM, Math.max(MIN_BPM, bpm))
}

export function msPerBeat(bpm: number): number {
  return 60_000 / clampBpm(bpm)
}

/**
 * How far off a live note may sit before the interface says anything. Mirrors
 * the deterministic analyser's floor but stays slightly looser, because live
 * hints must not nag while the final report is the thing that scores.
 */
export function liveTimingToleranceMs(bpm: number): number {
  return Math.max(90, 0.14 * msPerBeat(bpm))
}

/**
 * Absolute score beat for any onset-shaped value. Imported scores carry an
 * exact `absoluteBeat` that survives meter changes; older ones fall back to the
 * measure grid. `measureNo - 1` matches the score follower and the analyser, so
 * all three agree on what beat 0 means.
 */
export function absoluteBeatOf(
  onset: { measureNo: number; onsetBeat: number; absoluteBeat?: number | null },
  beatsPerMeasure: number,
): number {
  if (onset.absoluteBeat != null && Number.isFinite(onset.absoluteBeat)) {
    return onset.absoluteBeat
  }
  const beats = Number.isFinite(beatsPerMeasure) && beatsPerMeasure > 0 ? beatsPerMeasure : 4
  return (onset.measureNo - 1) * beats + onset.onsetBeat
}

export class PerformanceClock {
  private anchor: PerformanceAnchor | null = null
  private nominalBpm: number
  private observedBpm: number
  private lastInputMs: number | null = null
  readonly beatsPerMeasure: number

  constructor(bpm: number, beatsPerMeasure: number) {
    this.nominalBpm = clampBpm(bpm)
    this.observedBpm = this.nominalBpm
    this.beatsPerMeasure = Number.isFinite(beatsPerMeasure) && beatsPerMeasure > 0
      ? beatsPerMeasure : 4
  }

  get started(): boolean { return this.anchor !== null }
  get startedAtMs(): number | null { return this.anchor?.atMs ?? null }
  get anchorBeat(): number { return this.anchor?.beat ?? 0 }
  /** The tempo the player is actually holding, not the tempo on the page. */
  get bpm(): number { return this.observedBpm }

  reset(): void {
    this.anchor = null
    this.observedBpm = this.nominalBpm
    this.lastInputMs = null
  }

  /** Pin the timeline to a note. Later calls are ignored unless re-anchoring. */
  anchorAt(atMs: number, beat = 0): void {
    if (this.anchor) return
    this.anchor = { atMs, beat }
  }

  reanchorAt(atMs: number, beat: number): void {
    this.anchor = { atMs, beat }
  }

  /**
   * Feed the follower's tempo estimate back in, smoothed so one hesitant note
   * cannot swing the reference the next note is judged against.
   */
  observeTempo(bpm: number): void {
    const next = clampBpm(bpm)
    this.observedBpm = 0.75 * this.observedBpm + 0.25 * next
  }

  elapsedMs(atMs: number): number {
    if (!this.anchor) return 0
    return Math.max(0, atMs - this.anchor.atMs)
  }

  elapsedBeats(atMs: number): number {
    return this.elapsedMs(atMs) / msPerBeat(this.observedBpm)
  }

  /** When the player's own timeline says an absolute score beat should sound. */
  expectedMsForBeat(beat: number): number | null {
    if (!this.anchor) return null
    return this.anchor.atMs + (beat - this.anchor.beat) * msPerBeat(this.observedBpm)
  }

  /**
   * Register an input and judge it. The very first input becomes the anchor and
   * is always on time; a long silence re-anchors so a restart after a stumble
   * is a fresh start rather than a growing debt.
   */
  register(atMs: number, beat: number): TimingVerdict {
    const gapBeats = this.lastInputMs === null
      ? 0 : (atMs - this.lastInputMs) / msPerBeat(this.observedBpm)
    const restarting = this.started && gapBeats > REANCHOR_GAP_BEATS
    this.lastInputMs = atMs

    if (!this.started || restarting) {
      this.reanchorAt(atMs, beat)
      return { deltaMs: 0, beatsOff: 0, label: 'onTime', reference: 'anchor' }
    }
    return this.judge(atMs, beat)
  }

  /** Judge a time against the timeline without moving it. */
  judge(atMs: number, beat: number): TimingVerdict {
    const expected = this.expectedMsForBeat(beat)
    if (expected === null) {
      return { deltaMs: 0, beatsOff: 0, label: 'onTime', reference: 'anchor' }
    }
    const deltaMs = atMs - expected
    const tolerance = liveTimingToleranceMs(this.observedBpm)
    return {
      deltaMs,
      beatsOff: deltaMs / msPerBeat(this.observedBpm),
      label: Math.abs(deltaMs) <= tolerance ? 'onTime' : deltaMs < 0 ? 'early' : 'late',
      reference: 'elapsed',
    }
  }
}
