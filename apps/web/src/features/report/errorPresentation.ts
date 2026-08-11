import { tf } from '../../i18n/messages'
import type { ErrorEvent, Evidence } from '../../types'

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
