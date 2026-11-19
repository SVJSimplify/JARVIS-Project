import { execFile } from 'child_process';

export interface ProcessRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBufferBytes?: number;
  signal?: AbortSignal;
  windowsHide?: boolean;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export class ProcessRunError extends Error {
  readonly kind: 'launch' | 'timeout' | 'cancelled' | 'output-limit';
  readonly executable: string;
  constructor(kind: ProcessRunError['kind'], executable: string, message: string) {
    super(message);
    this.name = 'ProcessRunError';
    this.kind = kind;
    this.executable = executable;
  }
}

export class ProcessExitError extends Error {
  readonly result: ProcessResult;
  constructor(executable: string, result: ProcessResult) {
    super(`${executable} exited with code ${result.exitCode}.${result.stderr.trim() ? `\\n${result.stderr.trim()}` : ''}`);
    this.name = 'ProcessExitError';
    this.result = result;
  }
}

/**
 * One subprocess boundary for JINI.
 *
 * - argv is always passed as an array; this module never enables shell parsing.
 * - timeouts, caller cancellation and output bounds are explicit.
 * - non-zero exits are returned as structured outcomes, not silently converted to success.
 * - callers that require success use runProcessChecked.
 *
 * Shell interpretation, when intentionally required, must be explicit in the executable
 * and arguments supplied by the caller (for example powershell.exe -Command ...).
 */
export function runProcess(
  executable: string,
  args: string[],
  options: ProcessRunOptions = {}
): Promise<ProcessResult> {
  const started = Date.now();
  if (options.signal?.aborted) {
    return Promise.reject(new ProcessRunError('cancelled', executable, `${executable} was cancelled before it started.`));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      // execFile wires AbortSignal to child termination; this listener only ensures the
      // caller receives the stable JINI cancellation error rather than a Node-specific one.
    };
    const child = execFile(
      executable,
      args,
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        timeout: Math.max(0, options.timeoutMs ?? 120_000),
        maxBuffer: Math.max(1024, options.maxBufferBytes ?? 8 * 1024 * 1024),
        windowsHide: options.windowsHide ?? true,
        signal: options.signal,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const result: ProcessResult = {
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          exitCode: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
          durationMs: Date.now() - started,
        };
        finish(() => {
          if (options.signal?.aborted || (error as NodeJS.ErrnoException | null)?.name === 'AbortError') {
            reject(new ProcessRunError('cancelled', executable, `${executable} was cancelled.`));
            return;
          }
          const code = (error as NodeJS.ErrnoException & { code?: string | number; killed?: boolean } | null)?.code;
          if (error && (code === 'ETIMEDOUT' || (error as { killed?: boolean }).killed)) {
            reject(new ProcessRunError('timeout', executable, `${executable} exceeded its ${options.timeoutMs ?? 120_000}ms timeout.`));
            return;
          }
          if (error && code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            reject(new ProcessRunError('output-limit', executable, `${executable} exceeded the ${options.maxBufferBytes ?? 8 * 1024 * 1024} byte output limit.`));
            return;
          }
          if (error && typeof code !== 'number') {
            reject(new ProcessRunError('launch', executable, `Could not launch ${executable}: ${error.message}`));
            return;
          }
          resolve(result);
        });
      }
    );
    void child;
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runProcessChecked(
  executable: string,
  args: string[],
  options: ProcessRunOptions = {}
): Promise<ProcessResult> {
  const result = await runProcess(executable, args, options);
  if (result.exitCode !== 0) throw new ProcessExitError(executable, result);
  return result;
}
