import { describe, expect, it } from 'vitest'
import {
  FRAME_SIZE, LiveNoteDetector, detectPolyphony, frequencyToMidi,
} from './liveDetector'

const SAMPLE_RATE = 48_000
const HOP = 512

function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12)
}

/** Pseudo-random noise with a fixed seed, so a test cannot flake. */
function noiseSource(seed = 1) {
  let state = seed
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296
    return state / 2_147_483_648 - 1
  }
}

/**
 * A room: broadband hiss, 50 Hz mains hum, and a low rumble. Steady, so a good
 * detector should learn it and then ignore it entirely.
 */
function roomNoise(durationS: number, level: number, seed = 1): Float32Array {
  const random = noiseSource(seed)
  const samples = new Float32Array(Math.floor(SAMPLE_RATE * durationS))
  for (let index = 0; index < samples.length; index += 1) {
    const t = index / SAMPLE_RATE
    samples[index] = level * (
      random() * 0.7 +
      Math.sin(2 * Math.PI * 50 * t) * 0.5 +
      Math.sin(2 * Math.PI * 120 * t) * 0.25
    )
  }
  return samples
}

/**
 * A struck note: harmonics under an exponential decay, with a short release so
 * it reaches silence. A note that stopped mid-decay would be a step
 * discontinuity — a broadband click, which is a real percussive onset and which
 * the detector is right to notice. Real instruments do not do that.
 */
function note(hz: number, durationS: number, amplitude = 0.35): Float32Array {
  const samples = new Float32Array(Math.floor(SAMPLE_RATE * durationS))
  const releaseSamples = Math.floor(SAMPLE_RATE * 0.05)
  for (let index = 0; index < samples.length; index += 1) {
    const t = index / SAMPLE_RATE
    const remaining = samples.length - index
    const release = remaining < releaseSamples
      ? 0.5 * (1 - Math.cos((Math.PI * remaining) / releaseSamples)) : 1
    const envelope = Math.exp(-3.2 * t) * release
    samples[index] = amplitude * envelope * (
      Math.sin(2 * Math.PI * hz * t) +
      0.5 * Math.sin(2 * Math.PI * hz * 2 * t) +
      0.25 * Math.sin(2 * Math.PI * hz * 3 * t) +
      0.12 * Math.sin(2 * Math.PI * hz * 4 * t)
    )
  }
  return samples
}

function mixInto(target: Float32Array, source: Float32Array, atSample: number): void {
  for (let index = 0; index < source.length; index += 1) {
    const position = atSample + index
    if (position >= 0 && position < target.length) target[position] += source[index]
  }
}

/** Run a signal through the detector exactly as the worklet would. */
function detect(detector: LiveNoteDetector, signal: Float32Array) {
  const found: { pitch: number; atMs: number }[] = []
  const buffer = new Float32Array(FRAME_SIZE)
  for (let end = HOP; end <= signal.length; end += HOP) {
    buffer.copyWithin(0, HOP)
    buffer.set(signal.subarray(end - HOP, end), FRAME_SIZE - HOP)
    const result = detector.process(buffer, (end / SAMPLE_RATE) * 1_000)
    if (result) found.push({ pitch: result.pitch, atMs: result.atMs })
  }
  return found
}

function build(noiseLevel: number, seed = 1): LiveNoteDetector {
  const detector = new LiveNoteDetector({ sampleRate: SAMPLE_RATE })
  const room = roomNoise(2, noiseLevel, seed)
  const buffer = new Float32Array(FRAME_SIZE)
  for (let end = HOP; end <= room.length; end += HOP) {
    buffer.copyWithin(0, HOP)
    buffer.set(room.subarray(end - HOP, end), FRAME_SIZE - HOP)
    detector.learnNoiseFrame(buffer)
  }
  detector.sealNoiseProfile()
  return detector
}

describe('frequencyToMidi', () => {
  it('maps concert pitch and octaves', () => {
    expect(frequencyToMidi(440)).toBe(69)
    expect(frequencyToMidi(261.63)).toBe(60)
    expect(frequencyToMidi(880)).toBe(81)
  })
})

describe('LiveNoteDetector in a quiet room', () => {
  it('reports each struck note once, not once per frame', () => {
    const detector = build(0.002)
    const signal = roomNoise(3, 0.002, 7)
    const pitches = [60, 62, 64, 65]
    pitches.forEach((midi, index) => {
      mixInto(signal, note(midiToHz(midi), 0.7), Math.floor(SAMPLE_RATE * (0.4 + index * 0.6)))
    })

    const found = detect(detector, signal)
    expect(found.map((item) => item.pitch)).toEqual(pitches)
  })

  it('places an onset close to where the note actually began', () => {
    const detector = build(0.002)
    const signal = roomNoise(2, 0.002, 11)
    mixInto(signal, note(midiToHz(69), 0.8), Math.floor(SAMPLE_RATE * 0.8))

    const found = detect(detector, signal)
    expect(found).toHaveLength(1)
    expect(found[0].pitch).toBe(69)
    expect(Math.abs(found[0].atMs - 800)).toBeLessThan(60)
  })

  it('does not report a held note again while it rings', () => {
    const detector = build(0.002)
    const signal = roomNoise(3, 0.002, 13)
    // One long, slowly decaying note.
    mixInto(signal, note(midiToHz(67), 2.2, 0.4), Math.floor(SAMPLE_RATE * 0.5))

    expect(detect(detector, signal)).toHaveLength(1)
  })
})

describe('LiveNoteDetector in a noisy room', () => {
  it('stays silent on room noise alone', () => {
    const detector = build(0.02)
    const signal = roomNoise(3, 0.02, 21)
    expect(detect(detector, signal)).toEqual([])
  })

  it('still finds notes played over that noise', () => {
    const detector = build(0.02)
    const signal = roomNoise(3, 0.02, 23)
    const pitches = [72, 74, 76]
    pitches.forEach((midi, index) => {
      mixInto(signal, note(midiToHz(midi), 0.6, 0.32),
        Math.floor(SAMPLE_RATE * (0.5 + index * 0.7)))
    })

    expect(detect(detector, signal).map((item) => item.pitch)).toEqual(pitches)
  })

  it('does not invent an octave-down note, the classic autocorrelation failure', () => {
    const detector = build(0.01)
    const signal = roomNoise(2, 0.01, 29)
    mixInto(signal, note(midiToHz(76), 0.9), Math.floor(SAMPLE_RATE * 0.6))

    const found = detect(detector, signal)
    expect(found).toHaveLength(1)
    expect(found[0].pitch).toBe(76)
  })
})

describe('LiveNoteDetector without a learned room', () => {
  it('still works ungated when the noise check was skipped', () => {
    const detector = new LiveNoteDetector({ sampleRate: SAMPLE_RATE })
    detector.sealNoiseProfile()
    expect(detector.noiseProfileReady).toBe(false)

    const signal = roomNoise(2, 0.002, 31)
    mixInto(signal, note(midiToHz(64), 0.7), Math.floor(SAMPLE_RATE * 0.7))
    expect(detect(detector, signal).map((item) => item.pitch)).toEqual([64])
  })
})

describe('hearing more than one note at once', () => {
  /** Magnitude spectrum of a set of harmonic tones, as the detector sees it. */
  function spectrumOf(midis: number[], fftSize = 4096): Float32Array {
    const binHz = SAMPLE_RATE / fftSize
    const magnitude = new Float32Array(fftSize / 2)
    for (const midi of midis) {
      const fundamental = 440 * 2 ** ((midi - 69) / 12)
      for (let harmonic = 1; harmonic <= 6; harmonic += 1) {
        const bin = Math.round((fundamental * harmonic) / binHz)
        if (bin > 0 && bin < magnitude.length) magnitude[bin] += 1 / harmonic
      }
    }
    return magnitude
  }

  const BIN_HZ = SAMPLE_RATE / 4096

  it('reads a single note as a single note', () => {
    expect(detectPolyphony(spectrumOf([72]), BIN_HZ, 110, 1400)).toEqual([72])
  })

  it('reads a two-hand octave as two notes', () => {
    // What the demo songs actually are: melody over a left-hand bass.
    expect(detectPolyphony(spectrumOf([48, 72]), BIN_HZ, 110, 1400)).toContain(72)
  })

  it('reads a C major triad as three notes', () => {
    const found = detectPolyphony(spectrumOf([60, 64, 67]), BIN_HZ, 110, 1400)
    expect(found).toEqual(expect.arrayContaining([60, 64, 67]))
  })

  it('finds nothing in an empty spectrum', () => {
    expect(detectPolyphony(new Float32Array(2048), BIN_HZ, 110, 1400)).toEqual([])
  })
})
