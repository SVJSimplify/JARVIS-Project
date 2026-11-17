/**
 * PROJECT-BOUND SHELL ISOLATION (Round 33 Phase 1 §1.3; ROUND 34 Phases 1-2 — the
 * verified-bounded contract redesign and the real bubblewrap mount probe).
 *
 * THE HONEST TRUTH THIS MODULE IMPLEMENTS: a restricted working directory is NOT a
 * sandbox, and an executable's NAME being recognized does not make its ARGUMENTS safe.
 * Round 34 closes the allowlist gap (finding 1 of the Phase 0 audit): node -e, python -c,
 * npm run, npx <pkg> and shell interpreters can execute arbitrary code, so under the
 * verified-bounded pathway they are REFUSED — the command contract is now two-tier:
 *
 *   LEVEL 1 — OS-ENFORCED SANDBOX (the strong level, when the platform provides one).
 *   On POSIX, when bubblewrap is installed AND the ACTUAL MOUNT LAYOUT probe passes
 *   (Round 34 §2.2 — namespace creation, toolchain availability, workspace mount,
 *   workspace write access, outside-workspace isolation, working-directory behavior and
 *   child-process inheritance are all exercised through the SAME argument construction
 *   the runtime uses, against a temporary probe workspace outside the user's data),
 *   project-bound commands run inside a mount namespace in which ONLY the project
 *   workspace is writable and other user data is not even mounted. Kernel-enforced:
 *   arbitrary-code-executing tools (node, npm, python, build tooling, workspace-local
 *   scripts) are permitted BECAUSE the kernel bounds what they can touch — never because
 *   their name appeared on a list (Round 34 Gate 1).
 *
 *   LEVEL 2 — VERIFIED-BOUNDED EXECUTION (the honest fallback, everywhere else).
 *   Where no OS mechanism is available (Windows has no portable sandbox reachable from
 *   Node without native modules), project-bound commands run ONLY when their complete
 *   execution behavior can be established statically (Round 34 §1.1 contract A):
 *     - the executable must be in the STRICTLY-SAFE set (pure inspection / filesystem
 *       operations that never execute code, run hooks or load executable configuration),
 *       or `git` with one of the hook-free subcommands;
 *     - every path-like argument and redirection target must resolve — lexically AND by
 *       deepest-existing-ancestor realpath — inside the workspace;
 *     - EVERYTHING ELSE (code-executing toolchains, script interpreters, workspace-local
 *       scripts/executables, unknown executables) is REFUSED with an explanation —
 *       contract C — because under verified-bounded execution there is no kernel boundary
 *       that would contain what such a command executes;
 *     - constructs the scanner cannot parse safely (heredocs, subshells, process
 *       substitution, PowerShell script blocks, unmatched quotes, unsupported redirection
 *       forms) are REFUSED — the safest outcome for unsupported syntax is refusal
 *       (Round 34 §1.2).
 *   This is NOT keyword filtering pretending to be a sandbox and it is ALWAYS reported as
 *   "verified-bounded", never "sandboxed". It is also NOT a growing pile of regular
 *   expressions: the safe set is a FIXED classification of what can be statically proven,
 *   the scanner refuses what it cannot parse, and everything that actually needs to
 *   execute code belongs at level 1 or outside project-bound work.
 *
 * Unrestricted shell work (system-level maintenance, anything this module cannot verify)
 * stays available OUTSIDE project-bound tasks through the existing authorization
 * architecture — exactly as before. Non-project shell behavior is unchanged, byte for
 * byte. There is no unrestricted escape hatch inside the project-bound pathway, and a
 * failed sandbox launch NEVER falls back to unrestricted execution (Round 34 §2.3).
 */

import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type ShellIsolationMode = 'os-sandbox' | 'verified-bounded';

export interface SandboxProbeStep {
  step: string;
  ok: boolean;
  detail?: string;
}

export interface ShellIsolationCapability {
  mode: ShellIsolationMode;
  platform: string;
  /** The actual mechanism ("bubblewrap mount namespace (mount layout probed)" / ...). */
  mechanism: string;
  /** The honest warning shown in the Operations Center when only level 2 is available. */
  warning?: string;
  /** True once the probe ran to completion (the capability is measured, not assumed). */
  probed: boolean;
  /** ROUND 34 §2.2: the REAL mount-probe result — per-step, from the actual construction. */
  probe?: { passed: boolean; steps: SandboxProbeStep[]; at: number };
  /** ROUND 34 §6: project-bound commands the verifier refused (real counter). */
  refusedCommands: number;
  /** ROUND 34 §6: sandbox launches that FAILED at runtime (never retried unrestricted). */
  sandboxFailures: number;
}

const capability: ShellIsolationCapability = {
  mode: 'verified-bounded',
  platform: `${process.platform}`,
  mechanism: 'verified-bounded command pathway',
  probed: false,
  refusedCommands: 0,
  sandboxFailures: 0,
};

/** Real counter — called at the actual refusal site (devTools throws the verdict). */
export const noteBoundedRefusal = (): void => {
  capability.refusedCommands += 1;
};
/** Real counter — called when a sandbox launch fails at runtime (devTools reports it). */
export const noteSandboxFailure = (): void => {
  capability.sandboxFailures += 1;
};

export const shellIsolationCapability = (): ShellIsolationCapability => ({ ...capability, probe: capability.probe ? { ...capability.probe, steps: capability.probe.steps.map((s) => ({ ...s })) } : undefined });

// --------------------------------------------------------------------------
// The TWO-TIER command classification (Round 34 §1.1). A FIXED, small set:
// tier 1 can be statically proven safe anywhere; tier 2 executes code and is
// therefore permitted ONLY inside the kernel-enforced OS sandbox.
// --------------------------------------------------------------------------

/**
 * TIER 1 — STRICTLY SAFE ANYWHERE (contract A): pure inspection and filesystem
 * operations whose complete execution behavior is establishable without a kernel
 * sandbox. No member executes code, runs hooks, loads executable configuration, or
 * evaluates its arguments as anything but data/paths.
 */
const SAFE_ANYWHERE = new Set([
  // inspection / read-only
  'ls', 'cat', 'head', 'tail', 'wc', 'diff', 'sort', 'uniq', 'pwd', 'echo', 'printf',
  'rg', 'grep', 'find', 'file', 'stat', 'du', 'df', 'tree', 'which', 'whoami', 'hostname',
  'date', 'sleep',
  // filesystem operations (targets are path-verified inside the workspace)
  'mkdir', 'rmdir', 'touch', 'cp', 'mv', 'rm',
  // deterministic compiler: reads project config, emits project files, executes nothing
  'tsc',
  // PowerShell read-only / filesystem analogues (Windows-primary; names only, harmless elsewhere)
  'get-content', 'get-childitem', 'get-item', 'get-date', 'get-location', 'set-location',
  'test-path', 'copy-item', 'move-item', 'new-item', 'remove-item', 'write-output',
  'write-host', 'select-string', 'out-string', 'format-table', 'format-list',
  'measure-object', 'compare-object', 'test-json', 'resolve-path', 'split-path', 'join-path',
  // aliases of the above (PowerShell resolves them to the same cmdlets)
  'gc', 'gci', 'gi', 'sls', 'cpi', 'mi', 'ni', 'cd', 'sl', 'dir', 'type', 'md', 'write',
]);

/**
 * The `git` subcommands that never execute repository hooks or config-driven programs
 * (a commit/merge/rebase/checkout runs hooks; those are TIER 2). `git` itself is tier 1
 * ONLY with one of these subcommands.
 */
const SAFE_GIT_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'tag', 'remote', 'rev-parse', 'blame',
  'describe', 'shortlog', 'ls-files', 'check-ignore', 'config', 'init', 'add', 'clean',
  'stash', 'ls-remote', 'help', 'version',
]);

/**
 * TIER 2 — EXECUTES CODE (contract B/C): development toolchains whose arguments or
 * configuration are code (`node -e`, `python -c`, `npm run`, `npx <pkg>`, `make`,
 * interpreters, script launchers). Permitted ONLY when a genuine OS sandbox is active.
 * NOT a hard blocklist: every unknown executable lands here too (fail-closed).
 */
const SANDBOX_REQUIRED_TOOLS = new Set([
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'yarnpkg', 'tsx', 'ts-node', 'vite', 'esbuild',
  'python', 'python3', 'pip', 'pip3', 'make', 'cmake', 'cargo', 'rustc', 'go', 'gofmt',
  'java', 'javac', 'gradle', 'mvn', 'dotnet', 'gcc', 'g++', 'clang', 'clang++',
  // shell interpreters and PowerShell itself (they execute their input as code)
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'powershell', 'powershell.exe', 'pwsh', 'cmd', 'cmd.exe',
  // PowerShell remoting/execution host surfaces
  'invoke-command', 'start-job', 'start-threadjob',
]);

/** Constructs that make a command UNVERIFIABLE — refused under the verified-bounded
 *  contract, never parsed harder. Bare $VAR indirection ($HOME), ${…}, $(…), %VAR%,
 *  $env:, and backticks all name paths or commands the verifier cannot see. */
const UNVERIFIABLE = /\$\{|\$\(|`|\$env:|%[A-Za-z_]|%$|\$[A-Za-z_][A-Za-z0-9_]*/i;
/** Interpreters/launchers that execute their (unverifiable) argument as code — refused in
 *  BOTH modes (even the kernel sandbox has no business running these for project work). */
const LAUNCHERS = /^(iex|invoke-expression|start-process|start-job|start-threadjob|wscript|cscript|regsvr32|rundll32|mshta|msiexec|installutil)$/i;
/** `find` primaries that execute commands or write format output — tier 2, not tier 1. */
const FIND_EXEC_PRIMARIES = /^-(exec|execdir|ok|okdir|fprintf|fprint|fprint0)$/i;

const isDriveLetterPath = (t: string): boolean => /^[A-Za-z]:[\\/]/.test(t);
const isUncPath = (t: string): boolean => /^\\\\/.test(t);
const looksPathLike = (t: string): boolean =>
  /[/\\]/.test(t) || t.startsWith('~') || t.startsWith('.') || isDriveLetterPath(t) || isUncPath(t);

// ------------------------------------------------------------------ scanner (§1.2)

interface ScannedSegment {
  /** Word tokens with quotes resolved and escapes resolved (POSIX rules on POSIX,
   *  PowerShell literal-backslash rules on win32). */
  tokens: string[];
  /** When set, the segment contains syntax this scanner refuses to parse — the safest
   *  outcome for unsupported syntax is refusal (verified-bounded contract §1.2). */
  unsupported?: string;
  /** True when the segment used the PowerShell call operator (`&` directly before a word). */
  callOperator: boolean;
  /** Redirections found in the segment (operator + resolved target token, when any). */
  redirections: Array<{ op: string; target?: string; fdDup?: boolean }>;
}

/** Split a command into top-level segments on shell/PowerShell separators, respecting
 *  quotes and backslash escapes. Separators: `;`, newline, `|`, `||`, `|&`, `&&`, and a
 *  whitespace-preceded/backgrounding `&`. A `&` IMMEDIATELY before a word is the
 *  PowerShell call operator and stays inside its segment (handled by the verifier). */
function splitSegments(command: string, isWin: boolean): Array<{ text: string; callOperator: boolean }> {
  const segments: Array<{ text: string; callOperator: boolean }> = [];
  let cur = '';
  let quote: string | null = null;
  let callOperator = false;
  const push = (): void => {
    const t = cur.trim();
    if (t.length > 0 || callOperator) segments.push({ text: t, callOperator });
    cur = '';
    callOperator = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (!isWin && ch === '\\') {
      // POSIX escape: backslash + character is kept LITERALLY (backslash preserved) — the
      // CONSERVATIVE reading for verification: `..\\/out` stays path-like (traversal and
      // drive-letter/UNC detection survive), `\\;` is still not a separator, and the
      // PowerShell-literal backslashes of Windows command strings stay visible on POSIX.
      const next = command[i + 1];
      if (next === '\n') {
        i++;
        cur += ' ';
        continue;
      }
      cur += ch + (next ?? '');
      if (next !== undefined) i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '|') {
      // consume || and |& (both are pipe-style separators)
      if (ch === '|' && (command[i + 1] === '|' || command[i + 1] === '&')) i++;
      push();
      continue;
    }
    if (ch === '&') {
      if (command[i + 1] === '&') {
        push();
        i++;
        continue;
      }
      const nextChar = command[i + 1];
      if (nextChar !== undefined && !/\s/.test(nextChar)) {
        // PowerShell call operator: `&` glued to the next word stays in this segment.
        callOperator = true;
        cur += ch;
        continue;
      }
      push(); // backgrounding separator: `cmd &`
      continue;
    }
    cur += ch;
  }
  if (quote) {
    // unterminated quote — the scanner cannot know what the shell would do: mark the
    // whole trailing fragment unsupported by returning it verbatim as one segment.
    segments.push({ text: cur.trim(), callOperator });
    segments.push({ text: '\u0000unterminated-quote', callOperator: false });
    return segments;
  }
  push();
  return segments;
}

/**
 * Tokenize ONE segment (scanner v2, Round 34 §1.2): quotes and POSIX escapes resolved,
 * redirection operators recognized (`>`, `>>`, `2>`, `2>>`, `<`, `&>`, `>&`, fd
 * duplication `2>&1`), and UNSUPPORTED syntax detected instead of misparsed: subshell
 * parens, process substitution, braces (script blocks / brace expansion), heredocs and
 * herestrings, `<>`, redirection with no target, and unbalanced quotes.
 */
function tokenizeSegment(segment: string, isWin: boolean): ScannedSegment {
  const tokens: string[] = [];
  const redirections: ScannedSegment['redirections'] = [];
  let cur = '';
  let quote: string | null = null;
  let unsupported: string | undefined;
  const fail = (why: string): void => {
    unsupported ??= why;
  };
  const flush = (): void => {
    if (cur.length > 0) tokens.push(cur);
    cur = '';
  };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (!isWin && ch === '\\' && quote === '"') {
        const next = segment[i + 1];
        if (next === '"' || next === '\\' || next === '$' || next === '`' || next === '\n') {
          cur += next === '\n' ? '' : next;
          i++;
          continue;
        }
        cur += ch;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      continue;
    }
    if (!isWin && ch === '\\') {
      // Keep the escape pair LITERALLY (see splitSegments — conservative verification).
      const next = segment[i + 1];
      if (next === undefined) {
        fail('a trailing backslash escape cannot be parsed');
        continue;
      }
      cur += ch + next;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    // redirection operators (recognized exactly; anything else in the family refuses)
    if (ch === '>' || ch === '<') {
      flush();
      let op = ch;
      if (segment[i + 1] === op) {
        op += op;
        i++;
        if (op === '<<') {
          fail('heredoc/herestring syntax is not supported by the verified-bounded scanner');
          continue;
        }
        if (op === '<>') {
          fail('read-write redirection `<>` is not supported');
          continue;
        }
      } else if (ch === '>' && (segment[i + 1] === '&' || segment[i + 1] === '!')) {
        op += segment[i + 1];
        i++;
      }
      // skip whitespace, then the fd-dup or target
      let j = i + 1;
      while (j < segment.length && /\s/.test(segment[j])) j++;
      let k = j;
      while (k < segment.length && !/\s/.test(segment[k])) k++;
      const operand = segment.slice(j, k);
      if (!operand) {
        fail(`redirection "${op}" has no target`);
        continue;
      }
      if (operand.includes('(') || operand.includes(')')) {
        fail('process substitution / subshell in a redirection operand cannot be parsed');
        i = k - 1;
        continue;
      }
      if (/^\d$/.test(operand) && ch === '>') {
        // `>&2` style fd duplication written as `>& 2`
        redirections.push({ op, fdDup: true, target: operand });
        i = k - 1;
        continue;
      }
      if (/^&\d+$/.test(operand)) {
        redirections.push({ op, fdDup: true, target: operand.slice(1) });
        i = k - 1;
        continue;
      }
      if (op === '>&' || op === '&>') {
        if (/^\d+$/.test(operand)) {
          redirections.push({ op, fdDup: true, target: operand });
          i = k - 1;
          continue;
        }
        // `&> file` / `>& file` — both-streams redirection to a file
        redirections.push({ op, target: operand });
        tokens.push('\u0000REDIR', op, operand);
        i = k - 1;
        continue;
      }
      redirections.push({ op, target: operand });
      tokens.push('\u0000REDIR', op, operand);
      i = k - 1;
      continue;
    }
    if (ch === '(' || ch === ')') {
      fail('subshell parentheses cannot be parsed (process substitution and subshells are refused)');
      cur += ch;
      continue;
    }
    if (ch === '{' || ch === '}') {
      fail('brace syntax (PowerShell script blocks / brace expansion) cannot be parsed');
      cur += ch;
      continue;
    }
    if (ch === '&') {
      // within a segment a bare `&` only appears as the call operator (splitSegments
      // handles the separators); it is transparent for verification.
      flush();
      continue;
    }
    cur += ch;
  }
  if (quote) fail('an unterminated quote cannot be parsed');
  flush();
  return { tokens, unsupported, callOperator: false, redirections };
}

// ------------------------------------------------------------------ path verification

/** Resolve one candidate path and verify it stays inside the bound workspace (lexical +
 *  deepest-existing-ancestor realpath; fail-closed on unresolvable). */
function resolvesInsideWorkspace(raw: string, cwd: string, binding: { root: string; real: string }): boolean {
  const target = raw;
  if (target.startsWith('~')) return false; // expands outside the workspace by definition
  if (isUncPath(target)) return false;
  if (isDriveLetterPath(target) && process.platform !== 'win32') return false;
  const abs = path.isAbsolute(target) ? path.normalize(target) : path.resolve(cwd, target);
  const rel = path.relative(binding.root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  let probe = abs;
  for (;;) {
    try {
      const real = fs.realpathSync(probe);
      const rrel = path.relative(binding.real, real);
      return !rrel.startsWith('..') && !path.isAbsolute(rrel);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      const parent = path.dirname(probe);
      if (parent === probe) return false;
      probe = parent;
    }
  }
}

// ------------------------------------------------------------------ the verifier

export interface BoundedVerdict {
  allowed: boolean;
  reason?: string;
  /**
   * ROUND 34 §1.2 — when the verified command is a single plain segment (no redirection,
   * no pipes, no call operator) the scanner has already produced the exact executable +
   * argument array; devTools executes THAT directly instead of handing a command string
   * to a shell. Explicit argv construction is preferred over shell-string parsing
   * wherever the tool architecture allows it.
   */
  directExec?: { exe: string; args: string[] };
}

/**
 * THE verified-bounded verifier (Round 34 §1.1). `mode` defaults to the MEASURED
 * capability. Under `verified-bounded` the strict contract applies (tier-1 executables
 * only, path verification, unsupported syntax refused). Under a PROBED `os-sandbox` the
 * KERNEL is the filesystem boundary, so code-executing toolchains and shell syntax are
 * permitted inside the namespace — the verifier still refuses privilege elevation and
 * the launcher family in both modes.
 */
export function verifyBoundedCommand(
  command: string,
  cwd: string,
  binding: { root: string; real: string },
  opts: { mode?: ShellIsolationMode } = {}
): BoundedVerdict {
  const mode: ShellIsolationMode = opts.mode ?? capability.mode;
  const isWin = process.platform === 'win32';
  const refuse = (what: string, hint: string, kind: 'outside' | 'sandbox' = 'outside'): BoundedVerdict => ({
    allowed: false,
    reason:
      kind === 'outside'
        ? `OUTSIDE PROJECT WORKSPACE (unverified shell command): ${what}. ` +
          `Project-bound shell commands run through the verified-bounded pathway — only commands whose executable, working directory and filesystem targets can be verified to stay inside the project (${binding.root}) are executed. ` +
          `${hint} If this work genuinely needs unrestricted execution, the user must run it as non-project work through the existing authorization architecture.`
        : `SANDBOX REQUIRED (project-bound shell): ${what}. ` +
          `Under the verified-bounded pathway (no OS sandbox active on this machine) JARVIS executes only commands whose complete behavior can be statically established — pure inspection and filesystem tools with verified in-project targets. ` +
          `Commands that execute code (interpreters, package managers, build tooling, scripts) run ONLY inside the kernel-enforced OS sandbox. ` +
          `${hint} Install bubblewrap (Linux) so project-bound commands run sandboxed, or run this work as non-project work through the existing authorization architecture.`,
  });

  // Privilege elevation is refused in BOTH modes (a sandboxed process has no business
  // trying, and a verified-bounded process must never gain privilege).
  if (/\b(sudo|doas|runas|gsudo)\b/i.test(command)) {
    return refuse('the command elevates privileges', 'Privilege elevation is never available inside project-bound work.');
  }
  // ROUND 34 (§1.1, restored): under the verified-bounded contract, environment-variable
  // indirection, command substitution and backticks make a command UNVERIFIABLE — the
  // SHELL expands them at runtime, so a token like `$HOME/x` is an outside path the
  // scanner never sees. Refused before any classification (the OS-sandbox tier skips
  // this: the kernel bounds what the expansion can reach).
  if (mode === 'verified-bounded' && UNVERIFIABLE.test(command)) {
    return refuse(
      'the command uses environment-variable or command-substitution indirection that cannot be verified statically',
      'Use literal paths inside the project instead.'
    );
  }

  const segments = splitSegments(command, isWin);
  if (segments.some((s) => s.text === '\u0000unterminated-quote')) {
    return refuse('the command contains an unterminated quote', 'Quote the whole string; the scanner refuses what it cannot parse.');
  }

  let directExecCandidate: { exe: string; args: string[] } | undefined;
  const singleSegment = segments.length === 1;

  for (const seg of segments) {
    const scanned = tokenizeSegment(seg.text, isWin);
    // OS-sandbox mode: the kernel enforces the filesystem boundary, so shell syntax and
    // code-executing toolchains are permitted; only the launcher family stays refused
    // (nothing in project-bound work needs it, sandboxed or not).
    if (mode === 'os-sandbox') {
      if (scanned.tokens.some((t) => LAUNCHERS.test(t))) {
        return refuse(`"${scanned.tokens.find((t) => LAUNCHERS.test(t))}" executes another program or script that cannot be verified`, 'Run the target program directly if it is a project tool.');
      }
      continue;
    }
    if (scanned.unsupported) {
      return refuse(scanned.unsupported, 'Unsupported syntax is refused rather than misparsed; simplify the command (explicit paths, no substitution).');
    }
    const tokens = scanned.tokens.filter((t) => t !== '\u0000REDIR');
    if (!tokens.length) continue;
    let idx = 0;
    if (tokens[0] === '&') idx = 1; // PowerShell call operator: the NEXT token is the executable
    const exeToken = tokens[idx];
    if (!exeToken) continue;
    const bare = exeToken.toLowerCase();
    const isPathExe = looksPathLike(exeToken);
    if (isPathExe) {
      // Round 34 §1.1 contract B: workspace-local scripts/executables run only under a
      // genuine OS sandbox — verified-bounded cannot establish what a script executes.
      if (!resolvesInsideWorkspace(exeToken, cwd, binding)) {
        return refuse(`the executable path "${exeToken}" resolves outside the project workspace`, 'Run a workspace-local or standard toolchain executable.');
      }
      return refuse(
        `executing the workspace-local program "${exeToken}" runs code the verified-bounded pathway cannot statically verify (scripts can read, write and execute anything the process can)`,
        `Move the work into the OS sandbox pathway (install bubblewrap) or run it as non-project work.`,
        'sandbox'
      );
    }
    if (LAUNCHERS.test(bare)) {
      return refuse(`"${exeToken}" executes another program or script that cannot be verified`, 'Run the target program directly if it is a project tool.');
    }
    const tier1 = SAFE_ANYWHERE.has(bare);
    if (bare === 'git') {
      const sub = (tokens[idx + 1] ?? '').toLowerCase();
      if (!SAFE_GIT_SUBCOMMANDS.has(sub)) {
        return refuse(
          `"git ${sub || '(no subcommand)'}" can execute repository hooks or config-driven programs (commit/merge/rebase/checkout hooks, credential helpers)`,
          'Use a hook-free git subcommand (status/log/diff/show/branch/add/…), or run this under the OS sandbox.',
          'sandbox'
        );
      }
    } else if (bare === 'find') {
      // find's -exec family executes commands: tier 2 even though find itself is tier 1.
      if (tokens.some((t) => FIND_EXEC_PRIMARIES.test(t))) {
        return refuse('"find -exec/-ok/-fprintf" executes commands or writes formatted output the verifier cannot fully establish', 'Use rg/ls for discovery and run specific tools directly, or run under the OS sandbox.', 'sandbox');
      }
    } else if (!tier1) {
      const what = SANDBOX_REQUIRED_TOOLS.has(bare)
        ? `"${exeToken}" executes code (its arguments or configuration can run arbitrary programs — e.g. node -e, python -c, npm run, npx <pkg>)`
        : `"${exeToken}" is not a recognized strictly-safe tool of the project-bound pathway`;
      return refuse(what, tier1 ? '' : 'Only pure inspection/filesystem tools are verifiable without a kernel sandbox.', 'sandbox');
    }
    // argument verification for tier-1 executables (both the safe set and safe git)
    for (let i = idx + 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (FIND_EXEC_PRIMARIES.test(t)) {
        return refuse('"find -exec/-ok/-fprintf" executes commands the verifier cannot fully establish', 'Use rg/ls for discovery and run specific tools directly, or run under the OS sandbox.', 'sandbox');
      }
      // redirection operands were collected at scan time; targets verified below
      if (t === '/dev/null' || t === '/dev/stdout' || t === '/dev/stderr') continue;
      if (looksPathLike(t) && !resolvesInsideWorkspace(t, cwd, binding)) {
        return refuse(`the path argument "${t}" resolves outside the project workspace`, 'Reference only paths inside the project.');
      }
      // bare arguments that name an EXISTING file relative to the cwd are filesystem targets too
      if (!t.startsWith('-') && !looksPathLike(t)) {
        const abs = path.resolve(cwd, t);
        try {
          fs.statSync(abs);
        } catch {
          continue; // does not exist → an ordinary argument (a flag value, a name, text)
        }
        if (!resolvesInsideWorkspace(t, cwd, binding)) {
          return refuse(`the filesystem argument "${t}" resolves outside the project workspace`, 'Reference only paths inside the project.');
        }
      }
    }
    // redirection targets (scan-level): every target must be inside the workspace (or a
    // null/std device); `<` input from outside would read data the boundary must not expose.
    for (const r of scanned.redirections) {
      if (r.fdDup) continue; // 2>&1 etc. — no filesystem target
      const target = r.target ?? '';
      if (target === '/dev/null' || target === '/dev/stdout' || target === '/dev/stderr') continue;
      if (!resolvesInsideWorkspace(target, cwd, binding)) {
        return refuse(`the command redirects ${r.op === '<' ? 'input from' : 'output to'} "${target}" which resolves outside the project workspace`, r.op === '<' ? 'Read input from inside the project.' : 'Redirect inside the project.');
      }
    }
    // direct argv execution for a single plain segment (no shell involved at runtime):
    // only for tier-1 executables (safe set, or safe git) — the scanner has already
    // resolved every token, so the argv IS the command.
    const tier1Executable = bare === 'git' ? SAFE_GIT_SUBCOMMANDS.has((tokens[idx + 1] ?? '').toLowerCase()) : SAFE_ANYWHERE.has(bare);
    if (singleSegment && !scanned.callOperator && scanned.redirections.length === 0 && tokens[0] !== '&' && !isWin && tier1Executable) {
      directExecCandidate = { exe: bare, args: tokens.slice(idx + 1) };
    }
  }

  // PowerShell cmdlets are not real executables on POSIX: only offer direct exec when the
  // first token is a plain binary name (never a PowerShell cmdlet/alias).
  if (directExecCandidate) {
    const exe = directExecCandidate.exe;
    const psVerbPrefix = /^(get-|set-|out-|format-|measure-|compare-|test-|resolve-|split-|join-|select-|new-|copy-|move-|remove-|write-|invoke-|start-)/i;
    const psAlias = /^(gc|gci|gi|sls|cpi|mi|ni|sl|md|dir|type|echo|cd|write)$/i;
    if (psVerbPrefix.test(exe) || psAlias.test(exe)) directExecCandidate = undefined;
  }
  return directExecCandidate ? { allowed: true, directExec: directExecCandidate } : { allowed: true };
}

// --------------------------------------------------------------------------
// LEVEL 1 — the OS sandbox: mount construction (Round 34 §2.1) and the REAL
 // mount-layout probe (Round 34 §2.2).
// --------------------------------------------------------------------------

/** Directories mounted read-only into the OS sandbox when they exist (toolchains live here). */
const SANDBOX_RO_DIRS = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/etc', '/opt', '/nix'];
/** Directories replaced with isolated tmpfs (host user data under them is NOT mounted). */
const SANDBOX_TMPFS_DIRS = ['/tmp', '/home', '/run'];

const isCoveredByMount = (p: string): boolean =>
  p === '/' || SANDBOX_TMPFS_DIRS.includes(p) || SANDBOX_RO_DIRS.some((d) => p === d || p.startsWith(`${d}/`));

/**
 * Build the FULL bwrap argv prefix that isolates a project-bound command (Round 34 §2.1).
 * ROUND 34 FIX (audit findings 3 + 11):
 *   - the argv STARTS with the bwrap executable itself (Round 33 returned only the flags
 *     while devTools treated argvPrefix[0] as the executable — every sandbox launch would
 *     have failed with `exit ENOENT`);
 *   - the workspace's destination parent chain is GUARANTEED inside the namespace: every
 *     proper ancestor of the workspace that is not already provided by the read-only
 *     toolchain binds or the tmpfs mounts gets an explicit tmpfs mount (an EMPTY mount —
 *     host user data under it is never exposed) BEFORE the workspace bind, so the
 *     destination parent exists on every bubblewrap version and for workspaces nested
 *     under directories replaced by tmpfs (`/home/user/...`) or outside the mounted
 *     system roots (`/srv/...`, `/data/...`);
 *   - the workspace is mounted at its CANONICAL REAL path (symlinked workspace roots are
 *     handled deliberately: the real path is bound and chdir'd, never the link path);
 *   - `--die-with-parent` terminates the sandbox with the parent; no privileges are
 *     granted; other projects are simply not mounted.
 */
export const sandboxWrapperArgs = (workspaceReal: string, cwdReal: string): string[] => {
  // DELIBERATE SYMLINK HANDLING (§2.1): the workspace is mounted at its CANONICAL REAL
  // path — a symlinked workspace root never causes a bind through (or of) the link, so
  // the namespace cannot accidentally expose the link's parent directory tree.
  let real = path.resolve(workspaceReal);
  try {
    real = fs.realpathSync(real);
  } catch {
    /* keep the lexical absolute path (the probe/runtime verify existence beforehand) */
  }
  const args = ['bwrap', '--die-with-parent', '--unshare-ipc', '--proc', '/proc', '--dev', '/dev'];
  for (const d of SANDBOX_TMPFS_DIRS) args.push('--tmpfs', d);
  for (const d of SANDBOX_RO_DIRS) {
    try {
      if (fs.statSync(d).isDirectory()) args.push('--ro-bind', d, d);
    } catch {
      /* directory does not exist on this machine — skip it */
    }
  }
  // Explicit per-level destination construction (shallow → deep): every ancestor of the
  // workspace that is not covered by the mounts above gets an empty tmpfs, so the
  // workspace destination parent chain exists INSIDE the namespace without exposing the
  // host directories that live there.
  const parts = real.split(path.sep).filter(Boolean);
  const seen = new Set<string>();
  for (let i = 1; i < parts.length; i++) {
    const ancestor = path.sep + parts.slice(0, i).join(path.sep);
    if (seen.has(ancestor)) continue;
    seen.add(ancestor);
    if (!isCoveredByMount(ancestor)) args.push('--tmpfs', ancestor);
  }
  args.push('--bind', real, real, '--chdir', cwdReal);
  return args;
};

// ------------------------------------------------------------------ the REAL probe (§2.2)

const PROBE_STEP_NAMES = [
  'namespace-creation',
  'toolchain-availability',
  'workspace-source-resolution',
  'workspace-mount-creation',
  'workspace-write-access',
  'outside-workspace-isolation',
  'working-directory-behavior',
  'child-process-inheritance',
] as const;

/** The bwrap binary: fixed candidates first, then PATH (measured, never assumed). */
async function findBubblewrap(): Promise<string | null> {
  const candidates = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap', '/snap/bin/bwrap'];
  for (const b of candidates) {
    try {
      fs.accessSync(b, fs.constants.X_OK);
      return b;
    } catch {
      /* next */
    }
  }
  try {
    await new Promise<void>((resolve, reject) => execFile('bwrap', ['--version'], { timeout: 5_000 }, (err) => (err ? reject(err) : resolve())));
    return 'bwrap';
  } catch {
    return null;
  }
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * THE REAL MOUNT PROBE (Round 34 §2.2). Runs ONE bubblewrap invocation built by the SAME
 * sandboxWrapperArgs() construction the runtime uses, against a temporary probe workspace
 * OUTSIDE the user's project data (deeply nested under the tmpfs-replaced /tmp — exactly
 * the layout that broke the Round 33 construction). Verifies, in one pass:
 *   1. namespace creation,  2. toolchain availability,  3. workspace source resolution,
 *   4. workspace mount creation,  5. workspace write access,  6. outside-workspace
 *   isolation (host files AND the host home are invisible),  7. working-directory
 *   behavior,  8. child-process inheritance of the namespace.
 * Probe resources are cleaned up; a failed probe NEVER reports os-sandbox.
 */
async function runMountProbe(bwrapBin: string): Promise<{ passed: boolean; steps: SandboxProbeStep[]; detail?: string }> {
  const steps: SandboxProbeStep[] = PROBE_STEP_NAMES.map((step) => ({ step, ok: false }));
  const probeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'jarvis-bwrap-probe-'));
  try {
    const probeWs = path.join(probeRoot, 'probe-home', 'probe-user', 'probe-ws');
    await fsp.mkdir(probeWs, { recursive: true });
    await fsp.writeFile(path.join(probeWs, 'probe-file.txt'), 'probe', 'utf8');
    const outsideMarker = path.join(probeRoot, 'outside-marker.txt');
    await fsp.writeFile(outsideMarker, 'must-not-be-visible-inside-the-sandbox', 'utf8');
    let probeWsReal = probeWs;
    try {
      probeWsReal = fs.realpathSync(probeWs);
    } catch {
      /* keep lexical */
    }
    // The ACTUAL runtime construction — the probe validates exactly what commands get.
    const args = sandboxWrapperArgs(probeWsReal, probeWsReal).slice(1); // strip 'bwrap' (exec'd explicitly below)
    const script = [
      'ls / >/dev/null 2>&1 || exit 20',
      'command -v ls >/dev/null 2>&1 || exit 21',
      'cat probe-file.txt 2>/dev/null | grep -q probe || exit 22',
      'touch .jarvis-probe-write 2>/dev/null || exit 23',
      `test ! -e ${shq(outsideMarker)} || exit 24`,
      `test ! -e ${shq(os.homedir())} || exit 25`,
      `[ "$(pwd -P)" = ${shq(probeWsReal)} ] || exit 26`,
      `/bin/sh -c "test -f probe-file.txt" 2>/dev/null || exit 27`,
      'echo JARVIS-PROBE-PASS',
    ].join(' && ');
    const result = await new Promise<{ code: number | string; stdout: string; stderr: string; killed: boolean }>((resolve) => {
      execFile(bwrapBin, [...args, '/bin/sh', '-c', script], { timeout: 15_000 }, (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        resolve({
          code: e ? (e.killed ? 'TIMEOUT' : (e.code ?? 1)) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          killed: e?.killed === true,
        });
      });
    });
    const stepFor = (exitCode: number | string): number => {
      // ROUND 35 baseline fix (Phase 0 finding 11): the exit codes now name the step they
      // actually exercise — 22 is the in-sandbox workspace READ (mount creation, index 3)
      // and 23 the workspace WRITE test (index 4). Source resolution is verified host-side
      // and stays at index 2. A failure still fails the WHOLE probe (fail-safe unchanged).
      const map: Record<number, number> = { 20: 0, 21: 1, 22: 3, 23: 4, 24: 5, 25: 5, 26: 6, 27: 7 };
      if (typeof exitCode === 'number' && map[exitCode] !== undefined) return map[exitCode];
      return exitCode === 'TIMEOUT' ? 0 : 0;
    };
    if (result.code === 0 && result.stdout.includes('JARVIS-PROBE-PASS')) {
      for (const s of steps) s.ok = true;
      return { passed: true, steps };
    }
    // Failure: mark every step failed, then annotate the step that failed (workspace
    // source resolution is checked host-side and precedes the invocation).
    let probeWsResolvable = false;
    try {
      probeWsResolvable = !!fs.realpathSync(probeWs);
    } catch {
      probeWsResolvable = false;
    }
    steps[2] = { step: 'workspace-source-resolution', ok: probeWsResolvable, detail: probeWsResolvable ? probeWsReal : 'the probe workspace could not be resolved on the host' };
    const failedIdx = typeof result.code === 'number' ? stepFor(result.code) : 0;
    if (steps[failedIdx]) {
      steps[failedIdx] = {
        ...steps[failedIdx],
        detail: `exit ${result.code}${result.killed ? ' (timeout)' : ''}${result.stderr ? ` — ${result.stderr.trim().slice(0, 160)}` : ''}`,
      };
    } else {
      steps[0] = { ...steps[0], detail: `exit ${result.code}${result.killed ? ' (timeout)' : ''}${result.stderr ? ` — ${result.stderr.trim().slice(0, 160)}` : ''}` };
    }
    return { passed: false, steps, detail: typeof result.code === 'number' ? `probe step "${steps[failedIdx]?.step ?? 'namespace-creation'}" failed (exit ${result.code})` : `probe failed (${result.code})` };
  } catch (err) {
    return { passed: false, steps, detail: `probe error: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}` };
  } finally {
    await fsp.rm(probeRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

let probePromise: Promise<void> | null = null;

/**
 * Probe the OS-sandbox capability ONCE: capability is measured, never assumed, and the
 * probe exercises the REAL mount construction (Round 34 §2.2) — not a simple
 * process-launch check. A failed probe produces `verified-bounded`, NEVER `os-sandbox`.
 */
export function probeShellIsolation(): Promise<void> {
  if (probePromise) return probePromise;
  probePromise = (async () => {
    capability.probed = true;
    if (process.platform === 'win32') {
      capability.mode = 'verified-bounded';
      capability.mechanism = 'verified-bounded command pathway';
      capability.warning =
        'Unrestricted OS-level shell isolation is UNAVAILABLE on this platform (no sandbox mechanism reachable from Node). ' +
        'Project-bound shell commands run through the verified-bounded pathway: only strictly-safe inspection/filesystem commands with verified in-project targets are executed; commands that execute code (node, python, npm, scripts) are REFUSED. ' +
        'This is not a kernel sandbox. Install nothing to fix this on Windows — run code-executing work as non-project work.';
      return;
    }
    if (process.platform === 'darwin') {
      capability.mode = 'verified-bounded';
      capability.mechanism = 'verified-bounded command pathway';
      capability.warning =
        'OS-level shell isolation is unavailable on this platform (sandbox-exec is deprecated and seatbelt profiles are not safely generatable per-command). ' +
        'Project-bound commands run through the verified-bounded pathway; only strictly-safe commands are executed and everything else is refused.';
      return;
    }
    const bin = await findBubblewrap();
    if (!bin) {
      capability.mode = 'verified-bounded';
      capability.mechanism = 'verified-bounded command pathway';
      capability.warning =
        'bubblewrap is not installed on this machine, so kernel-enforced shell isolation is unavailable. ' +
        'Project-bound commands run through the verified-bounded pathway: only strictly-safe inspection/filesystem commands with verified in-project targets are executed; commands that execute code (node, python, npm, scripts) are REFUSED. ' +
        'Install bubblewrap for kernel-enforced isolation.';
      return;
    }
    const probe = await runMountProbe(bin);
    capability.probe = { passed: probe.passed, steps: probe.steps, at: Date.now() };
    if (probe.passed) {
      capability.mode = 'os-sandbox';
      capability.mechanism = 'bubblewrap mount namespace (REAL mount-layout probe passed: workspace bind, write access, isolation, cwd, child inheritance)';
      capability.warning = undefined;
    } else {
      capability.mode = 'verified-bounded';
      capability.mechanism = 'verified-bounded command pathway';
      capability.warning =
        `bubblewrap is installed but the REAL mount-layout probe FAILED (${probe.detail ?? 'unknown step'}), so kernel-enforced shell isolation is NOT available — it is never claimed from argv construction or a simple launch probe. ` +
        'Project-bound commands run through the verified-bounded pathway; only strictly-safe commands are executed and everything else is refused. ' +
        'Inspect the per-step probe result in the Operations Center (user namespaces may be disabled).';
    }
  })();
  return probePromise;
}

/** The honest residual note attached to verified-bounded executions (never claimed as a sandbox). */
export const boundedPathwayNote = (): string =>
  'verified-bounded: strictly-safe executables, working directory and filesystem targets verified inside the project; code-executing tools REFUSED; NOT a kernel sandbox';
