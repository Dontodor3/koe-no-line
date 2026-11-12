import { HOP_SECONDS } from "./pitch.mjs";

export const PATTERNS = {
  falling: { label: "下降調", example: "Yes.", hint: "高く始めて、語尾を下げます。", anchors: [2.4, 1.7, -2.4] },
  rising: { label: "上昇調", example: "Really?", hint: "低く始めて、語尾を上げます。", anchors: [-2.4, -1.7, 2.4] },
  dip: { label: "下降上昇調", example: "Well…", hint: "いったん下げてから、語尾を上げます。", anchors: [2.3, -2.6, 2.3] },
  flat: { label: "平坦調", example: "Hmm…", hint: "声の高さを大きく変えずに伸ばします。", anchors: [0, 0, 0] },
};

export const MESSAGES = {
  rising: "上がっています",
  falling: "下がっています",
  dip: "下がってから上がっています",
  flat: "ほぼ一定です",
  unclear: "判定できません",
};

export const semitones = (hz) => 12 * Math.log2(hz);
export const toHz = (pitch) => 2 ** (pitch / 12);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function guide(pattern, ratio) {
  const [start, middle, end] = PATTERNS[pattern].anchors;
  const part = ratio < 0.54 ? ratio / 0.54 : (ratio - 0.54) / 0.46;
  const eased = part * part * (3 - 2 * part);
  return ratio < 0.54 ? start + (middle - start) * eased : middle + (end - middle) * eased;
}

function quantile(values, proportion) {
  const ordered = values.slice().sort((a, b) => a - b);
  return ordered[Math.round((ordered.length - 1) * proportion)];
}

export function evaluate(trace) {
  if (!trace || trace.truncated) return "unclear";
  const { points } = trace;
  if (points.length < 9) return "unclear";
  const start = points[0].time;
  const duration = points.at(-1).time - start;
  if (duration < 0.125 || points.length * HOP_SECONDS < duration * 0.60) return "unclear";

  const early = [];
  const late = [];
  const middle = [];
  const bins = Array.from({ length: 5 }, () => []);
  for (const point of points) {
    const progress = (point.time - start) / duration;
    if (progress <= 0.25) early.push(point.pitch);
    if (progress >= 0.75) late.push(point.pitch);
    if (progress >= 0.30 && progress <= 0.70) middle.push(point.pitch);
    bins[Math.min(4, Math.floor(progress * 5))].push(point.pitch);
  }
  if (early.length < 2 || late.length < 2 || middle.length < 2) return "unclear";
  // A long break splits the evidence into separate stretches of voice.
  if (points.some((point, i) => i > 0 && point.time - points[i - 1].time > 0.20)) return "unclear";
  const first = quantile(early, 0.5);
  const last = quantile(late, 0.5);
  const trough = quantile(middle, 0.24);
  if (first - trough >= 1.6 && last - trough >= 1.6) return "dip";

  const pitches = points.map((point) => point.pitch);
  if (quantile(pitches, 0.90) - quantile(pitches, 0.10) <= 1.05) return "flat";
  const medians = bins.filter((bin) => bin.length).map((bin) => quantile(bin, 0.5));
  let up = 0;
  let down = 0;
  for (let i = 1; i < medians.length; i++) {
    const step = medians[i] - medians[i - 1];
    up += Math.max(step, 0);
    down += Math.max(-step, 0);
  }
  if (last - first >= 1.45 && up >= down * 2) return "rising";
  if (first - last >= 1.45 && down >= up * 2) return "falling";
  return "unclear";
}

const END_DELAY = 0.38;
const BRIDGE_LIMIT = 0.052;
const MAX_POINTS = Math.ceil(24 / HOP_SECONDS);
const NEUTRAL = semitones(150);

function closeInPitch(a, b, limit) {
  return a && b && Math.abs(a.pitch - b.pitch) <= limit;
}

export class ContourTracker {
  constructor() {
    this.baseline = null;
    this.active = null;
    this.latest = null;
    this.previous = null;
    this.resetFrames();
  }

  get reference() {
    return this.baseline ?? NEUTRAL;
  }

  resetFrames() {
    this.pending = null;
    this.lastFrame = null;
    this.candidate = null;
    this.gap = null;
  }

  push(frame, pattern) {
    if (this.lastFrame !== null && frame.time <= this.lastFrame) return false;
    const previous = this.pending;
    const next = frame.hz > 0 ? { ...frame, pitch: semitones(frame.hz), pattern } : { ...frame, pattern };
    this.pending = next;
    this.lastFrame = frame.time;
    if (!previous) return false;
    const nearNext = next.time - previous.time < 0.025 ? next : null;
    return this.accept(previous, nearNext);
  }

  accept(frame, next) {
    const old = this.active?.points.at(-1);
    let changed = false;
    if (old && frame.time - old.time >= END_DELAY) {
      this.finish();
      changed = true;
    }
    const last = this.active?.points.at(-1);
    // Reject an isolated octave or other spike before it reaches the graph.
    const spike = last && frame.hz && !closeInPitch(frame, last, 4.8) &&
      frame.time - last.time < 0.075 && !closeInPitch(frame, next, 1.8);
    if (!frame.hz || spike) {
      this.candidate = null;
      if (last) {
        const weak = (spike || frame.kind === "weak") &&
          frame.time - last.time <= BRIDGE_LIMIT &&
          (!this.gap || this.gap.weak) &&
          frame.time - (this.gap?.time ?? last.time) < 0.025;
        this.gap = { weak, time: frame.time };
      }
      return changed;
    }

    if (!this.active) {
      const first = this.candidate;
      if (!first || frame.time - first.time >= 0.025 || !closeInPitch(frame, first, 2.6) ||
          Math.max(first.confidence, frame.confidence) < 0.83) {
        this.candidate = frame;
        return changed;
      }
      this.active = {
        start: first.time,
        reference: this.baseline ?? (first.pitch + frame.pitch) / 2,
        pattern: first.pattern,
        points: [{ time: first.time, pitch: first.pitch, raw: first.pitch, confidence: first.confidence, join: false }],
      };
      this.candidate = null;
    }
    const points = this.active.points;
    const previous = points.at(-1);
    const elapsed = frame.time - previous.time;
    const jump = Math.abs(frame.pitch - previous.raw);
    const direct = elapsed < 0.025 && !this.gap && jump < 4.8;
    const bridge = this.gap?.weak && elapsed <= BRIDGE_LIMIT &&
      frame.time - this.gap.time < 0.025 && jump < 1.7 &&
      Math.min(frame.confidence, previous.confidence) >= 0.85;
    const join = Boolean(direct || bridge);
    // Smooth in semitones. Respond faster to intentional, sustained changes.
    const response = clamp(0.46 + jump * 0.12, 0.46, 0.78);
    const pitch = join ? previous.pitch + (frame.pitch - previous.pitch) * response : frame.pitch;
    points.push({ time: frame.time, pitch, raw: frame.pitch, confidence: frame.confidence, join });
    if (points.length > MAX_POINTS + 62) {
      points.splice(0, 62);
      points[0].join = false;
      this.active.truncated = true;
    }
    this.gap = null;
    return true;
  }

  finish() {
    if (!this.active) return false;
    const trace = this.active;
    trace.result = evaluate(trace);
    this.previous = this.latest;
    this.latest = trace;
    this.active = null;
    this.gap = null;
    const neutral = quantile(trace.points.map((point) => point.raw), 0.50);
    if (trace.points.length >= 6) {
      this.baseline = this.baseline === null ? neutral :
        this.baseline + clamp(neutral - this.baseline, -3, 3) * 0.28;
    }
    return true;
  }

  stop() {
    if (this.pending) this.accept(this.pending, null);
    this.finish();
    this.resetFrames();
  }

  clear() {
    this.active = null;
    this.resetFrames();
  }
}
