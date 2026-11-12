// YIN: de Cheveigné & Kawahara (2002), doi:10.1121/1.1458024.
export const RANGES = {
  low: [50, 300],
  normal: [65, 440],
  high: [105, 650],
};

export const WINDOW_SECONDS = 0.048;
export const HOP_SECONDS = 0.016;

// Reduce the cost of YIN and attenuate frequencies above the new Nyquist
// frequency before decimation. Keep the clock in original audio samples.
export class FrameSampler {
  constructor(inputRate, onFrame) {
    this.factor = Math.max(1, Math.floor(inputRate / 12000));
    this.rate = inputRate / this.factor;
    this.window = new Float32Array(Math.round(this.rate * WINDOW_SECONDS));
    this.hop = Math.round(this.rate * HOP_SECONDS);
    this.onFrame = onFrame;
    this.filter = 1 - Math.exp(-2 * Math.PI * 3100 / inputRate);
    this.inputRate = inputRate;
    this.samples = 0;
    this.nextFrame = this.window.length;
    this.filtered = [0, 0, 0];
  }

  push(input) {
    const { factor, window, filter, filtered } = this;
    let samples = this.samples;
    let [a, b, c] = filtered;
    for (const value of input) {
      a += filter * (value - a);
      b += filter * (a - b);
      c += filter * (b - c);
      samples++;
      if (samples % factor) continue;
      const position = samples / factor;
      window[(position - 1) % window.length] = c;
      if (position === this.nextFrame) {
        this.onFrame(window, position % window.length,
          (samples - factor * (window.length - 1) / 2) / this.inputRate);
        this.nextFrame += this.hop;
      }
    }
    this.samples = samples;
    filtered[0] = a;
    filtered[1] = b;
    filtered[2] = c;
  }
}

export class Yin {
  constructor(rate, size, range = RANGES.normal) {
    this.rate = rate;
    this.size = size;
    this.curve = new Float64Array(Math.ceil(rate / RANGES.low[0]) + 3);
    this.floor = 0.0002;
    this.setRange(range);
  }

  setRange([minHz, maxHz]) {
    this.range = [minHz, maxHz];
    // Look for a stronger high fundamental too. Rejecting it by range
    // is safer than returning one of its lower subharmonics.
    this.minLag = Math.max(2, Math.floor(this.rate / 1000));
    this.maxLag = Math.min(Math.ceil(this.rate / minHz), this.size >> 1);
  }

  measure(samples, time) {
    const { size, minLag, maxLag, curve } = this;
    // Measure AC energy near the frame centre, so silence at the edges of
    // an utterance stays distinguishable from short, weakly periodic gaps.
    const quarter = size >> 2;
    let sum = 0;
    let square = 0;
    for (let i = quarter; i < size - quarter; i++) {
      const value = samples[i];
      sum += value;
      square += value * value;
    }
    const count = size - 2 * quarter;
    const rms = Math.sqrt(Math.max(0, square / count - (sum / count) ** 2));
    const quietLimit = Math.max(0.00014, this.floor * 1.22);
    if (rms < quietLimit) {
      this.floor += 0.08 * (Math.max(0.00009, rms) - this.floor);
      return { time, hz: 0, confidence: 0, kind: "silence" };
    }

    let total = 0;
    const length = size - maxLag - 1;
    for (let lag = 1; lag <= maxLag + 1; lag++) {
      // Compare two equal-length spans centred on the frame timestamp.
      const start = (maxLag + 1 - lag) >> 1;
      let difference = 0;
      for (let i = start; i < start + length; i++) {
        const delta = samples[i] - samples[i + lag];
        difference += delta * delta;
      }
      total += difference;
      curve[lag] = total > 0 ? (difference * lag) / total : 1;
    }

    let first = 0;
    let best = 0;
    let bestValue = 1;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (!this.isMinimum(lag)) continue;
      const value = this.minimumValue(lag);
      if (value < bestValue) {
        bestValue = value;
        best = lag;
      }
      if (!first && value < 0.20) first = lag;
    }
    let lag = first || best;
    if (first) {
      // A prominent second harmonic can give YIN an early half-period.
      // Only substitute a full period when it is substantially more periodic.
      const firstValue = this.minimumValue(first);
      for (let candidate = Math.max(first + 1, Math.round(first * 1.92));
        candidate <= Math.min(maxLag, Math.round(first * 2.08)); candidate++) {
        if (!this.isMinimum(candidate)) continue;
        const value = this.minimumValue(candidate);
        if (value < 0.12 && firstValue - value > 0.027 && value < firstValue * 0.40) {
          lag = candidate;
          break;
        }
      }
    }

    const minimum = lag ? this.minimumValue(lag) : 1;
    if (minimum <= 0.27) {
      const hz = this.rate / (lag + this.offsetAt(lag));
      if (hz >= this.range[0] * 0.99 && hz <= this.range[1] * 1.01) {
        return { time, hz, confidence: 1 - minimum, kind: "voiced" };
      }
      return { time, hz: 0, confidence: 0, kind: "unvoiced" };
    }

    if (bestValue > 0.51) this.floor += 0.025 * (Math.min(rms, 0.003) - this.floor);
    return { time, hz: 0, confidence: 1 - bestValue, kind: bestValue <= 0.51 ? "weak" : "unvoiced" };
  }

  isMinimum(lag) {
    const { curve } = this;
    return curve[lag] < curve[lag - 1] && curve[lag] <= curve[lag + 1];
  }

  offsetAt(lag) {
    const { curve } = this;
    const curvature = curve[lag - 1] + curve[lag + 1] - 2 * curve[lag];
    return curvature > 0 ? 0.5 * (curve[lag - 1] - curve[lag + 1]) / curvature : 0;
  }

  minimumValue(lag) {
    const { curve } = this;
    return Math.max(0, curve[lag] + 0.25 * (curve[lag + 1] - curve[lag - 1]) * this.offsetAt(lag));
  }
}
