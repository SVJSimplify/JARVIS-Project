import { runProcess } from './execution/ProcessRunner';
import { executionSignal } from './toolResult';

/**
 * PROCESS IDENTITY (F-05).
 *
 * The protected-process policy is name-shaped: a pid means nothing to a classifier until
 * it is resolved to the program it actually runs. This module is the ONE pid→name
 * resolver; the authorization gate uses it BEFORE any stop/kill decision, so a pid call
 * gets exactly the same protection as a name call — and JARVIS itself is protected
 * regardless of how it is addressed.
 *
 * Fail-closed contract: when the identity of a pid cannot be verified (lookup error,
 * unknown pid, non-Windows host), the caller must refuse the stop. Tests inject a
 * resolver with setPidNameResolver; production uses tasklist.
 */

type PidResolver = (pid: number) => Promise<string | null>;

let override: PidResolver | null = null;

/** Test/di hook: replace the pid→name resolver (pass null to restore the default). */
export const setPidNameResolver = (fn: PidResolver | null): void => {
  override = fn;
};

/** Resolve a pid to its lowercased executable name (without .exe), or null when it cannot be verified. */
export async function resolveProcessName(pid: number): Promise<string | null> {
  if (override) {
    // The fail-closed contract covers injected resolvers too: a resolver error means
    // "identity unknown", never "kill anyway".
    try {
      return await override(pid);
    } catch {
      return null;
    }
  }
  try {
    if (process.platform !== 'win32') return null;
    const result = await runProcess({
      executable: 'tasklist',
      args: ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      cwd: process.cwd(),
      timeoutMs: 8_000,
      queueTimeoutMs: 8_000,
      maxOutputBytes: 128 * 1024,
      resource: 'system',
      signal: executionSignal(),
    });
    if (result.status !== 'success') return null;
    const stdout = result.stdout;
    const line = stdout.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
    if (line.toLowerCase().startsWith('info:')) return null; // no such pid
    const name = line
      .replace(/^"|"$/g, '')
      .split('","')[0]
      ?.toLowerCase()
      .replace(/\.exe$/, '')
      ?? '';
    return name || null;
  } catch {
    return null;
  }
}

/** Back-compat alias (Round 17 name) — one resolver, one identity. */
export const resolvePidName = resolveProcessName;

/** True when the pid belongs to this JARVIS process itself. */
export const isJarvisPid = (pid: number): boolean => pid === process.pid;
