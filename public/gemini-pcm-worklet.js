/**
 * Captures microphone audio, downmixes to mono, resamples to 16 kHz, and posts
 * 20 ms PCM16 frames. The main thread sends those frames to Gemini Live.
 */
class GeminiPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.position = 0;
    this.pending = [];
    this.pendingLength = 0;
    this.frameSamples = 320; // 20 ms at 16 kHz
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;

    let outLength = 0;
    for (let probe = this.position; probe < input.length; probe += this.ratio) outLength += 1;
    if (outLength === 0) {
      this.position -= input.length;
      return true;
    }

    const out = new Int16Array(outLength);
    let localPosition = this.position;
    for (let index = 0; index < outLength; index += 1) {
      const base = Math.floor(localPosition);
      const next = Math.min(base + 1, input.length - 1);
      const fraction = localPosition - base;
      const sample = input[base] * (1 - fraction) + input[next] * fraction;
      const clipped = Math.max(-1, Math.min(1, sample));
      out[index] = clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff;
      localPosition += this.ratio;
    }
    this.position = localPosition - input.length;

    this.pending.push(out);
    this.pendingLength += out.length;
    while (this.pendingLength >= this.frameSamples) {
      const frame = new Int16Array(this.frameSamples);
      let written = 0;
      while (written < this.frameSamples && this.pending.length > 0) {
        const chunk = this.pending[0];
        const take = Math.min(chunk.length, this.frameSamples - written);
        frame.set(chunk.subarray(0, take), written);
        written += take;
        if (take === chunk.length) this.pending.shift();
        else this.pending[0] = chunk.subarray(take);
      }
      this.pendingLength -= this.frameSamples;
      let sum = 0;
      for (let index = 0; index < frame.length; index += 1) sum += (frame[index] / 32768) ** 2;
      const level = Math.sqrt(sum / frame.length);
      this.port.postMessage({ type: "audio", buffer: frame.buffer, level }, [frame.buffer]);
    }
    return true;
  }
}

registerProcessor("gemini-pcm-processor", GeminiPcmProcessor);
