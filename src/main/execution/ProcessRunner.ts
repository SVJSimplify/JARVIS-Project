import { execFile, spawn, type ChildProcess } from 'node:child_process';

export type ProcessResource = 'command' | 'system' | 'build';
export type ProcessStatus = 'success' | 'failed' | 'timed_out' | 'cancelled' | 'launch_failed';

export interface ProcessResult {
  status: ProcessStatus;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  queueWaitMs: number;
  pid?: number;
  errorCode?: string;
  outputTruncated: boolean;
}

export interface ProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  resource?: ProcessResource;
  signal?: AbortSignal;
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

const GLOBAL_LIMIT = 4;
const RESOURCE_LIMITS: Record<ProcessResource, number> = {
  command: 2,
  system: 2,
  build: 1,
};

interface Waiter {
  resource: ProcessResource;
  signal?: AbortSignal;
  queuedAt: number;
  resolve: (ticket: { queueWaitMs: number; release: () => void }) => void;
  reject: (error: Error) => void;
  onAbort: () => void;
}

let activeTotal = 0;
const activeByResource: Record<ProcessResource, number> = { command: 0, system: 0, build: 0 };
const waiters: Waiter[] = [];

const pump = (): void => {
  while (activeTotal < GLOBAL_LIMIT) {
    const index = waiters.findIndex((w, i) => {
      if (w.signal?.aborted || activeByResource[w.resource] >= RESOURCE_LIMITS[w.resource]) return false;
      // Preserve FIFO ordering inside each resource class while allowing another class
      // to use an otherwise-idle global slot.
      return !waiters.slice(0, i).some((prior) => prior.resource === w.resource);
    });
    if (index < 0) return;
    const [waiter] = waiters.splice(index, 1);
    waiter.signal?.removeEventListener('abort', waiter.onAbort);
    activeTotal++;
    activeByResource[waiter.resource]++;
    let released = false;
    waiter.resolve({
      queueWaitMs: Math.max(0, Date.now() - waiter.queuedAt),
      release: () => {
        if (released) return;
        released = true;
        activeTotal = Math.max(0, activeTotal - 1);
        activeByResource[waiter.resource] = Math.max(0, activeByResource[waiter.resource] - 1);
        pump();
      },
    });
  }
};

const acquire = (resource: ProcessResource, signal?: AbortSignal) =>
  new Promise<{ queueWaitMs: number; release: () => void }>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Interrupted while waiting for a process slot.'));
      return;
    }
    const waiter: Waiter = {
      resource,
      signal,
      queuedAt: Date.now(),
      resolve,
      reject,
      onAbort: () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error('Interrupted while waiting for a process slot.'));
        pump();
      },
    };
    signal?.addEventListener('abort', waiter.onAbort, { once: true });
    waiters.push(waiter);
    pump();
  });

const emptyResult = (status: ProcessStatus, queueWaitMs: number, errorCode?: string): ProcessResult => ({
  status,
  exitCode: null,
  signal: null,
  stdout: '',
  stderr: '',
  durationMs: 0,
  queueWaitMs,
  errorCode,
  outputTruncated: false,
});

const killProcessTree = (child: ChildProcess): void => {
  const pid = child.pid;
  if (!pid) {
    child.kill();
    return;
  }
  if (process.platform === 'win32') {
    // taskkill /T closes descendants as well as the PowerShell wrapper. The callback is
    // intentionally detached from the tool's result path; the process close event settles it.
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }, () => undefined);
    child.kill();
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const hardKill = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }, 800);
  hardKill.unref();
};

/**
 * Shared process boundary for JINI. Queue wait is outside the execution deadline;
 * execution time starts only after a scheduler slot is granted. Every caller receives
 * an explicit outcome instead of interpreting child_process error strings as output.
 */
export async function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  const resource = request.resource ?? 'command';
  let ticket: { queueWaitMs: number; release: () => void };
  try {
    ticket = await acquire(resource, request.signal);
  } catch (error) {
    return emptyResult('cancelled', 0, error instanceof Error ? error.message : String(error));
  }

  const queueWaitMs = ticket.queueWaitMs;
  const timeoutMs = Math.max(250, Math.min(600_000, Math.trunc(request.timeoutMs ?? 60_000)));
  const maxOutputBytes = Math.max(16_384, Math.min(8 * 1024 * 1024, Math.trunc(request.maxOutputBytes ?? 2 * 1024 * 1024)));
  const startedAt = Date.now();

  try {
    if (request.signal?.aborted) return emptyResult('cancelled', queueWaitMs, 'aborted-before-launch');

    return await new Promise<ProcessResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let capturedBytes = 0;
      let outputTruncated = false;
      let killReason: 'timed_out' | 'cancelled' | null = null;
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let child: ChildProcess;

      const append = (stream: 'stdout' | 'stderr', chunk: Buffer | string): void => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = maxOutputBytes - capturedBytes;
        if (remaining <= 0) {
          outputTruncated = true;
          return;
        }
        const kept = value.length > remaining ? value.subarray(0, remaining) : value;
        const text = kept.toString('utf8');
        if (stream === 'stdout') stdout += text;
        else stderr += text;
        capturedBytes += kept.length;
        if (kept.length !== value.length) outputTruncated = true;
        try {
          request.onOutput?.(stream, text);
        } catch {
          /* Observability must never break the process. */
        }
      };

      const finalize = (result: ProcessResult): void => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        request.signal?.removeEventListener('abort', onAbort);
        ticket.release();
        resolve(result);
      };

      const onAbort = (): void => {
        if (killReason || settled) return;
        killReason = 'cancelled';
        if (child) killProcessTree(child);
      };

      try {
        child = spawn(request.executable, request.args, {
          cwd: request.cwd,
          env: { ...process.env, ...request.env },
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        finalize({
          ...emptyResult('launch_failed', queueWaitMs),
          durationMs: Date.now() - startedAt,
          errorCode: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      request.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
      child.once('error', (error: NodeJS.ErrnoException) => {
        finalize({
          status: 'launch_failed',
          exitCode: null,
          signal: null,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          queueWaitMs,
          pid: child.pid,
          errorCode: error.code ?? error.message,
          outputTruncated,
        });
      });
      child.once('close', (code, closeSignal) => {
        const status: ProcessStatus = killReason ?? (code === 0 ? 'success' : 'failed');
        finalize({
          status,
          exitCode: code,
          signal: closeSignal,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          queueWaitMs,
          pid: child.pid,
          outputTruncated,
        });
      });

      timeoutHandle = setTimeout(() => {
        if (settled || killReason) return;
        killReason = 'timed_out';
        killProcessTree(child);
      }, timeoutMs);
      timeoutHandle.unref();

      if (request.signal?.aborted) onAbort();
    });
  } finally {
    // runProcess's Promise finalizer normally releases the ticket. This protects early
    // exceptions before the child close event is wired, without releasing twice.
    ticket.release();
  }
}

export const processSchedulerSnapshot = () => ({
  active: activeTotal,
  queued: waiters.length,
  byResource: { ...activeByResource },
  queuedByResource: {
    command: waiters.filter((w) => w.resource === 'command').length,
    system: waiters.filter((w) => w.resource === 'system').length,
    build: waiters.filter((w) => w.resource === 'build').length,
  },
});

export const resetProcessSchedulerForTests = (): void => {
  // Tests may reset only while no process is active; active releases remain authoritative.
  waiters.splice(0, waiters.length);
};
