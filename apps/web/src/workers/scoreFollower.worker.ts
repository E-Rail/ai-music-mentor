// 在线跟谱 Worker（方案 5.4）：beam search，只驱动光标，不作最终成绩
// - 状态：当前位置 k、速度估计 tempoSecPerBeat、最多 8 个候选
// - 每个演奏组到达时，在 [k−2, k+6] 窗口内计算匹配代价，保留总代价最小
// - 三种转移：match / skip（漏音）/ insert（多弹）
// - 速度：最近 4–8 个高置信匹配点鲁棒线性估计 + 指数平滑
// - 连续 3 个低置信 → 冻结光标、扩大搜索窗口，高置信后重锁定

interface IncomingOnset {
  onsetId: string
  measureNo: number
  onsetBeat: number
  pitches: number[]
}

interface Candidate {
  k: number           // 下一个待匹配的乐谱 onset 下标
  cost: number        // 累计代价
  anchors: { beat: number; ms: number }[]
  lastMatchIdx: number | null
  observationConfidence: number
}

interface OnsetLite {
  idx: number
  onsetId: string
  measureNo: number
  onsetBeat: number
  absBeat: number
  pitches: number[]
}

const BEAM = 8
const WINDOW_BACK = 2
const WINDOW_FWD = 6
const LOW_CONF_LIMIT = 3

let onsets: OnsetLite[] = []
let beatsPerMeasure = 4
let nominalBpm = 96
let candidates: Candidate[] = []
let lowConfStreak = 0
let frozen = false
let lastPos: { idx: number; bpm: number; confidence: number } | null = null

function pitchSetDistance(expected: number[], played: number[]): number {
  const es = new Set(expected)
  const ps = new Set(played)
  let inter = 0
  for (const p of ps) if (es.has(p)) inter += 1
  const union = es.size + ps.size - inter
  return union === 0 ? 0 : 1 - inter / union
}

function estimateTempo(anchors: { beat: number; ms: number }[]): number {
  // 最近 4–8 个锚点鲁棒估计 secPerBeat（中位差分）
  const recent = anchors.slice(-8)
  if (recent.length < 2) return 60 / nominalBpm
  const deltas: number[] = []
  for (let i = 1; i < recent.length; i += 1) {
    const db = recent[i].beat - recent[i - 1].beat
    const dm = recent[i].ms - recent[i - 1].ms
    if (db > 0 && dm > 0) deltas.push(dm / db / 1000)
  }
  if (!deltas.length) return 60 / nominalBpm
  deltas.sort((a, b) => a - b)
  return deltas[Math.floor(deltas.length / 2)]
}

function normalizeOnsets(incoming: IncomingOnset[]): OnsetLite[] {
  const out = incoming.map((onset) => ({
    idx: 0,
    onsetId: onset.onsetId,
    measureNo: onset.measureNo,
    onsetBeat: onset.onsetBeat,
    absBeat: (onset.measureNo - 1) * beatsPerMeasure + onset.onsetBeat,
    pitches: [...new Set(onset.pitches)].sort((a, b) => a - b),
  })).sort((a, b) => a.absBeat - b.absBeat)
  out.forEach((o, i) => { o.idx = i })
  return out
}

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data
  if (msg.type === 'init') {
    beatsPerMeasure = msg.beatsPerMeasure
    nominalBpm = msg.bpm
    onsets = normalizeOnsets(msg.onsets ?? [])
    candidates = [{
      k: 0, cost: 0, anchors: [], lastMatchIdx: null,
      observationConfidence: 0,
    }]
    lowConfStreak = 0
    frozen = false
    lastPos = null
    self.postMessage({ type: 'ready', onsetCount: onsets.length })
    return
  }
  if (msg.type === 'reset') {
    candidates = [{
      k: 0, cost: 0, anchors: [], lastMatchIdx: null,
      observationConfidence: 0,
    }]
    lowConfStreak = 0
    frozen = false
    lastPos = null
    return
  }
  if (msg.type !== 'group' || !onsets.length) return

  const group = msg.group ?? msg
  const groupPitches: number[] = group.pitches
  const tOnMs: number = group.tOnMs

  const next: Candidate[] = []
  for (const cand of candidates) {
    const spb = estimateTempo(cand.anchors)
    const back = frozen ? WINDOW_BACK * 3 : WINDOW_BACK
    const fwd = frozen ? WINDOW_FWD * 3 : WINDOW_FWD
    const lo = Math.max(0, cand.k - back)
    const hi = Math.min(onsets.length - 1, cand.k + fwd)

    let bestMatch: { k: number; cost: number; conf: number } | null = null
    for (let j = lo; j <= hi; j += 1) {
      const o = onsets[j]
      const dist = pitchSetDistance(o.pitches, groupPitches)
      // 期望时间：有锚点用锚点外推，否则用标称速度
      let expectedMs: number
      if (cand.anchors.length) {
        const a = cand.anchors[cand.anchors.length - 1]
        expectedMs = a.ms + (o.absBeat - a.beat) * spb * 1000
      } else {
        expectedMs = tOnMs // 首组：无位置信息
      }
      const residNorm = cand.anchors.length
        ? Math.min(1, Math.abs(tOnMs - expectedMs) / Math.max(0.5 * spb * 1000, 150))
        : 0
      const matchCost = 0.65 * dist + 0.25 * residNorm + 0.10 * 0
      const skipped = Math.max(0, j - cand.k)
      // 冻结后降低远距离跳转惩罚，使高置信音高能真正重新锁定。
      const skippedCost = frozen
        ? Math.min(skipped, 8) * 0.08
        : skipped * 0.65
      const transitionCost = matchCost + skippedCost
      const conf = 1 - matchCost
      if (!bestMatch || transitionCost < bestMatch.cost) {
        bestMatch = { k: j, cost: transitionCost, conf }
      }
    }

    // match 转移
    if (bestMatch && bestMatch.conf >= 0.35) {
      const o = onsets[bestMatch.k]
      const anchors = cand.anchors.slice(-7)
      if (bestMatch.conf >= 0.6) anchors.push({ beat: o.absBeat, ms: tOnMs })
      next.push({
        k: bestMatch.k + 1,
        cost: cand.cost + bestMatch.cost,
        anchors,
        lastMatchIdx: bestMatch.k,
        observationConfidence: bestMatch.conf,
      })
    }
    // skip 转移（漏音/跳过乐谱事件）
    if (cand.k < onsets.length) {
      next.push({
        k: cand.k + 1, cost: cand.cost + 1.0, anchors: cand.anchors.slice(-8),
        lastMatchIdx: cand.lastMatchIdx, observationConfidence: 0.3,
      })
    }
    // insert 转移（多弹了一个事件，位置不动）
    next.push({
      k: cand.k, cost: cand.cost + 0.8, anchors: cand.anchors.slice(-8),
      lastMatchIdx: cand.lastMatchIdx, observationConfidence: 0.35,
    })
  }

  next.sort((a, b) => a.cost - b.cost)
  candidates = next.slice(0, BEAM)
  const minimumCost = candidates[0].cost
  for (const candidate of candidates) candidate.cost -= minimumCost
  const best = candidates[0]
  const posIdx = Math.min(
    Math.max(best.lastMatchIdx ?? (lastPos?.idx ?? 0), 0),
    onsets.length - 1,
  )
  const matchedSomething = best.lastMatchIdx !== null &&
    (lastPos === null || best.lastMatchIdx !== lastPos.idx)
  const conf = best.observationConfidence

  if (matchedSomething && conf >= 0.6) {
    lowConfStreak = 0
    frozen = false
  } else {
    lowConfStreak += 1
    if (lowConfStreak >= LOW_CONF_LIMIT) frozen = true
  }

  const spb = estimateTempo(best.anchors)
  const bpm = spb > 0 ? 60 / spb : nominalBpm
  const smoothedBpm = lastPos ? 0.7 * lastPos.bpm + 0.3 * bpm : bpm
  const o = onsets[posIdx]
  lastPos = { idx: posIdx, bpm: smoothedBpm, confidence: frozen ? 0.3 : conf }
  self.postMessage({
    type: 'position',
    onsetIdx: posIdx,
    onsetId: o.onsetId,
    measureNo: o.measureNo,
    onsetBeat: o.onsetBeat,
    bpm: Math.round(smoothedBpm * 10) / 10,
    confidence: lastPos.confidence,
    frozen,
    done: best.k >= onsets.length,
  })
}

export {}
