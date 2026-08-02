// 谱面组件（方案 6.2/6.3）：OSMD 渲染 + 错误标记 + 跟谱光标
//
// 高亮规范：
// - 红色实线框：错音/严重错误（+“错音”文本）
// - 橙色虚线框：节奏提前/延后（+±ms）
// - 灰色空心标记：漏音（+“漏”标签）
// - 蓝色光标：当前跟谱位置（低置信降低透明度 + “正在重新定位”）
// - 绿色勾：再次演奏已改善

import { useEffect, useRef, useState } from 'react'
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import type { ErrorEvent } from '../../types'
import { ERROR_TYPE_LABEL, t, tf } from '../../i18n/messages'
import {
  buildScoreLayout, locateScorePosition, staffHintFromEventIds, type ScoreMeasureLayout,
  type StaffHint,
} from './scoreGeometry'

interface Props {
  xmlUrl: string
  beatsPerMeasure: number
  errors?: ErrorEvent[]
  resolvedKeys?: Set<string>           // errorComparisonKey(error) 已改善
  cursor?: { measure: number; beat: number; frozen?: boolean; confidence?: number } | null
  selectedErrorId?: string | null
  onErrorClick?: (e: ErrorEvent) => void
  height?: number
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

const MARKER_STYLE: Record<string, { border: string; color: string; dashed?: boolean; hollow?: boolean }> = {
  wrong_pitch: { border: '#e5484d', color: '#e5484d' },
  missed_note: { border: '#8b8d98', color: '#8b8d98', hollow: true },
  extra_note: { border: '#3e63dd', color: '#3e63dd' },
  early_late: { border: '#f76b15', color: '#f76b15', dashed: true },
  duration_anomaly: { border: '#12a594', color: '#12a594', dashed: true },
  tempo_instability: { border: '#8e4ec6', color: '#8e4ec6', dashed: true },
}

export function ScoreViewer(props: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<ScoreMeasureLayout[]>([])
  const [sheetSize, setSheetSize] = useState<{ w: number; h: number } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    async function render() {
      if (!containerRef.current) return
      setLoadError(null)
      setLayout([])
      setSheetSize(null)
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
        if (vb && vb.length === 4) setSheetSize({ w: vb[2], h: vb[3] })
      } catch (e) {
        if (!cancelled && !(e instanceof DOMException && e.name === 'AbortError')) {
          setLoadError(e instanceof Error ? e.message : t('scoreRenderFailed'))
        }
      }
    }
    render()
    return () => { cancelled = true; controller.abort() }
  }, [props.xmlUrl])

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
        const st = MARKER_STYLE[err.type] ?? MARKER_STYLE.wrong_pitch
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
              border: `2px ${st.dashed ? 'dashed' : 'solid'} ${resolved ? '#30a46c' : st.border}`,
              borderRadius: 6, cursor: 'pointer', zIndex: 5,
              outline: selected ? `3px solid ${resolved ? '#30a46c' : st.border}55` : 'none',
            }}
          >
            <span className="marker-tag" style={{
              position: 'absolute', top: -20, left: '50%', transform: 'translateX(-50%)',
              fontSize: 10, whiteSpace: 'nowrap', padding: '1px 4px', borderRadius: 4,
              background: resolved ? '#30a46c' : st.border, color: 'white',
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
            width: 3, background: '#3e63dd', borderRadius: 2, zIndex: 4,
            opacity: lowConf ? 0.35 : 0.9, transition: 'left 120ms linear',
          }}>
            {lowConf && (
              <span style={{
                position: 'absolute', top: -18, left: -30, fontSize: 10,
                color: '#3e63dd', whiteSpace: 'nowrap',
              }}>{t('relocking')}…</span>
            )}
          </div>
        )
      })()}
    </div>
  )
}
