import { useEffect, useId, useRef } from 'react'
import { t, tf, type MessageKey } from '../../i18n/messages'
import type { Depth, Finish, LocaleChoice, Theme } from './preferences'

interface Choice<T extends string> {
  id: T
  /** Omitted when the choice names itself — see LANGUAGE_NAMES. */
  label?: MessageKey
  hint?: MessageKey
}

const THEMES: Choice<Theme>[] = [
  { id: 'light', label: 'settingsThemeLight' },
  { id: 'dark', label: 'settingsThemeDark' },
  { id: 'system', label: 'settingsThemeSystem' },
]
const FINISHES: Choice<Finish>[] = [
  { id: 'ebony', label: 'settingsFinishEbony' },
  { id: 'rosewood', label: 'settingsFinishRosewood' },
  { id: 'walnut', label: 'settingsFinishWalnut' },
  { id: 'ivory', label: 'settingsFinishIvory' },
]
// A language is written in itself, never translated: someone looking for their
// own language is looking for the word they already recognise.
const LOCALES: Choice<LocaleChoice>[] = [
  { id: 'zh-Hans' },
  { id: 'en-US' },
  { id: 'system', label: 'settingsLanguageSystem' },
]
const DEPTHS: Choice<Depth>[] = [
  { id: 'standard', label: 'settingsDepthStandard', hint: 'settingsDepthStandardHint' },
  { id: 'pro', label: 'settingsDepthPro', hint: 'settingsDepthProHint' },
]

/** Language names are written in the language they name, never translated. */
const LANGUAGE_NAMES: Record<string, string> = {
  'zh-Hans': '简体中文',
  'en-US': 'English',
}

function Group<T extends string>({ legend, choices, value, onChange, naming }: {
  legend: string
  choices: Choice<T>[]
  value: T
  onChange: (next: T) => void
  naming?: Record<string, string>
}) {
  const name = useId()
  return (
    <fieldset className="settings-group">
      <legend>{legend}</legend>
      <div className="settings-choices">
        {choices.map((choice) => (
          <label key={choice.id} className="settings-choice">
            <input
              type="radio"
              name={name}
              value={choice.id}
              checked={value === choice.id}
              onChange={() => onChange(choice.id)}
            />
            <span className="settings-choice-body">
              <span className="settings-choice-label">
                {naming?.[choice.id] ?? (choice.label ? t(choice.label) : choice.id)}
              </span>
              {choice.hint && (
                <span className="settings-choice-hint">{t(choice.hint)}</span>
              )}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

export function SettingsDialog({
  open, onClose, theme, onTheme, finish, onFinish, locale, onLocale, depth, onDepth,
}: {
  open: boolean
  onClose: () => void
  theme: Theme
  onTheme: (next: Theme) => void
  finish: Finish
  onFinish: (next: Finish) => void
  locale: LocaleChoice
  onLocale: (next: LocaleChoice) => void
  depth: Depth
  onDepth: (next: Depth) => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  // Escape closes, and focus is kept inside while it is open: a modal you can
  // tab out of leaves a keyboard user editing a form they cannot see.
  useEffect(() => {
    if (!open) return
    const node = dialogRef.current
    node?.querySelector<HTMLElement>('input, button')?.focus()
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') { onClose(); return }
      if (event.key !== 'Tab' || !node) return
      const focusable = node.querySelectorAll<HTMLElement>(
        'input:not([disabled]), button:not([disabled]), a[href]')
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="settings-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div className="settings-dialog" role="dialog" aria-modal="true"
           aria-labelledby={titleId} ref={dialogRef}>
        <div className="settings-header">
          <h2 id={titleId}>{t('settingsTitle')}</h2>
          <button type="button" className="btn btn-sm" onClick={onClose}
                  aria-label={t('settingsClose')}>✕</button>
        </div>

        <div className="settings-body">
          <section>
            <h3>{t('settingsAppearance')}</h3>
            <Group legend={t('settingsTheme')} choices={THEMES}
                   value={theme} onChange={onTheme} />
            <Group legend={t('settingsFinish')} choices={FINISHES}
                   value={finish} onChange={onFinish} />
            <p className="settings-note">{t('settingsFinishHint')}</p>
          </section>

          <section>
            <h3>{t('settingsLanguage')}</h3>
            <Group legend={t('settingsLanguage')} choices={LOCALES}
                   value={locale} onChange={onLocale} naming={LANGUAGE_NAMES} />
            <p className="settings-note">{t('settingsLanguageHint')}</p>
          </section>

          <section>
            <h3>{t('settingsDepth')}</h3>
            <Group legend={t('settingsDepth')} choices={DEPTHS}
                   value={depth} onChange={onDepth} />
          </section>

          <section className="settings-about">
            <h3>{t('settingsAbout')}</h3>
            <p className="settings-note">{tf('settingsAboutVersion', { version: '2.0.0' })}</p>
            <p className="settings-note">
              <a href="/docs" target="_blank" rel="noreferrer">{t('settingsAboutDocs')}</a>
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
