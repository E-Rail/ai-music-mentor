import { describe, expect, it } from 'vitest'
import { MicrophoneCapture } from './microphoneCapture'

describe('microphone take recovery', () => {
  it('finalizes buffered chunks when the browser already made MediaRecorder inactive', async () => {
    const capture = new MicrophoneCapture() as unknown as {
      chunks: Blob[]
      recorder: { state: string; mimeType: string }
      sessionId: string
      stopRecorder: () => Promise<Blob>
    }
    capture.chunks = [new Blob(['part-one']), new Blob(['part-two'])]
    capture.recorder = { state: 'inactive', mimeType: 'audio/webm' }
    capture.sessionId = 'device-loss-test'

    const take = await capture.stopRecorder()

    expect(take.size).toBeGreaterThan(0)
    expect(take.type).toBe('audio/webm')
  })

  it('shares one stop operation between device loss and an immediate analyze click', async () => {
    let stopCalls = 0
    const recorder = {
      state: 'recording', mimeType: 'audio/webm',
      onstop: null as (() => void) | null,
      onerror: null as ((event: Event) => void) | null,
      stop() {
        stopCalls += 1
        queueMicrotask(() => this.onstop?.())
      },
    }
    const capture = new MicrophoneCapture() as unknown as {
      chunks: Blob[]
      recorder: typeof recorder
      sessionId: string
      stopRecorder: () => Promise<Blob>
    }
    capture.chunks = [new Blob(['captured'])]
    capture.recorder = recorder
    capture.sessionId = 'double-stop-test'

    const fromDisconnect = capture.stopRecorder()
    const fromClick = capture.stopRecorder()
    const [first, second] = await Promise.all([fromDisconnect, fromClick])

    expect(stopCalls).toBe(1)
    expect(first.size).toBe(second.size)
  })
})
