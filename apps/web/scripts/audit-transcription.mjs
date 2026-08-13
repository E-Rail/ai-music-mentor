/**
 * Score every transcription engine against notes we already know.
 *
 * The takes are rendered from the MIDI fixtures, so the reference is exact:
 * these pitches, at these milliseconds. Both engines are handed byte-identical
 * audio through the app's own decode and enhancement path, so the only thing
 * that differs between the columns is the model.
 *
 *   node scripts/audit-transcription.mjs
 *
 * `TAKE=twinkle-correct` limits it to one file, `ENGINES=onsets-frames` to one
 * model, `HEADED=1` opens a window.
 *
 * A note counts as found when the pitch matches exactly and the onset lands
 * within ONSET_TOLERANCE_MS, matched one-to-one nearest-first — the standard
 * note-onset criterion, so the numbers here mean what the papers' numbers mean.
 */
import { chromium } from '@playwright/test'

const BASE = process.env.BASE ?? 'http://localhost:5173'
const ONSET_TOLERANCE_MS = 50
const ENGINE_IDS = (process.env.ENGINES ?? 'onsets-frames,basic-pitch').split(',')
const INSTRUMENT = process.env.INSTRUMENT ?? 'piano'

/** Greedy nearest-first one-to-one matching, as mir_eval does it. */
function score(reference, predicted) {
  const takenPredictions = new Set()
  const missed = []
  let matched = 0
  let onsetErrorSum = 0
  for (const wanted of reference) {
    let best = -1
    let bestDelta = Infinity
    predicted.forEach((note, index) => {
      if (takenPredictions.has(index) || note.pitch !== wanted.pitch) return
      const delta = Math.abs(note.tOnMs - wanted.onsetMs)
      if (delta <= ONSET_TOLERANCE_MS && delta < bestDelta) {
        best = index
        bestDelta = delta
      }
    })
    if (best >= 0) {
      takenPredictions.add(best)
      matched += 1
      onsetErrorSum += bestDelta
    } else {
      missed.push(wanted)
    }
  }
  const spurious = predicted.filter((_, index) => !takenPredictions.has(index))
  const precision = predicted.length ? matched / predicted.length : 0
  const recall = reference.length ? matched / reference.length : 0
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0
  return {
    matched,
    reference: reference.length,
    predicted: predicted.length,
    precision,
    recall,
    f1,
    meanOnsetErrorMs: matched ? onsetErrorSum / matched : null,
    missed,
    spurious,
  }
}

const percent = (value) => `${(value * 100).toFixed(1)}%`
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/**
 * The first import of a dependency Vite has not pre-bundled makes it optimise
 * and reload the page, which destroys the execution context mid-call. That is a
 * dev-server fact, not a failure, so retry through it.
 */
async function evaluateThroughReload(page, fn, arg, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await page.evaluate(fn, arg)
    } catch (error) {
      const reloaded = /Execution context was destroyed|Target closed|navigation/i
        .test(String(error && error.message))
      if (!reloaded || attempt >= attempts) throw error
      await page.waitForLoadState('domcontentloaded')
      await page.waitForTimeout(1500)
    }
  }
}

async function main() {
  const browser = await chromium.launch({ headless: !process.env.HEADED })
  const page = await browser.newPage()
  page.on('console', (message) => {
    if (message.type() === 'error') console.error('  [page]', message.text())
  })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })

  // Pull the engine modules in once so Vite finishes optimising before any
  // measurement starts; a reload in the middle of a run would lose a result.
  await evaluateThroughReload(page, async () => {
    await import('/src/features/microphone/transcriptionEngines.ts')
    await import('/src/features/microphone/transcription.ts')
    await import('/src/features/microphone/audioEnhancement.ts')
  })

  const index = await evaluateThroughReload(page, async () =>
    (await fetch('/fixtures/audio/index.json')).json())
  const takes = process.env.TAKE
    ? index.filter((take) => take.name === process.env.TAKE)
    : index
  if (!takes.length) throw new Error(`no take matched TAKE=${process.env.TAKE}`)

  const totals = new Map(ENGINE_IDS.map((id) => [id, []]))
  for (const take of takes) {
    console.log(`\n${take.name} — ${take.notes.length} notes`)
    for (const engineId of ENGINE_IDS) {
      const outcome = await evaluateThroughReload(page, async ({ engineId, audioUrl, instrument }) => {
        const engines = await import('/src/features/microphone/transcriptionEngines.ts')
        const transcription = await import('/src/features/microphone/transcription.ts')
        const enhancement = await import('/src/features/microphone/audioEnhancement.ts')
        const spec = engines.ENGINES[engineId]
        const blob = await (await fetch(audioUrl)).blob()
        const samples = await transcription.decodeMono(blob, spec.sampleRate)
        const enhanced = enhancement.enhanceAnalysisAudio(samples, spec.sampleRate, null)
        const started = performance.now()
        try {
          const run = await engines.runEngine(spec, {
            audio: enhanced.samples,
            instrument,
            noiseFloorDb: null,
            onsetThreshold: 0.25,
            frameThreshold: 0.25,
            confidenceAdjustment: 0,
          }, () => {})
          return {
            ok: true,
            backend: run.backend,
            wallMs: Math.round(performance.now() - started),
            events: run.events.map((event) => ({
              pitch: event.pitch, tOnMs: event.tOnMs,
            })),
          }
        } catch (error) {
          return { ok: false, message: String(error && error.message || error) }
        }
      }, { engineId, audioUrl: take.audio, instrument: INSTRUMENT })

      if (!outcome.ok) {
        console.log(`  ${engineId.padEnd(14)} FAILED — ${outcome.message}`)
        process.exitCode = 1
        continue
      }
      const result = score(take.notes, outcome.events)
      totals.get(engineId).push(result)
      console.log(
        `  ${engineId.padEnd(14)} F1 ${percent(result.f1).padStart(6)}` +
        `  P ${percent(result.precision).padStart(6)}` +
        `  R ${percent(result.recall).padStart(6)}` +
        `  found ${String(result.matched).padStart(2)}/${result.reference}` +
        `  reported ${String(result.predicted).padStart(3)}` +
        `  onset ±${result.meanOnsetErrorMs === null ? '--' : result.meanOnsetErrorMs.toFixed(0)}ms` +
        `  ${outcome.wallMs}ms on ${outcome.backend}`)
      if (process.env.MISSES) {
        const name = (p) => NAMES[p % 12] + (Math.floor(p / 12) - 1)
        console.log(`      missed:   ${result.missed
          .map((n) => `${name(n.pitch)}@${Math.round(n.onsetMs)}`).join(' ') || '(none)'}`)
        console.log(`      spurious: ${result.spurious
          .map((n) => `${name(n.pitch)}@${Math.round(n.tOnMs)}`).join(' ') || '(none)'}`)
      }
    }
  }

  console.log('\noverall')
  for (const [engineId, results] of totals) {
    if (!results.length) continue
    const matched = results.reduce((sum, r) => sum + r.matched, 0)
    const reference = results.reduce((sum, r) => sum + r.reference, 0)
    const predicted = results.reduce((sum, r) => sum + r.predicted, 0)
    const precision = predicted ? matched / predicted : 0
    const recall = reference ? matched / reference : 0
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0
    console.log(
      `  ${engineId.padEnd(14)} F1 ${percent(f1).padStart(6)}` +
      `  P ${percent(precision).padStart(6)}  R ${percent(recall).padStart(6)}` +
      `  ${matched}/${reference} notes found, ${predicted} reported`)
  }

  await browser.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
