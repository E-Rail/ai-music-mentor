import { lazy, Suspense, useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { ScaleSwitch, useUiScale } from './features/shell/ScaleSwitch'
import { api } from './api/client'
import {
  measureLabel, measureLabelList, setScoreMeasureLabels,
} from './features/score/measureLabels'
// One spelling for a note, everywhere: the strip of keys you are holding must
// name the same note the staff does.
import { noteName as midiName } from './features/score/pitch'
import type {
  CaptureMeta, ComparisonResult, DiagnosisReport, ErrorEvent, ExerciseResult,
  InputSource, InstrumentProfile, MentorChatResponse, MentorMemoryStatus,
  MentorPlanItem, MentorResponse,
  PerformanceEvent, ScoreDetail, ScoreEvent, ScoreMeta, ScoreNormalization,
  ScoreSourceType,
} from './types'
import { MidiCapture } from './features/midi/midiCapture'
import { MicrophoneCapture, type MicrophonePreview, type MicrophoneState } from './features/microphone/microphoneCapture'
import { MicrophonePanel } from './features/microphone/MicrophonePanel'
import type { InputDeviceDescriptor } from './features/input/PerformanceInputAdapter'
import { MidiUploadInputAdapter } from './features/input/MidiUploadInputAdapter'
import { StudioStepper, type StudioStage } from './features/practice/StudioStepper'
import { LivePanel } from './features/live/LivePanel'
import {
  LivePerformanceTracker, idleLiveState, type LivePerformanceState,
  type LiveTraceNote,
} from './features/live'
import { CoachReport } from './features/report/CoachReport'
import { errorColor, errorDetailForDisplay } from './features/report/errorPresentation'
import {
  categoryForScore, partitionScoreLibrary, scoreDisplayTitle,
  type ScoreLibraryItem,
} from './features/score/library'
import type { MentorChatMessage } from './features/mentor/MentorChat'
import {
  chatMessageId, readMentorChat, writeMentorChat,
} from './features/mentor/chatStorage'
import { MidiPlayer, ensureAudio, parsePitchNames, playPitches } from './features/audio/player'
import {
  initialWorkflowState, workflowReducer, type WorkflowPhase,
} from './workflow/machine'
import {
  CADENCE_LABEL, ERROR_TYPE_LABEL, EXERCISE_STRATEGIES, METRIC_LABEL, t, tf,
} from './i18n/messages'

const ScoreViewer = lazy(() => import('./features/score/ScoreViewer').then((module) => ({
  default: module.ScoreViewer,
})))

type Step = 'select' | 'calibrate' | 'perform' | 'report' | 'exercise' | 'compare'
type CalibrationStatus = {
  noteCount: number
  centerC: boolean
  lastPitch: number | null
  lastVelocity: number | null
  jitterMs: number | null
  duplicateMessages: number
}
type RecoveryContext = {
  kind: 'baseline' | 'retry'
  sessionId: string
  scoreId: string
  rangeStart: number
  rangeEnd: number
  baselineReportId?: string
  exerciseId?: string
  inputSource?: InputSource
  instrument?: InstrumentProfile
  uploadedMidiRef?: string
  uploadedFileName?: string
  savedAt: number
}
type ExerciseStage = 'design' | 'generated'
type SubmissionStage = 'idle' | 'saving' | 'transcribing' | 'analyzing' | 'complete' | 'error'
type ScoreListItem = ScoreLibraryItem

const RECOVERY_CONTEXT_KEY = 'ai-music-mentor:active-session'
function readRecoveryContext(): RecoveryContext | null {
  try {
    const raw = localStorage.getItem(RECOVERY_CONTEXT_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<RecoveryContext>
    if ((value.kind !== 'baseline' && value.kind !== 'retry') ||
        !value.sessionId || !value.scoreId || !Number.isFinite(value.rangeStart) ||
        !Number.isFinite(value.rangeEnd)) return null
    return value as RecoveryContext
  } catch { return null }
}

function writeRecoveryContext(context: RecoveryContext): void {
  try { localStorage.setItem(RECOVERY_CONTEXT_KEY, JSON.stringify(context)) } catch { /* storage unavailable */ }
}

function clearStoredRecoveryContext(sessionId?: string): void {
  try {
    const current = readRecoveryContext()
    if (!sessionId || current?.sessionId === sessionId) {
      localStorage.removeItem(RECOVERY_CONTEXT_KEY)
    }
  } catch { /* storage unavailable */ }
}

const PHASE_TO_STEP: Record<WorkflowPhase, Step> = {
  import: 'select', review: 'select', device_setup: 'calibrate', count_in: 'perform',
  recording: 'perform', analysis: 'perform', report: 'report', exercise: 'exercise',
  retry: 'compare', comparison: 'compare',
}

/**
 * How much of a new piece to practise first.
 *
 * Nobody learns a piece by playing all of it badly. A take is only useful
 * feedback if the player can hold the passage together, so a long import opens
 * on its first section and says so; a short one opens whole. The control is
 * right there either way — this is a starting point, not a rule.
 */
const FIRST_PASSAGE_MEASURES = 16

function openingRange(measureCount: number): { start: number; end: number } {
  const total = Math.max(1, Math.floor(measureCount) || 1)
  return { start: 1, end: Math.min(total, FIRST_PASSAGE_MEASURES) }
}

/** Files that have to be looked at rather than parsed. */
const READ_FROM_PAGE_SUFFIXES = /\.(pdf|png|jpe?g|webp|heic|heif)$/i

/** A score that a model read off a page, rather than one someone exported. */
function isReadFromPage(detail: { sourceType: ScoreSourceType }): boolean {
  return detail.sourceType === 'pdf' || detail.sourceType === 'image'
}

export default function App() {
  const [workflow, sendWorkflow] = useReducer(workflowReducer, initialWorkflowState)
  const step = PHASE_TO_STEP[workflow.phase]
  const [scores, setScores] = useState<ScoreListItem[]>([])
  const [scoreId, setScoreId] = useState<string | null>(null)
  const [scoreDetail, setScoreDetail] = useState<ScoreDetail | null>(null)
  const [normalization, setNormalization] = useState<ScoreNormalization | null>(null)
  const [meta, setMetaState] = useState<ScoreMeta | null>(null)
  /**
   * Setting the open score also publishes how its bars are named, so the staff,
   * the live cursor and every report say the same bar number. Going through one
   * setter is what makes that true no matter which path loaded the score.
   */
  const setMeta = useCallback((next: ScoreMeta | null) => {
    setScoreMeasureLabels(next?.measureLabels)
    setMetaState(next)
  }, [])
  const [events, setEvents] = useState<ScoreEvent[]>([])
  const [rangeStart, setRangeStart] = useState(1)
  const [rangeEnd, setRangeEnd] = useState(8)
  const [loading, setLoading] = useState(false)
  const [alert, setAlert] = useState<{ type: string; msg: string } | null>(null)
  const setStep = (next: Step) => {
    const phase: WorkflowPhase = next === 'select' ? (scoreId ? 'review' : 'import')
      : next === 'calibrate' ? 'device_setup'
        : next === 'perform' ? 'recording'
          : next === 'report' ? 'report'
            : next === 'exercise' ? 'exercise'
              : 'comparison'
    sendWorkflow({ type: 'NAVIGATE', phase })
  }

  // 演奏
  const captureRef = useRef<MidiCapture | null>(null)
  const microphoneRef = useRef<MicrophoneCapture | null>(null)
  const midiUploadRef = useRef<MidiUploadInputAdapter | null>(null)
  const playerRef = useRef<MidiPlayer | null>(null)
  const [midiSupported, setMidiSupported] = useState(true)
  const [inputs, setInputs] = useState<string[]>([])
  const [selectedInput, setSelectedInput] = useState<string | null>(null)
  const selectedInputRef = useRef<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [liveNotes, setLiveNotes] = useState<number[]>([])
  // `waiting` means the passage is holding here: a note is still owed, or a
  // wrong one has not been corrected yet.
  const [cursor, setCursor] = useState<
    { measure: number; beat: number; waiting?: boolean; bpm?: number } | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [recoveryContext, setRecoveryContext] = useState<RecoveryContext | null>(null)
  const [recoveredEvents, setRecoveredEvents] = useState<PerformanceEvent[]>([])
  const [inputSource, setInputSource] = useState<InputSource>('web-midi')
  const [instrument, setInstrument] = useState<InstrumentProfile>('piano')
  const [uploadMode, setUploadModeState] = useState(false)
  const [microphoneState, setMicrophoneState] = useState<MicrophoneState>('idle')
  const [microphoneError, setMicrophoneError] = useState<string | null>(null)
  const [microphoneDevices, setMicrophoneDevices] = useState<InputDeviceDescriptor[]>([])
  const [selectedMicrophoneId, setSelectedMicrophoneId] = useState('')
  const [micSensitivity, setMicSensitivity] = useState(0.5)
  const [micSensitivityPinned, setMicSensitivityPinned] = useState(false)
  const [microphonePreview, setMicrophonePreview] = useState<MicrophonePreview>({
    levelDb: -60, waveform: [], pitchHz: null, noiseFloorDb: null,
    analysisGainDb: 0, signalToNoiseDb: null,
  })
  const [transcriptionProgress, setTranscriptionProgress] = useState(0)
  const [captureMeta, setCaptureMeta] = useState<CaptureMeta | undefined>()
  const [headphonesConfirmed, setHeadphonesConfirmed] = useState(false)
  const [submissionStage, setSubmissionStage] = useState<SubmissionStage>('idle')
  const [liveFeedback, setLiveFeedback] = useState<LivePerformanceState>(
    idleLiveState('web-midi'))
  const [liveTrace, setLiveTrace] = useState<LiveTraceNote[]>([])
  const recordingRef = useRef(false)
  // One tracker serves every input source, so the staff marker, the cursor and
  // the live panel can never disagree about where the player is.
  const liveRef = useRef(new LivePerformanceTracker())
  const microphoneConnectRequestRef = useRef(0)
  const sessionStartInFlightRef = useRef(false)
  const submissionInFlightRef = useRef(false)
  const [calibration, setCalibration] = useState<CalibrationStatus>({
    noteCount: 0, centerC: false, lastPitch: null, lastVelocity: null,
    jitterMs: null, duplicateMessages: 0,
  })
  const uploadMidiRef = useRef<string | null>(null)
  const setUploadMode = (enabled: boolean) => {
    setUploadModeState(enabled)
    if (enabled) setInputSource('midi-upload')
    else if (inputSource === 'midi-upload') setInputSource('web-midi')
  }

  // 报告
  const [report, setReport] = useState<DiagnosisReport | null>(null)
  const [baselineReport, setBaselineReport] = useState<DiagnosisReport | null>(null)
  const [selectedError, setSelectedError] = useState<ErrorEvent | null>(null)
  const [mentor, setMentor] = useState<MentorResponse | null>(null)
  const [mentorLoading, setMentorLoading] = useState(false)
  const [mentorChat, setMentorChat] = useState<MentorChatMessage[]>([])
  const [mentorChatLoading, setMentorChatLoading] = useState(false)
  const [mentorMemory, setMentorMemory] = useState<MentorMemoryStatus | null>(null)
  const [question, setQuestion] = useState('')
  const mentorCacheRef = useRef(new Map<string, MentorResponse>())
  const mentorPendingRef = useRef(new Map<string, Promise<MentorResponse>>())
  const mentorRequestRef = useRef(0)
  const mentorChatRequestRef = useRef(0)
  const mentorChatAbortRef = useRef<AbortController | null>(null)

  // 练习
  const [exercise, setExercise] = useState<ExerciseResult | null>(null)
  const [exerciseScore, setExerciseScore] = useState<ScoreDetail | null>(null)
  const [exerciseStage, setExerciseStage] = useState<ExerciseStage>('design')
  const [generationNote, setGenerationNote] = useState('')
  const [strategy, setStrategy] = useState('auto')
  const [tempoRatio, setTempoRatio] = useState(0.6)
  const [loopCount, setLoopCount] = useState(4)
  const [hands, setHands] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const exerciseRequestRef = useRef(0)
  const scoreLoadRequestRef = useRef(0)

  // 对比
  const [comparison, setComparison] = useState<ComparisonResult | null>(null)
  const [accMode, setAccMode] = useState<'strict' | 'flexible'>('flexible')
  const [retrySessionId, setRetrySessionId] = useState<string | null>(null)
  const retryUploadMidiRef = useRef<string | null>(null)
  const [retryUploadName, setRetryUploadName] = useState<string | null>(null)
  const [retryTempo, setRetryTempo] = useState<number | null>(null)
  const accompanimentBpmRef = useRef(0)
  const lastTempoMeasureRef = useRef<number | null>(null)

  const resetPracticeBlock = () => {
    // Reports, chats, generated results and retry captures belong to exactly
    // one score context. Invalidate late async responses before clearing UI.
    exerciseRequestRef.current += 1
    mentorRequestRef.current += 1
    mentorChatRequestRef.current += 1
    mentorChatAbortRef.current?.abort()
    mentorChatAbortRef.current = null
    mentorPendingRef.current.clear()
    mentorCacheRef.current.clear()
    playerRef.current?.stop()
    liveTempoHookRef.current = null
    setPlaying(false)
    setReport(null)
    setBaselineReport(null)
    setSelectedError(null)
    setMentor(null)
    setMentorLoading(false)
    setMentorChat([])
    setMentorChatLoading(false)
    setMentorMemory(null)
    setQuestion('')
    setExercise(null)
    setExerciseScore(null)
    setExerciseStage('design')
    setGenerationNote('')
    setStrategy('auto')
    setTempoRatio(0.6)
    setLoopCount(4)
    setHands(null)
    setComparison(null)
    setSessionId(null)
    setRetrySessionId(null)
    setRetryUploadName(null)
    setRetryTempo(null)
    setCursor(null)
    setRecoveredEvents([])
    setRecoveryContext(null)
    setCaptureMeta(undefined)
    setTranscriptionProgress(0)
    setSubmissionStage('idle')
    setLoading(false)
    setRecording(false)
    recordingRef.current = false
    setLiveNotes([])
    liveRef.current.reset()
    setLiveTrace([])
    setLiveFeedback(idleLiveState(
      inputSource === 'microphone' ? 'microphone' : 'web-midi'))
    uploadMidiRef.current = null
    retryUploadMidiRef.current = null
    clearStoredRecoveryContext()
  }

  useEffect(() => { recordingRef.current = recording }, [recording])

  /**
   * Arm the live layer for a take. Nothing here starts a clock: the
   * performance timeline begins at the player's first note, so a student may
   * take as long as they like after the count-in.
   */
  const prepareLiveFeedback = (
    scoreEvents: ScoreEvent[], start: number, end: number,
    beatsPerMeasure: number, bpm: number, source: 'web-midi' | 'microphone',
  ) => {
    setLiveTrace([])
    setLiveFeedback(liveRef.current.begin({
      events: scoreEvents, rangeStart: start, rangeEnd: end,
      bpm, beatsPerMeasure, source,
    }))
  }

  /**
   * One place publishes everything that follows from a played note. The cursor
   * is exactly where the passage says the player is — there is no second
   * opinion to reconcile it with, which is what used to let the two drift.
   */
  const publishLiveState = (state: LivePerformanceState) => {
    setLiveFeedback(state)
    setLiveTrace([...liveRef.current.traceNotes])
    if (state.target) {
      setCursor({
        measure: state.target.measureNo, beat: state.target.onsetBeat,
        waiting: state.blocked || state.outstanding.length > 0,
        bpm: liveRef.current.bpm,
      })
    }
    liveTempoHookRef.current?.(state, liveRef.current.bpm)
  }

  /** Lets the retry stage follow the player's tempo without a second matcher. */
  const liveTempoHookRef = useRef<
    ((state: LivePerformanceState, bpm: number) => void) | null>(null)

  /**
   * Move past a position the player has decided not to finish. Theirs to press:
   * the app never rules that a wrong note "must have meant" a later one.
   */
  const skipLivePosition = () => {
    if (!recordingRef.current) return
    publishLiveState(liveRef.current.skipCurrent())
  }

  const observeLiveInput = (pitches: number[], atMs: number) => {
    if (!recordingRef.current) return
    publishLiveState(liveRef.current.observe({ pitches, atMs }))
  }

  // The meter is cosmetic. Notes arrive separately, from the detector's own
  // onset decisions, so a held note is one note rather than a pitch sample
  // every 180 ms and room tone never registers as playing at all.
  const updateMicrophonePreview = (preview: MicrophonePreview) => {
    setMicrophonePreview(preview)
  }

  const loadMentor = async (activeReport: DiagnosisReport, prompt = '',
    errorId?: string, notifyOnError = true): Promise<MentorResponse | null> => {
    const requestId = ++mentorRequestRef.current
    const key = JSON.stringify([activeReport.reportId, errorId ?? '', prompt.trim()])
    const cached = mentorCacheRef.current.get(key)
    if (cached) {
      setMentor(cached)
      setMentorLoading(false)
      return cached
    }

    setMentor(null)
    setMentorLoading(true)
    let pending = mentorPendingRef.current.get(key)
    if (!pending) {
      pending = api.mentor(activeReport.reportId, prompt, errorId)
      mentorPendingRef.current.set(key, pending)
    }
    try {
      const response = await pending
      mentorCacheRef.current.set(key, response)
      if (requestId === mentorRequestRef.current) setMentor(response)
      return response
    } catch (error) {
      if (requestId === mentorRequestRef.current && notifyOnError) {
        setAlert({
          type: 'warn',
          msg: tf('mentorUnavailableWithDetail', { detail: (error as Error).message }),
        })
      }
      return null
    } finally {
      if (mentorPendingRef.current.get(key) === pending) {
        mentorPendingRef.current.delete(key)
      }
      if (requestId === mentorRequestRef.current) setMentorLoading(false)
    }
  }

  const chooseError = (activeReport: DiagnosisReport, error: ErrorEvent) => {
    setSelectedError(error)
    void loadMentor(activeReport, '', error.id)
  }

  const applyMentorPlan = (plan: MentorPlanItem) => {
    const supported = new Set<string>(EXERCISE_STRATEGIES.map(([key]) => key))
    setStrategy(supported.has(plan.exerciseType) ? plan.exerciseType : 'auto')
    if (plan.tempo && meta?.tempo) {
      const ratio = Math.min(1.25, Math.max(0.25, plan.tempo / meta.tempo))
      setTempoRatio(Math.round(ratio * 100) / 100)
    }
    setLoopCount(Math.min(10, Math.max(1, plan.repetitions)))
    if (report) setBaselineReport(report)
    setExercise(null)
    setExerciseScore(null)
    setComparison(null)
    setExerciseStage('design')
    sendWorkflow({ type: 'EXERCISE_OPENED' })
  }

  // ---- 初始化 ----
  useEffect(() => {
    let cancelled = false
    api.listScores()
      .then((r) => {
        if (!cancelled) setScores(r.scores as ScoreListItem[])
      })
      .catch((error) => {
        if (!cancelled) setAlert({ type: 'error', msg: tf('loadScoresFailed', { detail: (error as Error).message }) })
      })
    const capture = new MidiCapture()
    capture.onLiveNote = (pitch, velocity, on) => {
      setLiveNotes((previous) => {
        if (!on) return previous.filter((value) => value !== pitch)
        if (previous.includes(pitch)) return previous
        return [...previous.slice(-7), pitch]
      })
      if (on) {
        setCalibration((previous) => ({
          ...previous,
          noteCount: previous.noteCount + 1,
          centerC: previous.centerC || pitch === 60,
          lastPitch: pitch,
          lastVelocity: velocity,
        }))
      }
    }
    capture.onHealth = (health) => setCalibration((previous) => ({
      ...previous,
      jitterMs: health.jitterMs,
      duplicateMessages: health.duplicateMessages,
    }))
    capture.onBatch = (activeSessionId, batchId, sequence, batchEvents) =>
      api.persistEventBatch(activeSessionId, batchId, sequence, batchEvents)
    capture.onDeviceLost = (name) => {
      capture.checkpoint()
      sendWorkflow({ type: 'DEVICE_LOST' })
      setCursor((previous) => previous ? { ...previous, waiting: true } : previous)
      const active = readRecoveryContext()
      if (active) void api.markDeviceLost(active.sessionId).catch(() => {})
      setAlert({ type: 'warn', msg: tf('deviceLost', { name }) })
    }
    capture.onStateChange = (message) => {
      const names = capture.listInputs()
      setInputs(names)
      const selected = selectedInputRef.current
      if (selected && !names.includes(selected)) {
        selectedInputRef.current = null
        setSelectedInput(null)
        setAlert({ type: 'warn', msg: tf('deviceStateLost', { message }) })
      } else {
        setAlert({ type: 'info', msg: message })
      }
    }
    captureRef.current = capture
    const microphone = new MicrophoneCapture()
    microphone.onStateChange = (state, message) => {
      setMicrophoneState(state)
      if ((state === 'error' || state === 'permission-denied' || state === 'device-lost') && message) {
        setMicrophoneError(message)
      } else if (state === 'ready') {
        setMicrophoneError(null)
      }
    }
    microphone.onPreview = updateMicrophonePreview
    microphone.onDetectedNote = (note) => {
      // Every pitch heard at the attack, so a two-hand chord reads as one.
      observeLiveInput(note.pitches, note.atMs)
      // The detector re-tunes itself to the room; show what it settled on.
      setMicSensitivity((previous) => {
        const actual = microphone.detectionSensitivity
        return Math.abs(actual - previous) > 0.01 ? actual : previous
      })
    }
    microphone.onTranscriptionProgress = setTranscriptionProgress
    microphone.onDeviceLost = () => {
      recordingRef.current = false
      setRecording(false)
      sendWorkflow({ type: 'DEVICE_LOST' })
      const active = readRecoveryContext()
      if (active) void api.markDeviceLost(active.sessionId).catch(() => {})
      setAlert({ type: 'warn', msg: t('microphoneDeviceLost') })
    }
    microphone.onLimitReached = () => {
      recordingRef.current = false
      setRecording(false)
      setAlert({ type: 'warn', msg: t('microphoneLimitReached') })
    }
    microphoneRef.current = microphone
    const midiUpload = new MidiUploadInputAdapter(api.uploadMidi)
    midiUploadRef.current = midiUpload
    const stored = readRecoveryContext()
    if (stored) {
      void (async () => {
        let recovered: PerformanceEvent[] = []
        let recoveredMeta: CaptureMeta | undefined
        let recoveredUploadRef: string | undefined
        let recoveredMicrophoneTake = false
        try {
          if (stored.inputSource === 'microphone') {
            recoveredMicrophoneTake = await microphone.restoreTake(
              stored.sessionId, stored.instrument ?? 'piano')
          } else if (stored.inputSource === 'midi-upload') {
            recoveredUploadRef = stored.uploadedMidiRef
            if (recoveredUploadRef) {
              midiUpload.restoreReference(
                stored.sessionId, recoveredUploadRef, stored.uploadedFileName)
            }
          } else {
            recovered = await MidiCapture.recover(stored.sessionId)
          }
          if (!recovered.length && !recoveredUploadRef && !recoveredMicrophoneTake) {
            if (stored.inputSource === 'microphone') await microphone.discard(stored.sessionId)
            else if (stored.inputSource === 'midi-upload') await midiUpload.discard(stored.sessionId)
            else await MidiCapture.clearRecovery(stored.sessionId)
            await api.discardSession(stored.sessionId).catch(() => {})
            clearStoredRecoveryContext(stored.sessionId)
            return
          }
          const recoveredScore = await api.getScore(stored.scoreId)
          let currentScore = recoveredScore
          let baseline: DiagnosisReport | null = null
          let restoredExercise: ExerciseResult | null = null
          if (stored.kind === 'retry') {
            if (!stored.baselineReportId) throw new Error(t('missingBaselineReport'))
            ;[baseline, restoredExercise] = await Promise.all([
              api.getReport(stored.baselineReportId),
              stored.exerciseId ? api.getExercise(stored.exerciseId) : Promise.resolve(null),
            ])
            if (baseline.scoreId !== recoveredScore.scoreId) {
              currentScore = await api.getScore(baseline.scoreId)
            }
          }
          if (cancelled) return
          setScoreId(currentScore.scoreId); setMeta(currentScore.metadata)
          setEvents(currentScore.scoreEvents); setScoreDetail(currentScore)
          setNormalization(currentScore.normalization)
          setRangeStart(stored.rangeStart); setRangeEnd(stored.rangeEnd)
          setInputSource(stored.inputSource ?? 'web-midi')
          setInstrument(stored.instrument ?? 'piano')
          setUploadModeState(stored.inputSource === 'midi-upload')
          setRecording(false); setRecoveredEvents(recovered); setCaptureMeta(recoveredMeta)
          setRecoveryContext(stored)
          if (stored.kind === 'baseline') {
            setSessionId(stored.sessionId)
            uploadMidiRef.current = recoveredUploadRef ?? null
            sendWorkflow({ type: 'CAPTURE_RESTORED', kind: 'baseline' })
          } else {
            setRetrySessionId(stored.sessionId)
            retryUploadMidiRef.current = recoveredUploadRef ?? null
            setRetryUploadName(stored.uploadedFileName ?? null)
            setBaselineReport(baseline); setReport(baseline)
            setExercise(restoredExercise)
            setExerciseScore(
              restoredExercise?.practiceScoreId === recoveredScore.scoreId
                ? recoveredScore : null,
            )
            if (restoredExercise) setExerciseStage('generated')
            setSelectedError(baseline?.errors[0] ?? null)
            setMentorChat(baseline ? readMentorChat(baseline.reportId) : [])
            sendWorkflow({ type: 'CAPTURE_RESTORED', kind: 'retry' })
          }
          setAlert({
            type: 'info',
            msg: recoveredUploadRef
              ? tf('recoveredMidiCanSubmit', { name: stored.uploadedFileName ?? 'MIDI' })
              : recoveredMicrophoneTake
                ? t('microphoneSavedTakeRecovered')
              : tf('recoveredNotesCanSubmit', { count: recovered.length }),
          })
        } catch (error) {
          if (!cancelled) {
            setRecoveryContext(stored)
            setRecoveredEvents(recovered)
            setAlert({ type: 'warn', msg: tf('recoveryFailed', { detail: (error as Error).message }) })
          }
        }
      })()
    }
    return () => {
      cancelled = true
      capture.dispose(); microphone.dispose(); midiUpload.dispose()
      playerRef.current?.dispose(); liveTempoHookRef.current = null
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!report) {
      setMentorMemory(null)
      return () => { cancelled = true }
    }
    api.getMentorMemory(report.reportId)
      .then((memory) => { if (!cancelled) setMentorMemory(memory) })
      .catch(() => { if (!cancelled) setMentorMemory(null) })
    return () => { cancelled = true }
  }, [report?.reportId])

  const getPlayer = (): MidiPlayer => {
    playerRef.current ??= new MidiPlayer()
    return playerRef.current
  }

  const discardRecoveredRecording = async () => {
    const context = recoveryContext
    if (!context) return
    if (context.inputSource === 'microphone') await microphoneRef.current?.discard(context.sessionId)
    else if (context.inputSource === 'midi-upload') await midiUploadRef.current?.discard(context.sessionId)
    else await MidiCapture.clearRecovery(context.sessionId)
    await api.discardSession(context.sessionId).catch(() => {})
    clearStoredRecoveryContext(context.sessionId)
    sendWorkflow({ type: 'CAPTURE_DISCARDED' })
    setRecoveredEvents([]); setRecoveryContext(null); setCursor(null)
    if (context.kind === 'baseline') {
      setSessionId(null)
    } else {
      setRetrySessionId(null)
      if (!baselineReport) sendWorkflow({ type: 'OPEN_IMPORT' })
    }
    setAlert({ type: 'info', msg: t('recoveryDiscarded') })
  }

  const refreshMidiInputs = async () => {
    try {
      const names = await captureRef.current!.requestAccess()
      setInputs(names)
      setAlert({ type: names.length ? 'info' : 'warn',
        msg: names.length ? t('rescanFound') : t('rescanEmpty') })
    } catch (error) {
      setAlert({ type: 'warn', msg: tf('reconnectFailed', { detail: (error as Error).message }) })
    }
  }

  const chooseInputSource = (source: InputSource) => {
    if (loading || recording || workflow.phase === 'analysis') return
    setInputSource(source)
    setUploadModeState(source === 'midi-upload')
    setAlert(null)
    if (source === 'midi-upload') sendWorkflow({ type: 'DEVICE_CONNECTED' })
    if (source === 'web-midi' && selectedInput) sendWorkflow({ type: 'DEVICE_CONNECTED' })
    if (source === 'microphone' && microphoneState === 'ready') {
      sendWorkflow({ type: 'DEVICE_CONNECTED' })
    }
  }

  const connectMicrophone = async (deviceId = selectedMicrophoneId || undefined) => {
    const requestId = ++microphoneConnectRequestRef.current
    setLoading(true); setAlert(null)
    setMicrophoneError(null)
    try {
      const devices = await microphoneRef.current!.connect(deviceId)
      if (requestId !== microphoneConnectRequestRef.current) return
      setMicrophoneDevices(devices)
      const selected = deviceId && devices.some((device) => device.id === deviceId)
        ? deviceId : devices[0]?.id ?? ''
      setSelectedMicrophoneId(selected)
      sendWorkflow({ type: 'DEVICE_CONNECTED' })
      const previewWarning = microphoneRef.current?.previewWarning
      setAlert({
        type: previewWarning ? 'info' : 'success',
        msg: previewWarning
          ? tf('microphoneReadyWithPreviewWarning', { detail: previewWarning })
          : t('microphoneReady'),
      })
    } catch (error) {
      if (requestId !== microphoneConnectRequestRef.current) return
      const state = microphoneRef.current?.state
      const detail = (error as Error).message
      setMicrophoneError(detail)
      setAlert({
        type: 'warn',
        msg: state === 'permission-denied'
          ? t('microphonePermissionDenied')
          : tf('reconnectFailed', { detail }),
      })
    } finally {
      if (requestId === microphoneConnectRequestRef.current) setLoading(false)
    }
  }

  const cancelMicrophoneConnect = () => {
    microphoneConnectRequestRef.current += 1
    microphoneRef.current?.cancelConnect()
    setLoading(false)
    setMicrophoneError(null)
    setAlert({ type: 'info', msg: t('microphoneRequestCancelled') })
  }

  const discardActiveCapture = async () => {
    const activeSessionId = workflow.capture === 'retry' ? retrySessionId : sessionId
    if (!activeSessionId) return
    if (recording && inputSource === 'microphone') {
      await microphoneRef.current?.cancelTake(activeSessionId)
    } else if (recording) captureRef.current?.stopCapture({ persist: false })
    liveTempoHookRef.current = null; playerRef.current?.stop()
    await api.discardSession(activeSessionId).catch(() => {})
    if (inputSource === 'microphone') await microphoneRef.current?.discard(activeSessionId)
    else if (inputSource === 'midi-upload') await midiUploadRef.current?.discard(activeSessionId)
    else await MidiCapture.clearRecovery(activeSessionId)
    clearStoredRecoveryContext(activeSessionId)
    recordingRef.current = false
    setRecording(false); setCursor(null); setRecoveredEvents([]); setRecoveryContext(null)
    setSubmissionStage('idle')
    if (workflow.capture === 'retry') setRetrySessionId(null)
    else setSessionId(null)
    sendWorkflow({ type: 'CAPTURE_DISCARDED' })
    setAlert({ type: 'info', msg: t('captureDiscarded') })
  }

  const discardCaptureAndReturnToScores = async () => {
    setLoading(true)
    try {
      await discardActiveCapture()
      resetPracticeBlock()
      sendWorkflow(scoreId ? { type: 'SCORE_SELECTED' } : { type: 'OPEN_IMPORT' })
      setAlert({ type: 'info', msg: t('returnedToScoresAfterDiscard') })
    } finally {
      setLoading(false)
    }
  }

  const rangeValid = !!meta && Number.isInteger(rangeStart) && Number.isInteger(rangeEnd) &&
    rangeStart >= 1 && rangeEnd >= rangeStart && rangeEnd <= meta.measureCount

  // ---- 选曲 ----
  const selectScore = async (id: string) => {
    const requestId = ++scoreLoadRequestRef.current
    setLoading(true); setAlert(null)
    try {
      const r = await api.getScore(id)
      if (requestId !== scoreLoadRequestRef.current) return
      resetPracticeBlock()
      setScoreId(id); setMeta(r.metadata); setEvents(r.scoreEvents)
      setScoreDetail(r); setNormalization(r.normalization)
      const opening = openingRange(r.metadata.measureCount)
      setRangeStart(opening.start); setRangeEnd(opening.end)
      sendWorkflow({ type: 'SCORE_SELECTED' })
    } catch (e) {
      if (requestId === scoreLoadRequestRef.current) {
        setAlert({ type: 'error', msg: tf('scoreLoadFailed', { detail: (e as Error).message }) })
      }
    }
    if (requestId === scoreLoadRequestRef.current) setLoading(false)
  }

  const importScore = async (file: File) => {
    const requestId = ++scoreLoadRequestRef.current
    setLoading(true); setAlert(null)
    // Reading a page takes tens of seconds, which is long enough that silence
    // reads as a hang. Say what is happening before the wait, not after it.
    if (READ_FROM_PAGE_SUFFIXES.test(file.name)) {
      setAlert({ type: 'info', msg: t('uploadScoreReading') })
    }
    try {
      const r = await api.importScore(file)
      if (requestId !== scoreLoadRequestRef.current) return
      resetPracticeBlock()
      setScores((s) => [...s.filter((x) => x.scoreId !== r.scoreId), {
        ...r.metadata, builtin: false, generated: false, lineageDepth: 0,
        libraryCategory: r.libraryCategory ?? 'uploaded',
        sourceName: r.sourceName ?? file.name,
      }])
      setScoreId(r.scoreId); setMeta(r.metadata); setEvents(r.scoreEvents)
      setScoreDetail(r); setNormalization(r.normalization)
      const opening = openingRange(r.metadata.measureCount)
      setRangeStart(opening.start); setRangeEnd(opening.end)
      sendWorkflow({ type: 'SCORE_SELECTED' })
      setAlert({ type: 'success', msg: tf('scoreImported', { title: r.metadata.title }) })
    } catch (e) {
      if (requestId === scoreLoadRequestRef.current) {
        const err = e as Error & { code?: string }
        setAlert({ type: 'error', msg: err.code === 'SCORE_UNSUPPORTED' ? err.message : tf('scoreImportFailed', { detail: err.message }) })
      }
    }
    if (requestId === scoreLoadRequestRef.current) setLoading(false)
  }

  const confirmNormalization = async () => {
    if (!scoreId || !normalization || scoreDetail?.sourceType !== 'midi') return
    setLoading(true); setAlert(null)
    try {
      const detail = await api.confirmNormalization(scoreId, normalization)
      setScoreDetail(detail); setNormalization(detail.normalization)
      setMeta(detail.metadata); setEvents(detail.scoreEvents)
      setRangeEnd(Math.min(rangeEnd, detail.metadata.measureCount))
      setAlert({ type: 'success', msg: t('normalizationSaved') })
    } catch (error) {
      setAlert({ type: 'error', msg: tf('normalizationSaveFailed', { detail: (error as Error).message }) })
    }
    setLoading(false)
  }

  const gotoCalibrate = async () => {
    if (!scoreId) return
    if (!rangeValid) {
      setAlert({ type: 'warn', msg: tf('invalidRange', { count: meta?.measureCount ?? 1 }) })
      return
    }
    if (scoreDetail?.sourceType === 'midi' && !normalization?.confirmed) {
      setAlert({ type: 'warn', msg: t('confirmNormalizationFirst') })
      return
    }
    getPlayer()
    sendWorkflow({ type: 'START_DEVICE_SETUP' }); setAlert(null); setLiveNotes([])
    setCalibration({ noteCount: 0, centerC: false, lastPitch: null, lastVelocity: null,
      jitterMs: null, duplicateMessages: 0 })
    if (inputSource === 'microphone' || inputSource === 'midi-upload') return
    setLoading(true)
    try {
      const names = await captureRef.current!.requestAccess()
      setInputs(names); setMidiSupported(true)
      if (names.length === 0) {
        setAlert({ type: 'warn', msg: t('noMidiFallback') })
        setUploadMode(true)
      }
    } catch (e) {
      setMidiSupported(false); setUploadMode(true)
      setAlert({ type: 'warn', msg: t('midiPermissionFallback') })
    } finally {
      setLoading(false)
    }
  }

  const pickInput = (name: string) => {
    if (loading || recording) return
    if (captureRef.current!.selectInput(name)) {
      selectedInputRef.current = name
      setSelectedInput(name); setUploadMode(false)
      sendWorkflow({ type: 'DEVICE_CONNECTED' })
      setAlert({ type: 'info', msg: tf('deviceSelected', { name }) })
    }
  }

  // ---- 创建会话 + 进入演奏 ----
  const startSession = async () => {
    if (!scoreId || !meta) return
    if (sessionStartInFlightRef.current) return
    if (inputSource === 'web-midi' && !selectedInput) {
      setAlert({ type: 'warn', msg: t('chooseMidiOrUpload') })
      return
    }
    if (inputSource === 'microphone' && microphoneState !== 'ready') {
      setAlert({ type: 'warn', msg: t('microphoneConnect') })
      return
    }
    sessionStartInFlightRef.current = true
    setLoading(true); setAlert(null); setSubmissionStage('idle')
    let countInPlayer: MidiPlayer | null = null
    let audioReady = inputSource === 'midi-upload'
    if (inputSource !== 'midi-upload') {
      try {
        countInPlayer = getPlayer()
        await countInPlayer.unlock()
        audioReady = true
      } catch { /* 会话仍可录制，稍后给出无预备拍提示 */ }
    }
    try {
      const device = inputSource === 'midi-upload' ? 'midi-file'
        : inputSource === 'microphone' ? (selectedMicrophoneId || 'microphone')
          : selectedInput!
      const r = await api.createSession(
        scoreId, rangeStart, rangeEnd, device, inputSource, instrument)
      setSessionId(r.sessionId)
      uploadMidiRef.current = null
      setCaptureMeta(undefined)
      setCursor(null); setLiveNotes([]); setRecording(false)
      if (inputSource === 'midi-upload') {
        midiUploadRef.current!.start(r.sessionId, instrument)
        sendWorkflow({ type: 'CAPTURE_STARTED', kind: 'baseline' })
        writeRecoveryContext({
          kind: 'baseline', sessionId: r.sessionId, scoreId,
          rangeStart, rangeEnd, inputSource, instrument, savedAt: Date.now(),
        })
      } else {
        sendWorkflow({ type: 'COUNT_IN_STARTED' })
        if (inputSource === 'web-midi') {
          captureRef.current!.onGroup = (group) => {
            observeLiveInput(group.pitches, group.tOnMs)
          }
        }
        setAlert({ type: 'info', msg: tf('countInStarts', { beats: r.countIn.beats }) })
        try {
          if (!audioReady || !countInPlayer) throw new Error(t('audioContextUnavailable'))
          await countInPlayer.countIn(r.countIn.beats, r.countIn.bpm)
        } catch {
          setAlert({ type: 'warn', msg: t('countInUnavailable') })
        }
        prepareLiveFeedback(
          events, rangeStart, rangeEnd, meta.beatsPerMeasure, meta.tempo,
          inputSource === 'microphone' ? 'microphone' : 'web-midi',
        )
        recordingRef.current = true
        if (inputSource === 'microphone') {
          microphoneRef.current!.start(r.sessionId, instrument)
        } else {
          captureRef.current!.startCapture(r.sessionId)
        }
        sendWorkflow({ type: 'CAPTURE_STARTED', kind: 'baseline' })
        writeRecoveryContext({
          kind: 'baseline', sessionId: r.sessionId, scoreId,
          rangeStart, rangeEnd, inputSource, instrument, savedAt: Date.now(),
        })
        setRecording(true)
        setAlert({
          type: 'info',
          msg: inputSource === 'microphone'
            ? t('microphoneRecording') : t('recordingDeterministic'),
        })
      }
    } catch (e) {
      recordingRef.current = false
      setRecording(false)
      setAlert({ type: 'error', msg: tf('createSessionFailed', { detail: (e as Error).message }) })
    } finally {
      sessionStartInFlightRef.current = false
      setLoading(false)
    }
  }

  // ---- 上传 MIDI 降级 ----
  const onUploadMidi = async (file: File) => {
    if (!sessionId) return
    uploadMidiRef.current = null
    setLoading(true); setAlert(null)
    try {
      const r = await midiUploadRef.current!.upload(file)
      setAlert({ type: 'success', msg: tf('midiUploaded', { name: file.name }) })
      uploadMidiRef.current = r.uploadedMidiRef ?? null
      const context = readRecoveryContext()
      if (context?.sessionId === sessionId && r.uploadedMidiRef) {
        const updated = {
          ...context, uploadedMidiRef: r.uploadedMidiRef,
          uploadedFileName: file.name, savedAt: Date.now(),
        }
        writeRecoveryContext(updated)
        setRecoveryContext(updated)
      }
    } catch (e) { setAlert({ type: 'error', msg: tf('uploadFailed', { detail: (e as Error).message }) }) }
    setLoading(false)
  }
  // ---- 停止演奏 → 提交分析 ----
  const stopAndAnalyze = async () => {
    if (!sessionId) return
    if (submissionInFlightRef.current) return
    if (inputSource === 'midi-upload' && !uploadMidiRef.current) {
      setAlert({ type: 'warn', msg: t('uploadPerformanceFirst') })
      return
    }
    submissionInFlightRef.current = true
    setLoading(true); setAlert(null)
    setSubmissionStage(inputSource === 'microphone' ? 'transcribing' : 'saving')
    const usingRecoveredEvents = recoveryContext?.kind === 'baseline' && (
      recoveredEvents.length > 0 || (inputSource === 'microphone' && !!captureMeta))
    let eventsToSubmit: PerformanceEvent[] = []
    let midiRef: string | undefined
    let submittedCaptureMeta = captureMeta
    if (inputSource === 'midi-upload' && uploadMidiRef.current) {
      midiRef = uploadMidiRef.current
    } else if (usingRecoveredEvents) {
      eventsToSubmit = recoveredEvents
    } else if (inputSource === 'microphone') {
      recordingRef.current = false
      setRecording(false)
      setTranscriptionProgress(0)
      try {
        const result = await microphoneRef.current!.stop()
        eventsToSubmit = result.events
        submittedCaptureMeta = result.captureMeta
        setCaptureMeta(result.captureMeta)
      } catch (error) {
        submissionInFlightRef.current = false
        setLoading(false)
        const failure = error as Error & { code?: string }
        if (failure.code === 'TRANSCRIPTION_CANCELLED') {
          setSubmissionStage('idle')
          setAlert({ type: 'info', msg: t('transcriptionCancelledSaved') })
        } else {
          setSubmissionStage('error')
          setAlert({ type: 'warn', msg: tf('transcriptionFailed', { detail: failure.message }) })
        }
        return
      }
    } else {
      recordingRef.current = false
      setRecording(false)
      eventsToSubmit = captureRef.current!.stopCapture()
      await captureRef.current!.flushBatches()
    }
    liveTempoHookRef.current = null
    setCursor(null)
    sendWorkflow({ type: 'SUBMIT_CAPTURE' })
    setSubmissionStage('analyzing')
    try {
      const r = await api.finishSession(
        sessionId, eventsToSubmit, midiRef, submittedCaptureMeta)
      const rep = await api.getReport(r.reportId)
      setReport(rep); setBaselineReport(rep)
      setSelectedError(rep.errors[0] ?? null)
      setMentor(null)
      setMentorChat(readMentorChat(rep.reportId))
      sendWorkflow({ type: 'ANALYSIS_COMPLETED' })
      setSubmissionStage('complete')
      if (inputSource === 'microphone') await microphoneRef.current?.discard(sessionId)
      else if (inputSource === 'midi-upload') await midiUploadRef.current?.discard(sessionId)
      else await MidiCapture.clearRecovery(sessionId)
      clearStoredRecoveryContext(sessionId)
      setRecoveredEvents([]); setRecoveryContext(null)
      // 预取导师解释
      void loadMentor(rep, '', rep.errors[0]?.id, false)
    } catch (e) {
      setSubmissionStage('error')
      const err = e as Error & { code?: string }
      if (err.code === 'ALIGNMENT_LOW_CONFIDENCE') {
        setAlert({ type: 'warn', msg: t('lowAlignmentConfidence') })
      } else { setAlert({ type: 'error', msg: tf('analysisFailed', { detail: err.message }) }) }
      sendWorkflow({ type: 'ANALYSIS_FAILED' })
      if (inputSource !== 'midi-upload' && !usingRecoveredEvents) {
        const context = readRecoveryContext()
        if (context && eventsToSubmit.length) {
          setRecoveryContext(context)
          setRecoveredEvents(eventsToSubmit)
        }
      }
    }
    submissionInFlightRef.current = false
    setLoading(false)
  }

  // ---- 导师追问 ----
  const askMentor = async (prompt?: string, retryMessageId?: string) => {
    if (!report || mentorChatLoading) return
    const activeReportId = report.reportId
    const requestId = ++mentorChatRequestRef.current
    const text = (prompt ?? question).trim()
    if (!text) return
    setAlert(null)
    const history = mentorChat
      .filter((message) => message.status === 'sent')
      .map((message) => ({ role: message.role, content: message.text.slice(0, 2_000) }))
      .slice(-10)
    const userId = retryMessageId ?? chatMessageId()
    let pendingMessages = retryMessageId
      ? mentorChat.map((message) => message.id === retryMessageId
        ? { ...message, status: 'sending' as const, error: undefined }
        : message)
      : [...mentorChat, {
          id: userId, role: 'user' as const, text,
          status: 'sending' as const,
        }]
    setMentorChat(pendingMessages)
    writeMentorChat(report.reportId, pendingMessages)
    setMentorChatLoading(true)
    const controller = new AbortController()
    mentorChatAbortRef.current = controller
    try {
      const response = await api.mentorChat(
        report.reportId, text, selectedError?.id, history, controller.signal)
      if (requestId !== mentorChatRequestRef.current || report.reportId !== activeReportId) return
      pendingMessages = [
        ...pendingMessages.map((message) => message.id === userId
          ? { ...message, status: 'sent' as const, error: undefined }
          : message),
        {
          id: chatMessageId(), role: 'assistant' as const,
          text: response.answer, status: 'sent' as const, response,
        },
      ]
      setMentorChat(pendingMessages)
      writeMentorChat(report.reportId, pendingMessages)
      if (response.memory) setMentorMemory(response.memory)
      if (!prompt) setQuestion('')
    } catch (error) {
      if (requestId !== mentorChatRequestRef.current) return
      const detail = (error as Error).message
      pendingMessages = pendingMessages.map((message) => message.id === userId
        ? { ...message, status: 'error' as const, error: detail }
        : message)
      setMentorChat(pendingMessages)
      writeMentorChat(report.reportId, pendingMessages)
      setAlert({ type: 'warn', msg: tf('mentorUnavailableWithDetail', { detail }) })
    } finally {
      if (mentorChatAbortRef.current === controller) mentorChatAbortRef.current = null
      if (requestId === mentorChatRequestRef.current) setMentorChatLoading(false)
    }
  }

  const forgetMentorMemory = async () => {
    if (!report) return
    try {
      await api.forgetMentorMemory(report.reportId)
      setMentorChat([])
      writeMentorChat(report.reportId, [])
      setMentorMemory((previous) => ({
        enabled: true,
        scopeId: previous?.scopeId ?? `score:${report.scoreId}`,
        rememberedTurnCount: 0,
        updatedAt: null,
      }))
      setAlert({ type: 'info', msg: t('mentorMemoryForgotten') })
    } catch (error) {
      setAlert({
        type: 'warn',
        msg: tf('mentorMemoryForgetFailed', { detail: (error as Error).message }),
      })
    }
  }

  const applyChatAction = (response: MentorChatResponse, actionIndex: number) => {
    const action = response.actions[actionIndex]
    if (!action || !report) return
    if (action.type === 'select_error' && action.errorId) {
      const error = report.errors.find((item) => item.id === action.errorId)
      if (error) chooseError(report, error)
      return
    }
    if (action.type === 'generate_exercise') {
      if (action.errorId) {
        const error = report.errors.find((item) => item.id === action.errorId)
        if (error) setSelectedError(error)
      }
      setBaselineReport(report)
      setExercise(null)
      setExerciseScore(null)
      setComparison(null)
      setExerciseStage('design')
      sendWorkflow({ type: 'EXERCISE_OPENED' })
      return
    }
    if (action.type === 'retry') setStep(exercise ? 'compare' : 'calibrate')
  }

  // ---- 生成练习 ----
  const genExercise = async () => {
    if (!report) return
    const requestId = ++exerciseRequestRef.current
    const sourceReportId = report.reportId
    const sourceScoreId = report.scoreId
    setLoading(true); setAlert(null)
    try {
      const r = await api.createExercise(report.reportId,
        selectedError ? [selectedError.id] : [],
        { strategy, tempoRatio, loopCount, hands }, generationNote, true)
      if (!r.practiceScoreId) throw new Error(t('exerciseScoreUnavailable'))
      const generatedScore = await api.getScore(r.practiceScoreId)
      if (requestId !== exerciseRequestRef.current ||
          report.reportId !== sourceReportId || report.scoreId !== sourceScoreId) return
      setExercise(r)
      setExerciseScore(generatedScore)
      setBaselineReport(report)
      setComparison(null)
      setScores((previous) => [
        ...previous.filter((item) => item.scoreId !== generatedScore.scoreId),
        {
          ...generatedScore.metadata, builtin: false, generated: true,
          lineageDepth: generatedScore.lineageDepth ?? r.lineageDepth ?? 1,
          libraryCategory: generatedScore.libraryCategory ?? 'generated',
          sourceName: generatedScore.sourceName,
        },
      ])
      if (r.aiPlan) {
        setStrategy(r.aiPlan.strategy)
        setTempoRatio(r.aiPlan.tempoRatio)
        setLoopCount(r.aiPlan.loopCount)
        setHands(r.aiPlan.hands)
      }
      setExerciseStage('generated')
      const strategyLabel = EXERCISE_STRATEGIES.find(([key]) => key === r.ruleId)?.[1] || r.ruleId
      setAlert({ type: 'success', msg: tf('exerciseGenerated', {
        rule: strategyLabel, measures: measureLabelList(r.sourceMeasures, '-'),
      }) })
    } catch (e) {
      if (requestId === exerciseRequestRef.current) {
        setAlert({ type: 'error', msg: tf('exerciseFailed', { detail: (e as Error).message }) })
      }
    }
    if (requestId === exerciseRequestRef.current) setLoading(false)
  }

  const playExercise = async () => {
    if (!exercise) return
    setPlaying(true)
    try {
      const player = getPlayer()
      await player.unlock()
      const midi = await player.loadMidi(exercise.midiUrl)
      await player.play(midi, { onEnd: () => setPlaying(false) })
    } catch (error) {
      setPlaying(false)
      setAlert({ type: 'error', msg: tf('exercisePlaybackFailed', { detail: (error as Error).message }) })
    }
  }

  const playEvidence = async (text: string) => {
    try {
      await ensureAudio()
      const pitches = parsePitchNames(text)
      if (pitches.length) await playPitches(pitches)
    } catch (error) {
      setAlert({ type: 'warn', msg: tf('evidencePlaybackFailed', { detail: (error as Error).message }) })
    }
  }

  const leaveExercise = (nextStep: Step) => {
    playerRef.current?.stop()
    setPlaying(false)
    setStep(nextStep)
  }

  // ---- 伴奏 + 再次演奏 → 对比 ----
  const startAccompaniment = async () => {
    if (!baselineReport) return
    if (sessionStartInFlightRef.current) return
    if (!exercise) {
      setAlert({ type: 'warn', msg: t('generateExerciseBeforeRetry') })
      setStep('exercise')
      return
    }
    if (inputSource === 'web-midi' && !selectedInput) {
      setAlert({ type: 'warn', msg: t('midiReconnectRequired') })
      return
    }
    if (inputSource === 'microphone' && microphoneState !== 'ready') {
      setAlert({ type: 'warn', msg: t('microphoneConnect') })
      return
    }
    sessionStartInFlightRef.current = true
    setLoading(true); setAlert(null); setSubmissionStage('idle')
    setPlaying(false)
    setComparison(null); setCursor(null); setRetryTempo(null); setRetryUploadName(null)
    retryUploadMidiRef.current = null
    liveTempoHookRef.current = null
    let captureStarted = false
    let createdSessionId: string | null = null
    try {
      if (!exercise.practiceScoreId) throw new Error(t('exerciseScoreUnavailable'))
      const targetScore = exerciseScore?.scoreId === exercise.practiceScoreId
        ? exerciseScore
        : await api.getScore(exercise.practiceScoreId)
      setExerciseScore(targetScore)
      const retryRangeStart = 1
      const retryRangeEnd = targetScore.metadata.measureCount
      const accompanimentAllowed = inputSource !== 'microphone' || headphonesConfirmed
      const player = accompanimentAllowed ? getPlayer() : null
      if (player) await player.unlock()
      const s = await api.createSession(
        targetScore.scoreId, retryRangeStart, retryRangeEnd,
        inputSource === 'midi-upload' ? 'midi-file'
          : inputSource === 'microphone' ? (selectedMicrophoneId || 'microphone')
            : selectedInput!,
        inputSource, instrument,
      )
      createdSessionId = s.sessionId
      setRetrySessionId(s.sessionId)
      setCaptureMeta(undefined)
      sendWorkflow({ type: 'RETRY_STARTED' })
      const acc = accompanimentAllowed
        ? await api.createAccompaniment(
            targetScore.scoreId, retryRangeStart, retryRangeEnd, accMode)
        : null
      const midi = acc && player ? await player.loadMidi(acc.midiUrl) : null
      accompanimentBpmRef.current = acc?.baseTempo ?? targetScore.metadata.tempo
      lastTempoMeasureRef.current = null
      setRetryTempo(acc?.baseTempo ?? null)
      if (inputSource !== 'midi-upload') {
        prepareLiveFeedback(
          targetScore.scoreEvents, retryRangeStart, retryRangeEnd,
          targetScore.metadata.beatsPerMeasure, targetScore.metadata.tempo,
          inputSource === 'microphone' ? 'microphone' : 'web-midi',
        )
        recordingRef.current = true
      }
      if (inputSource === 'web-midi') {
        // Flexible accompaniment follows the tempo the player is holding, once
        // per bar so it bends with them rather than chasing every note.
        liveTempoHookRef.current = (state, bpm) => {
          const measure = state.target?.measureNo
          if (measure == null) return
          if (lastTempoMeasureRef.current === null) {
            lastTempoMeasureRef.current = measure
            return
          }
          if (measure === lastTempoMeasureRef.current) return
          lastTempoMeasureRef.current = measure
          if (accMode !== 'flexible' || state.blocked || !(bpm > 0)) return
          const next = player!.followTempo(accompanimentBpmRef.current, bpm)
          accompanimentBpmRef.current = next
          player!.setBpm(next)
          setRetryTempo(Math.round(next * 10) / 10)
        }
        captureRef.current!.onGroup = (group) => {
          observeLiveInput(group.pitches, group.tOnMs)
        }
        captureRef.current!.startCapture(s.sessionId)
        sendWorkflow({ type: 'CAPTURE_STARTED', kind: 'retry' })
        writeRecoveryContext({
          kind: 'retry', sessionId: s.sessionId, scoreId: targetScore.scoreId,
          rangeStart: retryRangeStart, rangeEnd: retryRangeEnd,
          baselineReportId: baselineReport.reportId, exerciseId: exercise.exerciseId,
          inputSource, instrument, savedAt: Date.now(),
        })
        captureStarted = true
        setRecording(true)
      } else if (inputSource === 'microphone') {
        microphoneRef.current!.start(s.sessionId, instrument)
        sendWorkflow({ type: 'CAPTURE_STARTED', kind: 'retry' })
        writeRecoveryContext({
          kind: 'retry', sessionId: s.sessionId, scoreId: targetScore.scoreId,
          rangeStart: retryRangeStart, rangeEnd: retryRangeEnd,
          baselineReportId: baselineReport.reportId, exerciseId: exercise.exerciseId,
          inputSource, instrument, savedAt: Date.now(),
        })
        captureStarted = true
        setRecording(true)
      } else {
        midiUploadRef.current!.start(s.sessionId, instrument)
        sendWorkflow({ type: 'CAPTURE_STARTED', kind: 'retry' })
        writeRecoveryContext({
          kind: 'retry', sessionId: s.sessionId, scoreId: targetScore.scoreId,
          rangeStart: retryRangeStart, rangeEnd: retryRangeEnd,
          baselineReportId: baselineReport.reportId, exerciseId: exercise.exerciseId,
          inputSource, instrument, savedAt: Date.now(),
        })
      }
      if (midi && player) {
        await player.play(midi, {
          volume: -10,
          onEnd: () => setAlert({ type: 'info', msg: t('accompanimentEnded') }),
        })
      }
      setAlert({
        type: 'info',
        msg: inputSource === 'microphone' && !headphonesConfirmed
          ? t('microphoneRecording')
          : uploadMode
          ? t('accompanimentUploadStarted')
          : tf('accompanimentStarted', {
              mode: accMode === 'flexible' ? t('flexibleTempoDescription') : t('fixedTempoDescription'),
            }),
      })
    } catch (e) {
      if (captureStarted && inputSource === 'microphone' && createdSessionId) {
        await microphoneRef.current?.cancelTake(createdSessionId)
      } else if (captureStarted) captureRef.current!.stopCapture({ persist: false })
      if (createdSessionId) {
        await api.discardSession(createdSessionId).catch(() => {})
        if (inputSource === 'microphone') await microphoneRef.current?.discard(createdSessionId)
        else if (inputSource === 'midi-upload') await midiUploadRef.current?.discard(createdSessionId)
        else await MidiCapture.clearRecovery(createdSessionId)
        clearStoredRecoveryContext(createdSessionId)
      }
      liveTempoHookRef.current = null; playerRef.current?.stop()
      recordingRef.current = false
      setRecording(false); setRetrySessionId(null)
      sendWorkflow({ type: 'CAPTURE_DISCARDED' })
      setAlert({ type: 'error', msg: tf('accompanimentFailed', { detail: (e as Error).message }) })
    } finally {
      sessionStartInFlightRef.current = false
      setLoading(false)
    }
  }

  const onUploadRetryMidi = async (file: File) => {
    if (!retrySessionId) return
    retryUploadMidiRef.current = null
    setRetryUploadName(null)
    setLoading(true); setAlert(null)
    try {
      const result = await midiUploadRef.current!.upload(file)
      retryUploadMidiRef.current = result.uploadedMidiRef ?? null
      setRetryUploadName(file.name)
      const context = readRecoveryContext()
      if (context?.sessionId === retrySessionId && result.uploadedMidiRef) {
        const updated = {
          ...context, uploadedMidiRef: result.uploadedMidiRef,
          uploadedFileName: file.name, savedAt: Date.now(),
        }
        writeRecoveryContext(updated)
        setRecoveryContext(updated)
      }
      setAlert({ type: 'success', msg: tf('retryMidiUploaded', { name: file.name }) })
    } catch (error) {
      setAlert({ type: 'error', msg: tf('retryMidiUploadFailed', { detail: (error as Error).message }) })
    }
    setLoading(false)
  }

  const cancelRetry = async () => {
    const activeSessionId = retrySessionId
    setLoading(true)
    if (recording && inputSource === 'microphone' && activeSessionId) {
      await microphoneRef.current?.cancelTake(activeSessionId)
    } else if (recording) captureRef.current?.stopCapture({ persist: false })
    playerRef.current?.stop(); liveTempoHookRef.current = null
    if (activeSessionId) {
      await api.discardSession(activeSessionId).catch(() => {})
      if (inputSource === 'microphone') await microphoneRef.current?.discard(activeSessionId)
      else if (inputSource === 'midi-upload') await midiUploadRef.current?.discard(activeSessionId)
      else await MidiCapture.clearRecovery(activeSessionId)
      clearStoredRecoveryContext(activeSessionId)
    }
    recordingRef.current = false
    setRecording(false); setRetrySessionId(null); setRetryTempo(null); setCursor(null)
    setSubmissionStage('idle')
    setRecoveredEvents([]); setRecoveryContext(null); setRetryUploadName(null)
    retryUploadMidiRef.current = null
    sendWorkflow({ type: 'CAPTURE_DISCARDED' })
    setLoading(false)
    setAlert({ type: 'info', msg: t('retryCancelled') })
  }

  const stopRetryAndCompare = async () => {
    if (!retrySessionId || !baselineReport) return
    if (submissionInFlightRef.current) return
    if (inputSource === 'midi-upload' && !retryUploadMidiRef.current) {
      setAlert({ type: 'warn', msg: t('uploadFreshRetryFirst') })
      return
    }
    submissionInFlightRef.current = true
    setLoading(true); setAlert(null)
    setSubmissionStage(inputSource === 'microphone' ? 'transcribing' : 'saving')
    const usingRecoveredEvents = recoveryContext?.kind === 'retry' && (
      recoveredEvents.length > 0 || (inputSource === 'microphone' && !!captureMeta))
    let ev: PerformanceEvent[] = []
    let ref: string | undefined
    let retryCaptureMeta = captureMeta
    if (inputSource === 'midi-upload' && retryUploadMidiRef.current) {
      ref = retryUploadMidiRef.current
    } else if (usingRecoveredEvents) {
      ev = recoveredEvents
    } else if (inputSource === 'microphone') {
      recordingRef.current = false
      setRecording(false)
      setTranscriptionProgress(0)
      try {
        const result = await microphoneRef.current!.stop()
        ev = result.events
        retryCaptureMeta = result.captureMeta
        setCaptureMeta(result.captureMeta)
      } catch (error) {
        submissionInFlightRef.current = false
        setLoading(false)
        const failure = error as Error & { code?: string }
        if (failure.code === 'TRANSCRIPTION_CANCELLED') {
          setSubmissionStage('idle')
          setAlert({ type: 'info', msg: t('transcriptionCancelledSaved') })
        } else {
          setSubmissionStage('error')
          setAlert({ type: 'warn', msg: tf('transcriptionFailed', { detail: failure.message }) })
        }
        return
      }
    } else {
      recordingRef.current = false
      setRecording(false)
      ev = captureRef.current!.stopCapture()
      await captureRef.current!.flushBatches()
    }
    playerRef.current?.stop()
    liveTempoHookRef.current = null
    sendWorkflow({ type: 'SUBMIT_CAPTURE' })
    setSubmissionStage('analyzing')
    try {
      const r = await api.finishSession(retrySessionId, ev, ref, retryCaptureMeta)
      const [comp, rep2] = await Promise.all([
        api.compare(baselineReport.reportId, r.reportId),
        api.getReport(r.reportId),
      ])
      const completedScore = exerciseScore?.scoreId === rep2.scoreId
        ? exerciseScore
        : await api.getScore(rep2.scoreId)
      setComparison(comp)
      setReport(rep2)
      setScoreId(completedScore.scoreId)
      setMeta(completedScore.metadata)
      setEvents(completedScore.scoreEvents)
      setScoreDetail(completedScore)
      setNormalization(completedScore.normalization)
      setExerciseScore(completedScore)
      setSelectedError(rep2.errors[0] ?? null)
      setMentor(null)
      setMentorChat(readMentorChat(rep2.reportId))
      if (inputSource === 'microphone') await microphoneRef.current?.discard(retrySessionId)
      else if (inputSource === 'midi-upload') await midiUploadRef.current?.discard(retrySessionId)
      else await MidiCapture.clearRecovery(retrySessionId)
      clearStoredRecoveryContext(retrySessionId)
      setRecoveredEvents([]); setRecoveryContext(null)
      sendWorkflow({ type: 'COMPARISON_COMPLETED' })
      setSubmissionStage('complete')
      void loadMentor(rep2, '', rep2.errors[0]?.id, false)
    } catch (e) {
      setSubmissionStage('error')
      if (inputSource !== 'midi-upload' && !usingRecoveredEvents) {
        const context = readRecoveryContext()
        if (context && ev.length) {
          setRecoveryContext(context)
          setRecoveredEvents(ev)
        }
      }
      sendWorkflow({ type: 'ANALYSIS_FAILED' })
      setAlert({ type: 'error', msg: tf('comparisonFailed', { detail: (e as Error).message }) })
    }
    submissionInFlightRef.current = false
    setLoading(false)
  }

  const continueFromCurrentRound = () => {
    if (!report) return
    setBaselineReport(report)
    setComparison(null)
    setExercise(null)
    setExerciseScore(null)
    setExerciseStage('design')
    setStrategy('auto')
    setRetrySessionId(null)
    setRetryTempo(null)
    setCursor(null)
    sendWorkflow({ type: 'EXERCISE_OPENED' })
  }

  const openExerciseDesigner = () => {
    if (!report) return
    setBaselineReport(report)
    setExercise(null)
    setExerciseScore(null)
    setComparison(null)
    setRetrySessionId(null)
    setExerciseStage('design')
    sendWorkflow({ type: 'EXERCISE_OPENED' })
  }

  const resolvedKeys = useMemoResolvedKeys(comparison)
  const hasBaselineRecovery = recoveryContext?.kind === 'baseline' && recoveredEvents.length > 0
  const hasRetryRecovery = recoveryContext?.kind === 'retry' && recoveredEvents.length > 0
  const retryScoreXmlUrl = exerciseScore?.renderUrl ?? null
  const retryScoreMeta = exerciseScore?.metadata ?? null
  const activeCaptureSessionId = workflow.capture === 'retry' ? retrySessionId : sessionId
  const hasSavedMicrophoneTake = inputSource === 'microphone' && !recording &&
    microphoneState !== 'transcribing' &&
    Boolean(microphoneRef.current?.hasTake(activeCaptureSessionId))
  const studioStage: StudioStage = step === 'select' ? 'score'
    : step === 'calibrate' ? 'input'
      : step === 'perform' ? 'perform' : 'coach'
  const canOpenStudioStage = (stage: StudioStage) => {
    if (loading || workflow.phase === 'count_in' || workflow.phase === 'analysis') {
      return stage === studioStage
    }
    if (workflow.capture !== null) {
      return stage === studioStage || (stage === 'score' && hasSavedMicrophoneTake)
    }
    if (stage === 'score') return true
    if (stage === 'input') return Boolean(scoreId)
    if (stage === 'perform') return Boolean(sessionId) && step === 'perform'
    return Boolean(report)
  }
  const openStudioStage = (stage: StudioStage) => {
    if (!canOpenStudioStage(stage)) return
    if (stage === 'score') {
      if (workflow.capture !== null) {
        if (!hasSavedMicrophoneTake || !window.confirm(t('discardTakeReturnConfirm'))) return
        void discardCaptureAndReturnToScores()
        return
      }
      const openSessions = [sessionId, retrySessionId].filter(
        (value): value is string => Boolean(value))
      openSessions.forEach((activeSessionId) => {
        void api.discardSession(activeSessionId).catch(() => {})
      })
      resetPracticeBlock()
      sendWorkflow(scoreId ? { type: 'SCORE_SELECTED' } : { type: 'OPEN_IMPORT' })
    }
    else if (stage === 'input') setStep('calibrate')
    else if (stage === 'perform') setStep('perform')
    else setStep('report')
  }
  const clearGeneratedExercises = async () => {
    if (!window.confirm(t('clearGeneratedExercisesConfirm'))) return
    setLoading(true); setAlert(null)
    try {
      const selectedWasGenerated = scores.some((item) =>
        item.scoreId === scoreId && categoryForScore(item) === 'generated')
      const result = await api.clearGeneratedScores()
      resetPracticeBlock()
      setScores((previous) => previous.filter(
        (item) => categoryForScore(item) !== 'generated'))
      if (selectedWasGenerated) {
        setScoreId(null); setScoreDetail(null); setNormalization(null)
        setMeta(null); setEvents([])
        sendWorkflow({ type: 'RESET' })
      } else {
        sendWorkflow(scoreId ? { type: 'SCORE_SELECTED' } : { type: 'OPEN_IMPORT' })
      }
      setAlert({
        type: 'success',
        msg: tf('generatedExercisesCleared', { count: result.clearedCount }),
      })
    } catch (error) {
      setAlert({
        type: 'error',
        msg: tf('generatedExercisesClearFailed', { detail: (error as Error).message }),
      })
    }
    setLoading(false)
  }
  const scoreLibrary = partitionScoreLibrary(scores)
  const renderScoreCard = (score: ScoreListItem, compact = false) => {
    const category = categoryForScore(score)
    const displayTitle = category === 'generated'
      ? tf('generatedLibraryItemTitle', { round: score.lineageDepth ?? 1 })
      : scoreDisplayTitle(score)
    return (
      <button type="button" key={score.scoreId}
              aria-pressed={scoreId === score.scoreId}
              className={`score-card ${compact ? 'compact' : ''} ${scoreId === score.scoreId ? 'selected' : ''}`}
              onClick={() => selectScore(score.scoreId)}>
        <div className="title">
          <span className="score-title-text">{displayTitle}</span>
          {category === 'demo' && <span className="tag">{t('demoTag')}</span>}
          {category === 'uploaded' && <span className="tag uploaded">{t('uploadedTag')}</span>}
          {category === 'generated' && <span className="tag generated">{t('aiGeneratedTag')}</span>}
        </div>
        <div className="meta">{tf('scoreMeta', {
          measures: score.measureCount, tempo: score.tempo, meter: score.timeSignature,
        })}</div>
      </button>
    )
  }

  const [uiScale, setUiScale] = useUiScale()

  return (
    <div className="app">
      <div className="header">
        <h1>{t('appName')}</h1>
        <span className="subtitle">{t('appSubtitle')}</span>
        <span className="spacer" />
        <ScaleSwitch scale={uiScale} onChange={setUiScale} />
      </div>

      <StudioStepper active={studioStage} canOpen={canOpenStudioStage}
                     onOpen={openStudioStage} />

      <div className="app-body scroll-pane">
      {(scoreDetail?.generated || exerciseScore?.generated) && (
        <div className="round-context" role="status">
          <span>{tf('roundContext', {
            round: exerciseScore?.lineageDepth ?? scoreDetail?.lineageDepth ?? 1,
          })}</span>
          <strong>{exerciseScore?.metadata.title ?? scoreDetail?.metadata.title}</strong>
        </div>
      )}

      {alert && <div role={alert.type === 'error' || alert.type === 'warn' ? 'alert' : 'status'}
                     className={`alert alert-${alert.type}`}>{alert.msg}</div>}
      {workflow.lastRejection === 'CAPTURE_ACTIVE' && (
        <div className="alert alert-warn" role="alert">{t('captureActiveGuard')}</div>
      )}
      {recoveryContext && recoveredEvents.length > 0 && (
        <div className="recovery-banner" role="status">
          <span>{tf('localRecovery', { count: recoveredEvents.length })}</span>
          <button type="button" className="btn btn-sm" onClick={discardRecoveredRecording}
                  disabled={loading}>{t('discardRecovery')}</button>
        </div>
      )}

      <Suspense fallback={<div className="panel score-loading">{t('scoreEngineLoading')}</div>}>
      {/* Step 1: 选曲 */}
      {step === 'select' && (
        <div className={`panel ${scoreDetail ? 'fills-pane' : ''}`}>
          <h2>{t('scorePickerTitle')}</h2>
          <div className={`select-workspace ${scoreDetail ? 'with-detail' : ''}`}>
          <div className="select-library scroll-pane">
          <section className="library-section" aria-labelledby="demo-library-title">
            <div className="library-heading">
              <div>
                <h3 id="demo-library-title">{t('demoLibraryTitle')}</h3>
                <p className="dim">{t('demoLibraryHint')}</p>
              </div>
              <span className="library-count">{scoreLibrary.demos.length}</span>
            </div>
            <div className="score-list">
              {scoreLibrary.demos.map((score) => renderScoreCard(score))}
            </div>
          </section>

          <section className="library-section" aria-labelledby="upload-library-title">
            <div className="library-heading">
              <div>
                <h3 id="upload-library-title">{t('uploadedLibraryTitle')}</h3>
                <p className="dim">{t('uploadedLibraryHint')}</p>
              </div>
              <span className="library-count">{scoreLibrary.uploads.length}</span>
            </div>
            {scoreLibrary.uploads.length > 0 ? (
              <div className="score-list">
                {scoreLibrary.uploads.map((score) => renderScoreCard(score))}
              </div>
            ) : <div className="library-empty">{t('uploadedLibraryEmpty')}</div>}
          </section>

          {scoreLibrary.generated.length > 0 && (
            <details className="generated-library">
              <summary>
                <span className="generated-library-icon" aria-hidden="true">✦</span>
                <span className="generated-library-copy">
                  <strong>{t('generatedLibraryTitle')}</strong>
                  <small>{t('generatedLibraryHint')}</small>
                </span>
                <span className="library-count">{scoreLibrary.generated.length}</span>
              </summary>
              <div className="generated-library-actions">
                <span>{t('clearGeneratedExercisesHint')}</span>
                <button type="button" className="btn btn-danger btn-sm"
                        disabled={loading} onClick={clearGeneratedExercises}>
                  {t('clearGeneratedExercises')}
                </button>
              </div>
              <div className="score-list compact-list">
                {scoreLibrary.generated.map((score) => renderScoreCard(score, true))}
              </div>
            </details>
          )}
          <h3>{t('uploadScoreTitle')}</h3>
          <p className="dim">{t('uploadScoreHint')}</p>
          <UploadZone onFile={importScore}
                      accept=".musicxml,.xml,.mxl,.mid,.midi,.pdf,.png,.jpg,.jpeg,.webp"
                      disabled={loading} />
          </div>
          <div className="select-detail scroll-pane">
          {scoreDetail && normalization && (
            <section className="import-review" aria-labelledby="import-review-title">
              <div className="review-heading">
                <div>
                  <h3 id="import-review-title">{t('importReview')}</h3>
                  <p className="dim">{t('importReviewHint')}</p>
                </div>
                <span className={`display-badge ${
                  scoreDetail.displayMode === 'exact_notation' ? 'exact' : 'simplified'}`}>
                  {scoreDetail.displayMode === 'exact_notation' ? t('exactNotation') : t('simplifiedNotation')}
                </span>
              </div>
              {scoreDetail.displayMode === 'simplified_quantized_staff' && (
                <div className="alert alert-info">
                  {isReadFromPage(scoreDetail) ? t('readNotice') : t('simplifiedNotice')}
                </div>
              )}
              {!!scoreDetail.warnings.length && (
                <ul className="warning-list">
                  {scoreDetail.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                </ul>
              )}
              <div className="review-grid">
                <label>{t('tempoBpm')}
                  <input type="number" min={20} max={300} value={normalization.tempo}
                         disabled={scoreDetail.sourceType !== 'midi'}
                         onChange={(e) => setNormalization({ ...normalization,
                           tempo: Number(e.target.value), confirmed: false })} />
                </label>
                <label>{t('timeSignature')}
                  <input value={normalization.timeSignature}
                         disabled={scoreDetail.sourceType !== 'midi'}
                         onChange={(e) => setNormalization({ ...normalization,
                           timeSignature: e.target.value, confirmed: false })} />
                </label>
                <label>{t('quantizationGrid')}
                  <select value={normalization.quantization}
                          disabled={scoreDetail.sourceType !== 'midi'}
                          onChange={(e) => setNormalization({ ...normalization,
                            quantization: e.target.value as ScoreNormalization['quantization'], confirmed: false })}>
                    {['1/8', '1/12', '1/16', '1/24', '1/32'].map((value) => (
                      <option key={value} value={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <div className="confidence-field">
                  <span>{t('importConfidence')}</span>
                  <strong>{Math.round(scoreDetail.confidence * 100)}%</strong>
                </div>
              </div>
              {scoreDetail.sourceType === 'midi' && Object.entries(normalization.trackMapping).map(([track, hand]) => (
                <label className="track-map" key={track}>{tf('trackNumber', { number: Number(track) + 1 })}
                  <select value={hand} onChange={(e) => setNormalization({
                    ...normalization, confirmed: false,
                    trackMapping: { ...normalization.trackMapping,
                      [track]: e.target.value as ScoreNormalization['trackMapping'][string] },
                  })}>
                    <option value="split">{t('splitAtMiddleC')}</option>
                    <option value="RH">{t('rightHand')}</option>
                    <option value="LH">{t('leftHand')}</option>
                    <option value="ignore">{t('ignore')}</option>
                  </select>
                </label>
              ))}
              {scoreDetail.sourceType === 'midi' && (
                <button className="btn btn-primary btn-sm" onClick={confirmNormalization}
                        disabled={loading || normalization.confirmed}>
                  {normalization.confirmed ? t('normalizationConfirmed') : t('confirmNormalization')}
                </button>
              )}
            </section>
          )}
          {meta && scoreId && (
            <section className="score-preview" aria-label={t('scorePreview')}>
              <div className="score-preview-heading">
                <span className="eyebrow">{t('scorePreview')}</span>
                <small>{tf('scoreMeta', {
                  measures: meta.measureCount, tempo: meta.tempo,
                  meter: meta.timeSignature,
                })}</small>
              </div>
              <div className="score-stage">
                <ScoreViewer xmlUrl={api.scoreXmlUrl(scoreId)}
                             beatsPerMeasure={meta.beatsPerMeasure} height={200} />
              </div>
            </section>
          )}
          {meta && (
            <>
              <h3>{t('practiceRange')}</h3>
              {meta.measureCount > rangeEnd && rangeStart === 1 &&
               rangeEnd === openingRange(meta.measureCount).end && (
                <p className="dim">{tf('practiceRangeShortened', { count: rangeEnd })}</p>
              )}
              <div className="range-row">
                <span>{t('rangePrefix')}</span>
                <input aria-label={t('rangeStartAria')} type="number" min={1} max={meta.measureCount} value={rangeStart}
                       onChange={(e) => setRangeStart(Number(e.target.value))} style={{ width: 60 }} />
                <span>–</span>
                <input aria-label={t('rangeEndAria')} type="number" min={1} max={meta.measureCount} value={rangeEnd}
                       onChange={(e) => setRangeEnd(Number(e.target.value))} style={{ width: 60 }} />
                <span>{tf('rangeSummary', { count: meta.measureCount })}</span>
              </div>
              <div className="flex mt-12">
                <button className="btn btn-primary" onClick={gotoCalibrate}
                        disabled={loading || !rangeValid ||
                          (scoreDetail?.sourceType === 'midi' && !normalization?.confirmed)}>
                  {t('nextDevice')}
                </button>
              </div>
            </>
          )}
          </div>
          </div>
        </div>
      )}

      {/* Step 2: 校准 */}
      {step === 'calibrate' && (
        <div className="panel input-workspace">
          <div className="review-heading">
            <div>
              <h2>{t('inputMode')}</h2>
              <p className="dim">{t('microphoneHint')}</p>
            </div>
          </div>
          <div className="input-source-switch" role="group" aria-label={t('inputMode')}>
            {([
              ['web-midi', 'MIDI', t('inputMidi'), t('inputMidiCaption')],
              ['microphone', 'MIC', t('inputMicrophone'), t('inputMicrophoneCaption')],
              ['midi-upload', 'FILE', t('inputUpload'), t('inputUploadCaption')],
            ] as [InputSource, string, string, string][]).map(([source, badge, label, caption]) => (
              <button type="button" key={source} aria-pressed={inputSource === source}
                      className={inputSource === source ? 'active' : ''}
                      disabled={loading || recording}
                      onClick={() => chooseInputSource(source)}>
                <span className="input-source-badge">{badge}</span>
                <span><strong>{label}</strong><small>{caption}</small></span>
              </button>
            ))}
          </div>

          {inputSource === 'web-midi' && (
            <>
              <div className="input-card-heading">
                <div><h3>{t('usbMidiTitle')}</h3><p>{t('usbMidiHint')}</p></div>
                <button className="btn btn-sm" type="button" onClick={gotoCalibrate}
                        disabled={loading}>{t('rescan')}</button>
              </div>
              {!midiSupported ? (
                <div className="alert alert-warn">{t('midiBrowserFallback')}</div>
              ) : (
                <>
                  <div className="device-grid">
                    {inputs.map((name) => (
                      <button type="button" key={name} aria-pressed={selectedInput === name}
                              className={`device-item ${selectedInput === name ? 'selected' : ''}`}
                              disabled={loading || recording}
                              onClick={() => pickInput(name)}>
                        <span className="dot" /> <span>{name}</span>
                      </button>
                    ))}
                    {inputs.length === 0 && <div className="dim">{t('noMidiInput')}</div>}
                  </div>
                <div className="calibration-card" aria-live="polite">
                  <h3>{t('healthCheck')}</h3>
                  <p className="dim">{t('healthCheckHint')}</p>
                  <div className="calibration-row">
                    <span className={calibration.centerC ? 'check-ok' : 'check-pending'}>
                      {calibration.centerC ? '✓' : '○'} {t('middleC')}
                    </span>
                    <span className={calibration.noteCount >= 5 ? 'check-ok' : 'check-pending'}>
                      {calibration.noteCount >= 5 ? '✓' : '○'} {t('middleCThenFour')} {Math.max(0, Math.min(calibration.noteCount - 1, 4))}/4
                    </span>
                  </div>
                  <div className="live-notes">
                    {liveNotes.map((pitch) => <span key={pitch} className="live-note">{midiName(pitch)}</span>)}
                  </div>
                  <div className="dim mt-12">
                    {calibration.lastPitch === null
                      ? t('healthPrompt')
                      : tf('recentInput', { note: midiName(calibration.lastPitch), velocity: calibration.lastVelocity })}
                  </div>
                  <div className="health-metrics">
                    <span>{t('tapJitter')} <strong>{calibration.jitterMs === null ? t('awaitingFourTaps') : `${calibration.jitterMs} ms`}</strong></span>
                    <span>{t('duplicateMessages')} <strong>{calibration.duplicateMessages}</strong></span>
                  </div>
                </div>
                </>
              )}
            </>
          )}

          {inputSource === 'microphone' && (
            <MicrophonePanel
              state={microphoneState} devices={microphoneDevices}
              selectedDeviceId={selectedMicrophoneId} instrument={instrument}
              preview={microphonePreview} progress={transcriptionProgress} busy={loading}
              errorDetail={microphoneError}
              previewMode={microphoneRef.current?.previewMode ?? 'unavailable'}
              onConnect={() => void connectMicrophone()}
              onCancelConnect={cancelMicrophoneConnect}
              onSelectDevice={(deviceId) => {
                setSelectedMicrophoneId(deviceId)
                void connectMicrophone(deviceId)
              }}
              onInstrumentChange={setInstrument}
              onCancelTranscription={() => microphoneRef.current?.cancelTranscription()}
              sensitivity={micSensitivity}
              sensitivityPinned={micSensitivityPinned}
              onSensitivityChange={(value) => {
                setMicSensitivity(value)
                setMicSensitivityPinned(true)
                microphoneRef.current?.setDetectionSensitivity(value)
              }}
            />
          )}

          {inputSource === 'midi-upload' && (
            <div className="mt-20">
              <div className="alert alert-info">{t('uploadFallbackHint')}</div>
            </div>
          )}
          <div className="flex mt-20 between">
            <button className="btn" onClick={() => setStep('select')} disabled={loading}>{t('back')}</button>
            <button className="btn btn-primary" onClick={startSession}
                    disabled={loading ||
                      (inputSource === 'web-midi' && (!selectedInput || !calibration.centerC || calibration.noteCount < 5)) ||
                      (inputSource === 'microphone' && microphoneState !== 'ready')}>
              {inputSource === 'midi-upload' ? t('enterMidiUpload') : t('startWithCountIn')}
            </button>
          </div>
        </div>
      )}

      {/* Step 3: 演奏 */}
      {step === 'perform' && (
        <div className="panel performance-panel">
          <h2>{t('performanceTitle')} {uploadMode ? t('uploadModeSuffix') : ''}</h2>
          {meta && scoreId && (
            <div className="practice-studio">
              <div className="score-stage">
                <ScoreViewer xmlUrl={api.scoreXmlUrl(scoreId)} beatsPerMeasure={meta.beatsPerMeasure}
                             cursor={cursor} follow={recording}
                             liveFeedback={recording ? liveFeedback : null} />
              </div>
              {inputSource === 'microphone' && (
                <aside className="input-dock">
                  <MicrophonePanel
                    state={microphoneState} devices={microphoneDevices}
                    selectedDeviceId={selectedMicrophoneId} instrument={instrument}
                    preview={microphonePreview} progress={transcriptionProgress} busy={loading}
                    errorDetail={microphoneError}
                    previewMode={microphoneRef.current?.previewMode ?? 'unavailable'}
                    onConnect={() => void connectMicrophone()}
                    onCancelConnect={cancelMicrophoneConnect}
                    onSelectDevice={(deviceId) => {
                      setSelectedMicrophoneId(deviceId)
                      void connectMicrophone(deviceId)
                    }}
                    onInstrumentChange={setInstrument}
                    onCancelTranscription={() => microphoneRef.current?.cancelTranscription()}
                    sensitivity={micSensitivity}
                    sensitivityPinned={micSensitivityPinned}
                    onSensitivityChange={(value) => {
                      setMicSensitivity(value)
                      setMicSensitivityPinned(true)
                      microphoneRef.current?.setDetectionSensitivity(value)
                    }}
                  />
                  <LivePanel state={liveFeedback} trace={liveTrace} onSkip={skipLivePosition} />
                </aside>
              )}
              {inputSource !== 'microphone' && (
                <aside className="input-dock" aria-label={t('inputDockTitle')}>
                  {/* What you are playing leads the rail; the hardware it
                      arrived on is reference, so it sits underneath. */}
                  {inputSource === 'web-midi' && (
                    <>
                      <LivePanel state={liveFeedback} trace={liveTrace} onSkip={skipLivePosition} />
                      <div className="held-notes">
                        <span className="eyebrow">{t('heldNotes')}</span>
                        <div className="live-notes">
                          {liveNotes.length
                            ? liveNotes.map((pitch) => <span key={pitch} className="live-note">{midiName(pitch)}</span>)
                            : <span className="dim">{t('heldNotesEmpty')}</span>}
                        </div>
                      </div>
                    </>
                  )}
                  <div className="input-status-card">
                    <span className="eyebrow">{t('inputDockTitle')}</span>
                    <dl>
                      <div><dt>{t('inputSourceLabel')}</dt><dd>{inputSource === 'web-midi' ? t('inputMidi') : t('inputUpload')}</dd></div>
                      <div><dt>{t('inputInstrumentLabel')}</dt><dd>{instrument === 'piano'
                        ? t('instrumentPiano') : instrument === 'guitar'
                          ? t('instrumentGuitar') : t('instrumentViolin')}</dd></div>
                      <div><dt>{t('inputDeviceLabel')}</dt><dd>{inputSource === 'web-midi'
                        ? (selectedInput ?? t('noMidiInput'))
                        : (uploadMidiRef.current ? t('inputFileStored') : t('inputFileAwaiting'))}</dd></div>
                    </dl>
                    <div className={`input-status-pill ${
                      (inputSource === 'web-midi' && workflow.deviceConnected) ||
                      (inputSource === 'midi-upload' && uploadMidiRef.current) ? 'ready' : ''}`}>
                      {inputSource === 'web-midi' && workflow.deviceConnected
                        ? t('inputCaptureReady')
                        : inputSource === 'midi-upload' && uploadMidiRef.current
                          ? t('inputAnalysisReady') : t('waitingForNotes')}
                    </div>
                  </div>
                </aside>
              )}
            </div>
          )}
          {loading && submissionStage !== 'idle' && submissionStage !== 'complete' && (
            <div className={`submission-progress-card ${submissionStage}`} role="status">
              <span className="submission-spinner" />
              <div>
                <strong>{submissionStage === 'transcribing'
                  ? t('submissionTranscribing')
                  : submissionStage === 'analyzing'
                    ? t('submissionAnalyzing') : t('submissionSaving')}</strong>
                {submissionStage === 'transcribing' && (
                  <div className="submission-meter"><span style={{
                    width: `${Math.max(4, Math.round(transcriptionProgress * 100))}%`,
                  }} /></div>
                )}
              </div>
            </div>
          )}
          {inputSource === 'web-midi' && (
            <>
              {workflow.capture && !workflow.deviceConnected && (
                <div className="disconnect-recovery" role="alert">
                  <strong>{t('midiDisconnectedCursorFrozen')}</strong>
                  <span>{t('capturedSafe')}</span>
                  <div className="device-grid compact">
                    {inputs.map((name) => (
                      <button type="button" key={name} className="device-item"
                              onClick={() => pickInput(name)}>{name}</button>
                    ))}
                  </div>
                  <div className="flex">
                    <button className="btn btn-sm" onClick={refreshMidiInputs}>{t('rescanDevices')}</button>
                    <button className="btn btn-sm" onClick={stopAndAnalyze}>{t('submitCurrentRecording')}</button>
                    <button className="btn btn-danger btn-sm" onClick={discardActiveCapture}>{t('discardCurrentRecording')}</button>
                  </div>
                </div>
              )}
              {workflow.phase === 'analysis' && (
                <div className="analysis-progress" role="status">{t('analysisRunning')}</div>
              )}
              <div className="transport-bar midi-transport">
                <div className="recording-bar">
                  {recording && <span className="rec-dot" />}
                  <span>{recording ? t('recording') : (hasBaselineRecovery ? tf('recoveredNotes', { count: recoveredEvents.length }) : t('stopped'))}</span>
                  <span className="dim">{cursor ? tf('cursorPosition', {
                    measure: measureLabel(cursor.measure), bpm: cursor.bpm ?? '—',
                    state: cursor.waiting ? ` · ${t('waitingHere')}` : '',
                  }) : t('waitingForNotes')}</span>
                </div>
                <div className="flex">
                  <button className="btn" disabled={hasBaselineRecovery} onClick={async () => {
                    try {
                      const player = getPlayer()
                      await player.countIn(Math.round(meta!.beatsPerMeasure), meta!.tempo)
                    } catch (error) {
                      setAlert({ type: 'warn', msg: tf('countInPlaybackFailed', { detail: (error as Error).message }) })
                    }
                  }}>{t('hearCountIn')}</button>
                  <button className="btn btn-danger" onClick={stopAndAnalyze}
                          disabled={loading || workflow.phase === 'analysis' || (!recording && !hasBaselineRecovery)}>
                    {hasBaselineRecovery ? t('analyzeRecovered') : t('stopAndAnalyze')}
                  </button>
                </div>
              </div>
            </>
          )}
          {inputSource === 'microphone' && (
            <div className="transport-bar" aria-live="polite">
              <div className="transport-status">
                {recording && <span className="rec-dot" />}
                <strong>{microphoneState === 'transcribing'
                  ? t('microphoneTranscribing')
                  : recording ? t('microphoneRecording')
                    : microphoneRef.current?.hasTake(sessionId) ? t('microphoneTakeReady')
                    : hasBaselineRecovery ? tf('recoveredNotes', { count: recoveredEvents.length })
                      : t('stopped')}</strong>
                <span>{t('microphonePreviewOnly')}</span>
              </div>
              <div className="flex">
                <button className="btn btn-danger" onClick={stopAndAnalyze}
                        disabled={loading || microphoneState === 'transcribing' ||
                          (!recording && !hasBaselineRecovery &&
                            !microphoneRef.current?.hasTake(sessionId))}>
                  {hasBaselineRecovery
                    ? t('analyzeRecovered')
                    : !recording && microphoneRef.current?.hasTake(sessionId)
                      ? t('analyzeSavedTake')
                      : t('stopAndAnalyze')}
                </button>
                {!recording && microphoneRef.current?.hasTake(sessionId) && (
                  <button className="btn" onClick={() => void discardCaptureAndReturnToScores()}
                          disabled={loading || microphoneState === 'transcribing'}>
                    {t('discardTakeAndReturn')}
                  </button>
                )}
              </div>
            </div>
          )}
          {inputSource === 'midi-upload' && (
            <div className="mt-20">
              <div className="dim">{t('uploadedMidiExplanation')}</div>
              {sessionId && <UploadZone onFile={onUploadMidi} accept=".mid,.midi" disabled={loading} />}
              {uploadMidiRef.current && <div className="upload-confirm">{t('performanceFileReady')}</div>}
              <div className="flex mt-12 between">
                <button className="btn" onClick={() => setStep('calibrate')} disabled={loading}>{t('back')}</button>
                <button className="btn btn-primary" onClick={stopAndAnalyze} disabled={loading || !uploadMidiRef.current}>{t('submitAnalysis')}</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Step 4: 报告 */}
      {step === 'report' && report && (
        <CoachReport
          report={report}
          baseline={baselineReport}
          beatsPerMeasure={meta?.beatsPerMeasure}
          scoreXmlUrl={scoreId ? api.scoreXmlUrl(scoreId) : undefined}
          selectedError={selectedError}
          mentor={mentor}
          mentorLoading={mentorLoading}
          chatMessages={mentorChat}
          chatLoading={mentorChatLoading}
          question={question}
          mentorMemory={mentorMemory}
          onChooseError={(error) => chooseError(report, error)}
          onPlayEvidence={playEvidence}
          onApplyPlan={applyMentorPlan}
          onApplyChatAction={applyChatAction}
          onAskMentor={askMentor}
          onQuestionChange={setQuestion}
          onCancelChat={() => mentorChatAbortRef.current?.abort()}
          onForgetMemory={forgetMentorMemory}
          onRerecord={() => setStep('calibrate')}
          onGenerateExercise={openExerciseDesigner}
        />
      )}
      {/* Step 5: 练习 */}
      {step === 'exercise' && (
        <div className="panel training-panel">
          <div className="training-hero">
            <div>
              <span className="training-kicker">{t('aiExerciseKicker')}</span>
              <h2>{exerciseStage === 'design' ? t('exerciseDesignTitle') : t('exerciseGeneratedTitle')}</h2>
              <p>{exerciseStage === 'design' ? t('exerciseDesignSubtitle') : t('exerciseGeneratedSubtitle')}</p>
            </div>
            <div className="generation-loop" aria-label={t('generationLoopAria')}>
              <span className={exerciseStage === 'design' ? 'active' : 'done'}>{t('generationStepDesign')}</span>
              <b>→</b>
              <span className={exerciseStage === 'generated' ? 'active' : ''}>{t('generationStepResult')}</span>
              <b>↩</b>
            </div>
          </div>

          {exerciseStage === 'design' && (
            <div className="exercise-designer">
              {selectedError && (
                <div className="exercise-target">
                  <span className="badge" style={{ background: errorColor(selectedError.type) }}>
                    {ERROR_TYPE_LABEL[selectedError.type] ?? selectedError.type}
                  </span>
                  <div>
                    <strong>{tf('exerciseTargetPosition', {
                      measure: measureLabel(selectedError.location.measure),
                      beat: selectedError.location.beat + 1,
                    })}</strong>
                    <span>{errorDetailForDisplay(selectedError, report?.evidences ?? [])}</span>
                  </div>
                </div>
              )}

              <label className="generation-note">
                <span>{t('generationNoteLabel')}</span>
                <textarea value={generationNote}
                          onChange={(event) => setGenerationNote(event.target.value)}
                          maxLength={1000} rows={4}
                          placeholder={t('generationNotePlaceholder')} />
                <small>{tf('generationNoteCount', { count: generationNote.length })}</small>
              </label>
              <div className="note-suggestions">
                <span className="dim">{t('generationNoteExamples')}</span>
                {[t('generationNoteLeftHand'), t('generationNoteFiveMinutes'), t('generationNoteRhythm')].map((note) => (
                  <button type="button" className="strategy-btn" key={note}
                          onClick={() => setGenerationNote(note)}>{note}</button>
                ))}
              </div>

              <div className="designer-grid">
                <section>
                  <span className="control-label">{t('strategy')}</span>
                  <div className="strategy-select">
                    {EXERCISE_STRATEGIES.map(([key, label]) => (
                      <button type="button" key={key} aria-pressed={strategy === key}
                              className={`strategy-btn ${strategy === key ? 'active' : ''}`}
                              onClick={() => setStrategy(key)}>{label}</button>
                    ))}
                  </div>
                </section>
                <section>
                  <label className="control-label" htmlFor="exercise-tempo">{t('exerciseSpeed')}</label>
                  <div className="range-control">
                    <input id="exercise-tempo" aria-label={t('exerciseSpeedAria')}
                           type="range" min={0.25} max={1.25} step={0.05}
                           value={tempoRatio}
                           onChange={(event) => setTempoRatio(Number(event.target.value))} />
                    <strong>{Math.round(tempoRatio * 100)}%</strong>
                  </div>
                </section>
                <section>
                  <label className="control-label" htmlFor="exercise-loops">{t('loops')}</label>
                  <input id="exercise-loops" className="number-control"
                         aria-label={t('loopsAria')} type="number" min={1} max={10}
                         value={loopCount}
                         onChange={(event) => setLoopCount(Number(event.target.value))} />
                </section>
                {meta && meta.parts.length > 1 && (
                  <section>
                    <label className="control-label" htmlFor="exercise-hands">{t('part')}</label>
                    <select id="exercise-hands" className="select-control"
                            value={hands ?? ''}
                            onChange={(event) => setHands(event.target.value || null)}>
                      <option value="">{t('bothHands')}</option>
                      <option value="RH">{t('rightHand')}</option>
                      <option value="LH">{t('leftHand')}</option>
                    </select>
                  </section>
                )}
              </div>

              <div className="ai-generation-note">
                <span>AI</span>
                <div><strong>{t('aiGenerationBoundaryTitle')}</strong><br />{t('aiGenerationBoundary')}</div>
              </div>
              <div className="flex mt-20 between">
                <button className="btn" onClick={() => leaveExercise('report')}>{t('backToReport')}</button>
                <button className="btn btn-primary generate-ai-btn" onClick={genExercise} disabled={loading}>
                  {loading ? t('aiGeneratingExercise') : t('generateWithAi')}
                </button>
              </div>
            </div>
          )}

          {exerciseStage === 'generated' && exercise && (
            <div className="exercise-result">
              <div className="generated-plan-card">
                <div className="generated-plan-heading">
                  <div>
                    <span className="training-kicker">{t('aiPlanLabel')}</span>
                    <h3>{exercise.aiPlan?.title || t('exerciseGeneratedTitle')}</h3>
                  </div>
                  {exercise.plannerProvider?.startsWith('rules') && (
                    <span className="planner-status fallback">
                      {exercise.plannerProvider === 'rules'
                        ? t('exercisePlannerLocal') : t('exercisePlannerFallback')}
                    </span>
                  )}
                </div>
                {exercise.aiPlan?.rationale && <p>{exercise.aiPlan.rationale}</p>}
                {exercise.aiPlan?.noteAcknowledgement && (
                  <div className="note-ack">{exercise.aiPlan.noteAcknowledgement}</div>
                )}
                <div className="plan-facts">
                  <span>{tf('generatedMeasures', {
                    measures: measureLabelList(exercise.sourceMeasures),
                  })}</span>
                  <span>{tf('generatedStrategy', {
                    strategy: EXERCISE_STRATEGIES.find(([key]) => key === exercise.ruleId)?.[1] || exercise.ruleId,
                  })}</span>
                  <span>{tf('generatedTempo', { percent: Math.round((exercise.aiPlan?.tempoRatio ?? tempoRatio) * 100) })}</span>
                  <span>{tf('generatedLoops', { count: exercise.aiPlan?.loopCount ?? loopCount })}</span>
                  {!!exercise.cadencePlan?.length && (
                    <span>{tf('generatedCadences', {
                      cadences: exercise.cadencePlan.map((item) =>
                        CADENCE_LABEL[item] ?? item).join(' → '),
                    })}</span>
                  )}
                </div>
                <div className="success-criterion">{tf('mentorSuccessCriterion', { criterion: exercise.successCriterion })}</div>
              </div>

              {scoreId && meta && (
                <div className="generated-score">
                  <ScoreViewer xmlUrl={exercise.musicXmlUrl}
                               beatsPerMeasure={meta.beatsPerMeasure} height={240} />
                </div>
              )}
              {exercise.tempoPlan.length > 1 && (
                <div className="tempo-plan">{t('tempoLadder')}{exercise.tempoPlan.map((tempo) => `${tempo} BPM`).join(' → ')}</div>
              )}
              <div className="result-actions">
                <button className="btn btn-primary" onClick={playExercise} disabled={playing}>
                  {playing ? t('playing') : t('playExercise')}
                </button>
                <a className="btn" href={exercise.musicXmlUrl} download>{t('downloadMusicXml')}</a>
                <a className="btn" href={exercise.midiUrl} download>{t('downloadMidi')}</a>
              </div>
              <div className="flex mt-20 between">
                <button className="btn" onClick={() => {
                  playerRef.current?.stop()
                  setPlaying(false)
                  setExerciseStage('design')
                }}>{t('backToExerciseDesign')}</button>
                <div className="flex">
                  <button className="btn" onClick={genExercise} disabled={loading}>
                    {loading ? t('aiGeneratingExercise') : t('regenerateWithAi')}
                  </button>
                  <button className="btn btn-primary" onClick={() => leaveExercise('compare')}>
                    {t('enterEnsemble')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Step 6: 对比 */}
      {step === 'compare' && (
        <div className="panel">
          <h2>{t('comparisonTitle')}</h2>
          <div className="exercise-controls">
            <span className="dim">{t('accompanimentMode')}</span>
            <div className="strategy-select">
              <button type="button" aria-pressed={accMode === 'flexible'}
                      className={`strategy-btn ${accMode === 'flexible' ? 'active' : ''}`}
                      disabled={loading || (!!retrySessionId && !comparison) ||
                        (inputSource === 'microphone' && !headphonesConfirmed)}
                      onClick={() => setAccMode('flexible')}>{t('flexibleFollow')}</button>
              <button type="button" aria-pressed={accMode === 'strict'}
                      className={`strategy-btn ${accMode === 'strict' ? 'active' : ''}`}
                      disabled={loading || (!!retrySessionId && !comparison) ||
                        (inputSource === 'microphone' && !headphonesConfirmed)}
                      onClick={() => setAccMode('strict')}>{t('strictTempo')}</button>
            </div>
            {inputSource === 'microphone' && (
              <label className="mode-toggle headphone-warning">
                <input type="checkbox" checked={headphonesConfirmed}
                       disabled={loading || (!!retrySessionId && !comparison)}
                       onChange={(event) => setHeadphonesConfirmed(event.target.checked)} />
                {t('microphoneHeadphones')}
              </label>
            )}
            <button className="btn btn-primary btn-sm" onClick={startAccompaniment}
                    disabled={loading || recording || (!!retrySessionId && !comparison)}>
              {inputSource === 'microphone'
                ? (headphonesConfirmed ? t('startMicrophoneRetryWithAccompaniment') : t('startMicrophoneRetry'))
                : t('startAccompaniment')}
            </button>
            <button className="btn btn-danger btn-sm" onClick={stopRetryAndCompare}
                    disabled={loading || !retrySessionId || (uploadMode
                      ? !retryUploadMidiRef.current
                      : (!recording && !hasRetryRecovery &&
                        !microphoneRef.current?.hasTake(retrySessionId)))}>
              {hasRetryRecovery
                ? t('analyzeRecoveredComparison')
                : inputSource === 'microphone' && !recording &&
                    microphoneRef.current?.hasTake(retrySessionId)
                  ? t('analyzeSavedTakeComparison')
                  : t('stopAndCompare')}
            </button>
            {retrySessionId && !comparison && (
              <button className="btn btn-sm" onClick={cancelRetry} disabled={loading}>{t('cancelRetry')}</button>
            )}
          </div>

          {retrySessionId && !comparison && (
            <div className="retry-stage" aria-live="polite">
              {inputSource === 'web-midi' && workflow.capture === 'retry' && !workflow.deviceConnected && (
                <div className="disconnect-recovery" role="alert">
                  <strong>{t('retryDisconnected')}</strong>
                  <span>{t('capturedSafe')}</span>
                  <div className="device-grid compact">
                    {inputs.map((name) => (
                      <button type="button" key={name} className="device-item"
                              onClick={() => pickInput(name)}>{name}</button>
                    ))}
                  </div>
                  <div className="flex">
                    <button className="btn btn-sm" onClick={refreshMidiInputs}>{t('rescanDevices')}</button>
                    <button className="btn btn-danger btn-sm" onClick={discardActiveCapture}>{t('discardRetry')}</button>
                  </div>
                </div>
              )}
              {retryScoreMeta && retryScoreXmlUrl ? (
                <div className="retry-score-target">
                  <div className="retry-score-label">{t('retryGeneratedTarget')}</div>
                  <ScoreViewer xmlUrl={retryScoreXmlUrl}
                               beatsPerMeasure={retryScoreMeta.beatsPerMeasure} cursor={cursor}
                               follow={recording}
                               liveFeedback={recording ? liveFeedback : null} />
                </div>
              ) : (
                <div className="alert alert-warn">{t('retryGeneratedUnavailable')}</div>
              )}
              <div className="recording-bar">
                {inputSource !== 'midi-upload' && recording && <span className="rec-dot" />}
                <span>{inputSource === 'midi-upload'
                  ? t('midiFileRetry')
                  : inputSource === 'microphone' && microphoneState === 'transcribing'
                    ? t('microphoneTranscribing')
                    : (recording ? t('recordingRetry')
                      : microphoneRef.current?.hasTake(retrySessionId)
                        ? t('microphoneTakeReady')
                        : (hasRetryRecovery ? tf('recoveredNotes', { count: recoveredEvents.length }) : t('waitingToRecord')))}</span>
                <span className="dim">{tf('accompanimentStatus', { bpm: retryTempo ?? '—' })}</span>
                {cursor && <span className="dim">{tf('followerPosition', {
                  measure: measureLabel(cursor.measure),
                  bpm: Math.round(cursor.bpm ?? 0),
                })}</span>}
              </div>
              {inputSource !== 'midi-upload' && <LivePanel state={liveFeedback} trace={liveTrace} onSkip={skipLivePosition} />}
              {loading && submissionStage !== 'idle' && submissionStage !== 'complete' && (
                <div className={`submission-progress-card ${submissionStage}`} role="status">
                  <span className="submission-spinner" />
                  <strong>{submissionStage === 'transcribing'
                    ? t('submissionTranscribing')
                    : submissionStage === 'analyzing'
                      ? t('submissionAnalyzing') : t('submissionSaving')}</strong>
                </div>
              )}
              {inputSource === 'microphone' && microphoneState === 'transcribing' && (
                <div className="transcription-progress" role="status">
                  <div><span style={{ width: `${Math.round(transcriptionProgress * 100)}%` }} /></div>
                  <strong>{tf('transcriptionProgress', { value: Math.round(transcriptionProgress * 100) })}</strong>
                  <button type="button" className="btn btn-sm"
                          onClick={() => microphoneRef.current?.cancelTranscription()}>
                    {t('transcriptionCancel')}
                  </button>
                </div>
              )}
              {inputSource === 'midi-upload' && (
                <div className="mt-12">
                  <p className="dim">{t('uploadFreshRetry')}</p>
                  <UploadZone onFile={onUploadRetryMidi} accept=".mid,.midi" disabled={loading} />
                  {retryUploadName && <div className="upload-confirm">{tf('readyFile', { name: retryUploadName })}</div>}
                </div>
              )}
            </div>
          )}

          {comparison && baselineReport && report && (
            <div className="mt-20">
              {report.inputQuality?.status === 'insufficient' ? (
                <div className="limited-metrics-card">
                  <strong>{t('limitedMetricsTitle')}</strong>
                  <p>{t('limitedMetricsBody')}</p>
                </div>
              ) : <div className="table-scroll"><table className="comparison-table">
                <thead><tr><th>{t('metric')}</th><th>{t('previousRound')}</th><th>{t('currentRound')}</th><th>{t('change')}</th></tr></thead>
                <tbody>
                  {(['overallScore', 'pitchScore', 'rhythmScore', 'fluencyScore',
                    'dynamicsScore', 'timingMaeMs'] as const).map((k) => (
                    <tr key={k}>
                      <td>{METRIC_LABEL[k]}</td>
                      <td>{baselineReport.metrics[k]}</td>
                      <td>{report.metrics[k]}</td>
                      <td className={metricDeltaClass(k, comparison.metricDelta[k])}>
                        {comparison.metricDelta[k] > 0 ? '+' : ''}{comparison.metricDelta[k]}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>}
              <div className="alert alert-info">
                {report.inputQuality?.status === 'insufficient'
                  ? t('limitedMetricsBody')
                  : comparison.targetChanged
                  ? tf('lineageComparisonSummary', { remaining: report.errors.length })
                  : tf('comparisonSummary', {
                      resolved: comparison.resolvedErrors.length,
                      persistent: comparison.persistentErrors.length,
                      added: comparison.newErrors.length,
                    })}
              </div>
              {comparison.targetChanged && (
                <div className="dim lineage-metric-note">{t('lineageMetricNotice')}</div>
              )}
              <div className="alert alert-success">{comparison.suggestion}</div>
              {retryScoreMeta && retryScoreXmlUrl ? (
                <div className="retry-score-target">
                  <div className="retry-score-label">{t('retryGeneratedTarget')}</div>
                  <ScoreViewer
                    xmlUrl={retryScoreXmlUrl} beatsPerMeasure={retryScoreMeta.beatsPerMeasure}
                    errors={report.errors}
                    resolvedKeys={comparison.targetChanged ? undefined : resolvedKeys}
                  />
                </div>
              ) : (
                <div className="alert alert-warn">{t('retryGeneratedUnavailable')}</div>
              )}
              <section className="round-guidance">
                <span className="training-kicker">{t('currentRoundAiKicker')}</span>
                <h3>{report.inputQuality?.status === 'insufficient'
                  ? t('limitedMetricsTitle')
                  : report.errors.length
                  ? tf('roundProblemsRemain', { count: report.errors.length })
                  : t('roundPassed')}</h3>
                <p>{report.inputQuality?.status === 'insufficient'
                  ? t('limitedMetricsBody')
                  : mentorLoading
                  ? t('mentorThinking')
                  : (mentor?.summary || comparison.suggestion)}</p>
                {mentor?.plan[0] && (
                  <div className="round-plan-preview">
                    <strong>{mentor.plan[0].label || mentor.plan[0].exerciseType}</strong>
                    <span>{tf('mentorSuccessCriterion', {
                      criterion: mentor.plan[0].successCriterion,
                    })}</span>
                  </div>
                )}
                <div className="flex mt-12">
                  <button className="btn" onClick={() => setStep('report')}>
                    {t('viewCurrentRoundReport')}
                  </button>
                  <button className="btn btn-primary" onClick={continueFromCurrentRound}>
                    {report.errors.length ? t('generateFromCurrentRound') : t('increaseChallenge')}
                  </button>
                </div>
              </section>
            </div>
          )}

          <div className="flex mt-20 between">
            <button className="btn" onClick={comparison ? continueFromCurrentRound : () => setStep('exercise')}
                    disabled={!!retrySessionId && !comparison}>{comparison
                      ? t('generateFromCurrentRound') : t('backToExercise')}</button>
            <button className="btn btn-primary" onClick={() => {
              sendWorkflow({ type: 'RESET' }); setReport(null); setBaselineReport(null); setComparison(null)
              setMentorChat([]); setMentorMemory(null); setExercise(null); setExerciseStage('design'); setGenerationNote('')
              setExerciseScore(null); setRetrySessionId(null); setCursor(null); setRecording(false)
              recordingRef.current = false; setSubmissionStage('idle')
              liveRef.current.reset(); setLiveTrace([])
              setLiveFeedback(idleLiveState('web-midi'))
              setScoreId(null); setScoreDetail(null); setNormalization(null); setMeta(null); setEvents([])
              uploadMidiRef.current = null; retryUploadMidiRef.current = null
            }} disabled={!!retrySessionId && !comparison}>{t('restart')}</button>
          </div>
        </div>
      )}
      </Suspense>
      </div>
    </div>
  )
}

// ---- 辅助组件 ----
function UploadZone({ onFile, accept, disabled }: { onFile: (f: File) => void; accept: string; disabled?: boolean }) {
  const [drag, setDrag] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const choose = () => { if (!disabled) inputRef.current?.click() }
  return (
    <div className={`upload-zone ${drag ? 'drag' : ''}`}
         role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled}
         onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose() } }}
         onDragOver={(e) => { e.preventDefault(); if (!disabled) setDrag(true) }}
         onDragLeave={() => setDrag(false)}
         onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f && !disabled) onFile(f) }}
         onClick={choose}
    >
      <input ref={inputRef} type="file" accept={accept} hidden disabled={disabled}
             onClick={(e) => e.stopPropagation()}
             onChange={(e) => {
               const f = e.target.files?.[0]
               if (f) onFile(f)
               e.currentTarget.value = ''
             }} />
      <div className="dim">{t('fileDrop')}{disabled ? t('processingSuffix') : ''}</div>
    </div>
  )
}

// ---- 工具函数 ----

function useMemoResolvedKeys(comp: ComparisonResult | null): Set<string> {
  return new Set(comp?.resolvedErrors ?? [])
}

function metricDeltaClass(metric: string, delta: number): 'pos' | 'neg' | 'neutral' {
  if (delta === 0) return 'neutral'
  return (metric === 'timingMaeMs' ? delta < 0 : delta > 0) ? 'pos' : 'neg'
}
