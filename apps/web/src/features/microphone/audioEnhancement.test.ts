import { describe, expect, it } from 'vitest'
import { enhanceAnalysisAudio, enhancePreviewFrame } from './audioEnhancement'
import { estimatePitch } from './microphoneCapture'

function sine(frequency: number, seconds: number, amplitude: number,
  sampleRate = 22_050): Float32Array {
  return Float32Array.from({ length: Math.round(seconds * sampleRate) }, (_, index) =>
    Math.sin(2 * Math.PI * frequency * index / sampleRate) * amplitude)
}

describe('low-volume microphone enhancement', () => {
  it('recovers a quiet clean instrument signal for local transcription', () => {
    const quietA = sine(440, 1, 0.003)
    const result = enhanceAnalysisAudio(quietA, 22_050, -70)

    expect(result.metrics.lowVolumeRecovered).toBe(true)
    expect(result.metrics.inputGainDb).toBeGreaterThanOrEqual(12)
    expect(result.metrics.signalToNoiseDb).toBeGreaterThan(10)
    expect(result.metrics.normalizedPeakDb).toBeGreaterThan(result.metrics.rawPeakDb)
    expect(Math.max(...result.samples.map(Math.abs))).toBeLessThanOrEqual(0.98)
  })

  it('does not turn a sub-noise-floor frame into a fake live note', () => {
    const roomNoise = Float32Array.from({ length: 2_048 }, (_, index) =>
      Math.sin(index * 1.91) * 0.0005)
    const preview = enhancePreviewFrame(roomNoise, -66, -63, 0)

    expect(preview.signalPresent).toBe(false)
    expect(preview.gainDb).toBe(0)
  })

  it('lets the live pitch preview hear a quiet A4 after bounded gain', () => {
    const quietA = sine(440, 2_048 / 48_000, 0.004, 48_000)
    const preview = enhancePreviewFrame(quietA, -51, -66, 24)
    const pitch = estimatePitch(preview.samples, 48_000)

    expect(preview.signalPresent).toBe(true)
    expect(pitch).not.toBeNull()
    expect(pitch!).toBeCloseTo(440, -1)
  })
})
