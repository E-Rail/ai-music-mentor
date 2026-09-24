import { lazy, useState, type ReactNode } from 'react'
import type {
  DiagnosisReport, ErrorEvent, MentorChatResponse, MentorPlanItem, MentorResponse,
  MentorMemoryStatus,
} from '../../types'
import {
  ERROR_TYPE_LABEL, METRIC_LABEL, SEVERITY_LABEL, labelled, percent, t, tf,
} from '../../i18n/messages'
import {
  ProArticulation, ProDynamics, ProEvidence, ProHands, ProInputQuality, ProMethod, ProTempo,
} from './ProDetail'
import { errorColor, errorDetailForDisplay, evidenceNotes } from './errorPresentation'
import { MentorSummary } from '../mentor/MentorSummary'
import { MentorChat, type MentorChatMessage } from '../mentor/MentorChat'
import { measureLabel } from '../score/measureLabels'
import { Stage } from '../practice/Stage'
import { read, write, type Depth, type Preference } from '../shell/preferences'

const ScoreViewer = lazy(() => import('../score/ScoreViewer').then((module) => ({
  default: module.ScoreViewer,
})))

type CoachReportProps = {
  /** Pro adds rows to this page; it never changes how the page looks. */
  depth: Depth
  report: DiagnosisReport
  baseline: DiagnosisReport | null
  beatsPerMeasure?: number
  scoreXmlUrl?: string
  scoreTitle?: string
  headExtra?: ReactNode
  selectedError: ErrorEvent | null
  mentor: MentorResponse | null
  mentorLoading: boolean
  mentorInOtherLanguage?: boolean
  onRewriteMentor?: () => void
  chatMessages: MentorChatMessage[]
  chatLoading: boolean
  question: string
  mentorMemory: MentorMemoryStatus | null
  onChooseError: (error: ErrorEvent) => void
  onPlayEvidence: (pitches: number[]) => void
  onApplyPlan: (plan: MentorPlanItem) => void
  onApplyChatAction: (response: MentorChatResponse, actionIndex: number) => void
  onAskMentor: (prompt?: string, retryMessageId?: string) => void | Promise<void>
  onQuestionChange: (value: string) => void
  onCancelChat: () => void
  onForgetMemory: () => void | Promise<void>
  onRerecord: () => void
  onGenerateExercise: () => void
}

/**
 * Whether "A closer look" is open — Standard starts it closed, Pro open, and
 * after that it stays the way the player last left it, per mode.
 */
const CLOSER_LOOK: Record<Depth, Preference<'open' | 'closed'>> = {
  standard: { key: 'closerLook.standard', fallback: 'closed', values: ['open', 'closed'] },
  pro: { key: 'closerLook.pro', fallback: 'open', values: ['open', 'closed'] },
}

/**
 * The reading of one take, beside the mentor.
 *
 * Left, in the order a player asks: how did it go, where on the page, what
 * exactly, and — folded — why. Right, the mentor. Both scroll on their own, and
 * the two ways forward stay pinned underneath, so nothing the player came here
 * to do is ever below the fold.
 */
export function CoachReport({
  depth, report, baseline, beatsPerMeasure, scoreXmlUrl, scoreTitle, headExtra, selectedError,
  mentor, mentorLoading, mentorInOtherLanguage, onRewriteMentor,
  chatMessages, chatLoading, question,
  mentorMemory,
  onChooseError, onPlayEvidence, onApplyPlan, onApplyChatAction, onAskMentor,
  onQuestionChange, onCancelChat, onForgetMemory, onRerecord, onGenerateExercise,
}: CoachReportProps) {
  const [closerOpen, setCloserOpen] = useState(() => read(CLOSER_LOOK[depth]) === 'open')
  const [seenDepth, setSeenDepth] = useState(depth)
  if (seenDepth !== depth) {
    setSeenDepth(depth)
    setCloserOpen(read(CLOSER_LOOK[depth]) === 'open')
  }
  const pro = depth === 'pro'
  const warnings = report.warnings ?? []
  return (
    <Stage id="review" layout="review" headExtra={headExtra}
      main={<div className="review-main">
        <Scoreline report={report} baseline={baseline} />
        {warnings.length > 0 && (
          <ul className="report-warnings" role="note">
            {warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        )}
        {baseline && baseline.scoreId !== report.scoreId && (
          <div className="dim lineage-metric-note">{t('lineageMetricNotice')}</div>
        )}
        {scoreXmlUrl && beatsPerMeasure && (
          <div className="score-stage">
            <ScoreViewer
              xmlUrl={scoreXmlUrl} beatsPerMeasure={beatsPerMeasure} title={scoreTitle}
              errors={report.errors} selectedErrorId={selectedError?.id}
              onErrorClick={onChooseError}
            />
          </div>
        )}
        <section className="report-section">
          <h3>{tf('errorList', { count: report.errors.length })}</h3>
          <div className="error-list">
            {report.errors.map((error) => {
              const displayDetail = errorDetailForDisplay(error, report.evidences)
              const chosen = selectedError?.id === error.id
              return (
                <div key={error.id} className={`error-entry ${chosen ? 'open' : ''}`}>
                  <button type="button"
                          className={`error-item ${chosen ? 'selected' : ''}`}
                          aria-expanded={chosen}
                          onClick={() => onChooseError(error)}>
                    <span className="badge" style={{ background: errorColor(error.type) }}>
                      {ERROR_TYPE_LABEL[error.type] ?? error.type}
                    </span>
                    <span className="desc">
                      {tf('errorPosition', {
                        measure: measureLabel(error.location.measure),
                        beat: error.location.beat + 1,
                        severity: SEVERITY_LABEL[error.severity],
                      })}
                      {displayDetail && ` · ${displayDetail}`}
                    </span>
                    {pro && <span className="conf">{tf('confidence', { value: percent(error.confidence) })}</span>}
                  </button>
                  {/* The evidence opens under the mistake it belongs to, not
                      after a list that can run to fifty rows. */}
                  {chosen && (
                    <EvidenceDrawer report={report} error={error} onPlayCompare={onPlayEvidence} />
                  )}
                </div>
              )
            })}
            {report.errors.length === 0 && <div className="dim">{t('noErrors')}</div>}
          </div>
        </section>
        <details className="technical-details" open={closerOpen}
                 onToggle={(event) => {
                   const open = event.currentTarget.open
                   setCloserOpen(open)
                   write(CLOSER_LOOK[depth], open ? 'open' : 'closed')
                 }}>
          <summary>{t('musicalDetails')}</summary>
          <div className="closer-look">
            <section className="report-section">
              <h3>{t('repeatedPatterns')}</h3>
              {report.patterns.length ? (
                <ul className="fact-list plain">
                  {report.patterns.map((pattern) => (
                    <li key={pattern.id}><span className="fact-text">{pattern.description}</span></li>
                  ))}
                </ul>
              ) : <p className="dim">{t('noRepeatedPattern')}</p>}
            </section>
            {pro ? (
              <>
                <ProTempo report={report} />
                <ProHands report={report} />
                <ProDynamics report={report} />
                <ProArticulation report={report} />
                <ProEvidence report={report} measureLabel={measureLabel} />
                <ProInputQuality report={report} />
                <ProMethod report={report} />
              </>
            ) : (
              <p className="dim closer-look-more">{tf('evidenceCount', { count: report.evidences.length })}</p>
            )}
          </div>
        </details>
      </div>}
      aside={<div className="coach-mentor-column">
        <MentorSummary response={mentor} loading={mentorLoading} onApplyPlan={onApplyPlan}
                       otherLanguage={mentorInOtherLanguage} onRewrite={onRewriteMentor} />
        <MentorChat
          messages={chatMessages} loading={chatLoading} question={question}
          onQuestionChange={onQuestionChange} onAsk={onAskMentor}
          onCancel={onCancelChat} onApplyAction={onApplyChatAction}
          memory={mentorMemory} onForgetMemory={onForgetMemory}
        />
      </div>}
      actions={{
        back: <button className="btn" onClick={onRerecord}>{t('rerecord')}</button>,
        primary: (
          <button className="btn btn-primary" onClick={onGenerateExercise}>
            {t('generateExerciseNext')}
          </button>
        ),
      }}
    />
  )
}

const SCORELINE_METRICS = [
  'pitchScore', 'rhythmScore', 'fluencyScore', 'dynamicsScore', 'timingMaeMs', 'avgBpm',
] as const

/**
 * How the take went, on one line: the overall number, the six that make it
 * up, and where to start. It replaces a banner, a row of seven tiles and a
 * card that between them took a third of the screen before the score began.
 */
function Scoreline({ report, baseline }: {
  report: DiagnosisReport
  baseline: DiagnosisReport | null
}) {
  const quality = report.inputQuality
  const qualityChip = quality && (
    <span className={`quality-chip ${quality.status}`}>
      {labelled(t('inputQualityTitle'), {
        high: t('inputQualityHigh'), medium: t('inputQualityMedium'),
        low: t('inputQualityLow'), insufficient: t('inputQualityInsufficient'),
      }[quality.status])}
    </span>
  )
  if (quality?.status === 'insufficient') {
    return (
      <div className="scoreline limited">
        <div className="scoreline-focus">
          <strong>{t('limitedMetricsTitle')}</strong>
          <span>{t('limitedMetricsBody')}</span>
          <span className="dim">{tf('inputQualityNotes', { count: quality.acceptedNoteCount })}</span>
        </div>
        {qualityChip}
      </div>
    )
  }
  const metrics = report.metrics
  const comparable = Boolean(baseline && baseline.scoreId === report.scoreId)
  const delta = (key: keyof typeof metrics) => {
    if (!baseline || !comparable || baseline.metrics[key] === metrics[key]) return null
    const change = metrics[key] - baseline.metrics[key]
    const better = key === 'timingMaeMs' ? change < 0 : change > 0
    return (
      <span className={`delta ${better ? 'pos' : 'neg'}`}>
        {change > 0 ? '+' : ''}{change.toFixed(1)}
      </span>
    )
  }
  const primary = report.errors[0]
  return (
    <div className="scoreline">
      <div className="scoreline-overall">
        <span className="label">{METRIC_LABEL.overallScore}</span>
        <span className="value">{metrics.overallScore}</span>
        {delta('overallScore')}
      </div>
      <dl className="scoreline-metrics">
        {SCORELINE_METRICS.map((key) => (
          <div key={key}>
            <dt>{METRIC_LABEL[key]}</dt>
            <dd>{metrics[key]}{delta(key)}</dd>
          </div>
        ))}
      </dl>
      <div className="scoreline-focus">
        <span className="eyebrow">{t('startHere')}</span>
        <strong>{primary
          ? `${ERROR_TYPE_LABEL[primary.type] ?? primary.type} · ${tf('errorPosition', {
              measure: measureLabel(primary.location.measure),
              beat: primary.location.beat + 1,
              severity: SEVERITY_LABEL[primary.severity],
            })}`
          : t('noErrors')}</strong>
        {qualityChip}
      </div>
    </div>
  )
}

function EvidenceDrawer({ report, error, onPlayCompare }: {
  report: DiagnosisReport
  error: ErrorEvent
  onPlayCompare: (pitches: number[]) => void
}) {
  const evidences = report.evidences.filter((evidence) => error.evidenceIds.includes(evidence.id))
  return (
    <section className="evidence-box" aria-label={t('evidenceDetails')}>
      {evidences.length === 0 ? <p className="dim">{t('noDetailedEvidence')}</p> : (
        <ul className="fact-list">
          {evidences.map((evidence) => {
            const expected = evidenceNotes(evidence, 'expected')
            const actual = evidenceNotes(evidence, 'actual')
            return (
              <li key={evidence.id}>
                <span className="fact-text">{evidence.fact}</span>
                {(expected.length > 0 || actual.length > 0) && (
                  <span className="fact-actions">
                    {expected.length > 0 && (
                      <button className="btn btn-sm" onClick={() => onPlayCompare(expected)}>
                        {t('hearExpected')}
                      </button>
                    )}
                    {actual.length > 0 && (
                      <button className="btn btn-sm" onClick={() => onPlayCompare(actual)}>
                        {t('hearActual')}
                      </button>
                    )}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
