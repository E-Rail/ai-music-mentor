import { lazy } from 'react'
import type {
  DiagnosisReport, ErrorEvent, MentorChatResponse, MentorPlanItem, MentorResponse,
  MentorMemoryStatus,
} from '../../types'
import { ERROR_TYPE_LABEL, METRIC_LABEL, SEVERITY_LABEL, t, tf } from '../../i18n/messages'
import { errorColor, errorDetailForDisplay } from './errorPresentation'
import { MentorSummary } from '../mentor/MentorSummary'
import { MentorChat, type MentorChatMessage } from '../mentor/MentorChat'

const ScoreViewer = lazy(() => import('../score/ScoreViewer').then((module) => ({
  default: module.ScoreViewer,
})))

type CoachReportProps = {
  report: DiagnosisReport
  baseline: DiagnosisReport | null
  beatsPerMeasure?: number
  scoreXmlUrl?: string
  selectedError: ErrorEvent | null
  mentor: MentorResponse | null
  mentorLoading: boolean
  chatMessages: MentorChatMessage[]
  chatLoading: boolean
  question: string
  mentorMemory: MentorMemoryStatus | null
  onChooseError: (error: ErrorEvent) => void
  onPlayEvidence: (text: string) => void
  onApplyPlan: (plan: MentorPlanItem) => void
  onApplyChatAction: (response: MentorChatResponse, actionIndex: number) => void
  onAskMentor: (prompt?: string, retryMessageId?: string) => void | Promise<void>
  onQuestionChange: (value: string) => void
  onCancelChat: () => void
  onForgetMemory: () => void | Promise<void>
  onRerecord: () => void
  onGenerateExercise: () => void
}

export function CoachReport({
  report, baseline, beatsPerMeasure, scoreXmlUrl, selectedError,
  mentor, mentorLoading, chatMessages, chatLoading, question,
  mentorMemory,
  onChooseError, onPlayEvidence, onApplyPlan, onApplyChatAction, onAskMentor,
  onQuestionChange, onCancelChat, onForgetMemory, onRerecord, onGenerateExercise,
}: CoachReportProps) {
  const primary = report.errors[0]
  const limitedEvidence = report.inputQuality?.status === 'insufficient'
  return (
    <div className="panel coach-panel">
      <h2>{t('reportTitle')}</h2>
      <div className={`final-report-banner ${limitedEvidence ? 'limited' : 'ready'}`}>
        <strong>{limitedEvidence ? t('finalReportLimited') : t('finalReportReady')}</strong>
      </div>
      <MetricsView report={report} baseline={baseline} />
      <div className="primary-issue-card">
        <span className="training-kicker">{t('currentRoundAiKicker')}</span>
        <h3>{limitedEvidence
          ? t('limitedMetricsTitle')
          : primary
          ? `${ERROR_TYPE_LABEL[primary.type] ?? primary.type} · ${tf('errorPosition', {
              measure: primary.location.measure,
              beat: primary.location.beat + 1,
              severity: SEVERITY_LABEL[primary.severity],
            })}`
          : t('noErrors')}</h3>
        {report.inputQuality && (
          <div className={`input-quality ${report.inputQuality.status}`}>
            <strong>{t('inputQualityTitle')}：{{
              high: t('inputQualityHigh'), medium: t('inputQualityMedium'),
              low: t('inputQualityLow'), insufficient: t('inputQualityInsufficient'),
            }[report.inputQuality.status]}</strong>
            <span>{Math.round(report.inputQuality.confidence * 100)}% · {report.thresholdProfile}</span>
          </div>
        )}
      </div>
      {!!report.warnings?.length && (
        <div className="report-warnings">
          {report.warnings.map((warning) => (
            <div className="alert alert-warn" key={warning}>{warning}</div>
          ))}
        </div>
      )}
      {baseline && baseline.scoreId !== report.scoreId && (
        <div className="dim lineage-metric-note">{t('lineageMetricNotice')}</div>
      )}

      <div className="coach-workspace">
        <div className="coach-evidence-column">
          {scoreXmlUrl && beatsPerMeasure && (
            <ScoreViewer
              xmlUrl={scoreXmlUrl} beatsPerMeasure={beatsPerMeasure}
              errors={report.errors} selectedErrorId={selectedError?.id}
              onErrorClick={onChooseError}
            />
          )}
          <h3>{tf('errorList', { count: report.errors.length })}</h3>
          <div className="error-list">
            {report.errors.map((error) => {
              const displayDetail = errorDetailForDisplay(error, report.evidences)
              return (
                <button type="button" key={error.id}
                        className={`error-item ${selectedError?.id === error.id ? 'selected' : ''}`}
                        onClick={() => onChooseError(error)}>
                  <span className="badge" style={{ background: errorColor(error.type) }}>
                    {ERROR_TYPE_LABEL[error.type] ?? error.type}
                  </span>
                  <span className="desc">
                    {tf('errorPosition', {
                      measure: error.location.measure,
                      beat: error.location.beat + 1,
                      severity: SEVERITY_LABEL[error.severity],
                    })}
                    {displayDetail && ` · ${displayDetail}`}
                  </span>
                  <span className="conf">{tf('confidence', { value: error.confidence })}</span>
                </button>
              )
            })}
            {report.errors.length === 0 && <div className="dim">{t('noErrors')}</div>}
          </div>
          {selectedError && (
            <EvidenceDrawer report={report} error={selectedError} onPlayCompare={onPlayEvidence} />
          )}
          <details className="technical-details">
            <summary>{t('technicalDetails')}</summary>
            <div className="evidence-layers">
              <section>
                <h3>{t('verifiableFacts')}</h3>
                <p>{tf('evidenceCount', { count: report.evidences.length })}</p>
              </section>
              <section>
                <h3>{t('repeatedPatterns')}</h3>
                <p>{report.patterns.length
                  ? report.patterns.map((pattern) => tf('repeatedPattern', {
                      description: pattern.description, count: pattern.sampleCount,
                    })).join('；')
                  : t('noRepeatedPattern')}</p>
              </section>
              <section>
                <h3>{t('possibleCauses')}</h3>
                <p>{report.hypotheses.length
                  ? report.hypotheses.map((hypothesis) => tf('hypothesisConfidence', {
                      cause: hypothesis.cause, confidence: hypothesis.confidence,
                    })).join('；')
                  : t('insufficientEvidence')}</p>
              </section>
            </div>
          </details>
        </div>
        <aside className="coach-mentor-column">
          <MentorSummary response={mentor} loading={mentorLoading} onApplyPlan={onApplyPlan} />
          <MentorChat
            messages={chatMessages} loading={chatLoading} question={question}
            onQuestionChange={onQuestionChange} onAsk={onAskMentor}
            onCancel={onCancelChat} onApplyAction={onApplyChatAction}
            memory={mentorMemory} onForgetMemory={onForgetMemory}
          />
        </aside>
      </div>

      <div className="flex mt-20 between">
        <button className="btn" onClick={onRerecord}>{t('rerecord')}</button>
        <button className="btn btn-primary" onClick={onGenerateExercise}>
          {t('generateExerciseNext')}
        </button>
      </div>
    </div>
  )
}

function MetricsView({ report, baseline }: {
  report: DiagnosisReport
  baseline: DiagnosisReport | null
}) {
  if (report.inputQuality?.status === 'insufficient') {
    return (
      <div className="limited-metrics-card">
        <strong>{t('limitedMetricsTitle')}</strong>
        <p>{t('limitedMetricsBody')}</p>
        <span>{report.inputQuality.acceptedNoteCount} accepted · {report.inputQuality.rejectedNoteCount} filtered</span>
      </div>
    )
  }
  const metrics = report.metrics
  const hasComparableBaseline = Boolean(baseline && baseline.scoreId === report.scoreId)
  return (
    <div className="metrics-grid">
      {([
        'overallScore', 'pitchScore', 'rhythmScore', 'fluencyScore', 'dynamicsScore',
        'timingMaeMs', 'avgBpm',
      ] as const).map((key) => (
        <div key={key} className="metric">
          <div className="label">{METRIC_LABEL[key]}</div>
          <div className="value">{metrics[key]}</div>
          {baseline && hasComparableBaseline && baseline.metrics[key] !== metrics[key] && (
            <div className="delta" style={{ color:
              (key === 'timingMaeMs'
                ? metrics[key] < baseline.metrics[key]
                : metrics[key] > baseline.metrics[key]) ? 'var(--green)' : 'var(--red)',
            }}>
              {metrics[key] > baseline.metrics[key] ? '+' : ''}
              {(metrics[key] - baseline.metrics[key]).toFixed(1)}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function EvidenceDrawer({ report, error, onPlayCompare }: {
  report: DiagnosisReport
  error: ErrorEvent
  onPlayCompare: (text: string) => void
}) {
  const evidences = report.evidences.filter((evidence) => error.evidenceIds.includes(evidence.id))
  return (
    <div className="evidence-box">
      <h3 style={{ margin: '0 0 8px' }}>{t('evidenceDetails')}</h3>
      {evidences.map((evidence) => (
        <div key={evidence.id} className="fact">
          • {evidence.fact}
          <div className="compare">
            {evidence.expected && (
              <button className="btn btn-sm" onClick={() => onPlayCompare(evidence.expected)}>
                {t('hearExpected')}
              </button>
            )}
            {evidence.actual && (
              <button className="btn btn-sm" onClick={() => onPlayCompare(evidence.actual)}>
                {t('hearActual')}
              </button>
            )}
          </div>
        </div>
      ))}
      {evidences.length === 0 && <div className="dim">{t('noDetailedEvidence')}</div>}
    </div>
  )
}
