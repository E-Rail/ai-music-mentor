import { describe, expect, it } from 'vitest'
import { moduleScopeTranslations, parse, productSources, where } from './sourceScan'

/**
 * `t()` answers in whatever language is active when it is called. Called while
 * a module loads, that is always the default — so a table of labels built at the
 * top of a file stays Chinese for the life of the page, whatever the player
 * picks. That is how the four stage titles, every microphone state and the
 * mentor's quick questions stayed Chinese in English mode. Build such tables
 * from message keys and translate them at render.
 */
describe('translation happens at render', () => {
  it('never calls t or tf while a module loads', () => {
    const offenders = productSources().flatMap((file) => {
      const source = parse(file)
      return moduleScopeTranslations(source).map((call) =>
        `${where(source, call)}  ${call.getText(source).slice(0, 60)}`)
    })
    expect(offenders, `translate these inside the component instead:\n${
      offenders.join('\n')}`).toEqual([])
  })
})
