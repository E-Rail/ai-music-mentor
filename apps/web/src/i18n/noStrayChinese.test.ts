import { describe, expect, it } from 'vitest'
import { literalText, parse, productSources, where } from './sourceScan'

/**
 * Chinese characters, and the punctuation that travels with them: 、，；：（）
 * and the rest of the CJK symbol and full-width blocks. The first version of
 * this guard only looked for characters, so a hardcoded '；' joining two English
 * findings sailed through.
 */
const CJK = /[　-〿㐀-鿿＀-￯]/

/**
 * Files that are Chinese on purpose.
 *
 * A language names itself in its own language, and the score parser matches the
 * words a Chinese-engraved MusicXML part is actually called — neither is
 * interface copy, and translating either would break something.
 */
const DELIBERATE = new Set([
  'features/shell/SettingsDialog.tsx',
  'features/score/hands.ts',
])

describe('all product copy lives in the catalogue', () => {
  it('has no Chinese text or punctuation left in components, adapters or workers', () => {
    const offenders: string[] = []
    for (const file of productSources()) {
      const source = parse(file)
      if (DELIBERATE.has(where(source, source).split(':')[0])) continue
      for (const { node, text } of literalText(source)) {
        if (CJK.test(text)) offenders.push(`${where(source, node)}  ${text.trim().slice(0, 60)}`)
      }
    }
    expect(offenders, `move these into i18n/zh-Hans.ts and en-US.ts:\n${
      offenders.join('\n')}`).toEqual([])
  })
})
