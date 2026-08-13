import { t } from '../../i18n/messages'

export type StudioStage = 'score' | 'input' | 'perform' | 'coach'

const stages: { id: StudioStage; label: ReturnType<typeof t>; hint: ReturnType<typeof t> }[] = [
  { id: 'score', label: t('stageScore'), hint: t('stageScoreHint') },
  { id: 'input', label: t('stageInput'), hint: t('stageInputHint') },
  { id: 'perform', label: t('stagePerform'), hint: t('stagePerformHint') },
  { id: 'coach', label: t('stageCoach'), hint: t('stageCoachHint') },
]

export function StudioStepper({ active, canOpen, onOpen }: {
  active: StudioStage
  canOpen: (stage: StudioStage) => boolean
  onOpen: (stage: StudioStage) => void
}) {
  const activeIndex = stages.findIndex((stage) => stage.id === active)
  return (
    <nav className="studio-stepper" aria-label={t('workspaceAriaLabel')}>
      {stages.map((stage, index) => (
        <button type="button" key={stage.id}
                className={`${stage.id === active ? 'active' : ''} ${index < activeIndex ? 'done' : ''}`}
                aria-current={stage.id === active ? 'step' : undefined}
                disabled={!canOpen(stage.id)} onClick={() => onOpen(stage.id)}>
          {/* A barline, not a numeral: the stages are a passage you move
              through and can return to, not a ranked list. */}
          <span className="stage-mark" aria-hidden="true">
            {index < activeIndex ? '♩' : '𝄀'}
          </span>
          <span><strong>{stage.label}</strong><small>{stage.hint}</small></span>
        </button>
      ))}
    </nav>
  )
}
