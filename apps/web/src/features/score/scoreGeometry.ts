import { handOfEventId } from './hands'
import { diatonicStep } from './pitch'

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

// Staff position comes from the same table as the note's name, so a pitch is
// never drawn on a line other than the one its name implies.
export { diatonicStep } from './pitch'

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
 * Which line of music on the page each measure was engraved on.
 *
 * A staff is only vertically continuous inside one system. Bar 1 and bar 9 are
 * both "the treble staff", but the same pitch sits a whole page apart on them,
 * so anything that maps pitch to height has to know which line it is looking at
 * or it averages the entire page into a position that is on no staff at all.
 */
export function buildSystemIndex(layout: ScoreMeasureLayout[]): number[] {
  const systems: number[] = []
  let current = 0
  let top: number | null = null
  let height = 0
  for (const measure of layout) {
    if (measure.height <= 0) {
      // An unmeasurable bar keeps the line it was found on rather than starting
      // a new one, so one bad measure cannot split a system in two.
      systems.push(current)
      continue
    }
    if (top === null) {
      top = measure.y
      height = measure.height
    } else if (measure.y > top + Math.max(height, 1) * 0.5) {
      current += 1
      top = measure.y
      height = measure.height
    }
    systems.push(current)
  }
  return systems
}

export interface RenderedPitch {
  measure: number
  staffIndex: number
  pitch: number
  y: number
}

export interface PitchScaleIndex {
  /** Height for a pitch on one staff of one bar; null if that staff is absent. */
  yForPitch: (pitch: number, staffIndex: number, measureNo: number) => number | null
  stepHeight: (staffIndex: number, measureNo: number) => number
  /** How many separate fits were made — one per staff per line of music. */
  size: number
}

/**
 * Fit "pitch → height" once per staff per system, and place a pitch using the
 * fit belonging to the bar it is being drawn in.
 */
export function buildStaffPitchScales(
  rendered: RenderedPitch[],
  layout: ScoreMeasureLayout[],
  fallbackStepHeight: number,
): PitchScaleIndex {
  const systemOfMeasure = buildSystemIndex(layout)
  const systemOf = (measureNo: number): number =>
    systemOfMeasure[Math.min(Math.max(measureNo - 1, 0), systemOfMeasure.length - 1)] ?? 0

  const systemTop = new Map<number, number>()
  layout.forEach((measure, index) => {
    const system = systemOfMeasure[index] ?? 0
    if (measure.height > 0 && !systemTop.has(system)) systemTop.set(system, measure.y)
  })

  const points = new Map<string, PitchAnchor[]>()
  for (const note of rendered) {
    if (!Number.isFinite(note.pitch) || !Number.isFinite(note.y)) continue
    const key = `${note.staffIndex}:${systemOf(note.measure)}`
    const list = points.get(key) ?? []
    list.push({ pitch: note.pitch, y: note.y })
    points.set(key, list)
  }
  const scales = new Map<string, { system: number; staff: number; scale: PitchScale }>()
  points.forEach((anchors, key) => {
    const [staff, system] = key.split(':').map(Number)
    scales.set(key, { staff, system, scale: buildPitchScale(anchors, fallbackStepHeight) })
  })

  function resolve(staffIndex: number, measureNo: number):
    { scale: PitchScale; shift: number } | null {
    const system = systemOf(measureNo)
    const exact = scales.get(`${staffIndex}:${system}`)
    if (exact) return { scale: exact.scale, shift: 0 }
    // This staff engraved nothing on this line — a bar of rests, say. Every
    // system on a page repeats the same staff layout, so the nearest line's fit
    // is right once it is moved by the distance between the two lines.
    let nearest: { system: number; scale: PitchScale } | null = null
    let nearestDistance = Number.POSITIVE_INFINITY
    for (const entry of scales.values()) {
      if (entry.staff !== staffIndex) continue
      const distance = Math.abs(entry.system - system)
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearest = { system: entry.system, scale: entry.scale }
      }
    }
    if (!nearest) return null
    const from = systemTop.get(nearest.system)
    const to = systemTop.get(system)
    return {
      scale: nearest.scale,
      shift: from !== undefined && to !== undefined ? to - from : 0,
    }
  }

  return {
    yForPitch(pitch, staffIndex, measureNo) {
      const found = resolve(staffIndex, measureNo)
      if (!found || !Number.isFinite(pitch)) return null
      return found.scale.yForPitch(pitch) + found.shift
    },
    stepHeight(staffIndex, measureNo) {
      return resolve(staffIndex, measureNo)?.scale.stepHeight ?? fallbackStepHeight
    },
    size: scales.size,
  }
}

/**
 * Which staff a played pitch belongs on. A hint from the score wins; otherwise
 * the pitch goes to whichever staff already engraves notes closest to it, so a
 * left-hand note lands on the bass staff without being told.
 */
export const HAND_CROSSOVER_SEMITONES = 12

export function staffForPitch(
  pitch: number,
  staffPitches: Map<number, number[]>,
  hint: StaffHint = null,
): number | null {
  const indices = [...staffPitches.keys()].sort((left, right) => left - right)
  if (!indices.length) return null

  const distanceTo = (index: number): number => {
    let best = Number.POSITIVE_INFINITY
    for (const candidate of staffPitches.get(index) ?? []) {
      best = Math.min(best, Math.abs(candidate - pitch))
    }
    return best
  }

  let nearest = indices[0]
  for (const index of indices) {
    if (distanceTo(index) < distanceTo(nearest)) nearest = index
  }

  const hinted = hint === 'upper' ? indices[0]
    : hint === 'lower' ? indices[indices.length - 1]
    : null
  if (hinted === null) return nearest

  // The hint says which staff the music is on at this moment; the pitch says
  // which staff this note belongs on. A chord written across both hands hints
  // at only one of them, so a note that plainly lives an octave inside the
  // other staff's range goes there instead. The live layer draws the note that
  // sounded, and it has to appear where a reader would look for it.
  return distanceTo(hinted) - distanceTo(nearest) > HAND_CROSSOVER_SEMITONES
    ? nearest
    : hinted
}

export function staffHintFromEventIds(eventIds: Array<string | null | undefined>): StaffHint {
  // A position written across both staves spans them, so it is located from the
  // lower one; `staffForPitch` is where a played pitch may overrule that.
  const hands = eventIds.map(handOfEventId)
  if (hands.includes('left')) return 'lower'
  if (hands.includes('right')) return 'upper'
  return null
}
