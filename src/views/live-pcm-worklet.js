// Live capture processor shared by both local engines.
//
// Nemotron streams PCM16 straight to its sidecar, so "i16" (the default) keeps
// that path byte-for-byte as it was. Qwen chunking instead resamples each closed
// chunk through an OfflineAudioContext, which wants float samples, so it asks for
// "f32" and avoids a needless round trip through Int16 and back.
class TypeAloudPcm16CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    this.float = options?.processorOptions?.format === "f32";
  }

  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!samples?.length) {
      return true;
    }
    if (this.float) {
      // The graph reuses its input buffer between blocks, so post a copy.
      const copy = new Float32Array(samples);
      this.port.postMessage(copy.buffer, [copy.buffer]);
      return true;
    }
    const pcm = new Int16Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      pcm[index] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
    }
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    return true;
  }
}

registerProcessor("typealoud-pcm16-capture", TypeAloudPcm16CaptureProcessor);
