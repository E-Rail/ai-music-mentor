import { beforeAll, describe, expect, it } from 'vitest'
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

describe('grouping keys into gestures', () => {
  // The capture schedules its chord window on `window`, as it does in a
  // browser. Node has the same timers under a different name.
  beforeAll(() => {
    ;(globalThis as unknown as { window: unknown }).window ??= globalThis
  })

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  /** Feeds raw note-on messages and collects the groups the capture emits. */
  function harness() {
    const capture = new MidiCapture()
    const groups: number[][] = []
    capture.onGroup = (group) => groups.push(group.pitches)
    const inner = capture as unknown as {
      capturing: boolean
      handleMessage: (message: unknown) => void
    }
    inner.capturing = true
    const strike = (pitch: number) => inner.handleMessage({
      data: new Uint8Array([0x90, pitch, 80]), receivedTime: performance.now(),
    })
    return { groups, strike }
  }

  it('keeps a fast run as separate notes', async () => {
    // The window is 70 ms. Struck 50 ms apart, these five notes are three
    // gestures — but while every key restarted the timer they became one
    // 5-note chord, which then read as a fistful of wrong notes.
    const { groups, strike } = harness()
    for (let index = 0; index < 5; index += 1) {
      strike(60 + index)
      await wait(50)
    }
    await wait(120)
    expect(groups.length).toBeGreaterThan(1)
    expect(groups.flat()).toEqual([60, 61, 62, 63, 64])
  })

  it('keeps keys struck together in one group', async () => {
    const { groups, strike } = harness()
    strike(48)
    strike(60)
    await wait(160)
    expect(groups).toEqual([[48, 60]])
  })
})
