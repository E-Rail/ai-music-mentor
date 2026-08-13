import { beforeEach, describe, expect, it } from 'vitest'
import {
  measureLabel, measureLabelList, renumberMeasures, setScoreMeasureLabels,
} from './measureLabels'

const twoParts = (numbers: string[]) => `<?xml version="1.0"?>
<score-partwise>
<part-list><score-part id="P1"><part-name>Right Hand</part-name></score-part>
<score-part id="P2"><part-name>Left Hand</part-name></score-part></part-list>
<part id="P1">${numbers.map((n) => `<measure number="${n}"><note/></measure>`).join('')}</part>
<part id="P2">${numbers.map((n) => `<measure number="${n}"><note/></measure>`).join('')}</part>
</score-partwise>`

describe('measureLabel', () => {
  beforeEach(() => setScoreMeasureLabels([]))

  it('falls back to the position when the score published no labels', () => {
    expect(measureLabel(3)).toBe('3')
  })

  it('speaks the number printed on the page', () => {
    setScoreMeasureLabels(['0', '1', '2', '3'])
    // The pickup is bar 0, so timeline position 4 is printed as 3.
    expect(measureLabel(1)).toBe('0')
    expect(measureLabel(4)).toBe('3')
  })

  it('falls back for a bar the label list does not reach', () => {
    setScoreMeasureLabels(['0', '1'])
    expect(measureLabel(5)).toBe('5')
  })

  it('ignores a blank label rather than showing an empty bar number', () => {
    setScoreMeasureLabels(['1', '  ', '3'])
    expect(measureLabel(2)).toBe('2')
  })

  it('lists bars in the order given', () => {
    setScoreMeasureLabels(['0', '1', '2'])
    expect(measureLabelList([1, 3])).toBe('0、2')
  })
})

describe('renumberMeasures', () => {
  beforeEach(() => setScoreMeasureLabels([]))

  it('leaves the file alone when the score published no labels', () => {
    const xml = twoParts(['0', '0'])
    expect(renumberMeasures(xml)).toBe(xml)
  })

  it('replaces unusable numbers in every part', () => {
    setScoreMeasureLabels(['1', '2', '3'])
    const rewritten = renumberMeasures(twoParts(['0', '0', '0']))
    expect(rewritten.match(/number="1"/g)).toHaveLength(2)
    expect(rewritten.match(/number="2"/g)).toHaveLength(2)
    expect(rewritten).not.toContain('number="0"')
  })

  it('keeps other attributes on the measure tag', () => {
    setScoreMeasureLabels(['0', '1'])
    const xml = '<part id="P1"><measure implicit="yes" number="9" width="70"/>' +
      '<measure number="10" width="80"/></part>'
    const rewritten = renumberMeasures(xml)
    expect(rewritten).toContain('<measure implicit="yes" number="0" width="70"/>')
    expect(rewritten).toContain('<measure number="1" width="80"/>')
  })

  it('adds a number to a measure that carries none', () => {
    setScoreMeasureLabels(['1', '2'])
    const rewritten = renumberMeasures('<part id="P1"><measure><note/></measure>' +
      '<measure><note/></measure></part>')
    expect(rewritten).toContain('<measure number="1">')
    expect(rewritten).toContain('<measure number="2">')
  })

  it('refuses to renumber a part whose bar count disagrees with the timeline', () => {
    // Repeats expanded into the timeline but not into the page: renaming bars
    // under that mismatch would point the student at the wrong one.
    setScoreMeasureLabels(['1', '2', '3', '4'])
    const xml = twoParts(['1', '2'])
    expect(renumberMeasures(xml)).toBe(xml)
  })

  it('leaves the part list alone', () => {
    setScoreMeasureLabels(['1', '2'])
    const rewritten = renumberMeasures(twoParts(['0', '0']))
    expect(rewritten).toContain('<part-name>Right Hand</part-name>')
    expect(rewritten).toContain('<part-name>Left Hand</part-name>')
    expect(rewritten.match(/<measure number="1">/g)).toHaveLength(2)
    expect(rewritten.match(/<measure number="2">/g)).toHaveLength(2)
  })

  it('does not touch text outside a part', () => {
    setScoreMeasureLabels(['1'])
    const xml = '<work><work-title>measure 0</work-title></work>' +
      '<part id="P1"><measure number="0"/></part>'
    const rewritten = renumberMeasures(xml)
    expect(rewritten).toContain('<work-title>measure 0</work-title>')
    expect(rewritten).toContain('<measure number="1"/>')
  })
})
