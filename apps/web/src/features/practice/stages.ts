import type { MessageKey } from '../../i18n/messages'

/** Where the studio is, as the workflow sees it. */
export type Step = 'select' | 'calibrate' | 'perform' | 'report' | 'exercise' | 'compare'

/** Where the studio is, as the player sees it: five places, in the order you pass through them. */
export type StageId = 'score' | 'input' | 'perform' | 'review' | 'practice'

export interface StageDefinition {
  id: StageId
  /** The stage's name — in the step bar and as the heading of its page, so the two always agree. */
  title: MessageKey
  hint: MessageKey
  steps: readonly Step[]
}

/**
 * The practice loop, once.
 *
 * The step bar used to have four places and hid the whole second half of the
 * loop — designing an exercise, playing it with accompaniment, comparing —
 * under a tab called "Mentor", while the page itself said "Diagnosis". Naming
 * each place here, and reading the name from here everywhere, is what keeps
 * the bar and the page from disagreeing again.
 */
export const STAGES: readonly StageDefinition[] = [
  { id: 'score', title: 'stageScore', hint: 'stageScoreHint', steps: ['select'] },
  { id: 'input', title: 'stageInput', hint: 'stageInputHint', steps: ['calibrate'] },
  { id: 'perform', title: 'stagePerform', hint: 'stagePerformHint', steps: ['perform'] },
  { id: 'review', title: 'stageReview', hint: 'stageReviewHint', steps: ['report'] },
  { id: 'practice', title: 'stagePractice', hint: 'stagePracticeHint', steps: ['exercise', 'compare'] },
]

export function stageOf(step: Step): StageDefinition {
  return STAGES.find((stage) => stage.steps.includes(step)) ?? STAGES[0]
}
