export interface ScorePoint { x: number; y: number }
export interface ScoreSize { width: number; height: number }

interface PositionAndShapeLike {
  AbsolutePosition?: ScorePoint
  Size?: ScoreSize
  BorderTop?: number
  BorderBottom?: number
}

interface StaffEntryLike {
  PositionAndShape?: PositionAndShapeLike
  relInMeasureTimestamp?: { RealValue?: number }
  sourceStaffEntry?: { Timestamp?: { RealValue?: number } }
  getHighestYAtEntry?: () => number
  getLowestYAtEntry?: () => number
}

interface GraphicalMeasureLike {
  PositionAndShape?: PositionAndShapeLike
  staffEntries?: StaffEntryLike[]
}

export interface ScoreAnchor {
  beat: number
  x: number
  top: number
  bottom: number
  staffIndex: number
}

export interface ScoreMeasureLayout {
  x: number
  y: number
  width: number
  height: number
  anchors: ScoreAnchor[]
}

export interface ScoreOverlayPosition {
  x: number
  top: number
  height: number
}

export type StaffHint = 'upper' | 'lower' | null

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function safeCall(fn: (() => number) | undefined): number | null {
  try { return finite(fn?.()) } catch { return null }
}

/**
 * OSMD exposes engraving geometry in staff-space units while VexFlow's SVG
 * viewBox is in pixels (normally 10 px per unit). Convert once at the boundary.
 */
export function buildScoreLayout(
  measureList: GraphicalMeasureLike[][],
  pixelsPerUnit: number,
): ScoreMeasureLayout[] {
  const scale = Number.isFinite(pixelsPerUnit) && pixelsPerUnit > 0 ? pixelsPerUnit : 10

  return measureList.map((staves) => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const anchors: ScoreAnchor[] = []

    staves.forEach((measure, staffIndex) => {
      const shape = measure?.PositionAndShape
      const position = shape?.AbsolutePosition
      const size = shape?.Size
      if (position && size && [position.x, position.y, size.width, size.height].every(Number.isFinite)) {
        minX = Math.min(minX, position.x)
        minY = Math.min(minY, position.y)
        maxX = Math.max(maxX, position.x + size.width)
        maxY = Math.max(maxY, position.y + size.height)
      }

      for (const entry of measure?.staffEntries ?? []) {
        const entryPosition = entry.PositionAndShape?.AbsolutePosition
        if (!entryPosition || !Number.isFinite(entryPosition.x) || !Number.isFinite(entryPosition.y)) continue
        const timestamp = finite(entry.relInMeasureTimestamp?.RealValue) ??
          finite(entry.sourceStaffEntry?.Timestamp?.RealValue)
        if (timestamp === null) continue

        // OSMD timestamps use whole notes as 1.0; the product domain uses quarter-note beats.
        const beat = timestamp * 4
        const highest = safeCall(entry.getHighestYAtEntry) ??
          finite(entry.PositionAndShape?.BorderTop) ?? -2.5
        const lowest = safeCall(entry.getLowestYAtEntry) ??
          finite(entry.PositionAndShape?.BorderBottom) ?? 2.5
        const topUnits = entryPosition.y + Math.min(highest, -2.5) - 0.45
        const bottomUnits = entryPosition.y + Math.max(lowest, 2.5) + 0.45

        anchors.push({
          beat,
          x: entryPosition.x * scale,
          top: topUnits * scale,
          bottom: bottomUnits * scale,
          staffIndex,
        })
      }
    })

    if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
      return { x: 0, y: 0, width: 0, height: 0, anchors: [] }
    }
    return {
      x: minX * scale,
      y: minY * scale,
      width: (maxX - minX) * scale,
      height: (maxY - minY) * scale,
      anchors: anchors.sort((a, b) => a.beat - b.beat || a.staffIndex - b.staffIndex),
    }
  })
}

function anchorsForStaff(anchors: ScoreAnchor[], hint: StaffHint): ScoreAnchor[] {
  if (!anchors.length || hint === null) return anchors
  const staffIndex = hint === 'upper'
    ? Math.min(...anchors.map((anchor) => anchor.staffIndex))
    : Math.max(...anchors.map((anchor) => anchor.staffIndex))
  return anchors.filter((anchor) => anchor.staffIndex === staffIndex)
}

export function locateScorePosition(
  layout: ScoreMeasureLayout[],
  measureNo: number,
  beat: number,
  beatsPerMeasure: number,
  staffHint: StaffHint = null,
  spanWholeMeasure = false,
): ScoreOverlayPosition | null {
  const measure = layout[Math.min(Math.max(measureNo - 1, 0), layout.length - 1)]
  if (!measure || measure.width <= 0 || measure.height <= 0) return null

  const candidates = anchorsForStaff(measure.anchors, staffHint)
  let anchor: ScoreAnchor | null = null
  for (const candidate of candidates) {
    if (!anchor || Math.abs(candidate.beat - beat) < Math.abs(anchor.beat - beat)) anchor = candidate
  }

  const safeBeats = Number.isFinite(beatsPerMeasure) && beatsPerMeasure > 0 ? beatsPerMeasure : 4
  const fallbackX = measure.x + Math.min(Math.max(beat / safeBeats, 0), 1) * measure.width
  if (!anchor) {
    return { x: fallbackX, top: measure.y, height: measure.height }
  }

  return {
    x: anchor.x,
    top: spanWholeMeasure ? measure.y : anchor.top,
    height: spanWholeMeasure ? measure.height : Math.max(anchor.bottom - anchor.top, 1),
  }
}

/**
 * Staff position is diatonic, not chromatic: C♯4 sits on the same line as C4,
 * and E–F are neighbours while F–G are a whole step apart. Mapping a pitch to a
 * step index is what lets the app draw a note the score never contained.
 */
const DIATONIC_STEP_BY_PITCH_CLASS = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6]

export function diatonicStep(pitch: number): number {
  const pitchClass = ((Math.round(pitch) % 12) + 12) % 12
  return Math.floor(Math.round(pitch) / 12) * 7 + DIATONIC_STEP_BY_PITCH_CLASS[pitchClass]
}

export interface PitchAnchor { pitch: number; y: number }

export interface PitchScale {
  /** Vertical position for any pitch, including ones not in the score. */
  yForPitch: (pitch: number) => number
  /** Height of one diatonic step, for drawing ledger lines and note heads. */
  stepHeight: number
  /** False when the scale was estimated rather than fitted to real engraving. */
  fitted: boolean
}

/**
 * Fit "pitch → vertical position" from notes OSMD actually engraved.
 *
 * Staff spacing is uniform per diatonic step, so a least-squares line through
 * the rendered noteheads is exact rather than approximate, and it automatically
 * inherits the clef, the octave and the current zoom level.
 */
export function buildPitchScale(
  anchors: PitchAnchor[], fallbackStepHeight: number,
): PitchScale {
  const points = anchors
    .filter((anchor) => Number.isFinite(anchor.pitch) && Number.isFinite(anchor.y))
    .map((anchor) => ({ step: diatonicStep(anchor.pitch), y: anchor.y }))
  const steps = new Set(points.map((point) => point.step))
  const safeFallback = Number.isFinite(fallbackStepHeight) && fallbackStepHeight > 0
    ? fallbackStepHeight : 5

  if (points.length < 2 || steps.size < 2) {
    const base = points[0] ?? { step: diatonicStep(71), y: 0 }
    return {
      yForPitch: (pitch) => base.y - (diatonicStep(pitch) - base.step) * safeFallback,
      stepHeight: safeFallback,
      fitted: false,
    }
  }

  const count = points.length
  const meanStep = points.reduce((sum, point) => sum + point.step, 0) / count
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / count
  let covariance = 0
  let variance = 0
  for (const point of points) {
    covariance += (point.step - meanStep) * (point.y - meanY)
    variance += (point.step - meanStep) ** 2
  }
  // Screen coordinates grow downwards, so a higher pitch must produce a smaller
  // y. A degenerate or inverted fit falls back rather than drawing upside down.
  const slope = variance > 0 ? covariance / variance : 0
  if (!(slope < 0)) {
    return {
      yForPitch: (pitch) => meanY - (diatonicStep(pitch) - meanStep) * safeFallback,
      stepHeight: safeFallback,
      fitted: false,
    }
  }
  const intercept = meanY - slope * meanStep
  return {
    yForPitch: (pitch) => intercept + slope * diatonicStep(pitch),
    stepHeight: Math.abs(slope),
    fitted: true,
  }
}

/**
 * Which staff a played pitch belongs on. A hint from the score wins; otherwise
 * the pitch goes to whichever staff already engraves notes closest to it, so a
 * left-hand note lands on the bass staff without being told.
 */
export function staffForPitch(
  pitch: number,
  staffPitches: Map<number, number[]>,
  hint: StaffHint = null,
): number | null {
  const indices = [...staffPitches.keys()].sort((left, right) => left - right)
  if (!indices.length) return null
  if (hint === 'upper') return indices[0]
  if (hint === 'lower') return indices[indices.length - 1]
  let best = indices[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const index of indices) {
    for (const candidate of staffPitches.get(index) ?? []) {
      const distance = Math.abs(candidate - pitch)
      if (distance < bestDistance) {
        bestDistance = distance
        best = index
      }
    }
  }
  return best
}

export function staffHintFromEventIds(eventIds: Array<string | null | undefined>): StaffHint {
  const parts = eventIds
    .filter((eventId): eventId is string => Boolean(eventId))
    .map((eventId) => eventId.split(':')[1]?.trim().toLowerCase())
    .filter(Boolean)
  if (parts.some((part) => part === 'lh' || part.includes('left'))) return 'lower'
  if (parts.some((part) => part === 'rh' || part.includes('right'))) return 'upper'
  return null
}
