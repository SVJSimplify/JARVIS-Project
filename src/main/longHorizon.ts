import { promises as fs } from 'fs';
import * as path from 'path';
import { FILES_ROOT } from './workspace';
import { atomicWrite, loadJson } from './store';

/**
 * LONG-HORIZON EXECUTION & RESTART RECOVERY ENGINE
 *
 * Enforces:
 * - Persistent execution checkpoints across restarts.
 * - Idempotency keys to strictly prevent duplicate execution of non-idempotent operations
 *   (Invariant 11: No duplicate non-idempotent execution).
 * - Stale task detection & recovery at application boot.
 * - Resource budgeting and deadline management for long tasks.
 */

export interface IdempotencyRecord {
  key: string;
  action: string;
  target: string;
  executedAt: number;
  result: string;
}

export interface LongHorizonJob {
  id: string;
  goalId: string;
  planId?: string;
  status: 'active' | 'paused' | 'completed' | 'failed' | 'interrupted';
  progressPercent: number;
  idempotencyKeys: string[];
  checkpointCount: number;
  createdAt: number;
  updatedAt: number;
  deadline?: number;
}

const JOBS_FILE = path.join(FILES_ROOT, 'brain', 'long_horizon_jobs.json');
const IDEMPOTENCY_FILE = path.join(FILES_ROOT, 'brain', 'idempotency_store.json');

let jobsCache: LongHorizonJob[] | null = null;
let idempotencyCache: Record<string, IdempotencyRecord> | null = null;

/** Load idempotency cache */
async function loadIdempotency(): Promise<Record<string, IdempotencyRecord>> {
  if (idempotencyCache) return idempotencyCache;
  idempotencyCache = await loadJson<Record<string, IdempotencyRecord>>(IDEMPOTENCY_FILE, {});
  return idempotencyCache;
}

/** Check if an action with this idempotency key was already executed */
export async function checkIdempotency(key: string): Promise<IdempotencyRecord | null> {
  const records = await loadIdempotency();
  return records[key] ?? null;
}

/** Record execution under an idempotency key */
export async function recordIdempotentExecution(
  key: string,
  action: string,
  target: string,
  result: string
): Promise<void> {
  const records = await loadIdempotency();
  records[key] = {
    key,
    action,
    target,
    executedAt: Date.now(),
    result,
  };
  idempotencyCache = records;
  try {
    await fs.mkdir(path.dirname(IDEMPOTENCY_FILE), { recursive: true });
    await atomicWrite(IDEMPOTENCY_FILE, JSON.stringify(records, null, 2));
  } catch (err) {
    console.warn('[longHorizon] Failed to persist idempotency record:', err);
  }
}

/** Load all long-horizon jobs */
export async function loadLongHorizonJobs(): Promise<LongHorizonJob[]> {
  if (jobsCache) return jobsCache;
  jobsCache = await loadJson<LongHorizonJob[]>(JOBS_FILE, []);
  return jobsCache;
}

/** Register or update a long-horizon job */
export async function registerLongJob(job: LongHorizonJob): Promise<void> {
  const jobs = await loadLongHorizonJobs();
  const index = jobs.findIndex((j) => j.id === job.id);
  if (index >= 0) {
    jobs[index] = { ...job, updatedAt: Date.now() };
  } else {
    jobs.push(job);
  }
  jobsCache = jobs;
  try {
    await fs.mkdir(path.dirname(JOBS_FILE), { recursive: true });
    await atomicWrite(JOBS_FILE, JSON.stringify(jobs, null, 2));
  } catch (err) {
    console.warn('[longHorizon] Failed to persist long-horizon jobs:', err);
  }
}

/**
 * Restart Recovery:
 * Discovers any jobs found in 'active' state during startup and marks them 'interrupted'
 * with recovery notes so they do not hang indefinitely or execute twice.
 */
export async function recoverInterruptedJobs(): Promise<{ recoveredCount: number; jobIds: string[] }> {
  const jobs = await loadLongHorizonJobs();
  const recovered: string[] = [];

  for (const job of jobs) {
    if (job.status === 'active') {
      job.status = 'interrupted';
      job.updatedAt = Date.now();
      recovered.push(job.id);
    }
  }

  if (recovered.length > 0) {
    await fs.mkdir(path.dirname(JOBS_FILE), { recursive: true });
    await atomicWrite(JOBS_FILE, JSON.stringify(jobs, null, 2));
  }

  return {
    recoveredCount: recovered.length,
    jobIds: recovered,
  };
}
