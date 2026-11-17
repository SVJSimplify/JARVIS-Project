import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Tool } from './toolTypes';
import { FILES_ROOT, boundWorkspaceForTask } from './workspace';
import { shellVerdict } from './policy';
import { executionSignal } from './toolResult';
import { callContext } from './toolRecord';
import {
  noteBoundedRefusal,
  noteSandboxFailure,
  probeShellIsolation,
  sandboxWrapperArgs,
  shellIsolationCapability,
  verifyBoundedCommand,
  type ShellIsolationMode,
} from './shellIsolation';

const TAIL = 6000;

/**
 * ROUND 32 (§4.3) — the shell respects the project's active workspace context. A
 * project-bound task's shell commands run with the BOUND WORKSPACE as their working
 * directory (default and explicit `cwd` alike): a task for Project A must not shell into
 * Project B. Non-project calls keep the existing behavior (the Jarvis-Files root).
 *
 * ROUND 33 (§1.3) — A RESTRICTED CWD IS NOT A SANDBOX. When a binding is active, the
 * command additionally goes through the shell-isolation layer BEFORE anything runs.
 *
 * ROUND 34 (Phases 1-2) — the project-bound contract is two-tier and honest:
 *   - `os-sandbox` (bubblewrap, REAL mount-layout probe passed): the command runs inside
 *     the kernel mount namespace built by sandboxWrapperArgs — only the workspace is
 *     writable, other user data is not mounted. The cwd is resolved to its REAL path
 *     first: the namespace mounts the workspace at its canonical real path, so a
 *     symlinked workspace root is handled deliberately (never bind through the link).
 *   - `verified-bounded` (no sandbox): verifyBoundedCommand executes ONLY strictly-safe
 *     commands (tier-1 inspection/filesystem tools, hook-free git subcommands) whose
 *     targets are verified inside the project — everything that executes code is REFUSED
 *     (contract C), and single plain commands are handed to execFile as an EXPLICIT
 *     executable + argument array (contract §1.2), never re-parsed by a shell.
 *   - A sandbox launch that FAILS at runtime is an explicit SANDBOX EXECUTION FAILURE
 *     (§2.3): the command is never retried outside the sandbox, never switched to
 *     unrestricted execution; the started receipt already exists and the outcome is
 *     reported as unknown-with-refusal, visibly, in the Operations Center.
 */
const shellCwd = (requested: unknown): string => {
  const bound = boundWorkspaceForTask(callContext().taskId ?? '');
  if (!bound) return String(requested || FILES_ROOT);
  const want = String(requested || bound.root);
  const abs = path.resolve(want);
  const rel = path.relative(bound.root, abs);
  const inside = (!rel.startsWith('..') && !path.isAbsolute(rel)) || abs === bound.root;
  if (!inside) throw new Error(`OUTSIDE PROJECT WORKSPACE: the shell working directory "${want}" is outside this task's project workspace (${bound.root}) — project-bound commands run inside the project.`);
  return abs;
};

/**
 * ROUND 34: the project-bound shell execution gate. Verifies the command under the
 * measured capability mode, then returns the sandbox argv prefix (level 1), or the
 * direct executable+argument array for a verified single plain command (level 2), plus
 * the mode actually used.
 */
async function projectBoundShell(
  command: string,
  cwd: string
): Promise<{ argvPrefix: string[]; env: Record<string, string | undefined>; directExec?: { exe: string; args: string[] }; mode: ShellIsolationMode }> {
  const bound = boundWorkspaceForTask(callContext().taskId ?? '');
  if (!bound) return { argvPrefix: [], env: {}, mode: 'verified-bounded' };
  await probeShellIsolation();
  const cap = shellIsolationCapability();
  const mode = cap.mode;
  const verdict = verifyBoundedCommand(command, cwd, bound, { mode });
  if (!verdict.allowed) {
    noteBoundedRefusal();
    throw new Error(verdict.reason ?? 'the command could not be verified to stay inside the project workspace');
  }
  if (mode === 'os-sandbox') {
    // Kernel-enforced: the workspace is the only writable mount, other user data is not
    // even mounted. HOME/XDG live on the sandbox tmpfs so toolchain caches never leak.
    // The cwd is pinned to its REAL path — the namespace mounts the workspace at its
    // canonical real location (symlinked roots are deliberate, §2.1).
    let cwdReal = cwd;
    try {
      cwdReal = fs.realpathSync(cwd);
    } catch {
      /* keep the lexical cwd; containment was already verified */
    }
    return {
      argvPrefix: sandboxWrapperArgs(bound.real, cwdReal),
      env: { HOME: '/tmp/jarvis-home', XDG_CACHE_HOME: '/tmp/jarvis-cache', XDG_CONFIG_HOME: '/tmp/jarvis-config' },
      mode,
    };
  }
  return { argvPrefix: [], env: {}, directExec: verdict.directExec, mode };
}

// ROUND 28 (§4.3 cross-platform awareness): Windows stays the primary target and keeps
// PowerShell byte-for-byte; on POSIX systems the SAME tool runs the command through
// /bin/sh instead of silently failing with "exit ENOENT" (there is no powershell.exe).
// Same platform pattern verifyExec.ts already uses for its verification commands.
const IS_WIN = process.platform === 'win32';

/**
 * Spawn-level failure of the SANDBOX ITSELF (Round 34 §2.3): the bwrap binary could not
 * be executed, or bwrap reported its own mount/namespace error (its diagnostics always
 * carry the `bwrap: ` prefix and precede any command output). A command that merely
 * exits nonzero INSIDE the sandbox is a normal command failure — reported with its exit
 * code as before.
 */
const isSandboxLaunchFailure = (err: { code?: string | number | null; killed?: boolean } | null | undefined, stderr: string): boolean => {
  if (!err) return false;
  const spawnLevel = ['ENOENT', 'EACCES', 'EMFILE', 'EAGAIN'].includes(String(err.code ?? ''));
  if (spawnLevel) return true;
  const firstLine = String(stderr ?? '').split('\n')[0]?.trim() ?? '';
  return /^bwrap:\s/.test(firstLine);
};

const runShell = (
  command: string,
  cwd: string,
  timeout: number,
  argvPrefix: string[] = [],
  envOverlay: Record<string, string | undefined> = {},
  directExec?: { exe: string; args: string[] }
): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile(
      directExec ? directExec.exe : argvPrefix.length ? argvPrefix[0] : IS_WIN ? 'powershell.exe' : '/bin/sh',
      directExec
        ? directExec.args
        : argvPrefix.length
          ? [...argvPrefix.slice(1), IS_WIN ? 'powershell.exe' : '/bin/sh', ...(IS_WIN ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command])]
          : IS_WIN
            ? ['-NoProfile', '-NonInteractive', '-Command', command]
            : ['-c', command],
      { cwd, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, signal: executionSignal(), env: { ...process.env, ...envOverlay } },
      (err, stdout, stderr) => {
        // ROUND 34 §2.3: a failed sandbox launch is an explicit refusal — the command is
        // NEVER retried outside the sandbox and never switched to unrestricted shell
        // execution. The started receipt already exists; the outcome is surfaced as an
        // unknown-outcome refusal in the receipt trail and the Operations Center.
        if (argvPrefix.length && isSandboxLaunchFailure(err, stderr)) {
          noteSandboxFailure();
          const detail = err ? `${err.code ?? err.message}`.slice(0, 160) : 'unknown sandbox error';
          reject(
            new Error(
              `SANDBOX EXECUTION FAILURE: the OS sandbox could not launch this project-bound command (${detail}). ` +
                `The command was NOT executed — its outcome is UNKNOWN. Per the execution contract there is NO fallback to unrestricted shell execution: ` +
                `inspect the sandbox health in the Operations Center (bubblewrap installation, user namespaces), repair it, or run this work as non-project work through the existing authorization architecture.`
            )
          );
          return;
        }
        const out = `${stdout}${stderr}`.trim();
        const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0;
        resolve(`exit ${code}\n${out.length > TAIL ? '…' + out.slice(-TAIL) : out}`);
      }
    )
  );

export const devTools: Record<string, Tool> = {
  diagnostics: {
    description:
      'Type-check a TypeScript project (tsc --noEmit) and list compiler errors with file:line. Use after editing code, before declaring it done.',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project folder containing tsconfig.json. Defaults to the Jarvis-Files workspace.' },
        project: { type: 'string', description: 'Optional tsconfig path, e.g. tsconfig.node.json' },
      },
    },
    run: async (args) => {
      const project = args.project ? ` -p '${String(args.project).replace(/'/g, "''")}'` : '';
      const command = `npx --no-install tsc --noEmit --pretty false${project}`;
      // Second layer — the SAME central classifier already gated this call at the
      // authorization boundary (the guard now covers diagnostics too, F-01); classify the
      // COMPOSED command because it embeds model-supplied text (the tsconfig path).
      const v = shellVerdict(command);
      if (v.blocked) throw new Error(v.reason ?? 'Command blocked by policy.');
      const cwd = shellCwd(args.cwd);
      // ROUND 34: the project-bound isolation gate (sandbox, or the strict verified-
      // bounded contract — npx executes packages, so without an OS sandbox it refuses).
      const { argvPrefix, env, directExec } = await projectBoundShell(command, cwd);
      const out = await runShell(command, cwd, 180_000, argvPrefix, env, directExec);
      return out.startsWith('exit 0') ? 'No type errors.' : out;
    },
  },
  run_command: {
    description:
      'Run a shell command (PowerShell on Windows, /bin/sh elsewhere) to build, run, test or debug code and read its output (stdout+stderr tail, exit code). Use it in a loop: reproduce, inspect, fix, rerun.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string', description: 'Working folder. Defaults to the Jarvis-Files workspace.' },
        timeout_s: { type: 'number', description: 'Default 120, max 600.' },
      },
      required: ['command'],
    },
    run: async (args) => {
      const command = String(args.command ?? '');
      // Second layer only — the SAME central classifier already gated this call at the
      // authorization boundary (guard.assessRisk → permission.authorize). No private rules.
      const v = shellVerdict(command);
      if (v.blocked) throw new Error(v.reason ?? 'Command blocked by policy.');
      const timeout = Math.min(Number(args.timeout_s) || 120, 600) * 1000;
      const cwd = shellCwd(args.cwd);
      // ROUND 34: the project-bound isolation gate. With an active binding the command is
      // verified (strictly-safe executable + in-project targets, or executed inside the
      // probed kernel sandbox); anything unverifiable is refused with the honest
      // explanation — never guessed, never run unrestricted, never silently downgraded.
      const { argvPrefix, env, directExec } = await projectBoundShell(command, cwd);
      return runShell(command, cwd, timeout, argvPrefix, env, directExec);
    },
  },
};
