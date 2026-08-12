/**
 * Checks that the live overlay draws your note where that note lives on the
 * page, and that nothing it hangs off the note leaves the paper.
 *
 *   node apps/web/scripts/audit-score-overlay.mjs
 *
 * Needs the API on :8000 and the dev server on :5173 — it reads the engraved
 * note positions the viewer exposes in development.
 */
import { chromium } from '@playwright/test'

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173'
const WRONG_NOTE = Number(process.env.PITCH || 70)   // B♭4 — the note in bar 1

const checks = []
const record = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`  ${ok ? '[32m✓[0m' : '[31m✗[0m'} ${name}${detail ? `  — ${detail}` : ''}`)
}

const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage()
await page.addInitScript(() => {
  const input = { id: 'a', name: 'Overlay Keyboard', state: 'connected', type: 'input',
    onmidimessage: null, open: async () => {}, close: async () => {} }
  const access = { inputs: new Map([[input.id, input]]), onstatechange: null }
  Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async () => access })
  window.__midiNote = (n, on = true) => input.onmidimessage?.({
    data: new Uint8Array([on ? 0x90 : 0x80, n, on ? 82 : 0]), receivedTime: performance.now(),
  })
})
const play = async (pitch, hold = 60) => {
  await page.evaluate((p) => window.__midiNote(p, true), pitch)
  await page.waitForTimeout(hold)
  await page.evaluate((p) => window.__midiNote(p, false), pitch)
}

console.log('\nWhere your note is drawn')
await page.goto(BASE_URL, { waitUntil: 'networkidle' })
await page.waitForSelector('.score-card')
await page.locator('.score-card', { hasText: '小星星' }).first().click()
await page.waitForFunction(() => window.__scoreAnchors?.length > 0, null, { timeout: 20_000 })
await page.getByRole('button', { name: /设备检查/ }).first().click()
await page.waitForTimeout(1_200)
await page.locator('.device-item').first().click()
await page.waitForTimeout(300)
for (const pitch of [60, 62, 64, 65, 67, 69]) await play(pitch)
await page.waitForTimeout(400)
await page.getByRole('button', { name: /播放预备拍并开始/ }).click()
await page.waitForTimeout(4_000)
await play(WRONG_NOTE, 400)
await page.waitForTimeout(600)

const seen = await page.evaluate(() => {
  const dot = document.querySelector('.score-played-note')
  const stage = document.querySelector('.score-stage')?.getBoundingClientRect()
  const svg = document.querySelector('.score-stage svg')
  const view = svg?.getAttribute('viewBox')?.split(/[\s,]+/).map(Number)
  const labels = [...document.querySelectorAll(
    '.played-note-name, .played-note-timing, .cursor-tag, .marker-tag, .cursor-relocking')]
    .map((el) => {
      const r = el.getBoundingClientRect()
      return {
        text: (el.textContent || '').trim().slice(0, 12),
        escapes: Math.round(Math.max(
          stage.top - r.top, r.bottom - stage.bottom,
          stage.left - r.left, r.right - stage.right)),
      }
    })
  return {
    pitch: dot ? Number(dot.dataset.pitch) : null,
    topPercent: dot ? Number.parseFloat(dot.style.top) : null,
    sheetHeight: view?.[3] ?? null,
    anchors: window.__scoreAnchors ?? [],
    labels,
  }
})

// 小星星 opens on the first line of music, so the notes engraved in its first
// bars are the yardstick for where a wrong note on that line belongs.
const firstLine = seen.anchors.filter((a) => a.measure <= 3 && a.staffIndex === 0)
const byPitch = new Map(firstLine.map((a) => [a.pitch, a.y]))
const STEP_BY_CLASS = [0, 0, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6]
const step = (midi) => Math.floor(midi / 12) * 7 + STEP_BY_CLASS[((midi % 12) + 12) % 12]

record('the page reports its notes in MIDI numbers', byPitch.has(60) && byPitch.has(67),
  `bar 1 is ${[...byPitch.keys()].sort((a, b) => a - b).join(', ')} (C4 = 60)`)

const low = byPitch.get(60)
const high = byPitch.get(69) ?? byPitch.get(67)
const highPitch = byPitch.has(69) ? 69 : 67
const stepHeight = low !== undefined && high !== undefined
  ? (low - high) / (step(highPitch) - step(60)) : null

const drawnY = seen.topPercent !== null && seen.sheetHeight
  ? seen.topPercent / 100 * seen.sheetHeight : null
const expectedY = stepHeight !== null
  ? high - (step(WRONG_NOTE) - step(highPitch)) * stepHeight : null

record('a wrong note lands on its own line of the staff',
  drawnY !== null && expectedY !== null && Math.abs(drawnY - expectedY) <= 1.5,
  drawnY === null ? 'no note was drawn'
    : `drawn at ${drawnY.toFixed(1)}, belongs at ${expectedY.toFixed(1)} (one staff step is ${stepHeight?.toFixed(1)})`)

const stray = seen.labels.filter((label) => label.escapes > 0)
record('every label stays on the paper', stray.length === 0,
  stray.length ? stray.map((l) => `"${l.text}" by ${l.escapes}px`).join(', ')
    : `${seen.labels.length} checked`)

if (process.env.SHOT) {
  const stage = await page.locator('.score-stage').boundingBox()
  await page.screenshot({ path: process.env.SHOT, clip: {
    x: stage.x, y: stage.y, width: stage.width, height: Math.min(stage.height, 340),
  } })
}
await browser.close()

const passed = checks.filter((check) => check.ok).length
console.log(`\n${passed}/${checks.length} checks passed`)
process.exit(passed === checks.length ? 0 : 1)
