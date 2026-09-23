import {
  Fragment, lazy, Suspense, useCallback, useEffect, useReducer, useRef, useState, type ReactNode,
} from 'react'
import { SettingsDialog } from './features/shell/SettingsDialog'
import { useDepth, useFinish, useLocale, useTheme } from './features/shell/useSettings'
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
import { StudioStepper } from './features/practice/StudioStepper'
import { Stage } from './features/practice/Stage'
import { stageOf, type StageId, type Step } from './features/practice/stages'
import { LivePanel } from './features/live/LivePanel'
import {
  LivePerformanceTracker, idleLiveState, type LivePerformanceState,
  type LiveTraceNote,
} from './features/live'
import { CoachReport } from './features/report/CoachReport'
import { errorColor, errorDetailForDisplay } from './features/report/errorPresentation'
import {
  categoryForScore, partitionScoreLibrary, pieceTitle, pieceTitleOf,
  type ScoreLibraryItem,
} from './features/score/library'
import type { MentorChatMessage } from './features/mentor/MentorChat'
import {
  chatMessageId, readMentorChat, writeMentorChat,
} from './features/mentor/chatStorage'
import { MidiPlayer, ensureAudio, playPitches } from './features/audio/player'
import {
  initialWorkflowState, workflowReducer, type WorkflowPhase,
} from './workflow/machine'
import {
  CADENCE_LABEL, ERROR_TYPE_LABEL, EXERCISE_STRATEGIES, METRIC_LABEL, getLocale, instrumentLabel,
  t, tf,
} from './i18n/messages'
import type { Locale } from './features/shell/preferences'
import { withEmbeddedNote } from './features/shell/embedding'
import { NoticeStack, useNotices } from './features/shell/notices'

const ScoreViewer = lazy(() => import('./features/score/ScoreViewer').then((module) => ({
  default: module.ScoreViewer,
})))

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

/** One summary per report, question, mistake — and language. */
function mentorCacheKey(reportId: string, errorId: string | undefined, prompt: string,
  locale: Locale): string {
  return JSON.stringify([reportId, errorId ?? '', prompt.trim(), locale])
}

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

/** No key has been checked yet. Shared so the two places that reset a device
 *  check cannot drift apart and leave one of them half-clearing it. */
const UNCHECKED: CalibrationStatus = {
  noteCount: 0, centerC: false, lastPitch: null, lastVelocity: null,
  jitterMs: null, duplicateMessages: 0,
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
  const { notices, notify, dismiss: dismissNotice, clear: clearNotices } = useNotices()
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
  // The language the summary on screen was written in. It is AI prose, so a
  // language switch does not translate it; the panel offers to rewrite it.
  const [mentorLocale, setMentorLocale] = useState<Locale | null>(null)
  const mentorArgsRef = useRef<{ report: DiagnosisReport; prompt: string; errorId?: string } | null>(null)
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
    // The listener does better when it knows what is due. A left hand played
    // softer than the melody is otherwise easy to lose entirely, and a note
    // that is never heard is a note the cursor walks straight past.
    microphoneRef.current?.expect(state.outstanding.length
      ? state.outstanding.map((note) => note.pitch)
      : state.target?.pitches ?? [])
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
    const locale = getLocale()
    mentorArgsRef.current = { report: activeReport, prompt, errorId }
    const key = mentorCacheKey(activeReport.reportId, errorId, prompt, locale)
    const cached = mentorCacheRef.current.get(key)
    if (cached) {
      setMentor(cached)
      setMentorLocale(locale)
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
      if (requestId === mentorRequestRef.current) {
        setMentor(response)
        setMentorLocale(locale)
      }
      return response
    } catch (error) {
      if (requestId === mentorRequestRef.current && notifyOnError) {
        notify('warn', () => tf('mentorUnavailableWithDetail', { detail: (error as Error).message }))
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
        if (!cancelled) notify('error', () => tf('loadScoresFailed', { detail: (error as Error).message }))
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
      notify('warn', () => tf('deviceLost', { name }))
    }
    capture.onStateChange = (message) => {
      const names = capture.listInputs()
      setInputs(names)
      const selected = selectedInputRef.current
      if (selected && !names.includes(selected)) {
        selectedInputRef.current = null
        setSelectedInput(null)
        notify('warn', () => tf('deviceStateLost', { message }))
      } else {
        notify('info', () => message)
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
      notify('warn', () => t('microphoneDeviceLost'))
    }
    microphone.onLimitReached = () => {
      recordingRef.current = false
      setRecording(false)
      notify('warn', () => t('microphoneLimitReached'))
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
          notify('info', () => recoveredUploadRef
              ? tf('recoveredMidiCanSubmit', { name: stored.uploadedFileName ?? 'MIDI' })
              : recoveredMicrophoneTake
                ? t('microphoneSavedTakeRecovered')
              : tf('recoveredNotesCanSubmit', { count: recovered.length }))
        } catch (error) {
          if (!cancelled) {
            setRecoveryContext(stored)
            setRecoveredEvents(recovered)
            notify('warn', () => tf('recoveryFailed', { detail: (error as Error).message }))
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
    notify('info', () => t('recoveryDiscarded'))
  }

  const refreshMidiInputs = async () => {
    try {
      const names = await captureRef.current!.requestAccess()
      setInputs(names)
      notify(names.length ? 'info' : 'warn', () => names.length ? t('rescanFound') : t('rescanEmpty'))
    } catch (error) {
      notify('warn', () => tf('reconnectFailed', { detail: (error as Error).message }))
    }
  }

  const chooseInputSource = (source: InputSource) => {
    if (loading || recording || workflow.phase === 'analysis') return
    setInputSource(source)
    setUploadModeState(source === 'midi-upload')
    clearNotices()
    if (source === 'midi-upload') sendWorkflow({ type: 'DEVICE_CONNECTED' })
    if (source === 'web-midi' && selectedInput) sendWorkflow({ type: 'DEVICE_CONNECTED' })
    if (source === 'microphone' && microphoneState === 'ready') {
      sendWorkflow({ type: 'DEVICE_CONNECTED' })
    }
  }

  const connectMicrophone = async (deviceId = selectedMicrophoneId || undefined) => {
    const requestId = ++microphoneConnectRequestRef.current
    setLoading(true); clearNotices()
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
      notify(previewWarning ? 'info' : 'success', () => previewWarning
          ? tf('microphoneReadyWithPreviewWarning', { detail: previewWarning })
          : t('microphoneReady'))
    } catch (error) {
      if (requestId !== microphoneConnectRequestRef.current) return
      const state = microphoneRef.current?.state
      const detail = (error as Error).message
      setMicrophoneError(detail)
      notify('warn', () => state === 'permission-denied'
          ? t('microphonePermissionDenied')
          : tf('reconnectFailed', { detail }))
    } finally {
      if (requestId === microphoneConnectRequestRef.current) setLoading(false)
    }
  }

  const cancelMicrophoneConnect = () => {
    microphoneConnectRequestRef.current += 1
    microphoneRef.current?.cancelConnect()
    setLoading(false)
    setMicrophoneError(null)
    notify('info', () => t('microphoneRequestCancelled'))
  }

  /**
   * Throw away the take without asking.
   *
   * Every entry point below asks first; this is the shared body so that a
   * caller which has already asked does not ask twice.
   */
  const performDiscard = async () => {
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
    notify('info', () => t('captureDiscarded'))
  }

  /**
   * Is there anything to lose?
   *
   * Confirming a discard that throws nothing away is a dialog for its own sake,
   * so an untouched take goes quietly.
   */
  // The played notes live in the capture adapter rather than in state, so what
  // is testable here is whether a take exists at all: one being recorded, one
  // already transcribed, or one recovered from a previous session.
  const captureHasSomethingToLose = () =>
    recording || hasSavedMicrophoneTake || Boolean(captureMeta) ||
    Boolean(recoveryContext)

  /**
   * Discarding is destructive and irreversible, so it asks — from every button
   * that does it, not only from the one in the stepper. Three other buttons ran
   * the same code with no prompt at all, which meant a misclick in the transport
   * bar silently deleted a take the nav bar would have asked about.
   */
  const discardActiveCapture = async () => {
    if (captureHasSomethingToLose() &&
        !window.confirm(t('discardCaptureConfirm'))) return
    await performDiscard()
  }

  const discardCaptureAndReturnToScores = async () => {
    if (captureHasSomethingToLose() &&
        !window.confirm(t('discardTakeReturnConfirm'))) return
    setLoading(true)
    try {
      await performDiscard()
      resetPracticeBlock()
      sendWorkflow(scoreId ? { type: 'SCORE_SELECTED' } : { type: 'OPEN_IMPORT' })
      notify('info', () => t('returnedToScoresAfterDiscard'))
    } finally {
      setLoading(false)
    }
  }

  const rangeValid = !!meta && Number.isInteger(rangeStart) && Number.isInteger(rangeEnd) &&
    rangeStart >= 1 && rangeEnd >= rangeStart && rangeEnd <= meta.measureCount

  // ---- 选曲 ----
  const selectScore = async (id: string) => {
    // Choosing the piece that is already open is not a new start.
    if (id === scoreId && scoreDetail) {
      if (step !== 'select') setStep('select')
      return
    }
    const requestId = ++scoreLoadRequestRef.current
    setLoading(true); clearNotices()
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
        notify('error', () => tf('scoreLoadFailed', { detail: (e as Error).message }))
      }
    }
    if (requestId === scoreLoadRequestRef.current) setLoading(false)
  }

  const importScore = async (file: File) => {
    const requestId = ++scoreLoadRequestRef.current
    setLoading(true); clearNotices()
    // Reading a page takes tens of seconds, which is long enough that silence
    // reads as a hang. Say what is happening before the wait, not after it.
    if (READ_FROM_PAGE_SUFFIXES.test(file.name)) {
      notify('info', () => t('uploadScoreReading'))
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
      notify('success', () => tf('scoreImported', { title: r.metadata.title }))
    } catch (e) {
      if (requestId === scoreLoadRequestRef.current) {
        const err = e as Error & { code?: string }
        notify('error', () => err.code === 'SCORE_UNSUPPORTED' ? err.message : tf('scoreImportFailed', { detail: err.message }))
      }
    }
    if (requestId === scoreLoadRequestRef.current) setLoading(false)
  }

  const confirmNormalization = async () => {
    if (!scoreId || !normalization || scoreDetail?.sourceType !== 'midi') return
    setLoading(true); clearNotices()
    try {
      const detail = await api.confirmNormalization(scoreId, normalization)
      setScoreDetail(detail); setNormalization(detail.normalization)
      setMeta(detail.metadata); setEvents(detail.scoreEvents)
      setRangeEnd(Math.min(rangeEnd, detail.metadata.measureCount))
      notify('success', () => t('normalizationSaved'))
    } catch (error) {
      notify('error', () => tf('normalizationSaveFailed', { detail: (error as Error).message }))
    }
    setLoading(false)
  }

  const gotoCalibrate = async () => {
    if (!scoreId) return
    if (!rangeValid) {
      notify('warn', () => tf('invalidRange', { count: meta?.measureCount ?? 1 }))
      return
    }
    if (scoreDetail?.sourceType === 'midi' && !normalization?.confirmed) {
      notify('warn', () => t('confirmNormalizationFirst'))
      return
    }
    getPlayer()
    sendWorkflow({ type: 'START_DEVICE_SETUP' }); clearNotices(); setLiveNotes([])
    setCalibration(UNCHECKED)
    if (inputSource === 'microphone' || inputSource === 'midi-upload') return
    setLoading(true)
    try {
      const names = await captureRef.current!.requestAccess()
      setInputs(names); setMidiSupported(true)
      if (names.length === 0) {
        notify('warn', () => t('noMidiFallback'))
        setUploadMode(true)
      }
    } catch (e) {
      setMidiSupported(false); setUploadMode(true)
      notify('warn', () => withEmbeddedNote(t('midiPermissionFallback')))
    } finally {
      setLoading(false)
    }
  }

  const pickInput = (name: string) => {
    if (loading || recording) return
    if (captureRef.current!.selectInput(name)) {
      selectedInputRef.current = name
      setSelectedInput(name); setUploadMode(false)
      // A check belongs to the keyboard that passed it. Switching devices here
      // — because the first was the wrong one, or because it dropped and a
      // replacement was picked from the reconnect list — used to keep the old
      // device's ticks, so the new one was never actually verified and the
      // whole point of this screen was skipped.
      setCalibration(UNCHECKED)
      sendWorkflow({ type: 'DEVICE_CONNECTED' })
      notify('info', () => tf('deviceSelected', { name }))
    }
  }

  // ---- 创建会话 + 进入演奏 ----
  const startSession = async () => {
    if (!scoreId || !meta) return
    if (sessionStartInFlightRef.current) return
    if (inputSource === 'web-midi' && !selectedInput) {
      notify('warn', () => t('chooseMidiOrUpload'))
      return
    }
    if (inputSource === 'microphone' && microphoneState !== 'ready') {
      notify('warn', () => t('microphoneConnect'))
      return
    }
    sessionStartInFlightRef.current = true
    setLoading(true); clearNotices(); setSubmissionStage('idle')
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
        notify('info', () => tf('countInStarts', { beats: r.countIn.beats }))
        try {
          if (!audioReady || !countInPlayer) throw new Error(t('audioContextUnavailable'))
          await countInPlayer.countIn(r.countIn.beats, r.countIn.bpm)
        } catch {
          notify('warn', () => t('countInUnavailable'))
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
        // The action bar already says a microphone take is recording; only
        // the MIDI path has something more to tell (when its clock starts).
        if (inputSource !== 'microphone') notify('info', () => t('recordingDeterministic'))
      }
    } catch (e) {
      recordingRef.current = false
      setRecording(false)
      notify('error', () => tf('createSessionFailed', { detail: (e as Error).message }))
    } finally {
      sessionStartInFlightRef.current = false
      setLoading(false)
    }
  }

  // ---- 上传 MIDI 降级 ----
  const onUploadMidi = async (file: File) => {
    if (!sessionId) return
    uploadMidiRef.current = null
    setLoading(true); clearNotices()
    try {
      const r = await midiUploadRef.current!.upload(file)
      notify('success', () => tf('midiUploaded', { name: file.name }))
      uploadMidiRef.current = r.uploadedMidiRef ?? null
      const context = readRecoveryContext()
      if (context?.sessionId === sessionId && r.uploadedMidiRef) {
        const updated = {
          ...context, uploadedMidiRef: r.uploadedMidiRef,
          uploadedFileName: file.name, savedAt: Date.now(),
        }
        // Saved for a reload, not announced: the take is on screen, being
        // uploaded right now. The "left-over take" banner is for one found
        // after the page was closed, and showing it here offered to discard
        // the very take the player was in the middle of.
        writeRecoveryContext(updated)
      }
    } catch (e) { notify('error', () => tf('uploadFailed', { detail: (e as Error).message })) }
    setLoading(false)
  }
  // ---- 停止演奏 → 提交分析 ----
  const stopAndAnalyze = async () => {
    if (!sessionId) return
    if (submissionInFlightRef.current) return
    if (inputSource === 'midi-upload' && !uploadMidiRef.current) {
      notify('warn', () => t('uploadPerformanceFirst'))
      return
    }
    submissionInFlightRef.current = true
    setLoading(true); clearNotices()
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
          notify('info', () => t('transcriptionCancelledSaved'))
        } else {
          setSubmissionStage('error')
          notify('warn', () => tf('transcriptionFailed', { detail: failure.message }))
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
        notify('warn', () => t('lowAlignmentConfidence'))
      } else { notify('error', () => tf('analysisFailed', { detail: err.message })) }
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
    clearNotices()
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
      notify('warn', () => tf('mentorUnavailableWithDetail', { detail }))
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
      notify('info', () => t('mentorMemoryForgotten'))
    } catch (error) {
      notify('warn', () => tf('mentorMemoryForgetFailed', { detail: (error as Error).message }))
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
    setLoading(true); clearNotices()
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
      notify('success', () => tf('exerciseGenerated', {
        rule: strategyLabel, measures: measureLabelList(r.sourceMeasures, '-'),
      }))
    } catch (e) {
      if (requestId === exerciseRequestRef.current) {
        notify('error', () => tf('exerciseFailed', { detail: (e as Error).message }))
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
      notify('error', () => tf('exercisePlaybackFailed', { detail: (error as Error).message }))
    }
  }

  const playEvidence = async (pitches: number[]) => {
    try {
      await ensureAudio()
      if (pitches.length) await playPitches(pitches)
    } catch (error) {
      notify('warn', () => tf('evidencePlaybackFailed', { detail: (error as Error).message }))
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
      notify('warn', () => t('generateExerciseBeforeRetry'))
      setStep('exercise')
      return
    }
    if (inputSource === 'web-midi' && !selectedInput) {
      notify('warn', () => t('midiReconnectRequired'))
      return
    }
    if (inputSource === 'microphone' && microphoneState !== 'ready') {
      notify('warn', () => t('microphoneConnect'))
      return
    }
    sessionStartInFlightRef.current = true
    setLoading(true); clearNotices(); setSubmissionStage('idle')
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
          onEnd: () => notify('info', () => t('accompanimentEnded')),
        })
      }
      if (!(inputSource === 'microphone' && !headphonesConfirmed)) {
        notify('info', () => uploadMode
          ? t('accompanimentUploadStarted')
          : tf('accompanimentStarted', {
              mode: accMode === 'flexible' ? t('flexibleTempoDescription') : t('fixedTempoDescription'),
            }))
      }
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
      notify('error', () => tf('accompanimentFailed', { detail: (e as Error).message }))
    } finally {
      sessionStartInFlightRef.current = false
      setLoading(false)
    }
  }

  const onUploadRetryMidi = async (file: File) => {
    if (!retrySessionId) return
    retryUploadMidiRef.current = null
    setRetryUploadName(null)
    setLoading(true); clearNotices()
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
      }
      notify('success', () => tf('retryMidiUploaded', { name: file.name }))
    } catch (error) {
      notify('error', () => tf('retryMidiUploadFailed', { detail: (error as Error).message }))
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
    notify('info', () => t('retryCancelled'))
  }

  const stopRetryAndCompare = async () => {
    if (!retrySessionId || !baselineReport) return
    if (submissionInFlightRef.current) return
    if (inputSource === 'midi-upload' && !retryUploadMidiRef.current) {
      notify('warn', () => t('uploadFreshRetryFirst'))
      return
    }
    submissionInFlightRef.current = true
    setLoading(true); clearNotices()
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
          notify('info', () => t('transcriptionCancelledSaved'))
        } else {
          setSubmissionStage('error')
          notify('warn', () => tf('transcriptionFailed', { detail: failure.message }))
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
      notify('error', () => tf('comparisonFailed', { detail: (e as Error).message }))
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
  const studioStage: StageId = stageOf(step).id
  const canOpenStudioStage = (stage: StageId) => {
    if (loading || workflow.phase === 'count_in' || workflow.phase === 'analysis') {
      return stage === studioStage
    }
    if (workflow.capture !== null) {
      return stage === studioStage || (stage === 'score' && hasSavedMicrophoneTake)
    }
    if (stage === 'score') return true
    if (stage === 'input') return Boolean(scoreId)
    if (stage === 'perform') return Boolean(sessionId) && step === 'perform'
    if (stage === 'review') return Boolean(report)
    return Boolean(report || baselineReport)
  }
  /** Back into the practice loop where it was left: comparing, or at the bench. */
  const openPractice = () => {
    if (comparison || retrySessionId) setStep('compare')
    else if (exercise || baselineReport) setStep('exercise')
    else openExerciseDesigner()
  }
  const openStudioStage = (stage: StageId) => {
    if (!canOpenStudioStage(stage) || stage === studioStage) return
    if (stage === 'score') {
      if (workflow.capture !== null) {
        if (!hasSavedMicrophoneTake) return
        void discardCaptureAndReturnToScores()
        return
      }
      // Looking at the library is not starting over. It used to be: this tab
      // silently threw away the report, the conversation and the exercise.
      // The round now stays — Review and Practice remain one click away — until
      // a different piece is actually chosen. Only a take that was opened and
      // never submitted is let go, since there is no way back to it.
      if (step === 'perform' && sessionId) {
        void api.discardSession(sessionId).catch(() => {})
      }
      setStep('select')
    }
    else if (stage === 'input') setStep('calibrate')
    else if (stage === 'perform') setStep('perform')
    else if (stage === 'review') setStep('report')
    else openPractice()
  }
  /**
   * "Record again" means record again. When the instrument is still connected
   * and checked there is nothing to set up, so the take starts; only when it is
   * not does the player go back through Input.
   */
  const inputReady = inputSource === 'midi-upload' ||
    (inputSource === 'microphone' && microphoneState === 'ready') ||
    (inputSource === 'web-midi' && Boolean(selectedInput) && workflow.deviceConnected &&
      calibration.centerC && calibration.noteCount >= 5)
  const recordAgain = () => {
    if (!inputReady) {
      setStep('calibrate')
      return
    }
    sendWorkflow({ type: 'START_DEVICE_SETUP' })
    void startSession()
  }
  const clearGeneratedExercises = async () => {
    if (!window.confirm(t('clearGeneratedExercisesConfirm'))) return
    setLoading(true); clearNotices()
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
      notify('success', () => tf('generatedExercisesCleared', { count: result.clearedCount }))
    } catch (error) {
      notify('error', () => tf('generatedExercisesClearFailed', { detail: (error as Error).message }))
    }
    setLoading(false)
  }
  const scoreLibrary = partitionScoreLibrary(scores)
  const renderScoreCard = (score: ScoreListItem, compact = false) => {
    const category = categoryForScore(score)
    const displayTitle = pieceTitle(score)
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

  const [theme, setTheme] = useTheme()
  const [finish, setFinish] = useFinish()
  const [locale, setLocale, spokenLocale] = useLocale()

  // Everything the server wrote that is on screen now — the library, the open
  // piece, the report, the comparison, the exercise — is fetched again in the
  // new language. Deterministic and cheap: no AI call. The AI's own summary
  // is not rewritten behind the player's back; a cached one in this language
  // is shown if there is one, and otherwise the panel offers to rewrite it.
  const spokenOnceRef = useRef(spokenLocale)
  useEffect(() => {
    if (spokenOnceRef.current === spokenLocale) return
    spokenOnceRef.current = spokenLocale
    const same = <T,>(fresh: T, key: (value: T) => string) =>
      (current: T | null) => (current && key(current) === key(fresh) ? fresh : current)
    void api.listScores().then((r) => setScores(r.scores as ScoreListItem[])).catch(() => {})
    if (scoreDetail) {
      void api.getScore(scoreDetail.scoreId).then((fresh) => {
        setScoreDetail(same(fresh, (value) => value.scoreId))
        // Only the name is language; bar labels and tempo stay as they are.
        setMetaState((current) => current && current.scoreId === fresh.metadata.scoreId
          ? { ...current, title: fresh.metadata.title } : current)
      }).catch(() => {})
    }
    if (exerciseScore) {
      void api.getScore(exerciseScore.scoreId)
        .then((fresh) => setExerciseScore(same(fresh, (value) => value.scoreId))).catch(() => {})
    }
    for (const [held, set] of [[report, setReport], [baselineReport, setBaselineReport]] as const) {
      if (!held) continue
      void api.getReport(held.reportId).then((fresh) => {
        set(same(fresh, (value) => value.reportId))
        setSelectedError((current) => current
          ? fresh.errors.find((error) => error.id === current.id) ?? current : current)
      }).catch(() => {})
    }
    if (comparison && baselineReport && report) {
      void api.compare(baselineReport.reportId, report.reportId)
        .then((fresh) => setComparison((current) => current ? fresh : current)).catch(() => {})
    }
    if (exercise) {
      void api.getExercise(exercise.exerciseId).then((fresh) => setExercise((current) =>
        current?.exerciseId === fresh.exerciseId ? { ...current, ...fresh } : current)).catch(() => {})
    }
    const args = mentorArgsRef.current
    if (args) {
      const cached = mentorCacheRef.current.get(
        mentorCacheKey(args.report.reportId, args.errorId, args.prompt, spokenLocale))
      if (cached) {
        setMentor(cached)
        setMentorLocale(spokenLocale)
      } else if (mentor?.provider.startsWith('rules')) {
        // The offline mentor costs nothing to ask again, so there is no call
        // to save by keeping its old-language summary on screen.
        void loadMentor(args.report, args.prompt, args.errorId, false)
      }
    }
  // Keyed on the language alone: this is what a language change does, not
  // something to repeat whenever the report changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spokenLocale])

  const rewriteMentor = () => {
    const args = mentorArgsRef.current
    if (args) void loadMentor(args.report, args.prompt, args.errorId)
  }
  const mentorInOtherLanguage = Boolean(mentor && mentorLocale && mentorLocale !== spokenLocale)
  const [uiScale, setUiScale] = useDepth()
  const [settingsOpen, setSettingsOpen] = useState(false)

  const startOver = () => {
    sendWorkflow({ type: 'RESET' }); setReport(null); setBaselineReport(null); setComparison(null)
    setMentorChat([]); setMentorMemory(null); setExercise(null); setExerciseStage('design'); setGenerationNote('')
    setExerciseScore(null); setRetrySessionId(null); setCursor(null); setRecording(false)
    recordingRef.current = false; setSubmissionStage('idle')
    liveRef.current.reset(); setLiveTrace([])
    setLiveFeedback(idleLiveState('web-midi'))
    setScoreId(null); setScoreDetail(null); setNormalization(null); setMeta(null); setEvents([])
    uploadMidiRef.current = null; retryUploadMidiRef.current = null
  }

  /** Only a head row with something in it: an empty fragment is still "something". */
  const headExtras = (...parts: ReactNode[]) =>
    parts.some(Boolean) ? <>{parts.map((part, index) => <Fragment key={index}>{part}</Fragment>)}</> : undefined

  // A generated round says which round it is, wherever it is open.
  const roundBadge = (scoreDetail?.generated || exerciseScore?.generated) ? (
    <span className="round-context" role="status">
      <span>{tf('roundContext', {
        round: exerciseScore?.lineageDepth ?? scoreDetail?.lineageDepth ?? 1,
      })}</span>
    </span>
  ) : null

  const submissionStatus = loading && submissionStage !== 'idle' && submissionStage !== 'complete' ? (
    <span className={`submission-status ${submissionStage}`} role="status">
      <span className="submission-spinner" />
      {submissionStage === 'transcribing'
        ? tf('transcriptionProgress', { value: Math.round(transcriptionProgress * 100) })
        : submissionStage === 'analyzing' ? t('submissionAnalyzing') : t('submissionSaving')}
    </span>
  ) : null

  const microphonePanel = (
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
  )

  const disconnectRecovery = (kind: 'baseline' | 'retry') => (
    <div className="disconnect-recovery" role="alert">
      <strong>{kind === 'retry' ? t('retryDisconnected') : t('midiDisconnectedCursorFrozen')}</strong>
      <span>{t('capturedSafe')}</span>
      <div className="device-grid compact">
        {inputs.map((name) => (
          <button type="button" key={name} className="device-item"
                  onClick={() => pickInput(name)}>{name}</button>
        ))}
      </div>
      <div className="flex">
        <button className="btn btn-sm" onClick={refreshMidiInputs}>{t('rescanDevices')}</button>
        {kind === 'baseline' && (
          <button className="btn btn-sm" onClick={stopAndAnalyze}>{t('submitCurrentRecording')}</button>
        )}
        <button className="btn btn-danger btn-sm" onClick={discardActiveCapture}>
          {kind === 'retry' ? t('discardRetry') : t('discardCurrentRecording')}
        </button>
      </div>
    </div>
  )

  // --- 1 · the piece -------------------------------------------------------
  // An exact MusicXML file has nothing to review: its tempo and metre are the
  // engraver's, and the form showed them greyed out beside a 100% badge. Only
  // an import that made guesses — a MIDI file, a photographed page — or one
  // that has something to say, asks to be checked.
  const importNeedsReview = Boolean(scoreDetail && normalization && (
    scoreDetail.sourceType === 'midi' || scoreDetail.displayMode !== 'exact_notation' ||
    scoreDetail.warnings.length > 0))
  const nextBlockedByReview = scoreDetail?.sourceType === 'midi' && !normalization?.confirmed
  // A left-over take is announced everywhere except on the stage that already
  // shows it with its own "analyse" and "discard" — there the banner only
  // repeated the buttons underneath it.
  const recoveryOnItsOwnStage = Boolean(recoveryContext && (
    (recoveryContext.kind === 'baseline' && step === 'perform') ||
    (recoveryContext.kind === 'retry' && step === 'compare')))
  const discardRecoveredButton = recoveryContext?.kind === 'baseline' ? (
    <button className="btn" onClick={discardRecoveredRecording} disabled={loading}>
      {t('discardRecovery')}
    </button>
  ) : null

  const renderSelect = () => (
    <Stage id="score" layout="library" headExtra={roundBadge}
      main={<>
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
          {scoreLibrary.uploads.length > 0 && (
            <div className="score-list">
              {scoreLibrary.uploads.map((score) => renderScoreCard(score))}
            </div>
          )}
          <UploadZone onFile={importScore} hint={t('uploadScoreHint')}
                      accept=".musicxml,.xml,.mxl,.mid,.midi,.pdf,.png,.jpg,.jpeg,.webp"
                      disabled={loading} />
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
      </>}
      aside={meta && scoreId ? <>
        <div className="piece-head">
          <div>
            <h3>{pieceTitleOf(scoreDetail)}</h3>
            <small>{tf('scoreMeta', {
              measures: meta.measureCount, tempo: meta.tempo, meter: meta.timeSignature,
            })}</small>
          </div>
          {scoreDetail && (
            <span className={`display-badge ${
              scoreDetail.displayMode === 'exact_notation' ? 'exact' : 'simplified'}`}>
              {scoreDetail.displayMode === 'exact_notation' ? t('exactNotation') : t('simplifiedNotation')}
            </span>
          )}
        </div>
        {importNeedsReview && scoreDetail && normalization && (
          <section className="import-review" aria-labelledby="import-review-title">
            <div className="review-heading">
              <div>
                <h3 id="import-review-title">{t('importReview')}</h3>
                <p className="dim">{t('importReviewHint')}</p>
              </div>
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
            {scoreDetail.sourceType === 'midi' && (
              <>
                <div className="review-grid">
                  <label>{t('tempoBpm')}
                    <input type="number" min={20} max={300} value={normalization.tempo}
                           onChange={(e) => setNormalization({ ...normalization,
                             tempo: Number(e.target.value), confirmed: false })} />
                  </label>
                  <label>{t('timeSignature')}
                    <input value={normalization.timeSignature}
                           onChange={(e) => setNormalization({ ...normalization,
                             timeSignature: e.target.value, confirmed: false })} />
                  </label>
                  <label>{t('quantizationGrid')}
                    <select value={normalization.quantization}
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
                {Object.entries(normalization.trackMapping).map(([track, hand]) => (
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
                <button className="btn btn-primary btn-sm" onClick={confirmNormalization}
                        disabled={loading || normalization.confirmed}>
                  {normalization.confirmed ? t('normalizationConfirmed') : t('confirmNormalization')}
                </button>
              </>
            )}
          </section>
        )}
        <section className="score-preview" aria-label={t('scorePreview')}>
          <div className="score-stage">
            <ScoreViewer xmlUrl={api.scoreXmlUrl(scoreId)} title={pieceTitleOf(scoreDetail)}
                         beatsPerMeasure={meta.beatsPerMeasure} />
          </div>
        </section>
      </> : undefined}
      actions={{
        status: meta ? (
          <div className="range-row" role="group" aria-label={t('practiceRange')}>
            <span className="range-label">{t('practiceRange')}</span>
            <span>{t('rangePrefix')}</span>
            <input aria-label={t('rangeStartAria')} type="number" min={1} max={meta.measureCount}
                   value={rangeStart} onChange={(e) => setRangeStart(Number(e.target.value))} />
            <span>–</span>
            <input aria-label={t('rangeEndAria')} type="number" min={1} max={meta.measureCount}
                   value={rangeEnd} onChange={(e) => setRangeEnd(Number(e.target.value))} />
            <span>{tf('rangeSummary', { count: meta.measureCount })}</span>
            {meta.measureCount > rangeEnd && rangeStart === 1 &&
             rangeEnd === openingRange(meta.measureCount).end && (
              <span className="range-note">{tf('practiceRangeShortened', { count: rangeEnd })}</span>
            )}
          </div>
        ) : <span className="dim">{t('choosePieceFirst')}</span>,
        primary: (
          <button className="btn btn-primary" onClick={gotoCalibrate}
                  disabled={loading || !meta || !rangeValid || nextBlockedByReview}
                  title={nextBlockedByReview ? t('confirmNormalizationFirst') : undefined}>
            {t('nextDevice')}
          </button>
        ),
      }}
    />
  )

  // --- 2 · the input -------------------------------------------------------
  const startDisabled = loading ||
    (inputSource === 'web-midi' && (!selectedInput || !calibration.centerC || calibration.noteCount < 5)) ||
    (inputSource === 'microphone' && microphoneState !== 'ready')
  const renderInput = () => (
    <Stage id="input" layout="sources" headExtra={roundBadge}
      main={<>
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
      </>}
      aside={<>
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
              <div className="midi-setup">
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
              </div>
            )}
          </>
        )}
        {inputSource === 'microphone' && microphonePanel}
        {inputSource === 'midi-upload' && (
          <div className="upload-explainer">
            <h3>{t('inputUpload')}</h3>
            <p>{t('uploadFallbackHint')}</p>
          </div>
        )}
      </>}
      actions={{
        back: <button className="btn" onClick={() => setStep('select')} disabled={loading}>{t('back')}</button>,
        primary: (
          <button className="btn btn-primary" onClick={startSession} disabled={startDisabled}>
            {inputSource === 'midi-upload' ? t('enterMidiUpload') : t('startWithCountIn')}
          </button>
        ),
      }}
    />
  )

  // --- 3 · playing ---------------------------------------------------------
  const inputStatusCard = (
    <div className="input-status-card">
      <span className="eyebrow">{t('inputDockTitle')}</span>
      <dl>
        <div><dt>{t('inputSourceLabel')}</dt><dd>{inputSource === 'web-midi' ? t('inputMidi') : t('inputUpload')}</dd></div>
        <div><dt>{t('inputInstrumentLabel')}</dt><dd>{instrumentLabel(instrument)}</dd></div>
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
  )
  const renderPerform = () => (
    <Stage id="perform" layout="desk"
      headExtra={headExtras(uploadMode && <span className="tag">{t('uploadModeSuffix')}</span>, roundBadge)}
      main={meta && scoreId ? (
        <div className="score-stage">
          <ScoreViewer xmlUrl={api.scoreXmlUrl(scoreId)} beatsPerMeasure={meta.beatsPerMeasure}
                       title={pieceTitleOf(scoreDetail)} cursor={cursor} follow={recording}
                       liveFeedback={recording ? liveFeedback : null} />
        </div>
      ) : null}
      aside={<div className="input-dock" aria-label={t('inputDockTitle')}>
        {inputSource === 'web-midi' && workflow.capture && !workflow.deviceConnected &&
          disconnectRecovery('baseline')}
        {inputSource === 'microphone' && (
          <>
            {/* What you are playing leads the rail, as it does for MIDI; the
                setup it came through is reference while you play. */}
            <LivePanel state={liveFeedback} trace={liveTrace} onSkip={skipLivePosition} />
            {microphonePanel}
          </>
        )}
        {inputSource === 'web-midi' && (
          <>
            {/* What you are playing leads the rail; the hardware it arrived on
                is reference, so it sits underneath. */}
            <LivePanel state={liveFeedback} trace={liveTrace} onSkip={skipLivePosition} />
            <div className="held-notes">
              <span className="eyebrow">{t('heldNotes')}</span>
              <div className="live-notes">
                {liveNotes.length
                  ? liveNotes.map((pitch) => <span key={pitch} className="live-note">{midiName(pitch)}</span>)
                  : <span className="dim">{t('heldNotesEmpty')}</span>}
              </div>
            </div>
            {inputStatusCard}
          </>
        )}
        {inputSource === 'midi-upload' && (
          <>
            <p className="dim">{t('uploadedMidiExplanation')}</p>
            {sessionId && <UploadZone onFile={onUploadMidi} accept=".mid,.midi" disabled={loading} />}
            {uploadMidiRef.current && <div className="upload-confirm">{t('performanceFileReady')}</div>}
            {inputStatusCard}
          </>
        )}
      </div>}
      actions={inputSource === 'midi-upload' ? {
        back: <button className="btn" onClick={() => setStep('calibrate')} disabled={loading}>{t('back')}</button>,
        status: submissionStatus,
        primary: (
          <>
            {discardRecoveredButton}
            <button className="btn btn-primary" onClick={stopAndAnalyze}
                    disabled={loading || !uploadMidiRef.current}>{t('submitAnalysis')}</button>
          </>
        ),
      } : inputSource === 'microphone' ? {
        status: submissionStatus ?? (
          <div className="transport-status" aria-live="polite">
            {recording && <span className="rec-dot" />}
            <strong>{microphoneState === 'transcribing'
              ? t('microphoneTranscribing')
              : recording ? t('microphoneRecording')
                : microphoneRef.current?.hasTake(sessionId) ? t('microphoneTakeReady')
                : hasBaselineRecovery ? tf('recoveredNotes', { count: recoveredEvents.length })
                  : t('stopped')}</strong>
            <span className="dim">{t('microphonePreviewOnly')}</span>
          </div>
        ),
        primary: (
          <>
            {!recording && microphoneRef.current?.hasTake(sessionId) && (
              <button className="btn" onClick={() => void discardCaptureAndReturnToScores()}
                      disabled={loading || microphoneState === 'transcribing'}>
                {t('discardTakeAndReturn')}
              </button>
            )}
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
          </>
        ),
      } : {
        status: submissionStatus ?? (workflow.phase === 'analysis'
          ? <span role="status">{t('analysisRunning')}</span>
          : (
            <div className="recording-bar">
              {recording && <span className="rec-dot" />}
              <span>{recording ? t('recording') : (hasBaselineRecovery ? tf('recoveredNotes', { count: recoveredEvents.length }) : t('stopped'))}</span>
              <span className="dim">{cursor ? tf('cursorPosition', {
                measure: measureLabel(cursor.measure), bpm: cursor.bpm ?? '—',
                state: cursor.waiting ? ` · ${t('waitingHere')}` : '',
              }) : t('waitingForNotes')}</span>
            </div>
          )),
        primary: (
          <>
            {hasBaselineRecovery && discardRecoveredButton}
            <button className="btn" disabled={hasBaselineRecovery} onClick={async () => {
              try {
                const player = getPlayer()
                await player.countIn(Math.round(meta!.beatsPerMeasure), meta!.tempo)
              } catch (error) {
                notify('warn', () => tf('countInPlaybackFailed', { detail: (error as Error).message }))
              }
            }}>{t('hearCountIn')}</button>
            <button className="btn btn-danger" onClick={stopAndAnalyze}
                    disabled={loading || workflow.phase === 'analysis' || (!recording && !hasBaselineRecovery)}>
              {hasBaselineRecovery ? t('analyzeRecovered') : t('stopAndAnalyze')}
            </button>
          </>
        ),
      }}
    />
  )

  // --- 5 · practice --------------------------------------------------------
  // The loop inside Practice, so the player can see where they are in it.
  const practiceStep = step === 'compare' ? (comparison ? 3 : 2) : exerciseStage === 'generated' ? 1 : 0
  const practiceTrail = (
    <ol className="practice-trail" aria-label={t('generationLoopAria')}>
      {(['generationStepDesign', 'generationStepResult', 'practiceStepPlayAlong',
        'practiceStepCompare'] as const).map((key, index) => (
        <li key={key} className={index === practiceStep ? 'active' : index < practiceStep ? 'done' : ''}
            aria-current={index === practiceStep ? 'step' : undefined}>{t(key)}</li>
      ))}
    </ol>
  )

  const renderExerciseDesign = () => (
    <Stage id="practice" layout="bench" heading={t('exerciseDesignTitle')}
      headExtra={headExtras(practiceTrail, roundBadge)}
      main={<div className="exercise-designer">
        <p className="dim stage-lede">{t('exerciseDesignSubtitle')}</p>
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
          {(['generationNoteLeftHand', 'generationNoteFiveMinutes', 'generationNoteRhythm'] as const).map((key) => (
            <button type="button" className="strategy-btn" key={key}
                    onClick={() => setGenerationNote(t(key))}>{t(key)}</button>
          ))}
        </div>
        <div className="ai-generation-note">
          <span>AI</span>
          <div><strong>{t('aiGenerationBoundaryTitle')}</strong><br />{t('aiGenerationBoundary')}</div>
        </div>
      </div>}
      aside={<div className="designer-grid">
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
      </div>}
      actions={{
        back: <button className="btn" onClick={() => leaveExercise('report')}>{t('backToReport')}</button>,
        primary: (
          <button className="btn btn-primary generate-ai-btn" onClick={genExercise} disabled={loading}>
            {loading ? t('aiGeneratingExercise') : t('generateWithAi')}
          </button>
        ),
      }}
    />
  )

  const renderExerciseResult = () => exercise && (
    <Stage id="practice" layout="bench"
      heading={exercise.aiPlan?.title || t('exerciseGeneratedTitle')}
      headExtra={headExtras(practiceTrail, roundBadge)}
      main={scoreId && meta ? (
        <div className="generated-score score-stage">
          <ScoreViewer xmlUrl={exercise.musicXmlUrl} title={pieceTitleOf(exerciseScore)}
                       beatsPerMeasure={meta.beatsPerMeasure} />
        </div>
      ) : null}
      aside={<div className="generated-plan-card">
        <div className="generated-plan-heading">
          <span className="training-kicker">{t('aiPlanLabel')}</span>
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
          <span>{tf('generatedMeasures', { measures: measureLabelList(exercise.sourceMeasures) })}</span>
          <span>{tf('generatedStrategy', {
            strategy: EXERCISE_STRATEGIES.find(([key]) => key === exercise.ruleId)?.[1] || exercise.ruleId,
          })}</span>
          <span>{tf('generatedTempo', { percent: Math.round((exercise.aiPlan?.tempoRatio ?? tempoRatio) * 100) })}</span>
          <span>{tf('generatedLoops', { count: exercise.aiPlan?.loopCount ?? loopCount })}</span>
          {!!exercise.cadencePlan?.length && (
            <span>{tf('generatedCadences', {
              cadences: exercise.cadencePlan.map((item) => CADENCE_LABEL[item] ?? item).join(' → '),
            })}</span>
          )}
        </div>
        <div className="success-criterion">{tf('mentorSuccessCriterion', { criterion: exercise.successCriterion })}</div>
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
      </div>}
      actions={{
        back: (
          <button className="btn" onClick={() => {
            playerRef.current?.stop()
            setPlaying(false)
            setExerciseStage('design')
          }}>{t('backToExerciseDesign')}</button>
        ),
        primary: (
          <>
            <button className="btn" onClick={genExercise} disabled={loading}>
              {loading ? t('aiGeneratingExercise') : t('regenerateWithAi')}
            </button>
            <button className="btn btn-primary" onClick={() => leaveExercise('compare')}>
              {t('enterEnsemble')}
            </button>
          </>
        ),
      }}
    />
  )

  const retryLocked = !!retrySessionId && !comparison
  const renderCompare = () => (
    <Stage id="practice" layout="desk" heading={t('comparisonTitle')}
      headExtra={headExtras(practiceTrail, roundBadge)}
      main={comparison && baselineReport && report ? (
        retryScoreMeta && retryScoreXmlUrl ? (
          <div className="retry-score-target score-stage">
            <ScoreViewer
              xmlUrl={retryScoreXmlUrl} beatsPerMeasure={retryScoreMeta.beatsPerMeasure}
              title={pieceTitleOf(exerciseScore)} errors={report.errors}
              resolvedKeys={comparison.targetChanged ? undefined : resolvedKeys}
            />
          </div>
        ) : <div className="alert alert-warn">{t('retryGeneratedUnavailable')}</div>
      ) : retryScoreMeta && retryScoreXmlUrl ? (
        <div className="retry-score-target score-stage">
          <ScoreViewer xmlUrl={retryScoreXmlUrl} title={pieceTitleOf(exerciseScore)}
                       beatsPerMeasure={retryScoreMeta.beatsPerMeasure} cursor={cursor}
                       follow={recording}
                       liveFeedback={recording ? liveFeedback : null} />
        </div>
      ) : <div className="alert alert-warn">{t('retryGeneratedUnavailable')}</div>}
      aside={comparison && baselineReport && report ? (
        <div className="comparison-result">
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
          <p className="comparison-summary">
            {report.inputQuality?.status === 'insufficient'
              ? t('limitedMetricsBody')
              : comparison.targetChanged
              ? tf('lineageComparisonSummary', { remaining: report.errors.length })
              : tf('comparisonSummary', {
                  resolved: comparison.resolvedErrors.length,
                  persistent: comparison.persistentErrors.length,
                  added: comparison.newErrors.length,
                })}
          </p>
          {comparison.targetChanged && (
            <div className="dim lineage-metric-note">{t('lineageMetricNotice')}</div>
          )}
          <div className="alert alert-success">{comparison.suggestion}</div>
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
                <span>{tf('mentorSuccessCriterion', { criterion: mentor.plan[0].successCriterion })}</span>
              </div>
            )}
          </section>
        </div>
      ) : (
        <div className="retry-stage" aria-live="polite">
          <div className="exercise-controls">
            <span className="control-label">{t('accompanimentMode')}</span>
            <div className="strategy-select">
              <button type="button" aria-pressed={accMode === 'flexible'}
                      className={`strategy-btn ${accMode === 'flexible' ? 'active' : ''}`}
                      disabled={loading || retryLocked ||
                        (inputSource === 'microphone' && !headphonesConfirmed)}
                      onClick={() => setAccMode('flexible')}>{t('flexibleFollow')}</button>
              <button type="button" aria-pressed={accMode === 'strict'}
                      className={`strategy-btn ${accMode === 'strict' ? 'active' : ''}`}
                      disabled={loading || retryLocked ||
                        (inputSource === 'microphone' && !headphonesConfirmed)}
                      onClick={() => setAccMode('strict')}>{t('strictTempo')}</button>
            </div>
            {inputSource === 'microphone' && (
              <label className="mode-toggle headphone-warning">
                <input type="checkbox" checked={headphonesConfirmed}
                       disabled={loading || retryLocked}
                       onChange={(event) => setHeadphonesConfirmed(event.target.checked)} />
                {t('microphoneHeadphones')}
              </label>
            )}
          </div>
          {inputSource === 'web-midi' && workflow.capture === 'retry' && !workflow.deviceConnected &&
            disconnectRecovery('retry')}
          {inputSource !== 'midi-upload' && retrySessionId && (
            <LivePanel state={liveFeedback} trace={liveTrace} onSkip={skipLivePosition} />
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
          {inputSource === 'midi-upload' && retrySessionId && (
            <div>
              <p className="dim">{t('uploadFreshRetry')}</p>
              <UploadZone onFile={onUploadRetryMidi} accept=".mid,.midi" disabled={loading} />
              {retryUploadName && <div className="upload-confirm">{tf('readyFile', { name: retryUploadName })}</div>}
            </div>
          )}
        </div>
      )}
      actions={comparison ? {
        back: <button className="btn" onClick={() => setStep('report')}>{t('viewCurrentRoundReport')}</button>,
        primary: (
          <>
            <button className="btn" onClick={startOver}>{t('restart')}</button>
            <button className="btn btn-primary" onClick={continueFromCurrentRound}>
              {report?.errors.length ? t('generateFromCurrentRound') : t('increaseChallenge')}
            </button>
          </>
        ),
      } : {
        back: (
          <button className="btn" onClick={() => setStep('exercise')} disabled={retryLocked}>
            {t('backToExercise')}
          </button>
        ),
        status: submissionStatus ?? (retrySessionId ? (
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
        ) : null),
        primary: (
          <>
            {retrySessionId && (
              <button className="btn" onClick={cancelRetry} disabled={loading}>{t('cancelRetry')}</button>
            )}
            {retrySessionId ? (
              <button className="btn btn-danger" onClick={stopRetryAndCompare}
                      disabled={loading || (uploadMode
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
            ) : (
              <button className="btn btn-primary" onClick={startAccompaniment}
                      disabled={loading || recording}>
                {inputSource === 'microphone'
                  ? (headphonesConfirmed ? t('startMicrophoneRetryWithAccompaniment') : t('startMicrophoneRetry'))
                  : t('startAccompaniment')}
              </button>
            )}
          </>
        ),
      }}
    />
  )

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="brand">{t('appName')}</h1>
        <StudioStepper active={studioStage} canOpen={canOpenStudioStage}
                       onOpen={openStudioStage} />
        <button type="button" className="btn btn-sm settings-open"
                aria-haspopup="dialog" aria-expanded={settingsOpen}
                title={t('settingsOpen')} aria-label={t('settingsOpen')}
                onClick={() => setSettingsOpen(true)}>⚙</button>
      </header>

      <NoticeStack notices={notices} onDismiss={dismissNotice} />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        theme={theme} onTheme={setTheme}
        finish={finish} onFinish={setFinish}
        locale={locale} onLocale={setLocale}
        depth={uiScale} onDepth={setUiScale}
      />

      <main className="app-body">
      {workflow.lastRejection === 'CAPTURE_ACTIVE' && (
        <div className="alert alert-warn" role="alert">{t('captureActiveGuard')}</div>
      )}
      {/* Gated on the context, not on the note count. A microphone take or an
          uploaded file recovers without any MIDI events, so keying this on
          recoveredEvents left those two with a warning on every load and no
          button to clear it — the only way out was wiping storage by hand. */}
      {recoveryContext && !recoveryOnItsOwnStage && (
        <div className="recovery-banner" role="status">
          <span>{recoveredEvents.length > 0
            ? tf('localRecovery', { count: recoveredEvents.length })
            : t('localRecoveryTake')}</span>
          <button type="button" className="btn btn-sm" onClick={discardRecoveredRecording}
                  disabled={loading}>{t('discardRecovery')}</button>
        </div>
      )}

      <Suspense fallback={<div className="stage score-loading">{t('scoreEngineLoading')}</div>}>
        {step === 'select' && renderSelect()}
        {step === 'calibrate' && renderInput()}
        {step === 'perform' && renderPerform()}
        {step === 'report' && report && (
          <CoachReport
            depth={uiScale}
            report={report}
            baseline={baselineReport}
            beatsPerMeasure={meta?.beatsPerMeasure}
            scoreXmlUrl={scoreId ? api.scoreXmlUrl(scoreId) : undefined}
            scoreTitle={pieceTitleOf(scoreDetail)}
            headExtra={roundBadge}
            selectedError={selectedError}
            mentor={mentor}
            mentorLoading={mentorLoading}
            mentorInOtherLanguage={mentorInOtherLanguage}
            onRewriteMentor={rewriteMentor}
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
            onRerecord={recordAgain}
            onGenerateExercise={openExerciseDesigner}
          />
        )}
        {step === 'exercise' && (exerciseStage === 'generated' && exercise
          ? renderExerciseResult() : renderExerciseDesign())}
        {step === 'compare' && renderCompare()}
      </Suspense>
      </main>
    </div>
  )
}

// ---- 辅助组件 ----
function UploadZone({ onFile, accept, disabled, hint }: {
  onFile: (f: File) => void; accept: string; disabled?: boolean; hint?: string
}) {
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
      <div className="upload-zone-label">{t('fileDrop')}{disabled ? t('processingSuffix') : ''}</div>
      {hint && <div className="upload-zone-hint">{hint}</div>}
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
