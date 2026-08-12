/**
 * Finds anything painting outside the page or outside its own box.
 *
 * Shared by the layout audit and the demo-flow check, so "nothing overflows"
 * means the same thing in both and gets asserted at every stage of the product
 * rather than on the two screens someone happened to look at.
 */

const PROBE = () => {
  const found = []
  const pageWidth = document.documentElement.clientWidth
  const describe = (el) => {
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''
    return `${el.tagName.toLowerCase()}${cls}`
  }
  for (const el of document.querySelectorAll('body *')) {
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    const rect = el.getBoundingClientRect()
    if (!rect.width && !rect.height) continue

    // Content wider than the element, with nothing offering to scroll it.
    // An absolutely positioned child hanging off its anchor — a label on a note
    // — is deliberate, so only content still in the flow counts as a spill.
    const spill = el.scrollWidth - el.clientWidth
    if (spill > 1 && style.overflowX === 'visible' && el.clientWidth > 0) {
      const children = [...el.children]
      const inFlowSpills = !children.length || children.some((child) => {
        const childStyle = getComputedStyle(child)
        if (childStyle.position === 'absolute' || childStyle.position === 'fixed') return false
        const childRect = child.getBoundingClientRect()
        return childRect.right > rect.right + 1 || childRect.left < rect.left - 1
      })
      if (inFlowSpills) {
        found.push({ kind: 'content-spill', el: describe(el), by: spill, box: Math.round(el.clientWidth) })
      }
    }
    // Painted off the side of the page.
    if (rect.right > pageWidth + 1 || rect.left < -1) {
      found.push({
        kind: 'off-page', el: describe(el),
        by: Math.round(Math.max(rect.right - pageWidth, -rect.left)),
        box: Math.round(rect.width),
      })
    }
  }
  // One spilling parent reports every descendant; keep the first of each kind.
  const seen = new Set()
  const unique = found.filter((row) => {
    const key = `${row.kind}|${row.el}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return {
    rows: unique.slice(0, 25),
    pageScroll: document.documentElement.scrollWidth - pageWidth,
  }
}

export async function findOverflow(page) {
  return page.evaluate(PROBE)
}

/** One line per problem, ready to print or to attach to a failure. */
export function describeOverflow({ rows, pageScroll }) {
  const lines = rows.map((row) =>
    `${row.kind.padEnd(13)} ${row.el.padEnd(46)} +${row.by}px (box ${row.box})`)
  if (pageScroll > 1) lines.unshift(`the page itself scrolls sideways by ${pageScroll}px`)
  return lines
}
