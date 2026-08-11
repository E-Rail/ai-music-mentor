import { afterEach, describe, expect, it, vi } from 'vitest'
import { canTransitionMicrophone, MicrophoneCapture } from './microphoneCapture'

afterEach(() => vi.unstubAllGlobals())

describe('microphone state model', () => {
  it('supports permission recovery and a normal local transcription path', () => {
    expect(canTransitionMicrophone('idle', 'requesting')).toBe(true)
    expect(canTransitionMicrophone('requesting', 'permission-denied')).toBe(true)
    expect(canTransitionMicrophone('permission-denied', 'requesting')).toBe(true)
    expect(canTransitionMicrophone('noise-check', 'ready')).toBe(true)
    expect(canTransitionMicrophone('ready', 'recording')).toBe(true)
    expect(canTransitionMicrophone('recording', 'transcribing')).toBe(true)
    expect(canTransitionMicrophone('transcribing', 'ready')).toBe(true)
  })

  it('does not allow an idle microphone to claim it is recording', () => {
    expect(canTransitionMicrophone('idle', 'recording')).toBe(false)
  })

  it('unlocks Web Audio before waiting for microphone permission and can cancel', async () => {
    const order: string[] = []
    let resolveStream!: (stream: MediaStream) => void
    const permission = new Promise<MediaStream>((resolve) => { resolveStream = resolve })
    const stop = vi.fn()
    class FakeAudioContext {
      state = 'suspended'
      close = vi.fn(async () => undefined)
      resume = vi.fn(async () => { order.push('resume') })
      constructor() { order.push('audio-context') }
    }
    vi.stubGlobal('window', {
      isSecureContext: true,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      requestAnimationFrame: vi.fn(),
      cancelAnimationFrame: vi.fn(),
    })
    vi.stubGlobal('navigator', { mediaDevices: {
      getUserMedia: vi.fn(() => {
        order.push('get-user-media')
        return permission
      }),
    } })
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const capture = new MicrophoneCapture()

    const connection = capture.connect()
    expect(order).toEqual(['audio-context', 'resume', 'get-user-media'])
    capture.cancelConnect()
    resolveStream({
      getTracks: () => [{ stop }],
      getAudioTracks: () => [{ stop }],
    } as unknown as MediaStream)

    await expect(connection).rejects.toMatchObject({ code: 'MIC_CONNECT_CANCELLED' })
    expect(capture.state).toBe('idle')
    expect(stop).toHaveBeenCalled()
  })

  it('explains insecure origins instead of reporting an unknown connection failure', async () => {
    vi.stubGlobal('window', { isSecureContext: false })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } })
    const capture = new MicrophoneCapture()

    await expect(capture.connect()).rejects.toMatchObject({ code: 'MIC_INSECURE_CONTEXT' })
    expect(capture.state).toBe('error')
  })
})
