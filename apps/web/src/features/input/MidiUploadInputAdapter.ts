import type { InstrumentProfile } from '../../types'
import type {
  InputDeviceDescriptor, PerformanceCaptureResult, PerformanceInputAdapter,
} from './PerformanceInputAdapter'

type MidiUploader = (sessionId: string, file: File) =>
  Promise<{ uploadedMidiRef: string }>

/**
 * Upload-mode adapter. The server owns MIDI parsing, while the browser keeps
 * only the opaque private artifact reference needed to finish the session.
 */
export class MidiUploadInputAdapter implements PerformanceInputAdapter {
  readonly source = 'midi-upload' as const
  private sessionId = ''
  private uploadedMidiRef: string | null = null
  private fileName: string | null = null

  constructor(private readonly uploader: MidiUploader) {}

  async connect(): Promise<InputDeviceDescriptor[]> {
    return []
  }

  start(sessionId: string, _instrument: InstrumentProfile): void {
    this.sessionId = sessionId
    this.uploadedMidiRef = null
    this.fileName = null
  }

  async upload(file: File): Promise<PerformanceCaptureResult> {
    if (!this.sessionId) throw new Error('MIDI 上传会话尚未开始')
    const result = await this.uploader(this.sessionId, file)
    this.uploadedMidiRef = result.uploadedMidiRef
    this.fileName = file.name
    return this.currentResult()
  }

  restoreReference(sessionId: string, uploadedMidiRef: string, fileName?: string): void {
    this.sessionId = sessionId
    this.uploadedMidiRef = uploadedMidiRef
    this.fileName = fileName ?? null
  }

  stop(): PerformanceCaptureResult {
    if (!this.uploadedMidiRef) throw new Error('请先上传演奏 MIDI 文件')
    return this.currentResult()
  }

  async recover(sessionId: string, _instrument: InstrumentProfile):
  Promise<PerformanceCaptureResult | null> {
    return sessionId === this.sessionId && this.uploadedMidiRef
      ? this.currentResult() : null
  }

  async discard(sessionId: string): Promise<void> {
    if (sessionId !== this.sessionId) return
    this.uploadedMidiRef = null
    this.fileName = null
  }

  dispose(): void {
    this.sessionId = ''
    this.uploadedMidiRef = null
    this.fileName = null
  }

  private currentResult(): PerformanceCaptureResult {
    return {
      events: [],
      uploadedMidiRef: this.uploadedMidiRef ?? undefined,
      fileName: this.fileName ?? undefined,
    }
  }
}
