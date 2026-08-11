import { describe, expect, it } from 'vitest'
import { initialWorkflowState, workflowReducer, type WorkflowState } from './machine'

describe('practice workflow guards', () => {
  it('requires review before device setup', () => {
    const state = workflowReducer(initialWorkflowState, { type: 'START_DEVICE_SETUP' })
    expect(state.phase).toBe('import')
    expect(state.lastRejection).toBe('SCORE_NOT_READY')
  })

  it('does not navigate away from an active capture', () => {
    let state = workflowReducer(initialWorkflowState, { type: 'SCORE_SELECTED' })
    state = workflowReducer(state, { type: 'START_DEVICE_SETUP' })
    state = workflowReducer(state, { type: 'COUNT_IN_STARTED' })
    state = workflowReducer(state, { type: 'CAPTURE_STARTED', kind: 'baseline' })
    state = workflowReducer(state, { type: 'NAVIGATE', phase: 'import' })
    expect(state.phase).toBe('recording')
    expect(state.lastRejection).toBe('CAPTURE_ACTIVE')
  })

  it('does not abandon a session while count-in or analysis is in progress', () => {
    const counting: WorkflowState = { ...initialWorkflowState, phase: 'count_in' }
    const countInNavigation = workflowReducer(
      counting, { type: 'NAVIGATE', phase: 'import' })
    expect(countInNavigation.phase).toBe('count_in')
    expect(countInNavigation.lastRejection).toBe('TRANSITION_IN_PROGRESS')

    const analyzing: WorkflowState = {
      ...initialWorkflowState, phase: 'analysis', submittedCapture: 'baseline',
    }
    const scoreSelection = workflowReducer(analyzing, { type: 'SCORE_SELECTED' })
    expect(scoreSelection.phase).toBe('analysis')
    expect(scoreSelection.lastRejection).toBe('TRANSITION_IN_PROGRESS')
  })

  it('preserves capture state on device loss and analysis failure', () => {
    let state: WorkflowState = { ...initialWorkflowState, phase: 'count_in' }
    state = workflowReducer(state, { type: 'CAPTURE_STARTED', kind: 'baseline' })
    state = workflowReducer(state, { type: 'DEVICE_LOST' })
    expect(state.capturePreserved).toBe(true)
    state = workflowReducer(state, { type: 'SUBMIT_CAPTURE' })
    state = workflowReducer(state, { type: 'ANALYSIS_FAILED' })
    expect(state.phase).toBe('recording')
    expect(state.capturePreserved).toBe(true)
  })

  it('rejects a second retry while a capture is active', () => {
    let state: WorkflowState = { ...initialWorkflowState, phase: 'exercise' }
    state = workflowReducer(state, { type: 'RETRY_STARTED' })
    state = workflowReducer(state, { type: 'CAPTURE_STARTED', kind: 'retry' })
    state = workflowReducer(state, { type: 'RETRY_STARTED' })
    expect(state.lastRejection).toBe('CAPTURE_ALREADY_ACTIVE')
  })

  it('starts a clean workflow when another score is selected', () => {
    const stale: WorkflowState = {
      ...initialWorkflowState,
      phase: 'exercise',
      submittedCapture: 'retry',
      capturePreserved: true,
      deviceConnected: true,
      lastRejection: 'OLD_ERROR',
    }
    const state = workflowReducer(stale, { type: 'SCORE_SELECTED' })
    expect(state).toEqual({
      ...initialWorkflowState,
      phase: 'review',
      deviceConnected: true,
    })
  })
})
