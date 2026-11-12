import { FrameSampler, RANGES, Yin } from "./pitch.mjs";

self.onmessage = ({ data: { port, sampleRate, range } }) => {
  const { rate, window } = new FrameSampler(sampleRate, () => {});
  const detector = new Yin(rate, window.length, RANGES[range]);
  port.onmessage = ({ data: { samples, time } }) => {
    const frame = detector.measure(samples, time);
    port.postMessage(samples, [samples.buffer]);
    self.postMessage(frame);
  };
  self.postMessage({ ready: true });
};
