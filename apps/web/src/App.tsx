import { lazy, Suspense, useEffect, useReducer, useRef, useState } from 'react'
import { api } from './api/client'
import type {
  ComparisonResult, DiagnosisReport, ErrorEvent, ExerciseResult,
  MentorPlanItem, MentorResponse, PerformanceEvent, ScoreDetail, ScoreEvent, ScoreMeta, ScoreNormalization,
} from './types'
import { MidiCapture } from './features/midi/midiCapture'
import { FollowerClient, type FollowerPosition } from './features/follower/followerClient'
import { errorDetailForDisplay } from './features/report/errorPresentation'
import type { MidiPlayer } from './features/audio/player'
import {
  initialWorkflowState, workflowReducer, workspaceForPhase, type WorkflowPhase,
} from './workflow/machine'
import {
  ERROR_TYPE_LABEL, EXERCISE_STRATEGIES, METRIC_LABEL, SEVERITY_LABEL, t, tf,
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
  savedAt: number
}
type MentorChatMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  status: 'sending' | 'sent' | 'error'
  response?: MentorResponse
  error?: string
}
type ExerciseStage = 'design' | 'generated'
type ScoreListItem = ScoreMeta & {
  builtin: boolean
  generated?: boolean
  lineageDepth?: number
}

const RECOVERY_CONTEXT_KEY = 'ai-music-mentor:active-session'
const MENTOR_CHAT_KEY_PREFIX = 'ai-music-mentor:mentor-chat:'
const MENTOR_QUICK_QUESTIONS = [
  t('mentorQuickWhy'), t('mentorQuickPractice'), t('mentorQuickPlan'),
]

function readMentorChat(reportId: string): MentorChatMessage[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(`${MENTOR_CHAT_KEY_PREFIX}${reportId}`) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((message) => message &&
      (message.role === 'user' || message.role === 'assistant') &&
      typeof message.text === 'string' && typeof message.id === 'string')
      .map((message) => message.status === 'sending'
        ? { ...message, status: 'error', error: t('mentorChatInterrupted') }
        : message)
      .slice(-40) as MentorChatMessage[]
  } catch { return [] }
}

function writeMentorChat(reportId: string, messages: MentorChatMessage[]): void {
  try {
    localStorage.setItem(
      `${MENTOR_CHAT_KEY_PREFIX}${reportId}`,
      JSON.stringify(messages.slice(-40)),
    )
  } catch { /* text chat remains available in memory */ }
}

function clientMessageId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `chat_${Date.now()}_${Math.random()}`
}

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

const STEP_LABELS: { key: Step; label: string }[] = [
  { key: 'select', label: t('stepPrepare') },
  { key: 'calibrate', label: t('stepDevice') },
  { key: 'perform', label: t('stepPerform') },
  { key: 'report', label: t('stepReport') },
  { key: 'exercise', label: t('stepExercise') },
  { key: 'compare', label: t('stepCompare') },
]

const PHASE_TO_STEP: Record<WorkflowPhase, Step> = {
  import: 'select', review: 'select', device_setup: 'calibrate', count_in: 'perform',
  recording: 'perform', analysis: 'perform', report: 'report', exercise: 'exercise',
  retry: 'compare', comparison: 'compare',
}

export default function App() {
  const [workflow, sendWorkflow] = useReducer(workflowReducer, initialWorkflowState)
  const step = PHASE_TO_STEP[workflow.phase]
  const [scores, setScores] = useState<ScoreListItem[]>([])
  const [scoreId, setScoreId] = useState<string | null>(null)
  const [scoreDetail, setScoreDetail] = useState<ScoreDetail | null>(null)
  const [normalization, setNormalization] = useState<ScoreNormalization | null>(null)
  const [meta, setMeta] = useState<ScoreMeta | null>(null)
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
  const followerRef = useRef<FollowerClient | null>(null)
  const playerRef = useRef<MidiPlayer | null>(null)
  const playerLoadRef = useRef<Promise<MidiPlayer> | null>(null)
  const [midiSupported, setMidiSupported] = useState(true)
  const [inputs, setInputs] = useState<string[]>([])
  const [selectedInput, setSelectedInput] = useState<string | null>(null)
  const selectedInputRef = useRef<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [liveNotes, setLiveNotes] = useState<number[]>([])
  const [cursor, setCursor] = useState<{ measure: number; beat: number; frozen?: boolean; confidence?: number; bpm?: number } | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [recoveryContext, setRecoveryContext] = useState<RecoveryContext | null>(null)
  const [recoveredEvents, setRecoveredEvents] = useState<PerformanceEvent[]>([])
  const [uploadMode, setUploadMode] = useState(false)
  const [calibration, setCalibration] = useState<CalibrationStatus>({
    noteCount: 0, centerC: false, lastPitch: null, lastVelocity: null,
    jitterMs: null, duplicateMessages: 0,
  })
  const uploadMidiRef = useRef<string | null>(null)

  // 报告
  const [report, setReport] = useState<DiagnosisReport | null>(null)
  const [baselineReport, setBaselineReport] = useState<DiagnosisReport | null>(null)
  const [selectedError, setSelectedError] = useState<ErrorEvent | null>(null)
  const [mentor, setMentor] = useState<MentorResponse | null>(null)
  const [mentorLoading, setMentorLoading] = useState(false)
  const [mentorChat, setMentorChat] = useState<MentorChatMessage[]>([])
  const [mentorChatLoading, setMentorChatLoading] = useState(false)
  const [question, setQuestion] = useState('')
  const mentorCacheRef = useRef(new Map<string, MentorResponse>())
  const mentorPendingRef = useRef(new Map<string, Promise<MentorResponse>>())
  const mentorRequestRef = useRef(0)

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

  // 对比
  const [comparison, setComparison] = useState<ComparisonResult | null>(null)
  const [accMode, setAccMode] = useState<'strict' | 'flexible'>('flexible')
  const [retrySessionId, setRetrySessionId] = useState<string | null>(null)
  const retryUploadMidiRef = useRef<string | null>(null)
  const [retryUploadName, setRetryUploadName] = useState<string | null>(null)
  const [retryTempo, setRetryTempo] = useState<number | null>(null)
  const accompanimentBpmRef = useRef(0)
  const lastTempoMeasureRef = useRef<number | null>(null)

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
      sendWorkflow({ type: 'DEVICE_LOST' })
      setCursor((previous) => previous ? { ...previous, frozen: true } : previous)
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
    const stored = readRecoveryContext()
    if (stored) {
      void (async () => {
        let recovered: PerformanceEvent[] = []
        try {
          recovered = await MidiCapture.recover(stored.sessionId)
          if (!recovered.length) {
            await MidiCapture.clearRecovery(stored.sessionId)
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
          setUploadMode(false); setRecording(false); setRecoveredEvents(recovered)
          setRecoveryContext(stored)
          if (stored.kind === 'baseline') {
            setSessionId(stored.sessionId)
            sendWorkflow({ type: 'CAPTURE_RESTORED', kind: 'baseline' })
          } else {
            setRetrySessionId(stored.sessionId)
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
            msg: tf('recoveredNotesCanSubmit', { count: recovered.length }),
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
      capture.dispose(); playerRef.current?.dispose(); followerRef.current?.stop()
    }
  }, [])

  const getPlayer = (): Promise<MidiPlayer> => {
    if (playerRef.current) return Promise.resolve(playerRef.current)
    if (!playerLoadRef.current) {
      playerLoadRef.current = import('./features/audio/player')
        .then(({ MidiPlayer: Player }) => {
          const player = new Player()
          playerRef.current = player
          return player
        })
        .catch((error) => {
          playerLoadRef.current = null
          throw error
        })
    }
    return playerLoadRef.current
  }

  const discardRecoveredRecording = async () => {
    const context = recoveryContext
    if (!context) return
    await MidiCapture.clearRecovery(context.sessionId)
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

  const discardActiveCapture = async () => {
    const activeSessionId = workflow.capture === 'retry' ? retrySessionId : sessionId
    if (!activeSessionId) return
    if (recording) captureRef.current?.stopCapture({ persist: false })
    followerRef.current?.stop(); playerRef.current?.stop()
    await api.discardSession(activeSessionId).catch(() => {})
    await MidiCapture.clearRecovery(activeSessionId)
    clearStoredRecoveryContext(activeSessionId)
    setRecording(false); setCursor(null); setRecoveredEvents([]); setRecoveryContext(null)
    if (workflow.capture === 'retry') setRetrySessionId(null)
    else setSessionId(null)
    sendWorkflow({ type: 'CAPTURE_DISCARDED' })
    setAlert({ type: 'info', msg: t('captureDiscarded') })
  }

  const stepIndex = STEP_LABELS.findIndex((s) => s.key === step)
  const rangeValid = !!meta && Number.isInteger(rangeStart) && Number.isInteger(rangeEnd) &&
    rangeStart >= 1 && rangeEnd >= rangeStart && rangeEnd <= meta.measureCount

  // ---- 选曲 ----
  const selectScore = async (id: string) => {
    setLoading(true); setAlert(null)
    try {
      const r = await api.getScore(id)
      setScoreId(id); setMeta(r.metadata); setEvents(r.scoreEvents)
      setScoreDetail(r); setNormalization(r.normalization)
      setExercise(null); setExerciseScore(null); setComparison(null)
      setRangeEnd(r.metadata.measureCount)
      setRangeStart(1)
      sendWorkflow({ type: 'SCORE_SELECTED' })
    } catch (e) { setAlert({ type: 'error', msg: tf('scoreLoadFailed', { detail: (e as Error).message }) }) }
    setLoading(false)
  }

  const importScore = async (file: File) => {
    setLoading(true); setAlert(null)
    try {
      const r = await api.importScore(file)
      setScores((s) => [...s.filter((x) => x.scoreId !== r.scoreId), {
        ...r.metadata, builtin: false, generated: false, lineageDepth: 0,
      }])
      setScoreId(r.scoreId); setMeta(r.metadata); setEvents(r.scoreEvents)
      setScoreDetail(r); setNormalization(r.normalization)
      setExercise(null); setExerciseScore(null); setComparison(null)
      setRangeStart(1); setRangeEnd(r.metadata.measureCount)
      sendWorkflow({ type: 'SCORE_SELECTED' })
      setAlert({ type: 'success', msg: tf('scoreImported', { title: r.metadata.title }) })
    } catch (e) {
      const err = e as Error & { code?: string }
      setAlert({ type: 'error', msg: err.code === 'SCORE_UNSUPPORTED' ? err.message : tf('scoreImportFailed', { detail: err.message }) })
    }
    setLoading(false)
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
    void getPlayer().catch(() => { /* 仅预取；真正播放时会显示错误 */ })
    sendWorkflow({ type: 'START_DEVICE_SETUP' }); setAlert(null); setLiveNotes([])
    setCalibration({ noteCount: 0, centerC: false, lastPitch: null, lastVelocity: null,
      jitterMs: null, duplicateMessages: 0 })
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
    }
  }

  const pickInput = (name: string) => {
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
    if (!uploadMode && !selectedInput) {
      setAlert({ type: 'warn', msg: t('chooseMidiOrUpload') })
      return
    }
    setLoading(true); setAlert(null)
    let countInPlayer: MidiPlayer | null = null
    let audioReady = uploadMode
    if (!uploadMode) {
      try {
        countInPlayer = await getPlayer()
        await countInPlayer.unlock()
        audioReady = true
      } catch { /* 会话仍可录制，稍后给出无预备拍提示 */ }
    }
    try {
      const r = await api.createSession(scoreId, rangeStart, rangeEnd, uploadMode ? 'midi-file' : selectedInput!)
      setSessionId(r.sessionId)
      uploadMidiRef.current = null
      setCursor(null); setLiveNotes([]); setRecording(false)
      if (uploadMode) {
        sendWorkflow({ type: 'CAPTURE_STARTED', kind: 'baseline' })
      } else {
        sendWorkflow({ type: 'COUNT_IN_STARTED' })
        const follower = new FollowerClient()
        follower.onPosition = (p) => setCursor({
          measure: p.measureNo, beat: p.onsetBeat, frozen: p.frozen,
          confidence: p.confidence, bpm: p.bpm,
        })
        follower.onError = () => setAlert({
          type: 'warn', msg: t('realtimeCursorUnavailable'),
        })
        follower.start(buildOnsets(events, rangeStart, rangeEnd), meta.beatsPerMeasure, meta.tempo)
        followerRef.current = follower
        captureRef.current!.onGroup = (group) => follower.feed({
          id: group.id, tOnMs: group.tOnMs, pitches: group.pitches,
        })
        setAlert({ type: 'info', msg: tf('countInStarts', { beats: r.countIn.beats }) })
        try {
          if (!audioReady || !countInPlayer) throw new Error(t('audioContextUnavailable'))
          await countInPlayer.countIn(r.countIn.beats, r.countIn.bpm)
        } catch {
          setAlert({ type: 'warn', msg: t('countInUnavailable') })
        }
        captureRef.current!.startCapture(r.sessionId)
        sendWorkflow({ type: 'CAPTURE_STARTED', kind: 'baseline' })
        writeRecoveryContext({
          kind: 'baseline', sessionId: r.sessionId, scoreId,
          rangeStart, rangeEnd, savedAt: Date.now(),
        })
        setRecording(true)
        setAlert({ type: 'info', msg: t('recordingDeterministic') })
      }
    } catch (e) { setAlert({ type: 'error', msg: tf('createSessionFailed', { detail: (e as Error).message }) }) }
    setLoading(false)
  }

  // ---- 上传 MIDI 降级 ----
  const onUploadMidi = async (file: File) => {
    if (!sessionId) return
    uploadMidiRef.current = null
    setLoading(true); setAlert(null)
    try {
      const r = await api.uploadMidi(sessionId, file)
      setAlert({ type: 'success', msg: tf('midiUploaded', { name: file.name }) })
      uploadMidiRef.current = r.uploadedMidiRef
    } catch (e) { setAlert({ type: 'error', msg: tf('uploadFailed', { detail: (e as Error).message }) }) }
    setLoading(false)
  }
  // ---- 停止演奏 → 提交分析 ----
  const stopAndAnalyze = async () => {
    if (!sessionId) return
    if (uploadMode && !uploadMidiRef.current) {
      setAlert({ type: 'warn', msg: t('uploadPerformanceFirst') })
      return
    }
    setLoading(true); setAlert(null)
    const usingRecoveredEvents = recoveryContext?.kind === 'baseline' && recoveredEvents.length > 0
    let eventsToSubmit: PerformanceEvent[] = []
    let midiRef: string | undefined
    if (uploadMode && uploadMidiRef.current) {
      midiRef = uploadMidiRef.current
    } else if (usingRecoveredEvents) {
      eventsToSubmit = recoveredEvents
    } else {
      setRecording(false)
      eventsToSubmit = captureRef.current!.stopCapture()
      await captureRef.current!.flushBatches()
    }
    followerRef.current?.stop()
    setCursor(null)
    sendWorkflow({ type: 'SUBMIT_CAPTURE' })
    try {
      const r = await api.finishSession(sessionId, eventsToSubmit, midiRef)
      const rep = await api.getReport(r.reportId)
      setReport(rep); setBaselineReport(rep)
      setSelectedError(rep.errors[0] ?? null)
      setMentor(null)
      setMentorChat(readMentorChat(rep.reportId))
      sendWorkflow({ type: 'ANALYSIS_COMPLETED' })
      await MidiCapture.clearRecovery(sessionId)
      clearStoredRecoveryContext(sessionId)
      setRecoveredEvents([]); setRecoveryContext(null)
      // 预取导师解释
      void loadMentor(rep, '', rep.errors[0]?.id, false)
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'ALIGNMENT_LOW_CONFIDENCE') {
        setAlert({ type: 'warn', msg: t('lowAlignmentConfidence') })
      } else { setAlert({ type: 'error', msg: tf('analysisFailed', { detail: err.message }) }) }
      sendWorkflow({ type: 'ANALYSIS_FAILED' })
      if (!uploadMode && !usingRecoveredEvents) {
        const context = readRecoveryContext()
        if (context && eventsToSubmit.length) {
          setRecoveryContext(context)
          setRecoveredEvents(eventsToSubmit)
        }
      }
    }
    setLoading(false)
  }

  // ---- 导师追问 ----
  const askMentor = async (prompt?: string, retryMessageId?: string) => {
    if (!report || mentorChatLoading || mentorLoading) return
    const text = (prompt ?? question).trim()
    if (!text) return
    setAlert(null)
    const history = mentorChat
      .filter((message) => message.status === 'sent')
      .map((message) => ({ role: message.role, content: message.text }))
      .slice(-10)
    const userId = retryMessageId ?? clientMessageId()
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
    try {
      const response = await api.mentor(
        report.reportId, text, selectedError?.id, history)
      pendingMessages = [
        ...pendingMessages.map((message) => message.id === userId
          ? { ...message, status: 'sent' as const, error: undefined }
          : message),
        {
          id: clientMessageId(), role: 'assistant' as const,
          text: response.summary, status: 'sent' as const, response,
        },
      ]
      setMentorChat(pendingMessages)
      writeMentorChat(report.reportId, pendingMessages)
      if (!prompt) setQuestion('')
    } catch (error) {
      const detail = (error as Error).message
      pendingMessages = pendingMessages.map((message) => message.id === userId
        ? { ...message, status: 'error' as const, error: detail }
        : message)
      setMentorChat(pendingMessages)
      writeMentorChat(report.reportId, pendingMessages)
      setAlert({ type: 'warn', msg: tf('mentorUnavailableWithDetail', { detail }) })
    } finally {
      setMentorChatLoading(false)
    }
  }

  // ---- 生成练习 ----
  const genExercise = async () => {
    if (!report) return
    setLoading(true); setAlert(null)
    try {
      const r = await api.createExercise(report.reportId,
        selectedError ? [selectedError.id] : [],
        { strategy, tempoRatio, loopCount, hands }, generationNote, true)
      if (!r.practiceScoreId) throw new Error(t('exerciseScoreUnavailable'))
      const generatedScore = await api.getScore(r.practiceScoreId)
      setExercise(r)
      setExerciseScore(generatedScore)
      setBaselineReport(report)
      setComparison(null)
      setScores((previous) => [
        ...previous.filter((item) => item.scoreId !== generatedScore.scoreId),
        {
          ...generatedScore.metadata, builtin: false, generated: true,
          lineageDepth: generatedScore.lineageDepth ?? r.lineageDepth ?? 1,
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
      setAlert({ type: 'success', msg: tf('exerciseGenerated', { rule: strategyLabel, measures: r.sourceMeasures.join('-') }) })
    } catch (e) { setAlert({ type: 'error', msg: tf('exerciseFailed', { detail: (e as Error).message }) }) }
    setLoading(false)
  }

  const playExercise = async () => {
    if (!exercise) return
    setPlaying(true)
    try {
      const player = await getPlayer()
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
      const { ensureAudio, parsePitchNames, playPitches } = await import('./features/audio/player')
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
    if (!exercise) {
      setAlert({ type: 'warn', msg: t('generateExerciseBeforeRetry') })
      setStep('exercise')
      return
    }
    if (!uploadMode && !selectedInput) {
      setAlert({ type: 'warn', msg: t('midiReconnectRequired') })
      return
    }
    setLoading(true); setAlert(null)
    setPlaying(false)
    setComparison(null); setCursor(null); setRetryTempo(null); setRetryUploadName(null)
    retryUploadMidiRef.current = null
    followerRef.current?.stop()
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
      const player = await getPlayer()
      await player.unlock()
      const s = await api.createSession(
        targetScore.scoreId, retryRangeStart, retryRangeEnd,
        uploadMode ? 'midi-file' : selectedInput!,
      )
      createdSessionId = s.sessionId
      setRetrySessionId(s.sessionId)
      sendWorkflow({ type: 'RETRY_STARTED' })
      const acc = await api.createAccompaniment(
        targetScore.scoreId, retryRangeStart, retryRangeEnd, accMode,
      )
      const midi = await player.loadMidi(acc.midiUrl)
      accompanimentBpmRef.current = acc.baseTempo
      lastTempoMeasureRef.current = null
      setRetryTempo(acc.baseTempo)
      if (!uploadMode) {
        const follower = new FollowerClient()
        follower.onPosition = (position: FollowerPosition) => {
          setCursor({
            measure: position.measureNo, beat: position.onsetBeat,
            frozen: position.frozen, confidence: position.confidence, bpm: position.bpm,
          })
          if (lastTempoMeasureRef.current === null) {
            lastTempoMeasureRef.current = position.measureNo
          } else if (position.measureNo !== lastTempoMeasureRef.current) {
            lastTempoMeasureRef.current = position.measureNo
            if (accMode === 'flexible' && !position.frozen &&
                position.confidence >= 0.6 && position.bpm > 0) {
              const next = player.followTempo(accompanimentBpmRef.current, position.bpm)
              accompanimentBpmRef.current = next
              player.setBpm(next)
              setRetryTempo(Math.round(next * 10) / 10)
            }
          }
        }
        follower.onError = () => setAlert({
          type: 'warn', msg: t('accompanimentFollowerUnavailable'),
        })
        follower.start(
          buildOnsets(targetScore.scoreEvents, retryRangeStart, retryRangeEnd),
          targetScore.metadata.beatsPerMeasure, targetScore.metadata.tempo,
        )
        followerRef.current = follower
        captureRef.current!.onGroup = (group) => follower.feed({
          id: group.id, tOnMs: group.tOnMs, pitches: group.pitches,
        })
        captureRef.current!.startCapture(s.sessionId)
        sendWorkflow({ type: 'CAPTURE_STARTED', kind: 'retry' })
        writeRecoveryContext({
          kind: 'retry', sessionId: s.sessionId, scoreId: targetScore.scoreId,
          rangeStart: retryRangeStart, rangeEnd: retryRangeEnd,
          baselineReportId: baselineReport.reportId, exerciseId: exercise.exerciseId,
          savedAt: Date.now(),
        })
        captureStarted = true
        setRecording(true)
      } else {
        sendWorkflow({ type: 'CAPTURE_STARTED', kind: 'retry' })
      }
      await player.play(midi, {
        volume: -10,
        onEnd: () => setAlert({ type: 'info', msg: t('accompanimentEnded') }),
      })
      setAlert({
        type: 'info',
        msg: uploadMode
          ? t('accompanimentUploadStarted')
          : tf('accompanimentStarted', {
              mode: accMode === 'flexible' ? t('flexibleTempoDescription') : t('fixedTempoDescription'),
            }),
      })
    } catch (e) {
      if (captureStarted) captureRef.current!.stopCapture({ persist: false })
      if (createdSessionId) {
        await api.discardSession(createdSessionId).catch(() => {})
        await MidiCapture.clearRecovery(createdSessionId)
        clearStoredRecoveryContext(createdSessionId)
      }
      followerRef.current?.stop(); playerRef.current?.stop()
      setRecording(false); setRetrySessionId(null)
      sendWorkflow({ type: 'CAPTURE_DISCARDED' })
      setAlert({ type: 'error', msg: tf('accompanimentFailed', { detail: (e as Error).message }) })
    }
    setLoading(false)
  }

  const onUploadRetryMidi = async (file: File) => {
    if (!retrySessionId) return
    retryUploadMidiRef.current = null
    setRetryUploadName(null)
    setLoading(true); setAlert(null)
    try {
      const result = await api.uploadMidi(retrySessionId, file)
      retryUploadMidiRef.current = result.uploadedMidiRef
      setRetryUploadName(file.name)
      setAlert({ type: 'success', msg: tf('retryMidiUploaded', { name: file.name }) })
    } catch (error) {
      setAlert({ type: 'error', msg: tf('retryMidiUploadFailed', { detail: (error as Error).message }) })
    }
    setLoading(false)
  }

  const cancelRetry = async () => {
    const activeSessionId = retrySessionId
    setLoading(true)
    if (recording) captureRef.current?.stopCapture({ persist: false })
    playerRef.current?.stop(); followerRef.current?.stop()
    if (activeSessionId) {
      await api.discardSession(activeSessionId).catch(() => {})
      await MidiCapture.clearRecovery(activeSessionId)
      clearStoredRecoveryContext(activeSessionId)
    }
    setRecording(false); setRetrySessionId(null); setRetryTempo(null); setCursor(null)
    setRecoveredEvents([]); setRecoveryContext(null); setRetryUploadName(null)
    retryUploadMidiRef.current = null
    sendWorkflow({ type: 'CAPTURE_DISCARDED' })
    setLoading(false)
    setAlert({ type: 'info', msg: t('retryCancelled') })
  }

  const stopRetryAndCompare = async () => {
    if (!retrySessionId || !baselineReport) return
    if (uploadMode && !retryUploadMidiRef.current) {
      setAlert({ type: 'warn', msg: t('uploadFreshRetryFirst') })
      return
    }
    setLoading(true); setAlert(null)
    const usingRecoveredEvents = recoveryContext?.kind === 'retry' && recoveredEvents.length > 0
    let ev: PerformanceEvent[] = []
    let ref: string | undefined
    if (uploadMode && retryUploadMidiRef.current) {
      ref = retryUploadMidiRef.current
    } else if (usingRecoveredEvents) {
      ev = recoveredEvents
    } else {
      setRecording(false)
      ev = captureRef.current!.stopCapture()
      await captureRef.current!.flushBatches()
    }
    playerRef.current?.stop()
    followerRef.current?.stop()
    sendWorkflow({ type: 'SUBMIT_CAPTURE' })
    try {
      const r = await api.finishSession(retrySessionId, ev, ref)
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
      await MidiCapture.clearRecovery(retrySessionId)
      clearStoredRecoveryContext(retrySessionId)
      setRecoveredEvents([]); setRecoveryContext(null)
      sendWorkflow({ type: 'COMPARISON_COMPLETED' })
      void loadMentor(rep2, '', rep2.errors[0]?.id, false)
    } catch (e) {
      if (!uploadMode && !usingRecoveredEvents) {
        const context = readRecoveryContext()
        if (context && ev.length) {
          setRecoveryContext(context)
          setRecoveredEvents(ev)
        }
      }
      sendWorkflow({ type: 'ANALYSIS_FAILED' })
      setAlert({ type: 'error', msg: tf('comparisonFailed', { detail: (e as Error).message }) })
    }
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

  const resolvedKeys = useMemoResolvedKeys(comparison)
  const hasBaselineRecovery = recoveryContext?.kind === 'baseline' && recoveredEvents.length > 0
  const hasRetryRecovery = recoveryContext?.kind === 'retry' && recoveredEvents.length > 0
  const retryScoreXmlUrl = exerciseScore?.renderUrl ?? null
  const retryScoreMeta = exerciseScore?.metadata ?? null
  const workspace = workspaceForPhase(workflow.phase)

  return (
    <div className="app">
      <div className="header">
        <h1>{t('appName')}</h1>
        <span className="subtitle">{t('appSubtitle')}</span>
      </div>

      <nav className="workspaces" aria-label={t('workspaceAriaLabel')}>
        <button type="button" className={workspace === 'score' ? 'active' : ''}
                disabled={workflow.capture !== null}
                onClick={() => sendWorkflow({ type: 'NAVIGATE', phase: scoreId ? 'review' : 'import' })}>
          <span>01</span>{t('workspaceScore')}
        </button>
        <button type="button" className={workspace === 'performance' ? 'active' : ''}
                disabled={!scoreId || workflow.capture !== null}
                onClick={() => sendWorkflow({ type: 'NAVIGATE', phase: 'device_setup' })}>
          <span>02</span>{t('workspacePerformance')}
        </button>
        <button type="button" className={workspace === 'training' ? 'active' : ''}
                disabled={!report || workflow.capture !== null}
                onClick={() => sendWorkflow({ type: 'NAVIGATE', phase: 'report' })}>
          <span>03</span>{t('workspaceTraining')}
        </button>
      </nav>

      <div className="steps">
        {STEP_LABELS.map((s, i) => (
          <span key={s.key} aria-current={step === s.key ? 'step' : undefined}
                className={`step-chip ${step === s.key ? 'active' : i < stepIndex ? 'done' : ''}`}>
            {s.label}
          </span>
        ))}
      </div>

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
        <div className="panel">
          <h2>{t('scorePickerTitle')}</h2>
          <div className="score-list">
            {scores.map((s) => (
              <button type="button" key={s.scoreId}
                      aria-pressed={scoreId === s.scoreId}
                      className={`score-card ${scoreId === s.scoreId ? 'selected' : ''}`}
                      onClick={() => selectScore(s.scoreId)}>
                <div className="title">
                  {s.title}
                  {s.builtin && <span className="tag">{t('builtin')}</span>}
                  {s.generated && (
                    <span className="tag generated">{tf('generatedScoreTag', {
                      round: s.lineageDepth ?? 1,
                    })}</span>
                  )}
                </div>
                <div className="meta">{tf('scoreMeta', {
                  measures: s.measureCount, tempo: s.tempo, meter: s.timeSignature,
                })}</div>
              </button>
            ))}
          </div>
          <h3>{t('uploadScoreTitle')}</h3>
          <p className="dim">{t('uploadScoreHint')}</p>
          <UploadZone onFile={importScore} accept=".musicxml,.xml,.mxl,.mid,.midi" disabled={loading} />
          {scoreDetail && normalization && (
            <section className="import-review" aria-labelledby="import-review-title">
              <div className="review-heading">
                <div>
                  <h3 id="import-review-title">{t('importReview')}</h3>
                  <p className="dim">{t('importReviewHint')}</p>
                </div>
                <span className={`display-badge ${scoreDetail.sourceType === 'midi' ? 'simplified' : 'exact'}`}>
                  {scoreDetail.displayMode === 'exact_notation' ? t('exactNotation') : t('simplifiedNotation')}
                </span>
              </div>
              {scoreDetail.displayMode === 'simplified_quantized_staff' && (
                <div className="alert alert-info">{t('simplifiedNotice')}</div>
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
          {meta && (
            <>
              <h3>{t('practiceRange')}</h3>
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
      )}

      {/* Step 2: 校准 */}
      {step === 'calibrate' && (
        <div className="panel">
          <div className="review-heading">
            <div>
              <h2>{t('usbMidiTitle')}</h2>
              <p className="dim">{t('usbMidiHint')}</p>
            </div>
            <button className="btn btn-sm" type="button" onClick={gotoCalibrate} disabled={loading}>{t('rescan')}</button>
          </div>
          {!midiSupported && <div className="alert alert-warn">{t('midiBrowserFallback')}</div>}
          {midiSupported && (
            <>
              <div className="device-grid">
                {inputs.map((name) => (
                  <button type="button" key={name} aria-pressed={selectedInput === name}
                          className={`device-item ${selectedInput === name ? 'selected' : ''}`}
                          onClick={() => pickInput(name)}>
                    <span className="dot" /> <span>{name}</span>
                  </button>
                ))}
                {inputs.length === 0 && <div className="dim">{t('noMidiInput')}</div>}
              </div>
              {!uploadMode && (
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
              )}
              <div className="flex mt-12">
                <label className="mode-toggle">
                  <input type="checkbox" checked={uploadMode} onChange={(e) => setUploadMode(e.target.checked)} />
                  {t('useMidiUploadFallback')}
                </label>
              </div>
            </>
          )}
          {uploadMode && (
            <div className="mt-20">
              <div className="alert alert-info">{t('uploadFallbackHint')}</div>
            </div>
          )}
          <div className="flex mt-20 between">
            <button className="btn" onClick={() => setStep('select')} disabled={loading}>{t('back')}</button>
            <button className="btn btn-primary" onClick={startSession}
                    disabled={loading || (!selectedInput && !uploadMode) ||
                      (!uploadMode && (!calibration.centerC || calibration.noteCount < 5))}>
              {uploadMode ? t('enterMidiUpload') : t('startWithCountIn')}
            </button>
          </div>
        </div>
      )}

      {/* Step 3: 演奏 */}
      {step === 'perform' && (
        <div className="panel">
          <h2>{t('performanceTitle')} {uploadMode ? t('uploadModeSuffix') : ''}</h2>
          {meta && scoreId && (
            <ScoreViewer xmlUrl={api.scoreXmlUrl(scoreId)} beatsPerMeasure={meta.beatsPerMeasure}
                         cursor={cursor} />
          )}
          {!uploadMode && (
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
              <div className="recording-bar">
                {recording && <span className="rec-dot" />}
                <span>{recording ? t('recording') : (hasBaselineRecovery ? tf('recoveredNotes', { count: recoveredEvents.length }) : t('stopped'))}</span>
                <span className="dim">{t('liveNotes')}</span>
                <div className="live-notes">{liveNotes.map((pitch) => <span key={pitch} className="live-note">{midiName(pitch)}</span>)}</div>
                <span className="dim">| {cursor ? tf('cursorPosition', {
                  measure: cursor.measure, bpm: cursor.bpm ?? '—', state: cursor.frozen ? ` · ${t('relocking')}` : '',
                }) : t('waitingForNotes')}</span>
              </div>
              <div className="flex mt-12 between">
                <button className="btn" disabled={hasBaselineRecovery} onClick={async () => {
                  try {
                    const player = await getPlayer()
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
            </>
          )}
          {uploadMode && (
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
        <div className="panel">
          <h2>{t('reportTitle')}</h2>
          <MetricsView report={report} baseline={baselineReport} />
          {baselineReport && baselineReport.scoreId !== report.scoreId && (
            <div className="dim lineage-metric-note">{t('lineageMetricNotice')}</div>
          )}
          <div className="evidence-layers">
            <section>
              <h3>{t('verifiableFacts')}</h3>
              <p>{tf('evidenceCount', { count: report.evidences.length })}</p>
            </section>
            <section>
              <h3>{t('repeatedPatterns')}</h3>
              <p>{report.patterns.length
                ? report.patterns.map((pattern) => tf('repeatedPattern', {
                    description: pattern.description, count: pattern.sampleCount,
                  })).join('；')
                : t('noRepeatedPattern')}</p>
            </section>
            <section>
              <h3>{t('possibleCauses')}</h3>
              <p>{report.hypotheses.length
                ? report.hypotheses.map((hypothesis) => tf('hypothesisConfidence', {
                    cause: hypothesis.cause, confidence: hypothesis.confidence,
                  })).join('；')
                : t('insufficientEvidence')}</p>
            </section>
          </div>
          {meta && scoreId && (
            <ScoreViewer
              xmlUrl={api.scoreXmlUrl(scoreId)} beatsPerMeasure={meta.beatsPerMeasure}
              errors={report.errors}
              selectedErrorId={selectedError?.id}
              onErrorClick={(e) => chooseError(report, e)}
            />
          )}
          <h3>{tf('errorList', { count: report.errors.length })}</h3>
          <div className="error-list">
            {report.errors.map((e) => {
              const displayDetail = errorDetailForDisplay(e, report.evidences)
              return (
                <button type="button" key={e.id}
                        className={`error-item ${selectedError?.id === e.id ? 'selected' : ''}`}
                        onClick={() => chooseError(report, e)}>
                  <span className="badge" style={{ background: errColor(e.type) }}>
                    {ERROR_TYPE_LABEL[e.type] ?? e.type}
                  </span>
                  <span className="desc">
                    {tf('errorPosition', {
                      measure: e.location.measure, beat: e.location.beat + 1, severity: SEVERITY_LABEL[e.severity],
                    })}
                    {displayDetail && ` · ${displayDetail}`}
                  </span>
                  <span className="conf">{tf('confidence', { value: e.confidence })}</span>
                </button>
              )
            })}
            {report.errors.length === 0 && <div className="dim">{t('noErrors')}</div>}
          </div>

          {selectedError && (
            <EvidenceDrawer report={report} err={selectedError} onPlayCompare={playEvidence} />
          )}

          {mentorLoading && (
            <div className="mentor-box mentor-loading" role="status">
              <span className="mentor-loading-dot" />
              {t('mentorThinking')}
            </div>
          )}

          {mentor && !mentorLoading && (
            <div className="mentor-box">
              <div className="mentor-header">
                <div className="mentor-label">{t('mentorLayer')}</div>
                <div className={`mentor-meta ${mentor.provider.startsWith('rules') ? 'fallback' : ''}`}>
                  {mentor.provider.startsWith('rules')
                    ? (mentor.provider === 'rules' ? t('mentorLocalRules') : t('mentorLocalFallback'))
                    : tf('mentorProviderMeta', {
                        provider: mentor.provider,
                        model: mentor.model || 'OpenAI-compatible',
                        latency: mentor.latencyMs ?? 0,
                      })}
                </div>
              </div>
              <div className="summary">{mentor.summary}</div>
              {mentor.evidence.length > 0 && (
                <section className="mentor-section">
                  <h4>{t('mentorEvidenceTitle')}</h4>
                  <div className="mentor-evidence-list">
                    {mentor.evidence.map((evidence, index) => (
                      <div className="mentor-evidence" key={`${evidence.measure}:${evidence.beat}:${index}`}>
                        <span>{tf('mentorEvidencePosition', {
                          measure: evidence.measure, beat: evidence.beat + 1,
                        })}</span>
                        {evidence.fact}
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {mentor.hypotheses.length > 0 && (
                <section className="mentor-section">
                  <h4>{t('mentorHypothesesTitle')}</h4>
                  {mentor.hypotheses.map((hypothesis, index) => (
                    <div key={`${hypothesis.cause}:${index}`} className="hyp">
                      • {tf('hypothesisConfidence', {
                        cause: hypothesis.cause, confidence: hypothesis.confidence,
                      })}<br />{t('limitation')}{hypothesis.limitation}
                    </div>
                  ))}
                </section>
              )}
              {mentor.plan.length > 0 && (
                <section className="mentor-section">
                  <h4>{t('mentorPlanTitle')}</h4>
                  <div className="mentor-plan-grid">
                    {mentor.plan.map((plan, index) => (
                      <article className="mentor-plan" key={`${plan.exerciseType}:${index}`}>
                        <strong>{plan.label || plan.exerciseType}</strong>
                        <span>{tf('mentorPlanMeasures', { measures: plan.measures.join('、') })}</span>
                        {plan.tempo && <span>{tf('mentorPlanTempo', { tempo: plan.tempo })}</span>}
                        <span>{tf('mentorPlanRepetitions', { count: plan.repetitions })}</span>
                        <span>{tf('mentorSuccessCriterion', { criterion: plan.successCriterion })}</span>
                        <button className="btn btn-sm" onClick={() => applyMentorPlan(plan)}>
                          {t('mentorApplyPlan')}
                        </button>
                      </article>
                    ))}
                  </div>
                </section>
              )}
              {mentor.encouragement && <div className="encourage">{mentor.encouragement}</div>}
            </div>
          )}
          <section className="mentor-chat mt-20">
            <div className="mentor-chat-heading">
              <div>
                <span className="mentor-chat-kicker">{t('mentorChatKicker')}</span>
                <h3>{t('mentorChatTitle')}</h3>
              </div>
              <span className="dim">{t('mentorChatSaved')}</span>
            </div>
            <div className="mentor-chat-thread" aria-live="polite">
              {mentorChat.length === 0 && (
                <div className="mentor-chat-empty">{t('mentorChatEmpty')}</div>
              )}
              {mentorChat.map((message) => (
                <div className={`chat-row ${message.role}`} key={message.id}>
                  <div className={`chat-bubble ${message.status}`}>
                    <div className="chat-role">
                      {message.role === 'user' ? t('mentorChatYou') : t('mentorChatAi')}
                    </div>
                    <div>{message.text}</div>
                    {message.role === 'assistant' && message.response && (
                      <>
                        <div className={`chat-provider ${message.response.provider.startsWith('rules') ? 'fallback' : ''}`}>
                          {message.response.provider.startsWith('rules')
                            ? (message.response.provider === 'rules'
                                ? t('mentorLocalRules') : t('mentorLocalFallback'))
                            : tf('mentorProviderMeta', {
                                provider: message.response.provider,
                                model: message.response.model || 'OpenAI-compatible',
                                latency: message.response.latencyMs ?? 0,
                              })}
                        </div>
                        {message.response.plan[0] && (
                          <button className="btn btn-sm chat-plan-action"
                                  onClick={() => applyMentorPlan(message.response!.plan[0])}>
                            {t('mentorApplyPlan')}
                          </button>
                        )}
                      </>
                    )}
                    {message.status === 'sending' && (
                      <span className="chat-status">{t('mentorChatSending')}</span>
                    )}
                    {message.status === 'error' && (
                      <div className="chat-error">
                        <span>{tf('mentorChatFailed', { detail: message.error })}</span>
                        <button className="btn btn-sm" disabled={mentorChatLoading || mentorLoading}
                                onClick={() => void askMentor(message.text, message.id)}>
                          {t('mentorChatRetry')}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="mentor-quick">
              <span className="dim">{t('mentorQuickQuestions')}</span>
              {MENTOR_QUICK_QUESTIONS.map((prompt) => (
                <button type="button" className="strategy-btn" key={prompt}
                        disabled={mentorLoading || mentorChatLoading}
                        onClick={() => void askMentor(prompt)}>{prompt}</button>
              ))}
            </div>
            <div className="mentor-composer">
              <textarea value={question} onChange={(e) => setQuestion(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey && question.trim() &&
                              !mentorLoading && !mentorChatLoading) {
                            e.preventDefault()
                            void askMentor()
                          }
                        }}
                        rows={3} maxLength={2000}
                        placeholder={t('mentorQuestionPlaceholder')} />
              <button className="btn btn-primary" onClick={() => void askMentor()}
                      disabled={mentorLoading || mentorChatLoading || !question.trim()}>
                {mentorChatLoading ? t('mentorChatSending') : t('askMentor')}
              </button>
            </div>
            <div className="dim mentor-chat-hint">{t('mentorChatHint')}</div>
          </section>

          <div className="flex mt-20 between">
            <button className="btn" onClick={() => setStep('calibrate')}>{t('rerecord')}</button>
            <button className="btn btn-primary"
                    onClick={() => sendWorkflow({ type: 'EXERCISE_OPENED' })}>{t('generateExerciseNext')}</button>
          </div>
        </div>
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
                  <span className="badge" style={{ background: errColor(selectedError.type) }}>
                    {ERROR_TYPE_LABEL[selectedError.type] ?? selectedError.type}
                  </span>
                  <div>
                    <strong>{tf('exerciseTargetPosition', {
                      measure: selectedError.location.measure,
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
                  <span className={`planner-status ${exercise.plannerProvider?.startsWith('rules') ? 'fallback' : ''}`}>
                    {exercise.plannerProvider?.startsWith('rules')
                      ? (exercise.plannerProvider === 'rules'
                          ? t('exercisePlannerLocal') : t('exercisePlannerFallback'))
                      : tf('exercisePlannerMeta', {
                          provider: exercise.plannerProvider || 'AI',
                          latency: exercise.plannerLatencyMs ?? 0,
                        })}
                  </span>
                </div>
                {exercise.aiPlan?.rationale && <p>{exercise.aiPlan.rationale}</p>}
                {exercise.aiPlan?.noteAcknowledgement && (
                  <div className="note-ack">{exercise.aiPlan.noteAcknowledgement}</div>
                )}
                <div className="plan-facts">
                  <span>{tf('generatedMeasures', { measures: exercise.sourceMeasures.join('、') })}</span>
                  <span>{tf('generatedStrategy', {
                    strategy: EXERCISE_STRATEGIES.find(([key]) => key === exercise.ruleId)?.[1] || exercise.ruleId,
                  })}</span>
                  <span>{tf('generatedTempo', { percent: Math.round((exercise.aiPlan?.tempoRatio ?? tempoRatio) * 100) })}</span>
                  <span>{tf('generatedLoops', { count: exercise.aiPlan?.loopCount ?? loopCount })}</span>
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
                      disabled={loading || (!!retrySessionId && !comparison)}
                      onClick={() => setAccMode('flexible')}>{t('flexibleFollow')}</button>
              <button type="button" aria-pressed={accMode === 'strict'}
                      className={`strategy-btn ${accMode === 'strict' ? 'active' : ''}`}
                      disabled={loading || (!!retrySessionId && !comparison)}
                      onClick={() => setAccMode('strict')}>{t('strictTempo')}</button>
            </div>
            <button className="btn btn-primary btn-sm" onClick={startAccompaniment}
                    disabled={loading || recording || (!!retrySessionId && !comparison)}>{t('startAccompaniment')}</button>
            <button className="btn btn-danger btn-sm" onClick={stopRetryAndCompare}
                    disabled={loading || !retrySessionId || (uploadMode ? !retryUploadMidiRef.current : (!recording && !hasRetryRecovery))}>
              {hasRetryRecovery ? t('analyzeRecoveredComparison') : t('stopAndCompare')}
            </button>
            {retrySessionId && !comparison && (
              <button className="btn btn-sm" onClick={cancelRetry} disabled={loading}>{t('cancelRetry')}</button>
            )}
          </div>

          {retrySessionId && !comparison && (
            <div className="retry-stage" aria-live="polite">
              {!uploadMode && workflow.capture === 'retry' && !workflow.deviceConnected && (
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
                               beatsPerMeasure={retryScoreMeta.beatsPerMeasure} cursor={cursor} />
                </div>
              ) : (
                <div className="alert alert-warn">{t('retryGeneratedUnavailable')}</div>
              )}
              <div className="recording-bar">
                {!uploadMode && recording && <span className="rec-dot" />}
                <span>{uploadMode
                  ? t('midiFileRetry')
                  : (recording ? t('recordingRetry') : (hasRetryRecovery ? tf('recoveredNotes', { count: recoveredEvents.length }) : t('waitingToRecord')))}</span>
                <span className="dim">{tf('accompanimentStatus', { bpm: retryTempo ?? '—' })}</span>
                {cursor && <span className="dim">{tf('followerConfidence', {
                  measure: cursor.measure, confidence: Math.round((cursor.confidence ?? 0) * 100),
                })}</span>}
              </div>
              {uploadMode && (
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
              <div className="table-scroll"><table className="comparison-table">
                <thead><tr><th>{t('metric')}</th><th>{t('previousRound')}</th><th>{t('currentRound')}</th><th>{t('change')}</th></tr></thead>
                <tbody>
                  {(['overallScore', 'pitchScore', 'rhythmScore', 'fluencyScore', 'timingMaeMs'] as const).map((k) => (
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
              </table></div>
              <div className="alert alert-info">
                {comparison.targetChanged
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
                <h3>{report.errors.length
                  ? tf('roundProblemsRemain', { count: report.errors.length })
                  : t('roundPassed')}</h3>
                <p>{mentorLoading
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
              setMentorChat([]); setExercise(null); setExerciseStage('design'); setGenerationNote('')
              setExerciseScore(null); setRetrySessionId(null); setCursor(null); setRecording(false)
              setScoreId(null); setScoreDetail(null); setNormalization(null); setMeta(null); setEvents([])
              uploadMidiRef.current = null; retryUploadMidiRef.current = null
            }} disabled={!!retrySessionId && !comparison}>{t('restart')}</button>
          </div>
        </div>
      )}
      </Suspense>
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

function MetricsView({ report, baseline }: { report: DiagnosisReport; baseline: DiagnosisReport | null }) {
  const m = report.metrics
  const hasComparableBaseline = Boolean(baseline && baseline.scoreId === report.scoreId)
  return (
    <div className="metrics-grid">
      {([
        'overallScore', 'pitchScore', 'rhythmScore', 'fluencyScore', 'timingMaeMs', 'avgBpm',
      ] as const).map((k) => (
        <div key={k} className="metric">
          <div className="label">{METRIC_LABEL[k]}</div>
          <div className="value">{m[k]}</div>
          {baseline && hasComparableBaseline && baseline.metrics[k] !== m[k] && (
            <div className="delta" style={{ color: (k === 'timingMaeMs' ? m[k] < baseline.metrics[k] : m[k] > baseline.metrics[k]) ? 'var(--green)' : 'var(--red)' }}>
              {m[k] > baseline.metrics[k] ? '+' : ''}{(m[k] - baseline.metrics[k]).toFixed(1)}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function EvidenceDrawer({ report, err, onPlayCompare }: {
  report: DiagnosisReport; err: ErrorEvent; onPlayCompare: (text: string) => void
}) {
  const evs = report.evidences.filter((e) => err.evidenceIds.includes(e.id))
  return (
    <div className="evidence-box">
      <h3 style={{ margin: '0 0 8px' }}>{t('evidenceDetails')}</h3>
      {evs.map((ev) => (
        <div key={ev.id} className="fact">
          • {ev.fact}
          <div className="compare">
            {ev.expected && <button className="btn btn-sm" onClick={() => onPlayCompare(ev.expected)}>{t('hearExpected')}</button>}
            {ev.actual && <button className="btn btn-sm" onClick={() => onPlayCompare(ev.actual)}>{t('hearActual')}</button>}
          </div>
        </div>
      ))}
      {evs.length === 0 && <div className="dim">{t('noDetailedEvidence')}</div>}
    </div>
  )
}

// ---- 工具函数 ----
function buildOnsets(events: ScoreEvent[], rs: number, re: number) {
  const map = new Map<string, { onsetId: string; measureNo: number; onsetBeat: number; pitches: number[] }>()
  for (const e of events) {
    if (e.measureNo < rs || e.measureNo > re || e.optional) continue
    const key = `${e.measureNo}:${e.onsetBeat}`
    if (!map.has(key)) {
      const token = String(e.onsetBeat).replace('.', '_')
      map.set(key, { onsetId: `${e.eventId.split(':')[0]}:m${e.measureNo}:b${token}`, measureNo: e.measureNo, onsetBeat: e.onsetBeat, pitches: [] })
    }
    map.get(key)!.pitches.push(...e.pitches)
  }
  return [...map.values()].sort((a, b) => a.measureNo - b.measureNo || a.onsetBeat - b.onsetBeat)
}

function midiName(midi: number): string {
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  return `${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`
}

function errColor(type: string): string {
  return { wrong_pitch: '#e5484d', missed_note: '#8b8d98', extra_note: '#3e63dd', early_late: '#f76b15', duration_anomaly: '#12a594', tempo_instability: '#8e4ec6' }[type] ?? '#e5484d'
}

function useMemoResolvedKeys(comp: ComparisonResult | null): Set<string> {
  return new Set(comp?.resolvedErrors ?? [])
}

function metricDeltaClass(metric: string, delta: number): 'pos' | 'neg' | 'neutral' {
  if (delta === 0) return 'neutral'
  return (metric === 'timingMaeMs' ? delta < 0 : delta > 0) ? 'pos' : 'neg'
}
