/**
 * Where the follow cursor lands while you are actually playing.
 *
 * The sheet scrolls itself during a take, and the marks on it are positioned as
 * a percentage of the page. Those two facts fight: a scroll container that is
 * also the positioning context resolves `top: 33%` against the *visible*
 * height, not the height of the music, so every mark creeps toward the top and
 * the error grows the further down the page you get. It looked fine on the
 * report, where nothing scrolls, which is why this checks the playing screen.
 *
 *   node scripts/audit-live-cursor.mjs
 */
import { chromium } from '@playwright/test'
const BASE = process.env.BASE ?? 'http://localhost:5173'
const browser = await chromium.launch({ headless: !process.env.HEADED })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 780 } })).newPage()
await page.addInitScript(() => {
  const input = { id: 't', name: 'T', state: 'connected', type: 'input',
    onmidimessage: null, open: async () => {}, close: async () => {} }
  const access = { inputs: new Map([[input.id, input]]), onstatechange: null }
  Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async () => access })
  window.__midiNote = (n, on) => input.onmidimessage?.({
    data: new Uint8Array([on ? 0x90 : 0x80, n, on ? 82 : 0]), receivedTime: performance.now() })
})
const send = (p, o) => page.evaluate(([a, b]) => window.__midiNote(a, b), [p, o])
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForSelector('.score-card')
await page.locator('.score-card', { hasText: '小星星' }).first().click()
await page.waitForTimeout(2000)
const range = page.locator('.range-row input[type="number"]')
if (await range.count()) { await range.first().fill('1'); await range.last().fill('12'); await range.last().blur() }
await page.waitForTimeout(600)
await page.getByRole('button', { name: /设备检查/ }).first().click()
await page.waitForTimeout(1200)
await page.locator('.device-item').first().click()
await page.waitForTimeout(300)
for (const p of [60,62,64,65,67,69]) { await send(p, true); await page.waitForTimeout(55); await send(p, false) }
await page.waitForTimeout(400)
await page.getByRole('button', { name: /播放预备拍并开始/ }).click()
await page.waitForTimeout(4500)
for (const p of [60,60,67,67,69,69,67]) { await send(p, true); await page.waitForTimeout(180); await send(p, false) }
await page.waitForTimeout(800)
const measured = await page.evaluate(() => {
  const sv = document.querySelector('.score-viewer')
  const cur = document.querySelector('[data-testid=score-cursor]')
  const svg = sv?.querySelector('svg')
  const anchors = window.__scoreAnchors
  const r = (el) => { const b = el.getBoundingClientRect(); return { top: Math.round(b.top), h: Math.round(b.height) } }
  return {
    viewer: { client: sv?.clientHeight, scroll: sv?.scrollHeight, scrollTop: sv?.scrollTop,
              position: getComputedStyle(sv).position, ...r(sv) },
    svg: svg ? r(svg) : null,
    cursorStyleTop: cur?.style.top, cursorRect: cur ? r(cur) : null,
    // Where the cursor *should* be: same fraction of the real sheet.
    anchorsSample: Array.isArray(anchors) ? anchors.slice(0, 2).map(a => ({ p: a.pitch, top: Math.round(a.top) })) : null,
  }
})
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT })
await browser.close()

const checks = []
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); }

const { viewer, svg, cursorRect, cursorStyleTop } = measured
if (!svg || !cursorRect || !cursorStyleTop) {
  console.error('No cursor on the page — the take did not start.')
  process.exit(1)
}
const fraction = Number.parseFloat(cursorStyleTop) / 100
const belongs = svg.top + fraction * svg.h
const off = Math.abs(cursorRect.top - belongs)
// One staff step is a few pixels; anything past a couple of pixels is visible
// as the cursor sitting on the wrong line.
check('the cursor sits where the page says it does',
      off <= 4, `drawn at ${cursorRect.top}, belongs at ${Math.round(belongs)} (off by ${off.toFixed(1)}px)`)
check('the sheet is taller than its window, so it has somewhere to scroll',
      viewer.scroll > viewer.client, `${viewer.scroll}px of music in a ${viewer.client}px window`)
check('the sheet followed the player',
      viewer.scrollTop > 0, `scrolled to ${viewer.scrollTop}px`)

console.log('\nThe follow cursor while playing')
for (const c of checks) {
  console.log(`  ${c.ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m'} ${c.name}  — ${c.detail}`)
}
const passed = checks.filter((c) => c.ok).length
console.log(`\n${passed}/${checks.length} checks passed`)
process.exit(passed === checks.length ? 0 : 1)
