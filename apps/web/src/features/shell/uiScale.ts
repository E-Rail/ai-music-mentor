/**
 * How much of the instrument you want on screen at once.
 *
 * Two scales, one product. Starter is roomier — larger type, more air, fewer
 * things competing for attention — for someone finding their way around. Pro
 * packs the same screen tighter so the score, the evidence and the mentor can
 * be read together instead of paged between.
 *
 * It is a *scale*, not a feature gate: nothing is taken away in starter that a
 * player might need, and nothing appears in pro that only an engineer would
 * want. What pro adds is musical depth — the repeated patterns behind a
 * mistake, the confidence on a reading, the full evidence list — which is
 * detail about the playing, not about the machinery.
 */
export type UiScale = 'starter' | 'pro'

const STORAGE_KEY = 'ui-scale'
export const DEFAULT_SCALE: UiScale = 'starter'

export function isUiScale(value: unknown): value is UiScale {
  return value === 'starter' || value === 'pro'
}

/**
 * The stored choice, or the roomier one.
 *
 * Starting a first-time player in pro would be showing them a dense screen
 * before they know what any of it means, so the default errs towards air.
 */
export function readScale(): UiScale {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return isUiScale(stored) ? stored : DEFAULT_SCALE
  } catch {
    // Private browsing can refuse storage. A scale is not worth an exception.
    return DEFAULT_SCALE
  }
}

/**
 * Put the choice on the document element, where CSS can see it.
 *
 * Every size in the interface is derived from tokens that this attribute
 * switches, so one line here re-scales the whole product and no component has
 * to know which scale is running.
 */
export function applyScale(scale: UiScale): void {
  document.documentElement.dataset.scale = scale
  try {
    window.localStorage.setItem(STORAGE_KEY, scale)
  } catch { /* the interface still works unsaved */ }
}
