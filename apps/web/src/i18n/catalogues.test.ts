import { describe, expect, it } from 'vitest'
import { enUS } from './en-US'
import { zhHans } from './zh-Hans'
import {
  CADENCE_LABEL, ERROR_TYPE_LABEL, EXERCISE_STRATEGIES, METRIC_LABEL,
  SEVERITY_LABEL, getLocale, setLocale, t, tf,
} from './messages'

const placeholders = (message: string) =>
  [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()

describe('the two catalogues stay in step', () => {
  it('has an English string for every Chinese one', () => {
    expect(Object.keys(enUS).sort()).toEqual(Object.keys(zhHans).sort())
  })

  it('leaves no message empty', () => {
    // liveHandUnknown is deliberately blank: an unattributed hand is named by
    // saying nothing, not by saying "unknown".
    const allowedBlank = new Set(['liveHandUnknown'])
    for (const [key, value] of Object.entries(enUS)) {
      if (allowedBlank.has(key)) continue
      expect(value.trim(), `en-US ${key} is empty`).not.toBe('')
    }
  })

  it('keeps every placeholder a translation is given', () => {
    for (const key of Object.keys(zhHans) as (keyof typeof zhHans)[]) {
      expect(placeholders(enUS[key]), `placeholders differ for ${key}`)
        .toEqual(placeholders(zhHans[key]))
    }
  })

  it('does not leave Chinese characters in the English catalogue', () => {
    for (const [key, value] of Object.entries(enUS)) {
      expect(/[一-鿿]/.test(value), `en-US ${key} still has Chinese`)
        .toBe(false)
    }
  })
})

describe('switching language', () => {
  it('changes what t returns', () => {
    setLocale('zh-Hans')
    expect(t('settingsTitle')).toBe('设置')
    setLocale('en-US')
    expect(t('settingsTitle')).toBe('Settings')
    expect(getLocale()).toBe('en-US')
  })

  it('changes what tf interpolates into', () => {
    setLocale('en-US')
    expect(tf('trackNumber', { number: 3 })).toBe('Track 3')
    setLocale('zh-Hans')
    expect(tf('trackNumber', { number: 3 })).toBe('轨道 3')
  })

  it('carries the label maps with it', () => {
    // These are imported by value across a dozen components, so they are
    // refilled in place rather than replaced. If that ever regresses, the
    // labels silently stay in the previous language.
    setLocale('en-US')
    expect(ERROR_TYPE_LABEL.wrong_pitch).toBe('Wrong note')
    expect(SEVERITY_LABEL.high).toBe('Serious')
    expect(METRIC_LABEL.pitchScore).toBe('Pitch')
    expect(CADENCE_LABEL.half).toBe('Half cadence')
    expect(EXERCISE_STRATEGIES.find(([id]) => id === 'loop')?.[1])
      .toBe('Loop a passage')

    setLocale('zh-Hans')
    expect(ERROR_TYPE_LABEL.wrong_pitch).toBe('错音')
    expect(SEVERITY_LABEL.high).toBe('严重')
    expect(EXERCISE_STRATEGIES.find(([id]) => id === 'loop')?.[1]).toBe('片段循环')
  })

  it('keeps the strategy list complete and ordered in both languages', () => {
    setLocale('en-US')
    const english = EXERCISE_STRATEGIES.map(([id]) => id)
    setLocale('zh-Hans')
    expect(EXERCISE_STRATEGIES.map(([id]) => id)).toEqual(english)
    expect(english[0]).toBe('auto')
    expect(english).toHaveLength(7)
  })
})
