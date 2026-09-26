import type { ReactNode } from 'react'
import { t } from '../../i18n/messages'
import type { StageId } from './stages'
import { STAGES } from './stages'

/**
 * How the columns of a stage share the width.
 *
 * A laptop screen is wide and short. Stacking a stage's parts one under the
 * other put the thing you were there to do — the score, the mentor, the next
 * button — a scroll or two below the fold. Every stage is two panes side by
 * side instead, each scrolling on its own, with the actions pinned underneath.
 */
export type StageLayout =
  | 'library'   // browse on the left, the chosen piece on the right
  | 'sources'   // a short list of choices, then the chosen one set up
  | 'desk'      // the page, with a rail beside it for what you are doing
  | 'review'    // the reading of your take, the mentor beside it
  | 'bench'     // a form, and what it will make
  | 'single'    // one pane

export interface StageActions {
  /** The way back — always on the left. */
  back?: ReactNode
  /** Where things stand, between the two. */
  status?: ReactNode
  /** The one thing to do next — always on the right, always visible. */
  primary?: ReactNode
}

export function Stage({ id, layout, heading, headExtra, main, aside, actions, className = '' }: {
  id: StageId
  layout: StageLayout
  /** Overrides the stage name for a sub-step, e.g. "Design the exercise". */
  heading?: string
  /** Sits at the right of the heading row: a sub-step trail, a badge. */
  headExtra?: ReactNode
  main: ReactNode
  aside?: ReactNode
  actions?: StageActions
  className?: string
}) {
  const stage = STAGES.find((item) => item.id === id)!
  const titleId = `stage-${id}-title`
  return (
    <section className={`stage stage-${id} ${className}`} aria-labelledby={titleId}>
      {/* The step bar already names this stage. A heading row that only says
          it again costs a line of height on every screen, so it is kept for
          screen readers and shown only when it has something to add. */}
      <header className={`stage-head ${heading || headExtra ? '' : 'visually-hidden'}`}>
        <h2 id={titleId}>{heading ?? t(stage.title)}</h2>
        {headExtra && <div className="stage-head-extra">{headExtra}</div>}
      </header>
      <div className={`stage-body layout-${aside ? layout : 'single'}`}>
        <div className="stage-main scroll-pane">{main}</div>
        {aside && <div className="stage-aside scroll-pane">{aside}</div>}
      </div>
      {actions && (actions.back || actions.status || actions.primary) && (
        <footer className="stage-actions">
          <div className="stage-actions-back">{actions.back}</div>
          <div className="stage-actions-status">{actions.status}</div>
          <div className="stage-actions-primary">{actions.primary}</div>
        </footer>
      )}
    </section>
  )
}
