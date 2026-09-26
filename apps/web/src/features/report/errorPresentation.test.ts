import { describe, expect, it } from 'vitest'
import type { ErrorEvent, Evidence } from '../../types'
import { errorDetailForDisplay, evidenceNotes } from './errorPresentation'

const baseError: ErrorEvent = {
  id: 'err_1',
  type: 'extra_note',
  location: { measure: 1, beat: 3, eventId: null, eventIds: [] },
  severity: 'medium',
  evidenceIds: ['ev_1'],
  confidence: 0.7,
  detail: 'group:g_0003',
}

const evidence: Evidence = {
  id: 'ev_1', fact: '第 1 小节附近多弹 G4', measureNo: 1, beat: 3,
  expected: '（无此音）', actual: 'G4', deltaMs: null,
}

describe('error detail presentation', () => {
  it('turns a legacy group ID into useful musical detail', () => {
    expect(errorDetailForDisplay(baseError, [evidence])).toBe('实际多弹 G4')
  })

  it('never exposes an internal group ID when evidence is unavailable', () => {
    expect(errorDetailForDisplay(baseError, [])).toBe('')
  })

  it('preserves an already user-facing detail', () => {
    expect(errorDetailForDisplay({ ...baseError, detail: '实际多弹 C#5' }, [])).toBe('实际多弹 C#5')
  })
})

describe('what evidence can play back', () => {
  const evidence = (fields: Partial<Evidence>): Evidence => ({
    id: 'ev', fact: '', measureNo: 1, beat: 0, expected: '', actual: '', deltaMs: null,
    ...fields,
  })

  it('plays the notes the report names, whatever language the sentence is in', () => {
    const wrong = evidence({ expected: 'G4', actual: 'G#4', expectedPitches: [67], actualPitches: [68] })
    expect(evidenceNotes(wrong, 'expected')).toEqual([67])
    expect(evidenceNotes(wrong, 'actual')).toEqual([68])
  })

  it('offers nothing to play for evidence that is not about notes', () => {
    const chord = evidence({ expected: 'all chord notes together', actual: 'off by +140 ms',
      expectedPitches: [], actualPitches: [] })
    expect(evidenceNotes(chord, 'expected')).toEqual([])
  })

  it('still reads the notes out of a report written before they were sent', () => {
    expect(evidenceNotes(evidence({ expected: 'C4/E4' }), 'expected')).toEqual([60, 64])
  })
})
