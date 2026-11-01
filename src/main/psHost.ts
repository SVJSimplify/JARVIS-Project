import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

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

function exec(line: string, id: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      timer = null;
      reject(new Error('App control timed out.'));
      reset();
    }, timeoutMs);
    const ok = (s: string): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(s);
    };
    const bad = (e: Error): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      reject(e);
    };
    waiting = { id, resolve: ok, reject: bad };
    // A dead host must fail the call at once, not silently swallow the command until the timeout.
    if (!proc || !proc.stdin.writable) {
      bad(new Error('PowerShell host is not running.'));
      return;
    }
    proc.stdin.write(line, (err) => {
      if (err && timer) bad(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

function start(prelude: string): Promise<void> {
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
  return exec(wrapPrelude(prelude), 0, 60000).then(() => undefined);
}

/** Runs `body` in the shared PowerShell. `env` values are passed as $env:NAME. Calls are queued one at a time. */
export function runPs(prelude: string, body: string, env: Record<string, string>, timeoutMs = 20000): Promise<string> {
  const job = chain.then(async () => {
    if (!proc || !ready) ready = start(prelude);
    try {
      await ready;
    } catch (e) {
      reset();
      throw e;
    }
    const id = ++seq;
    const vars = Object.entries(env)
      .map(([k, v]) => `$env:${k} = ${decode(v)}`)
      .join('\n');
    return exec(wrapCall(`${vars}\n${body}`, id), id, timeoutMs);
  });
  chain = job.catch(() => undefined);
  return job;
}

process.on('exit', () => proc?.kill());
