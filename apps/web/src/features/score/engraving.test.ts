import { describe, expect, it } from 'vitest'
import { retitle } from './engraving'

describe('the engraved title is the one the app uses', () => {
  it('replaces every title the file carries', () => {
    const xml = '<score-partwise><work><work-title>小星星</work-title></work>' +
      '<movement-title>Music21 Fragment</movement-title></score-partwise>'
    expect(retitle(xml, 'Twinkle, Twinkle')).toBe(
      '<score-partwise><work><work-title>Twinkle, Twinkle</work-title></work>' +
      '<movement-title>Twinkle, Twinkle</movement-title></score-partwise>')
  })

  it('adds one when the file has none', () => {
    expect(retitle('<score-partwise version="4.0"><part-list/></score-partwise>', 'Étude'))
      .toBe('<score-partwise version="4.0"><movement-title>Étude</movement-title><part-list/></score-partwise>')
  })

  it('escapes what it writes and leaves the file alone without a title', () => {
    expect(retitle('<score-partwise><movement-title>x</movement-title></score-partwise>', 'A & B <C>'))
      .toContain('<movement-title>A &amp; B &lt;C&gt;</movement-title>')
    expect(retitle('<score-partwise/>', undefined)).toBe('<score-partwise/>')
    expect(retitle('<score-partwise/>', '  ')).toBe('<score-partwise/>')
  })
})
