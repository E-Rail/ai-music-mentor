export interface AudioEnhancementMetrics {
  inputGainDb: number
  rawPeakDb: number
  normalizedPeakDb: number
  signalToNoiseDb: number | null
  lowVolumeRecovered: boolean
}

export interface EnhancedAudio {
  samples: Float32Array
  metrics: AudioEnhancementMetrics
}

const MIN_DB = -120

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function amplitudeDb(value: number): number {
  return 20 * Math.log10(Math.max(1e-6, value))
}

function rms(samples: Float32Array, start = 0, end = samples.length): number {
  if (end <= start) return 0
  let sum = 0
  for (let index = start; index < end; index += 1) sum += samples[index] ** 2
  return Math.sqrt(sum / (end - start))
}

function percentile(sorted: number[], ratio: number): number {
  if (!sorted.length) return MIN_DB
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))]
}

function peakDb(samples: Float32Array): number {
  let peak = 0
  for (const value of samples) peak = Math.max(peak, Math.abs(value))
  return amplitudeDb(peak)
}

function frameLevels(samples: Float32Array): number[] {
  const frameSize = 1_024
  const levels: number[] = []
  for (let start = 0; start < samples.length; start += frameSize / 2) {
    levels.push(amplitudeDb(rms(samples, start, Math.min(samples.length, start + frameSize))))
  }
  return levels.sort((a, b) => a - b)
}

/**
 * Prepare audio for local note recognition only. The returned signal is never
 * connected to the speakers and the original MediaRecorder blob remains intact.
 */
export function enhanceAnalysisAudio(
  input: Float32Array,
  sampleRate: number,
  measuredNoiseFloorDb: number | null,
): EnhancedAudio {
  if (!input.length) {
    return {
      samples: new Float32Array(),
      metrics: {
        inputGainDb: 0, rawPeakDb: MIN_DB, normalizedPeakDb: MIN_DB,
        signalToNoiseDb: null, lowVolumeRecovered: false,
      },
    }
  }

  const levels = frameLevels(input)
  const signalDb = percentile(levels, 0.9)
  const estimatedNoiseDb = measuredNoiseFloorDb ?? percentile(levels, 0.2)
  const signalToNoiseDb = clamp(signalDb - estimatedNoiseDb, 0, 80)
  const rawPeakDb = peakDb(input)
  const audibleEvidence = rawPeakDb > -82 && (
    measuredNoiseFloorDb !== null ? signalToNoiseDb >= 3 : signalDb > -72
  )
  const desiredGainDb = audibleEvidence ? clamp(-18 - signalDb, 0, 24) : 0
  const gain = 10 ** (desiredGainDb / 20)

  // Remove DC and sub-audible rumble before gain. A 30 Hz one-pole high-pass
  // preserves the supported instruments while preventing low-frequency HVAC
  // energy from consuming the normalization headroom.
  const output = new Float32Array(input.length)
  const cutoff = 30
  const dt = 1 / Math.max(1, sampleRate)
  const rc = 1 / (2 * Math.PI * cutoff)
  const alpha = rc / (rc + dt)
  let previousInput = input[0]
  let previousOutput = 0
  for (let index = 1; index < input.length; index += 1) {
    const filtered = alpha * (previousOutput + input[index] - previousInput)
    previousInput = input[index]
    previousOutput = filtered
    // Keep inference bounded without changing or playing the captured audio.
    output[index] = clamp(filtered * gain, -0.98, 0.98)
  }

  return {
    samples: output,
    metrics: {
      inputGainDb: Math.round(desiredGainDb * 10) / 10,
      rawPeakDb: Math.round(rawPeakDb * 10) / 10,
      normalizedPeakDb: Math.round(peakDb(output) * 10) / 10,
      signalToNoiseDb: Math.round(signalToNoiseDb * 10) / 10,
      lowVolumeRecovered: desiredGainDb >= 6,
    },
  }
}

export function enhancePreviewFrame(
  input: Float32Array,
  levelDb: number,
  measuredNoiseFloorDb: number | null,
  previousGainDb: number,
): { samples: Float32Array; gainDb: number; signalToNoiseDb: number | null; signalPresent: boolean } {
  const signalToNoiseDb = measuredNoiseFloorDb === null
    ? null : clamp(levelDb - measuredNoiseFloorDb, 0, 80)
  const signalPresent = levelDb > -78 && (
    measuredNoiseFloorDb === null ? levelDb > -62 : (signalToNoiseDb ?? 0) >= 4
  )
  const desiredGainDb = signalPresent ? clamp(-20 - levelDb, 0, 24) : 0
  const smoothing = desiredGainDb > previousGainDb ? 0.38 : 0.12
  const gainDb = previousGainDb + (desiredGainDb - previousGainDb) * smoothing
  const gain = 10 ** (gainDb / 20)
  let mean = 0
  for (const value of input) mean += value
  mean /= Math.max(1, input.length)
  const output = new Float32Array(input.length)
  for (let index = 0; index < input.length; index += 1) {
    output[index] = clamp((input[index] - mean) * gain, -0.98, 0.98)
  }
  return { samples: output, gainDb, signalToNoiseDb, signalPresent }
}
