import type { CaptureMeta, InputSource, InstrumentProfile, PerformanceEvent } from '../../types'

export interface InputDeviceDescriptor {
  id: string
  label: string
}

export interface PerformanceCaptureResult {
  events: PerformanceEvent[]
  captureMeta?: CaptureMeta
  uploadedMidiRef?: string
  fileName?: string
}

export interface PerformanceInputAdapter {
  readonly source: InputSource
  connect(deviceId?: string): Promise<InputDeviceDescriptor[]>
  start(sessionId: string, instrument: InstrumentProfile): Promise<void> | void
  stop(): Promise<PerformanceCaptureResult> | PerformanceCaptureResult
  recover(sessionId: string, instrument: InstrumentProfile): Promise<PerformanceCaptureResult | null>
  discard(sessionId: string): Promise<void>
  dispose(): void
}
