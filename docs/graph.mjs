import { guide, toHz } from "./contour.mjs";

const VOICE = "#007b68";
const TARGET = "#718bb3";
const PREVIOUS = "#8bb7af";
const LIVE_SECONDS = 1.6;
const LENGTHS = [0.4, 0.6, 0.8, 1.2, 1.6, 2, 3, 4, 6, 8, 12, 16, 20, 28];
const HEIGHTS = [8, 12, 16, 24, 32, 48, 64];
const number = new Intl.NumberFormat("ja", { maximumFractionDigits: 2 });

export function drawPatternIcons(buttons) {
  for (const button of buttons) {
    const ctx = button.querySelector("canvas").getContext("2d");
    if (!ctx) continue;
    ctx.lineWidth = 4.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = getComputedStyle(button).color;
    ctx.clearRect(0, 0, 108, 54);
    ctx.beginPath();
    for (let i = 0; i <= 30; i++) {
      const x = 13 + 82 * i / 30;
      const y = 27 - 6.3 * guide(button.dataset.pattern, i / 30);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

function lengthOf(trace) {
  return trace.points.at(-1).time - trace.start;
}

function drawTrace(ctx, trace, x, y, reference, unit, color, width, origin) {
  if (!trace) return;
  const offset = unit === "hz" ? reference : trace.reference;
  ctx.beginPath();
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let i = 0; i < trace.points.length; i++) {
    const point = trace.points[i];
    const time = point.time - trace.start;
    if (time < origin - 0.08) continue;
    const px = x(time);
    const py = y(point.pitch - offset);
    if (point.join && i > 0 && trace.points[i - 1].time - trace.start >= origin - 0.08) {
      ctx.lineTo(px, py);
    } else {
      ctx.moveTo(px, py);
      // A single reliable frame at an edge is visible as a tiny stroke.
      if (!trace.points[i + 1]?.join) ctx.lineTo(px + 0.1, py);
    }
  }
  ctx.stroke();
}

export class PitchGraph {
  constructor(canvas, getView) {
    this.canvas = canvas;
    this.getView = getView;
    this.ctx = canvas.getContext("2d");
    this.request = null;
    this.lastPaint = 0;
    this.height = 8;
    this.goalHeight = 8;
    this.trace = null;
    new ResizeObserver(() => this.schedule()).observe(canvas);
    this.schedule();
  }

  schedule() {
    if (this.request !== null) return;
    this.request = requestAnimationFrame((time) => {
      this.request = null;
      if (time - this.lastPaint < 28) {
        this.schedule();
        return;
      }
      const elapsed = Math.min(time - this.lastPaint, 65);
      this.lastPaint = time;
      this.draw(elapsed);
    });
  }

  draw(elapsed) {
    const { canvas, ctx } = this;
    if (!ctx) return;
    const { trace, previous, live, pattern, unit, fallback } = this.getView();
    const { width, height } = canvas.getBoundingClientRect();
    if (width < 100 || height < 100) return;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const rasterWidth = Math.round(width * ratio);
    const rasterHeight = Math.round(height * ratio);
    if (canvas.width !== rasterWidth || canvas.height !== rasterHeight) {
      canvas.width = rasterWidth;
      canvas.height = rasterHeight;
    }
    ctx.setTransform(rasterWidth / width, 0, 0, rasterHeight / height, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const reference = trace?.reference ?? fallback;
    let maximum = 0;
    for (const item of [trace, previous]) {
      if (!item) continue;
      const center = unit === "hz" ? reference : item.reference;
      for (const point of item.points) maximum = Math.max(maximum, Math.abs(point.pitch - center));
    }
    const needed = HEIGHTS.find((candidate) => maximum <= candidate - 0.65) ?? HEIGHTS.at(-1);
    if (this.trace !== trace) {
      this.trace = trace;
      this.height = needed;
      this.goalHeight = needed;
    }
    this.goalHeight = live ? Math.max(needed, this.goalHeight) : needed;
    this.height += (this.goalHeight - this.height) * Math.min(1, elapsed / 130);
    if (Math.abs(this.height - this.goalHeight) > 0.08) this.schedule();
    else this.height = this.goalHeight;

    const duration = trace ? lengthOf(trace) : 0;
    const firstTime = trace ? trace.points[0].time - trace.start : 0;
    const span = live || !trace ? LIVE_SECONDS :
      (LENGTHS.find((candidate) => (duration - firstTime) * 1.08 <= candidate) ?? LENGTHS.at(-1));
    const origin = live ? Math.max(0, duration - span * 0.97) : firstTime;
    const left = 38;
    const right = width - 7;
    const top = 12;
    const bottom = height - 29;
    const x = (time) => left + (time - origin) / span * (right - left);
    const y = (pitch) => (top + bottom) / 2 - pitch / this.height * (bottom - top) / 2;

    ctx.fillStyle = "#f6faf9";
    ctx.beginPath();
    ctx.roundRect(left, top, right - left, bottom - top, 5);
    ctx.fill();
    ctx.font = "12px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    ctx.lineWidth = 1;
    const step = this.height <= 8.1 ? 4 : this.height <= 16.1 ? 6 : this.height <= 32.1 ? 12 : 24;
    const ticks = Math.floor(this.height / step + 1e-6);
    for (let i = -ticks; i <= ticks; i++) {
      const pitch = i * step;
      const yy = y(pitch);
      ctx.fillStyle = "#4e6765";
      const label = unit === "hz" ? String(Math.round(toHz(reference + pitch))) : (pitch > 0 ? "+" : "") + pitch;
      ctx.fillText(label, left - 6, yy);
      ctx.strokeStyle = i === 0 ? "#bfdbd4" : "#dce9e6";
      ctx.beginPath();
      ctx.moveTo(left, yy);
      ctx.lineTo(right, yy);
      ctx.stroke();
    }
    const timeStep = span / 4;
    let labeledEnd = false;
    for (let tick = Math.ceil(origin / timeStep - 1e-6); tick * timeStep <= origin + span + 1e-6; tick++) {
      const time = tick === 0 ? 0 : tick * timeStep;
      const xx = x(time);
      ctx.strokeStyle = "#dce9e6";
      ctx.beginPath();
      ctx.moveTo(xx, top);
      ctx.lineTo(xx, bottom);
      ctx.stroke();
      if (Math.abs(xx - right) < 0.1) {
        ctx.textAlign = "right";
        ctx.fillStyle = "#4e6765";
        ctx.fillText(`${number.format(time)} 秒`, right, bottom + 14);
        labeledEnd = true;
      } else if (xx <= right - 28) {
        ctx.textAlign = "center";
        ctx.fillStyle = "#4e6765";
        ctx.fillText(number.format(time), xx, bottom + 14);
      }
    }
    if (!labeledEnd) {
      ctx.fillStyle = "#4e6765";
      ctx.textAlign = "right";
      ctx.fillText("秒", right, bottom + 14);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top - 1, right - left, bottom - top + 2);
    ctx.clip();
    const guideLength = trace && !live && !trace.truncated ? Math.max(duration, 0.08) : span * 0.94;
    ctx.lineWidth = 1.7;
    ctx.strokeStyle = TARGET;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    for (let i = 0; i <= 48; i++) {
      const progress = i / 48;
      const px = x(origin + guideLength * progress);
      const py = y(guide(pattern, progress));
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    drawTrace(ctx, previous, x, y, reference, unit, PREVIOUS, 1.6, origin);
    drawTrace(ctx, trace, x, y, reference, unit, VOICE, 2.7, origin);
    ctx.restore();
  }
}
