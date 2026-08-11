import type { MentorPlanItem, MentorResponse } from '../../types'
import { t, tf } from '../../i18n/messages'

type MentorSummaryProps = {
  response: MentorResponse | null
  loading: boolean
  onApplyPlan: (plan: MentorPlanItem) => void
}

export function MentorSummary({ response, loading, onApplyPlan }: MentorSummaryProps) {
  if (loading) {
    return (
      <div className="mentor-box mentor-loading" role="status">
        <span className="mentor-loading-dot" />
        {t('mentorThinking')}
      </div>
    )
  }

  if (!response) return null

  return (
    <div className="mentor-box">
      <div className="mentor-header">
        <div className="mentor-label">{t('mentorLayer')}</div>
        <div className={`mentor-meta ${response.provider.startsWith('rules') ? 'fallback' : ''}`}>
          {response.provider.startsWith('rules')
            ? (response.provider === 'rules' ? t('mentorLocalRules') : t('mentorLocalFallback'))
            : tf('mentorProviderMeta', {
                provider: response.provider,
                model: response.model || 'OpenAI-compatible',
                latency: response.latencyMs ?? 0,
              })}
        </div>
      </div>
      <div className="summary">{response.summary}</div>
      {response.evidence.length > 0 && (
        <section className="mentor-section">
          <h4>{t('mentorEvidenceTitle')}</h4>
          <div className="mentor-evidence-list">
            {response.evidence.map((evidence, index) => (
              <div className="mentor-evidence" key={`${evidence.measure}:${evidence.beat}:${index}`}>
                <span>{tf('mentorEvidencePosition', {
                  measure: evidence.measure, beat: evidence.beat + 1,
                })}</span>
                {evidence.fact}
              </div>
            ))}
          </div>
        </section>
      )}
      {response.hypotheses.length > 0 && (
        <section className="mentor-section">
          <h4>{t('mentorHypothesesTitle')}</h4>
          {response.hypotheses.map((hypothesis, index) => (
            <div key={`${hypothesis.cause}:${index}`} className="hyp">
              • {tf('hypothesisConfidence', {
                cause: hypothesis.cause, confidence: hypothesis.confidence,
              })}<br />{t('limitation')}{hypothesis.limitation}
            </div>
          ))}
        </section>
      )}
      {response.plan.length > 0 && (
        <section className="mentor-section">
          <h4>{t('mentorPlanTitle')}</h4>
          <div className="mentor-plan-grid">
            {response.plan.map((plan, index) => (
              <article className="mentor-plan" key={`${plan.exerciseType}:${index}`}>
                <strong>{plan.label || plan.exerciseType}</strong>
                <span>{tf('mentorPlanMeasures', { measures: plan.measures.join('、') })}</span>
                {plan.tempo && <span>{tf('mentorPlanTempo', { tempo: plan.tempo })}</span>}
                <span>{tf('mentorPlanRepetitions', { count: plan.repetitions })}</span>
                <span>{tf('mentorSuccessCriterion', { criterion: plan.successCriterion })}</span>
                <button className="btn btn-sm" onClick={() => onApplyPlan(plan)}>
                  {t('mentorApplyPlan')}
                </button>
              </article>
            ))}
          </div>
        </section>
      )}
      {response.encouragement && <div className="encourage">{response.encouragement}</div>}
    </div>
  )
}
