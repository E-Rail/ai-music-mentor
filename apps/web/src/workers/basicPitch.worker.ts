/// <reference lib="webworker" />

import {
  addPitchBendsToNoteEvents, BasicPitch, noteFramesToTime, outputToNotesPoly,
  type NoteEventTime,
} from '@spotify/basic-pitch'
import '@tensorflow/tfjs-backend-cpu'
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm'
import * as tf from '@tensorflow/tfjs-core'
import type { PerformanceEvent } from '../types'
import { cleanupTranscribedNotes } from '../features/microphone/noteCleanup'
import { profileForNoise } from '../features/microphone/profiles'
import type { TranscribeRequest } from '../features/microphone/engineProtocol'

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope

type ModelOutput = {
  frames: number[][]
  onsets: number[][]
  contours: number[][]
}

async function evaluateBasicPitch(audio: Float32Array,
  onProgress: (progress: number) => void): Promise<ModelOutput> {
  const frames: number[][] = []
  const onsets: number[][] = []
  const contours: number[][] = []
  tf.engine().startScope()
  const model = new BasicPitch('/models/basic-pitch/model.json')
  try {
    await model.evaluateModel(
      audio,
      (frameBatch, onsetBatch, contourBatch) => {
        frames.push(...frameBatch)
        onsets.push(...onsetBatch)
        contours.push(...contourBatch)
      },
      onProgress,
    )
    return { frames, onsets, contours }
  } finally {
    try { (await model.model).dispose() } catch { /* a failed model load has nothing to dispose */ }
    try { tf.engine().endScope() } catch { /* keep the CPU retry available after a backend failure */ }
  }
}

function meanPitchBend(note: NoteEventTime): number | null {
  if (!note.pitchBends?.length) return null
  const mean = note.pitchBends.reduce((sum, value) => sum + value, 0) / note.pitchBends.length
  return Math.round(mean * (100 / 3) * 10) / 10
}

workerScope.onmessage = async (message: MessageEvent<TranscribeRequest>) => {
  if (message.data.type !== 'transcribe') return
  const started = performance.now()
  try {
    let backend = 'cpu'
    try {
      setWasmPaths('/models/tfjs-wasm/')
      await import('@tensorflow/tfjs-backend-wasm')
      if (await tf.setBackend('wasm')) backend = 'wasm'
    } catch {
      await tf.setBackend('cpu')
    }
    await tf.ready()
    workerScope.postMessage({ type: 'progress', progress: 0.02, backend })

    const reportProgress = (progress: number) => workerScope.postMessage({
      type: 'progress', progress: Math.min(0.92, Math.max(0.02, progress * 0.9)), backend,
    })
    let output: ModelOutput
    try {
      output = await evaluateBasicPitch(message.data.audio, reportProgress)
    } catch (wasmError) {
      if (backend !== 'wasm') throw wasmError
      // Some Chromium/TensorFlow.js combinations initialize WASM successfully
      // but fail when the graph returns a tensor. Retry the preserved audio on
      // the CPU backend instead of stranding the saved recording.
      await tf.setBackend('cpu')
      await tf.ready()
      backend = 'cpu'
      workerScope.postMessage({ type: 'progress', progress: 0.02, backend })
      try {
        output = await evaluateBasicPitch(message.data.audio, reportProgress)
      } catch (cpuError) {
        const wasmMessage = wasmError instanceof Error ? wasmError.message : String(wasmError)
        const cpuMessage = cpuError instanceof Error ? cpuError.message : String(cpuError)
        throw new Error(`本地转录引擎失败（WASM: ${wasmMessage}；CPU: ${cpuMessage}）`)
      }
    }

    const { frames, onsets, contours } = output

    const notes = noteFramesToTime(addPitchBendsToNoteEvents(
      contours, outputToNotesPoly(
        frames, onsets, message.data.onsetThreshold, message.data.frameThreshold, 5),
    ))
    const raw: PerformanceEvent[] = notes.map((note, index) => ({
      id: `mic_raw_${index + 1}`,
      tOnMs: Math.max(0, note.startTimeSeconds * 1000),
      tOffMs: Math.max(0, (note.startTimeSeconds + note.durationSeconds) * 1000),
      pitch: Math.max(0, Math.min(127, Math.round(note.pitchMidi))),
      velocity: Math.max(1, Math.min(127, Math.round(note.amplitude * 127))),
      channel: 0,
      source: 'microphone',
      pedalDown: false,
      transcriptionConfidence: Math.max(0, Math.min(1, note.amplitude)),
      pitchBendCents: meanPitchBend(note),
    }))
    const baseProfile = profileForNoise(message.data.instrument, message.data.noiseFloorDb)
    const cleaned = cleanupTranscribedNotes(raw, {
      ...baseProfile,
      minConfidence: Math.max(0.25,
        baseProfile.minConfidence + message.data.confidenceAdjustment),
    })
    workerScope.postMessage({
      type: 'complete', events: cleaned.events,
      rejectedCount: cleaned.rejectedCount,
      meanConfidence: cleaned.meanConfidence,
      latencyMs: Math.round(performance.now() - started), backend,
    })
  } catch (error) {
    workerScope.postMessage({
      type: 'error', message: error instanceof Error ? error.message : String(error),
    })
  }
}

export {}
