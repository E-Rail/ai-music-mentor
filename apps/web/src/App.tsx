import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api/client'
import type {
  ComparisonResult, DiagnosisReport, ErrorEvent, ExerciseResult,
  MentorResponse, PerformanceEvent, ScoreEvent, ScoreMeta,
} from './types'
import { ERROR_TYPE_LABEL, SEVERITY_LABEL } from './types'
import { ScoreViewer } from './features/score/ScoreViewer'
import { MidiCapture } from './features/midi/midiCapture'
import { FollowerClient, type FollowerPosition } from './features/follower/followerClient'
import { MidiPlayer, playPitches, parsePitchNames } from './features/audio/player'

type Step = 'select' | 'calibrate' | 'perform' | 'report' | 'exercise' | 'compare'
const STEP_LABELS: { key: Step; label: string }[] = [
  { key: 'select', label: '1 曲目准备' },
  { key: 'calibrate', label: '2 设备校准' },
  { key: 'perform', label: '3 正式演奏' },
  { key: 'report', label: '4 诊断报告' },
  { key: 'exercise', label: '5 生成练习' },
  { key: 'compare', label: '6 合奏验证' },
]

export default function App() {
  const [step, setStep] = useState<Step>('select')
  const [scores, setScores] = useState<(ScoreMeta & { builtin: boolean })[]>([])
  const [scoreId, setScoreId] = useState<string | null>(null)
  const [meta, setMeta] = useState<ScoreMeta | null>(null)
  const [events, setEvents] = useState<ScoreEvent[]>([])
  const [rangeStart, setRangeStart] = useState(1)
  const [rangeEnd, setRangeEnd] = useState(8)
  const [loading, setLoading] = useState(false)
  const [alert, setAlert] = useState<{ type: string; msg: string } | null>(null)

  // 演奏
  const captureRef = useRef<MidiCapture | null>(null)
  const followerRef = useRef<FollowerClient | null>(null)
  const playerRef = useRef<MidiPlayer | null>(null)
  const [midiSupported, setMidiSupported] = useState(true)
  const [inputs, setInputs] = useState<string[]>([])
  const [selectedInput, setSelectedInput] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [liveNotes, setLiveNotes] = useState<number[]>([])
  const [cursor, setCursor] = useState<{ measure: number; beat: number; frozen?: boolean; confidence?: number; bpm?: number } | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [perfEvents, setPerfEvents] = useState<PerformanceEvent[]>([])
  const [uploadMode, setUploadMode] = useState(false)

  // 报告
  const [report, setReport] = useState<DiagnosisReport | null>(null)
  const [baselineReport, setBaselineReport] = useState<DiagnosisReport | null>(null)
  const [selectedError, setSelectedError] = useState<ErrorEvent | null>(null)
  const [mentor, setMentor] = useState<MentorResponse | null>(null)
  const [question, setQuestion] = useState('')

  // 练习
  const [exercise, setExercise] = useState<ExerciseResult | null>(null)
  const [strategy, setStrategy] = useState('auto')
  const [tempoRatio, setTempoRatio] = useState(0.6)
  const [loopCount, setLoopCount] = useState(4)
  const [hands, setHands] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)

  // 对比
  const [comparison, setComparison] = useState<ComparisonResult | null>(null)
  const [accMode, setAccMode] = useState<'strict' | 'flexible'>('flexible')

  // ---- 初始化 ----
  useEffect(() => {
    api.listScores().then((r) => setScores(r.scores as (ScoreMeta & { builtin: boolean })[])).catch(() => {})
    captureRef.current = new MidiCapture()
    playerRef.current = new MidiPlayer()
    return () => { playerRef.current?.dispose(); followerRef.current?.stop() }
  }, [])

  const stepIndex = STEP_LABELS.findIndex((s) => s.key === step)

  // ---- 选曲 ----
  const selectScore = async (id: string) => {
    setLoading(true); setAlert(null)
    try {
      const r = await api.getScore(id)
      setScoreId(id); setMeta(r.metadata); setEvents(r.scoreEvents)
      setRangeEnd(r.metadata.measureCount)
      setRangeStart(1)
    } catch (e) { setAlert({ type: 'error', msg: `加载失败：${(e as Error).message}` }) }
    setLoading(false)
  }

  const importScore = async (file: File) => {
    setLoading(true); setAlert(null)
    try {
      const r = await api.importScore(file)
      setScores((s) => [...s.filter((x) => x.scoreId !== r.scoreId), { ...r.metadata, builtin: false } as ScoreMeta & { builtin: boolean }])
      await selectScore(r.scoreId)
      setAlert({ type: 'success', msg: `已导入：${r.metadata.title}` })
    } catch (e) {
      const err = e as Error & { code?: string }
      setAlert({ type: 'error', msg: err.code === 'SCORE_UNSUPPORTED' ? '该 MusicXML 无法解析（含复杂跳转或格式错误），请使用内置曲目' : `导入失败：${err.message}` })
    }
    setLoading(false)
  }

  const gotoCalibrate = async () => {
    if (!scoreId) return
    setStep('calibrate'); setAlert(null)
    try {
      const names = await captureRef.current!.requestAccess()
      setInputs(names); setMidiSupported(true)
      if (names.length === 0) {
        setAlert({ type: 'warn', msg: '未发现 MIDI 设备。可使用「上传 MIDI 文件」降级模式继续演示。' })
        setUploadMode(true)
      }
    } catch (e) {
      setMidiSupported(false); setUploadMode(true)
      setAlert({ type: 'warn', msg: '浏览器不支持 Web MIDI 或权限被拒。已切换到「上传 MIDI 文件」降级模式。' })
    }
  }

  const pickInput = (name: string) => {
    if (captureRef.current!.selectInput(name)) {
      setSelectedInput(name); setAlert({ type: 'info', msg: `已选择设备：${name}` })
    }
  }

  // ---- 创建会话 + 进入演奏 ----
  const startSession = async () => {
    if (!scoreId) return
    setLoading(true); setAlert(null)
    try {
      const r = await api.createSession(scoreId, rangeStart, rangeEnd, selectedInput || 'midi-file')
      setSessionId(r.sessionId)
      // 启动跟谱 Worker（onset 聚类）
      const onsets = buildOnsets(events, rangeStart, rangeEnd)
      const follower = new FollowerClient()
      follower.onPosition = (p) => setCursor({ measure: p.measureNo, beat: p.onsetBeat, frozen: p.frozen, confidence: p.confidence, bpm: p.bpm })
      follower.start(onsets, meta!.beatsPerMeasure, meta!.tempo)
      followerRef.current = follower
      // 启动采集
      captureRef.current!.onGroup = (g) => follower.feed({ id: g.id, tOnMs: g.tOnMs, pitches: g.pitches })
      captureRef.current!.onLiveNote = (pitch, _vel, on) => {
        setLiveNotes((prev) => on ? [...prev.slice(-8), pitch] : prev.filter((p) => p !== pitch))
      }
      captureRef.current!.startCapture(r.sessionId)
      setRecording(true); setPerfEvents([]); setCursor(null)
      setStep('perform')
    } catch (e) { setAlert({ type: 'error', msg: `创建会话失败：${(e as Error).message}` }) }
    setLoading(false)
  }

  // ---- 上传 MIDI 降级 ----
  const onUploadMidi = async (file: File) => {
    if (!sessionId) return
    setLoading(true); setAlert(null)
    try {
      const r = await api.uploadMidi(sessionId, file)
      setAlert({ type: 'success', msg: `已上传 ${file.name}，可提交分析` })
      uploadMidiRef.current = r.uploadedMidiRef
    } catch (e) { setAlert({ type: 'error', msg: `上传失败：${(e as Error).message}` }) }
    setLoading(false)
  }
  const uploadMidiRef = useRef<string | null>(null)

  // ---- 停止演奏 → 提交分析 ----
  const stopAndAnalyze = async () => {
    if (!sessionId) return
    setLoading(true); setAlert(null)
    let eventsToSubmit: PerformanceEvent[] = []
    let midiRef: string | undefined
    if (uploadMode && uploadMidiRef.current) {
      midiRef = uploadMidiRef.current
    } else {
      setRecording(false)
      eventsToSubmit = captureRef.current!.stopCapture()
      setPerfEvents(eventsToSubmit)
    }
    followerRef.current?.stop()
    setCursor(null)
    try {
      const r = await api.finishSession(sessionId, eventsToSubmit, midiRef)
      const rep = await api.getReport(r.reportId)
      setReport(rep); setBaselineReport(rep)
      setSelectedError(rep.errors[0] ?? null)
      setStep('report')
      // 预取导师解释
      api.mentor(rep.reportId, '').then(setMentor).catch(() => {})
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'ALIGNMENT_LOW_CONFIDENCE') {
        setAlert({ type: 'warn', msg: '整体对齐置信度过低，无法给出确定性评分。建议重录或缩短练习范围。' })
      } else { setAlert({ type: 'error', msg: `分析失败：${err.message}` }) }
    }
    setLoading(false)
  }

  // ---- 导师追问 ----
  const askMentor = async () => {
    if (!report) return
    const resp = await api.mentor(report.reportId, question, selectedError?.id)
    setMentor(resp)
  }

  // ---- 生成练习 ----
  const genExercise = async () => {
    if (!report) return
    setLoading(true); setAlert(null)
    try {
      const r = await api.createExercise(report.reportId,
        selectedError ? [selectedError.id] : [],
        { strategy, tempoRatio, loopCount, hands })
      setExercise(r)
      setAlert({ type: 'success', msg: `已生成「${r.ruleId}」练习：第 ${r.sourceMeasures.join('-')} 小节` })
    } catch (e) { setAlert({ type: 'error', msg: `生成失败：${(e as Error).message}` }) }
    setLoading(false)
  }

  const playExercise = async () => {
    if (!exercise) return
    setPlaying(true)
    try {
      const midi = await playerRef.current!.loadMidi(exercise.midiUrl)
      await playerRef.current!.play(midi, { onEnd: () => setPlaying(false) })
    } catch { setPlaying(false) }
  }

  // ---- 伴奏 + 再次演奏 → 对比 ----
  const [retrySessionId, setRetrySessionId] = useState<string | null>(null)
  const startAccompaniment = async () => {
    if (!scoreId) return
    setLoading(true); setAlert(null)
    try {
      // 创建第二次会话
      const s = await api.createSession(scoreId, rangeStart, rangeEnd, selectedInput || 'midi-file')
      setRetrySessionId(s.sessionId)
      // 伴奏
      const acc = await api.createAccompaniment(scoreId, rangeStart, rangeEnd, accMode)
      const midi = await playerRef.current!.loadMidi(acc.midiUrl)
      await playerRef.current!.play(midi, { volume: -10, onEnd: () => {} })
      setAlert({ type: 'info', msg: `伴奏已启动（${accMode === 'flexible' ? '柔性跟随' : '严格节拍'}），请跟随演奏` })
      if (!uploadMode) {
        captureRef.current!.startCapture(s.sessionId)
        setRecording(true)
      }
    } catch (e) { setAlert({ type: 'error', msg: `伴奏启动失败：${(e as Error).message}` }) }
    setLoading(false)
  }

  const stopRetryAndCompare = async () => {
    if (!retrySessionId || !report) return
    setLoading(true); setAlert(null)
    let ev: PerformanceEvent[] = []
    let ref: string | undefined
    if (uploadMode && uploadMidiRef.current) {
      ref = uploadMidiRef.current
    } else {
      setRecording(false)
      ev = captureRef.current!.stopCapture()
    }
    playerRef.current?.stop()
    try {
      const r = await api.finishSession(retrySessionId, ev, ref)
      const comp = await api.compare(report.reportId, r.reportId)
      setComparison(comp)
      const rep2 = await api.getReport(r.reportId)
      setReport(rep2)
      setStep('compare')
    } catch (e) { setAlert({ type: 'error', msg: `对比失败：${(e as Error).message}` }) }
    setLoading(false)
  }

  const resolvedKeys = useMemoResolvedKeys(comparison)

  return (
    <div className="app">
      <div className="header">
        <h1>AI 音乐导师</h1>
        <span className="subtitle">MIDI 实时跟谱 · 错误诊断 · 微练习生成 · 自适应伴奏</span>
      </div>

      <div className="steps">
        {STEP_LABELS.map((s, i) => (
          <span key={s.key} className={`step-chip ${step === s.key ? 'active' : i < stepIndex ? 'done' : ''}`}>
            {s.label}
          </span>
        ))}
      </div>

      {alert && <div className={`alert alert-${alert.type}`}>{alert.msg}</div>}

      {/* Step 1: 选曲 */}
      {step === 'select' && (
        <div className="panel">
          <h2>选择曲目或上传 MusicXML</h2>
          <div className="score-list">
            {scores.map((s) => (
              <div key={s.scoreId} className={`score-card ${scoreId === s.scoreId ? 'selected' : ''}`}
                   onClick={() => selectScore(s.scoreId)}>
                <div className="title">{s.title}{s.builtin && <span className="tag">内置</span>}</div>
                <div className="meta">{s.measureCount} 小节 · {s.tempo} BPM · {s.timeSignature}</div>
              </div>
            ))}
          </div>
          <h3>或上传 MusicXML（≤5MB，≤200 小节）</h3>
          <UploadZone onFile={importScore} accept=".musicxml,.xml,.mxl" disabled={loading} />
          {meta && (
            <>
              <h3>练习范围</h3>
              <div className="range-row">
                <span>第</span>
                <input type="number" min={1} max={meta.measureCount} value={rangeStart}
                       onChange={(e) => setRangeStart(Number(e.target.value))} style={{ width: 60 }} />
                <span>–</span>
                <input type="number" min={1} max={meta.measureCount} value={rangeEnd}
                       onChange={(e) => setRangeEnd(Number(e.target.value))} style={{ width: 60 }} />
                <span>小节（共 {meta.measureCount} 小节）</span>
              </div>
              <div className="flex mt-12">
                <button className="btn btn-primary" onClick={gotoCalibrate} disabled={loading}>下一步：设备校准 →</button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Step 2: 校准 */}
      {step === 'calibrate' && (
        <div className="panel">
          <h2>设备校准</h2>
          {!midiSupported && <div className="alert alert-warn">当前浏览器不支持 Web MIDI API。已切换到上传 MIDI 降级模式。</div>}
          {midiSupported && (
            <>
              <div className="device-grid">
                {inputs.map((name) => (
                  <div key={name} className={`device-item ${selectedInput === name ? 'selected' : ''}`}
                       onClick={() => pickInput(name)}>
                    <span className="dot" /> <span>{name}</span>
                  </div>
                ))}
                {inputs.length === 0 && <div className="dim">未发现 MIDI 输入设备</div>}
              </div>
              <div className="live-notes">
                {liveNotes.map((p, i) => <span key={i} className="live-note">{midiName(p)}</span>)}
              </div>
              <div className="dim mt-12">提示：弹一下中央 C（C5）确认信号通畅。</div>
              <div className="flex mt-12 between">
                <button className="btn" onClick={() => setStep('select')}>← 返回</button>
                <label className="btn btn-sm">
                  使用上传 MIDI 降级
                  <input type="checkbox" checked={uploadMode} onChange={(e) => setUploadMode(e.target.checked)} hidden />
                </label>
                <button className="btn btn-primary" onClick={startSession} disabled={loading || (!selectedInput && !uploadMode)}>
                  开始演奏 →
                </button>
              </div>
            </>
          )}
          {uploadMode && (
            <div className="mt-20">
              <h3>上传 MIDI 文件作为演奏记录</h3>
              {sessionId && <UploadZone onFile={onUploadMidi} accept=".mid,.midi" disabled={loading} />}
              <div className="flex mt-12 between">
                <button className="btn" onClick={() => setStep('select')}>← 返回</button>
                <button className="btn btn-primary" onClick={startSession} disabled={loading}>进入演奏 →</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Step 3: 演奏 */}
      {step === 'perform' && (
        <div className="panel">
          <h2>正式演奏 {uploadMode ? '（上传 MIDI 模式）' : ''}</h2>
          {meta && scoreId && (
            <ScoreViewer xmlUrl={api.scoreXmlUrl(scoreId)} beatsPerMeasure={meta.beatsPerMeasure}
                         cursor={cursor} />
          )}
          {!uploadMode && (
            <>
              <div className="recording-bar">
                {recording && <span className="rec-dot" />}
                <span>{recording ? '正在录制…' : '已停止'}</span>
                <span className="dim">| 实时音符：</span>
                <div className="live-notes">{liveNotes.map((p, i) => <span key={i} className="live-note">{midiName(p)}</span>)}</div>
                <span className="dim">| {cursor ? `第${cursor.measure}小节 ${cursor.bpm ?? ''} BPM` : '等待音符…'}</span>
              </div>
              <div className="flex mt-12 between">
                <button className="btn" onClick={async () => {
                  await playerRef.current!.countIn(Math.round(meta!.beatsPerMeasure), meta!.tempo)
                }}>听预备拍</button>
                <button className="btn btn-danger" onClick={stopAndAnalyze} disabled={loading}>
                  停止并分析 →
                </button>
              </div>
            </>
          )}
          {uploadMode && (
            <div className="mt-20">
              <div className="dim">已上传的 MIDI 将作为本次演奏记录提交分析。</div>
              {sessionId && <UploadZone onFile={onUploadMidi} accept=".mid,.midi" disabled={loading} />}
              <div className="flex mt-12 between">
                <button className="btn" onClick={() => setStep('calibrate')}>← 返回</button>
                <button className="btn btn-primary" onClick={stopAndAnalyze} disabled={loading}>提交分析 →</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Step 4: 报告 */}
      {step === 'report' && report && (
        <div className="panel">
          <h2>诊断报告</h2>
          <MetricsView report={report} baseline={baselineReport} />
          {meta && scoreId && (
            <ScoreViewer
              xmlUrl={api.scoreXmlUrl(scoreId)} beatsPerMeasure={meta.beatsPerMeasure}
              errors={baselineReport?.errors ?? report.errors}
              selectedErrorId={selectedError?.id}
              onErrorClick={(e) => { setSelectedError(e); api.mentor(report.reportId, '', e.id).then(setMentor) }}
            />
          )}
          <h3>错误列表（{report.errors.length} 处）</h3>
          <div className="error-list">
            {report.errors.map((e) => (
              <div key={e.id} className={`error-item ${selectedError?.id === e.id ? 'selected' : ''}`}
                   onClick={() => { setSelectedError(e); api.mentor(report.reportId, '', e.id).then(setMentor) }}>
                <span className="badge" style={{ background: errColor(e.type) }}>
                  {ERROR_TYPE_LABEL[e.type] ?? e.type}
                </span>
                <span className="desc">
                  第 {e.location.measure} 小节第 {e.location.beat + 1} 拍 · {SEVERITY_LABEL[e.severity]}
                  {e.detail && ` · ${e.detail}`}
                </span>
                <span className="conf">置信度 {e.confidence}</span>
              </div>
            ))}
            {report.errors.length === 0 && <div className="dim">本次演奏未发现明确错误，完成度很好！</div>}
          </div>

          {selectedError && (
            <EvidenceDrawer report={report} err={selectedError} onPlayCompare={(text) => {
              const ps = parsePitchNames(text)
              if (ps.length) playPitches(ps)
            }} />
          )}

          {mentor && (
            <div className="mentor-box">
              <div className="summary">{mentor.summary}</div>
              {mentor.hypotheses.map((h, i) => (
                <div key={i} className="hyp">• {h.cause}（置信度 {h.confidence}）<br />限制：{h.limitation}</div>
              ))}
              {mentor.encouragement && <div className="encourage">{mentor.encouragement}</div>}
            </div>
          )}
          <div className="flex mt-12">
            <input value={question} onChange={(e) => setQuestion(e.target.value)}
                   placeholder="向 AI 导师追问：为什么这里总是慢？"
                   style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--panel-2)', color: 'var(--text)' }} />
            <button className="btn btn-primary" onClick={askMentor}>追问</button>
          </div>

          <div className="flex mt-20 between">
            <button className="btn" onClick={() => setStep('perform')}>← 重新演奏</button>
            <button className="btn btn-primary" onClick={() => setStep('exercise')}>生成练习 →</button>
          </div>
        </div>
      )}

      {/* Step 5: 练习 */}
      {step === 'exercise' && (
        <div className="panel">
          <h2>生成微练习</h2>
          <div className="exercise-controls">
            <span className="dim">策略：</span>
            <div className="strategy-select">
              {[['auto', '自动'], ['loop', '片段循环'], ['slow_ladder', '慢速阶梯'], ['hands_separate', '拆手'], ['rhythm_variant', '节奏变体'], ['beat_skeleton', '节拍骨架']].map(([k, l]) => (
                <span key={k} className={`strategy-btn ${strategy === k ? 'active' : ''}`} onClick={() => setStrategy(k)}>{l}</span>
              ))}
            </div>
          </div>
          <div className="exercise-controls">
            <span className="dim">速度：</span>
            <input type="range" min={0.4} max={1} step={0.05} value={tempoRatio} onChange={(e) => setTempoRatio(Number(e.target.value))} />
            <span>{Math.round(tempoRatio * 100)}%</span>
            <span className="dim">循环：</span>
            <input type="number" min={1} max={10} value={loopCount} onChange={(e) => setLoopCount(Number(e.target.value))} style={{ width: 50 }} />
            {meta && meta.parts.length > 1 && (
              <>
                <span className="dim">声部：</span>
                <select value={hands ?? ''} onChange={(e) => setHands(e.target.value || null)} style={{ background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px' }}>
                  <option value="">双手</option>
                  <option value="RH">右手</option>
                  <option value="LH">左手</option>
                </select>
              </>
            )}
            <button className="btn btn-primary btn-sm" onClick={genExercise} disabled={loading}>生成</button>
          </div>

          {exercise && (
            <div className="mt-20">
              <div className="alert alert-success">已生成「{exercise.ruleId}」练习 · 第 {exercise.sourceMeasures.join('-')} 小节 · 达标：{exercise.successCriterion}</div>
              {scoreId && (
                <ScoreViewer xmlUrl={exercise.musicXmlUrl} beatsPerMeasure={meta!.beatsPerMeasure} height={200} />
              )}
              <div className="flex mt-12">
                <button className="btn btn-primary" onClick={playExercise} disabled={playing}>
                  {playing ? '播放中…' : '▶ 播放练习'}
                </button>
                <a className="btn" href={exercise.musicXmlUrl} download>下载 MusicXML</a>
                <a className="btn" href={exercise.midiUrl} download>下载 MIDI</a>
              </div>
              {exercise.tempoPlan.length > 1 && (
                <div className="dim mt-12">速度阶梯：{exercise.tempoPlan.map((t) => `${t} BPM`).join(' → ')}</div>
              )}
            </div>
          )}

          <div className="flex mt-20 between">
            <button className="btn" onClick={() => setStep('report')}>← 返回报告</button>
            <button className="btn btn-primary" onClick={() => setStep('compare')}>进入合奏验证 →</button>
          </div>
        </div>
      )}

      {/* Step 6: 对比 */}
      {step === 'compare' && (
        <div className="panel">
          <h2>合奏验证 · 前后对比</h2>
          <div className="exercise-controls">
            <span className="dim">伴奏模式：</span>
            <div className="strategy-select">
              <span className={`strategy-btn ${accMode === 'flexible' ? 'active' : ''}`} onClick={() => setAccMode('flexible')}>柔性跟随</span>
              <span className={`strategy-btn ${accMode === 'strict' ? 'active' : ''}`} onClick={() => setAccMode('strict')}>严格节拍</span>
            </div>
            <button className="btn btn-primary btn-sm" onClick={startAccompaniment} disabled={loading || recording}>启动伴奏并演奏</button>
            <button className="btn btn-danger btn-sm" onClick={stopRetryAndCompare} disabled={loading || !retrySessionId}>停止并对比</button>
          </div>

          {comparison && baselineReport && report && (
            <div className="mt-20">
              <table className="comparison-table">
                <thead><tr><th>指标</th><th>首次</th><th>再次</th><th>变化</th></tr></thead>
                <tbody>
                  {(['overallScore', 'pitchScore', 'rhythmScore', 'fluencyScore', 'timingMaeMs'] as const).map((k) => (
                    <tr key={k}>
                      <td>{METRIC_LABEL[k]}</td>
                      <td>{baselineReport.metrics[k]}</td>
                      <td>{report.metrics[k]}</td>
                      <td className={comparison.metricDelta[k] > 0 === (k === 'timingMaeMs') ? 'neg' : 'pos'}>
                        {comparison.metricDelta[k] > 0 ? '+' : ''}{comparison.metricDelta[k]}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="alert alert-info">
                已解决：{comparison.resolvedErrors.length} 处 · 仍存在：{comparison.persistentErrors.length} 处 · 新增：{comparison.newErrors.length} 处
              </div>
              <div className="alert alert-success">{comparison.suggestion}</div>
              {meta && scoreId && (
                <ScoreViewer
                  xmlUrl={api.scoreXmlUrl(scoreId)} beatsPerMeasure={meta.beatsPerMeasure}
                  errors={report.errors} resolvedKeys={resolvedKeys}
                />
              )}
            </div>
          )}

          <div className="flex mt-20 between">
            <button className="btn" onClick={() => setStep('exercise')}>← 返回练习</button>
            <button className="btn btn-primary" onClick={() => { setStep('select'); setReport(null); setBaselineReport(null); setComparison(null); setExercise(null) }}>重新开始 ↺</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---- 辅助组件 ----
function UploadZone({ onFile, accept, disabled }: { onFile: (f: File) => void; accept: string; disabled?: boolean }) {
  const [drag, setDrag] = useState(false)
  return (
    <div className={`upload-zone ${drag ? 'drag' : ''}`}
         onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
         onDragLeave={() => setDrag(false)}
         onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) onFile(f) }}
         onClick={() => document.getElementById('file-input')?.click()}
    >
      <input id="file-input" type="file" accept={accept} hidden
             onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f) }} />
      <div className="dim">点击或拖拽文件到此处{disabled ? '（处理中…）' : ''}</div>
    </div>
  )
}

function MetricsView({ report, baseline }: { report: DiagnosisReport; baseline: DiagnosisReport | null }) {
  const m = report.metrics
  return (
    <div className="metrics-grid">
      {([
        ['overallScore', '综合'], ['pitchScore', '音准'], ['rhythmScore', '节奏'],
        ['fluencyScore', '流畅度'], ['timingMaeMs', '时值MAE(ms)'], ['avgBpm', '速度(BPM)'],
      ] as const).map(([k, label]) => (
        <div key={k} className="metric">
          <div className="label">{label}</div>
          <div className="value">{m[k]}</div>
          {baseline && baseline.metrics[k] !== m[k] && (
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
      <h3 style={{ margin: '0 0 8px' }}>证据详情</h3>
      {evs.map((ev) => (
        <div key={ev.id} className="fact">
          • {ev.fact}
          <div className="compare">
            {ev.expected && <button className="btn btn-sm" onClick={() => onPlayCompare(ev.expected)}>试听期望</button>}
            {ev.actual && <button className="btn btn-sm" onClick={() => onPlayCompare(ev.actual)}>试听实际</button>}
          </div>
        </div>
      ))}
      {evs.length === 0 && <div className="dim">无详细证据</div>}
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

const METRIC_LABEL: Record<string, string> = {
  overallScore: '综合', pitchScore: '音准', rhythmScore: '节奏',
  fluencyScore: '流畅度', timingMaeMs: '时值MAE(ms)', avgBpm: '速度(BPM)',
}
