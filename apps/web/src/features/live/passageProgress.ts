/**
 * Where the player is in the passage — the one rule, for every input source.
 *
 * ## Each hand travels on its own
 *
 * A single cursor through the page cannot describe two-handed music. Bar 1 of
 * 小星星 is four right-hand quarter notes over one left-hand whole note: while
 * the right hand is on beat 3, the left hand is still on the note it struck at
 * beat 1, because the page says to hold it. A shared cursor has to declare one
 * of those two positions wrong, and the late-arriving hand is the one it
 * punishes — which is how a two-handed take used to stop dead on its first
 * chord.
 *
 * So each hand walks its own lane. A played note goes to the hand that is
 * waiting for it. The hands need no coordination at all: they may land together
 * or a beat apart, and both are simply correct.
 *
 * A lane may lag only as long as the page holds its note. Once a hand's note
 * has stopped sounding and never arrived, that note is *missed* and the lane is
 * brought up to where the music now is — a hand cannot fall behind for ever.
 *
 * ## A wrong note stops its hand where it is
 *
 * A pitch no lane is waiting for is a wrong note at the position that hand is
 * on. It is never matched against another position in the score, and it never
 * moves anything forward. The passage holds there, names what it is still owed
 * and which hand owes it, until the player plays it or presses skip. An earlier
 * version ran a beam-search follower that looked two onsets ahead and six back;
 * it relocated mistakes and carried students past where they actually were.
 *
 * The one exception is not a wrong note. Hands-separate practice leaves the
 * other hand out on purpose, so a strike a lane's position does not want, that
 * the lane's *immediately next* position does, played after this position was
 * begun, is a missed note and moves that lane on by exactly one. One step, to
 * the note that is literally next — never a search.
 */
import type { Hand } from '../score/hands'
import type { ExpectedNote, LiveTarget } from './liveTargets'
import { absoluteBeatOf } from './performanceClock'

export interface StrikeOutcome {
  /** Position this strike was judged against. */
  index: number
  target: LiveTarget | null
  /** Pitches that belonged here and had not sounded yet. */
  accepted: number[]
  /** Pitches that belong here but had already sounded — hunting, not an error. */
  repeated: number[]
  /** Pitches that do not belong here at all. */
  wrong: number[]
  /** Still to be played at this position, after this strike. */
  outstanding: ExpectedNote[]
  /** Nothing is left outstanding at this position. */
  completed: boolean
  /** Holding here because something wrong was played and not yet corrected. */
  blocked: boolean
  /** No positions left in the passage. */
  done: boolean
}

interface Lane {
  hand: Hand
  /** Indices into `targets` where this hand has notes, in order. */
  steps: number[]
  cursor: number
  blocked: boolean
  /** Where this hand plays, for placing a note no lane is waiting for. */
  low: number
  high: number
}

export class PassageProgress {
  private targets: LiveTarget[] = []
  private beatsPerMeasure = 4
  private lanes: Lane[] = []
  /** Pitches already sounded at each position, whichever hand produced them. */
  private struck = new Map<number, Set<number>>()
  /**
   * The furthest into the music the player has actually got — the beat of the
   * latest position where something correct has sounded.
   *
   * Not the furthest lane cursor: a hand that has just finished a whole note
   * points at a bar the player has not reached yet, and treating that as the
   * lead drags the other hand off the end of the bar it is still playing.
   */
  private reachedBeat = Number.NEGATIVE_INFINITY
  private reported = 0

  constructor(targets: LiveTarget[] = [], beatsPerMeasure = 4) {
    this.load(targets, beatsPerMeasure)
  }

  load(targets: LiveTarget[], beatsPerMeasure = 4): void {
    this.targets = targets
    this.beatsPerMeasure = beatsPerMeasure > 0 ? beatsPerMeasure : 4
    const byHand = new Map<Hand, Lane>()
    targets.forEach((target, index) => {
      for (const note of target.expected) {
        const lane = byHand.get(note.hand) ?? {
          hand: note.hand, steps: [], cursor: 0, blocked: false,
          low: note.pitch, high: note.pitch,
        }
        if (lane.steps[lane.steps.length - 1] !== index) lane.steps.push(index)
        lane.low = Math.min(lane.low, note.pitch)
        lane.high = Math.max(lane.high, note.pitch)
        byHand.set(note.hand, lane)
      }
    })
    this.lanes = [...byHand.values()]
    this.reset()
  }

  reset(): void {
    for (const lane of this.lanes) {
      lane.cursor = 0
      lane.blocked = false
    }
    this.struck = new Map()
    this.reachedBeat = Number.NEGATIVE_INFINITY
    this.reported = 0
  }

  get index(): number { return this.reported }
  get target(): LiveTarget | null { return this.targets[this.reported] ?? null }
  get done(): boolean {
    return this.lanes.every((lane) => lane.cursor >= lane.steps.length)
  }

  get blocked(): boolean {
    return this.lanes.some((lane) =>
      lane.blocked && lane.steps[lane.cursor] === this.reported)
  }

  /** Everything the reported position still owes, whichever hand owes it. */
  get outstanding(): ExpectedNote[] {
    return this.outstandingAt(this.reported)
  }

  strike(pitches: number[]): StrikeOutcome {
    const heard = [...new Set(pitches)].sort((left, right) => left - right)
    this.catchUpLaggingHands()

    const accepted: number[] = []
    const repeated: number[] = []
    const wrong: number[] = []
    let judgedAt: number | null = null
    let heldAt: number | null = null

    for (const pitch of heard) {
      const lane = this.laneFor(pitch)
      if (!lane) { wrong.push(pitch); continue }
      if (this.canMoveOn(lane, pitch)) this.advance(lane)

      const step = lane.steps[lane.cursor]
      if (step === undefined) { wrong.push(pitch); continue }
      const struck = this.struckAt(step)
      const writtenHere = this.notesAt(lane, step).some((note) => note.pitch === pitch)

      if (writtenHere && !struck.has(pitch)) {
        struck.add(pitch)
        accepted.push(pitch)
        this.reachedBeat = Math.max(this.reachedBeat, this.beatOf(step))
        judgedAt = judgedAt === null ? step : Math.max(judgedAt, step)
        lane.blocked = false
        if (!this.outstandingFor(lane).length) this.advance(lane)
      } else if (writtenHere) {
        repeated.push(pitch)
        judgedAt = judgedAt ?? step
      } else {
        wrong.push(pitch)
        lane.blocked = true
        heldAt = heldAt === null ? step : Math.min(heldAt, step)
      }
    }

    this.reported = heldAt ?? judgedAt ?? this.earliestUnfinished()
    return this.outcome(accepted, repeated, wrong)
  }

  /**
   * The player's own decision to move past a position. The app never makes it
   * for them — that would be guessing at what they meant.
   */
  skip(): StrikeOutcome {
    const index = this.reported
    const outstanding = this.outstandingAt(index)
    const struck = this.struckAt(index)
    for (const note of this.targets[index]?.expected ?? []) struck.add(note.pitch)
    for (const lane of this.lanes) {
      if (lane.steps[lane.cursor] === index) this.advance(lane)
    }
    this.reported = this.earliestUnfinished()
    return {
      index, target: this.targets[index] ?? null,
      accepted: [], repeated: [], wrong: [],
      outstanding, completed: false, blocked: false, done: this.done,
    }
  }

  // --- the lanes ------------------------------------------------------------

  private notesAt(lane: Lane, step: number | undefined): ExpectedNote[] {
    if (step === undefined) return []
    return this.targets[step]?.expected.filter((note) => note.hand === lane.hand) ?? []
  }

  private struckAt(step: number): Set<number> {
    const existing = this.struck.get(step)
    if (existing) return existing
    const created = new Set<number>()
    this.struck.set(step, created)
    return created
  }

  private outstandingAt(step: number): ExpectedNote[] {
    const struck = this.struckAt(step)
    return this.targets[step]?.expected.filter((note) => !struck.has(note.pitch)) ?? []
  }

  private outstandingFor(lane: Lane): ExpectedNote[] {
    const step = lane.steps[lane.cursor]
    if (step === undefined) return []
    const struck = this.struckAt(step)
    return this.notesAt(lane, step).filter((note) => !struck.has(note.pitch))
  }

  private advance(lane: Lane): void {
    lane.cursor += 1
    lane.blocked = false
  }

  /** Whether this hand has already produced something at the position it is on. */
  private begun(lane: Lane): boolean {
    const step = lane.steps[lane.cursor]
    if (step === undefined) return false
    const struck = this.struckAt(step)
    return this.notesAt(lane, step).some((note) => struck.has(note.pitch))
  }

  /**
   * Whether the music has already moved past the position this hand is on.
   *
   * Measured against where the player has actually reached, never against
   * another lane's cursor: a hand that has just finished a whole note points at
   * a bar nobody has played yet, and reading that as "the music has moved on"
   * would let the other hand skip the note it is sitting on.
   */
  private passedBy(lane: Lane): boolean {
    const step = lane.steps[lane.cursor]
    if (step === undefined) return false
    return this.reachedBeat > this.beatOf(step)
  }

  private canMoveOn(lane: Lane, pitch: number): boolean {
    const next = lane.steps[lane.cursor + 1]
    if (next === undefined) return false
    if (this.outstandingFor(lane).some((note) => note.pitch === pitch)) return false
    if (!this.notesAt(lane, next).some((note) => note.pitch === pitch)) return false
    // Either this hand has already produced something here — hands-separate
    // practice, leaving the other hand out on purpose — or the music has moved
    // past this position without it. Both are a missed note, not a wrong one.
    // A note written at neither step still reaches none of this.
    return this.begun(lane) || this.passedBy(lane)
  }

  /**
   * The hand this note belongs to: the one waiting for it, else the one about
   * to want it, else the one whose register it is in. Nothing here searches the
   * score — every candidate is a note a hand is already due to play.
   */
  private laneFor(pitch: number): Lane | null {
    if (!this.lanes.length) return null
    const waiting = this.lanes.find((lane) =>
      this.outstandingFor(lane).some((note) => note.pitch === pitch))
    if (waiting) return waiting
    const movingOn = this.lanes.find((lane) => this.canMoveOn(lane, pitch))
    if (movingOn) return movingOn
    const struckHere = this.lanes.find((lane) =>
      this.notesAt(lane, lane.steps[lane.cursor]).some((note) => note.pitch === pitch))
    if (struckHere) return struckHere
    return this.lanes.reduce((best, lane) =>
      this.registerDistance(lane, pitch) < this.registerDistance(best, pitch)
        ? lane : best)
  }

  private registerDistance(lane: Lane, pitch: number): number {
    if (pitch < lane.low) return lane.low - pitch
    if (pitch > lane.high) return pitch - lane.high
    return 0
  }

  private beatOf(step: number): number {
    const target = this.targets[step]
    return target ? absoluteBeatOf(target, this.beatsPerMeasure) : 0
  }

  /**
   * A hand may lag only while the page still holds its note. Once that note has
   * stopped sounding and never arrived it is missed, not wrong, and the hand is
   * brought up to the music — otherwise a hand left out of one bar would report
   * every later note against a position long gone.
   */
  private catchUpLaggingHands(): void {
    const lead = this.reachedBeat
    for (const lane of this.lanes) {
      while (lane.cursor < lane.steps.length) {
        const notes = this.notesAt(lane, lane.steps[lane.cursor])
        if (!notes.length) break
        const stopsSounding = Math.max(...notes.map((note) => note.endsAtBeat))
        if (!Number.isFinite(stopsSounding) || stopsSounding > lead) break
        this.advance(lane)
      }
    }
  }

  private earliestUnfinished(): number {
    let earliest: number | null = null
    for (const lane of this.lanes) {
      const step = lane.steps[lane.cursor]
      if (step === undefined) continue
      earliest = earliest === null ? step : Math.min(earliest, step)
    }
    return earliest ?? this.reported
  }

  private outcome(
    accepted: number[], repeated: number[], wrong: number[],
  ): StrikeOutcome {
    const index = this.reported
    const outstanding = this.outstandingAt(index)
    return {
      index,
      target: this.targets[index] ?? null,
      accepted, repeated, wrong, outstanding,
      completed: accepted.length > 0 && outstanding.length === 0,
      blocked: this.blocked,
      done: this.done,
    }
  }
}
