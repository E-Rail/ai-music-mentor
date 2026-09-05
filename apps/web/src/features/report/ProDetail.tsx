import { t, tf } from '../../i18n/messages'
import { handOfEventIds } from '../score/hands'
import type { DiagnosisReport } from '../../types'

/**
 * What Pro adds to a report.
 *
 * Every number here was already measured and already sent — the evidence list,
 * the per-note confidence, the engine that did the reading, the room it was
 * read in. Standard leaves it folded away because a player wanting to know what
 * to practise does not need it; Pro is for the take after that, when the
 * question has become "how do you know?".
 *
 * Nothing here grades a dynamic. Velocity and amplitude are evidence about a
 * played note, and only notation may be read as a written marking.
 */
export function ProEvidence({ report, measureLabel }: {
  report: DiagnosisReport
  measureLabel: (measure: number) => string | number
}) {
  if (!report.evidences.length) {
    return (
      <section className="pro-block">
        <h3>{t('proEvidenceTitle')}</h3>
        <p className="pro-empty">{t('proEvidenceEmpty')}</p>
      </section>
    )
  }
  return (
    <section className="pro-block">
      <h3>{t('proEvidenceTitle')}</h3>
      <ul className="pro-evidence">
        {report.evidences.map((evidence) => (
          <li key={evidence.id}>
            <span className="pro-where">{tf('proEvidencePosition', {
              measure: measureLabel(evidence.measureNo),
              beat: evidence.beat + 1,
            })}</span>
            <span className="pro-fact">{evidence.fact}</span>
            {(evidence.expected || evidence.actual) && (
              <span className="pro-compare">
                {evidence.expected && (
                  <span><em>{t('proEvidenceExpected')}</em> {evidence.expected}</span>
                )}
                {evidence.actual && (
                  <span><em>{t('proEvidenceActual')}</em> {evidence.actual}</span>
                )}
              </span>
            )}
            {typeof evidence.deltaMs === 'number' && (
              <span className="pro-delta">{tf('proEvidenceDelta', {
                ms: evidence.deltaMs > 0
                  ? `+${Math.round(evidence.deltaMs)}`
                  : Math.round(evidence.deltaMs),
              })}</span>
            )}
          </li>
        ))}
      </ul>
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
    <section className="pro-block">
      <h3>{t('proHandsTitle')}</h3>
      {total === 0 ? (
        <p className="pro-empty">{t('proHandsClean')}</p>
      ) : (
        <ul className="pro-hands">
          <li>{tf('proHandsLeft', { count: counts.left })}</li>
          <li>{tf('proHandsRight', { count: counts.right })}</li>
          {counts.unknown > 0 && (
            <li>{tf('proHandsUnknown', { count: counts.unknown })}</li>
          )}
        </ul>
      )}
    </section>
  )
}

/**
 * How good the reading itself was.
 *
 * A player whose room was too loud deserves to know that before they believe a
 * score. All of this has been on the wire since the first release without ever
 * reaching the screen.
 */
export function ProInputQuality({ report }: { report: DiagnosisReport }) {
  const quality = report.inputQuality
  if (!quality) return null
  return (
    <section className="pro-block">
      <h3>{t('proInputTitle')}</h3>
      <ul className="pro-input">
        {quality.transcriptionEngine && (
          <li>{tf('proInputEngine', {
            engine: quality.transcriptionEngine,
            version: quality.transcriptionVersion,
          })}</li>
        )}
        <li>{tf('proInputAccepted', {
          accepted: quality.acceptedNoteCount,
          rejected: quality.rejectedNoteCount,
        })}</li>
        {typeof quality.noiseFloorDb === 'number' && (
          <li>{tf('proInputNoise', { db: Math.round(quality.noiseFloorDb) })}</li>
        )}
        <li>{tf('proInputConfidence', {
          value: Math.round(quality.confidence * 100),
        })}</li>
        <li className="pro-provenance">{tf('proProvenance', {
          algorithm: report.algorithmVersion,
          profile: report.thresholdProfile,
        })}</li>
      </ul>
    </section>
  )
}
