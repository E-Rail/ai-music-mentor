import { useEffect, useRef, useState } from 'react'
import type { TempoPoint } from '../../types'
import { t, tf } from '../../i18n/messages'
import { measureLabel } from '../score/measureLabels'

const HEIGHT = 150
const PAD = { top: 14, right: 46, bottom: 24, left: 34 }

/** Round tick values a player would say out loud: 80, 90, 100 — not 83.7. */
function ticks(low: number, high: number): number[] {
  const span = Math.max(1, high - low)
  const step = [2, 5, 10, 20, 25, 50].find((candidate) => span / candidate <= 4) ?? 50
  const out: number[] = []
  for (let value = Math.ceil(low / step) * step; value <= high; value += step) out.push(value)
  return out
}

/**
 * The tempo the player actually kept, against the tempo that was marked.
 *
 * One series, so no legend: the heading names it. Brass, because brass means
 * "you" everywhere in this interface; the marking is a dashed rule in the
 * page's quiet ink. The curve is the same sliding median the tempo check read,
 * so what is drawn is the evidence that was judged, not a second opinion.
 */
export function TempoCurve({ points, targetBpm }: {
  points: TempoPoint[]
  targetBpm?: number | null
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(480)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const box = boxRef.current
    if (!box || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, entry.contentRect.width)))
    observer.observe(box)
    return () => observer.disconnect()
  }, [])

  if (points.length < 2) {
    return <p className="dim">{t('tempoCurveTooShort')}</p>
  }

  const bpms = points.map((point) => point.bpm)
  const reference = targetBpm ?? null
  const low = Math.min(...bpms, reference ?? Infinity)
  const high = Math.max(...bpms, reference ?? -Infinity)
  const margin = Math.max(4, (high - low) * 0.15)
  const yMin = low - margin
  const yMax = high + margin
  const firstBeat = points[0].beat
  const lastBeat = points[points.length - 1].beat
  const plotWidth = width - PAD.left - PAD.right
  const plotHeight = HEIGHT - PAD.top - PAD.bottom
  const x = (beat: number) => PAD.left + ((beat - firstBeat) / Math.max(1e-6, lastBeat - firstBeat)) * plotWidth
  const y = (bpm: number) => PAD.top + (1 - (bpm - yMin) / (yMax - yMin)) * plotHeight
  const path = points.map((point, index) =>
    `${index ? 'L' : 'M'}${x(point.beat).toFixed(1)},${y(point.bpm).toFixed(1)}`).join(' ')

  // One x label per bar at most, and only as many as fit side by side.
  const barStarts = points.filter((point, index) =>
    index === 0 || point.measure !== points[index - 1].measure)
  const every = Math.max(1, Math.ceil(barStarts.length / Math.max(1, Math.floor(plotWidth / 44))))
  const xLabels = barStarts.filter((_, index) => index % every === 0)

  const last = points[points.length - 1]
  const active = hover === null ? null : points[hover]
  const nearest = (clientX: number) => {
    const box = boxRef.current?.getBoundingClientRect()
    if (!box) return null
    const beat = firstBeat + ((clientX - box.left - PAD.left) / plotWidth) * (lastBeat - firstBeat)
    let best = 0
    points.forEach((point, index) => {
      if (Math.abs(point.beat - beat) < Math.abs(points[best].beat - beat)) best = index
    })
    return best
  }

  return (
    <div className="tempo-curve" ref={boxRef}>
      <svg width={width} height={HEIGHT} role="img"
           aria-label={tf('tempoCurveAria', {
             low: Math.round(Math.min(...bpms)), high: Math.round(Math.max(...bpms)),
             target: reference === null ? '—' : Math.round(reference),
           })}
           onPointerMove={(event) => setHover(nearest(event.clientX))}
           onPointerLeave={() => setHover(null)}>
        {ticks(yMin, yMax).map((value) => (
          <g key={value}>
            <line className="tempo-grid" x1={PAD.left} x2={width - PAD.right} y1={y(value)} y2={y(value)} />
            <text className="tempo-axis" x={PAD.left - 6} y={y(value)} dy="0.32em" textAnchor="end">{value}</text>
          </g>
        ))}
        {xLabels.map((point) => (
          <text key={point.beat} className="tempo-axis" x={x(point.beat)} y={HEIGHT - 6}
                textAnchor="middle">{measureLabel(point.measure)}</text>
        ))}
        {reference !== null && (
          <line className="tempo-target" x1={PAD.left} x2={width - PAD.right}
                y1={y(reference)} y2={y(reference)} />
        )}
        <path className="tempo-line" d={path} />
        <circle className="tempo-end" cx={x(last.beat)} cy={y(last.bpm)} r={4} />
        <text className="tempo-end-label" x={x(last.beat) + 8} y={y(last.bpm)} dy="0.32em">
          {Math.round(last.bpm)}
        </text>
        {active && (
          <g>
            <line className="tempo-crosshair" x1={x(active.beat)} x2={x(active.beat)}
                  y1={PAD.top} y2={HEIGHT - PAD.bottom} />
            <circle className="tempo-end" cx={x(active.beat)} cy={y(active.bpm)} r={4} />
          </g>
        )}
      </svg>
      {active && (
        <div className="tempo-tooltip" role="status"
             style={{ left: Math.min(width - 120, Math.max(0, x(active.beat) - 50)) }}>
          {tf('tempoCurvePoint', { bar: measureLabel(active.measure), bpm: Math.round(active.bpm) })}
        </div>
      )}
      <table className="visually-hidden">
        <caption>{t('tempoCurveTitle')}</caption>
        <thead><tr><th>{t('tempoCurveBar')}</th><th>BPM</th></tr></thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.beat}><td>{measureLabel(point.measure)}</td><td>{Math.round(point.bpm)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
