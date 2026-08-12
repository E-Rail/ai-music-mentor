/**
 * Where the player is in the passage — the one rule, for every input source.
 *
 * The passage moves forward only when the position the player is on has been
 * played in full. Both hands count: a chord written across two staves is one
 * position, and it is not finished until every note in it has sounded, however
 * far apart the two hands landed.
 *
 * A note that does not belong at this position is a wrong note *here*. It is
 * never matched against any other position in the score, and it never moves the
 * player forward. The passage waits, showing what is still outstanding, until
 * the player either plays it or decides to skip it.
 *
 * That paragraph is the whole design. An earlier version searched the score for
 * something a wrong note might have been — which quietly relocated the mistake,
 * and sometimes carried the student several notes past where they actually
 * were.
 *
 * The one exception is not a wrong note at all. A student practising the right
 * hand alone leaves the left hand's notes unplayed on purpose, and would
 * otherwise stall on the first bar forever. So a strike that this position does
 * not want, that the *immediately next* position does, played after this
 * position has already been begun, is read as a missed note and moves on by one.
 * One step, to the note that is literally next — never a search, and never a
 * home for a note that is written nowhere nearby.
 */
import type { ExpectedNote, LiveTarget } from './liveTargets'

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
  /** This strike finished the position, so the next one moves on. */
  completed: boolean
  /** Holding here because something wrong was played and not yet corrected. */
  blocked: boolean
  /** No positions left in the passage. */
  done: boolean
}

export class PassageProgress {
  private targets: LiveTarget[] = []
  private cursor = 0
  private struck = new Set<number>()
  private wrongHere = false

  constructor(targets: LiveTarget[] = []) {
    this.load(targets)
  }

  load(targets: LiveTarget[]): void {
    this.targets = targets
    this.reset()
  }

  reset(): void {
    this.cursor = 0
    this.struck = new Set()
    this.wrongHere = false
  }

  get index(): number { return Math.min(this.cursor, Math.max(this.targets.length - 1, 0)) }
  get target(): LiveTarget | null { return this.targets[this.cursor] ?? null }
  get done(): boolean { return this.cursor >= this.targets.length }
  get blocked(): boolean { return this.wrongHere }

  get outstanding(): ExpectedNote[] {
    return (this.target?.expected ?? []).filter((note) => !this.struck.has(note.pitch))
  }

  strike(pitches: number[]): StrikeOutcome {
    const heard = [...new Set(pitches)].sort((left, right) => left - right)
    if (this.movingOn(heard)) {
      // A note this position does not want, that the very next position does,
      // played after this position was already begun: the student has left a
      // note out and gone on — practising the right hand alone, most often.
      // That is a missed note, not a wrong one, so it does not hold anything.
      // It is one step, to the note that is literally next; nothing is searched
      // for, and a genuinely wrong note still finds no home anywhere.
      this.advance()
    }
    return this.judge(heard)
  }

  private movingOn(heard: number[]): boolean {
    const target = this.target
    const next = this.targets[this.cursor + 1]
    if (!target || !next || !heard.length) return false
    if (!this.struck.size) return false
    const here = new Set(target.expected.map((note) => note.pitch))
    const outstanding = new Set(this.outstanding.map((note) => note.pitch))
    if (heard.some((pitch) => outstanding.has(pitch))) return false
    const there = new Set(next.expected.map((note) => note.pitch))
    return heard.every((pitch) => there.has(pitch) || here.has(pitch)) &&
      heard.some((pitch) => there.has(pitch))
  }

  private judge(heard: number[]): StrikeOutcome {
    const index = this.cursor
    const target = this.target
    if (!target) {
      return {
        index, target: null, accepted: [], repeated: [], wrong: heard,
        outstanding: [], completed: false, blocked: false, done: true,
      }
    }

    const here = new Set(target.expected.map((note) => note.pitch))
    const accepted: number[] = []
    const repeated: number[] = []
    const wrong: number[] = []
    for (const pitch of heard) {
      if (!here.has(pitch)) wrong.push(pitch)
      else if (this.struck.has(pitch)) repeated.push(pitch)
      else { accepted.push(pitch); this.struck.add(pitch) }
    }
    if (wrong.length) this.wrongHere = true

    const outstanding = target.expected.filter((note) => !this.struck.has(note.pitch))
    const completed = outstanding.length === 0
    const blocked = this.wrongHere && !completed
    if (completed) this.advance()

    return {
      index, target, accepted, repeated, wrong, outstanding, completed, blocked,
      done: this.done,
    }
  }

  /**
   * The player's own decision to move on without finishing this position. The
   * app never makes it for them — that would be guessing at what they meant.
   */
  skip(): StrikeOutcome {
    const index = this.cursor
    const target = this.target
    const outstanding = this.outstanding
    if (target) this.advance()
    return {
      index, target, accepted: [], repeated: [], wrong: [],
      outstanding, completed: false, blocked: false, done: this.done,
    }
  }

  private advance(): void {
    this.cursor += 1
    this.struck = new Set()
    this.wrongHere = false
  }
}
