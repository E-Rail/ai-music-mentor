import { describe, expect, it } from 'vitest'
import { ScoreFollowerEngine, type ScoreFollowerOnset } from './scoreFollowerEngine'

const onsets: ScoreFollowerOnset[] = [60, 62, 64, 65, 67, 69].map((pitch, index) => ({
  onsetId: `note-${index}`,
  measureNo: 1 + Math.floor(index / 4),
  onsetBeat: index % 4,
  pitches: [pitch],
}))

function engine(): ScoreFollowerEngine {
  const follower = new ScoreFollowerEngine()
  follower.init(onsets, 4, 96)
  return follower
}

describe('ScoreFollowerEngine', () => {
  it('tracks an in-order performance at the note that was actually played', () => {
    const follower = engine()
    const positions = onsets.slice(0, 5).map((onset, index) =>
      follower.process({ pitches: onset.pitches, tOnMs: index * 625 }))
    expect(positions.map((position) => position?.onsetIdx)).toEqual([0, 1, 2, 3, 4])
  })

  it('does not jump three notes ahead when a wrong key happens to match a future note', () => {
    const follower = engine()
    expect(follower.process({ pitches: [60], tOnMs: 0 })?.onsetIdx).toBe(0)
    const accidental = follower.process({ pitches: [65], tOnMs: 625 })
    expect(accidental?.onsetIdx).toBe(0)
    expect(accidental?.confidence).toBeLessThan(0.5)
    expect(follower.process({ pitches: [62], tOnMs: 650 })?.onsetIdx).toBe(1)
  })

  it('can consume one genuinely missed score note when elapsed time supports it', () => {
    const follower = engine()
    follower.process({ pitches: [60], tOnMs: 0 })
    const skipped = follower.process({ pitches: [64], tOnMs: 1_250 })
    expect(skipped?.onsetIdx).toBe(2)
    expect(skipped?.confidence).toBeGreaterThanOrEqual(0.6)
  })

  it('uses imported absolute beats across meter changes', () => {
    const follower = new ScoreFollowerEngine()
    follower.init([
      { onsetId: 'm1', measureNo: 1, onsetBeat: 0, absoluteBeat: 0, pitches: [60] },
      { onsetId: 'm2', measureNo: 2, onsetBeat: 0, absoluteBeat: 4, pitches: [62] },
      { onsetId: 'm3', measureNo: 3, onsetBeat: 0, absoluteBeat: 5, pitches: [64] },
    ], 4, 60)

    expect(follower.process({ pitches: [60], tOnMs: 0 })?.onsetId).toBe('m1')
    expect(follower.process({ pitches: [62], tOnMs: 4_000 })?.onsetId).toBe('m2')
    expect(follower.process({ pitches: [64], tOnMs: 5_000 })?.onsetId).toBe('m3')
  })
})
