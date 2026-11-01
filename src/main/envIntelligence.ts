import { exec } from 'child_process';
import * as os from 'os';
import { promisify } from 'util';
import { FILES_ROOT } from './workspace';

const execAsync = promisify(exec);

/**
 * ENVIRONMENTAL INTELLIGENCE ENGINE
 *
 * Enforces:
 * "JARVIS should understand relevant information about: files, projects,
 * applications, processes, browser state, available tools, installed dependencies,
 * current task state, environment changes.
 * Refresh stale information before consequential actions."
 */

export interface EnvSnapshot {
  timestamp: number;
  platform: string;
  arch: string;
  cpus: number;
  totalMemoryMb: number;
  freeMemoryMb: number;
  workspacePath: string;
  runtimes: {
    node: boolean;
    python: boolean;
    git: boolean;
  };
  activeProcesses: string[];
}

let cachedSnapshot: EnvSnapshot | null = null;
let lastSnapshotAt = 0;
const SNAPSHOT_TTL_MS = 60_000; // 60 seconds TTL

/** Check if command is available on host without throwing */
async function hasCommand(cmd: string): Promise<boolean> {
  try {
    const isWin = process.platform === 'win32';
    const checkCmd = isWin ? `where ${cmd}` : `which ${cmd}`;
    await execAsync(checkCmd, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** Collect current system and environment state snapshot */
export async function getEnvironmentSnapshot(forceRefresh = false): Promise<EnvSnapshot> {
  const now = Date.now();
  if (!forceRefresh && cachedSnapshot && now - lastSnapshotAt < SNAPSHOT_TTL_MS) {
    return cachedSnapshot;
  }

  const [hasNode, hasPy, hasGit] = await Promise.all([
    hasCommand('node'),
    hasCommand('python'),
    hasCommand('git'),
  ]);

  const snapshot: EnvSnapshot = {
    timestamp: now,
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
    freeMemoryMb: Math.round(os.freemem() / (1024 * 1024)),
    workspacePath: FILES_ROOT,
    runtimes: {
      node: hasNode,
      python: hasPy,
      git: hasGit,
    },
    activeProcesses: [],
  };

  cachedSnapshot = snapshot;
  lastSnapshotAt = now;
  return snapshot;
}

/** Formats environment status for prompt context or status briefing */
export async function formatEnvPrompt(forceRefresh = false): Promise<string> {
  const env = await getEnvironmentSnapshot(forceRefresh);
  const runtimeList = Object.entries(env.runtimes)
    .map(([name, ok]) => `${name}: ${ok ? 'installed' : 'absent'}`)
    .join(', ');

  return (
    `[ENVIRONMENT STATE]: OS: ${env.platform}-${env.arch} (${env.cpus} cores, ${env.freeMemoryMb}MB / ${env.totalMemoryMb}MB free). ` +
    `Runtimes: ${runtimeList}. Workspace: ${env.workspacePath}`
  );
}
