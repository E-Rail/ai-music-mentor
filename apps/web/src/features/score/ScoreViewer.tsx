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
import { ERROR_TYPE_LABEL } from '../../types'

interface MeasureBox { x: number; y: number; w: number; h: number }

interface Props {
  xmlUrl: string
  beatsPerMeasure: number
  errors?: ErrorEvent[]
  resolvedKeys?: Set<string>           // `${type}@${measure}` 已改善
  cursor?: { measure: number; beat: number; frozen?: boolean; confidence?: number } | null
  selectedErrorId?: string | null
  onErrorClick?: (e: ErrorEvent) => void
  height?: number
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
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null)
  const [boxes, setBoxes] = useState<MeasureBox[]>([])
  const [sheetSize, setSheetSize] = useState<{ w: number; h: number } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function render() {
      if (!containerRef.current) return
      setLoadError(null)
      containerRef.current.innerHTML = ''
      const osmd = new OpenSheetMusicDisplay(containerRef.current, {
        autoResize: false, backend: 'svg', drawTitle: true, drawSubtitle: false,
        drawComposer: false, pageBackgroundColor: 'white',
      })
      osmdRef.current = osmd
      try {
        const text = await (await fetch(props.xmlUrl)).text()
        await osmd.load(text)
        osmd.render()
        if (cancelled) return
        // 计算小节盒（OSMD 单位 → 百分比定位）
        const list = (osmd as any).GraphicSheet?.MeasureList ?? []
        const svg = containerRef.current.querySelector('svg')
        const vb = svg?.getAttribute('viewBox')?.split(/\s+/).map(Number)
        const mb: MeasureBox[] = []
        for (let m = 0; m < list.length; m += 1) {
          const staves = list[m] as any[]
          if (!staves?.length) { mb.push({ x: 0, y: 0, w: 0, h: 0 }); continue }
          let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity
          for (const g of staves) {
            const ps = g?.PositionAndShape
            if (!ps) continue
            const x = ps.AbsolutePosition?.x ?? 0
            const y = ps.AbsolutePosition?.y ?? 0
            const w = ps.Size?.width ?? 0
            const h = ps.Size?.height ?? 0
            minX = Math.min(minX, x); minY = Math.min(minY, y)
            maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h)
          }
          mb.push({ x: minX, y: minY, w: maxX - minX, h: maxY - minY })
        }
        setBoxes(mb)
        if (vb && vb.length === 4) setSheetSize({ w: vb[2], h: vb[3] })
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : '乐谱渲染失败')
      }
    }
    render()
    return () => { cancelled = true }
  }, [props.xmlUrl])

  function posOf(measure: number, beat: number): { left: string; top: string; height: string; xFrac: number; yFrac: number } | null {
    if (!sheetSize || !boxes.length) return null
    const box = boxes[Math.min(Math.max(measure - 1, 0), boxes.length - 1)]
    if (!box || !box.w) return null
    const frac = Math.min(Math.max(beat / props.beatsPerMeasure, 0), 1)
    const x = box.x + frac * box.w
    const y = box.y
    return {
      left: `${(x / sheetSize.w) * 100}%`,
      top: `${(y / sheetSize.h) * 100}%`,
      height: `${(box.h / sheetSize.h) * 100}%`,
      xFrac: x / sheetSize.w,
      yFrac: y / sheetSize.h,
    }
  }

  return (
    <div className="score-viewer" style={{ position: 'relative', minHeight: props.height ?? 260 }}>
      <div ref={containerRef} style={{ width: '100%', overflow: 'hidden', background: 'white', borderRadius: 8 }} />
      {loadError && <div className="score-error">⚠️ {loadError}</div>}

      {/* 错误标记层 */}
      {sheetSize && (props.errors ?? []).map((err) => {
        const p = posOf(err.location.measure, err.location.beat)
        if (!p) return null
        const st = MARKER_STYLE[err.type] ?? MARKER_STYLE.wrong_pitch
        const resolved = props.resolvedKeys?.has(`${err.type}@${err.location.measure}`)
        const selected = props.selectedErrorId === err.id
        return (
          <button
            key={err.id}
            className="score-marker"
            title={`${ERROR_TYPE_LABEL[err.type] ?? err.type} · 第${err.location.measure}小节`}
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
              {resolved ? '✓ 已改善' : (st.hollow ? '漏' : ERROR_TYPE_LABEL[err.type] ?? err.type)}
            </span>
          </button>
        )
      })}

      {/* 跟谱光标 */}
      {sheetSize && props.cursor && (() => {
        const p = posOf(props.cursor.measure, props.cursor.beat)
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
              }}>正在重新定位…</span>
            )}
          </div>
        )
      })()}
    </div>
  )
}
