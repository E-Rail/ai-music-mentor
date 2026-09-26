import { describe, expect, it } from 'vitest'
import { STAGES, stageOf, type Step } from './stages'
import { setLocale, t } from '../../i18n/messages'

const STEPS: Step[] = ['select', 'calibrate', 'perform', 'report', 'exercise', 'compare']

describe('the practice loop has five places', () => {
  it('puts every step in exactly one stage', () => {
    for (const step of STEPS) {
      expect(STAGES.filter((stage) => stage.steps.includes(step)), step).toHaveLength(1)
    }
  })

  it('keeps the whole second half of the loop under Practice, not under Review', () => {
    expect(stageOf('report').id).toBe('review')
    expect(stageOf('exercise').id).toBe('practice')
    expect(stageOf('compare').id).toBe('practice')
  })

  it('names every stage in both languages', () => {
    for (const locale of ['zh-Hans', 'en-US'] as const) {
      setLocale(locale)
      for (const stage of STAGES) {
        expect(t(stage.title).trim(), `${locale} ${stage.id}`).not.toBe('')
        expect(t(stage.hint).trim(), `${locale} ${stage.id}`).not.toBe('')
      }
    }
    setLocale('zh-Hans')
  })
})
