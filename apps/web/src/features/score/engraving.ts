/**
 * How this app engraves a page, in one place.
 *
 * Every score the student sees — the library preview, the passage they are
 * about to play, a generated exercise, the retry — goes through `ScoreViewer`,
 * so these settings are the whole app's house style. They are written down
 * separately from the component because they are decisions about reading music,
 * not about React.
 */
import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'

export const ENGRAVING_OPTIONS = {
  autoResize: false,
  backend: 'svg',
  drawTitle: true,
  drawSubtitle: false,
  drawComposer: false,
  pageBackgroundColor: 'white',
  // "Right Hand" / "Left Hand" / "Pno" down the left margin is engraving for an
  // orchestral score, where a player has to find their own line. A student at a
  // piano already knows which hand is which, and the labels cost the width the
  // music needs.
  drawPartNames: false,
  drawPartAbbreviations: false,
  // Every bar, not every other one. The app tells a student to fix 第 7 小节;
  // they must be able to find bar 7 by reading, not by counting from bar 5.
  drawMeasureNumbers: true,
  measureNumberInterval: 1,
} as const

/**
 * Spacing that keeps a grand staff reading as one instrument.
 *
 * OSMD's defaults space two staves far enough apart that a piano part looks
 * like two unrelated players — which is exactly the wrong thing to teach
 * someone whose hands have to arrive together.
 */
export function applyEngravingRules(osmd: OpenSheetMusicDisplay): void {
  const rules = osmd.EngravingRules
  if (!rules) return
  rules.StaffDistance = 5.5
  rules.BetweenStaffDistance = 4.0
  rules.MinimumDistanceBetweenSystems = 5.0
  rules.PageTopMargin = 3.0
  rules.PageBottomMargin = 1.0
  // Sit the number clear of the top staff line so it never collides with a
  // ledger line or a note above the staff.
  rules.MeasureNumberLabelOffset = -1.6
  rules.MeasureNumberLabelHeight = 1.3
}

const TITLE_TAGS = /<(work-title|movement-title)>[\s\S]*?<\/\1>/g
const ROOT_OPEN = /<score-(?:partwise|timewise)\b[^>]*>/

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Print the title the app calls this piece, not the one in the file.
 *
 * A bundled piece is stored under its Chinese name and a music21 export calls
 * itself "Music21 Fragment", so the engraved heading either contradicted the
 * library card or stayed Chinese in an English studio. Whatever the card says,
 * the page says.
 */
export function retitle(xml: string, title: string | undefined): string {
  const wanted = title?.trim()
  if (!wanted) return xml
  const escaped = escapeText(wanted)
  if (/<(work-title|movement-title)>/.test(xml)) {
    return xml.replace(TITLE_TAGS, (_whole, tag: string) => `<${tag}>${escaped}</${tag}>`)
  }
  return xml.replace(ROOT_OPEN, (open) => `${open}<movement-title>${escaped}</movement-title>`)
}
