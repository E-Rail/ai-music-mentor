import { describe, expect, it, vi } from 'vitest'
import { MidiUploadInputAdapter } from './MidiUploadInputAdapter'

describe('MidiUploadInputAdapter', () => {
  it('keeps the private artifact reference through finish and recovery', async () => {
    const uploader = vi.fn(async () => ({ uploadedMidiRef: 'artifact-private-1' }))
    const adapter = new MidiUploadInputAdapter(uploader)
    const file = { name: 'take.mid' } as File

    adapter.start('session-1', 'piano')
    const uploaded = await adapter.upload(file)

    expect(uploader).toHaveBeenCalledWith('session-1', file)
    expect(uploaded).toMatchObject({
      events: [], uploadedMidiRef: 'artifact-private-1', fileName: 'take.mid',
    })
    expect(await adapter.recover('session-1', 'piano')).toEqual(uploaded)
    expect(adapter.stop()).toEqual(uploaded)

    await adapter.discard('session-1')
    expect(await adapter.recover('session-1', 'piano')).toBeNull()
  })

  it('can restore a server-side reference after refresh', async () => {
    const adapter = new MidiUploadInputAdapter(async () => ({ uploadedMidiRef: 'unused' }))
    adapter.restoreReference('session-2', 'artifact-private-2', 'retry.mid')

    expect(await adapter.recover('session-2', 'violin')).toMatchObject({
      uploadedMidiRef: 'artifact-private-2', fileName: 'retry.mid',
    })
  })
})
