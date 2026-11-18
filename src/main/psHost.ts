import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { acquireExecutionSlot } from './execution/ExecutionScheduler';

/**
 * One long-lived PowerShell process. The old code started powershell.exe and recompiled the
 * C# helper for every single action (roughly a second each); here that cost is paid once.
 */
const DONE = '__JDONE__';
const ERR = '__JERR__';

let proc: ChildProcessWithoutNullStreams | null = null;
let ready: Promise<void> | null = null;
let buf = '';
let waiting: { id: number; resolve: (s: string) => void; reject: (e: Error) => void } | null = null;
let chain: Promise<unknown> = Promise.resolve();
let seq = 0;

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const decode = (s: string) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(s)}'))`;

const wrapCall = (script: string, id: number) =>
  `& { try { $r = (& ([scriptblock]::Create(${decode(script)})) | Out-String); Write-Output $r } catch { Write-Output ('${ERR}' + $_.Exception.Message) }; Write-Output '${DONE}${id}' }\n`;
const wrapPrelude = (script: string) =>
  `try { . ([scriptblock]::Create(${decode(script)})) } catch { Write-Output ('${ERR}' + $_.Exception.Message) }; Write-Output '${DONE}0'\n`;

function onData(chunk: string): void {
  buf += chunk;
  if (!waiting) {
    buf = '';
    return;
  }
  const mark = `${DONE}${waiting.id}`;
  const i = buf.indexOf(mark);
  if (i < 0) return;
  const out = buf.slice(0, i).trim();
  buf = buf.slice(i + mark.length);
  const w = waiting;
  waiting = null;
  if (out.startsWith(ERR)) w.reject(new Error(out.slice(ERR.length).split('\n').find((l) => l.trim())?.trim() ?? 'App control failed.'));
  else w.resolve(out);
}

function reset(): void {
  waiting = null;
  buf = '';
  proc?.kill();
  proc = null;
  ready = null;
}

function exec(line: string, id: number, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (fn: (value: any) => void, value: any): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const ok = (value: string): void => finish(resolve, value);
    const bad = (error: Error): void => finish(reject, error);
    const onAbort = (): void => {
      if (settled) return;
      bad(new Error('PowerShell operation cancelled.'));
      // The host is stateful. A cancelled command may still be executing, so discard the
      // session rather than risk mixing its late output with the next request.
      reset();
    };
    if (signal?.aborted) {
      bad(new Error('PowerShell operation cancelled before dispatch.'));
      return;
    }
    timer = setTimeout(() => {
      bad(new Error('App control timed out.'));
      reset();
    }, timeoutMs);
    timer.unref?.();
    waiting = { id, resolve: ok, reject: bad };
    if (!proc || !proc.stdin.writable) {
      bad(new Error('PowerShell host is not running.'));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.stdin.write(line, (err) => {
      if (err && !settled) bad(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

function start(prelude: string, signal?: AbortSignal): Promise<void> {
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
    windowsHide: true,
  });
  proc = p;
  buf = '';
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', onData);
  p.stderr.on('data', () => undefined); // failures are caught inside the scripts
  // A child that dies mid-write emits EPIPE on stdin; the exit/error handlers reject any waiting caller.
  p.stdin.on('error', () => undefined);
  p.on('exit', () => {
    if (proc !== p) return;
    const w = waiting;
    proc = null;
    ready = null;
    waiting = null;
    w?.reject(new Error('PowerShell host exited.'));
  });
  p.on('error', (e) => {
    if (proc !== p) return;
    const w = waiting;
    proc = null;
    ready = null;
    waiting = null;
    w?.reject(e);
  });
  p.stdin.write('[Console]::OutputEncoding = [Text.Encoding]::UTF8\n');
  return exec(wrapPrelude(prelude), 0, 60000, signal).then(() => undefined);
}

/** Runs `body` in the shared PowerShell. Commands are serialized by the shared execution scheduler. */
export function runPs(prelude: string, body: string, env: Record<string, string>, timeoutMs = 20000, signal?: AbortSignal): Promise<string> {
  return (async () => {
    const ticket = await acquireExecutionSlot('persistent_shell', signal, 60_000);
    try {
      if (signal?.aborted) throw new Error('PowerShell operation cancelled before dispatch.');
      if (!proc || !ready) ready = start(prelude, signal);
      try {
        await ready;
      } catch (error) {
        reset();
        throw error;
      }
      if (signal?.aborted) throw new Error('PowerShell operation cancelled before dispatch.');
      const id = ++seq;
      const vars = Object.entries(env)
        .map(([k, v]) => `$env:${k} = ${decode(v)}`)
        .join('\\n');
      return await exec(wrapCall(`${vars}\\n${body}`, id), id, timeoutMs, signal);
    } finally {
      ticket.release();
    }
  })();
}

process.on('exit', () => proc?.kill());
