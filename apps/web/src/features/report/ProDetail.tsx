import { t, tf } from '../../i18n/messages'
import { handOfEventIds } from '../score/hands'
import type { DiagnosisReport } from '../../types'
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

/**
 * Which hand the problems are in.
 *
 * Derived here rather than asked of the server: an error already names the
 * score events it belongs to, and those already carry the hand.
 */
export function ProHands({ report }: { report: DiagnosisReport }) {
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
  return (
    <section className="report-section">
      <h3>{t('tempoCurveTitle')}</h3>
      {report.targetBpm ? (
        <p className="dim">{tf('tempoCurveHint', { bpm: Math.round(report.targetBpm) })}</p>
      ) : null}
      <TempoCurve points={report.tempoCurve} targetBpm={report.targetBpm} />
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
