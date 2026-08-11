import { ScoreFollowerEngine } from '../features/follower/scoreFollowerEngine'

// Live cursor worker. Final scoring remains entirely in the backend analysis
// pipeline; this worker only reports a conservative preview position.
const engine = new ScoreFollowerEngine()

self.onmessage = (event: MessageEvent) => {
  const message = event.data
  if (message.type === 'init') {
    engine.init(message.onsets ?? [], message.beatsPerMeasure, message.bpm)
    self.postMessage({ type: 'ready', onsetCount: message.onsets?.length ?? 0 })
    return
  }
  if (message.type === 'reset') {
    engine.reset()
    return
  }
  if (message.type !== 'group') return
  const group = message.group ?? message
  const position = engine.process({
    tOnMs: group.tOnMs,
    pitches: group.pitches ?? [],
  })
  if (position) self.postMessage({ type: 'position', ...position })
}

export {}
