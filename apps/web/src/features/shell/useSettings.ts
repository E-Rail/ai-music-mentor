import { useCallback, useEffect, useState } from 'react'
import { getLocale, setLocale, t } from '../../i18n/messages'
import {
  DEPTH, FINISH, LOCALE, THEME, applyDepth, applyFinish, applyTheme,
  read, resolveLocale, write,
  type Depth, type Finish, type Locale, type LocaleChoice, type Preference, type Theme,
} from './preferences'

/**
 * One hook for every preference.
 *
 * Each returns the stored value and a setter that persists it and puts it on
 * the document in the same breath, so no component has to remember to do both.
 */
function usePreference<T extends string>(preference: Preference<T>,
  apply: (value: T) => void): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => read(preference))
  useEffect(() => { apply(value) }, [apply, value])
  const choose = useCallback((next: T) => {
    write(preference, next)
    setValue(next)
  }, [preference])
  return [value, choose]
}

export function useTheme(): [Theme, (next: Theme) => void] {
  const [theme, choose] = usePreference(THEME, applyTheme)
  // A player on "follow the system" should change with it, not at the next
  // reload. Only that choice listens; an explicit light or dark ignores the OS.
  useEffect(() => {
    if (theme !== 'system') return
    const query = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = () => applyTheme('system')
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [theme])
  return [theme, choose]
}

export function useFinish(): [Finish, (next: Finish) => void] {
  return usePreference(FINISH, applyFinish)
}

export function useDepth(): [Depth, (next: Depth) => void] {
  return usePreference(DEPTH, applyDepth)
}

/**
 * The language choice, and the re-render that makes it visible.
 *
 * `t()` reads a module-level locale rather than a context, so changing it does
 * not by itself repaint anything. Holding the choice in state here — in a
 * component near the root — is what causes the tree below to re-render and call
 * `t()` again. Nothing in this app is memoised, so that reaches every string.
 *
 * Capture is unaffected: a take lives in refs, a worker and IndexedDB, none of
 * which a render touches. Switching language mid-recording is therefore safe
 * and deliberately allowed.
 */
function speak(locale: Locale): void {
  setLocale(locale)
  document.documentElement.lang = locale === 'zh-Hans' ? 'zh-Hans' : 'en'
  document.title = t('appName')
}

/**
 * Put the stored language in place before the first render.
 *
 * Applying it from an effect meant the first paint was always Chinese and an
 * English player saw the interface change language under them on every load.
 */
export function speakStoredLanguage(): void {
  speak(resolveLocale(read(LOCALE)))
}

export function useLocale(): [LocaleChoice, (next: LocaleChoice) => void, Locale] {
  const [choice, setChoice] = useState<LocaleChoice>(() => read(LOCALE))
  // The language actually in use. It is state as well as the choice, because
  // "follow the system" can change what it resolves to without the choice
  // changing — and only a state change re-renders the tree.
  const [spoken, setSpoken] = useState<Locale>(() => resolveLocale(read(LOCALE)))
  const apply = useCallback((next: LocaleChoice) => {
    const resolved = resolveLocale(next)
    speak(resolved)
    setSpoken(resolved)
  }, [])
  useEffect(() => { apply(choice) }, [apply, choice])
  // Following the system means following it while the app is open, the same
  // way the theme does. Only "system" listens; an explicit choice ignores it.
  useEffect(() => {
    if (choice !== 'system') return
    const onLanguageChange = () => apply('system')
    window.addEventListener('languagechange', onLanguageChange)
    return () => window.removeEventListener('languagechange', onLanguageChange)
  }, [apply, choice])
  const choose = useCallback((next: LocaleChoice) => {
    write(LOCALE, next)
    setChoice(next)
    apply(next)
  }, [apply])
  return [choice, choose, spoken]
}

export { getLocale }
