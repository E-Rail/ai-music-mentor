/**
 * Real-time note detection that survives a noisy room.
 *
 * The old live path ran a normalised autocorrelation over every preview frame
 * and reported whatever pitch came back. In a room with people talking that
 * reports a pitch continuously — room tone is periodic enough to fool it — and
 * it never says *when* a note started, so a two-second held note looked like
 * twenty separate notes.
 *
 * This detector answers a different question: "did a note just start, and what
 * was it?". Three stages, all local and dependency-free:
 *
 *   1. Learn the room. During the noise check the detector averages a
 *      magnitude spectrum of the empty room.
 *   2. Subtract it. Each frame is spectrally gated against that profile, so
 *      steady chatter, fans and hum stop contributing energy.
 *   3. Find onsets, then pitch. Spectral flux over the gated spectrum with an
 *      adaptive threshold marks note starts; pitch is read only at an onset,
 *      from the NSDF (McLeod), which is far more octave-stable than raw
 *      autocorrelation.
 *
 * One FFT per frame serves both the flux and the autocorrelation (via
 * Wiener–Khinchin), which is what keeps this cheap enough to run live.
 *
 * Polyphony is deliberately out of scope here: at an onset the detector reports
 * the strongest pitch. Chords are resolved after the take by Basic Pitch, which
 * remains the only thing that feeds scoring.
 */

/** Analysis window. 2048 samples is ~43 ms at 48 kHz. */
export const FRAME_SIZE = 2048
/** Zero-padded transform size, so the autocorrelation is circular-safe. */
const FFT_SIZE = 4096
/** Frames of flux history behind the adaptive threshold (~0.5 s). */
const FLUX_HISTORY = 48
/** How much of the learned noise spectrum to remove. Above 1 to be decisive. */
const OVER_SUBTRACTION = 1.6
/**
 * Fraction of a frame's energy that must be *new* for it to count as an attack.
 * Normalising by the frame's own energy is what makes this work at any volume:
 * a struck note is mostly new energy, a ringing one is almost none.
 */
const ONSET_RISE = 0.28
/** Quietest frame worth examining at all, as RMS, when no room was learned. */
const ABSOLUTE_RMS_FLOOR = 0.0025
/**
 * How long to keep trying to name a note after its attack. At the attack the
 * analysis window is still mostly the silence before it, which is far too
 * little of the note to identify; a few frames later the window has filled.
 */
const PITCH_SETTLE_MS = 160
/**
 * How much of the new note must be inside the window before naming it. Without
 * this, a note struck while the previous one is still ringing gets named after
 * its predecessor, which still dominates the window at the attack.
 */
const PITCH_MIN_SETTLE_MS = 42
/** Decay applied to the running peak energy, per frame. */
const PEAK_DECAY = 0.985

export interface LiveDetectorOptions {
  sampleRate: number
  /** Lowest note worth looking for, in Hz. */
  minPitchHz?: number
  maxPitchHz?: number
  /** Refractory period; two onsets closer than this are one note. */
  minIntervalMs?: number
  /** NSDF peak height below which the pitch is not trusted. */
  clarityThreshold?: number
  /** Multiplier on the median flux. Higher = fewer, more certain onsets. */
  fluxSensitivity?: number
}

export interface DetectedNote {
  /** MIDI note number. */
  pitch: number
  frequencyHz: number
  atMs: number
  /** NSDF peak height, 0–1. How periodic the frame was. */
  clarity: number
  /** How far the onset stood above the adaptive threshold. */
  fluxRatio: number
}

const DEFAULTS = {
  minPitchHz: 110,
  maxPitchHz: 1_400,
  minIntervalMs: 95,
  clarityThreshold: 0.72,
  fluxSensitivity: 1.9,
}

function hann(size: number): Float32Array {
  const window = new Float32Array(size)
  for (let index = 0; index < size; index += 1) {
    window[index] = 0.5 * (1 - Math.cos((2 * Math.PI * index) / (size - 1)))
  }
  return window
}

/** In-place iterative radix-2 FFT. `inverse` skips the 1/N scaling. */
function fft(real: Float32Array, imag: Float32Array, inverse: boolean): void {
  const size = real.length
  for (let i = 1, j = 0; i < size; i += 1) {
    let bit = size >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[real[i], real[j]] = [real[j], real[i]]
      ;[imag[i], imag[j]] = [imag[j], imag[i]]
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / length
    const wReal = Math.cos(angle)
    const wImag = Math.sin(angle)
    for (let start = 0; start < size; start += length) {
      let curReal = 1
      let curImag = 0
      for (let offset = 0; offset < length / 2; offset += 1) {
        const a = start + offset
        const b = a + length / 2
        const tReal = real[b] * curReal - imag[b] * curImag
        const tImag = real[b] * curImag + imag[b] * curReal
        real[b] = real[a] - tReal
        imag[b] = imag[a] - tImag
        real[a] += tReal
        imag[a] += tImag
        const nextReal = curReal * wReal - curImag * wImag
        curImag = curReal * wImag + curImag * wReal
        curReal = nextReal
      }
    }
  }
}

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = sorted.length >> 1
  return sorted.length % 2
    ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function frequencyToMidi(hz: number): number {
  return Math.round(69 + 12 * Math.log2(hz / 440))
}

export class LiveNoteDetector {
  private readonly options: Required<LiveDetectorOptions>
  private readonly window = hann(FRAME_SIZE)
  private readonly real = new Float32Array(FFT_SIZE)
  private readonly imag = new Float32Array(FFT_SIZE)
  private readonly power = new Float32Array(FFT_SIZE)
  /** The windowed frame the current spectrum was taken from. */
  private readonly windowed = new Float32Array(FRAME_SIZE)
  private windowedLength = 0
  private readonly bins = FFT_SIZE / 2
  private noiseSum: Float32Array
  private noiseFrames = 0
  private noiseProfile: Float32Array | null = null
  private noiseRms = 0
  private noiseRmsSum = 0
  private previousMagnitude: Float32Array
  private fluxHistory: number[] = []
  private lastOnsetMs = -Infinity
  private armed = true
  private peakEnergy = 0
  private belowGate = true
  /** An attack that has been seen but not yet named. */
  private pendingOnsetMs: number | null = null
  private pendingRatio = 0

  /** Seed the running spectrum without treating the change as an attack. */
  private primeFrom(magnitude: Float32Array): void {
    const profile = this.noiseProfile
    for (let bin = 0; bin < this.bins; bin += 1) {
      const floor = profile ? profile[bin] * OVER_SUBTRACTION : 0
      this.previousMagnitude[bin] = Math.max(0, magnitude[bin] - floor)
    }
  }

  constructor(options: LiveDetectorOptions) {
    this.options = { ...DEFAULTS, ...options }
    this.noiseSum = new Float32Array(this.bins)
    this.previousMagnitude = new Float32Array(this.bins)
  }

  get noiseProfileReady(): boolean { return this.noiseProfile !== null }

  reset(): void {
    this.previousMagnitude = new Float32Array(this.bins)
    this.fluxHistory = []
    this.lastOnsetMs = -Infinity
    this.armed = true
    this.peakEnergy = 0
    this.belowGate = true
    this.pendingOnsetMs = null
    this.pendingRatio = 0
  }

  /** Forget the room as well as the take. */
  resetAll(): void {
    this.reset()
    this.noiseSum = new Float32Array(this.bins)
    this.noiseFrames = 0
    this.noiseRmsSum = 0
    this.noiseRms = 0
    this.noiseProfile = null
  }

  /** Feed a frame of the empty room during the noise check. */
  learnNoiseFrame(frame: Float32Array): void {
    const magnitude = this.spectrum(frame)
    for (let bin = 0; bin < this.bins; bin += 1) this.noiseSum[bin] += magnitude[bin]
    this.noiseRmsSum += this.windowedRms()
    this.noiseFrames += 1
  }

  /** Freeze what was learned. Without frames the detector runs ungated. */
  sealNoiseProfile(): void {
    if (!this.noiseFrames) {
      this.noiseProfile = null
      this.noiseRms = 0
      return
    }
    const profile = new Float32Array(this.bins)
    for (let bin = 0; bin < this.bins; bin += 1) {
      profile[bin] = this.noiseSum[bin] / this.noiseFrames
    }
    this.noiseProfile = profile
    this.noiseRms = this.noiseRmsSum / this.noiseFrames
  }

  private windowedRms(): number {
    let sum = 0
    for (let index = 0; index < this.windowedLength; index += 1) {
      sum += this.windowed[index] ** 2
    }
    return Math.sqrt(sum / Math.max(1, this.windowedLength))
  }

  /**
   * Windowed magnitude spectrum of the most recent FRAME_SIZE samples.
   *
   * The windowed samples are kept because the autocorrelation below has to be
   * normalised by the energy of the very same signal it was computed from —
   * mixing windowed and raw data makes every NSDF peak too small to trust.
   */
  private spectrum(frame: Float32Array): Float32Array {
    const offset = Math.max(0, frame.length - FRAME_SIZE)
    const count = Math.min(FRAME_SIZE, frame.length)
    this.real.fill(0)
    this.imag.fill(0)
    let mean = 0
    for (let index = 0; index < count; index += 1) mean += frame[offset + index]
    mean /= Math.max(1, count)
    for (let index = 0; index < count; index += 1) {
      const value = (frame[offset + index] - mean) * this.window[index]
      this.windowed[index] = value
      this.real[index] = value
    }
    this.windowedLength = count
    fft(this.real, this.imag, false)
    // Power over the whole transform: the autocorrelation needs the full
    // symmetric spectrum, not just the half used for magnitudes.
    for (let bin = 0; bin < FFT_SIZE; bin += 1) {
      this.power[bin] = this.real[bin] ** 2 + this.imag[bin] ** 2
    }
    const magnitude = new Float32Array(this.bins)
    for (let bin = 0; bin < this.bins; bin += 1) {
      magnitude[bin] = Math.sqrt(this.power[bin])
    }
    return magnitude
  }

  /**
   * Autocorrelation from the power spectrum already computed for this frame,
   * then NSDF, then McLeod peak picking.
   */
  private pitchFromLastSpectrum(): { hz: number; clarity: number } | null {
    const { sampleRate, minPitchHz, maxPitchHz, clarityThreshold } = this.options
    const count = this.windowedLength
    const signal = this.windowed

    // Wiener–Khinchin: ACF = IFFT(|FFT(x)|²). The power spectrum of a real
    // signal is already symmetric, so it can be fed straight back in.
    this.real.set(this.power)
    this.imag.fill(0)
    fft(this.real, this.imag, true)
    const acf = this.real

    const minLag = Math.max(2, Math.floor(sampleRate / maxPitchHz))
    const maxLag = Math.min(count - 2, Math.floor(sampleRate / minPitchHz))
    if (maxLag <= minLag) return null

    // Running energies so NSDF normalises without another O(N·lag) pass.
    let energy = 0
    for (let index = 0; index < count; index += 1) energy += signal[index] ** 2
    if (energy <= 1e-12) return null
    let headEnergy = energy
    let tailEnergy = energy
    const nsdf = new Float32Array(maxLag + 1)
    for (let lag = 1; lag <= maxLag; lag += 1) {
      headEnergy -= signal[count - lag] ** 2
      tailEnergy -= signal[lag - 1] ** 2
      const denominator = headEnergy + tailEnergy
      nsdf[lag] = denominator > 1e-12 ? (2 * (acf[lag] / FFT_SIZE)) / denominator : 0
    }

    // McLeod: take the highest of the local maxima that clear 0.9 × the best,
    // choosing the earliest such peak so an octave-down subharmonic loses.
    let best = 0
    for (let lag = minLag; lag <= maxLag; lag += 1) best = Math.max(best, nsdf[lag])
    if (best < clarityThreshold) return null
    const cutoff = best * 0.9
    let chosen = -1
    for (let lag = minLag + 1; lag < maxLag; lag += 1) {
      if (nsdf[lag] >= cutoff && nsdf[lag] >= nsdf[lag - 1] && nsdf[lag] >= nsdf[lag + 1]) {
        chosen = lag
        break
      }
    }
    if (chosen < 0) return null

    // Parabolic interpolation around the peak for sub-bin accuracy.
    const left = nsdf[chosen - 1]
    const centre = nsdf[chosen]
    const right = nsdf[chosen + 1]
    const denominator = left - 2 * centre + right
    const shift = denominator !== 0 ? (0.5 * (left - right)) / denominator : 0
    const hz = sampleRate / (chosen + shift)
    if (!Number.isFinite(hz) || hz < minPitchHz || hz > maxPitchHz) return null
    return { hz, clarity: centre }
  }

  /**
   * Offer a frame. Returns a note only at the moment one starts.
   *
   * `atMs` should be the time the *end* of this frame was captured; the onset
   * is reported half a window earlier, which is where the attack actually was.
   */
  process(frame: Float32Array, atMs: number): DetectedNote | null {
    if (frame.length < 64) return null
    const magnitude = this.spectrum(frame)

    // Is anything sounding at all? Compared against the room when one was
    // learned, so a loud hall does not permanently look like playing.
    const gate = Math.max(ABSOLUTE_RMS_FLOOR, this.noiseRms * 2.2)
    if (this.windowedRms() < gate) {
      this.peakEnergy = 0
      this.pendingOnsetMs = null
      this.armed = true
      this.belowGate = true
      return null
    }

    // First frame back above the gate: prime the running spectrum and judge
    // nothing. Zeroing it here instead would make the next frame look like a
    // note starting from silence, which fired a phantom onset every time a
    // real note decayed out through the gate.
    if (this.belowGate) {
      this.belowGate = false
      this.primeFrom(magnitude)
      return null
    }

    let flux = 0
    let energy = 0
    const profile = this.noiseProfile
    for (let bin = 0; bin < this.bins; bin += 1) {
      const floor = profile ? profile[bin] * OVER_SUBTRACTION : 0
      const gated = Math.max(0, magnitude[bin] - floor)
      const step = gated - this.previousMagnitude[bin]
      if (step > 0) flux += step
      energy += gated
      this.previousMagnitude[bin] = gated
    }
    if (energy <= 1e-9) {
      this.armed = true
      this.pendingOnsetMs = null
      return null
    }

    // Measure new energy against the loudest this passage has recently been,
    // not against the current frame. Dividing by a decaying note's own energy
    // makes a little late noise look like a whole new attack.
    this.peakEnergy = Math.max(energy, this.peakEnergy * PEAK_DECAY)
    const rise = flux / Math.max(energy, this.peakEnergy * 0.3)
    const adaptive = median(this.fluxHistory) * this.options.fluxSensitivity
    this.fluxHistory.push(rise)
    if (this.fluxHistory.length > FLUX_HISTORY) this.fluxHistory.shift()
    const threshold = Math.max(ONSET_RISE, adaptive)

    // An attack already seen is still waiting to be named.
    if (this.pendingOnsetMs !== null) {
      const settled = this.resolvePending(atMs)
      if (settled) return settled
      return null
    }

    if (rise <= threshold) {
      // Re-arm once the signal settles, so a ringing note cannot retrigger.
      if (rise < threshold * 0.5) this.armed = true
      return null
    }
    if (!this.armed) return null
    if (atMs - this.lastOnsetMs < this.options.minIntervalMs) return null

    this.armed = false
    this.lastOnsetMs = atMs
    // The attack sits behind the window, not at its trailing edge.
    this.pendingOnsetMs = atMs - (FRAME_SIZE / this.options.sampleRate) * 500
    this.pendingRatio = rise / threshold
    return this.resolvePending(atMs)
  }

  /** Name the pending attack once enough of the note is inside the window. */
  private resolvePending(atMs: number): DetectedNote | null {
    const onsetMs = this.pendingOnsetMs
    if (onsetMs === null) return null
    // Give the window time to fill with the new note before naming it.
    if (atMs - onsetMs < PITCH_MIN_SETTLE_MS) return null
    const pitch = this.pitchFromLastSpectrum()
    if (!pitch) {
      if (atMs - onsetMs > PITCH_SETTLE_MS) this.pendingOnsetMs = null
      return null
    }
    const midi = frequencyToMidi(pitch.hz)
    this.pendingOnsetMs = null
    if (midi < 0 || midi > 127) return null
    return {
      pitch: midi,
      frequencyHz: pitch.hz,
      atMs: onsetMs,
      clarity: pitch.clarity,
      fluxRatio: this.pendingRatio,
    }
  }
}
