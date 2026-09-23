import type { ScoreDetail, ScoreMeta } from '../../types'
import { tf } from '../../i18n/messages'

export type ScoreLibraryCategory = 'demo' | 'uploaded' | 'generated' | 'internal'

export type ScoreLibraryItem = ScoreMeta & {
  builtin: boolean
  generated?: boolean
  lineageDepth?: number
  sourceName?: string | null
  libraryCategory?: ScoreLibraryCategory
}

export function categoryForScore(score: ScoreLibraryItem): ScoreLibraryCategory {
  if (score.libraryCategory) return score.libraryCategory
  if (score.builtin) return 'demo'
  if (score.generated) return 'generated'
  return 'uploaded'
}

export function partitionScoreLibrary<T extends ScoreLibraryItem>(scores: T[]) {
  const visible = scores.filter((score) => categoryForScore(score) !== 'internal')
  return {
    demos: visible.filter((score) => categoryForScore(score) === 'demo'),
    uploads: visible.filter((score) => categoryForScore(score) === 'uploaded').reverse(),
    generated: visible.filter((score) => categoryForScore(score) === 'generated').reverse(),
  }
}

export function scoreDisplayTitle(score: ScoreLibraryItem): string {
  const sourceBase = (score.sourceName ?? '')
    .replace(/\.(musicxml|xml|mxl|midi|mid)$/i, '')
    .trim()
  const title = score.title?.trim()
  if (!title || title === score.scoreId || /^score_[0-9a-f]+$/i.test(title)) {
    return sourceBase || title || score.scoreId
  }
  return title
}

/**
 * The one name a piece goes by — on its library card, above the page, and
 * engraved on the page itself. A generated round is named for its place in the
 * practice loop rather than by the planner's working title.
 */
export function pieceTitle(score: ScoreLibraryItem): string {
  return categoryForScore(score) === 'generated'
    ? tf('generatedLibraryItemTitle', { round: score.lineageDepth ?? 1 })
    : scoreDisplayTitle(score)
}

/** The same name, for a piece that has been opened rather than listed. */
export function pieceTitleOf(detail: ScoreDetail | null | undefined): string | undefined {
  if (!detail) return undefined
  return pieceTitle({
    ...detail.metadata,
    builtin: detail.libraryCategory === 'demo',
    generated: detail.generated,
    lineageDepth: detail.lineageDepth,
    sourceName: detail.sourceName,
    libraryCategory: detail.libraryCategory,
  })
}
