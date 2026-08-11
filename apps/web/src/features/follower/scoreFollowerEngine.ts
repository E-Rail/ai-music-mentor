export interface ScoreFollowerOnset {
  onsetId: string
  measureNo: number
  onsetBeat: number
  absoluteBeat?: number | null
  pitches: number[]
}

export interface ScoreFollowerGroup {
  tOnMs: number
  pitches: number[]
}

export interface ScoreFollowerPosition {
  onsetIdx: number
  onsetId: string
  measureNo: number
  onsetBeat: number
  bpm: number
  confidence: number
  frozen: boolean
  done: boolean
}

interface OnsetLite extends ScoreFollowerOnset {
  idx: number
  absBeat: number
}

interface Candidate {
  k: number
  cost: number
  anchors: { beat: number; ms: number }[]
  lastMatchIdx: number | null
  observationConfidence: number
}

const BEAM_SIZE = 8
const NORMAL_LOOKAHEAD = 2
const RELOCK_LOOKAHEAD = 12
const RELOCK_LOOKBACK = 6
const LOW_CONFIDENCE_LIMIT = 3
const INSERTION_COST = 0.75

function pitchSetDistance(expected: number[], played: number[]): number {
  const expectedSet = new Set(expected)
  const playedSet = new Set(played)
  let intersection = 0
  for (const pitch of playedSet) if (expectedSet.has(pitch)) intersection += 1
  const union = expectedSet.size + playedSet.size - intersection
  return union === 0 ? 0 : 1 - intersection / union
}

function estimateSecondsPerBeat(
  anchors: { beat: number; ms: number }[], nominalBpm: number,
): number {
  const recent = anchors.slice(-8)
  if (recent.length < 2) return 60 / nominalBpm
  const estimates: number[] = []
  for (let index = 1; index < recent.length; index += 1) {
    const beatDelta = recent[index].beat - recent[index - 1].beat
    const timeDelta = recent[index].ms - recent[index - 1].ms
    if (beatDelta > 0 && timeDelta > 0) estimates.push(timeDelta / beatDelta / 1_000)
  }
  if (!estimates.length) return 60 / nominalBpm
  estimates.sort((left, right) => left - right)
  return estimates[Math.floor(estimates.length / 2)]
}

/**
 * Online score follower used only for the live cursor.
 *
 * A performed onset may either match one score onset or be treated as an
 * insertion. There is deliberately no standalone "skip" transition: advancing
 * the score without consuming a played onset was the source of the cursor
 * drifting several notes ahead. A missing score note is represented by a
 * forward match, and that match must be supported by pitch and elapsed time.
 */
export class ScoreFollowerEngine {
  private onsets: OnsetLite[] = []
  private beatsPerMeasure = 4
  private nominalBpm = 96
  private candidates: Candidate[] = []
  private lowConfidenceStreak = 0
  private frozen = false
  private lastPosition: { idx: number; bpm: number; confidence: number } | null = null

  init(incoming: ScoreFollowerOnset[], beatsPerMeasure: number, bpm: number): void {
    this.beatsPerMeasure = Math.max(0.25, beatsPerMeasure)
    this.nominalBpm = Math.max(20, Math.min(300, bpm))
    this.onsets = incoming.map((onset) => ({
      ...onset,
      idx: 0,
      absBeat: onset.absoluteBeat ??
        (onset.measureNo - 1) * this.beatsPerMeasure + onset.onsetBeat,
      pitches: [...new Set(onset.pitches)].sort((left, right) => left - right),
    })).sort((left, right) => left.absBeat - right.absBeat)
    this.onsets.forEach((onset, index) => { onset.idx = index })
    this.reset()
  }

  reset(): void {
    this.candidates = [{
      k: 0, cost: 0, anchors: [], lastMatchIdx: null,
      observationConfidence: 0,
    }]
    this.lowConfidenceStreak = 0
    this.frozen = false
    this.lastPosition = null
  }

  process(group: ScoreFollowerGroup): ScoreFollowerPosition | null {
    if (!this.onsets.length || !group.pitches.length) return null
    const played = [...new Set(group.pitches)].sort((left, right) => left - right)
    const next: Candidate[] = []

    for (const candidate of this.candidates) {
      const secondsPerBeat = estimateSecondsPerBeat(candidate.anchors, this.nominalBpm)
      const lookback = this.frozen ? RELOCK_LOOKBACK : 0
      const lookahead = this.frozen ? RELOCK_LOOKAHEAD : NORMAL_LOOKAHEAD
      const low = Math.max(0, candidate.k - lookback)
      const high = Math.min(this.onsets.length - 1, candidate.k + lookahead)

      for (let scoreIndex = low; scoreIndex <= high; scoreIndex += 1) {
        const onset = this.onsets[scoreIndex]
        const pitchDistance = pitchSetDistance(onset.pitches, played)
        const pitchConfidence = 1 - pitchDistance
        if (pitchConfidence < 0.38) continue

        let timingResidual = 0
        let unsupportedEarlyJump = 0
        if (candidate.anchors.length) {
          const anchor = candidate.anchors[candidate.anchors.length - 1]
          const expectedMs = anchor.ms +
            (onset.absBeat - anchor.beat) * secondsPerBeat * 1_000
          timingResidual = Math.min(
            1,
            Math.abs(group.tOnMs - expectedMs) /
              Math.max(0.5 * secondsPerBeat * 1_000, 150),
          )
          if (scoreIndex > candidate.k) {
            const earlyByMs = expectedMs - group.tOnMs
            const allowedEarlyMs = Math.max(120, secondsPerBeat * 350)
            if (earlyByMs > allowedEarlyMs) {
              unsupportedEarlyJump = 0.45 +
                Math.min(0.45, (earlyByMs - allowedEarlyMs) /
                  Math.max(secondsPerBeat * 1_000, 1) * 0.25)
            }
          }
        }

        const skipped = Math.max(0, scoreIndex - candidate.k)
        const movedBack = Math.max(0, candidate.k - scoreIndex)
        const skipCost = skipped * (this.frozen ? 0.08 : 0.55)
        const backwardCost = movedBack * 0.22
        const matchCost = 0.82 * pitchDistance + 0.18 * timingResidual +
          skipCost + backwardCost + unsupportedEarlyJump
        const observationConfidence = Math.max(
          0, Math.min(1, 0.82 * pitchConfidence + 0.18 * (1 - timingResidual)),
        )
        const anchors = candidate.anchors.slice(-7)
        if (observationConfidence >= 0.6) {
          anchors.push({ beat: onset.absBeat, ms: group.tOnMs })
        }
        next.push({
          k: scoreIndex + 1,
          cost: candidate.cost + matchCost,
          anchors,
          lastMatchIdx: scoreIndex,
          observationConfidence,
        })
      }

      // An extra/wrong onset is consumed without moving the score cursor.
      next.push({
        k: candidate.k,
        cost: candidate.cost + INSERTION_COST,
        anchors: candidate.anchors.slice(-8),
        lastMatchIdx: candidate.lastMatchIdx,
        observationConfidence: 0.2,
      })
    }

    next.sort((left, right) => left.cost - right.cost)
    this.candidates = next.slice(0, BEAM_SIZE)
    const minimumCost = this.candidates[0].cost
    for (const candidate of this.candidates) candidate.cost -= minimumCost
    const best = this.candidates[0]

    const fallbackIndex = this.lastPosition?.idx ?? 0
    let positionIndex = best.lastMatchIdx ?? fallbackIndex
    // A locked cursor never moves backwards. Backtracking is reserved for the
    // explicit low-confidence re-lock state.
    if (!this.frozen && this.lastPosition) {
      positionIndex = Math.max(positionIndex, this.lastPosition.idx)
    }
    positionIndex = Math.min(Math.max(positionIndex, 0), this.onsets.length - 1)
    const advanced = best.lastMatchIdx !== null &&
      (this.lastPosition === null || best.lastMatchIdx !== this.lastPosition.idx)

    if (advanced && best.observationConfidence >= 0.6) {
      this.lowConfidenceStreak = 0
      this.frozen = false
    } else {
      this.lowConfidenceStreak += 1
      if (this.lowConfidenceStreak >= LOW_CONFIDENCE_LIMIT) this.frozen = true
    }

    const secondsPerBeat = estimateSecondsPerBeat(best.anchors, this.nominalBpm)
    const estimatedBpm = Math.max(20, Math.min(300, 60 / secondsPerBeat))
    const smoothedBpm = this.lastPosition
      ? 0.7 * this.lastPosition.bpm + 0.3 * estimatedBpm
      : estimatedBpm
    const onset = this.onsets[positionIndex]
    const confidence = this.frozen ? Math.min(0.3, best.observationConfidence)
      : best.observationConfidence
    this.lastPosition = { idx: positionIndex, bpm: smoothedBpm, confidence }
    return {
      onsetIdx: positionIndex,
      onsetId: onset.onsetId,
      measureNo: onset.measureNo,
      onsetBeat: onset.onsetBeat,
      bpm: Math.round(smoothedBpm * 10) / 10,
      confidence,
      frozen: this.frozen,
      done: best.k >= this.onsets.length,
    }
  }
}
