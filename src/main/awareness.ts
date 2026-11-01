import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { getAwarenessEnabled } from './settings';
import type { Tool } from './toolTypes';

/**
 * Persistent screen awareness. One tiny PowerShell loop reports the foreground app, its window title and idle time.
 * No model calls and no screenshots. Everything lives in memory only (never written to disk) and is cleared when
 * awareness is turned off. Sensitive windows (banking, password managers, private browsing) are masked.
 */
const POLL_MS = 1500;
const MIN_DWELL_MS = 5_000; // shorter visits are alt-tab noise
const MAX_AGE_MS = 30 * 60_000;
const MAX_VISITS = 60;
const TITLE_MAX = 90;
const AWAY_MS = 60_000;
const SENSITIVE = /keepass|bitwarden|1password|lastpass|dashlane|password|bank|paypal|wallet|netbanking|credit card|incognito|inprivate|private browsing/i;

interface Visit {
  app: string;
  title: string;
  start: number;
  end: number;
}

const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class FG {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [StructLayout(LayoutKind.Sequential)] struct LII { public uint cb; public uint t; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LII i);
  public static string Now() {
    IntPtr h = GetForegroundWindow(); var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
    uint pid; GetWindowThreadProcessId(h, out pid);
    var i = new LII(); i.cb = (uint)Marshal.SizeOf(i); GetLastInputInfo(ref i);
    return pid + "\\t" + sb.ToString().Replace("\\t", " ").Replace("\\r", " ").Replace("\\n", " ") + "\\t" + ((uint)Environment.TickCount - i.t);
  }
}
'@
[Console]::OutputEncoding = [Text.Encoding]::UTF8
while ($true) {
  $parts = [FG]::Now().Split("\`t")
  $name = (Get-Process -Id ([int]$parts[0])).ProcessName
  Write-Output ($name + "\`t" + $parts[1] + "\`t" + $parts[2])
  Start-Sleep -Milliseconds ${POLL_MS}
}
`;

let proc: ChildProcessWithoutNullStreams | null = null;
let buf = '';
let current: Visit | null = null;
let timeline: Visit[] = [];
let idleMs = 0;
let restartTimer: ReturnType<typeof setTimeout> | undefined;
let wanted = false;

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const span = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
};

function normalise(app: string, title: string): { app: string; title: string } {
  if (SENSITIVE.test(app) || SENSITIVE.test(title)) return { app: SENSITIVE.test(app) ? 'private app' : app, title: '' };
  if (/^jarvis$/i.test(title.trim())) return { app: 'JARVIS', title: '' };
  return { app, title: title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX)}…` : title };
}

function close(v: Visit, now: number): void {
  v.end = now;
  if (v.end - v.start < MIN_DWELL_MS) return;
  timeline.push(v);
  const cutoff = now - MAX_AGE_MS;
  timeline = timeline.filter((x) => x.end >= cutoff).slice(-MAX_VISITS);
}

function onLine(line: string): void {
  const parts = line.replace(/\r$/, '').split('\t');
  if (parts.length < 3) return;
  const idle = Number(parts[parts.length - 1]);
  const { app, title } = normalise(parts[0], parts.slice(1, -1).join(' ').trim());
  const now = Date.now();
  idleMs = Number.isFinite(idle) ? idle : 0;
  if (current && current.app === app && current.title === title) return;
  if (current) close(current, now);
  current = { app, title, start: now, end: now };
}

function onData(chunk: string): void {
  buf += chunk;
  let i: number;
  while ((i = buf.indexOf('\n')) >= 0) {
    onLine(buf.slice(0, i));
    buf = buf.slice(i + 1);
  }
}

function launch(): void {
  if (proc || process.platform !== 'win32') return;
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
  proc = p;
  buf = '';
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', onData);
  p.stderr.on('data', () => undefined);
  const gone = () => {
    if (proc !== p) return;
    proc = null;
    if (wanted) restartTimer = setTimeout(launch, 5000);
  };
  p.on('exit', gone);
  p.on('error', gone);
}

function halt(): void {
  wanted = false;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = undefined;
  proc?.kill();
  proc = null;
  current = null;
  timeline = [];
  idleMs = 0;
}

/** Start or stop the watcher to match the saved setting (default: on). */
export async function syncAwareness(): Promise<void> {
  if (await getAwarenessEnabled()) {
    wanted = true;
    launch();
  } else halt();
}

export const stopAwareness = halt;
export const awarenessActive = (): boolean => proc !== null;

/** Injected into every request. Cheap: reads counters already in memory. */
export function getAwarenessPrompt(): string {
  if (!proc || !current) return '';
  const now = Date.now();
  const lines = [
    'SCREEN CONTEXT (background only: use it to resolve words like "this", "here", "that error" and to stay relevant; never recite it, and never comment on what they are doing unless asked):',
    `Active now: ${current.app}${current.title ? ` - "${current.title}"` : ''}, for ${span(now - current.start)}.${idleMs > AWAY_MS ? ` Away from the keyboard for ${span(idleMs)}.` : ''}`,
  ];
  const seen = new Map<string, number>();
  for (const v of timeline.filter((x) => now - x.end < 15 * 60_000)) seen.set(v.app, (seen.get(v.app) ?? 0) + (v.end - v.start));
  const earlier = [...seen].filter(([a]) => a !== current!.app).sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (earlier.length) lines.push(`Earlier (last 15 min): ${earlier.map(([a, ms]) => `${a} ${span(ms)}`).join(', ')}.`);
  lines.push('The title is only a hint of what is on screen. If you need to actually see it, call see_screen.');
  return lines.join('\n');
}

export const awarenessTools: Record<string, Tool> = {
  recent_activity: {
    description:
      'What the user has been doing on this computer in the last 30 minutes: apps and window titles in order, with times. Use for "what was I just doing", "go back to what I was working on", "which file was I in". Does not capture screen content; use see_screen for that.',
    parameters: { type: 'object', properties: {} },
    run: () => {
      if (!proc) return 'Screen awareness is off or unavailable (Windows only). It can be turned on in Settings.';
      const rows = [...timeline, ...(current ? [{ ...current, end: Date.now() }] : [])];
      if (!rows.length) return 'No activity recorded yet.';
      return rows.map((v) => `${clock(v.start)} ${v.app}${v.title ? ` - ${v.title}` : ''} (${span(v.end - v.start)})`).join('\n');
    },
  },
};
