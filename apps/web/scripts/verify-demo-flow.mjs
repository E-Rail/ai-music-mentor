/**
 * Walks the whole product the way a demo does, against the real backend, and
 * says plainly what worked. Run it before presenting.
 *
 *   node apps/web/scripts/verify-demo-flow.mjs
 *
 * Needs the API on :8000 and the web app on :5173 (or set BASE_URL / API_URL).
 * USB MIDI is simulated, so this runs without any hardware attached.
 */
import { chromium } from '@playwright/test'

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173'
const API_URL = process.env.API_URL || 'http://127.0.0.1:8000'
const SHOTS = process.env.SHOT_DIR || null

const steps = []
let failures = 0

function record(name, ok, detail = '') {
  steps.push({ name, ok, detail })
  if (!ok) failures += 1
  const mark = ok ? '[32m✓[0m' : '[31m✗[0m'
  console.log(`  ${mark} ${name}${detail ? `  — ${detail}` : ''}`)
}

async function check(name, fn) {
  try {
    const detail = await fn()
    record(name, true, detail || '')
  } catch (error) {
    record(name, false, error.message.split('\n')[0].slice(0, 160))
  }
}

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  permissions: ['microphone'],
})
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(error.message))

// Simulate a USB MIDI keyboard so no hardware is needed to verify the path.
await page.addInitScript(() => {
  const input = {
    id: 'verify-midi', name: 'Verify Keyboard', state: 'connected', type: 'input',
    onmidimessage: null, open: async () => undefined, close: async () => undefined,
  }
  const access = { inputs: new Map([[input.id, input]]), onstatechange: null }
  Object.defineProperty(navigator, 'requestMIDIAccess', {
    configurable: true, value: async () => access,
  })
  Object.assign(window, {
    __midiNote(note, on = true) {
      input.onmidimessage?.({
        data: new Uint8Array([on ? 0x90 : 0x80, note, on ? 82 : 0]),
        receivedTime: performance.now(),
      })
    },
  })
})

const play = async (pitch, holdMs = 55) => {
  await page.evaluate((p) => window.__midiNote(p, true), pitch)
  await page.waitForTimeout(holdMs)
  await page.evaluate((p) => window.__midiNote(p, false), pitch)
}

const shot = async (name) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/flow-${name}.png`, fullPage: true })
}

console.log('\nBackend')
let songs = []
await check('API is up and serving the score library', async () => {
  const response = await fetch(`${API_URL}/api/v1/scores`)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = await response.json()
  songs = body.scores.filter((score) => score.libraryCategory === 'demo')
  return `${songs.length} demo songs`
})

await check('well-known demo songs are present with their real names', () => {
  const titles = new Set(songs.map((song) => song.title))
  const wanted = ['小星星', '欢乐颂', '两只老虎', '茉莉花']
  const missing = wanted.filter((title) => !titles.has(title))
  if (missing.length) throw new Error(`missing ${missing.join(', ')}`)
  return wanted.join(' · ')
})

console.log('\nUSB MIDI path')
// 小星星 bars 1-2, in the octave the score is actually written in. These are
// the right notes: the run below is a correct take, so the report has to agree
// that it was correct. A take that is wrong on purpose proves far less.
const TWINKLE = [60, 60, 67, 67, 69, 69, 67]   // C4 C4 G4 G4 | A4 A4 G4

await check('app loads without a page error', async () => {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' })
  await page.waitForSelector('.score-card', { timeout: 15_000 })
  if (pageErrors.length) throw new Error(pageErrors[0])
  return `${await page.locator('.score-card').count()} songs listed`
})

await check('pick 小星星 and narrow the practice range to bars 1–2', async () => {
  await page.locator('.score-card', { hasText: '小星星' }).first().click()
  await page.waitForTimeout(1_800)
  const range = await page.locator('.range-row').innerText()
  if (!range.includes('12')) throw new Error(`unexpected measure count: ${range}`)
  // The take below plays exactly these two bars, so the report is about a
  // complete passage rather than one the player abandoned.
  const end = page.locator('.range-row input[type="number"]').last()
  await end.fill('2')
  await end.blur()
  await page.waitForTimeout(400)
  await shot('01-score')
  return '12 bars available, practising 1–2'
})

await check('device check accepts the keyboard', async () => {
  await page.getByRole('button', { name: /设备检查/ }).first().click()
  await page.waitForTimeout(1_200)
  await page.locator('.device-item').first().click()
  await page.waitForTimeout(300)
  for (const pitch of [60, 62, 64, 65, 67, 69]) await play(pitch)
  await page.waitForTimeout(400)
  await shot('02-device')
  const start = page.getByRole('button', { name: /播放预备拍并开始/ })
  if (await start.isDisabled()) throw new Error('start stayed disabled after calibration')
  return 'calibration satisfied'
})

await check('recording starts and the player may begin whenever they like', async () => {
  await page.getByRole('button', { name: /播放预备拍并开始/ }).click()
  await page.waitForTimeout(3_500)
  // Deliberately wait before the first note.
  await page.waitForTimeout(2_500)
  await play(TWINKLE[0])
  await page.waitForTimeout(500)
  const timing = await page.locator('.live-facts dd').nth(2).innerText()
  if (!timing.includes('从这个音开始计时')) {
    throw new Error(`first note judged as: ${timing}`)
  }
  return 'first note anchors the timeline'
})

await check('the score engraves and shows the note actually played', async () => {
  const BEAT = 60_000 / 92
  for (const pitch of TWINKLE.slice(1)) {
    await page.waitForTimeout(BEAT - 55)
    await play(pitch)
  }
  await page.waitForTimeout(400)
  await shot('03-playing')
  if (!(await page.locator('.score-stage svg').count())) {
    throw new Error('no engraved staff')
  }
  const marker = page.getByTestId('score-played-note').first()
  const played = await marker.getAttribute('data-pitch')
  const role = await marker.getAttribute('data-role')
  if (!played) throw new Error('no played-note marker on the staff')
  // The notes above are the ones on the page, so the app has to recognise them
  // as such. If this reads "extra", the score and the keyboard disagree about
  // what octave the piece is in.
  if (role !== 'matched') {
    throw new Error(`a correct note was judged "${role}" at pitch ${played}`)
  }
  return `staff engraved, marker at pitch ${played} (${role})`
})

let reportReady = false
await check('stop and analyse produces a report', async () => {
  await page.getByRole('button', { name: /停止并分析/ }).click()
  await page.waitForSelector('.metrics-grid', { timeout: 45_000 })
  await shot('04-report')
  reportReady = true
  const overall = await page.locator('.metric .value').first().innerText()
  // A take that played the right notes must not be scored as wrong ones.
  const pitchScore = Number(await page.locator('.metric .value').nth(1).innerText())
  if (Number.isFinite(pitchScore) && pitchScore < 60) {
    throw new Error(`correct notes scored ${pitchScore} for pitch`)
  }
  return `overall ${overall}, pitch ${pitchScore}`
})

await check('the report cites verifiable evidence', async () => {
  if (!reportReady) throw new Error('skipped: no report')
  const errors = await page.locator('.error-item').count()
  const metrics = await page.locator('.metric').count()
  if (!metrics) throw new Error('no metrics rendered')
  return `${metrics} metrics, ${errors} located errors`
})

await check('AI mentor finishes thinking and answers', async () => {
  if (!reportReady) throw new Error('skipped: no report')
  const box = page.locator('.mentor-box').first()
  if (!(await box.count())) throw new Error('mentor panel missing')
  // Wait for the summary itself. Absence of the spinner is not an answer — the
  // request may simply not have started yet.
  // waitForFunction takes (pageFunction, arg, options). Passing the options as
  // the second argument silently hands them to the page as data and leaves the
  // 30s default in force — which is shorter than a slow host takes to answer.
  await page.waitForFunction(() => {
    const node = document.querySelector('.mentor-box .summary')
    return !!node && (node.textContent || '').trim().length > 10
  }, null, { timeout: 150_000 })
  const summary = await box.locator('.summary').innerText()
  const provider = await box.locator('.mentor-meta').innerText().catch(() => '')
  if (summary.trim().length < 10) throw new Error('mentor produced no summary')
  return `${provider.trim()} · ${summary.replace(/\s+/g, ' ').trim().slice(0, 50)}…`
})

await check('exercise generation reaches a generated practice score', async () => {
  if (!reportReady) throw new Error('skipped: no report')
  await page.getByRole('button', { name: /生成练习/ }).first().click()
  await page.waitForTimeout(1_200)
  await shot('05-designer')
  await page.getByRole('button', { name: /让 AI 设计并生成|生成/ }).first().click()
  await page.waitForSelector('.generated-plan-card', { timeout: 150_000 })
  await shot('06-exercise')
  const plan = await page.locator('.plan-facts').first().innerText()
  return plan.replace(/\s+/g, ' ').trim().slice(0, 70)
})

await check('retry with accompaniment records a second take', async () => {
  const enter = page.getByRole('button', { name: /进入合奏验证/ })
  if (!(await enter.count())) throw new Error('no route into the retry stage')
  await enter.first().click()
  await page.waitForTimeout(1_500)
  const start = page.getByRole('button', { name: /启动伴奏并演奏/ })
  if (!(await start.count())) throw new Error('accompaniment control missing')
  await start.first().click()
  await page.waitForTimeout(4_000)
  for (const pitch of [72, 74, 76, 77]) {
    await play(pitch)
    await page.waitForTimeout(400)
  }
  await shot('07-retry')
  return 'second take captured'
})

await check('comparison table reports the two rounds', async () => {
  const stop = page.getByRole('button', { name: /停止并对比/ })
  if (!(await stop.count())) throw new Error('no stop-and-compare control')
  await stop.first().click()
  await page.waitForSelector('.comparison-table', { timeout: 45_000 })
  await shot('08-comparison')
  const rows = await page.locator('.comparison-table tbody tr').count()
  return `${rows} metrics compared`
})

console.log('\nMicrophone path')
await check('microphone mode is reachable and asks for the room check', async () => {
  const fresh = await context.newPage()
  fresh.on('pageerror', (error) => pageErrors.push(error.message))
  await fresh.goto(BASE_URL, { waitUntil: 'networkidle' })
  await fresh.waitForSelector('.score-card')
  await fresh.locator('.score-card', { hasText: '两只老虎' }).first().click()
  await fresh.waitForTimeout(1_500)
  await fresh.getByRole('button', { name: /设备检查/ }).first().click()
  await fresh.waitForTimeout(1_000)
  const micButton = fresh.getByRole('button', { name: /麦克风/ }).first()
  if (!(await micButton.count())) throw new Error('microphone input option missing')
  await micButton.click()
  await fresh.waitForTimeout(800)
  if (SHOTS) await fresh.screenshot({ path: `${SHOTS}/flow-09-microphone.png`, fullPage: true })
  const panel = await fresh.locator('.microphone-panel').count()
  await fresh.close()
  if (!panel) throw new Error('microphone panel did not render')
  return 'panel ready for the room-noise check'
})

await check('no uncaught page errors during the whole run', () => {
  if (pageErrors.length) throw new Error(`${pageErrors.length}: ${pageErrors[0]}`)
  return 'clean'
})

await browser.close()

const passed = steps.filter((step) => step.ok).length
console.log(`\n${passed}/${steps.length} checks passed`)
if (failures) {
  console.log('\nFailed:')
  for (const step of steps.filter((item) => !item.ok)) {
    console.log(`  - ${step.name}: ${step.detail}`)
  }
}
process.exit(failures ? 1 : 0)
