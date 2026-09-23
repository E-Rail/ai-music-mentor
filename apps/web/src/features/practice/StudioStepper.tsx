import { t, type MessageKey } from '../../i18n/messages'

export type StudioStage = 'score' | 'input' | 'perform' | 'coach'

const stages: { id: StudioStage; label: MessageKey; hint: MessageKey }[] = [
  { id: 'score', label: 'stageScore', hint: 'stageScoreHint' },
  { id: 'input', label: 'stageInput', hint: 'stageInputHint' },
  { id: 'perform', label: 'stagePerform', hint: 'stagePerformHint' },
  { id: 'coach', label: 'stageCoach', hint: 'stageCoachHint' },
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
          <span><strong>{t(stage.label)}</strong><small>{t(stage.hint)}</small></span>
        </button>
      ))}
    </nav>
  )
}
