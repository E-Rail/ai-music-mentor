import { t, tf } from '../../i18n/messages'
import { LiveTrace } from './LiveTrace'
import type { LivePerformanceState, LiveTraceNote } from './livePerformance'

const PITCH_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']

export function noteName(pitch: number): string {
  return `${PITCH_NAMES[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`
}

const STATUS_TEXT = {
  idle: 'liveStatusIdle',
  waiting: 'liveStatusWaiting',
  match: 'liveStatusMatch',
  partial: 'liveStatusPartial',
  different: 'liveStatusDifferent',
  corrected: 'liveStatusCorrected',
} as const

/**
 * What you just played, first; what was written, second.
 *
 * The panel leads with the pitch that sounded because that is the thing the
 * student can act on. Timing is stated against their own start, so it stays
 * blank for the note that begins the take.
 */
export function LivePanel(
  { state, trace }: { state: LivePerformanceState; trace: LiveTraceNote[] },
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
              measure: state.target.measureNo,
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

      {!!state.missing.length && state.status !== 'waiting' && (
        <p className="live-missing">{tf('liveMissingPitches', {
          notes: state.missing.map(noteName).join(' · '),
        })}</p>
      )}

      <LiveTrace notes={trace} />

      <p className="live-disclaimer">{state.source === 'microphone'
        ? t('liveDisclaimerMic') : t('liveDisclaimerMidi')}</p>
    </section>
  )
}
