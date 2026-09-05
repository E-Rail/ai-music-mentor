import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEPTH, FINISH, LOCALE, THEME, detectLocale, migrateLegacyScale, read,
  resolveLocale, write,
} from './preferences'

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v) },
    removeItem: (k: string) => { map.delete(k) },
    clear: () => { map.clear() },
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size },
  } as Storage
}

beforeEach(() => {
  vi.stubGlobal('window', { localStorage: memoryStorage() })
})

describe('reading a preference', () => {
  it('falls back to the default when nothing is stored', () => {
    expect(read(THEME)).toBe('system')
    expect(read(FINISH)).toBe('ebony')
    expect(read(DEPTH)).toBe('standard')
  })

  it('rejects a stored value that is not one of the choices', () => {
    window.localStorage.setItem('studio.finish', 'mahogany')
    expect(read(FINISH)).toBe('ebony')
  })

  it('returns what was written', () => {
    write(FINISH, 'walnut')
    expect(read(FINISH)).toBe('walnut')
  })

  it('survives storage that refuses to answer', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem() { throw new Error('blocked') },
        setItem() { throw new Error('blocked') },
      },
    })
    expect(read(THEME)).toBe('system')
    expect(() => write(THEME, 'dark')).not.toThrow()
  })
})

describe('choosing a language for a first visit', () => {
  it('opens in Simplified Chinese for a Simplified reader', () => {
    expect(detectLocale(['zh-CN', 'en-US'])).toBe('zh-Hans')
  })

  it('opens in Simplified Chinese for a traditional-script reader', () => {
    // Not translated separately; Simplified serves them far better than English.
    expect(detectLocale(['zh-Hant'])).toBe('zh-Hans')
    expect(detectLocale(['zh-TW'])).toBe('zh-Hans')
    expect(detectLocale(['zh-HK'])).toBe('zh-Hans')
  })

  it('opens in English for everyone else', () => {
    expect(detectLocale(['en-GB'])).toBe('en-US')
    expect(detectLocale(['ja-JP', 'ko-KR'])).toBe('en-US')
    expect(detectLocale([])).toBe('en-US')
  })

  it('follows the first Chinese tag even when it is not first overall', () => {
    expect(detectLocale(['fr-FR', 'zh-CN'])).toBe('zh-Hans')
  })

  it('honours an explicit choice over the system', () => {
    expect(resolveLocale('en-US')).toBe('en-US')
    expect(resolveLocale('zh-Hans')).toBe('zh-Hans')
  })
})

describe('carrying forward the old ui-scale choice', () => {
  it('keeps a player who chose the denser screen on it', () => {
    window.localStorage.setItem('ui-scale', 'pro')
    migrateLegacyScale()
    expect(read(DEPTH)).toBe('pro')
    expect(window.localStorage.getItem('ui-scale')).toBeNull()
  })

  it('maps the old starter name to standard', () => {
    window.localStorage.setItem('ui-scale', 'starter')
    migrateLegacyScale()
    expect(read(DEPTH)).toBe('standard')
  })

  it('does not overwrite a choice already made in the new settings', () => {
    write(DEPTH, 'standard')
    window.localStorage.setItem('ui-scale', 'pro')
    migrateLegacyScale()
    expect(read(DEPTH)).toBe('standard')
  })

  it('does nothing when there is nothing to carry forward', () => {
    expect(() => migrateLegacyScale()).not.toThrow()
    expect(read(DEPTH)).toBe('standard')
  })
})

describe('the locale preference itself', () => {
  it('defaults to following the system', () => {
    expect(read(LOCALE)).toBe('system')
  })
})
