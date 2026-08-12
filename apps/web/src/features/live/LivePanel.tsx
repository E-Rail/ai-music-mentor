import { t, tf } from '../../i18n/messages'
import { LiveTrace } from './LiveTrace'
import type { LivePerformanceState, LiveTraceNote } from './livePerformance'
import { measureLabel } from '../score/measureLabels'
import { noteName } from '../score/pitch'
import type { Hand } from '../score/hands'
import type { ExpectedNote } from './liveTargets'

export { noteName } from '../score/pitch'

const STATUS_TEXT = {
  idle: 'liveStatusIdle',
  waiting: 'liveStatusWaiting',
  match: 'liveStatusMatch',
  partial: 'liveStatusPartial',
  different: 'liveStatusDifferent',
  corrected: 'liveStatusCorrected',
} as const

const HAND_TEXT: Record<Hand, 'liveHandLeft' | 'liveHandRight' | 'liveHandUnknown'> = {
  left: 'liveHandLeft', right: 'liveHandRight', unknown: 'liveHandUnknown',
}

/** "左手 C3 · 右手 E4" — a student needs the hand, not just the pitch. */
export function describeExpected(notes: ExpectedNote[]): string {
  return notes
    .map((note) => `${t(HAND_TEXT[note.hand])}${noteName(note.pitch)}`.trim())
    .join(' · ')
}

/**
 * What you just played, first; what was written, second.
 *
 * The panel leads with the pitch that sounded because that is the thing the
 * student can act on. Timing is stated against their own start, so it stays
 * blank for the note that begins the take.
 */
export function LivePanel(
  { state, trace, onSkip }: {
    state: LivePerformanceState
    trace: LiveTraceNote[]
    onSkip?: () => void
  },
) {
  const timing = state.timing
  const timingLabel = !timing ? null
    : timing.reference === 'anchor' ? t('liveTimingFromYourStart')
    : timing.reference === 'unplaced' ? t('liveTimingUnplaced')
    : timing.label === 'onTime' ? t('liveTimingOnTime')
    : tf(timing.label === 'early' ? 'liveTimingEarly' : 'liveTimingLate',
      { ms: Math.abs(Math.round(timing.deltaMs)) })
  const timingTone = !timing || timing.reference !== 'elapsed' ? 'none' : timing.label

  return (
    <section className={`live-panel ${state.status}`} aria-live="polite">
      <div className="live-panel-heading">
        <span className="eyebrow">{t('livePlayedTitle')}</span>
        <strong className="live-status">{t(STATUS_TEXT[state.status])}</strong>
      </div>

      <div className="live-played" data-status={state.status}>
        {state.played.length ? state.played.map((item) => (
          <span key={item.pitch} className={`played-chip ${item.role}`}>
            {noteName(item.pitch)}
          </span>
        )) : <span className="played-chip empty">{t('liveAwaitingFirstNote')}</span>}
      </div>

      <dl className="live-facts">
        <div>
          <dt>{t('liveWrittenHere')}</dt>
          <dd className="numeric">{state.target?.pitches.length
            ? state.target.pitches.map(noteName).join(' · ')
            : '—'}</dd>
        </div>
        <div>
          <dt>{t('livePosition')}</dt>
          <dd className="numeric">{state.target
            ? tf('liveMeasureBeat', {
              measure: measureLabel(state.target.measureNo),
              beat: state.target.onsetBeat + 1,
            })
            : '—'}</dd>
        </div>
        <div>
          <dt>{t('liveTiming')}</dt>
          <dd className={`numeric timing-${timingTone}`}>
            {timingLabel ?? '—'}
          </dd>
        </div>
      </dl>

      {/* What this position still owes, named by hand. The passage holds here
          until it is paid or the player decides to skip it — it never looks
          elsewhere in the score for something a wrong note might have been. */}
      {!!state.outstanding.length && state.status !== 'waiting' && (
        <div className="live-owed">
          <p className={state.blocked ? 'live-missing blocked' : 'live-missing'}>
            {tf(state.blocked ? 'liveBlockedHere' : 'liveStillOwed', {
              notes: describeExpected(state.outstanding),
            })}
          </p>
          {state.outstanding.length > 1 && !state.blocked && (
            <p className="live-hint">{t('liveWaitingBothHands')}</p>
          )}
          {onSkip && (
            <button type="button" className="btn live-skip" onClick={onSkip}>
              {t('liveSkipHere')}
            </button>
          )}
          {onSkip && <p className="live-hint">{t('liveSkipHint')}</p>}
        </div>
      )}

      <LiveTrace notes={trace} />

      <p className="live-disclaimer">{state.source === 'microphone'
        ? t('liveDisclaimerMic') : t('liveDisclaimerMidi')}</p>
    </section>
  )
}
