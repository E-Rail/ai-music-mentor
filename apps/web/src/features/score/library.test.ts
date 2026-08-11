import { describe, expect, it } from 'vitest'
import {
  partitionScoreLibrary, scoreDisplayTitle, type ScoreLibraryItem,
} from './library'

function score(overrides: Partial<ScoreLibraryItem>): ScoreLibraryItem {
  return {
    scoreId: 'score_123456789abc', title: 'Example', composer: '', tempo: 96,
    timeSignature: '4/4', beatsPerMeasure: 4, measureCount: 8, parts: ['RH'],
    scoreHash: 'hash', builtin: false, ...overrides,
  }
}

describe('score library', () => {
  it('keeps demos and uploads prominent while separating generated work', () => {
    const result = partitionScoreLibrary([
      score({ scoreId: 'demo', builtin: true, libraryCategory: 'demo' }),
      score({ scoreId: 'upload', libraryCategory: 'uploaded' }),
      score({ scoreId: 'exercise', generated: true, libraryCategory: 'generated' }),
      score({ scoreId: 'fixture', libraryCategory: 'internal' }),
    ])

    expect(result.demos.map((item) => item.scoreId)).toEqual(['demo'])
    expect(result.uploads.map((item) => item.scoreId)).toEqual(['upload'])
    expect(result.generated.map((item) => item.scoreId)).toEqual(['exercise'])
    expect(Object.values(result).flat().some((item) => item.scoreId === 'fixture')).toBe(false)
  })

  it('uses the original filename instead of an opaque generated import title', () => {
    expect(scoreDisplayTitle(score({
      title: 'score_123456789abc', sourceName: 'My nocturne.mxl',
    }))).toBe('My nocturne')
  })
})
