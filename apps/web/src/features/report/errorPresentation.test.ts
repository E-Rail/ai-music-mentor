import { describe, expect, it } from 'vitest'
import type { ErrorEvent, Evidence } from '../../types'
import { errorDetailForDisplay } from './errorPresentation'

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
