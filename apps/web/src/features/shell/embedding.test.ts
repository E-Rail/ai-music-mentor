import { afterEach, describe, expect, it } from 'vitest'
import { isEmbedded, withEmbeddedNote } from './embedding'

const original = globalThis.window

function pretendWindow(value: unknown) {
  Object.defineProperty(globalThis, 'window', {
    value, writable: true, configurable: true,
  })
}

afterEach(() => { pretendWindow(original) })

describe('telling a framed page apart from a refused permission', () => {
  it('says no when the page is its own top', () => {
    const self = { location: { origin: 'https://example.hf.space' } } as never
    pretendWindow(Object.assign(self, { self, top: self }))
    expect(isEmbedded()).toBe(false)
  })

  it('says yes when something else is the top', () => {
    const self = { location: { origin: 'https://example.hf.space' } }
    pretendWindow(Object.assign(self, { self, top: { other: true } }))
    expect(isEmbedded()).toBe(true)
  })

  it('treats a cross-origin window.top that throws as framed', () => {
    // A frame on another origin cannot read its own top, and the throw is the
    // only evidence available — so it has to count as a yes rather than crash.
    const self = { location: { origin: 'https://example.hf.space' } }
    pretendWindow(Object.defineProperty(Object.assign(self, { self }), 'top', {
      get() { throw new DOMException('cross-origin', 'SecurityError') },
    }))
    expect(isEmbedded()).toBe(true)
  })

  it('says no where there is no window at all', () => {
    // The capture modules are imported by tests and by tooling that runs in
    // Node, and neither should be told to open a tab.
    pretendWindow(undefined)
    expect(isEmbedded()).toBe(false)
  })
})

describe('what a student is told when a permission fails', () => {
  it('leaves the browser\'s own advice alone on a top-level page', () => {
    const self = { location: { origin: 'https://example.hf.space' } } as never
    pretendWindow(Object.assign(self, { self, top: self }))
    expect(withEmbeddedNote('麦克风被阻止。')).toBe('麦克风被阻止。')
  })

  it('names the address to open when the frame is the reason', () => {
    const self = { location: { origin: 'https://example.hf.space' } }
    pretendWindow(Object.assign(self, { self, top: { other: true } }))
    const message = withEmbeddedNote('麦克风被阻止。')
    expect(message).toContain('麦克风被阻止。')
    // The address has to be the real one, not a placeholder left unfilled.
    expect(message).toContain('https://example.hf.space')
    expect(message).not.toContain('{address}')
  })
})
