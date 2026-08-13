export type WorkflowPhase =
  | 'import'
  | 'review'
  | 'device_setup'
  | 'count_in'
  | 'recording'
  | 'analysis'
  | 'report'
  | 'exercise'
  | 'retry'
  | 'comparison'

export type CaptureKind = 'baseline' | 'retry'

export interface WorkflowState {
  phase: WorkflowPhase
  capture: CaptureKind | null
  submittedCapture: CaptureKind | null
  capturePreserved: boolean
  deviceConnected: boolean
  lastRejection: string | null
}

export type WorkflowEvent =
  | { type: 'SCORE_SELECTED' }
  | { type: 'OPEN_IMPORT' }
  | { type: 'START_DEVICE_SETUP' }
  | { type: 'DEVICE_CONNECTED' }
  | { type: 'COUNT_IN_STARTED' }
  | { type: 'CAPTURE_STARTED'; kind: CaptureKind }
  | { type: 'DEVICE_LOST' }
  | { type: 'CAPTURE_RESTORED'; kind: CaptureKind }
  | { type: 'SUBMIT_CAPTURE' }
  | { type: 'ANALYSIS_COMPLETED' }
  | { type: 'ANALYSIS_FAILED' }
  | { type: 'EXERCISE_OPENED' }
  | { type: 'RETRY_STARTED' }
  | { type: 'COMPARISON_COMPLETED' }
  | { type: 'CAPTURE_DISCARDED' }
  | { type: 'NAVIGATE'; phase: WorkflowPhase }
  | { type: 'RESET' }

export const initialWorkflowState: WorkflowState = {
  phase: 'import', capture: null, submittedCapture: null, capturePreserved: false,
  deviceConnected: false, lastRejection: null,
}

function reject(state: WorkflowState, reason: string): WorkflowState {
  return { ...state, lastRejection: reason }
}

export function workflowReducer(state: WorkflowState, event: WorkflowEvent): WorkflowState {
  switch (event.type) {
    case 'SCORE_SELECTED':
      if (state.capture) return reject(state, 'CAPTURE_ACTIVE')
      if (state.phase === 'count_in' || state.phase === 'analysis') {
        return reject(state, 'TRANSITION_IN_PROGRESS')
      }
      // A score is a hard workflow boundary. Do not carry a submitted capture,
      // preserved retry, or stale analysis phase into the next piece.
      return {
        ...initialWorkflowState,
        phase: 'review',
        deviceConnected: state.deviceConnected,
      }
    case 'OPEN_IMPORT':
      if (state.capture) return reject(state, 'CAPTURE_ACTIVE')
      if (state.phase === 'count_in' || state.phase === 'analysis') {
        return reject(state, 'TRANSITION_IN_PROGRESS')
      }
      return {
        ...initialWorkflowState,
        deviceConnected: state.deviceConnected,
      }
    case 'START_DEVICE_SETUP':
      if (state.phase !== 'review' && state.phase !== 'report') return reject(state, 'SCORE_NOT_READY')
      return { ...state, phase: 'device_setup', lastRejection: null }
    case 'DEVICE_CONNECTED':
      return { ...state, deviceConnected: true, lastRejection: null }
    case 'COUNT_IN_STARTED':
      if (state.phase !== 'device_setup') return reject(state, 'DEVICE_SETUP_REQUIRED')
      return { ...state, phase: 'count_in', lastRejection: null }
    case 'CAPTURE_STARTED':
      if (state.capture) return reject(state, 'CAPTURE_ALREADY_ACTIVE')
      if (event.kind === 'baseline' && !['device_setup', 'count_in'].includes(state.phase)) {
        return reject(state, 'COUNT_IN_REQUIRED')
      }
      if (event.kind === 'retry' && !['exercise', 'retry', 'comparison'].includes(state.phase)) {
        return reject(state, 'EXERCISE_REQUIRED')
      }
      return { ...state, phase: event.kind === 'retry' ? 'retry' : 'recording',
        capture: event.kind, submittedCapture: null, capturePreserved: true, lastRejection: null }
    case 'DEVICE_LOST':
      if (!state.capture) return { ...state, deviceConnected: false }
      return { ...state, deviceConnected: false, capturePreserved: true,
        lastRejection: 'DEVICE_LOST_CAPTURE_PRESERVED' }
    case 'CAPTURE_RESTORED':
      return { ...state, phase: event.kind === 'retry' ? 'retry' : 'recording',
        capture: event.kind, submittedCapture: null, capturePreserved: true, lastRejection: null }
    case 'SUBMIT_CAPTURE':
      if (!state.capture && !state.capturePreserved) return reject(state, 'NO_CAPTURE_EVENTS')
      return { ...state, phase: 'analysis', submittedCapture: state.capture,
        capture: null, lastRejection: null }
    case 'ANALYSIS_COMPLETED':
      if (state.phase !== 'analysis') return reject(state, 'ANALYSIS_NOT_RUNNING')
      return { ...state, phase: 'report', submittedCapture: null,
        capturePreserved: false, lastRejection: null }
    case 'ANALYSIS_FAILED':
      if (state.phase !== 'analysis') return state
      return { ...state, phase: state.submittedCapture === 'retry' ? 'retry' : 'recording',
        capture: state.submittedCapture, submittedCapture: null, capturePreserved: true,
        lastRejection: 'ANALYSIS_FAILED_CAPTURE_PRESERVED' }
    case 'EXERCISE_OPENED':
      if (state.phase !== 'report' && state.phase !== 'comparison') return reject(state, 'REPORT_REQUIRED')
      return { ...state, phase: 'exercise', lastRejection: null }
    case 'RETRY_STARTED':
      if (state.capture) return reject(state, 'CAPTURE_ALREADY_ACTIVE')
      if (state.phase !== 'exercise' && state.phase !== 'comparison' && state.phase !== 'retry') {
        return reject(state, 'EXERCISE_REQUIRED')
      }
      return { ...state, phase: 'retry', lastRejection: null }
    case 'COMPARISON_COMPLETED':
      return { ...state, phase: 'comparison', capture: null,
        submittedCapture: null, capturePreserved: false, lastRejection: null }
    case 'CAPTURE_DISCARDED':
      return { ...state, capture: null, submittedCapture: null, capturePreserved: false,
        phase: state.phase === 'retry' ? 'exercise' : 'review', lastRejection: null }
    case 'NAVIGATE':
      if ((state.phase === 'count_in' || state.phase === 'analysis') &&
          event.phase !== state.phase) {
        return reject(state, 'TRANSITION_IN_PROGRESS')
      }
      if (state.capture && event.phase !== state.phase && event.phase !== 'analysis') {
        return reject(state, 'CAPTURE_ACTIVE')
      }
      return { ...state, phase: event.phase, lastRejection: null }
    case 'RESET':
      if (state.capture) return reject(state, 'CAPTURE_ACTIVE')
      return initialWorkflowState
  }
}

export type Workspace = 'score' | 'performance' | 'training'

export function workspaceForPhase(phase: WorkflowPhase): Workspace {
  if (phase === 'import' || phase === 'review') return 'score'
  if (['device_setup', 'count_in', 'recording', 'analysis'].includes(phase)) return 'performance'
  return 'training'
}
