import { describe, expect, it } from 'vitest'
import { transcribeAudio } from './transcription'

describe('microphone transcription cancellation', () => {
  it('rejects an already-cancelled take before decoding or loading the model', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(transcribeAudio(
      new Blob(['saved-audio']), 'piano', null, () => {}, controller.signal,
    )).rejects.toMatchObject({ code: 'TRANSCRIPTION_CANCELLED' })
  })
})
