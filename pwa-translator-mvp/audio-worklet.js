class PcmMeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetSampleRate = 16000;
    this.chunkSize = 8000;
    this.buffer = new Float32Array(this.chunkSize);
    this.offset = 0;
    this.frameCount = 0;
    this.resampleCursor = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input) return true;

    if (output) {
      output.fill(0);
    }

    let sum = 0;
    const ratio = sampleRate / this.targetSampleRate;
    for (let i = 0; i < input.length; i += 1) {
      const sample = input[i];
      sum += sample * sample;

      if (i >= this.resampleCursor) {
        this.buffer[this.offset] = sample;
        this.offset += 1;
        this.resampleCursor += ratio;

        if (this.offset >= this.buffer.length) {
          const samples = this.buffer.slice(0);
          this.port.postMessage(
            { type: "pcm", sampleRate: this.targetSampleRate, samples },
            [samples.buffer],
          );
          this.offset = 0;
        }
      }
    }
    this.resampleCursor -= input.length;

    this.frameCount += 1;
    if (this.frameCount % 4 === 0) {
      this.port.postMessage({ type: "meter", rms: Math.sqrt(sum / input.length) });
    }

    return true;
  }
}

registerProcessor("pcm-meter-processor", PcmMeterProcessor);
