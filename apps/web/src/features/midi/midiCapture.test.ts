import { describe, expect, it } from 'vitest'
import { MidiCapture } from './midiCapture'

describe('MIDI capture recovery', () => {
  it('finalizes each held note exactly once when capture stops', () => {
    const capture = new MidiCapture() as unknown as {
      active: Map<string, Array<{
        id: string; tOn: number; receivedTimeMs: number
        velocity: number; pitch: number; channel: number
      }>>
      capturing: boolean
      stopCapture: (options: { persist: boolean }) => Array<{ id: string }>
    }
    capture.active.set('0:60', [{
      id: 'held-c4', tOn: performance.now(), receivedTimeMs: performance.now(),
      velocity: 80, pitch: 60, channel: 0,
    }])
    capture.capturing = true

    expect(capture.stopCapture({ persist: false }).map((event) => event.id))
      .toEqual(['held-c4'])
  })
})
