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
import { followScrollTop } from './followScroll'
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import type { ErrorEvent } from '../../types'
import { ERROR_TYPE_LABEL, t, tf } from '../../i18n/messages'
import type { LivePerformanceState } from '../live'
import { CURSOR_INK, RESOLVED_INK, errorInk } from '../report/errorPalette'
import {
  buildScoreLayout, buildStaffPitchScales, locateScorePosition, staffForPitch,
  staffHintFromEventIds, type ScoreMeasureLayout, type StaffHint,
} from './scoreGeometry'
import { labelPlacement } from './overlayLabels'
import { midiFromOsmdHalfTone, noteName } from './pitch'
import { measureLabel, renumberMeasures } from './measureLabels'
import { ENGRAVING_OPTIONS, applyEngravingRules } from './engraving'

interface Props {
  xmlUrl: string
  beatsPerMeasure: number
  errors?: ErrorEvent[]
  resolvedKeys?: Set<string>           // errorComparisonKey(error) 已改善
  cursor?: { measure: number; beat: number; waiting?: boolean } | null
  /** Scroll the sheet to keep the cursor in view while playing. */
  follow?: boolean
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
      const osmd = new OpenSheetMusicDisplay(containerRef.current, ENGRAVING_OPTIONS)
      applyEngravingRules(osmd)
      try {
        const response = await fetch(props.xmlUrl, { signal: controller.signal })
        if (!response.ok) throw new Error(tf('scoreLoadHttpFailed', { status: response.status }))
        const text = await response.text()
        if (cancelled) return
        // The page prints the same bar numbers the app says out loud. A file
        // that numbers every bar 0 would otherwise contradict every position in
        // the report.
        await osmd.load(renumberMeasures(text))
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
                      // OSMD reports half tones an octave below MIDI. Everything
                      // downstream — the keyboard, the analysis, the report —
                      // speaks MIDI, so convert here and nowhere else.
                      const pitch = midiFromOsmdHalfTone(Number(
                        note.sourceNote?.halfTone ??
                        note.sourceNote?.Pitch?.getHalfTone?.()))
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
            // The layout auditor reads these to check that the overlay lands on
            // the right staff line. Development only.
            if (import.meta.env.DEV) {
              (window as unknown as Record<string, unknown>).__scoreAnchors = anchors
            }
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
   * "Pitch → staff height", fitted to the notes OSMD actually drew — once per
   * staff per line of music. This is what lets the overlay place a note the
   * student played but the score never contained: a wrong note gets its own
   * position instead of colouring the note they missed.
   *
   * Fitting one line per staff across the whole page instead would average
   * every system together and put the note above the staff, on no pitch at all.
   */
  const pitchScales = useMemo(
    () => buildStaffPitchScales(noteAnchors, layout, (noteAnchors[0]?.height ?? 10) / 2),
    [noteAnchors, layout],
  )

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

  /** Placement classes for a label hung off a point `posOf` returned. */
  function sheetPlacement(left: string, top: string) {
    if (!sheetSize) return { side: 'above' as const, align: 'center' as const, className: '' }
    return labelPlacement(
      sheetSize.w * Number.parseFloat(left) / 100,
      sheetSize.h * Number.parseFloat(top) / 100,
      sheetSize.w,
    )
  }

  // Follow the place being played. The cursor's top is already in sheet
  // coordinates, which is the same space this element scrolls through.
  const followRef = useRef<HTMLDivElement>(null)
  // posOf answers in percentages of the sheet, so the pixels come from what is
  // actually laid out rather than from the viewBox.
  const cursorAt = props.cursor && sheetSize
    ? posOf(props.cursor.measure, props.cursor.beat, null, true)
    : null
  const cursorFraction = cursorAt ? Number.parseFloat(cursorAt.top) / 100 : null
  const cursorSpan = cursorAt ? Number.parseFloat(cursorAt.height) / 100 : 0
  useEffect(() => {
    const view = followRef.current
    if (!props.follow || !view || cursorFraction === null) return
    const content = view.scrollHeight
    const next = followScrollTop({
      cursorTop: cursorFraction * content,
      cursorHeight: cursorSpan * content,
      viewportHeight: view.clientHeight,
      scrollTop: view.scrollTop,
      contentHeight: content,
    })
    if (next === null) return
    view.scrollTo({
      top: next,
      // Someone who asked for less motion gets the jump instead of the slide.
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto' : 'smooth',
    })
  }, [props.follow, cursorFraction, cursorSpan])

  return (
    // The outer element scrolls; the inner one is what the overlays are
    // positioned against. They cannot be the same element: a scroll container
    // that is also `position: relative` becomes the containing block, and then
    // a `top: 33%` note resolves against the *visible* height rather than the
    // height of the page it is written on — every mark creeps toward the top
    // and none of them move when the sheet scrolls.
    <div ref={followRef} className={`score-viewer ${props.follow ? 'following' : ''}`}>
      <div className="score-sheet"
           style={{ position: 'relative', minHeight: props.height ?? 260 }}>
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

        // Sheet-unit height for a pitch at this point in the music, or null when
        // the page gives nothing to place it against.
        const sheetYFor = (pitch: number): number | null => {
          // A pitch the page engraved right here already has an exact height.
          // Use it: a fit is only for notes the score never contained.
          const exact = written.find((anchor) => anchor.pitch === pitch)
          if (exact) return exact.y
          const staffIndex = staffForPitch(pitch, staffPitches, hint)
          const fitted = staffIndex === null ? null
            : pitchScales.yForPitch(pitch, staffIndex, target?.measureNo ?? 1)
          if (fitted !== null) return Math.min(Math.max(fitted, 2), sheetSize.h - 2)
          if (!fallback) return null
          return sheetSize.h * (Number.parseFloat(fallback.top) +
            Number.parseFloat(fallback.height) / 2) / 100
        }
        const yFor = (pitch: number): string | null => {
          const y = sheetYFor(pitch)
          return y === null ? null : `${(y / sheetSize.h) * 100}%`
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
              const y = sheetYFor(item.pitch)
              if (y === null) return null
              const top = `${(y / sheetSize.h) * 100}%`
              // Keep the note's own label on the paper: near the top edge it
              // hangs below instead, near a side it tucks in.
              const placement = labelPlacement(
                sheetSize.w * Number.parseFloat(columnX) / 100, y, sheetSize.w,
              )
              return (
                <div
                  key={`played-${item.pitch}`}
                  className={`score-played-note ${item.role} ${placement.className}`}
                  data-testid="score-played-note"
                  data-status={livePreview.status}
                  data-role={item.role}
                  data-pitch={item.pitch}
                  style={{ left: columnX, top }}
                  aria-label={tf('livePlayedOnScore', {
                    note: noteName(item.pitch),
                    measure: measureLabel(target?.measureNo ?? 0),
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
        const placement = sheetPlacement(p.left, p.top)
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
            <span
              className={`marker-tag ${placement.className}`}
              style={{ background: resolved ? RESOLVED_COLOR : st.paper }}
            >
              {resolved ? `✓ ${t('improved')}` : (st.hollow ? t('missing') : ERROR_TYPE_LABEL[err.type] ?? err.type)}
            </span>
          </button>
        )
      })}

      {/* 跟谱光标：颜色跟随当前这个音对不对，位置一直往前走。 */}
      {sheetSize && props.cursor && (() => {
        const p = posOf(props.cursor.measure, props.cursor.beat, null, true)
        if (!p) return null
        const waiting = props.cursor.waiting === true
        const status = props.liveFeedback?.status ?? 'idle'
        const placement = sheetPlacement(p.left, p.top)
        return (
          <div
            className={`score-cursor ${status}`}
            data-testid="score-cursor"
            data-status={status}
            style={{ left: p.left, top: p.top, height: p.height }}
          >
            {status === 'corrected' && (
              <span className={`cursor-tag corrected ${placement.className}`}>
                {t('liveStatusCorrected')}
              </span>
            )}
            {/* Sits below the system so it cannot cover the played note or
                the written-note ghost, which are the point of this overlay. */}
            {waiting && status !== 'corrected' && (
              <span className="cursor-relocking">{t('waitingHere')}</span>
            )}
          </div>
        )
      })()}
      </div>
    </div>
  )
}
