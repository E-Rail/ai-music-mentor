/** Finds every element that paints outside the page or outside its own box. */
import { chromium } from '@playwright/test'
import { describeOverflow, findOverflow } from './lib/overflow.mjs'

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173'
const WIDTHS = (process.env.WIDTHS || '1440,1280,1100').split(',').map(Number)

let failures = 0

const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
})

for (const width of WIDTHS) {
  const context = await browser.newContext({
    viewport: { width, height: 950 }, permissions: ['microphone'],
  })
  const page = await context.newPage()
  await page.addInitScript(() => {
    const input = { id: 'a', name: 'Audit Keyboard', state: 'connected', type: 'input',
      onmidimessage: null, open: async () => {}, close: async () => {} }
    const access = { inputs: new Map([[input.id, input]]), onstatechange: null }
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async () => access })
    window.__midiNote = (n, on = true) => input.onmidimessage?.({
      data: new Uint8Array([on ? 0x90 : 0x80, n, on ? 82 : 0]), receivedTime: performance.now(),
    })
  })

  const report = async (label) => {
    const lines = describeOverflow(await findOverflow(page))
    console.log(`\n  [${width}px] ${label}`)
    if (!lines.length) console.log('    clean')
    for (const line of lines) console.log(`    ${line}`)
    failures += lines.length
  }

  await page.goto(BASE_URL, { waitUntil: 'networkidle' })
  await page.waitForSelector('.score-card', { timeout: 15_000 })
  await report('song list')

  await page.locator('.score-card', { hasText: '小星星' }).first().click()
  await page.waitForTimeout(2_000)
  await report('score picked')

  await page.getByRole('button', { name: /设备检查/ }).first().click()
  await page.waitForTimeout(1_200)
  await report('device check (midi)')

  // Microphone branch, full width in the device-check step.
  const mic = page.getByRole('button', { name: /麦克风/ }).first()
  if (await mic.count()) {
    await mic.click()
    await page.waitForTimeout(1_500)
    await report('device check (microphone)')
    const columns = await page.evaluate(() => {
      const grid = document.querySelector('.mic-panel-grid')
      return grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0
    })
    console.log(`    full-width panel lays out in ${columns} column(s)`)
  }

  // The same panel as it is used in the studio: a 372px rail. Built with the
  // real ancestors, so the container queries it relies on actually apply.
  const railed = await page.evaluate(() => {
    const panel = document.querySelector('.microphone-panel')
    if (!panel) return null
    const host = document.createElement('div')
    host.style.cssText = 'position:absolute;left:-9999px;top:0;width:1368px'
    host.className = 'panel performance-panel'
    const studio = document.createElement('div')
    studio.className = 'practice-studio'
    const dock = document.createElement('aside')
    dock.className = 'input-dock'
    const clone = panel.cloneNode(true)
    dock.appendChild(clone)
    studio.append(Object.assign(document.createElement('div'), { className: 'score-stage' }), dock)
    host.appendChild(studio)
    document.body.appendChild(host)
    const worst = [...clone.querySelectorAll('*'), clone]
      .map((el) => ({ el: el.className || el.tagName, spill: el.scrollWidth - el.clientWidth }))
      .filter((row) => row.spill > 1)
      .sort((a, b) => b.spill - a.spill)[0]
    const width = clone.scrollWidth
    const rail = Math.round(dock.getBoundingClientRect().width)
    host.remove()
    return { width, rail, worst }
  })
  if (railed) {
    console.log(`\n  [${width}px] microphone panel in the studio rail`)
    console.log(`    rail is ${railed.rail}px, panel needs ${railed.width}px` +
      (railed.width > railed.rail ? `  → OVERFLOWS by ${railed.width - railed.rail}px` : '  → fits'))
    if (railed.worst) console.log(`    worst child: ${railed.worst.el} +${railed.worst.spill}px`)
  }

  await context.close()
}

await browser.close()

console.log(failures ? `\n${failures} layout problem(s) found` : '\nno layout problems found')
process.exit(failures ? 1 : 0)
