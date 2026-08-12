import { beforeAll, describe, expect, it, vi } from 'vitest'
import { confidenceFromVelocity } from './engineProtocol'
import { AUDIO_PROFILES, profileForNoise } from './profiles'
import {
  ENGINES, engineFor, fallbackFor, runEngine, type EngineSpec,
} from './transcriptionEngines'

beforeAll(() => {
  // The runner uses window.setTimeout, which exists in a browser and in a
  // worker but not in the bare Node environment vitest runs in.
  ;(globalThis as unknown as { window?: unknown }).window ??= globalThis
})

/** A worker that answers on command, so the plumbing is testable without a model. */
function fakeWorker() {
  const worker = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onerror: null as ((event: { message: string }) => void) | null,
    posted: [] as unknown[],
    transfers: [] as unknown[],
    terminated: 0,
    postMessage(message: unknown, transfer?: unknown[]) {
      this.posted.push(message)
      if (transfer) this.transfers.push(...transfer)
    },
    terminate() { this.terminated += 1 },
    send(data: unknown) { this.onmessage?.({ data }) },
  }
  return worker
}

function specFor(worker: ReturnType<typeof fakeWorker>, stallTimeoutMs = 50): EngineSpec {
  return {
    id: 'basic-pitch',
    version: 'test',
    sampleRate: 22_050,
    stallTimeoutMs,
    create: () => worker as unknown as Worker,
  }
}

const request = () => ({
  audio: new Float32Array(8),
  instrument: 'piano' as const,
  noiseFloorDb: null,
  onsetThreshold: 0.25,
  frameThreshold: 0.25,
  confidenceAdjustment: 0,
})

describe('which engine hears a take', () => {
  it('sends piano to the piano model and everything else to the generalist', () => {
    expect(engineFor('piano')).toBe('onsets-frames')
    expect(engineFor('guitar')).toBe('basic-pitch')
    expect(engineFor('violin')).toBe('basic-pitch')
  })

  it('falls back off the specialist, and nowhere from the generalist', () => {
    expect(fallbackFor('onsets-frames')).toBe('basic-pitch')
    expect(fallbackFor('basic-pitch')).toBeNull()
  })

  it('decodes each engine at the rate its model was trained on', () => {
    expect(ENGINES['onsets-frames'].sampleRate).toBe(16_000)
    expect(ENGINES['basic-pitch'].sampleRate).toBe(22_050)
  })

  it('gives the piano model room to run, since it cannot report progress', () => {
    expect(ENGINES['onsets-frames'].stallTimeoutMs)
      .toBeGreaterThan(ENGINES['basic-pitch'].stallTimeoutMs)
  })
})

describe('a note the model committed to', () => {
  it('survives the piano floor however softly it was played', () => {
    const floor = AUDIO_PROFILES.piano.minConfidence
    expect(confidenceFromVelocity(1)).toBeGreaterThan(floor)
    expect(confidenceFromVelocity(127)).toBeGreaterThan(floor)
  })

  it('still ranks louder notes above quieter ones', () => {
    expect(confidenceFromVelocity(100)).toBeGreaterThan(confidenceFromVelocity(30))
  })

  it('leaves the noisy-room penalty something to bite on', () => {
    // A loud strike outranks the strictest floor a noisy room can impose; a
    // whisper does not. Without that the penalty would be inert.
    const strict = profileForNoise('piano', -20).minConfidence
    expect(confidenceFromVelocity(127)).toBeGreaterThan(strict)
    expect(confidenceFromVelocity(1)).toBeLessThan(strict)
  })
})

describe('running an engine', () => {
  it('transfers the audio rather than copying it', async () => {
    const worker = fakeWorker()
    const payload = request()
    const running = runEngine(specFor(worker), payload, () => {})
    worker.send({
      type: 'complete', events: [], rejectedCount: 0, meanConfidence: 0,
      latencyMs: 5, backend: 'cpu',
    })
    await running
    expect(worker.transfers).toEqual([payload.audio.buffer])
  })

  it('gives up when an engine goes quiet, and keeps the take recoverable', async () => {
    vi.useFakeTimers()
    try {
      const worker = fakeWorker()
      const running = runEngine(specFor(worker, 50), request(), () => {})
      const settled = expect(running).rejects.toMatchObject({
        code: 'TRANSCRIPTION_STALLED',
      })
      await vi.advanceTimersByTimeAsync(60)
      await settled
      expect(worker.terminated).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not give up on an engine that is still reporting progress', async () => {
    vi.useFakeTimers()
    try {
      const worker = fakeWorker()
      const seen: number[] = []
      const running = runEngine(specFor(worker, 50), request(), (p) => seen.push(p))
      for (let step = 0; step < 4; step += 1) {
        await vi.advanceTimersByTimeAsync(40)
        worker.send({ type: 'progress', progress: 0.2 * step, backend: 'webgl' })
      }
      worker.send({
        type: 'complete', events: [], rejectedCount: 2, meanConfidence: 0.7,
        latencyMs: 9, backend: 'webgl',
      })
      await expect(running).resolves.toMatchObject({ backend: 'webgl', rejectedCount: 2 })
      expect(seen).toHaveLength(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a worker that never started instead of hanging', async () => {
    const worker = fakeWorker()
    const running = runEngine(specFor(worker, 5_000), request(), () => {})
    worker.onerror?.({ message: 'boom' })
    await expect(running).rejects.toThrow('boom')
  })

  it('stops listening once a take is abandoned', async () => {
    const controller = new AbortController()
    const worker = fakeWorker()
    const running = runEngine(specFor(worker, 5_000), request(), () => {}, controller.signal)
    controller.abort()
    await expect(running).rejects.toMatchObject({ code: 'TRANSCRIPTION_CANCELLED' })
    expect(worker.terminated).toBe(1)
  })
})
