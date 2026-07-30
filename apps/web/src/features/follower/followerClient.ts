// 跟谱 Worker 客户端封装

export interface FollowerPosition {
  onsetId: string
  measureNo: number
  onsetBeat: number
  bpm: number
  confidence: number
  frozen: boolean
}

export interface FollowerOnset {
  onsetId: string
  measureNo: number
  onsetBeat: number
  pitches: number[]
}

export class FollowerClient {
  private worker: Worker | null = null
  onPosition: ((p: FollowerPosition) => void) | null = null

  start(onsets: FollowerOnset[], beatsPerMeasure: number, bpm: number): void {
    this.stop()
    this.worker = new Worker(
      new URL('../../workers/scoreFollower.worker.ts', import.meta.url),
      { type: 'module' })
    this.worker.onmessage = (ev) => {
      if (ev.data.type === 'position' && this.onPosition) {
        this.onPosition(ev.data as FollowerPosition)
      }
    }
    this.worker.postMessage({ type: 'init', onsets, beatsPerMeasure, bpm })
  }

  feed(group: { id: string; tOnMs: number; pitches: number[] }): void {
    this.worker?.postMessage({ type: 'group', group })
  }

  stop(): void {
    this.worker?.terminate()
    this.worker = null
  }
}
