import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import { promisify } from 'util';
import { jobSummary } from './agi';
import { hudVisible, sendToHud } from './hud';
import type { Tool } from './toolTypes';

const run = promisify(execFile);
const TICK_MS = 2000;
const PROC_EVERY = 3; // process list every 3rd tick (6 s)
const HIST = 40;

export interface HudAlert { id: string; level: 'warn' | 'crit'; text: string }
export interface Telemetry {
  t: number;
  cpu: number;
  cpuHist: number[];
  ram: { used: number; total: number; pct: number };
  ramHist: number[];
  net: { down: number; up: number; downHist: number[]; upHist: number[]; iface: string; ip: string };
  procs: Array<{ name: string; mb: number; n: number }>;
  jobs: string[];
  alerts: HudAlert[];
  uptime: number;
}

const push = (a: number[], v: number): number[] => [...a, v].slice(-HIST);
let last = os.cpus();
function cpuPct(): number {
  const now = os.cpus();
  let idle = 0;
  let total = 0;
  now.forEach((c, i) => {
    const p = last[i];
    if (!p) return;
    const ti = c.times.idle - p.times.idle;
    idle += ti;
    total += c.times.user - p.times.user + (c.times.nice - p.times.nice) + (c.times.sys - p.times.sys) + (c.times.irq - p.times.irq) + ti;
  });
  last = now;
  return total ? Math.round(100 * (1 - idle / total)) : 0;
}

async function netBytes(): Promise<{ rx: number; tx: number } | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run('netstat', ['-e'], { windowsHide: true, timeout: 3000 });
      for (const line of stdout.split(/\r?\n/)) {
        const m = line.match(/(\d[\d.,]*)\s+(\d[\d.,]*)\s*$/); // first numeric row is "Bytes  received  sent", whatever the locale
        if (m) return { rx: Number(m[1].replace(/[.,]/g, '')), tx: Number(m[2].replace(/[.,]/g, '')) };
      }
      return null;
    }
    let rx = 0;
    let tx = 0;
    for (const line of (await fs.readFile('/proc/net/dev', 'utf8')).split('\n').slice(2)) {
      const [name, rest] = line.split(':');
      if (!rest || name.trim() === 'lo') continue;
      const c = rest.trim().split(/\s+/).map(Number);
      rx += c[0] || 0;
      tx += c[8] || 0;
    }
    return { rx, tx };
  } catch {
    return null;
  }
}

function iface(): { iface: string; ip: string } {
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    const a = list?.find((x) => x.family === 'IPv4' && !x.internal);
    if (a) return { iface: name, ip: a.address };
  }
  return { iface: 'none', ip: '' };
}

async function topProcs(): Promise<Telemetry['procs']> {
  try {
    const groups = new Map<string, { kb: number; n: number }>();
    if (process.platform === 'win32') {
      const { stdout } = await run('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 5000 });
      for (const line of stdout.split(/\r?\n/)) {
        const c = line.replace(/^"|"$/g, '').split('","');
        if (c.length < 5) continue;
        const g = groups.get(c[0]) ?? { kb: 0, n: 0 };
        g.kb += parseInt(c[4].replace(/[^\d]/g, ''), 10) || 0;
        g.n++;
        groups.set(c[0], g);
      }
    } else {
      const { stdout } = await run('ps', ['-eo', 'comm=,rss='], { maxBuffer: 4 * 1024 * 1024, timeout: 5000 });
      for (const line of stdout.split('\n')) {
        const m = line.trim().match(/^(.+?)\s+(\d+)$/);
        if (!m) continue;
        const g = groups.get(m[1]) ?? { kb: 0, n: 0 };
        g.kb += Number(m[2]);
        g.n++;
        groups.set(m[1], g);
      }
    }
    return [...groups.entries()].sort((a, b) => b[1].kb - a[1].kb).slice(0, 6).map(([name, g]) => ({ name, mb: Math.round(g.kb / 1024), n: g.n }));
  } catch {
    return [];
  }
}

/** An alert fires only after it has held for N samples and clears only when it stops, so values hovering at a threshold do not flicker. */
const streak = new Map<string, number>();
const hold = (id: string, on: boolean, need: number): boolean => {
  const n = on ? (streak.get(id) ?? 0) + 1 : 0;
  streak.set(id, n);
  return n >= need;
};

function alerts(cpu: number, ramPct: number, procs: Telemetry['procs']): HudAlert[] {
  const out: HudAlert[] = [];
  if (hold('cpu', cpu >= 90, 5)) out.push({ id: 'cpu', level: 'warn', text: `CPU at ${cpu}% for 10 seconds` });
  if (hold('ram', ramPct >= 92, 3)) out.push({ id: 'ram', level: 'crit', text: `Memory ${ramPct}% full` });
  else if (hold('ram-w', ramPct >= 85, 3)) out.push({ id: 'ram', level: 'warn', text: `Memory ${ramPct}% full` });
  const hog = procs[0];
  if (hold('hog', !!hog && hog.mb >= 3000, 2)) out.push({ id: 'hog', level: 'warn', text: `${hog.name} is using ${(hog.mb / 1024).toFixed(1)} GB` });
  return out;
}

let timer: NodeJS.Timeout | null = null;
let busy = false;
let tick = 0;
let snap: Telemetry | null = null;
let prevNet: { rx: number; tx: number; t: number } | null = null;
let cpuHist: number[] = [];
let ramHist: number[] = [];
let downHist: number[] = [];
let upHist: number[] = [];
let procs: Telemetry['procs'] = [];

async function sample(): Promise<void> {
  if (busy || !hudVisible()) return;
  busy = true;
  try {
    const now = Date.now();
    const cpu = cpuPct();
    const total = os.totalmem();
    const used = total - os.freemem();
    const pct = Math.round((used / total) * 100);
    const nb = await netBytes();
    let down = 0;
    let up = 0;
    if (nb && prevNet && now > prevNet.t) {
      const s = (now - prevNet.t) / 1000;
      down = Math.max(0, (nb.rx - prevNet.rx) / s);
      up = Math.max(0, (nb.tx - prevNet.tx) / s);
    }
    if (nb) prevNet = { ...nb, t: now };
    if (tick++ % PROC_EVERY === 0) procs = await topProcs();
    cpuHist = push(cpuHist, cpu);
    ramHist = push(ramHist, pct);
    downHist = push(downHist, Math.round(down));
    upHist = push(upHist, Math.round(up));
    snap = {
      t: now,
      cpu,
      cpuHist,
      ram: { used, total, pct },
      ramHist,
      net: { down, up, downHist, upHist, ...iface() },
      procs,
      jobs: jobSummary(),
      alerts: alerts(cpu, pct, procs),
      uptime: os.uptime(),
    };
    sendToHud('telemetry', snap);
  } finally {
    busy = false;
  }
}

export const latestTelemetry = (): Telemetry | null => snap;
export function startTelemetry(): void {
  if (timer) return;
  timer = setInterval(() => void sample(), TICK_MS);
  void sample();
}
export function stopTelemetry(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

const rate = (b: number): string => (b < 1024 ? `${Math.round(b)} B/s` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB/s` : `${(b / 1048576).toFixed(1)} MB/s`);

export const telemetryTools: Record<string, Tool> = {
  hud_status: {
    description: 'Live system status from the HUD panels: CPU, memory, network speed, biggest running programs, JARVIS background jobs and active alerts. Use for "how is my computer doing", "why is it slow", "any alerts".',
    parameters: { type: 'object', properties: {} },
    run: () => {
      if (!snap) return 'NOT DONE: no telemetry yet. The HUD must be open and visible.';
      const s = snap;
      return [
        `CPU ${s.cpu}% | Memory ${s.ram.pct}% (${(s.ram.used / 1073741824).toFixed(1)} of ${(s.ram.total / 1073741824).toFixed(1)} GB) | Network down ${rate(s.net.down)}, up ${rate(s.net.up)} (${s.net.iface} ${s.net.ip})`,
        `Top programs: ${s.procs.map((p) => `${p.name} ${p.mb} MB${p.n > 1 ? ` x${p.n}` : ''}`).join(', ') || 'unknown'}`,
        `JARVIS jobs: ${s.jobs.join('; ') || 'none'}`,
        `Alerts: ${s.alerts.map((a) => `${a.level.toUpperCase()} ${a.text}`).join('; ') || 'none'} (battery and connection alerts show on the HUD itself)`,
      ].join('\n');
    },
  },
};
