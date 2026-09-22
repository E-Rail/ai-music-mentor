import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transcribeAudio } from './transcription'
import { runEngine } from './transcriptionEngines'

vi.mock('./transcriptionEngines', async importOriginal => ({
  ...await importOriginal<typeof import('./transcriptionEngines')>(),
  runEngine: vi.fn(),
}))

beforeEach(() => {
  vi.stubGlobal('AudioContext', class {
    decodeAudioData = async () => ({ duration: 3 })
    close = async () => {}
  })
  vi.stubGlobal('OfflineAudioContext', class {
    constructor(_channels: number, private length: number) {}
    destination = {}
    createBufferSource = () => ({ buffer: null, connect() {}, start() {} })
    startRendering = async () => ({ getChannelData: () => new Float32Array(this.length) })
  })
  vi.mocked(runEngine).mockImplementation(async (_spec, request) => {
    // Reproduce the actual Worker.postMessage transfer, which detaches audio.
    structuredClone(request.audio, { transfer: [request.audio.buffer] })
    return { events: [], backend: 'test', latencyMs: 1, rejectedCount: 0, meanConfidence: 0 }
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks() })

describe('microphone transcription orchestration', () => {
  it('rejects an already-cancelled take before decoding or loading the model', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(transcribeAudio(new Blob(), 'piano', null, () => {}, controller.signal))
      .rejects.toMatchObject({ code: 'TRANSCRIPTION_CANCELLED' })
    expect(runEngine).not.toHaveBeenCalled()
  })

  it('preserves duration after transferring samples and does not rerun a sparse take', async () => {
    const result = await transcribeAudio(new Blob(), 'piano', null, () => {})
    expect(result.captureMeta.audioDurationSeconds).toBe(3)
    expect(runEngine).toHaveBeenCalledTimes(1)
  })

  it('does not retry a failed fast engine indefinitely', async () => {
    vi.mocked(runEngine).mockRejectedValueOnce(new Error('GPU unavailable'))
    await expect(transcribeAudio(new Blob(), 'piano', null, () => {}))
      .rejects.toThrow('GPU unavailable')
    expect(runEngine).toHaveBeenCalledTimes(1)
  })

  it('propagates cancellation during inference without invoking a fallback', async () => {
    vi.mocked(runEngine).mockRejectedValueOnce(Object.assign(new Error('cancelled'), {
      code: 'TRANSCRIPTION_CANCELLED',
    }))
    await expect(transcribeAudio(new Blob(), 'piano', null, () => {}))
      .rejects.toMatchObject({ code: 'TRANSCRIPTION_CANCELLED' })
    expect(runEngine).toHaveBeenCalledTimes(1)
  })
})
