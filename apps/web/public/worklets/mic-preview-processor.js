/* Preview-only AudioWorklet. These samples never enter the scoring pipeline.
 *
 * The window is posted every HOP samples rather than a dozen times a second:
 * onset detection needs ~10 ms resolution to place a note attack, and at 12 Hz
 * the gaps between windows were longer than the windows themselves. */
const HOP = 512

class MicPreviewProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.framesSincePost = 0
    this.preview = new Float32Array(2048)
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel?.length) return true
    this.preview.copyWithin(0, channel.length)
    this.preview.set(channel, this.preview.length - channel.length)
    this.framesSincePost += channel.length
    if (this.framesSincePost >= HOP) {
      this.framesSincePost = 0
      let squareSum = 0
      for (let index = 0; index < channel.length; index += 1) {
        squareSum += channel[index] * channel[index]
      }
      this.port.postMessage({
        level: Math.sqrt(squareSum / channel.length),
        waveform: this.preview.slice(),
        sampleRate,
      })
    }
    return true
  }
}

registerProcessor('mic-preview-processor', MicPreviewProcessor)
