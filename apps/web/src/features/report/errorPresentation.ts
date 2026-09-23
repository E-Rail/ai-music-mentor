import { tf } from '../../i18n/messages'
import type { ErrorEvent, Evidence } from '../../types'
import { parsePitchNames } from '../audio/player'

const INTERNAL_GROUP_DETAIL = /^group:[a-z0-9._-]+$/i

/**
 * Older reports used an internal performance-group ID as visible detail.
 * Translate it from linked evidence when possible and otherwise hide it.
 */
export function errorDetailForDisplay(error: ErrorEvent, evidences: Evidence[]): string {
  const detail = error.detail.trim()
  if (!INTERNAL_GROUP_DETAIL.test(detail)) return detail

  if (error.type === 'extra_note') {
    const evidence = error.evidenceIds
      .map((id) => evidences.find((candidate) => candidate.id === id))
      .find((candidate) => candidate?.actual.trim())
    if (evidence?.actual) return tf('extraNoteDetail', { notes: evidence.actual })
  }

  return ''
}

export { errorColor } from './errorPalette'

/**
 * The notes to play for one side of a piece of evidence, or none.
 *
 * A report says which notes it means; the sentence is for reading. Parsing
 * note names out of it stopped working the moment it could be English, and
 * offered a "hear" button on evidence like "all chord notes together" that had
 * nothing to play. Only a report written before the notes were sent falls
 * back to reading them out of the text.
 */
export function evidenceNotes(evidence: Evidence, side: 'expected' | 'actual'): number[] {
  const pitches = side === 'expected' ? evidence.expectedPitches : evidence.actualPitches
  if (pitches !== undefined) return pitches
  return parsePitchNames(side === 'expected' ? evidence.expected : evidence.actual)
}
