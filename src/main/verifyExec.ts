import { promises as fs } from 'fs';
import * as path from 'path';
import { shellVerdict } from './policy';
import { recordOutcome, recordStartedStrict } from './toolRecord';
import { loadJson } from './store';
import { FILES_ROOT } from './workspace';
import { executionSignal } from './toolResult';
import { runProcess } from './execution/ProcessRunner';

/**
 * VERIFICATION EXECUTION — the command runner for acceptance checks, extracted from the
 * retired mission engine and now the ONLY out-of-band command executor.
 *
 * It is part of the central policy boundary, not an exception to it: every command is
 * classified by policy.shellVerdict before execution — the same classifier that guards
 * run_command — so a destructive acceptance target is refused here exactly like anywhere
 * else, and every execution (allowed or blocked) lands in the durable tool-record ledger
 * as evidence with agent 'verifier'.
 *
 * History: this runner used to execFile straight from coordinator/verifier with NO policy
 * check — the one command path that bypassed the gate. Closed.
 */

export interface ProjectFacts {
  root: string;
  scripts: string[];
  summary: string;
}

/** Parse the package.json scripts worth running for verification, in priority order (pure). */
export const verifyScripts = (scripts: Record<string, unknown>): string[] =>
  ['typecheck', 'test', 'build'].filter((k) => typeof scripts[k] === 'string');

export async function detectProject(): Promise<ProjectFacts | null> {
  const entries = await fs.readdir(FILES_ROOT, { withFileTypes: true }).catch(() => []);
  // Round 20 (CHANGE 11): only DIRECTORIES are project candidates — the old candidate
  // list probed package.json inside every file too (a JSON store named x.json produced a
  // directory probe and an ENOTDIR warning per scan).
  const candidates: string[] = [FILES_ROOT, ...entries.filter((e) => e.isDirectory()).map((e) => e.name)].slice(0, 41);
  for (const name of candidates) {
    const root = name === FILES_ROOT ? FILES_ROOT : path.join(FILES_ROOT, name);
    const pkg = await loadJson<{ name?: string; scripts?: Record<string, unknown> } | null>(path.join(root, 'package.json'), null);
    if (!pkg) continue;
    const scripts = verifyScripts(pkg.scripts ?? {});
    return {
      root,
      scripts,
      summary: `npm project "${pkg.name ?? '?'}" at ${root}${scripts.length ? `; scripts: ${scripts.join(', ')}` : '; no standard scripts'}`,
    };
  }
  const hasPy = await fs
    .stat(path.join(FILES_ROOT, 'requirements.txt'))
    .then(() => true, () => false);
  return hasPy ? { root: FILES_ROOT, scripts: [], summary: 'python project at FILES_ROOT (requirements.txt); no npm scripts' } : null;
}

let verifySeq = 0;

/**
 * Run one verification command, bounded by cwd and timeout; resolves "exit N" + output,
 * never throws. Policy-enforced: a deletion or OS-resource command is refused BEFORE any
 * process starts, and the decision is recorded in the durable execution ledger.
 *
 * Round 18 (§4.1): verification commands are EXECUTE-class — they run in the receipt
 * lifecycle like any other side-effect-capable operation: the started receipt is durable
 * before the process starts, and the outcome record is durable before the result is
 * reported to the verifier.
 */
export const runCmd = async (command: string, cwd: string, timeout: number): Promise<string> => {
  const verdict = shellVerdict(command);
  const id = `v${Date.now().toString(36)}${++verifySeq}`;
  if (verdict.blocked) {
    await recordOutcome(
      {
        id,
        t: Date.now(),
        ms: 0,
        tool: 'verify_command',
        agent: 'verifier',
        args: `command=${command}`,
        auth: 'blocked',
        status: 'not-run',
        result: verdict.reason,
        retries: 0,
        idempotencyKey: `verify_command:${command.slice(0, 120)}`,
      },
      { sideEffectMayHaveRun: false }
    );
    return `BLOCKED: ${verdict.reason ?? 'blocked by policy'} The verification command itself may not delete or modify OS resources.`;
  }
  const t0 = Date.now();
  // Round 20 (CHANGE 1): the strict started receipt — a verify command whose receipt
  // cannot land does not spawn a process, exactly like the dispatch choke point.
  await recordStartedStrict({
    id,
    t: t0,
    tool: 'verify_command',
    agent: 'verifier',
    args: `command=${command}`,
    auth: 'autonomous',
    idempotencyKey: `verify_command:${command.slice(0, 120)}`,
  });
  const isWindows = process.platform === 'win32';
  const result = await runProcess({
    executable: isWindows ? 'powershell.exe' : 'bash',
    args: isWindows ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-lc', command],
    cwd,
    timeoutMs: timeout,
    maxOutputBytes: 2 * 1024 * 1024,
    resource: 'build',
    signal: executionSignal(),
  });
  const resultText = [
    result.status === 'success'
      ? `exit 0 · ${result.durationMs}ms · queue ${result.queueWaitMs}ms`
      : result.status === 'timed_out'
        ? `TIMEOUT after ${Math.round(timeout / 1000)}s · ${result.durationMs}ms`
        : result.status === 'queue_timed_out'
          ? `QUEUE TIMEOUT after ${result.queueWaitMs}ms`
          : result.status === 'cancelled'
          ? `CANCELLED · ${result.durationMs}ms`
          : result.status === 'launch_failed'
            ? `LAUNCH FAILED (${result.errorCode ?? 'unknown'}) · ${result.durationMs}ms`
            : `exit ${result.exitCode ?? 'unknown'} · ${result.durationMs}ms`,
    result.stdout.trim(),
    result.stderr.trim() && `STDERR: ${result.stderr.trim()}`,
    result.outputTruncated ? '[output truncated at 2 MiB]' : '',
  ].filter(Boolean).join('\n');
  const neverStarted = result.status === 'queue_timed_out' || result.status === 'launch_failed' || (result.status === 'cancelled' && result.durationMs === 0);
  await recordOutcome(
    {
      id,
      t: t0,
      ms: Date.now() - t0,
      queueWaitMs: result.queueWaitMs,
      processMs: result.durationMs,
      processStatus: result.status,
      processExitCode: result.exitCode,
      processPid: result.pid,
      tool: 'verify_command',
      agent: 'verifier',
      args: `command=${command}`,
      auth: 'autonomous',
      status: result.status === 'success' ? 'ok' : neverStarted ? 'not-run' : result.status === 'cancelled' ? 'cancelled' : 'failed',
      result: resultText,
      retries: 0,
      idempotencyKey: `verify_command:${command.slice(0, 120)}`,
    },
    { sideEffectMayHaveRun: !neverStarted }
  );
  return result.status === 'success' ? resultText : `FAILED: ${resultText}`;
};
