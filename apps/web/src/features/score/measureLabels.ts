/**
 * One vocabulary for bar numbers, shared by the page and everything said about it.
 *
 * `measureNo` is a position in the performance timeline: 1, 2, 3… always, which
 * is what alignment, event IDs and the follower need. It is not always the
 * number printed on the page. A piece that opens with a pickup bar prints that
 * bar as 0, so every printed number after it is one lower than its position —
 * and a report that says "第 4 小节" then sends the student to the wrong bar.
 *
 * The score itself decides its own labels (see `measure_labels` on the API side);
 * this module is where the browser reads them. There is one score open at a
 * time, so the labels live here rather than being threaded through every
 * component that happens to mention a bar — the same shape as the message
 * catalogue in `i18n/messages`.
 */

let labels: string[] = []

/** Publish the open score's labels. Call once, wherever the score is set. */
export function setScoreMeasureLabels(next: string[] | undefined | null): void {
  labels = Array.isArray(next) ? next : []
}

/** For tests and callers that hold a score other than the open one. */
export function scoreMeasureLabels(): string[] {
  return labels
}

/**
 * The name for one bar. Falls back to its position, which is right for scores
 * that are numbered plainly and is never worse than printing nothing.
 */
export function measureLabel(measureNo: number, from: string[] = labels): string {
  const label = from[measureNo - 1]
  return label && label.trim() ? label.trim() : String(measureNo)
}

/** A list of bars, in the order given. */
export function measureLabelList(
  measures: readonly number[], separator = '、', from: string[] = labels,
): string {
  return measures.map((measure) => measureLabel(measure, from)).join(separator)
}

// `<part ...>`, and deliberately not `<part-list>`: `\b` would match the hyphen
// and swallow the part list into the first part's block.
const PART_BLOCK = /<part(?:\s[^>]*)?>[\s\S]*?<\/part>/g
const MEASURE_TAG = /<measure\b([^>]*?)(\/?)>/g
const NUMBER_ATTR = /\bnumber\s*=\s*"[^"]*"/

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

/**
 * Print the same labels on the engraved page.
 *
 * A renderer shows whatever number the file carries, so a file whose bars are
 * all numbered 0 — or numbered in a way the score rejected as untrustworthy —
 * would contradict every position the app reports. Rewriting the numbers before
 * the renderer sees them makes that contradiction impossible.
 *
 * A part whose bar count does not match the label list is left exactly as it
 * was: that means repeats were expanded into the timeline but not into the
 * page, and renumbering under that mismatch would put the wrong name on a bar.
 */
export function renumberMeasures(xml: string, from: string[] = labels): string {
  if (!from.length || !xml.includes('<measure')) return xml
  return xml.replace(PART_BLOCK, (part) => {
    if ((part.match(MEASURE_TAG) ?? []).length !== from.length) return part
    let index = 0
    return part.replace(MEASURE_TAG, (_tag, attributes: string, selfClose: string) => {
      const label = escapeAttribute(measureLabel(index + 1, from))
      index += 1
      const rewritten = NUMBER_ATTR.test(attributes)
        ? attributes.replace(NUMBER_ATTR, `number="${label}"`)
        : ` number="${label}"${attributes}`
      return `<measure${rewritten}${selfClose}>`
    })
  })
}
