import { FrameSampler } from "./pitch.mjs";

class PitchCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pool = [];
    this.sampler = new FrameSampler(sampleRate, (window, start, time) => {
      const samples = this.pool.pop();
      if (!samples) return;
      samples.set(window.subarray(start));
      samples.set(window.subarray(0, start), window.length - start);
      this.channel.postMessage({ samples, time }, [samples.buffer]);
    });
    this.port.onmessage = ({ data }) => {
      this.channel = data.port;
      this.channel.onmessage = ({ data: samples }) => this.pool.push(samples);
      for (let i = 0; i < 3; i++) this.pool.push(new Float32Array(this.sampler.window.length));
    };
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (input && this.channel) this.sampler.push(input);
    // The worklet's output stays silent.
    return true;
  }
}

registerProcessor("pitch-capture", PitchCapture);
