/**
 * Product copy, in the language the player chose.
 *
 * Components and infrastructure should only use these keys, so a locale can be
 * added without rewriting the workflow. Two catalogues exist — zh-Hans is the
 * reference and en-US is typed against it, so a key added to one and forgotten
 * in the other is a build error rather than Chinese text in an English screen.
 *
 * `t` is a plain function rather than a hook on purpose: it is called from
 * nearly five hundred places, including modules that are not components at all.
 * Switching language re-renders from the App root, and because nothing in this
 * tree is memoised, that reaches every caller.
 */
import type { Locale } from '../features/shell/preferences'
import { enUS } from './en-US'
import { zhHans } from './zh-Hans'

export type MessageKey = keyof typeof zhHans

const CATALOGUES: Record<Locale, Record<MessageKey, string>> = {
  'zh-Hans': zhHans,
  'en-US': enUS,
}

let active: Locale = 'zh-Hans'

export function getLocale(): Locale {
  return active
}

/**
 * Switch language.
 *
 * The label maps below are rebuilt in place rather than replaced, because they
 * are imported by value in a dozen components; reassigning the binding here
 * would leave every one of them holding the old object.
 */
export function setLocale(locale: Locale): void {
  active = locale
  refreshLabels()
}

export const t = (key: MessageKey): string => CATALOGUES[active][key]

export function tf(key: MessageKey, values: Record<string, string | number | null | undefined>): string {
  return Object.entries(values).reduce(
    (message, [name, value]) => message.split(`{${name}}`).join(String(value ?? '')),
    CATALOGUES[active][key],
  )
}

// ------------------------------------------------------------------ joiners
// Punctuation is language too. A '；' written into a component reads as a stray
// Chinese mark in an English sentence, so the joins live in the catalogue.

/** Items of one kind: bars, notes. 1、2、3 / 1, 2, 3 */
export const joinList = (items: readonly (string | number)[]): string =>
  items.join(t('listSeparator'))

/** Parts of one statement: a label and where it is. */
export const joinPhrases = (items: readonly (string | number)[]): string =>
  items.join(t('phraseSeparator'))

/** Whole findings, each able to stand as its own sentence. */
export const joinClauses = (items: readonly (string | number)[]): string =>
  items.join(t('clauseSeparator'))

/** A 0–1 confidence as people say it: 39%, not 0.387. */
export const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`

/** "Input quality: high" */
export const labelled = (label: string, value: string | number): string =>
  tf('labelValue', { label, value })

const INSTRUMENT_KEYS: Record<string, MessageKey> = {
  piano: 'instrumentPiano', guitar: 'instrumentGuitar', violin: 'instrumentViolin',
}

export const instrumentLabel = (instrument: string): string =>
  INSTRUMENT_KEYS[instrument] ? t(INSTRUMENT_KEYS[instrument]) : instrument

// ------------------------------------------------------------------- labels
// These name values that arrive from the API as bare codes. They were plain
// Chinese constants until this file learned a second language, which meant they
// stayed Chinese whatever the interface was set to.

const ERROR_TYPES = ['wrong_pitch', 'missed_note', 'extra_note', 'early_late',
  'duration_anomaly', 'tempo_instability', 'dynamics_anomaly', 'hesitation'] as const
const CADENCES = ['half', 'deceptive', 'plagal', 'authentic'] as const
const SEVERITIES = ['high', 'medium', 'low'] as const
const METRICS = ['overallScore', 'pitchScore', 'rhythmScore', 'fluencyScore',
  'dynamicsScore', 'timingMaeMs', 'avgBpm'] as const
export const STRATEGY_IDS = ['auto', 'loop', 'slow_ladder', 'hands_separate',
  'rhythm_variant', 'beat_skeleton', 'chunk_connect'] as const

export const ERROR_TYPE_LABEL: Record<string, string> = {}
export const CADENCE_LABEL: Record<string, string> = {}
export const SEVERITY_LABEL: Record<string, string> = {}
export const METRIC_LABEL: Record<string, string> = {}
/** [id, label] pairs, in the order they are offered to the player. */
export const EXERCISE_STRATEGIES: [string, string][] = []

function fill(target: Record<string, string>, ids: readonly string[],
  prefix: string): void {
  for (const id of ids) target[id] = t(`${prefix}${id}` as MessageKey)
}

function refreshLabels(): void {
  fill(ERROR_TYPE_LABEL, ERROR_TYPES, 'errorType_')
  fill(CADENCE_LABEL, CADENCES, 'cadence_')
  fill(SEVERITY_LABEL, SEVERITIES, 'severity_')
  fill(METRIC_LABEL, METRICS, 'metric_')
  EXERCISE_STRATEGIES.length = 0
  for (const id of STRATEGY_IDS) {
    EXERCISE_STRATEGIES.push([id, t(`strategy_${id}` as MessageKey)])
  }
}

refreshLabels()

export { zhHans, enUS }
