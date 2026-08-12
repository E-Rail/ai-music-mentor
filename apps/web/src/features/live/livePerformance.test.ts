import { describe, expect, it } from 'vitest'
import type { ScoreEvent } from '../../types'
import { PerformanceClock, absoluteBeatOf, liveTimingToleranceMs } from './performanceClock'
import { buildLiveTargets } from './liveTargets'
import { PassageProgress } from './passageProgress'
import { LivePerformanceTracker } from './livePerformance'

function event(
  partial: Partial<ScoreEvent> & Pick<ScoreEvent, 'eventId' | 'measureNo' | 'onsetBeat' | 'pitches'>,
): ScoreEvent {
  return {
    absoluteBeat: null, durationBeat: 1, part: 'RH', voice: 1,
    dynamicTarget: null, optional: false, ...partial,
  } as ScoreEvent
}

/** A one-hand scale: one note per beat, C4 upwards. */
function scale(count: number, startPitch = 60): ScoreEvent[] {
  return Array.from({ length: count }, (_, index) => event({
    eventId: `s:RH:m${1 + Math.floor(index / 4)}:b${index % 4}:1`,
    measureNo: 1 + Math.floor(index / 4),
    onsetBeat: index % 4,
    absoluteBeat: index,
    pitches: [startPitch + index],
  }))
}

const CHORD: ScoreEvent[] = [
  event({ eventId: 's:RH:m1:b0:1', measureNo: 1, onsetBeat: 0, absoluteBeat: 0, pitches: [60] }),
  event({ eventId: 's:RH:m1:b1:1', measureNo: 1, onsetBeat: 1, absoluteBeat: 1, pitches: [64, 67] }),
]

/**
 * 小星星, bar 1, as it is actually written: the right hand plays four quarter
 * notes while the left hand holds one whole note under them.
 */
const TWO_HANDS: ScoreEvent[] = [
  event({ eventId: 't:RH:m1:b0:0', measureNo: 1, onsetBeat: 0, absoluteBeat: 0, pitches: [60] }),
  event({ eventId: 't:LH:m1:b0:0', measureNo: 1, onsetBeat: 0, absoluteBeat: 0, pitches: [48], durationBeat: 4, part: 'LH' }),
  event({ eventId: 't:RH:m1:b1:1', measureNo: 1, onsetBeat: 1, absoluteBeat: 1, pitches: [60] }),
  event({ eventId: 't:RH:m1:b2:2', measureNo: 1, onsetBeat: 2, absoluteBeat: 2, pitches: [67] }),
]

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

describe('a position on the page', () => {
  it('carries the hand that wrote each note', () => {
    const [first] = buildLiveTargets(TWO_HANDS, 1, 99)
    expect(first.expected).toEqual([
      { pitch: 48, hand: 'left' }, { pitch: 60, hand: 'right' },
    ])
  })

  it('orders by absolute beat so a meter change cannot reshuffle the passage', () => {
    const targets = buildLiveTargets([
      event({ eventId: 'a:RH:m1:b0:1', measureNo: 1, onsetBeat: 0, absoluteBeat: 0, pitches: [60] }),
      event({ eventId: 'b:RH:m2:b0:1', measureNo: 2, onsetBeat: 0, absoluteBeat: 4, pitches: [62] }),
      event({ eventId: 'c:RH:m3:b0:1', measureNo: 3, onsetBeat: 0, absoluteBeat: 5, pitches: [64] }),
    ], 1, 3)
    expect(targets.map((target) => target.absoluteBeat)).toEqual([0, 4, 5])
  })
})

describe('PassageProgress', () => {
  const targets = () => buildLiveTargets(scale(4), 1, 99)

  it('moves on only when the position has been played in full', () => {
    const progress = new PassageProgress(buildLiveTargets(CHORD, 1, 99))
    progress.strike([60])
    const half = progress.strike([64])
    expect(half.completed).toBe(false)
    expect(half.outstanding).toEqual([{ pitch: 67, hand: 'right' }])
    expect(progress.index).toBe(1)
    const rest = progress.strike([67])
    expect(rest.completed).toBe(true)
  })

  it('holds where the player is when they play a wrong note', () => {
    const progress = new PassageProgress(targets())
    progress.strike([60])
    const wrong = progress.strike([70])
    expect(wrong.wrong).toEqual([70])
    expect(wrong.accepted).toEqual([])
    expect(wrong.blocked).toBe(true)
    // The passage does not go looking for a 70 further along the score.
    expect(progress.target?.pitches).toEqual([61])
    expect(progress.index).toBe(1)
  })

  it('lets the player correct a wrong note in place', () => {
    const progress = new PassageProgress(targets())
    progress.strike([60])
    progress.strike([70])
    const fixed = progress.strike([61])
    expect(fixed.completed).toBe(true)
    expect(progress.blocked).toBe(false)
    expect(progress.target?.pitches).toEqual([62])
  })

  it('treats a re-struck note as hunting, not as a mistake', () => {
    // The left hand is owed and the player repeats the note they have while
    // looking for it. The next position wants something else, so this is not
    // moving on — and it is certainly not a wrong note.
    const progress = new PassageProgress(buildLiveTargets([
      event({ eventId: 'h:RH:m1:b0:0', measureNo: 1, onsetBeat: 0, absoluteBeat: 0, pitches: [60] }),
      event({ eventId: 'h:LH:m1:b0:0', measureNo: 1, onsetBeat: 0, absoluteBeat: 0, pitches: [48], part: 'LH' }),
      event({ eventId: 'h:RH:m1:b1:1', measureNo: 1, onsetBeat: 1, absoluteBeat: 1, pitches: [67] }),
    ], 1, 99))
    progress.strike([60])
    const again = progress.strike([60])
    expect(again.repeated).toEqual([60])
    expect(again.wrong).toEqual([])
    expect(again.blocked).toBe(false)
    expect(again.outstanding).toEqual([{ pitch: 48, hand: 'left' }])
  })

  it('lets a right-hand-only practice run keep going', () => {
    // Hands-separate practice leaves the left hand out on purpose. Its notes
    // are missed, not wrong, so the passage moves on one position at a time
    // instead of stalling on the first bar forever.
    const progress = new PassageProgress(buildLiveTargets(TWO_HANDS, 1, 99))
    expect(progress.strike([60]).outstanding).toEqual([{ pitch: 48, hand: 'left' }])
    expect(progress.strike([60]).target?.onsetBeat).toBe(1)
    expect(progress.strike([67]).target?.onsetBeat).toBe(2)
    expect(progress.blocked).toBe(false)
  })

  it('will not move on for a note that is written neither here nor next', () => {
    const progress = new PassageProgress(buildLiveTargets(TWO_HANDS, 1, 99))
    progress.strike([60])
    const wrong = progress.strike([70])
    expect(wrong.wrong).toEqual([70])
    expect(wrong.blocked).toBe(true)
    expect(progress.target?.onsetBeat).toBe(0)
  })

  it('moves on only when the player says so', () => {
    const progress = new PassageProgress(buildLiveTargets(TWO_HANDS, 1, 99))
    progress.strike([60])
    progress.skip()
    expect(progress.target?.onsetBeat).toBe(1)
  })
})

describe('LivePerformanceTracker', () => {
  it('puts the first note on the first target however late the player begins', () => {
    const live = tracker(scale(8))
    const state = live.observe({ pitches: [60], atMs: 12_000 })
    expect(state.target?.measureNo).toBe(1)
    expect(state.target?.onsetBeat).toBe(0)
    expect(state.timing?.label).toBe('onTime')
    expect(state.status).toBe('match')
  })

  it('never reports the microphone player as late for waiting to start', () => {
    const live = tracker(scale(8), 'microphone')
    const state = live.observe({ pitches: [60], atMs: 3_000 })
    expect(state.target?.onsetBeat).toBe(0)
    expect(state.timing?.label).toBe('onTime')
  })

  it('reports what the player actually played, not what was written', () => {
    const live = tracker(scale(8))
    live.observe({ pitches: [60], atMs: 0 })
    const state = live.observe({ pitches: [70], atMs: 625 })
    expect(state.played).toEqual([{ pitch: 70, role: 'extra' }])
    expect(state.missing).toEqual([61])
    expect(state.status).toBe('different')
  })

  it('stops on a wrong note instead of finding it somewhere in the score', () => {
    // 70 is written at the very end of this passage. The old follower would
    // jump there; the passage now stays where the player is.
    const live = tracker(scale(11))
    live.observe({ pitches: [60], atMs: 0 })
    const stuck = live.observe({ pitches: [70], atMs: 625 })
    expect(stuck.target?.onsetBeat).toBe(1)
    expect(stuck.blocked).toBe(true)
    const stillStuck = live.observe({ pitches: [70], atMs: 1_250 })
    expect(stillStuck.target?.onsetBeat).toBe(1)
    expect(live.observe({ pitches: [61], atMs: 1_875 }).status).toBe('corrected')
    expect(live.observe({ pitches: [62], atMs: 2_500 }).target?.onsetBeat).toBe(2)
  })

  it('waits for the other hand before moving on', () => {
    const live = tracker(TWO_HANDS)
    const rightOnly = live.observe({ pitches: [60], atMs: 0 })
    expect(rightOnly.status).toBe('partial')
    expect(rightOnly.outstanding).toEqual([{ pitch: 48, hand: 'left' }])
    expect(rightOnly.blocked).toBe(false)
    // The left hand lands 300 ms later — far outside any chord window, and
    // still the same position on the page.
    const both = live.observe({ pitches: [48], atMs: 300 })
    expect(both.status).toBe('match')
    expect(both.target?.onsetBeat).toBe(0)
    expect(live.observe({ pitches: [60], atMs: 625 }).target?.onsetBeat).toBe(1)
  })

  it('accepts both hands struck together as one position', () => {
    const live = tracker(TWO_HANDS)
    const state = live.observe({ pitches: [48, 60], atMs: 0 })
    expect(state.status).toBe('match')
    expect(state.outstanding).toEqual([])
  })

  it('times a position from the first hand that lands, not the second', () => {
    const live = tracker(TWO_HANDS)
    live.observe({ pitches: [48, 60], atMs: 0 })
    live.observe({ pitches: [60], atMs: 625 })
    // The right hand is on time at beat 2; the left hand joining late must not
    // re-time it, and must not be reported as a note of its own.
    const onBeat = live.observe({ pitches: [67], atMs: 1_250 })
    expect(onBeat.timing?.reference).toBe('elapsed')
    expect(onBeat.timing?.label).toBe('onTime')
  })

  it('records a trace of the played notes with their timing', () => {
    const live = tracker(scale(4))
    live.observe({ pitches: [60], atMs: 5_000 })
    live.observe({ pitches: [61], atMs: 5_625 })
    live.observe({ pitches: [62], atMs: 6_800 })
    expect(live.traceNotes.map((note) => note.pitch)).toEqual([60, 61, 62])
    expect(live.traceNotes[0].timing).toBe('onTime')
    expect(live.traceNotes[2].timing).toBe('late')
  })

  it('makes no timing claim for a note played where the passage is held', () => {
    const live = tracker(scale(8))
    live.observe({ pitches: [60], atMs: 0 })
    const stuck = live.observe({ pitches: [99], atMs: 690 })
    expect(stuck.timing?.reference).toBe('unplaced')
    const stillStuck = live.observe({ pitches: [98], atMs: 3_900 })
    expect(stillStuck.timing?.reference).toBe('unplaced')
  })

  it('makes no timing claim when the deviation is beyond tracking range', () => {
    const live = tracker(scale(8))
    live.observe({ pitches: [60], atMs: 0 })
    // Onset 1 is one beat (625 ms) in; arriving 2.5 s later is not "late".
    const adrift = live.observe({ pitches: [61], atMs: 3_100 })
    expect(adrift.timing?.reference).toBe('unplaced')
  })

  it('still reports an ordinary late note', () => {
    const live = tracker(scale(8))
    live.observe({ pitches: [60], atMs: 0 })
    const late = live.observe({ pitches: [61], atMs: 900 })
    expect(late.timing?.reference).toBe('elapsed')
    expect(late.timing?.label).toBe('late')
    expect(Math.round(late.timing!.deltaMs)).toBe(275)
  })

  it('keeps a partially played chord on its own onset', () => {
    const live = tracker(CHORD)
    live.observe({ pitches: [60], atMs: 0 })
    const state = live.observe({ pitches: [64], atMs: 625 })
    expect(state.status).toBe('partial')
    expect(state.missing).toEqual([67])
    expect(state.target?.onsetBeat).toBe(1)
  })

  it('moves past a position the player chooses to skip', () => {
    const live = tracker(TWO_HANDS)
    live.observe({ pitches: [60], atMs: 0 })
    const skipped = live.skipCurrent()
    expect(skipped.target?.onsetBeat).toBe(1)
    expect(live.observe({ pitches: [60], atMs: 625 }).status).toBe('match')
  })
})

describe('correcting a mistake', () => {
  it('marks the fix as corrected rather than as a clean hit', () => {
    const live = tracker(scale(8))
    live.observe({ pitches: [60], atMs: 0 })
    expect(live.state.status).toBe('match')
    const wrong = live.observe({ pitches: [70], atMs: 625 })
    expect(wrong.status).toBe('different')
    expect(live.observe({ pitches: [61], atMs: 900 }).status).toBe('corrected')
  })

  it('does not carry a correction forward to the next note', () => {
    const live = tracker(scale(8))
    live.observe({ pitches: [60], atMs: 0 })
    live.observe({ pitches: [70], atMs: 625 })
    live.observe({ pitches: [61], atMs: 900 })
    expect(live.observe({ pitches: [62], atMs: 1_500 }).status).toBe('match')
  })

  it('does not call a second hand arriving late a correction', () => {
    // Waiting for the other hand is not a mistake, so completing the position
    // is a clean match rather than a fix.
    const live = tracker(TWO_HANDS)
    live.observe({ pitches: [60], atMs: 0 })
    expect(live.observe({ pitches: [48], atMs: 200 }).status).toBe('match')
  })

  it('a half-played chord finished after a wrong note is a correction', () => {
    const live = tracker(CHORD)
    live.observe({ pitches: [60], atMs: 0 })
    expect(live.observe({ pitches: [64, 70], atMs: 625 }).status).toBe('partial')
    expect(live.observe({ pitches: [67], atMs: 900 }).status).toBe('corrected')
  })
})

describe('repeated notes', () => {
  // 小星星 opens C C G G — the same pitch twice in a row, which is where a
  // score-searching follower used to place one strike on the wrong onset.
  const TWINKLE = [60, 60, 67, 67].map((pitch, index) => event({
    eventId: `t:RH:m1:b${index}:1`, measureNo: 1, onsetBeat: index,
    absoluteBeat: index, pitches: [pitch],
  }))

  it('advances one position per strike', () => {
    const live = tracker(TWINKLE)
    const beats = [0, 625, 1_250, 1_875].map((atMs, index) =>
      live.observe({ pitches: [TWINKLE[index].pitches[0]], atMs }).target?.onsetBeat)
    expect(beats).toEqual([0, 1, 2, 3])
  })
})
