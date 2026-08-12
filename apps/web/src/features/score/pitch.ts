/**
 * How this app spells a pitch, and which line of the staff that spelling sits
 * on. One table for both, because they are the same decision.
 *
 * A MIDI number does not say whether 70 is A♯ or B♭, and the two are drawn a
 * line apart. Keeping the name and the staff position in separate tables is how
 * the app came to label a dot "B♭4" while drawing it on the A space — and how
 * the same key came to read "A#4" in the input strip and "B♭4" on the page.
 *
 * `step` is diatonic: an accidental never moves a note off its line, so C♯ sits
 * on C and E♭ sits on E.
 */
const SPELLING: ReadonlyArray<{ name: string; step: number }> = [
  { name: 'C', step: 0 },
  { name: 'C♯', step: 0 },
  { name: 'D', step: 1 },
  { name: 'E♭', step: 2 },
  { name: 'E', step: 2 },
  { name: 'F', step: 3 },
  { name: 'F♯', step: 3 },
  { name: 'G', step: 4 },
  { name: 'A♭', step: 5 },
  { name: 'A', step: 5 },
  { name: 'B♭', step: 6 },
  { name: 'B', step: 6 },
]

const STEPS_PER_OCTAVE = 7

function pitchClass(midi: number): number {
  return ((Math.round(midi) % 12) + 12) % 12
}

/** "B♭4". The same name everywhere the app shows a note to a person. */
export function noteName(midi: number): string {
  if (!Number.isFinite(midi)) return '—'
  return `${SPELLING[pitchClass(midi)].name}${Math.floor(Math.round(midi) / 12) - 1}`
}

/**
 * Staff position is diatonic, not chromatic: C♯4 sits on the same line as C4,
 * and E–F are neighbours while F–G are a whole step apart. Mapping a pitch to a
 * step index is what lets the app draw a note the score never contained.
 */
export function diatonicStep(midi: number): number {
  const rounded = Math.round(midi)
  return Math.floor(rounded / 12) * STEPS_PER_OCTAVE + SPELLING[pitchClass(rounded)].step
}

/**
 * OSMD counts half tones from C0 while MIDI counts from C-1, so every pitch it
 * reports is an octave below the number the rest of the product speaks — the
 * keyboard, the alignment, the report and the mentor all use MIDI. Convert at
 * the boundary, the way the pixel scale already is.
 */
export const OSMD_HALFTONE_TO_MIDI = 12

export function midiFromOsmdHalfTone(halfTone: number): number {
  return Number.isFinite(halfTone) ? halfTone + OSMD_HALFTONE_TO_MIDI : Number.NaN
}
