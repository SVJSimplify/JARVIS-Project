import type { JarvisMode } from './jarvisMode';

type RGB = [number, number, number];

interface Look {
  rgb: RGB;
  spin: number;
  energy: number;
}

const LOOKS: Record<JarvisMode, Look> = {
  idle: { rgb: [255, 255, 255], spin: 1, energy: 0.2 },
  listening: { rgb: [255, 255, 255], spin: 1.3, energy: 0.55 },
  thinking: { rgb: [200, 200, 200], spin: 3.4, energy: 0.45 },
  speaking: { rgb: [255, 255, 255], spin: 1.7, energy: 0.85 },
};

export interface FrameInput {
  dt: number;
  width: number;
  height: number;
  mode: JarvisMode;
  /** Normalised microphone level, 0..1. */
  level: number;
  reduceMotion: boolean;
}

const TAU = Math.PI * 2;
const POINTS = 620;
const BARS = 96;
const TICKS = 180;
const STREAMS = 50;
const DEPTH = 3.4;
const ARCS: ReadonlyArray<readonly [number, number]> = [
  [0, 1.15], [1.5, 0.5], [2.3, 1.4], [4.1, 0.35], [4.7, 1.2],
];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const easeOut = (v: number) => 1 - Math.pow(1 - clamp01(v), 3);
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/** Fibonacci sphere: xyz triplets plus a stable per-point seed. */
function buildCloud(n: number) {
  const xyz = new Float32Array(n * 3);
  const seed = new Float32Array(n);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    xyz[i * 3] = Math.cos(i * golden) * r;
    xyz[i * 3 + 1] = y;
    xyz[i * 3 + 2] = Math.sin(i * golden) * r;
    seed[i] = (Math.sin(i * 12.9898) * 43758.5453) % 1;
    seed[i] = Math.abs(seed[i]);
  }
  return { xyz, seed };
}

/**
 * Canvas renderer for the JARVIS reactor. Holds only animation state;
 * the React wrapper owns the canvas, sizing and the frame loop.
 */
export class Reactor {
  private rgb: RGB = [...LOOKS.idle.rgb];
  private spin = 1;
  private energy = 0.2;
  private level = 0;
  private think = 0;
  private boot = 0;
  private clock = 0;
  private rotA = 0;
  private rotB = 0;
  private rotC = 0;
  private rotSphere = 0;
  private readonly cloud = buildCloud(POINTS);

  render(ctx: CanvasRenderingContext2D, f: FrameInput): void {
    this.advance(f);
    const { width: w, height: h } = f;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.34;

    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    this.drawBloom(ctx, cx, cy, R);
    this.drawStreams(ctx, cx, cy, R);
    this.drawSphere(ctx, cx, cy, R * 0.5);
    this.drawHex(ctx, cx, cy, R);
    this.drawSweep(ctx, cx, cy, R);
    this.drawCore(ctx, cx, cy, R);
    this.drawBars(ctx, cx, cy, R);
    this.drawTicks(ctx, cx, cy, R);
    this.drawArcs(ctx, cx, cy, R);
    this.drawOuter(ctx, cx, cy, R);
    this.drawLabels(ctx, cx, cy, R);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  private advance(f: FrameInput): void {
    const look = LOOKS[f.mode];
    const dt = f.dt * (f.reduceMotion ? 0.15 : 1);
    const ease = 1 - Math.exp(-f.dt * 4);

    for (let i = 0; i < 3; i++) this.rgb[i] = lerp(this.rgb[i], look.rgb[i], ease);
    this.spin = lerp(this.spin, look.spin, ease);
    this.energy = lerp(this.energy, look.energy, ease);
    this.think = lerp(this.think, f.mode === 'thinking' ? 1 : 0, ease);
    this.clock += dt;
    this.level = lerp(this.level, this.targetLevel(f), 1 - Math.exp(-f.dt * 14));
    this.boot = f.reduceMotion ? 1 : Math.min(1, this.boot + f.dt / 2.6);

    this.rotA += dt * 0.18 * this.spin;
    this.rotB -= dt * 0.11 * this.spin;
    this.rotC += dt * 0.45 * this.spin;
    this.rotSphere += dt * 0.22 * (0.6 + this.spin * 0.4);
  }

  private targetLevel(f: FrameInput): number {
    const t = this.clock;
    if (f.mode === 'speaking') return 0.3 + 0.5 * Math.abs(Math.sin(t * 7.3) * Math.sin(t * 2.9 + 1));
    if (f.mode === 'listening') return Math.max(f.level, 0.08);
    return 0;
  }

  /** Staggered boot progress for layer `i` (0..1, eased). */
  private stage(i: number): number {
    return easeOut((this.boot - i * 0.1) / 0.55);
  }

  private color(alpha: number): string {
    const [r, g, b] = this.rgb;
    return `rgba(${r | 0},${g | 0},${b | 0},${alpha})`;
  }

  private drawBloom(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number): void {
    const p = this.stage(0);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.7);
    g.addColorStop(0, this.color((0.16 + this.level * 0.22) * p));
    g.addColorStop(0.45, this.color(0.05 * p));
    g.addColorStop(1, this.color(0));
    ctx.fillStyle = g;
    ctx.fillRect(cx - R * 1.8, cy - R * 1.8, R * 3.6, R * 3.6);
  }

  private drawSphere(ctx: CanvasRenderingContext2D, cx: number, cy: number, Rs: number): void {
    const p = this.stage(1);
    if (p <= 0) return;
    const { xyz, seed } = this.cloud;
    const t = this.clock;
    const cosY = Math.cos(this.rotSphere);
    const sinY = Math.sin(this.rotSphere);
    const tilt = 0.38;
    const cosT = Math.cos(tilt);
    const sinT = Math.sin(tilt);
    const amp = 0.015 + this.level * 0.16 + this.energy * 0.02;
    const rippleSpeed = 2 + this.energy * 5;
    const grow = 1 + this.level * 0.5;

    // Latitude wireframe for structure.
    ctx.lineWidth = 1;
    ctx.strokeStyle = this.color(0.11 * p);
    for (const lat of [-0.66, -0.33, 0, 0.33, 0.66]) {
      const r = Math.sqrt(1 - lat * lat);
      ctx.beginPath();
      for (let k = 0; k <= 48; k++) {
        const a = (k / 48) * TAU;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        const y1 = lat * cosT - z * sinT;
        const z2 = lat * sinT + z * cosT;
        const s = DEPTH / (DEPTH - z2);
        const px = cx + x * Rs * s * p;
        const py = cy + y1 * Rs * s * p;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    ctx.fillStyle = this.color(1);
    for (let i = 0; i < POINTS; i++) {
      const x = xyz[i * 3];
      const y = xyz[i * 3 + 1];
      const z = xyz[i * 3 + 2];
      const x1 = x * cosY + z * sinY;
      const z1 = -x * sinY + z * cosY;
      const y1 = y * cosT - z1 * sinT;
      const z2 = y * sinT + z1 * cosT;

      const wave = Math.sin(y * 7 - t * rippleSpeed + seed[i] * 0.8);
      const disp = 1 + amp * wave * (0.5 + seed[i] * 0.5);
      const s = (DEPTH / (DEPTH - z2)) * disp * p;
      const depth = (z2 + 1) / 2;
      const size = (0.7 + 1.5 * depth) * grow;

      ctx.globalAlpha = (0.12 + 0.88 * depth * depth) * p;
      ctx.fillRect(cx + x1 * Rs * s - size / 2, cy + y1 * Rs * s - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }

  private drawSweep(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number): void {
    const p = this.stage(2);
    if (p <= 0) return;
    const edge = this.rotC;
    const g = ctx.createConicGradient(edge - 0.16 * TAU, cx, cy);
    g.addColorStop(0, this.color(0));
    g.addColorStop(0.16, this.color(0.2 * p));
    g.addColorStop(0.1601, this.color(0));
    g.addColorStop(1, this.color(0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.98, 0, TAU);
    ctx.fill();

    ctx.strokeStyle = this.color(0.55 * p);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(edge) * R * 0.7, cy + Math.sin(edge) * R * 0.7);
    ctx.lineTo(cx + Math.cos(edge) * R * 0.98, cy + Math.sin(edge) * R * 0.98);
    ctx.stroke();
  }

  private drawCore(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number): void {
    const p = this.stage(0);
    const r = R * (0.13 + this.level * 0.07) * p;
    if (r <= 0) return;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 2.4);
    g.addColorStop(0, `rgba(255,255,255,${0.95 * p})`);
    g.addColorStop(0.25, this.color(0.55 * p));
    g.addColorStop(1, this.color(0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 2.4, 0, TAU);
    ctx.fill();
  }

  private drawBars(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number): void {
    const p = this.stage(2);
    if (p <= 0) return;
    const r0 = R * 0.7;
    const t = this.clock;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = this.color(0.85 * p);
    ctx.beginPath();
    for (let i = 0; i < BARS; i++) {
      const a = (i / BARS) * TAU - Math.PI / 2 + this.rotB * 0.3;
      const n = 0.5 + 0.5 * Math.sin(i * 1.7 + t * 6) * Math.sin(i * 0.41 - t * 2.3);
      const len = R * (0.012 + 0.11 * clamp01(this.level * (0.35 + 0.65 * n) + 0.03 * n)) * p;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      ctx.moveTo(cx + cos * r0, cy + sin * r0);
      ctx.lineTo(cx + cos * (r0 + len), cy + sin * (r0 + len));
    }
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  private drawTicks(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number): void {
    const p = this.stage(3);
    if (p <= 0) return;
    const r = R * 0.88;
    const base = this.rotA + (1 - p) * 2.5;

    ctx.lineWidth = 1;
    ctx.strokeStyle = this.color(0.35 * p);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.stroke();

    ctx.strokeStyle = this.color(0.6 * p);
    ctx.beginPath();
    for (let i = 0; i < TICKS; i++) {
      const a = (i / TICKS) * TAU + base;
      const len = R * (i % 15 === 0 ? 0.06 : i % 5 === 0 ? 0.035 : 0.018);
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      ctx.moveTo(cx + cos * r, cy + sin * r);
      ctx.lineTo(cx + cos * (r - len), cy + sin * (r - len));
    }
    ctx.stroke();
  }

  private drawArcs(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number): void {
    const p = this.stage(4);
    if (p <= 0) return;
    const rot = this.rotB - (1 - p) * 3;
    const passes = [
      { width: 9, alpha: 0.1 },
      { width: 3, alpha: 0.75 },
    ];
    for (const pass of passes) {
      ctx.lineWidth = pass.width;
      ctx.strokeStyle = this.color(pass.alpha * p);
      for (const [start, len] of ARCS) {
        ctx.beginPath();
        ctx.arc(cx, cy, R, rot + start, rot + start + len);
        ctx.stroke();
      }
    }
  }

  private drawOuter(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number): void {
    const p = this.stage(5);
    if (p <= 0) return;
    const r = R * 1.14;

    ctx.lineWidth = 1;
    ctx.strokeStyle = this.color(0.5 * p);
    ctx.setLineDash([2, 7]);
    ctx.lineDashOffset = -this.rotA * r;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);

    // Fixed cardinal markers pointing inward.
    const m = R * 0.035;
    ctx.fillStyle = this.color(0.8 * p);
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2 - Math.PI / 2;
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(cx + ux * (r + m * 0.4), cy + uy * (r + m * 0.4));
      ctx.lineTo(cx + ux * (r - m) - uy * m * 0.7, cy + uy * (r - m) + ux * m * 0.7);
      ctx.lineTo(cx + ux * (r - m) + uy * m * 0.7, cy + uy * (r - m) - ux * m * 0.7);
      ctx.closePath();
      ctx.fill();
    }

    if (this.think < 0.01) return;
    // Orbiting comets while processing.
    for (let k = 0; k < 3; k++) {
      const head = this.rotC * 1.7 + (k * TAU) / 3;
      for (let s = 0; s < 7; s++) {
        ctx.strokeStyle = this.color(0.7 * this.think * (1 - s / 7));
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r, head - (s + 1) * 0.07, head - s * 0.07);
        ctx.stroke();
      }
      const hx = cx + Math.cos(head) * r;
      const hy = cy + Math.sin(head) * r;
      ctx.fillStyle = this.color(0.22 * this.think);
      ctx.beginPath();
      ctx.arc(hx, hy, 9, 0, TAU);
      ctx.fill();
      ctx.fillStyle = this.color(this.think);
      ctx.beginPath();
      ctx.arc(hx, hy, 3, 0, TAU);
      ctx.fill();
    }
  }

  private drawLabels(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number): void {
    const p = this.stage(5);
    if (p <= 0) return;
    const r = R * 1.26;
    ctx.font = `${Math.max(9, R * 0.036)}px "Share Tech Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = this.color(0.42 * p);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU - this.rotA * 0.6;
      ctx.save();
      ctx.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      ctx.rotate(a + Math.PI / 2);
      ctx.fillText(String(i * 30).padStart(3, '0'), 0, 0);
      ctx.restore();
    }
  }

  /** Particles streaming between the outer ring and the core. */
  private drawStreams(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number): void {
    const p = this.stage(2);
    if (p <= 0) return;
    const speed = 0.12 + this.energy * 0.35 + this.think * 0.4;
    const dir = this.think > 0.5 ? -1 : 1;
    ctx.fillStyle = this.color(1);
    for (let i = 0; i < STREAMS; i++) {
      const a = i * 2.399963 + this.rotA * 0.5;
      const f = (((i * 0.6180339 + this.clock * speed * dir) % 1) + 1) % 1;
      const r = R * (1.18 - f * 0.5);
      const edge = Math.sin(f * Math.PI);
      ctx.globalAlpha = 0.4 * edge * p;
      const s = 1 + edge * 1.4;
      ctx.fillRect(cx + Math.cos(a) * r - s / 2, cy + Math.sin(a) * r - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
  }

  /** Counter-rotating hexagon with vertex nodes. */
  private drawHex(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number): void {
    const p = this.stage(3);
    if (p <= 0) return;
    for (const [k, rot, alpha] of [[0.6, -this.rotA * 1.4, 0.35]] as const) {
      const r = R * k * p;
      ctx.lineWidth = 1;
      ctx.strokeStyle = this.color(alpha * p);
      ctx.beginPath();
      for (let i = 0; i <= 6; i++) {
        const a = rot + (i / 6) * TAU;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = this.color(0.9 * p);
      for (let i = 0; i < 6; i++) {
        const a = rot + (i / 6) * TAU;
        ctx.fillRect(cx + Math.cos(a) * r - 1.5, cy + Math.sin(a) * r - 1.5, 3, 3);
      }
    }
  }
}
