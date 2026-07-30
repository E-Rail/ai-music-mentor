// 在线跟谱 Worker（方案 5.4）：beam search，只驱动光标，不作最终成绩
// - 状态：当前位置 k、速度估计 tempoSecPerBeat、最多 8 个候选
// - 每个演奏组到达时，在 [k−2, k+6] 窗口内计算匹配代价，保留总代价最小
// - 三种转移：match / skip（漏音）/ insert（多弹）
// - 速度：最近 4–8 个高置信匹配点鲁棒线性估计 + 指数平滑
// - 连续 3 个低置信 → 冻结光标、扩大搜索窗口，高置信后重锁定

interface ScoreEventLite {
  eventId: string
  measureNo: number
  onsetBeat: number
  pitches: number[]
  optional: boolean
}

interface Candidate {
  k: number           // 下一个待匹配的乐谱 onset 下标
  cost: number        // 累计代价
  anchors: { beat: number; ms: number }[]
}

interface OnsetLite {
  idx: number
  measureNo: number
  onsetBeat: number
  absBeat: number
  pitches: number[]
  optional: boolean
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

function clusterOnsets(events: ScoreEventLite[]): OnsetLite[] {
  const map = new Map<string, OnsetLite>()
  for (const e of events) {
    const key = `${e.measureNo}:${e.onsetBeat}`
    const cur = map.get(key)
    if (cur) {
      cur.pitches = [...new Set([...cur.pitches, ...e.pitches])].sort((a, b) => a - b)
      cur.optional = cur.optional && e.optional
    } else {
      map.set(key, {
        idx: 0, measureNo: e.measureNo, onsetBeat: e.onsetBeat,
        absBeat: (e.measureNo - 1) * beatsPerMeasure + e.onsetBeat,
        pitches: [...e.pitches], optional: e.optional,
      })
    }
  }
  const out = [...map.values()].sort((a, b) => a.absBeat - b.absBeat)
  out.forEach((o, i) => { o.idx = i })
  return out
}

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data
  if (msg.type === 'init') {
    beatsPerMeasure = msg.beatsPerMeasure
    nominalBpm = msg.bpm
    onsets = clusterOnsets(msg.scoreEvents)
    candidates = [{ k: 0, cost: 0, anchors: [] }]
    lowConfStreak = 0
    frozen = false
    lastPos = null
    self.postMessage({ type: 'ready', onsetCount: onsets.length })
    return
  }
  if (msg.type === 'reset') {
    candidates = [{ k: 0, cost: 0, anchors: [] }]
    lowConfStreak = 0
    frozen = false
    lastPos = null
    return
  }
  if (msg.type !== 'group' || !onsets.length) return

  const groupPitches: number[] = msg.pitches
  const tOnMs: number = msg.tOnMs
  const spbDefault = 60 / nominalBpm

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
      const cost = 0.65 * dist + 0.25 * residNorm + 0.10 * 0
      const conf = 1 - cost
      if (!bestMatch || cost < bestMatch.cost) bestMatch = { k: j, cost, conf }
    }

    // match 转移
    if (bestMatch && bestMatch.cost < 0.9) {
      const o = onsets[bestMatch.k]
      const anchors = [...cand.anchors]
      if (bestMatch.conf >= 0.6) anchors.push({ beat: o.absBeat, ms: tOnMs })
      next.push({ k: bestMatch.k + 1, cost: cand.cost + bestMatch.cost, anchors })
    }
    // skip 转移（漏音/跳过乐谱事件）
    if (cand.k < onsets.length) {
      next.push({ k: cand.k + 1, cost: cand.cost + 1.0, anchors: [...cand.anchors] })
    }
    // insert 转移（多弹了一个事件，位置不动）
    next.push({ k: cand.k, cost: cand.cost + 0.8, anchors: [...cand.anchors] })
  }

  next.sort((a, b) => a.cost - b.cost)
  candidates = next.slice(0, BEAM)
  const best = candidates[0]
  const posIdx = Math.min(best.k, onsets.length - 1)
  const matchedSomething = best.k > (lastPos?.idx ?? 0) || best.anchors.length > 0
  const conf = best.anchors.length ? 0.85 : 0.4

  if (matchedSomething && best.anchors.length >= 1) {
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
    measureNo: o.measureNo,
    onsetBeat: o.onsetBeat,
    bpm: Math.round(smoothedBpm * 10) / 10,
    confidence: lastPos.confidence,
    frozen,
    done: best.k >= onsets.length,
  })
}

export {}
