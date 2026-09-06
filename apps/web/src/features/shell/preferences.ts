/**
 * Everything the player gets to choose about the studio.
 *
 * One primitive, four preferences. Each is declared once — its storage key, its
 * fallback, what counts as a valid value, and the attribute CSS reads it from —
 * and the same read/write/subscribe path serves all of them. Adding a fifth
 * preference is a declaration, not another copy of this logic.
 *
 * Storage can refuse: a private window, cleared site data, a browser set to
 * block it. A preference is never worth an exception, so every access falls
 * back to the default and the studio carries on unsaved.
 */

export type Theme = 'light' | 'dark' | 'system'
export type Finish = 'ebony' | 'rosewood' | 'walnut' | 'ivory'
export type Locale = 'zh-Hans' | 'en-US'
export type LocaleChoice = Locale | 'system'
/**
 * How much detail the report shows.
 *
 * Not a feature gate and not a paywall: standard answers "what should I work
 * on", pro answers "show me the measurements behind that". Nothing a player
 * needs is hidden in standard, and nothing in pro is about the machinery —
 * it is all detail about the playing.
 */
export type Depth = 'standard' | 'pro'

export interface Preference<T extends string> {
  readonly key: string
  readonly fallback: T
  readonly values: readonly T[]
  /** The data-* attribute on <html> that CSS keys off, when there is one. */
  readonly attribute?: string
}

export const THEME: Preference<Theme> = {
  key: 'theme', fallback: 'system', values: ['light', 'dark', 'system'],
  attribute: 'theme',
}
export const FINISH: Preference<Finish> = {
  key: 'finish', fallback: 'ebony',
  values: ['ebony', 'rosewood', 'walnut', 'ivory'], attribute: 'finish',
}
export const LOCALE: Preference<LocaleChoice> = {
  key: 'locale', fallback: 'system', values: ['zh-Hans', 'en-US', 'system'],
}
export const DEPTH: Preference<Depth> = {
  key: 'depth', fallback: 'standard', values: ['standard', 'pro'],
  attribute: 'depth',
}

const NAMESPACE = 'studio.'

export function isValid<T extends string>(preference: Preference<T>,
  value: unknown): value is T {
  return typeof value === 'string' &&
    (preference.values as readonly string[]).includes(value)
}

export function read<T extends string>(preference: Preference<T>): T {
  try {
    const stored = window.localStorage.getItem(NAMESPACE + preference.key)
    return isValid(preference, stored) ? stored : preference.fallback
  } catch {
    return preference.fallback
  }
}

export function write<T extends string>(preference: Preference<T>, value: T): void {
  try {
    window.localStorage.setItem(NAMESPACE + preference.key, value)
  } catch { /* the studio still works unsaved */ }
}

// ---------------------------------------------------------------- the document

/**
 * Put the resolved choices where CSS and assistive tech can see them.
 *
 * `system` is resolved here rather than in CSS so one attribute always states
 * what is actually on screen: a stylesheet that has to answer both
 * `[data-theme="dark"]` and a media query in every rule gets one of them wrong
 * eventually.
 */
export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  root.dataset.theme = resolveTheme(theme)
  // Scrollbars, form controls and the canvas the browser paints behind the page
  // all follow this; without it a light page keeps dark native furniture.
  root.style.colorScheme = resolveTheme(theme)
}

export function applyFinish(finish: Finish): void {
  document.documentElement.dataset.finish = finish
}

export function applyDepth(depth: Depth): void {
  document.documentElement.dataset.depth = depth
}

// ---------------------------------------------------------------- language

/**
 * Which language to open in when the player has not chosen one.
 *
 * Every Chinese tag resolves to Simplified, traditional-script ones included:
 * zh-Hant, zh-TW and zh-HK are not translated separately here, and a reader of
 * traditional Chinese is far better served by Simplified than by a language
 * they may not read at all. Everything outside Chinese gets English.
 */
export function detectLocale(
  languages: readonly string[] = typeof navigator === 'undefined'
    ? [] : navigator.languages ?? [navigator.language]): Locale {
  for (const tag of languages) {
    if (tag.toLowerCase().startsWith('zh')) return 'zh-Hans'
  }
  return 'en-US'
}

export function resolveLocale(choice: LocaleChoice): Locale {
  return choice === 'system' ? detectLocale() : choice
}

// ---------------------------------------------------------------- migration

/**
 * Carry forward the one preference that existed before this module.
 *
 * `ui-scale` held 'starter' | 'pro'. The values are the same idea under a
 * clearer name, so a player who chose the denser screen keeps it rather than
 * being quietly reset on upgrade. Runs once; the old key is then removed.
 */
export function migrateLegacyScale(): void {
  try {
    const legacy = window.localStorage.getItem('ui-scale')
    if (!legacy) return
    if (window.localStorage.getItem(NAMESPACE + DEPTH.key) === null) {
      write(DEPTH, legacy === 'pro' ? 'pro' : 'standard')
    }
    window.localStorage.removeItem('ui-scale')
  } catch { /* nothing to carry forward */ }
}

/** Read every stored choice and put it on the document. Call once, at boot. */
export function applyStoredPreferences(): void {
  migrateLegacyScale()
  applyTheme(read(THEME))
  applyFinish(read(FINISH))
  applyDepth(read(DEPTH))
}
