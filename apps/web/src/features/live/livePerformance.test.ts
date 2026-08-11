import { describe, expect, it } from 'vitest'
import type { ScoreEvent } from '../../types'
import { PerformanceClock, absoluteBeatOf, liveTimingToleranceMs } from './performanceClock'
import { buildLiveTargets, targetIndexAtElapsedBeats } from './liveTargets'
import { LivePerformanceTracker, classifyPlayedPitches } from './livePerformance'

function scale(count: number, startPitch = 60): ScoreEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    eventId: `s:RH:m${1 + Math.floor(index / 4)}:b${index % 4}:1`,
    measureNo: 1 + Math.floor(index / 4),
    onsetBeat: index % 4,
    absoluteBeat: index,
    durationBeat: 1,
    pitches: [startPitch + index],
    part: 'RH',
    voice: 1,
    dynamicTarget: null,
    optional: false,
  })) as ScoreEvent[]
}

const CHORD: ScoreEvent[] = [
  { eventId: 's:RH:m1:b0:1', measureNo: 1, onsetBeat: 0, absoluteBeat: 0, durationBeat: 1, pitches: [60], part: 'RH', voice: 1, dynamicTarget: null, optional: false },
  { eventId: 's:RH:m1:b1:1', measureNo: 1, onsetBeat: 1, absoluteBeat: 1, durationBeat: 1, pitches: [64, 67], part: 'RH', voice: 1, dynamicTarget: null, optional: false },
] as ScoreEvent[]

function tracker(events: ScoreEvent[], source: 'web-midi' | 'microphone' = 'web-midi') {
  const instance = new LivePerformanceTracker()
  instance.begin({
    events, rangeStart: 1, rangeEnd: 99, bpm: 96, beatsPerMeasure: 4, source,
  })
  return instance
}

describe('PerformanceClock', () => {
  it('starts the timeline at the first note, however long the player waits', () => {
    const clock = new PerformanceClock(96, 4)
    const verdict = clock.register(30_000, 0)
    expect(verdict.label).toBe('onTime')
    expect(verdict.reference).toBe('anchor')
    expect(clock.startedAtMs).toBe(30_000)
    expect(clock.elapsedMs(30_000)).toBe(0)
  })

  it('judges later notes against the player, not against the record button', () => {
    const clock = new PerformanceClock(120, 4)
    clock.register(9_000, 0)
    // One beat at 120 BPM is 500 ms.
    expect(clock.register(9_500, 1).label).toBe('onTime')
    expect(clock.judge(9_900, 2).label).toBe('early')
    expect(clock.judge(10_900, 2).label).toBe('late')
  })

  it('re-anchors after a long silence so a restart is not a growing debt', () => {
    const clock = new PerformanceClock(120, 4)
    clock.register(0, 0)
    clock.register(500, 1)
    const afterBreak = clock.register(30_000, 2)
    expect(afterBreak.reference).toBe('anchor')
    expect(afterBreak.label).toBe('onTime')
  })

  it('widens tolerance with slower tempo', () => {
    expect(liveTimingToleranceMs(60)).toBeGreaterThan(liveTimingToleranceMs(180))
  })

  it('reads exact absolute beats and falls back to the measure grid', () => {
    expect(absoluteBeatOf({ measureNo: 3, onsetBeat: 1, absoluteBeat: 5 }, 4)).toBe(5)
    expect(absoluteBeatOf({ measureNo: 3, onsetBeat: 1 }, 4)).toBe(9)
  })
})

describe('classifyPlayedPitches', () => {
  it('marks a pitch the score does not contain as the player’s own note', () => {
    const result = classifyPlayedPitches([61], [60])
    expect(result.pitches).toEqual([{ pitch: 61, role: 'extra' }])
    expect(result.missing).toEqual([60])
    expect(result.status).toBe('different')
  })

  it('keeps both halves of a half-played chord visible', () => {
    const result = classifyPlayedPitches([64, 70], [64, 67])
    expect(result.pitches).toEqual([
      { pitch: 64, role: 'matched' }, { pitch: 70, role: 'extra' },
    ])
    expect(result.missing).toEqual([67])
    expect(result.status).toBe('partial')
  })
})

describe('LivePerformanceTracker', () => {
  it('puts the first note on the first target however late the player begins', () => {
    const live = tracker(scale(8))
    const state = live.observe({ pitches: [60], atMs: 12_000, followerIndex: 4 })
    expect(state.target?.measureNo).toBe(1)
    expect(state.target?.onsetBeat).toBe(0)
    expect(state.timing?.label).toBe('onTime')
    expect(state.status).toBe('match')
  })

  it('never reports the microphone player as late for waiting to start', () => {
    const live = tracker(scale(8), 'microphone')
    // The old wall-clock path pointed at note 5 after a three second pause.
    const state = live.observe({ pitches: [60], atMs: 3_000 })
    expect(state.target?.onsetBeat).toBe(0)
    expect(state.timing?.label).toBe('onTime')
  })

  it('reports what the player actually played, not what was written', () => {
    const live = tracker(scale(8))
    live.observe({ pitches: [60], atMs: 0, followerIndex: 0 })
    const state = live.observe({ pitches: [70], atMs: 625, followerIndex: 1 })
    expect(state.played).toEqual([{ pitch: 70, role: 'extra' }])
    expect(state.missing).toEqual([61])
    expect(state.status).toBe('different')
  })

  it('follows the score follower rather than a second private counter', () => {
    const live = tracker(scale(8))
    live.observe({ pitches: [60], atMs: 0, followerIndex: 0 })
    // A wrong note keeps the follower where it is; the live card must agree.
    const stuck = live.observe({ pitches: [99], atMs: 625, followerIndex: 0 })
    expect(stuck.target?.onsetBeat).toBe(0)
    const moved = live.observe({ pitches: [63], atMs: 1_875, followerIndex: 3 })
    expect(moved.target?.onsetBeat).toBe(3)
  })

  it('records a trace of the played notes with their timing', () => {
    const live = tracker(scale(4))
    live.observe({ pitches: [60], atMs: 5_000, followerIndex: 0 })
    live.observe({ pitches: [61], atMs: 5_625, followerIndex: 1 })
    live.observe({ pitches: [62], atMs: 6_800, followerIndex: 2 })
    expect(live.traceNotes.map((note) => note.pitch)).toEqual([60, 61, 62])
    expect(live.traceNotes[0].timing).toBe('onTime')
    expect(live.traceNotes[2].timing).toBe('late')
  })

  it('makes no timing claim while the follower is stuck on one onset', () => {
    const live = tracker(scale(8))
    live.observe({ pitches: [60], atMs: 0, followerIndex: 0 })
    // The follower could not place these, so "late by N ms" would be invented.
    const stuck = live.observe({ pitches: [99], atMs: 690, followerIndex: 0 })
    expect(stuck.timing?.reference).toBe('unplaced')
    const stillStuck = live.observe({ pitches: [98], atMs: 3_900, followerIndex: 0 })
    expect(stillStuck.timing?.reference).toBe('unplaced')
  })

  it('makes no timing claim when the deviation is beyond tracking range', () => {
    const live = tracker(scale(8))
    live.observe({ pitches: [60], atMs: 0, followerIndex: 0 })
    // Onset 1 is one beat (625 ms) in; arriving 2.5 s later is not "late".
    const adrift = live.observe({ pitches: [61], atMs: 3_100, followerIndex: 1 })
    expect(adrift.timing?.reference).toBe('unplaced')
  })

  it('still reports an ordinary late note', () => {
    const live = tracker(scale(8))
    live.observe({ pitches: [60], atMs: 0, followerIndex: 0 })
    const late = live.observe({ pitches: [61], atMs: 900, followerIndex: 1 })
    expect(late.timing?.reference).toBe('elapsed')
    expect(late.timing?.label).toBe('late')
    expect(Math.round(late.timing!.deltaMs)).toBe(275)
  })

  it('re-judges a note once the follower catches up, without re-anchoring', () => {
    const live = tracker(scale(8))
    live.observe({ pitches: [60], atMs: 0, followerIndex: 0 })
    const startedAt = live.state.startedAtMs
    // The worker's verdict for note 2 lands after note 2 itself, so the note is
    // first placed with the stale index 0 and corrected to 1 a moment later.
    const provisional = live.observe({ pitches: [61], atMs: 640, followerIndex: 0 })
    expect(provisional.timing?.reference).toBe('unplaced')
    const corrected = live.syncPosition(1)
    expect(corrected.target?.onsetBeat).toBe(1)
    expect(corrected.status).toBe('match')
    expect(corrected.timing?.reference).toBe('elapsed')
    expect(corrected.timing?.label).toBe('onTime')
    expect(live.state.startedAtMs).toBe(startedAt)
  })

  it('revises the trace when it revises the panel', () => {
    const live = tracker(scale(8))
    live.observe({ pitches: [60], atMs: 0, followerIndex: 0 })
    live.observe({ pitches: [61], atMs: 640, followerIndex: 0 })
    const last = () => live.traceNotes[live.traceNotes.length - 1]
    expect(last().status).toBe('different')
    live.syncPosition(1)
    expect(last().status).toBe('match')
    expect(last().timing).toBe('onTime')
  })

  it('keeps the anchor verdict when the follower corrects the first note', () => {
    const live = tracker(scale(8))
    live.observe({ pitches: [60], atMs: 8_000, followerIndex: null })
    const corrected = live.syncPosition(1)
    expect(corrected.timing?.reference).toBe('anchor')
    expect(corrected.timing?.label).toBe('onTime')
  })

  it('keeps a partially played chord on its own onset', () => {
    const live = tracker(CHORD)
    live.observe({ pitches: [60], atMs: 0, followerIndex: 0 })
    const state = live.observe({ pitches: [64], atMs: 625, followerIndex: 1 })
    expect(state.status).toBe('partial')
    expect(state.missing).toEqual([67])
    expect(state.target?.onsetBeat).toBe(1)
  })
})

describe('target ordering', () => {
  it('orders by absolute beat so a meter change cannot reshuffle the passage', () => {
    const targets = buildLiveTargets([
      { eventId: 'a', measureNo: 1, onsetBeat: 0, absoluteBeat: 0, durationBeat: 1, pitches: [60], part: 'RH', voice: 1, dynamicTarget: null, optional: false },
      { eventId: 'b', measureNo: 2, onsetBeat: 0, absoluteBeat: 4, durationBeat: 1, pitches: [62], part: 'RH', voice: 1, dynamicTarget: null, optional: false },
      { eventId: 'c', measureNo: 3, onsetBeat: 0, absoluteBeat: 5, durationBeat: 1, pitches: [64], part: 'RH', voice: 1, dynamicTarget: null, optional: false },
    ] as ScoreEvent[], 1, 3)
    expect(targets.map((target) => target.absoluteBeat)).toEqual([0, 4, 5])
    expect(targetIndexAtElapsedBeats(targets, 5, 4)).toBe(2)
  })

  it('measures elapsed beats from the passage start, not from measure one', () => {
    const targets = buildLiveTargets(scale(8).map((event) => ({
      ...event, measureNo: event.measureNo + 4, absoluteBeat: event.absoluteBeat! + 16,
    })), 5, 99)
    expect(targetIndexAtElapsedBeats(targets, 0, 4)).toBe(0)
    expect(targetIndexAtElapsedBeats(targets, 3, 4)).toBe(3)
  })
})
