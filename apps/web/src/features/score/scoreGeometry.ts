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

export function staffHintFromEventIds(eventIds: Array<string | null | undefined>): StaffHint {
  const parts = eventIds
    .filter((eventId): eventId is string => Boolean(eventId))
    .map((eventId) => eventId.split(':')[1]?.trim().toLowerCase())
    .filter(Boolean)
  if (parts.some((part) => part === 'lh' || part.includes('left'))) return 'lower'
  if (parts.some((part) => part === 'rh' || part.includes('right'))) return 'upper'
  return null
}
