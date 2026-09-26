import { describe, expect, it } from 'vitest'
import { ERROR_TYPE_LABEL } from '../../i18n/messages'
import { ERROR_INK } from './errorPalette'

describe('one ink per kind of mistake', () => {
  it('draws every kind of mistake the report can name', () => {
    // A type without ink falls back to the wrong-note colour, which would call
    // a stop a wrong note on the page.
    for (const type of Object.keys(ERROR_TYPE_LABEL)) expect(ERROR_INK[type]).toBeDefined()
  })

  it('draws only a note that never sounded as hollow', () => {
    // The page labels a hollow mark "missed", so hollow has exactly one meaning.
    const hollow = Object.entries(ERROR_INK).filter(([, ink]) => ink.hollow).map(([type]) => type)
    expect(hollow).toEqual(['missed_note'])
  })
})
