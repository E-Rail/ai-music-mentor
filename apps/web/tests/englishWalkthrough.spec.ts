import { expect, test, type Page } from '@playwright/test'

/**
 * Every screen of the practice loop, in English, with no Chinese on it.
 *
 * English mode once kept Chinese stage titles, microphone states, quick
 * questions and punctuation, because each was frozen or hardcoded somewhere
 * the unit tests did not look. This walks the whole loop — piece, input, play,
 * review, design, exercise, play along, compare — in Standard and in Pro, and
 * reads what is actually on the screen at each step.
 *
 * The server is stood in for with English answers, as the real one gives when
 * the browser asks in English (tests/api/test_language.py holds that side).
 */

const CJK = /[　-〿㐀-鿿＀-￯]/

const SCORE = {
  scoreId: 'walk-score', title: 'Walkthrough Étude', composer: '', tempo: 120,
  timeSignature: '4/4', beatsPerMeasure: 4, measureCount: 1,
  parts: ['RH'], scoreHash: 'walk-hash',
}
const DETAIL = {
  scoreId: SCORE.scoreId, sourceType: 'musicxml', displayMode: 'exact_notation',
  metadata: SCORE, normalizedMetadata: SCORE,
  scoreEvents: [60, 62, 64, 65].map((pitch, index) => ({
    eventId: `walk-score:RH:m1:b${index}:1`, measureNo: 1, onsetBeat: index,
    durationBeat: 1, pitches: [pitch], part: 'RH', voice: 1,
    dynamicTarget: null, optional: false,
  })),
  warnings: [], confidence: 1,
  normalization: { tempo: 120, timeSignature: '4/4', quantization: '1/16',
    trackMapping: {}, confirmed: true },
  sourceReferences: [], libraryCategory: 'demo',
  renderUrl: '/api/v1/scores/walk-score/render.musicxml', timelineUrl: null,
}
const PRACTICE = {
  ...DETAIL, scoreId: 'walk-practice', generated: true, lineageDepth: 1,
  libraryCategory: 'generated', parentScoreId: 'walk-score', rootScoreId: 'walk-score',
  metadata: { ...SCORE, scoreId: 'walk-practice', title: 'Motif study' },
  normalizedMetadata: { ...SCORE, scoreId: 'walk-practice', title: 'Motif study' },
  renderUrl: '/api/v1/scores/walk-practice/render.musicxml',
}
const MUSICXML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key>
<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
</measure></part></score-partwise>`
const MIDI = Buffer.from([
  0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x01, 0xe0,
  0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x14, 0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
  0x00, 0x90, 0x3c, 0x40, 0x83, 0x60, 0x80, 0x3c, 0x00, 0x00, 0xff, 0x2f, 0x00,
])
const report = (reportId: string, scoreId: string) => ({
  reportId, sessionId: `sess-${reportId}`, scoreId,
  metrics: { pitchScore: 92, rhythmScore: 78, fluencyScore: 84, dynamicsScore: 90,
    overallScore: 84, timingMaeMs: 142, avgBpm: 116, matchedCount: 1, expectedCount: 1 },
  errors: [{ id: 'err-walk', type: 'wrong_pitch',
    location: { measure: 1, beat: 0, eventId: 'walk-score:RH:m1:b0:1', eventIds: ['walk-score:RH:m1:b0:1'] },
    severity: 'medium', evidenceIds: ['ev-walk'], confidence: 0.86, detail: '' }],
  evidences: [{ id: 'ev-walk', fact: 'Expected C4, played C#4 (bar 1, beat 1)',
    measureNo: 1, beat: 0, expected: 'C4', actual: 'C#4',
    expectedPitches: [60], actualPitches: [61], deltaMs: null }],
  patterns: [{ id: 'pat-walk', description: 'Wrong notes cluster together (2 times, bars 1–1)',
    coveredErrorIds: ['err-walk'], sampleCount: 2 }],
  hypotheses: [{ cause: 'Possibly shifts prepared too late', confidence: 0.65,
    limitation: "MIDI alone can't confirm fingering" }],
  warnings: ['Some notes were heard with low confidence. Check these findings against the score.'],
  notes: ['Matched with a mistake-tolerant alignment.'],
  // A written slowing in the middle, so the stepped target and its shading draw.
  tempoCurve: [{ beat: 0, measure: 1, bpm: 118, targetBpm: 120, shape: 'steady' },
    { beat: 1, measure: 1, bpm: 121, targetBpm: 120, shape: 'slowing' },
    { beat: 2, measure: 1, bpm: 106, targetBpm: 100, shape: 'steady' },
    { beat: 3, measure: 1, bpm: 99, targetBpm: 100, shape: 'steady' }],
  targetBpm: 120,
  // Every Pro section that reads the profile has something to say.
  performance: {
    hands: [
      { hand: 'RH', expected: 12, correct: 11, timingMaeMs: 24, timingBiasMs: -3, medianVelocity: 82 },
      { hand: 'LH', expected: 6, correct: 6, timingMaeMs: 61, timingBiasMs: 55, medianVelocity: 88 },
    ],
    handLagMs: 58, handLagSamples: 6, velocityRange: [60, 80, 92], handBalance: -6,
    staccatoChecked: 4, staccatoMet: 3, legatoChecked: 5, legatoMet: 2,
    accentsChecked: 2, accentsMet: 1, hairpinsChecked: 1, hairpinsMet: 0,
    pedalledReleases: 3, hesitations: 1, restarts: 1,
  },
  inputQuality: { source: 'midi-upload', instrument: 'piano', status: 'high', confidence: 0.9,
    acceptedNoteCount: 4, rejectedNoteCount: 0, noiseFloorDb: null,
    transcriptionEngine: '', transcriptionVersion: '' },
  algorithmVersion: 'walk', thresholdProfile: 'walk', scoreHash: 'walk-hash', sourceReferences: [],
})
const mentor = (reportId: string) => ({
  provider: 'fake-ai', model: 'fake', promptVersion: 'test', responseMode: 'json_schema',
  latencyMs: 5, fallbackReason: null, reportId,
  summary: 'Start with the wrong note in bar 1.',
  evidence: [{ measure: 1, beat: 0, fact: 'Expected C4, played C#4 (bar 1, beat 1)' }],
  hypotheses: [{ cause: 'Possibly shifts prepared too late', confidence: 0.65,
    limitation: "MIDI alone can't confirm fingering" }],
  plan: [{ exerciseType: 'chunk_connect', measures: [1], tempo: 60, repetitions: 4,
    successCriterion: 'Twice in a row: pitch score ≥ 95', label: 'Join the phrases · bars 1–1' }],
  encouragement: 'Keep going!',
})

async function standInServer(page: Page) {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    expect(await request.headerValue('accept-language')).toBe('en-US')
    if (path === '/api/v1/scores' && method === 'GET') {
      return route.fulfill({ json: { scores: [{ ...SCORE, builtin: true, libraryCategory: 'demo',
        sourceType: 'musicxml', displayMode: 'exact_notation', warnings: [], confidence: 1 }] } })
    }
    if (path === '/api/v1/scores/walk-score') return route.fulfill({ json: DETAIL })
    if (path === '/api/v1/scores/walk-practice') return route.fulfill({ json: PRACTICE })
    if (path.endsWith('.musicxml') || path.endsWith('/musicxml')) {
      return route.fulfill({ contentType: 'application/xml', body: MUSICXML })
    }
    if (path.endsWith('/midi')) return route.fulfill({ contentType: 'audio/midi', body: MIDI })
    if (path === '/api/v1/sessions' && method === 'POST') {
      const body = request.postDataJSON() as { scoreId: string }
      return route.fulfill({ status: 201, json: {
        sessionId: body.scoreId === 'walk-practice' ? 'sess-retry' : 'sess-walk',
        countIn: { beats: 1, bpm: 240 } } })
    }
    if (path.endsWith('/upload-midi')) return route.fulfill({ json: { uploadedMidiRef: 'upload-walk' } })
    if (path.endsWith('/finish')) {
      const retry = path.includes('sess-retry')
      return route.fulfill({ status: 202, json: {
        analysisJobId: 'job', reportId: retry ? 'rep-retry' : 'rep-walk' } })
    }
    if (path === '/api/v1/reports/rep-walk') return route.fulfill({ json: report('rep-walk', 'walk-score') })
    if (path === '/api/v1/reports/rep-retry') return route.fulfill({ json: report('rep-retry', 'walk-practice') })
    if (path === '/api/v1/mentor/responses') {
      return route.fulfill({ json: mentor((request.postDataJSON() as { reportId: string }).reportId) })
    }
    if (path === '/api/v1/mentor/memory') {
      return route.fulfill({ json: { enabled: true, scopeId: 'score:walk-score', rememberedTurnCount: 0 } })
    }
    if (path === '/api/v1/exercises' && method === 'POST') {
      return route.fulfill({ status: 201, json: {
        exerciseId: 'ex-walk', sourceScoreId: 'walk-score', practiceScoreId: 'walk-practice',
        lineageDepth: 1, ruleId: 'chunk_connect', sourceMeasures: [1], tempoPlan: [60, 90, 120],
        cadencePlan: ['half', 'deceptive', 'plagal', 'authentic'],
        successCriterion: 'Twice in a row: pitch score ≥ 95 and timing MAE ≤ 120 ms',
        musicXmlUrl: '/api/v1/exercises/ex-walk/musicxml', midiUrl: '/api/v1/exercises/ex-walk/midi',
        plannerProvider: 'fake-ai', plannerModel: 'fake', plannerLatencyMs: 5, plannerFallbackReason: null,
        aiPlan: { title: 'Developing the motif in bar 1', strategy: 'chunk_connect', errorIds: ['err-walk'],
          tempoRatio: 0.6, loopCount: 4, hands: null,
          rationale: 'To work on the wrong note in bar 1, this joins the phrase slowly.',
          noteAcknowledgement: '' },
      } })
    }
    if (path === '/api/v1/accompaniments') {
      return route.fulfill({ status: 201, json: { accompanimentId: 'acc', baseTempo: 120,
        midiUrl: '/api/v1/accompaniments/acc/midi', harmonyEvents: [], beatsPerMeasure: 4 } })
    }
    if (path === '/api/v1/comparisons') {
      return route.fulfill({ json: {
        baselineId: 'rep-walk', retryId: 'rep-retry', baselineScoreId: 'walk-score',
        retryScoreId: 'walk-practice', targetChanged: true,
        metricDelta: { overallScore: 0, pitchScore: 0, rhythmScore: 0, fluencyScore: 0,
          dynamicsScore: 0, timingMaeMs: 0, avgBpm: 0 },
        resolvedErrors: [], persistentErrors: [], newErrors: [],
        suggestion: 'The generated piece still shows 1 problem this round.',
      } })
    }
    return route.fulfill({ status: 404, json: { detail: { code: 'NOT_MOCKED', message: path } } })
  })
}

async function expectNoChinese(page: Page, where: string) {
  const text = await page.locator('body').innerText()
  const lines = text.split('\n').filter((line) => CJK.test(line))
  expect(lines, `Chinese on the ${where} screen`).toEqual([])
}

for (const depth of ['standard', 'pro'] as const) {
  test.describe(`the whole loop in English, ${depth}`, () => {
    test.use({ locale: 'en-US' })

    test('never shows a Chinese character or mark', async ({ page }) => {
      await page.addInitScript((mode) => {
        localStorage.setItem('studio.depth', mode)
      }, depth)
      await standInServer(page)
      await page.goto('/')

      await page.getByRole('button', { name: /Walkthrough Étude/ }).click()
      await expect(page.locator('.stage-score .score-viewer')).toContainText('Walkthrough Étude')
      await expectNoChinese(page, 'piece')

      await page.getByRole('button', { name: /Next: check the input/ }).click()
      await page.getByRole('button', { name: /Upload MIDI/ }).click()
      await expectNoChinese(page, 'input')

      await page.getByRole('button', { name: /Go to MIDI upload/ }).click()
      await page.locator('input[type=file]').first().setInputFiles({
        name: 'take.mid', mimeType: 'audio/midi', buffer: MIDI })
      await expect(page.getByText('Performance file ready')).toBeVisible()
      await expectNoChinese(page, 'play')

      await page.getByRole('button', { name: /Submit for analysis/ }).click()
      await expect(page.getByText('Start with the wrong note in bar 1.')).toBeVisible()
      await page.getByRole('button', { name: /Wrong note/ }).first().click()
      await expect(page.getByRole('button', { name: 'Hear what was written' })).toBeVisible()
      if (depth === 'pro') {
        await expect(page.getByRole('heading', { name: 'The tempo you kept' })).toBeVisible()
        await expect(page.getByRole('heading', { name: 'How this take was measured' })).toBeVisible()
        for (const heading of ['Hands separately', 'Dynamics', 'Articulation']) {
          await expect(page.getByRole('heading', { name: heading })).toBeVisible()
        }
        await expect(page.getByText(/the left lands 58 ms after the right/)).toBeVisible()
        await expect(page.getByText('stops × 1, restarts × 1')).toBeVisible()
      } else {
        await expect(page.getByRole('heading', { name: 'The tempo you kept' })).toHaveCount(0)
      }
      await expectNoChinese(page, 'review')

      await page.getByRole('button', { name: /Build an exercise/ }).click()
      await expectNoChinese(page, 'design')
      await page.getByRole('button', { name: /Let the AI design and build it/ }).click()
      await expect(page.getByRole('heading', { name: 'Developing the motif in bar 1' })).toBeVisible()
      await expectNoChinese(page, 'exercise')

      await page.getByRole('button', { name: /Play it with accompaniment/ }).click()
      await page.getByRole('button', { name: /Start the accompaniment and play/ }).click()
      await page.locator('input[type=file]').last().setInputFiles({
        name: 'retry.mid', mimeType: 'audio/midi', buffer: MIDI })
      await expectNoChinese(page, 'play along')
      await page.getByRole('button', { name: /Stop and compare/ }).click()
      await expect(page.getByText('The generated piece still shows 1 problem this round.')).toBeVisible()
      await expectNoChinese(page, 'compare')
    })
  })
}
