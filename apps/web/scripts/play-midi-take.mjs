/**
 * Plays a MIDI file into the running app as if it came from a USB keyboard, and
 * reports what the live layer made of it.
 *
 *   node apps/web/scripts/play-midi-take.mjs packages/score-fixtures/midi/live/twinkle-correct.mid
 *
 * Options (environment):
 *   SONG=小星星     which score to open
 *   BARS=1-4        practice range
 *   HEADED=1        watch it happen in a real window
 *   SHOT=path.png   save a screenshot of the staff at the end
 *
 * Needs the API on :8000 and the web app on :5173.
 */
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import tonejsMidi from '@tonejs/midi'

const { Midi } = tonejsMidi

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/play-midi-take.mjs <file.mid>')
  process.exit(2)
}
const BASE_URL = process.env.BASE_URL || 'http://localhost:5173'
const SONG = process.env.SONG || '小星星'
const [BAR_FROM, BAR_TO] = (process.env.BARS || '1-4').split('-').map(Number)

const midi = new Midi(readFileSync(resolve(file)))
const strikes = midi.tracks
  .flatMap((track) => track.notes)
  .map((note) => ({ atMs: note.time * 1000, pitch: note.midi, ms: note.duration * 1000 }))
  .sort((left, right) => left.atMs - right.atMs || left.pitch - right.pitch)
if (!strikes.length) {
  console.error(`${file} contains no notes`)
  process.exit(2)
}
console.log(`\n${basename(file)} — ${strikes.length} notes over ` +
  `${(strikes[strikes.length - 1].atMs / 1000).toFixed(1)}s\n`)

const browser = await chromium.launch({ headless: !process.env.HEADED })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage()
await page.addInitScript(() => {
  const input = { id: 'take', name: 'Sample Take', state: 'connected', type: 'input',
    onmidimessage: null, open: async () => {}, close: async () => {} }
  const access = { inputs: new Map([[input.id, input]]), onstatechange: null }
  Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async () => access })
  window.__midiNote = (n, on) => input.onmidimessage?.({
    data: new Uint8Array([on ? 0x90 : 0x80, n, on ? 82 : 0]), receivedTime: performance.now(),
  })
})
const send = (pitch, on) => page.evaluate(
  ([p, o]) => window.__midiNote(p, o), [pitch, on])
const wait = (ms) => new Promise((done) => setTimeout(done, Math.max(0, ms)))

await page.goto(BASE_URL, { waitUntil: 'networkidle' })
await page.waitForSelector('.score-card')
await page.locator('.score-card', { hasText: SONG }).first().click()
await page.waitForTimeout(2_000)
const range = page.locator('.range-row input[type="number"]')
await range.first().fill(String(BAR_FROM))
await range.last().fill(String(BAR_TO))
await range.last().blur()
await page.waitForTimeout(400)

await page.getByRole('button', { name: /设备检查/ }).first().click()
await page.waitForTimeout(1_200)
await page.locator('.device-item').first().click()
await page.waitForTimeout(300)
for (const pitch of [60, 62, 64, 65, 67, 69]) {
  await send(pitch, true); await wait(55); await send(pitch, false)
}
await page.waitForTimeout(400)
await page.getByRole('button', { name: /播放预备拍并开始/ }).click()
await page.waitForTimeout(4_000)

// Play the file in real time, and read the panel after every strike.
const seen = []
const releases = []
const started = Date.now()
let index = 0
while (index < strikes.length) {
  const at = strikes[index].atMs
  const together = []
  while (index < strikes.length && strikes[index].atMs - at < 1) {
    together.push(strikes[index]); index += 1
  }
  await wait(at - (Date.now() - started))
  for (const note of together) {
    await send(note.pitch, true)
    releases.push({ at: at + note.ms, pitch: note.pitch })
  }
  for (const done of releases.filter((r) => r.at <= Date.now() - started)) {
    await send(done.pitch, false)
  }
  await page.waitForTimeout(140)
  seen.push(await page.evaluate(() => {
    const panel = document.querySelector('.live-panel')
    const text = (selector) => panel?.querySelector(selector)?.textContent?.trim() ?? ''
    return {
      status: text('.live-status'),
      played: [...(panel?.querySelectorAll('.played-chip') ?? [])].map((el) => el.textContent.trim()),
      position: panel?.querySelectorAll('.live-facts dd')[1]?.textContent?.trim() ?? '',
      owed: text('.live-owed .live-missing'),
    }
  }))
}
for (const done of releases) await send(done.pitch, false)

let last = ''
for (const row of seen) {
  const line = `${row.position.padEnd(22)} ${row.played.join('+').padEnd(12)} ` +
    `${row.status.padEnd(14)} ${row.owed}`
  if (line !== last) console.log(`  ${line}`)
  last = line
}

if (process.env.SHOT) {
  const studio = await page.locator('.practice-studio').boundingBox()
  await page.screenshot({ path: process.env.SHOT, clip: {
    x: studio.x, y: studio.y, width: studio.width, height: Math.min(studio.height, 560),
  } })
}
const finished = seen[seen.length - 1]
console.log(`\nended at ${finished.position}` +
  (finished.owed ? ` — still owed: ${finished.owed}` : ''))
if (process.env.HEADED) await page.waitForTimeout(8_000)
await browser.close()
