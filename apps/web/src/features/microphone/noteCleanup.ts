import type { PerformanceEvent } from '../../types'
import type { AudioDetectionProfile } from './profiles'

/**
 * A note as an engine hands it over, before anything decides it was played.
 *
 * `attack` is the engine's certainty that the note *began* here — Basic
 * Pitch's onset head at the note's first frame. It is absent when the engine
 * has already made that decision itself: Onsets and Frames only emits a note
 * whose onset fired, so every note it reports is a strike.
 *
 * It stays on this side of the worker boundary. What leaves is a
 * `PerformanceEvent`, and the certainty that matters travels as its
 * `transcriptionConfidence`.
 */
export type TranscribedNote = PerformanceEvent & { attack?: number }

export interface CleanupResult {
  events: PerformanceEvent[]
  /**
   * Notes that had some claim to being played and still did not make it: a
   * middling attack nothing else explains, or a strike outside the instrument.
   * Echoes of a held note and overtones of a struck one are explained, not
   * rejected, so a noisy room raises this number and a clean take does not.
   */
  rejectedCount: number
  meanConfidence: number
}

/**
 * An attack this weak is not a claim to anything. Basic Pitch re-fires its
 * onset head on a held note whenever another note is struck, at 0.3–0.6; below
 * this it is not worth counting as a rejection.
 */
const BORDERLINE_ATTACK = 0.45
/**
 * An attack this strong is a new strike whatever the profile says. It keeps a
 * repeated note from being merged into the one before it on the instruments
 * that do not gate on attacks.
 */
const CERTAIN_ATTACK = 0.8
/**
 * Where an instrument's overtones fall: the octave, twelfth, double octave,
 * major seventeenth, nineteenth and triple octave. A struck note is heard at
 * these as well, and a transcriber that hears them as notes reports a G6 for
 * every G4.
 */
const OVERTONE_SEMITONES = [12, 19, 24, 28, 31, 36]
/** How close two onsets must be for one to be the other's overtone. */
const OVERTONE_WINDOW_MS = 50
/** An overtone sounds at under half its fundamental's strength. */
const OVERTONE_LOUDNESS_SHARE = 0.5
/**
 * …and was struck less certainly. A played octave is struck as firmly as the
 * note under it; an overtone rides in on its fundamental's attack.
 */
const OVERTONE_ATTACK_MARGIN = 0.15

function confidence(event: PerformanceEvent): number {
  return event.transcriptionConfidence ?? 0
}

/** Loudness as the engine measured it: velocity for both engines. */
function loudness(event: PerformanceEvent): number {
  return event.velocity
}

/**
 * Decide which of an engine's notes were played.
 *
 * The question that matters is not "was a pitch sounding?" but "was a key
 * struck?". A held note keeps sounding while other notes are struck over it,
 * and an engine that re-reads it at every one of those strikes reports the
 * left hand's whole note four times. A repeated note looks the same from the
 * outside: one pitch, sounding, then sounding again. Only the attack tells
 * them apart, so on the instruments whose notes begin with one, the attack
 * decides:
 *
 * - struck firmly → a note, even the same pitch again straight away;
 * - not struck, and continuing a note of that pitch → more of that note;
 * - not struck, and an overtone of a note struck with it → explained;
 * - anything else → not a note.
 *
 * Measured on the rendered takes, this took Basic Pitch from 70 of 91 notes
 * found with 154 reported to 91 of 91 with 91 reported, and held up with room
 * noise mixed in at 10 dB. The old rule merged by silence alone and folded
 * every repeated note — the second C of "C C G G" — into the first.
 */
export function cleanupTranscribedNotes(raw: TranscribedNote[],
  profile: AudioDetectionProfile): CleanupResult {
  const inRange = raw
    .filter((event) => event.pitch >= profile.minPitch && event.pitch <= profile.maxPitch)
    .sort((a, b) => a.tOnMs - b.tOnMs || a.pitch - b.pitch)
  const cleaned = profile.attackFloor === null
    ? bySound(inRange, profile)
    : byAttack(inRange, profile, profile.attackFloor)
  const events = profile.monophonic
    ? strongestNonOverlappingSequence(cleaned.events)
    : cleaned.events
  const meanConfidence = events.length
    ? events.reduce((sum, event) => sum + confidence(event), 0) / events.length
    : 0
  return {
    events: events.map(({ attack: _attack, ...event }: TranscribedNote, index) =>
      ({ ...event, id: `mic_${index + 1}` })),
    rejectedCount: (raw.length - inRange.length) + cleaned.rejected
      + (cleaned.events.length - events.length),
    meanConfidence,
  }
}

/** A note of `pitch` that is still sounding, or only just stopped, at `atMs`. */
function sounding(kept: TranscribedNote[], pitch: number, atMs: number,
  gapMs: number): TranscribedNote | undefined {
  for (let index = kept.length - 1; index >= 0; index -= 1) {
    const candidate = kept[index]
    if (candidate.pitch !== pitch) continue
    return candidate.tOnMs <= atMs && atMs - candidate.tOffMs <= gapMs ? candidate : undefined
  }
  return undefined
}

function overtoneOf(note: TranscribedNote, others: TranscribedNote[]): boolean {
  return others.some((fundamental) => fundamental !== note &&
    OVERTONE_SEMITONES.includes(note.pitch - fundamental.pitch) &&
    Math.abs(note.tOnMs - fundamental.tOnMs) <= OVERTONE_WINDOW_MS &&
    loudness(note) < OVERTONE_LOUDNESS_SHARE * loudness(fundamental) &&
    (note.attack ?? 1) < (fundamental.attack ?? 1) - OVERTONE_ATTACK_MARGIN)
}

/** Piano, and anything else whose notes begin with a strike. */
function byAttack(notes: TranscribedNote[], profile: AudioDetectionProfile,
  attackFloor: number): { events: TranscribedNote[]; rejected: number } {
  const struck = (note: TranscribedNote) => (note.attack ?? 1) >= attackFloor
  const kept: TranscribedNote[] = []
  let rejected = 0
  for (const source of notes) {
    const note = { ...source }
    if (struck(note)) {
      if (confidence(note) < profile.minConfidence ||
          note.tOffMs - note.tOnMs < profile.minDurationMs) {
        rejected += 1
        continue
      }
      // Struck again while still ringing: the first one ends here.
      const previous = sounding(kept, note.pitch, note.tOnMs, 0)
      if (previous && previous.tOffMs > note.tOnMs) previous.tOffMs = note.tOnMs
      kept.push(note)
      continue
    }
    const held = sounding(kept, note.pitch, note.tOnMs, profile.mergeGapMs)
    if (held) {
      held.tOffMs = Math.max(held.tOffMs, note.tOffMs)
      continue
    }
    if ((note.attack ?? 0) >= BORDERLINE_ATTACK && !overtoneOf(note, notes)) rejected += 1
  }
  return { events: kept.filter((note) => !overtoneOf(note, kept)), rejected }
}

/** Bowed and other notes that can begin without a strike: sound decides. */
function bySound(notes: TranscribedNote[],
  profile: AudioDetectionProfile): { events: TranscribedNote[]; rejected: number } {
  const filtered = notes
    .filter((event) => confidence(event) >= profile.minConfidence)
    .filter((event) => event.tOffMs - event.tOnMs >= profile.minDurationMs)

  const merged: TranscribedNote[] = []
  for (const event of filtered) {
    const previous = [...merged].reverse().find((candidate) => candidate.pitch === event.pitch)
    // Merging exists for a note the model reported in two pieces. A note struck
    // again is a different thing that looks identical from here, and the only
    // evidence separating them is what happened in between: if another pitch
    // began while this one was apparently silent, the player was playing, so
    // these are two strikes. A clear attack says the same thing directly.
    //
    // Without this a violin trill collapses. C-D-C-D-C at 100ms a note leaves
    // 100ms between one C and the next, inside the 120ms window, so every C
    // folds into the first and every D into the first D — five notes become
    // two, and the take is diagnosed as a fistful of missed notes.
    const struckBetween = previous !== undefined && filtered.some((other) =>
      other.pitch !== event.pitch &&
      other.tOnMs > previous.tOnMs && other.tOnMs < event.tOnMs)
    const struckAgain = (event.attack ?? 0) >= CERTAIN_ATTACK
    if (previous && !struckBetween && !struckAgain &&
        event.tOnMs - previous.tOffMs <= profile.mergeGapMs &&
        event.tOnMs >= previous.tOnMs) {
      const previousConfidence = confidence(previous)
      const currentConfidence = confidence(event)
      previous.tOffMs = Math.max(previous.tOffMs, event.tOffMs)
      previous.transcriptionConfidence = Math.max(previousConfidence, currentConfidence)
      previous.velocity = Math.max(previous.velocity, event.velocity)
      continue
    }
    merged.push({ ...event })
  }
  return { events: merged, rejected: notes.length - merged.length }
}

/** Select the highest-confidence non-overlapping sequence.
 *
 * Replacing only the first overlapping event can leave the replacement
 * overlapping a second event in a chain. Weighted interval scheduling makes
 * the monophonic profile truly monophonic and preserves credible short notes.
 */
function strongestNonOverlappingSequence<T extends PerformanceEvent>(events: T[]): T[] {
  const sorted = [...events].sort((a, b) =>
    a.tOffMs - b.tOffMs || a.tOnMs - b.tOnMs || a.pitch - b.pitch)
  const previousCompatible = sorted.map((event, index) => {
    let low = 0
    let high = index - 1
    let result = -1
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      if (sorted[middle].tOffMs <= event.tOnMs) {
        result = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    return result
  })
  const scores = new Array<number>(sorted.length + 1).fill(0)
  const take = new Array<boolean>(sorted.length).fill(false)
  for (let index = 0; index < sorted.length; index += 1) {
    const include = confidence(sorted[index]) + scores[previousCompatible[index] + 1]
    const exclude = scores[index]
    take[index] = include > exclude
    scores[index + 1] = take[index] ? include : exclude
  }
  const chosen: T[] = []
  for (let index = sorted.length - 1; index >= 0;) {
    const include = confidence(sorted[index]) + scores[previousCompatible[index] + 1]
    if (take[index] && include >= scores[index]) {
      chosen.push(sorted[index])
      index = previousCompatible[index]
    } else {
      index -= 1
    }
  }
  return chosen.sort((a, b) => a.tOnMs - b.tOnMs || a.pitch - b.pitch)
}
