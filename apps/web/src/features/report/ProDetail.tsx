import { t, tf, type MessageKey } from '../../i18n/messages'
import { handOfEventIds } from '../score/hands'
import type { DiagnosisReport, HandProfile, PerformanceProfile } from '../../types'
import { TempoCurve } from './TempoCurve'

/**
 * What Pro adds to a report.
 *
 * Every number here was already measured and already sent — the evidence list,
 * the per-hand split, the engine that did the reading, the room it was read in,
 * the tempo that was kept. Standard leaves them out because a player wanting to
 * know what to practise does not need them; Pro is for the take after that,
 * when the question has become "how do you know?".
 *
 * They are drawn with the same pieces as everything else in the report — the
 * same section heading, fact row and metric tile — because Pro is more of the
 * same studio, not a different one.
 *
 * Nothing here grades a dynamic. Velocity and amplitude are evidence about a
 * played note, and only notation may be read as a written marking.
 */
export function ProEvidence({ report, measureLabel }: {
  report: DiagnosisReport
  measureLabel: (measure: number) => string | number
}) {
  return (
    <section className="report-section">
      <h3>{t('proEvidenceTitle')}</h3>
      {report.evidences.length === 0 ? (
        <p className="dim">{t('proEvidenceEmpty')}</p>
      ) : (
        <ul className="fact-list">
          {report.evidences.map((evidence) => (
            <li key={evidence.id}>
              <span className="fact-where">{tf('proEvidencePosition', {
                measure: measureLabel(evidence.measureNo),
                beat: evidence.beat + 1,
              })}</span>
              <span className="fact-text">{evidence.fact}</span>
              {(evidence.expected || evidence.actual) && (
                <span className="fact-compare">
                  {evidence.expected && (
                    <span><em>{t('proEvidenceExpected')}</em> {evidence.expected}</span>
                  )}
                  {evidence.actual && (
                    <span><em>{t('proEvidenceActual')}</em> {evidence.actual}</span>
                  )}
                  {typeof evidence.deltaMs === 'number' && !evidence.actual && (
                    <span className="numeric">{tf('proEvidenceDelta', {
                      ms: evidence.deltaMs > 0
                        ? `+${Math.round(evidence.deltaMs)}`
                        : Math.round(evidence.deltaMs),
                    })}</span>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** The marking a MIDI velocity sits nearest to, as a musician would say it. */
export function dynamicName(velocity: number): string {
  if (velocity < 41) return 'pp'
  if (velocity < 52) return 'p'
  if (velocity < 65) return 'mp'
  if (velocity < 79) return 'mf'
  if (velocity < 93) return 'f'
  return 'ff'
}

/** Within this, two onsets or two hands are "together" to the ear. */
const TOGETHER_MS = 20
/** Two hands closer than this in velocity sound level. */
const EVEN_VELOCITY = 5

const HAND_LABEL: Record<HandProfile['hand'], MessageKey> = { RH: 'rightHand', LH: 'leftHand' }

function handSummary(hand: HandProfile): string {
  const parts = [tf('proHandNotes', { correct: hand.correct, expected: hand.expected })]
  if (typeof hand.timingMaeMs === 'number') {
    parts.push(tf('proHandTiming', { ms: Math.round(hand.timingMaeMs) }))
  }
  if (typeof hand.timingBiasMs === 'number') {
    const bias = Math.round(hand.timingBiasMs)
    parts.push(Math.abs(bias) < TOGETHER_MS ? t('proHandOnPulse')
      : tf(bias > 0 ? 'proHandBehind' : 'proHandAhead', { ms: Math.abs(bias) }))
  }
  if (typeof hand.medianVelocity === 'number') {
    const velocity = Math.round(hand.medianVelocity)
    parts.push(tf('proHandLoudness', { velocity, dynamic: dynamicName(velocity) }))
  }
  return parts.join(t('phraseSeparator'))
}

function handLag(performance: PerformanceProfile): string | null {
  if (typeof performance.handLagMs !== 'number') return null
  const ms = Math.round(performance.handLagMs)
  const count = performance.handLagSamples
  if (Math.abs(ms) < TOGETHER_MS) return tf('proHandLagTogether', { ms: TOGETHER_MS, count })
  return tf(ms > 0 ? 'proHandLagLate' : 'proHandLagEarly', { ms: Math.abs(ms), count })
}

/**
 * Each hand on its own: what it got right, how close to the pulse, how loud,
 * and whether the two land together.
 *
 * The numbers come from the server's performance profile, measured on the
 * same alignment the mistakes came from. A report written before there was a
 * profile falls back to counting its mistakes by hand.
 */
export function ProHands({ report }: { report: DiagnosisReport }) {
  const performance = report.performance
  if (performance?.hands.length) {
    const lag = handLag(performance)
    return (
      <section className="report-section">
        <h3>{t('proHandsTitle')}</h3>
        <dl className="fact-table">
          {performance.hands.map((hand) => (
            <div key={hand.hand}><dt>{t(HAND_LABEL[hand.hand])}</dt><dd>{handSummary(hand)}</dd></div>
          ))}
        </dl>
        {lag && <p className="report-line">{lag}</p>}
      </section>
    )
  }
  const counts = { left: 0, right: 0, unknown: 0 }
  for (const error of report.errors) {
    // An error names its score events under location; a single-event error
    // still has location.eventId, so fall back to that rather than dropping
    // it into "unattributed".
    const ids = error.location.eventIds ?? (
      error.location.eventId ? [error.location.eventId] : [])
    counts[handOfEventIds(ids)] += 1
  }
  const total = counts.left + counts.right + counts.unknown
  return (
    <section className="report-section">
      <h3>{t('proHandsTitle')}</h3>
      {total === 0 ? (
        <p className="dim">{t('proHandsClean')}</p>
      ) : (
        <div className="metric-row">
          <div className="metric"><div className="label">{t('leftHand')}</div>
            <div className="value">{counts.left}</div></div>
          <div className="metric"><div className="label">{t('rightHand')}</div>
            <div className="value">{counts.right}</div></div>
          {counts.unknown > 0 && (
            <div className="metric"><div className="label">{t('proHandsBoth')}</div>
              <div className="value">{counts.unknown}</div></div>
          )}
        </div>
      )}
    </section>
  )
}

const fromMicrophone = (report: DiagnosisReport) => report.inputQuality?.source === 'microphone'

/**
 * How loud, how wide, and whether the marks that shape loudness were met.
 *
 * Only a keyboard reports how hard a key was struck. A microphone's loudness
 * is the room and the distance as much as the hand, so for a microphone take
 * this says so and judges nothing.
 */
export function ProDynamics({ report }: { report: DiagnosisReport }) {
  const performance = report.performance
  if (!performance) return null
  if (fromMicrophone(report)) {
    return (
      <section className="report-section">
        <h3>{t('proDynamicsTitle')}</h3>
        <p className="dim">{t('proDynamicsMicrophone')}</p>
      </section>
    )
  }
  const range = performance.velocityRange
  const balance = performance.handBalance
  const rows: [string, string][] = []
  if (range && range.length === 3) {
    const [low, median, high] = range.map(Math.round)
    rows.push([t('proDynamicsRange'), tf('proDynamicsRangeValue', {
      low, high, median, lowName: dynamicName(low), highName: dynamicName(high),
    })])
  }
  if (typeof balance === 'number') {
    const amount = Math.round(Math.abs(balance))
    rows.push([t('proBalanceLabel'), amount < EVEN_VELOCITY ? t('proBalanceEven')
      : tf(balance > 0 ? 'proBalanceRight' : 'proBalanceLeft', { amount })])
  }
  if (performance.hairpinsChecked) {
    rows.push([t('proHairpinsLabel'), tf('proMetOf', {
      met: performance.hairpinsMet, checked: performance.hairpinsChecked,
    })])
  }
  if (performance.accentsChecked) {
    rows.push([t('proAccentsLabel'), tf('proAccentsMetOf', {
      met: performance.accentsMet, checked: performance.accentsChecked,
    })])
  }
  if (!rows.length) return null
  const narrow = range && range.length === 3 && range[2] - range[0] < 12
  return (
    <section className="report-section">
      <h3>{t('proDynamicsTitle')}</h3>
      <dl className="fact-table">
        {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      {narrow && <p className="report-line">{t('proDynamicsNarrow')}</p>}
    </section>
  )
}

/** Short, joined: how the written articulation marks were met. */
export function ProArticulation({ report }: { report: DiagnosisReport }) {
  const performance = report.performance
  if (!performance) return null
  const rows: [string, string][] = []
  if (performance.staccatoChecked) {
    rows.push([t('proStaccatoLabel'), tf('proStaccatoMetOf', {
      met: performance.staccatoMet, checked: performance.staccatoChecked,
    })])
  }
  if (performance.legatoChecked) {
    rows.push([t('proLegatoLabel'), tf('proLegatoMetOf', {
      met: performance.legatoMet, checked: performance.legatoChecked,
    })])
  }
  const note = fromMicrophone(report) ? t('proArticulationMicrophone')
    : !rows.length && !performance.pedalledReleases && !performance.accentsChecked
      ? t('proArticulationNone') : null
  return (
    <section className="report-section">
      <h3>{t('proArticulationTitle')}</h3>
      {rows.length > 0 && (
        <dl className="fact-table">
          {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
      )}
      {performance.pedalledReleases > 0 && (
        <p className="report-line">{tf('proPedalled', { count: performance.pedalledReleases })}</p>
      )}
      {note && <p className="dim">{note}</p>}
    </section>
  )
}

/**
 * How good the reading itself was.
 *
 * A player whose room was too loud deserves to know that before they believe a
 * score.
 */
export function ProInputQuality({ report }: { report: DiagnosisReport }) {
  const quality = report.inputQuality
  if (!quality) return null
  return (
    <section className="report-section">
      <h3>{t('proInputTitle')}</h3>
      <dl className="fact-table">
        {quality.transcriptionEngine && (
          <div><dt>{t('proInputEngineLabel')}</dt><dd>{quality.transcriptionEngine}
            {quality.transcriptionVersion ? ` ${quality.transcriptionVersion}` : ''}</dd></div>
        )}
        <div><dt>{t('proInputNotesLabel')}</dt><dd>{tf('proInputAccepted', {
          accepted: quality.acceptedNoteCount, rejected: quality.rejectedNoteCount,
        })}</dd></div>
        {typeof quality.noiseFloorDb === 'number' && (
          <div><dt>{t('proInputNoiseLabel')}</dt><dd className="numeric">
            {Math.round(quality.noiseFloorDb)} dBFS</dd></div>
        )}
        <div><dt>{t('proInputConfidenceLabel')}</dt><dd className="numeric">
          {Math.round(quality.confidence * 100)}%</dd></div>
        <div><dt>{t('proProvenanceLabel')}</dt><dd className="numeric">
          {report.algorithmVersion} · {report.thresholdProfile}</dd></div>
      </dl>
    </section>
  )
}

export function ProTempo({ report }: { report: DiagnosisReport }) {
  if (!report.tempoCurve?.length) return null
  const points = report.tempoCurve
  const stepped = new Set(points.map((point) => point.targetBpm ?? report.targetBpm)).size > 1 ||
    points.some((point) => point.shape && point.shape !== 'steady')
  const performance = report.performance
  return (
    <section className="report-section">
      <h3>{t('tempoCurveTitle')}</h3>
      {stepped ? <p className="dim">{t('tempoCurveHintSteps')}</p>
        : report.targetBpm ? (
          <p className="dim">{tf('tempoCurveHint', { bpm: Math.round(report.targetBpm) })}</p>
        ) : null}
      <TempoCurve points={points} targetBpm={report.targetBpm} />
      {performance && (
        <dl className="fact-table">
          <div><dt>{t('proFlowLabel')}</dt><dd>{
            performance.hesitations || performance.restarts
              ? tf('proFlowCounts', { stops: performance.hesitations, restarts: performance.restarts })
              : t('proFlowClean')}</dd></div>
        </dl>
      )}
    </section>
  )
}

/** How the take was measured — method, kept apart from what went wrong. */
export function ProMethod({ report }: { report: DiagnosisReport }) {
  if (!report.notes?.length) return null
  return (
    <section className="report-section">
      <h3>{t('methodTitle')}</h3>
      <ul className="fact-list plain">
        {report.notes.map((note) => <li key={note}><span className="fact-text">{note}</span></li>)}
      </ul>
    </section>
  )
}
