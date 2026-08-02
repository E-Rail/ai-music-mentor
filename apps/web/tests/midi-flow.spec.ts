import { expect, test, type Page } from '@playwright/test'

const SCORE = {
  scoreId: 'test-score', title: '测试练习', composer: '', tempo: 120,
  timeSignature: '4/4', beatsPerMeasure: 4, measureCount: 1,
  parts: ['Piano'], scoreHash: 'fixture-hash',
}

const DETAIL = {
  scoreId: SCORE.scoreId, sourceType: 'musicxml', displayMode: 'exact_notation',
  metadata: SCORE, normalizedMetadata: SCORE,
  scoreEvents: [{ eventId: 'test-score:RH:m1:b0:1', measureNo: 1, onsetBeat: 0,
    durationBeat: 1, pitches: [60], part: 'RH', voice: 1,
    dynamicTarget: null, optional: false }],
  warnings: [], confidence: 1,
  normalization: { tempo: 120, timeSignature: '4/4', quantization: '1/16',
    trackMapping: {}, confirmed: true },
  sourceReferences: [], renderUrl: '/api/v1/scores/test-score/render.musicxml',
  timelineUrl: null,
}

const PRACTICE_SCORE = {
  ...SCORE, scoreId: 'practice-ex-browser', title: 'AI 生成练习谱',
  tempo: 60, scoreHash: 'practice-fixture-hash',
}

const PRACTICE_DETAIL = {
  ...DETAIL,
  scoreId: PRACTICE_SCORE.scoreId,
  metadata: PRACTICE_SCORE,
  normalizedMetadata: PRACTICE_SCORE,
  scoreEvents: DETAIL.scoreEvents.map((event) => ({
    ...event, eventId: `practice-ex-browser:RH:m1:b0:1`,
  })),
  renderUrl: '/api/v1/scores/practice-ex-browser/render.musicxml',
  timelineUrl: '/api/v1/scores/practice-ex-browser/timeline.midi',
  generated: true,
  parentScoreId: SCORE.scoreId,
  rootScoreId: SCORE.scoreId,
  lineageDepth: 1,
}

const PRACTICE2_SCORE = {
  ...PRACTICE_SCORE, scoreId: 'practice-ex-round2', title: 'AI 第二轮练习谱',
  tempo: 54, scoreHash: 'practice-round2-hash',
}

const PRACTICE2_DETAIL = {
  ...PRACTICE_DETAIL,
  scoreId: PRACTICE2_SCORE.scoreId,
  metadata: PRACTICE2_SCORE,
  normalizedMetadata: PRACTICE2_SCORE,
  renderUrl: '/api/v1/scores/practice-ex-round2/render.musicxml',
  timelineUrl: '/api/v1/scores/practice-ex-round2/timeline.midi',
  parentScoreId: PRACTICE_SCORE.scoreId,
  lineageDepth: 2,
}

const MUSICXML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key>
<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
</measure></part></score-partwise>`

const GENERATED_MUSICXML = MUSICXML.replace(
  '<score-partwise version="3.1">',
  '<score-partwise version="3.1"><movement-title>AI 生成练习谱</movement-title>',
).replace('<step>C</step>', '<step>D</step>')

const MIDI = Buffer.from([
  0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06,
  0x00, 0x00, 0x00, 0x01, 0x01, 0xe0,
  0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x14,
  0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
  0x00, 0x90, 0x3c, 0x40,
  0x83, 0x60, 0x80, 0x3c, 0x00,
  0x00, 0xff, 0x2f, 0x00,
])

const REPORT = {
  reportId: 'report-browser', sessionId: 'sess-browser', scoreId: 'test-score',
  metrics: { pitchScore: 92, rhythmScore: 78, fluencyScore: 84, dynamicsScore: 90,
    overallScore: 84, timingMaeMs: 142, avgBpm: 116, matchedCount: 1, expectedCount: 1 },
  errors: [{ id: 'err-browser', type: 'early_late',
    location: { measure: 1, beat: 0, eventId: 'test-score:RH:m1:b0:1' },
    severity: 'medium', evidenceIds: ['ev-browser'], confidence: 0.86,
    detail: '延后 142 ms' }],
  evidences: [{ id: 'ev-browser', fact: '第 1 小节第 1 拍延后 142 ms',
    measureNo: 1, beat: 0, expected: 'C4', actual: 'C4', deltaMs: 142 }],
  patterns: [], hypotheses: [{ cause: '拍点内部不稳定', confidence: 0.7,
    limitation: '没有动作或指法证据' }],
  algorithmVersion: 'browser-test', thresholdProfile: 'browser-test',
  scoreHash: 'fixture-hash', sourceReferences: [],
}

const ROUND_REPORT = {
  ...REPORT,
  reportId: 'report-round', sessionId: 'sess-round', scoreId: PRACTICE_SCORE.scoreId,
  metrics: { ...REPORT.metrics, pitchScore: 88, rhythmScore: 82, overallScore: 85,
    timingMaeMs: 118 },
  errors: [{ ...REPORT.errors[0], id: 'err-round', type: 'wrong_pitch',
    location: { measure: 1, beat: 0,
      eventId: 'practice-ex-browser:RH:m1:b0:1' }, detail: 'D4 被弹成 C4' }],
  evidences: [{ ...REPORT.evidences[0], id: 'ev-round', fact: '当前轮第 1 小节出现错音',
    expected: 'D4', actual: 'C4', deltaMs: null }],
  scoreHash: 'practice-fixture-hash',
}

const mentorResponse = (summary: string, reportId = REPORT.reportId) => ({
  provider: 'fake-ai', model: 'fake-model', promptVersion: 'test',
  responseMode: 'json_schema', latencyMs: 12, fallbackReason: null,
  reportId, summary,
  evidence: [{ measure: 1, beat: 0, fact: '第 1 小节第 1 拍延后 142 ms' }],
  hypotheses: REPORT.hypotheses,
  plan: [{ exerciseType: 'slow_ladder', measures: [1], tempo: 60,
    repetitions: 4, successCriterion: '连续两次稳定在拍点内', label: '慢速节拍循环' }],
  encouragement: '保持慢而准确。',
})

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const input = {
      id: 'mock-usb-1', name: 'Mock USB Piano', state: 'connected',
      type: 'input', onmidimessage: null as ((message: unknown) => void) | null,
      open: async () => undefined, close: async () => undefined,
    }
    const access = { inputs: new Map([[input.id, input]]), onstatechange: null as ((event: unknown) => void) | null }
    Object.defineProperty(navigator, 'requestMIDIAccess', {
      configurable: true, value: async () => access,
    })
    Object.assign(window, {
      __midiNote(note: number, receivedTime: number) {
        input.onmidimessage?.({ data: new Uint8Array([0x90, note, 80]), receivedTime })
      },
      __disconnectMidi() {
        input.state = 'disconnected'
        access.onstatechange?.({ port: input })
      },
    })
  })
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path === '/api/v1/scores' && route.request().method() === 'GET') {
      return route.fulfill({ json: { scores: [{ ...SCORE, builtin: true,
        sourceType: 'musicxml', displayMode: 'exact_notation', warnings: [], confidence: 1 }] } })
    }
    if (path === '/api/v1/scores/test-score' && route.request().method() === 'GET') {
      return route.fulfill({ json: DETAIL })
    }
    if (path === '/api/v1/scores/practice-ex-browser' && route.request().method() === 'GET') {
      return route.fulfill({ json: PRACTICE_DETAIL })
    }
    if (path === '/api/v1/scores/practice-ex-round2' && route.request().method() === 'GET') {
      return route.fulfill({ json: PRACTICE2_DETAIL })
    }
    if (path === '/api/v1/scores/practice-ex-browser/render.musicxml') {
      return route.fulfill({ contentType: 'application/xml', body: GENERATED_MUSICXML })
    }
    if (path === '/api/v1/scores/practice-ex-round2/render.musicxml') {
      return route.fulfill({ contentType: 'application/xml', body: GENERATED_MUSICXML })
    }
    if (path.endsWith('/render.musicxml')) {
      return route.fulfill({ contentType: 'application/xml', body: MUSICXML })
    }
    if (path.endsWith('/exercises/ex-browser/musicxml')) {
      return route.fulfill({ contentType: 'application/xml', body: GENERATED_MUSICXML })
    }
    if (path.endsWith('/exercises/ex-round2/musicxml')) {
      return route.fulfill({ contentType: 'application/xml', body: GENERATED_MUSICXML })
    }
    if (path === '/api/v1/exercises/ex-browser' && route.request().method() === 'GET') {
      return route.fulfill({ json: {
        exerciseId: 'ex-browser', sourceScoreId: 'test-score',
        practiceScoreId: 'practice-ex-browser', lineageDepth: 1, ruleId: 'slow_ladder',
        sourceMeasures: [1], tempoPlan: [60, 65, 70, 120],
        successCriterion: '连续两次稳定在拍点内',
        musicXmlUrl: '/api/v1/exercises/ex-browser/musicxml',
        midiUrl: '/api/v1/exercises/ex-browser/midi',
      } })
    }
    if (path.endsWith('/midi')) {
      return route.fulfill({ contentType: 'audio/midi', body: MIDI })
    }
    if (path === '/api/v1/sessions' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { scoreId?: string }
      const sessionId = body.scoreId === PRACTICE_SCORE.scoreId ? 'sess-round' : 'sess-browser'
      return route.fulfill({ status: 201, json: { sessionId, countIn: { beats: 1, bpm: 240 } } })
    }
    if (path.endsWith('/event-batches')) {
      return route.fulfill({ json: { batchId: 'mock', accepted: true, storedEventCount: 1 } })
    }
    if (path.endsWith('/device-lost')) {
      return route.fulfill({ json: { sessionId: 'sess-browser', status: 'device_lost' } })
    }
    if (path.endsWith('/finish')) {
      const round = path.includes('/sess-round/')
      return route.fulfill({ status: 202, json: {
        analysisJobId: round ? 'job-round' : 'job-browser',
        reportId: round ? ROUND_REPORT.reportId : REPORT.reportId,
      } })
    }
    if (path === `/api/v1/reports/${REPORT.reportId}`) {
      return route.fulfill({ json: REPORT })
    }
    if (path === `/api/v1/reports/${ROUND_REPORT.reportId}`) {
      return route.fulfill({ json: ROUND_REPORT })
    }
    if (path === '/api/v1/mentor/responses') {
      const body = route.request().postDataJSON() as { question?: string; history?: unknown[] }
      const summary = body.question
        ? (body.history?.length
            ? '我记得上一轮建议；这次把慢速循环缩短为两组。'
            : `回答：${body.question}`)
        : '先处理第 1 小节的拍点延后。'
      const reportId = (route.request().postDataJSON() as { reportId?: string }).reportId
      return route.fulfill({ json: mentorResponse(
        reportId === ROUND_REPORT.reportId && !body.question
          ? '根据当前轮错音证据，下一首应缩短并降低速度。'
          : summary,
        reportId,
      ) })
    }
    if (path === '/api/v1/exercises') {
      const body = route.request().postDataJSON() as { generationNote?: string; reportId?: string }
      if (body.reportId === ROUND_REPORT.reportId) {
        return route.fulfill({ status: 201, json: {
          exerciseId: 'ex-round2', sourceScoreId: PRACTICE_SCORE.scoreId,
          practiceScoreId: PRACTICE2_SCORE.scoreId, lineageDepth: 2,
          ruleId: 'loop', sourceMeasures: [1], tempoPlan: [],
          successCriterion: '连续两次准确弹出 D4',
          musicXmlUrl: '/api/v1/exercises/ex-round2/musicxml',
          midiUrl: '/api/v1/exercises/ex-round2/midi',
          plannerProvider: 'fake-ai', plannerModel: 'fake-model', plannerLatencyMs: 10,
          plannerFallbackReason: null,
          aiPlan: { title: '基于当前轮错音的第二首练习', strategy: 'loop',
            errorIds: ['err-round'], tempoRatio: 0.45, loopCount: 3, hands: null,
            rationale: '只依据当前轮的 D4 错音生成。',
            noteAcknowledgement: '已沿用当前轮要求。' },
        } })
      }
      return route.fulfill({ status: 201, json: {
        exerciseId: 'ex-browser', sourceScoreId: 'test-score',
        practiceScoreId: 'practice-ex-browser', lineageDepth: 1,
        ruleId: 'slow_ladder', sourceMeasures: [1],
        tempoPlan: [60, 65, 70, 120], successCriterion: '连续两次稳定在拍点内',
        musicXmlUrl: '/api/v1/exercises/ex-browser/musicxml',
        midiUrl: '/api/v1/exercises/ex-browser/midi',
        plannerProvider: 'fake-ai', plannerModel: 'fake-model', plannerLatencyMs: 12,
        plannerFallbackReason: null,
        aiPlan: { title: '五分钟慢速节拍练习', strategy: 'slow_ladder',
          errorIds: ['err-browser'], tempoRatio: 0.5, loopCount: 3, hands: null,
          rationale: '先降低速度稳定拍点，再逐级提速。',
          noteAcknowledgement: `已采用要求：${body.generationNote}` },
      } })
    }
    if (path === '/api/v1/accompaniments' && route.request().method() === 'POST') {
      return route.fulfill({ status: 201, json: {
        accompanimentId: 'acc-browser', baseTempo: 120,
        midiUrl: '/api/v1/accompaniments/acc-browser/midi',
        harmonyEvents: [{ measure: 1, pitches: [48, 60, 64] }],
        beatsPerMeasure: 4,
      } })
    }
    if (path === '/api/v1/comparisons' && route.request().method() === 'GET') {
      return route.fulfill({ json: {
        baselineId: REPORT.reportId, retryId: ROUND_REPORT.reportId,
        baselineScoreId: SCORE.scoreId, retryScoreId: PRACTICE_SCORE.scoreId,
        targetChanged: true,
        metricDelta: { overallScore: 1, pitchScore: -4, rhythmScore: 4,
          fluencyScore: 0, timingMaeMs: -24, avgBpm: 0 },
        resolvedErrors: ['type:early_late'], persistentErrors: [],
        newErrors: ['type:wrong_pitch'],
        suggestion: '本轮仍有 1 个问题，将依据当前轮继续调整。',
      } })
    }
    return route.fulfill({ status: 404, json: { detail: { code: 'MOCK_NOT_FOUND', message: path } } })
  })
})

async function enterRecording(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /测试练习/ }).click()
  await page.getByRole('button', { name: /下一步：设备检查/ }).click()
  await page.getByRole('button', { name: /Mock USB Piano/ }).click()
  await page.evaluate(() => {
    const send = (window as unknown as { __midiNote: (note: number, time: number) => void }).__midiNote
    ;[60, 62, 64, 65, 67].forEach((note, index) => send(note, 1000 + index * 500))
  })
  await page.getByRole('button', { name: /播放预备拍并开始/ }).click()
  await expect(page.getByText('正在录制。实时跟谱只驱动光标，最终评分会在停止后复算。')).toBeVisible()
}

test('mocked USB MIDI health check and disconnect recovery', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: '工作区' })).toBeVisible()
  await page.getByRole('button', { name: /测试练习/ }).click()
  await page.getByRole('button', { name: /下一步：设备检查/ }).click()
  await page.getByRole('button', { name: /Mock USB Piano/ }).click()

  await page.evaluate(() => {
    const send = (window as unknown as { __midiNote: (note: number, time: number) => void }).__midiNote
    ;[60, 62, 64, 65, 67].forEach((note, index) => send(note, 1000 + index * 500))
  })
  await expect(page.getByText(/中央 C 后四拍 4\/4/)).toBeVisible()
  await expect(page.getByText(/疑似重复消息/)).toContainText('0')

  await page.getByRole('button', { name: /播放预备拍并开始/ }).click()
  await expect(page.getByText('正在录制。实时跟谱只驱动光标，最终评分会在停止后复算。')).toBeVisible()
  await page.evaluate(() => {
    (window as unknown as { __disconnectMidi: () => void }).__disconnectMidi()
  })
  await expect(page.getByText(/MIDI 输入已断开，光标已冻结/)).toBeVisible()
  await expect(page.getByRole('button', { name: '提交当前录音' })).toBeVisible()
  await expect(page.getByRole('button', { name: '丢弃本次录音' })).toBeVisible()
})

test('AI chat keeps context and exercise generation loops back to design', async ({ page }) => {
  await enterRecording(page)
  await page.evaluate(() => {
    (window as unknown as { __midiNote: (note: number, time: number) => void }).__midiNote(60, 4000)
  })
  await page.getByRole('button', { name: /停止并分析/ }).click()

  await expect(page.getByRole('heading', { name: '诊断报告' })).toBeVisible()
  await expect(page.getByText('先处理第 1 小节的拍点延后。')).toBeVisible()
  await page.getByRole('button', { name: '根据证据，我现在应该先怎么练？' }).click()
  await expect(page.getByText(/回答：根据证据/)).toBeVisible()

  const composer = page.getByPlaceholder(/向 AI 导师追问/)
  await composer.fill('那下一组呢？')
  await page.getByRole('button', { name: '追问' }).click()
  await expect(page.getByText(/我记得上一轮建议/)).toBeVisible()

  await page.getByRole('button', { name: '生成练习 →', exact: true }).click()
  await expect(page.getByRole('heading', { name: '告诉 AI 你想怎么练' })).toBeVisible()
  await page.getByPlaceholder(/我左手比较弱/).fill('只练左手，控制在 5 分钟。')
  await page.getByRole('button', { name: /让 AI 设计并生成/ }).click()

  await expect(page.getByRole('heading', { name: '练习已经生成' })).toBeVisible()
  await expect(page.getByText('五分钟慢速节拍练习')).toBeVisible()
  await expect(page.getByText(/只练左手，控制在 5 分钟/)).toBeVisible()
  await page.getByRole('button', { name: /返回修改要求/ }).click()
  await expect(page.getByRole('heading', { name: '告诉 AI 你想怎么练' })).toBeVisible()
  await expect(page.getByPlaceholder(/我左手比较弱/)).toHaveValue('只练左手，控制在 5 分钟。')

  await page.getByRole('button', { name: /让 AI 设计并生成/ }).click()
  await expect(page.getByRole('heading', { name: '练习已经生成' })).toBeVisible()
  await page.getByRole('button', { name: /进入合奏验证/ }).click()
  const generatedRetrySession = page.waitForRequest((request) =>
    request.url().endsWith('/api/v1/sessions') &&
    request.method() === 'POST' &&
    request.postDataJSON().scoreId === 'practice-ex-browser')
  const generatedRetryScore = page.waitForRequest((request) =>
    request.url().endsWith('/api/v1/scores/practice-ex-browser/render.musicxml'))
  await page.getByRole('button', { name: '启动伴奏并演奏' }).click()
  await Promise.all([generatedRetrySession, generatedRetryScore])
  await expect(page.getByText('本轮演奏目标 · AI 生成练习')).toBeVisible()
  await expect(page.locator('.retry-stage .score-viewer')).toContainText('AI 生成练习谱')

  await page.evaluate(() => {
    (window as unknown as { __midiNote: (note: number, time: number) => void }).__midiNote(60, 9000)
  })
  await page.getByRole('button', { name: '停止并对比' }).click()
  await expect(page.getByText('根据当前轮错音证据，下一首应缩短并降低速度。')).toBeVisible()
  await expect(page.getByRole('heading', {
    name: '仍有 1 个问题，继续让 AI 调整',
  })).toBeVisible()

  await page.getByRole('button', { name: /基于本轮生成下一首/ }).first().click()
  await expect(page.getByRole('heading', { name: '告诉 AI 你想怎么练' })).toBeVisible()
  const nextRoundRequest = page.waitForRequest((request) =>
    request.url().endsWith('/api/v1/exercises') &&
    request.postDataJSON().reportId === ROUND_REPORT.reportId)
  await page.getByRole('button', { name: /让 AI 设计并生成/ }).click()
  await nextRoundRequest
  await expect(page.getByText('基于当前轮错音的第二首练习')).toBeVisible()
})
