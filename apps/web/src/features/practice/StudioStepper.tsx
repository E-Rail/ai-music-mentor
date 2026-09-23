import { t } from '../../i18n/messages'
import { STAGES, type StageId } from './stages'

/**
 * The five places in the practice loop, in one line of the top bar.
 *
 * A barline, not a numeral: the stages are a passage you move through and can
 * return to, not a ranked list. The hint rides along as a tooltip and, where
 * the bar has room for it, under the name.
 */
export function StudioStepper({ active, canOpen, onOpen }: {
  active: StageId
  canOpen: (stage: StageId) => boolean
  onOpen: (stage: StageId) => void
}) {
  const activeIndex = STAGES.findIndex((stage) => stage.id === active)
  return (
    <nav className="studio-stepper" aria-label={t('workspaceAriaLabel')}>
      {STAGES.map((stage, index) => (
        <button type="button" key={stage.id} title={t(stage.hint)}
                className={`${stage.id === active ? 'active' : ''} ${index < activeIndex ? 'done' : ''}`}
                aria-current={stage.id === active ? 'step' : undefined}
                disabled={!canOpen(stage.id)} onClick={() => onOpen(stage.id)}>
          <span className="stage-mark" aria-hidden="true">
            {index < activeIndex ? '♩' : '𝄀'}
          </span>
          <span className="stage-words">
            <strong>{t(stage.title)}</strong>
            <small>{t(stage.hint)}</small>
          </span>
        </button>
      ))}
    </nav>
  )
}
