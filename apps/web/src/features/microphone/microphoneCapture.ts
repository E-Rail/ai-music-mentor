import type {
  InputDeviceDescriptor, PerformanceCaptureResult, PerformanceInputAdapter,
} from '../input/PerformanceInputAdapter'
import type { InstrumentProfile } from '../../types'
import { LiveNoteDetector, type DetectedNote } from './liveDetector'
import { transcribeAudio } from './transcription'
import { enhancePreviewFrame } from './audioEnhancement'

export type MicrophoneState =
  | 'idle' | 'requesting' | 'noise-check' | 'ready' | 'recording'
  | 'transcribing' | 'permission-denied' | 'device-lost' | 'error'

const STATE_TRANSITIONS: Record<MicrophoneState, readonly MicrophoneState[]> = {
  idle: ['requesting', 'transcribing'],
  requesting: ['noise-check', 'permission-denied', 'error', 'device-lost'],
  'noise-check': ['ready', 'error', 'device-lost'],
  ready: ['requesting', 'recording', 'transcribing', 'device-lost', 'error', 'idle'],
  recording: ['ready', 'transcribing', 'device-lost', 'error', 'idle'],
  transcribing: ['ready', 'error', 'idle'],
  'permission-denied': ['requesting', 'idle'],
  'device-lost': ['requesting', 'transcribing', 'idle'],
  error: ['requesting', 'transcribing', 'ready', 'idle'],
}

export function canTransitionMicrophone(from: MicrophoneState,
  to: MicrophoneState): boolean {
  return from === to || STATE_TRANSITIONS[from].includes(to)
}

export interface MicrophonePreview {
  levelDb: number
  waveform: number[]
  pitchHz: number | null
  noiseFloorDb: number | null
  analysisGainDb: number
  signalToNoiseDb: number | null
}

const DB_NAME = 'ai-music-mentor-audio'
const STORE_NAME = 'takes'
const MAX_TAKE_MS = 90_000
const PERMISSION_TIMEOUT_MS = 30_000
/** The worklet now posts every 512 samples for onset timing; the visible
 *  meter does not need 90 repaints a second. */
const PREVIEW_EVERY_N_FRAMES = 8

type MicrophoneConnectionError = Error & { code?: string }

function connectionError(code: string, message: string): MicrophoneConnectionError {
  return Object.assign(new Error(message), { code })
}

function microphoneFailure(error: unknown): MicrophoneConnectionError {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return connectionError(
        'MIC_PERMISSION_DENIED',
        '浏览器或 macOS 已阻止麦克风。请同时检查地址栏的网站权限，以及“系统设置 → 隐私与安全性 → 麦克风”。',
      )
    }
    if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      return connectionError('MIC_NOT_FOUND', '没有找到可用麦克风。请连接设备后重新扫描。')
    }
    if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
      return connectionError(
        'MIC_NOT_READABLE',
        '麦克风正被其他应用独占，或 macOS 尚未允许当前浏览器使用它。请关闭其他录音应用后重试。',
      )
    }
    if (error.name === 'OverconstrainedError') {
      return connectionError('MIC_DEVICE_UNAVAILABLE', '之前选择的麦克风已不可用，正在尝试系统默认输入。')
    }
  }
  return error instanceof Error
    ? Object.assign(error, { code: (error as MicrophoneConnectionError).code ?? 'MIC_CONNECT_FAILED' })
    : connectionError('MIC_CONNECT_FAILED', String(error))
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function putTake(sessionId: string, blob: Blob): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put({ blob, savedAt: Date.now() }, sessionId)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  } catch { /* capture still works when IndexedDB is unavailable */ }
}

async function getTake(sessionId: string): Promise<Blob | null> {
  try {
    const db = await openDb()
    const value = await new Promise<{ blob?: Blob } | undefined>((resolve, reject) => {
      const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(sessionId)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    db.close()
    return value?.blob instanceof Blob ? value.blob : null
  } catch { return null }
}

async function deleteTake(sessionId: string): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(sessionId)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  } catch { /* best effort */ }
}

export function estimatePitch(samples: Float32Array, sampleRate: number): number | null {
  let squareSum = 0
  for (const value of samples) squareSum += value * value
  if (Math.sqrt(squareSum / samples.length) < 0.006) return null
  const minLag = Math.floor(sampleRate / 1_600)
  const maxLag = Math.min(samples.length - 2, Math.floor(sampleRate / 27))
  let bestLag = 0
  let bestCorrelation = 0
  const correlations = new Float32Array(maxLag + 1)
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let correlation = 0
    let energyA = 0
    let energyB = 0
    for (let index = 0; index < samples.length - lag; index += 1) {
      correlation += samples[index] * samples[index + lag]
      energyA += samples[index] ** 2
      energyB += samples[index + lag] ** 2
    }
    const normalized = correlation / Math.sqrt(Math.max(1e-12, energyA * energyB))
    correlations[lag] = normalized
    if (normalized > bestCorrelation) {
      bestCorrelation = normalized
      bestLag = lag
    }
  }
  if (bestCorrelation < 0.68 || !bestLag) return null
  // A periodic tone also correlates at 2×, 3×… its true period. Prefer the
  // earliest strong local maximum close to the global peak so A4 does not get
  // reported as a low subharmonic such as 40 Hz.
  const strongPeak = Math.max(0.68, bestCorrelation * 0.95)
  for (let lag = minLag + 1; lag < maxLag; lag += 1) {
    if (correlations[lag] >= strongPeak &&
        correlations[lag] >= correlations[lag - 1] &&
        correlations[lag] >= correlations[lag + 1]) {
      bestLag = lag
      break
    }
  }
  return sampleRate / bestLag
}

export class MicrophoneCapture implements PerformanceInputAdapter {
  readonly source = 'microphone' as const
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private worklet: AudioWorkletNode | null = null
  private analyser: AnalyserNode | null = null
  private silentGain: GainNode | null = null
  private previewFrame: number | null = null
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private takeBlob: Blob | null = null
  private stopPromise: Promise<Blob> | null = null
  private sessionId = ''
  private instrument: InstrumentProfile = 'piano'
  private startedAt = 0
  private maxTimer: number | null = null
  private noiseSamples: number[] = []
  private noiseFloorDb: number | null = null
  private liveDetector: LiveNoteDetector | null = null
  private detectorSampleRate = 0
  private expected: readonly number[] = []
  private previewThrottle = 0
  /** Fires once per detected note attack while recording. */
  onDetectedNote: ((note: DetectedNote) => void) | null = null
  private transcriptionAbort: AbortController | null = null
  private discarding = false
  private connectionAttempt = 0
  private previewGainDb = 0

  previewMode: 'worklet' | 'analyser' | 'unavailable' = 'unavailable'
  previewWarning: string | null = null

  state: MicrophoneState = 'idle'
  onStateChange: ((state: MicrophoneState, message?: string) => void) | null = null
  onPreview: ((preview: MicrophonePreview) => void) | null = null
  onTranscriptionProgress: ((progress: number) => void) | null = null
  onDeviceLost: (() => void) | null = null
  onLimitReached: (() => void) | null = null

  private setState(state: MicrophoneState, message?: string): void {
    this.state = state
    this.onStateChange?.(state, message)
  }

  async connect(deviceId?: string): Promise<InputDeviceDescriptor[]> {
    const attempt = ++this.connectionAttempt
    this.setState('requesting')
    this.stopMediaGraph()
    this.previewMode = 'unavailable'
    this.previewWarning = null
    if (!window.isSecureContext) {
      const error = connectionError(
        'MIC_INSECURE_CONTEXT',
        '麦克风只能在安全页面使用。请通过 launch.sh 打开 http://127.0.0.1:8000，不要使用局域网 IP。',
      )
      this.setState('error', error.message)
      throw error
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      const error = connectionError(
        'MIC_UNSUPPORTED',
        '当前浏览器没有提供麦克风接口。请使用最新版桌面 Chrome 或 Edge。',
      )
      this.setState('error', error.message)
      throw error
    }

    // Start Web Audio while the click still has user activation. Waiting for
    // the permission prompt first can leave AudioContext.resume() suspended.
    let resumeResult: Promise<Error | null> | null = null
    try {
      this.context = new AudioContext({ latencyHint: 'interactive' })
      resumeResult = (this.context.state === 'running'
        ? Promise.resolve()
        : this.context.resume()).then(() => null, (error) => microphoneFailure(error))
    } catch (error) {
      this.previewWarning = microphoneFailure(error).message
      this.context = null
    }

    const requestStream = async (exactDeviceId?: string): Promise<MediaStream> => {
      const request = navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: exactDeviceId ? { exact: exactDeviceId } : undefined,
          echoCancellation: { ideal: false }, noiseSuppression: { ideal: false },
          // Automatic gain control pumps on music and keeps moving the floor
          // the room profile was learned against, so detection is done on a
          // stable signal and levels are normalised in software instead.
          autoGainControl: { ideal: false },
          channelCount: 1,
        },
        video: false,
      })
      let timeoutId = 0
      try {
        return await new Promise<MediaStream>((resolve, reject) => {
          timeoutId = window.setTimeout(() => reject(connectionError(
            'MIC_PERMISSION_TIMEOUT',
            '浏览器没有完成麦克风授权。请查看地址栏旁的权限图标；允许后点击重试。',
          )), PERMISSION_TIMEOUT_MS)
          request.then(resolve, reject)
        })
      } catch (error) {
        if ((error as MicrophoneConnectionError).code === 'MIC_PERMISSION_TIMEOUT') {
          void request.then((lateStream) => lateStream.getTracks().forEach((track) => track.stop()))
        }
        throw error
      } finally {
        window.clearTimeout(timeoutId)
      }
    }

    try {
      try {
        this.stream = await requestStream(deviceId)
      } catch (error) {
        const failure = microphoneFailure(error)
        if (deviceId && ['MIC_NOT_FOUND', 'MIC_DEVICE_UNAVAILABLE'].includes(failure.code ?? '')) {
          this.stream = await requestStream()
        } else {
          throw failure
        }
      }
      if (attempt !== this.connectionAttempt) {
        this.stream.getTracks().forEach((track) => track.stop())
        this.stream = null
        throw connectionError('MIC_CONNECT_CANCELLED', '麦克风连接已取消')
      }
    } catch (error) {
      const failure = microphoneFailure(error)
      if (attempt === this.connectionAttempt) {
        this.setState(failure.code === 'MIC_PERMISSION_DENIED' ? 'permission-denied' : 'error',
          failure.message)
      }
      throw failure
    }
    const track = this.stream.getAudioTracks()[0]
    track.onended = () => {
      this.setState('device-lost')
      this.onDeviceLost?.()
      // Browsers disagree on whether MediaRecorder remains "recording" after
      // its input track ends. Finalize either state so this take stays usable.
      if (this.recorder || this.chunks.length) void this.stopRecorder().catch(() => {})
    }
    await this.startPreview(resumeResult)
    if (this.previewMode === 'unavailable') {
      this.noiseFloorDb = null
      this.setState('ready', this.previewWarning ?? undefined)
    } else {
      await this.checkRoomNoise()
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      return devices.filter((device) => device.kind === 'audioinput').map((device, index) => ({
        id: device.deviceId, label: device.label || `麦克风 ${index + 1}`,
      }))
    } catch {
      // Device enumeration is useful for switching inputs, but it must not turn
      // an already-authorized recording stream into a failed connection.
      const settings = track.getSettings()
      return [{
        id: settings.deviceId || track.id,
        label: track.label || '当前麦克风',
      }]
    }
  }

  cancelConnect(): void {
    this.connectionAttempt += 1
    this.stopMediaGraph()
    if (this.state === 'requesting' || this.state === 'noise-check') this.setState('idle')
  }

  private emitPreview(samples: Float32Array, sampleRate: number): void {
    let squareSum = 0
    for (const value of samples) squareSum += value * value
    const levelDb = 20 * Math.log10(Math.max(1e-6, Math.sqrt(squareSum / samples.length)))

    // The room is learned from raw samples: the profile has to describe the
    // microphone's actual noise, not a gain-corrected version of it.
    if (this.state === 'noise-check') {
      this.noiseSamples.push(levelDb)
      this.detector(sampleRate).learnNoiseFrame(samples)
    } else if (this.state === 'recording') {
      const note = this.detector(sampleRate).process(samples, performance.now())
      if (note) this.onDetectedNote?.(note)
    }

    // The visible meter keeps its own gentle normalisation so the waveform
    // stays readable; it has never fed detection and still does not.
    this.previewThrottle += 1
    if (this.previewThrottle % PREVIEW_EVERY_N_FRAMES !== 0) return
    const enhanced = enhancePreviewFrame(
      samples, levelDb, this.noiseFloorDb, this.previewGainDb)
    this.previewGainDb = enhanced.gainDb
    this.onPreview?.({
      levelDb,
      waveform: Array.from(enhanced.samples).filter((_, index) => index % 32 === 0),
      pitchHz: enhanced.signalPresent ? estimatePitch(enhanced.samples, sampleRate) : null,
      noiseFloorDb: this.noiseFloorDb,
      analysisGainDb: enhanced.gainDb,
      signalToNoiseDb: enhanced.signalToNoiseDb,
    })
  }

  /** Detection sensitivity, 0–1. Auto-tuned from the room unless pinned. */
  get detectionSensitivity(): number {
    return this.liveDetector?.sensitivity ?? 0.5
  }

  /** Hold a chosen sensitivity, overriding what the room suggested. */
  setDetectionSensitivity(value: number): void {
    this.liveDetector?.pinSensitivity(value)
  }

  /** The live detector, built on first use once the sample rate is known. */
  /**
   * Tell the listener which notes the page is waiting for.
   *
   * A left hand played softer than the right — which is most playing — can sit
   * far enough under the melody that blind listening loses it entirely. Knowing
   * a note is due is enough to believe a quieter trace of it, and a note that
   * was never played is still never invented.
   */
  expect(pitches: readonly number[]): void {
    this.expected = pitches
    this.liveDetector?.expect(pitches)
  }

  private detector(sampleRate: number): LiveNoteDetector {
    if (!this.liveDetector || this.detectorSampleRate !== sampleRate) {
      this.liveDetector = new LiveNoteDetector({ sampleRate })
      this.liveDetector.expect(this.expected)
      this.detectorSampleRate = sampleRate
    }
    return this.liveDetector
  }

  private async startPreview(resumeResult: Promise<Error | null> | null): Promise<void> {
    if (!this.context || !resumeResult || !this.stream) return
    const resumeError = await Promise.race([
      resumeResult,
      new Promise<Error>((resolve) => window.setTimeout(
        () => resolve(new Error('音频预览未能启动；录音仍可正常使用。')), 2_000)),
    ])
    if (resumeError || this.context.state !== 'running') {
      this.previewWarning = resumeError?.message ?? '音频预览被浏览器暂停；录音仍可正常使用。'
      return
    }
    this.sourceNode = this.context.createMediaStreamSource(this.stream)
    this.silentGain = this.context.createGain()
    this.silentGain.gain.value = 0
    try {
      await this.context.audioWorklet.addModule('/worklets/mic-preview-processor.js')
      this.worklet = new AudioWorkletNode(this.context, 'mic-preview-processor')
      this.sourceNode.connect(this.worklet).connect(this.silentGain).connect(this.context.destination)
      this.worklet.port.onmessage = (event: MessageEvent<{
        level: number; waveform: Float32Array; sampleRate: number
      }>) => this.emitPreview(event.data.waveform, event.data.sampleRate)
      this.previewMode = 'worklet'
      return
    } catch (error) {
      this.sourceNode.disconnect()
      this.worklet?.disconnect()
      this.worklet = null
      this.previewWarning = `高性能预览不可用，已切换兼容模式：${microphoneFailure(error).message}`
    }

    try {
      this.analyser = this.context.createAnalyser()
      this.analyser.fftSize = 2048
      this.sourceNode.connect(this.analyser).connect(this.silentGain).connect(this.context.destination)
      const samples = new Float32Array(this.analyser.fftSize)
      const tick = () => {
        if (!this.analyser || !this.context) return
        this.analyser.getFloatTimeDomainData(samples)
        this.emitPreview(samples, this.context.sampleRate)
        this.previewFrame = window.requestAnimationFrame(tick)
      }
      tick()
      this.previewMode = 'analyser'
    } catch (error) {
      this.previewWarning = `实时预览不可用，但录音和停止后分析仍可使用：${microphoneFailure(error).message}`
      this.previewMode = 'unavailable'
    }
  }

  private async checkRoomNoise(): Promise<void> {
    this.noiseSamples = []
    this.setState('noise-check')
    await new Promise((resolve) => window.setTimeout(resolve, 2_000))
    const track = this.stream?.getAudioTracks()[0]
    if (!track || track.readyState === 'ended') {
      this.setState('device-lost')
      throw new Error('麦克风在房间噪声检查期间断开')
    }
    const sorted = [...this.noiseSamples].sort((a, b) => a - b)
    this.noiseFloorDb = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null
    this.previewGainDb = 0
    this.liveDetector?.sealNoiseProfile()
    this.setState('ready')
  }

  start(sessionId: string, instrument: InstrumentProfile): void {
    if (!this.stream || this.state !== 'ready') throw new Error('麦克风尚未准备好')
    const mimeType = [
      'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4',
    ].find((type) => MediaRecorder.isTypeSupported(type))
    this.liveDetector?.reset()
    this.sessionId = sessionId
    this.instrument = instrument
    this.chunks = []
    this.takeBlob = null
    this.stopPromise = null
    this.discarding = false
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined)
    this.recorder.ondataavailable = (event) => {
      if (!event.data.size || this.discarding) return
      this.chunks.push(event.data)
      void putTake(this.sessionId, new Blob(this.chunks, { type: this.recorder?.mimeType }))
    }
    this.recorder.start(1_000)
    this.startedAt = performance.now()
    this.maxTimer = window.setTimeout(() => {
      void this.stopRecorder().then(() => {
        this.setState('ready')
        this.onLimitReached?.()
      }).catch(() => this.onLimitReached?.())
    }, MAX_TAKE_MS)
    this.setState('recording')
  }

  private stopRecorder(): Promise<Blob> {
    if (this.maxTimer) window.clearTimeout(this.maxTimer)
    this.maxTimer = null
    if (this.takeBlob) return Promise.resolve(this.takeBlob)
    if (this.stopPromise) return this.stopPromise
    if ((!this.recorder || this.recorder.state === 'inactive') && this.chunks.length) {
      this.takeBlob = new Blob(this.chunks, { type: this.recorder?.mimeType })
      void putTake(this.sessionId, this.takeBlob)
      return Promise.resolve(this.takeBlob)
    }
    if (!this.recorder || this.recorder.state === 'inactive') {
      return Promise.reject(new Error('没有可转录的麦克风录音'))
    }
    this.stopPromise = new Promise((resolve, reject) => {
      const recorder = this.recorder!
      recorder.onerror = (event) => {
        this.stopPromise = null
        reject((event as Event & { error?: DOMException }).error ?? new Error('录音器错误'))
      }
      recorder.onstop = () => {
        this.takeBlob = new Blob(this.chunks, { type: recorder.mimeType })
        void putTake(this.sessionId, this.takeBlob)
        resolve(this.takeBlob)
      }
      try {
        recorder.stop()
      } catch (error) {
        this.stopPromise = null
        reject(error)
      }
    })
    return this.stopPromise
  }

  async stop(): Promise<PerformanceCaptureResult> {
    const blob = await this.stopRecorder()
    this.setState('transcribing')
    this.transcriptionAbort = new AbortController()
    try {
      const result = await transcribeAudio(
        blob, this.instrument, this.noiseFloorDb,
        (progress) => this.onTranscriptionProgress?.(progress),
        this.transcriptionAbort.signal,
      )
      this.setState('ready')
      return result
    } catch (error) {
      // Transcription is downstream of capture. A model/backend failure must
      // not pretend that an active microphone was disconnected or discard the
      // locally saved take; the user can retry analysis immediately.
      this.setState(this.stream?.active ? 'ready' : 'device-lost')
      throw error
    } finally {
      this.transcriptionAbort = null
    }
  }

  async recover(sessionId: string, instrument: InstrumentProfile): Promise<PerformanceCaptureResult | null> {
    if (!await this.restoreTake(sessionId, instrument)) return null
    const blob = this.takeBlob!
    this.setState('transcribing')
    this.transcriptionAbort = new AbortController()
    try {
      const result = await transcribeAudio(
        blob, instrument, this.noiseFloorDb,
        (progress) => this.onTranscriptionProgress?.(progress),
        this.transcriptionAbort.signal,
      )
      this.setState('ready')
      return result
    } catch (error) {
      this.setState(this.stream?.active ? 'ready' : 'device-lost')
      throw error
    } finally {
      this.transcriptionAbort = null
    }
  }

  /** Restore a locally saved take without unexpectedly restarting inference. */
  async restoreTake(sessionId: string, instrument: InstrumentProfile): Promise<boolean> {
    const blob = await getTake(sessionId)
    if (!blob) return false
    this.sessionId = sessionId
    this.instrument = instrument
    this.takeBlob = blob
    return true
  }

  cancelTranscription(): void {
    this.transcriptionAbort?.abort()
  }

  hasTake(sessionId?: string | null): boolean {
    return Boolean(sessionId && this.sessionId === sessionId && this.takeBlob)
  }

  async discard(sessionId: string): Promise<void> {
    await deleteTake(sessionId)
    if (this.sessionId === sessionId) this.takeBlob = null
  }

  async cancelTake(sessionId: string): Promise<void> {
    this.discarding = true
    if (this.maxTimer) window.clearTimeout(this.maxTimer)
    this.maxTimer = null
    if (this.stopPromise) {
      await this.stopPromise.catch(() => {})
    } else if (this.recorder?.state === 'recording') {
      try { this.recorder.stop() } catch { /* recorder already stopped */ }
    }
    this.chunks = []
    this.takeBlob = null
    await deleteTake(sessionId)
    if (this.stream) this.setState('ready')
  }

  private stopMediaGraph(): void {
    if (this.previewFrame !== null) window.cancelAnimationFrame(this.previewFrame)
    this.previewFrame = null
    this.stream?.getTracks().forEach((track) => track.stop())
    this.sourceNode?.disconnect()
    this.worklet?.disconnect()
    this.analyser?.disconnect()
    this.silentGain?.disconnect()
    if (this.context) void this.context.close().catch(() => {})
    this.stream = null
    this.sourceNode = null
    this.worklet = null
    this.analyser = null
    this.silentGain = null
    this.context = null
  }

  dispose(): void {
    if (this.maxTimer) window.clearTimeout(this.maxTimer)
    this.transcriptionAbort?.abort()
    if (this.recorder?.state === 'recording') this.recorder.stop()
    this.stopMediaGraph()
    this.setState('idle')
  }
}
