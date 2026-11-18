import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { acquireExecutionSlot, executionSchedulerSnapshot, resetExecutionSchedulerForTests, QueueTimeoutError, type ExecutionResource } from './ExecutionScheduler';
import { setToolExecutionMetrics } from '../toolResult';

export type ProcessResource = ExecutionResource;
export type ProcessStatus = 'success' | 'failed' | 'timed_out' | 'queue_timed_out' | 'cancelled' | 'launch_failed';

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
  queueTimeoutMs?: number;
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

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

const killProcessTree = (child: ChildProcess, onCleanup: () => void): ReturnType<typeof setTimeout> | undefined => {
  const pid = child.pid;
  if (!pid) {
    child.kill();
    onCleanup();
    return undefined;
  }
  if (process.platform === 'win32') {
    // taskkill /T closes descendants as well as the PowerShell wrapper. Keep the scheduler
    // slot until taskkill has finished so descendants are not competing with the next job.
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }, () => onCleanup());
    child.kill();
    return undefined;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const hardKill = setTimeout(() => {
    // The group may outlive its parent. Check it after the grace period and kill any
    // descendants that ignored SIGTERM before releasing the process resource slot.
    try {
      process.kill(-pid, 0);
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* the whole process group exited during the grace period */
    }
    onCleanup();
  }, 800);
  hardKill.unref();
  return hardKill;
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
    ticket = await acquireExecutionSlot(resource, request.signal, request.queueTimeoutMs ?? 60_000);
  } catch (error) {
    const result = error instanceof QueueTimeoutError
      ? { ...emptyResult('queue_timed_out', error.queueWaitMs, error.message), durationMs: 0 }
      : emptyResult('cancelled', 0, error instanceof Error ? error.message : String(error));
    setToolExecutionMetrics({
      queueWaitMs: result.queueWaitMs,
      processMs: 0,
      processStatus: result.status,
      exitCode: result.exitCode,
      pid: result.pid,
    });
    return result;
  }

  const queueWaitMs = ticket.queueWaitMs;
  const requestedTimeout = request.timeoutMs ?? 60_000;
  const timeoutMs = Number.isFinite(requestedTimeout) ? Math.max(250, Math.min(600_000, Math.trunc(requestedTimeout))) : 60_000;
  const requestedMaxOutput = request.maxOutputBytes ?? 2 * 1024 * 1024;
  const maxOutputBytes = Number.isFinite(requestedMaxOutput) ? Math.max(16_384, Math.min(8 * 1024 * 1024, Math.trunc(requestedMaxOutput))) : 2 * 1024 * 1024;
  const startedAt = Date.now();

  try {
    if (request.signal?.aborted) return emptyResult('cancelled', queueWaitMs, 'aborted-before-launch');

    const result = await new Promise<ProcessResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let capturedBytes = 0;
      let outputTruncated = false;
      let killReason: 'timed_out' | 'cancelled' | null = null;
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let hardKillHandle: ReturnType<typeof setTimeout> | undefined;
      let treeCleanupPending = false;
      let closeResultPending: ProcessResult | undefined;
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
        if (hardKillHandle && !treeCleanupPending) clearTimeout(hardKillHandle);
        request.signal?.removeEventListener('abort', onAbort);
        ticket.release();
        resolve(result);
      };

      const onAbort = (): void => {
        if (killReason || settled) return;
        killReason = 'cancelled';
        if (child) {
          treeCleanupPending = true;
          hardKillHandle = killProcessTree(child, () => {
            treeCleanupPending = false;
            if (closeResultPending) finalize(closeResultPending);
          });
        }
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
        const result: ProcessResult = {
          status,
          exitCode: code,
          signal: closeSignal,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          queueWaitMs,
          pid: child.pid,
          outputTruncated,
        };
        if (treeCleanupPending) closeResultPending = result;
        else finalize(result);
      });

      timeoutHandle = setTimeout(() => {
        if (settled || killReason) return;
        killReason = 'timed_out';
        treeCleanupPending = true;
        hardKillHandle = killProcessTree(child, () => {
          treeCleanupPending = false;
          if (closeResultPending) finalize(closeResultPending);
        });
      }, timeoutMs);
      timeoutHandle.unref();

      if (request.signal?.aborted) onAbort();
    });
    setToolExecutionMetrics({
      queueWaitMs: result.queueWaitMs,
      processMs: result.durationMs,
      processStatus: result.status,
      exitCode: result.exitCode,
      pid: result.pid,
    });
    return result;
  } finally {
    // runProcess's Promise finalizer normally releases the ticket. This protects early
    // exceptions before the child close event is wired, without releasing twice.
    ticket.release();
  }
}

export const processSchedulerSnapshot = executionSchedulerSnapshot;
export const resetProcessSchedulerForTests = resetExecutionSchedulerForTests;
