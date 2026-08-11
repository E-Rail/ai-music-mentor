// 谱面组件（方案 6.2/6.3）：OSMD 渲染 + 错误标记 + 跟谱光标
//
// 高亮规范：
// 实时层（演奏中）：
// - 铜黄实心点：你实际弹出的音，画在它自己的音高位置上
// - 绯红实心点：谱面这里没有这个音（你弹的额外音）
// - 墨色虚线空心圈：谱面写了但没响的音
// 报告层（停止后）：
// - 绯红实线框：错音
// - 铜黄虚线框：提前/延后、多音
// - 灰色空心标记：漏音（+“漏”标签）
// - 铜黄竖线：当前跟谱位置（低置信降低透明度 + “正在重新定位”）
// - 绿色框：再次演奏已改善

import { useEffect, useMemo, useRef, useState } from 'react'
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import type { ErrorEvent } from '../../types'
import { ERROR_TYPE_LABEL, t, tf } from '../../i18n/messages'
import type { LivePerformanceState } from '../live'
import { CURSOR_INK, RESOLVED_INK, errorInk } from '../report/errorPalette'
import {
  buildPitchScale, buildScoreLayout, locateScorePosition, staffForPitch,
  staffHintFromEventIds, type PitchScale, type ScoreMeasureLayout, type StaffHint,
} from './scoreGeometry'

interface Props {
  xmlUrl: string
  beatsPerMeasure: number
  errors?: ErrorEvent[]
  resolvedKeys?: Set<string>           // errorComparisonKey(error) 已改善
  cursor?: { measure: number; beat: number; frozen?: boolean; confidence?: number } | null
  liveFeedback?: LivePerformanceState | null
  selectedErrorId?: string | null
  onErrorClick?: (e: ErrorEvent) => void
  height?: number
}

interface RenderedNoteAnchor {
  measure: number
  beat: number
  pitch: number
  staffIndex: number
  x: number
  y: number
  width: number
  height: number
}

const PITCH_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']

function noteName(pitch: number): string {
  return `${PITCH_NAMES[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`
}

export function errorComparisonKey(error: ErrorEvent): string {
  const ids = [
    ...(error.location.eventIds ?? []),
    ...(error.location.eventId ? [error.location.eventId] : []),
  ].filter(Boolean).sort()
  const anchor = ids.length
    ? `events:${[...new Set(ids)].join('|')}`
    : `m:${error.location.measure}|b:${Number(error.location.beat || 0).toFixed(3)}|d:${error.detail.trim().replace(/\s+/g, ' ')}`
  return `${error.type}@${anchor}`
}

const RESOLVED_COLOR = RESOLVED_INK.paper
const CURSOR_COLOR = CURSOR_INK

export function ScoreViewer(props: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<ScoreMeasureLayout[]>([])
  const [sheetSize, setSheetSize] = useState<{ w: number; h: number } | null>(null)
  const [noteAnchors, setNoteAnchors] = useState<RenderedNoteAnchor[]>([])
  const [livePreview, setLivePreview] = useState<LivePerformanceState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    async function render() {
      if (!containerRef.current) return
      setLoadError(null)
      setLayout([])
      setSheetSize(null)
      setNoteAnchors([])
      containerRef.current.innerHTML = ''
      const osmd = new OpenSheetMusicDisplay(containerRef.current, {
        autoResize: false, backend: 'svg', drawTitle: true, drawSubtitle: false,
        drawComposer: false, pageBackgroundColor: 'white',
      })
      try {
        const response = await fetch(props.xmlUrl, { signal: controller.signal })
        if (!response.ok) throw new Error(tf('scoreLoadHttpFailed', { status: response.status }))
        const text = await response.text()
        if (cancelled) return
        await osmd.load(text)
        if (cancelled) return
        osmd.render()
        if (cancelled) return
        // OSMD layout uses staff-space units while the VexFlow SVG uses pixels.
        // Convert the measure and exact staff-entry anchors at this boundary.
        const list = osmd.GraphicSheet?.MeasureList ?? []
        const pixelsPerUnit = osmd.Drawer.calculatePixelDistance(1)
        const svg = containerRef.current.querySelector('svg')
        const vb = svg?.getAttribute('viewBox')?.split(/[\s,]+/).map(Number)
        setLayout(buildScoreLayout(list, pixelsPerUnit))
        if (vb && vb.length === 4) {
          const viewWidth = vb[2]
          const viewHeight = vb[3]
          setSheetSize({ w: viewWidth, h: viewHeight })
          const svgRect = svg?.getBoundingClientRect()
          if (svg && svgRect?.width && svgRect.height) {
            const anchors: RenderedNoteAnchor[] = []
            list.forEach((staves, measureIndex) => {
              staves.forEach((measure, staffIndex) => {
                for (const entry of measure?.staffEntries ?? []) {
                  const timestamp = Number(entry.relInMeasureTimestamp?.RealValue ??
                    entry.sourceStaffEntry?.Timestamp?.RealValue)
                  if (!Number.isFinite(timestamp)) continue
                  const beat = timestamp * 4
                  for (const voice of entry.graphicalVoiceEntries ?? []) {
                    for (const note of voice.notes ?? []) {
                      const pitch = Number(note.sourceNote?.halfTone ??
                        note.sourceNote?.Pitch?.getHalfTone?.())
                      if (!Number.isFinite(pitch)) continue
                      try {
                        const renderedNote = note as unknown as {
                          getNoteheadSVGs?: () => SVGGraphicsElement[]
                          vfnoteIndex?: number
                        }
                        const heads = renderedNote.getNoteheadSVGs?.() ?? []
                        const head = heads[renderedNote.vfnoteIndex ?? 0] ?? heads[0]
                        const rect = head?.getBoundingClientRect()
                        if (!rect?.width || !rect.height) continue
                        anchors.push({
                          measure: measureIndex + 1, beat, pitch, staffIndex,
                          x: ((rect.left + rect.width / 2 - svgRect.left) / svgRect.width) * viewWidth,
                          y: ((rect.top + rect.height / 2 - svgRect.top) / svgRect.height) * viewHeight,
                          width: (rect.width / svgRect.width) * viewWidth,
                          height: (rect.height / svgRect.height) * viewHeight,
                        })
                      } catch { /* the beat-level marker remains available */ }
                    }
                  }
                }
              })
            })
            setNoteAnchors(anchors)
          }
        }
      } catch (e) {
        if (!cancelled && !(e instanceof DOMException && e.name === 'AbortError')) {
          setLoadError(e instanceof Error ? e.message : t('scoreRenderFailed'))
        }
      }
    }
    render()
    return () => { cancelled = true; controller.abort() }
  }, [props.xmlUrl])

  /**
   * "Pitch → staff height" per staff, fitted to the notes OSMD actually drew.
   * This is what lets the overlay place a note the student played but the score
   * never contained — a wrong note gets its own position instead of colouring
   * the note they missed.
   */
  const pitchScales = useMemo(() => {
    const perStaff = new Map<number, { pitch: number; y: number }[]>()
    for (const anchor of noteAnchors) {
      const list = perStaff.get(anchor.staffIndex) ?? []
      list.push({ pitch: anchor.pitch, y: anchor.y })
      perStaff.set(anchor.staffIndex, list)
    }
    const fallbackStep = (noteAnchors[0]?.height ?? 10) / 2
    const scales = new Map<number, PitchScale>()
    perStaff.forEach((points, staffIndex) => {
      scales.set(staffIndex, buildPitchScale(points, fallbackStep))
    })
    return scales
  }, [noteAnchors])

  const staffPitches = useMemo(() => {
    const perStaff = new Map<number, number[]>()
    for (const anchor of noteAnchors) {
      const list = perStaff.get(anchor.staffIndex) ?? []
      list.push(anchor.pitch)
      perStaff.set(anchor.staffIndex, list)
    }
    return perStaff
  }, [noteAnchors])

  useEffect(() => {
    const feedback = props.liveFeedback
    if (!feedback?.played.length || feedback.status === 'idle' ||
        feedback.status === 'waiting') {
      setLivePreview(null)
      return
    }
    setLivePreview(feedback)
    const timer = window.setTimeout(() => setLivePreview(null), 1_400)
    return () => window.clearTimeout(timer)
    // Keyed on the played note itself: a re-render with the same input must not
    // restart the fade, and a genuinely new note must.
  }, [props.liveFeedback?.playedAtMs, props.liveFeedback?.status,
      props.liveFeedback?.played.map((item) => item.pitch).join(',')])

  function posOf(measure: number, beat: number, staffHint: StaffHint, spanWholeMeasure = false): {
    left: string; top: string; height: string
  } | null {
    if (!sheetSize || !layout.length) return null
    const position = locateScorePosition(
      layout, measure, beat, props.beatsPerMeasure, staffHint, spanWholeMeasure,
    )
    if (!position) return null
    const x = Math.min(Math.max(position.x, 0), sheetSize.w)
    const top = Math.min(Math.max(position.top, 0), sheetSize.h)
    const height = Math.min(Math.max(position.height, 1), sheetSize.h - top)
    return {
      left: `${(x / sheetSize.w) * 100}%`,
      top: `${(top / sheetSize.h) * 100}%`,
      height: `${(height / sheetSize.h) * 100}%`,
    }
  }

  return (
    <div className="score-viewer" style={{ position: 'relative', minHeight: props.height ?? 260 }}>
      <div ref={containerRef} style={{ width: '100%', overflow: 'hidden', background: 'white', borderRadius: 8 }} />
      {loadError && <div className="score-error" role="alert">⚠️ {loadError}</div>}

      {/* 实时层：先画你弹出的音，谱面音作为对照的影子。
          完整错误判定仍由停止后的确定性分析产生。 */}
      {sheetSize && !!livePreview?.played.length && (() => {
        const target = livePreview.target
        const hint = target ? staffHintFromEventIds(target.eventIds) : null
        const written = target
          ? noteAnchors.filter((anchor) =>
              anchor.measure === target.measureNo &&
              Math.abs(anchor.beat - target.onsetBeat) < 0.02 &&
              target.pitches.includes(anchor.pitch))
          : []
        const fallback = target
          ? posOf(target.measureNo, target.onsetBeat, hint)
          : null
        // Horizontal place = where in the music we are; vertical place = the
        // pitch that actually sounded.
        const columnX = written[0]
          ? `${(written[0].x / sheetSize.w) * 100}%`
          : fallback?.left ?? null
        if (!columnX) return null

        const yFor = (pitch: number): string | null => {
          const staffIndex = staffForPitch(pitch, staffPitches, hint)
          const scale = staffIndex === null ? null : pitchScales.get(staffIndex)
          if (scale) return `${(scale.yForPitch(pitch) / sheetSize.h) * 100}%`
          if (!fallback) return null
          return `${Number.parseFloat(fallback.top) +
            Number.parseFloat(fallback.height) / 2}%`
        }

        const timing = livePreview.timing
        const timingTag = !timing || timing.reference !== 'elapsed' ||
          timing.label === 'onTime'
          ? null
          : `${timing.deltaMs > 0 ? '+' : ''}${Math.round(timing.deltaMs)}ms`

        return (
          <>
            {/* 谱面写的音：空心影子，供对照 */}
            {livePreview.missing.map((pitch) => {
              const top = yFor(pitch)
              return top && (
                <div key={`written-${pitch}`} className="score-written-ghost"
                     aria-hidden="true" style={{ left: columnX, top }} />
              )
            })}
            {/* 你实际弹出的音 */}
            {livePreview.played.map((item, index) => {
              const top = yFor(item.pitch)
              if (!top) return null
              return (
                <div
                  key={`played-${item.pitch}`}
                  className={`score-played-note ${item.role}`}
                  data-testid="score-played-note"
                  data-status={livePreview.status}
                  data-role={item.role}
                  data-pitch={item.pitch}
                  style={{ left: columnX, top }}
                  aria-label={tf('livePlayedOnScore', {
                    note: noteName(item.pitch),
                    measure: target?.measureNo ?? 0,
                    beat: (target?.onsetBeat ?? 0) + 1,
                  })}
                >
                  <span className="played-note-name">{noteName(item.pitch)}</span>
                  {index === 0 && timingTag && (
                    <span className={`played-note-timing ${timing?.label}`}>{timingTag}</span>
                  )}
                </div>
              )
            })}
          </>
        )
      })()}

      {/* 错误标记层 */}
      {sheetSize && (props.errors ?? []).map((err) => {
        const p = posOf(
          err.location.measure,
          err.location.beat,
          staffHintFromEventIds([
            err.location.eventId,
            ...(err.location.eventIds ?? []),
          ]),
        )
        if (!p) return null
        const st = errorInk(err.type)
        const resolved = props.resolvedKeys?.has(errorComparisonKey(err))
        const selected = props.selectedErrorId === err.id
        return (
          <button
            key={err.id}
            className="score-marker"
            data-measure={err.location.measure}
            data-beat={err.location.beat}
            title={`${ERROR_TYPE_LABEL[err.type] ?? err.type} · ${tf('errorPosition', {
              measure: err.location.measure, beat: err.location.beat + 1, severity: '',
            }).replace(/ · $/, '')}`}
            aria-label={`${resolved ? t('improved') : ERROR_TYPE_LABEL[err.type] ?? err.type}，${tf('errorPosition', {
              measure: err.location.measure, beat: err.location.beat + 1, severity: '',
            }).replace(/ · $/, '')}`}
            onClick={() => props.onErrorClick?.(err)}
            style={{
              position: 'absolute', left: p.left, top: p.top, height: p.height,
              width: 26, marginLeft: -13, background: 'transparent',
              border: `2px ${st.stroke} ${resolved ? RESOLVED_COLOR : st.paper}`,
              borderRadius: 6, cursor: 'pointer', zIndex: 5,
              outline: selected ? `3px solid ${resolved ? RESOLVED_COLOR : st.paper}55` : 'none',
            }}
          >
            <span className="marker-tag" style={{
              position: 'absolute', top: -20, left: '50%', transform: 'translateX(-50%)',
              fontSize: 10, whiteSpace: 'nowrap', padding: '1px 4px', borderRadius: 4,
              background: resolved ? RESOLVED_COLOR : st.paper, color: 'white',
            }}>
              {resolved ? `✓ ${t('improved')}` : (st.hollow ? t('missing') : ERROR_TYPE_LABEL[err.type] ?? err.type)}
            </span>
          </button>
        )
      })}

      {/* 跟谱光标 */}
      {sheetSize && props.cursor && (() => {
        const p = posOf(props.cursor.measure, props.cursor.beat, null, true)
        if (!p) return null
        const lowConf = (props.cursor.confidence ?? 1) < 0.5 || props.cursor.frozen
        return (
          <div style={{
            position: 'absolute', left: p.left, top: p.top, height: p.height,
            width: 3, background: CURSOR_COLOR, borderRadius: 2, zIndex: 4,
            opacity: lowConf ? 0.35 : 0.9, transition: 'left 120ms linear',
          }}>
            {/* Sits below the system so it cannot cover the played note or
                the written-note ghost, which are the point of this overlay. */}
            {lowConf && (
              <span className="cursor-relocking">{t('relocking')}…</span>
            )}
          </div>
        )
      })()}
    </div>
  )
}
