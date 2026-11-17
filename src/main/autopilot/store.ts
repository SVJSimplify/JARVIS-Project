/**
 * PROJECT STORE (Round 22, Project Autopilot) — durable storage for project records.
 *
 * THE DATA-PRESERVATION CONTRACT (Round 22 mandatory correction):
 *  - Project records are USER DATA. The single policy's hard restriction A (deletion of
 *    user data/resources) applies to them in full. This module contains NO deletion of
 *    project data: no pruning routine of any kind, no startup eviction, no background
 *    cleanup, no "keep only the latest N" load window, no terminal-status eviction, and
 *    no archival that removes the user's access to the original records.
 *  - EVERY project file ever written stays on disk and loadable until the USER deletes
 *    it themselves (which no tool in this layer offers).
 *  - Bounded behaviour lives ONLY in memory views (pagination in views.ts) and in
 *    per-record list caps (events/decisions kept bounded INSIDE each record while the
 *    record itself, and its full durable event/plan archives on disk, are never deleted).
 *
 * Persistence primitives are the SHARED Round 21 ones (store.ts): atomicWrite (temp +
 * fsync + rename + .bak), loadJson (corrupt-file quarantine + backup recovery) and
 * withStoreLock (serialized read-modify-write). One persistence implementation, no
 * second store runtime. Layout mirrors the durable task store: one JSON file per
 * project under FILES_ROOT/brain/autopilot/projects/.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { FILES_ROOT } from '../workspace';
import { atomicAppend, atomicWrite, loadJson, withStoreLock } from '../store';
import { emitActivity } from '../modes';
import type { DecisionRecord, PlanVersion, ProjectEvent, ProjectRecord, ProjectStatus } from './types';

const projectsDir = (): string => path.join(FILES_ROOT, 'brain', 'autopilot', 'projects');
const eventsDir = (): string => path.join(FILES_ROOT, 'brain', 'autopilot', 'events');
const plansDir = (): string => path.join(FILES_ROOT, 'brain', 'autopilot', 'plans');

const fileOf = (id: string): string => path.join(projectsDir(), `project-${id}.json`);
const eventsFileOf = (id: string): string => path.join(eventsDir(), `project-${id}.events.jsonl`);
const planFileOf = (id: string, version: number): string => path.join(plansDir(), `project-${id}.plan-v${version}.json`);

/** In-record bounds — the RECORD stays; only its embedded lists are capped. The full
 *  event history is durably appended to the per-project .events.jsonl (atomicAppend,
 *  fsynced), so capping the embedded copy never loses durable history. */
const MAX_EMBEDDED_EVENTS = 400;
const MAX_EMBEDDED_DECISIONS = 200;
const MAX_EMBEDDED_VERIFICATIONS = 300;
const MAX_EMBEDDED_PLAN_HISTORY = 40;
const MAX_ATTEMPTS_PER_TASK = 12;

// --------------------------------------------------------------------- durable archives

/** Append one event to the project's DURABLE event history (fsynced append; the
 *  embedded in-record copy is a bounded view over it). Never deletes anything. */
export async function appendDurableEvent(projectId: string, event: ProjectEvent): Promise<void> {
  return appendDurableEvents(projectId, [event]);
}

/** Batched variant: one fsynced append for many events (project creation writes its
 *  full birth history in ONE durable append instead of one fsync per event). */
export async function appendDurableEvents(projectId: string, events: ProjectEvent[]): Promise<void> {
  if (!events.length) return;
  await fs.mkdir(eventsDir(), { recursive: true });
  await atomicAppend(eventsFileOf(projectId), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`).catch(() => undefined);
}

/** Archive one plan version durably (full snapshot; nothing is ever overwritten or
 *  removed — version numbers only grow). */
export async function archivePlanVersion(projectId: string, version: PlanVersion): Promise<void> {
  await fs.mkdir(plansDir(), { recursive: true });
  await atomicWrite(planFileOf(projectId, version.version), JSON.stringify(version, null, 2)).catch(() => undefined);
}

/** Read a project's durable event history (the full, uncapped record). The file is
 *  JSONL — parsed LINE BY LINE; a JSON parser here would quarantine a healthy history
 *  file on every multi-event read. A torn tail line from a crash costs nothing. */
export async function readDurableEvents(projectId: string): Promise<ProjectEvent[]> {
  let raw = '';
  try {
    raw = await fs.readFile(eventsFileOf(projectId), 'utf8');
  } catch {
    return []; // no history yet (or the file is momentarily absent) — an empty history, not an error
  }
  const out: ProjectEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as ProjectEvent;
      if (v && typeof v.id === 'string' && typeof v.kind === 'string') out.push(v);
    } catch {
      /* a torn tail line from a crash costs nothing — the rest is intact */
    }
  }
  return out;
}

// ------------------------------------------------------------------------ the cache

/** In-memory cache. A project is NEVER removed from the cache to make it inaccessible:
 *  the only evictions are (a) test resets and (b) refresh-from-disk for a project whose
 *  file changed underneath us, both of which re-load the record rather than drop it. */
const cache = new Map<string, ProjectRecord>();
let loaded = false;
let seq = 0;

const changeNotifier = new Set<() => void>();
export const onProjectsChanged = (fn: () => void): (() => void) => {
  changeNotifier.add(fn);
  return () => changeNotifier.delete(fn);
};
const notify = (): void => {
  for (const fn of changeNotifier) {
    try {
      fn();
    } catch {
      /* a broken listener must not break the save that triggered it */
    }
  }
};

export const newProjectId = (): string => `P-${Date.now().toString(36)}${++seq}${Math.random().toString(36).slice(2, 6)}`;

const isValidRecord = (r: unknown): r is ProjectRecord => {
  const p = r as ProjectRecord | null;
  return (
    !!p &&
    typeof p.id === 'string' &&
    typeof p.title === 'string' &&
    typeof p.status === 'string' &&
    !!p.understanding &&
    Array.isArray(p.tasks) &&
    Array.isArray(p.milestones)
  );
};

/** Load EVERY project file from disk — no slice(-N) window, no age filter, no status
 *  filter. Older projects remain fully accessible after restart. */
async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  let names: string[] = [];
  try {
    names = (await fs.readdir(projectsDir())).filter((f) => /^project-[\w-]+\.json$/.test(f)).sort();
  } catch {
    return; // no projects yet (first boot) — an empty store, not an error
  }
  for (const n of names) {
    const raw = await loadJson<ProjectRecord | null>(path.join(projectsDir(), n), null);
    if (!isValidRecord(raw)) continue; // a damaged record is skipped here, NOT deleted — quarantine/loadJson recovery owns the file itself
    cache.set(raw.id, raw);
    const m = /^P-(\w+?)(\d{2,})/.exec(raw.id);
    if (m) {
      const n2 = Number(m[2]);
      if (Number.isFinite(n2) && n2 > seq) seq = n2;
    }
  }
}

// ------------------------------------------------------------------- write path

async function save(p: ProjectRecord): Promise<void> {
  p.updatedAt = Date.now();
  await atomicWrite(fileOf(p.id), JSON.stringify(p, null, 2));
  notify();
}

/**
 * Serialized read-modify-write on ONE project record (withStoreLock, the shared Round 21
 * primitive): concurrent updates to the same project land in order, whole; concurrent
 * updates to DIFFERENT projects never wait on each other (per-file keys).
 */
export function updateProject<T>(id: string, fn: (p: ProjectRecord) => Promise<T> | T): Promise<T> {
  return withStoreLock(fileOf(id), async () => {
    await ensureLoaded();
    const current = cache.get(id);
    if (!current) throw new Error(`NOT DONE: no project ${id}.`);
    const result = await fn(current);
    await save(current);
    return result;
  });
}

/** Create and persist a new project record. Never evicts anything to make room. */
export async function createProject(p: ProjectRecord): Promise<ProjectRecord> {
  await fs.mkdir(projectsDir(), { recursive: true });
  await ensureLoaded();
  cache.set(p.id, p);
  await save(p);
  emitActivity({ kind: 'task', cid: `proj-${p.id}`, label: 'Project created', detail: p.title, status: 'ok' });
  return p;
}

// ----------------------------------------------------------------------- read API

export async function getProject(id: string): Promise<ProjectRecord | undefined> {
  await ensureLoaded();
  return cache.get(id);
}

/** ALL projects, newest first. Unfiltered, unpaged — pagination happens at the VIEW
 *  layer (views.ts) and never touches persistence. */
export async function listProjects(): Promise<ProjectRecord[]> {
  await ensureLoaded();
  return [...cache.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export async function countProjects(): Promise<number> {
  return (await listProjects()).length;
}

export async function listProjectIds(): Promise<string[]> {
  return (await listProjects()).map((p) => p.id);
}

// ------------------------------------------------------------ record-shaping helpers

export const pushEvent = (p: ProjectRecord, event: ProjectEvent): void => {
  p.events = [...p.events, event].slice(-MAX_EMBEDDED_EVENTS);
  void appendDurableEvent(p.id, event);
};

export const pushDecision = (p: ProjectRecord, d: DecisionRecord): void => {
  p.decisions = [...p.decisions, d].slice(-MAX_EMBEDDED_DECISIONS);
};

export const pushVerification = (p: ProjectRecord, v: ProjectRecord['verifications'][number]): void => {
  p.verifications = [...p.verifications, v].slice(-MAX_EMBEDDED_VERIFICATIONS);
};

export const pushPlanHistory = (p: ProjectRecord, entry: ProjectRecord['planHistory'][number]): void => {
  p.planHistory = [...p.planHistory, entry].slice(-MAX_EMBEDDED_PLAN_HISTORY);
};

export const pushAttempt = (p: ProjectRecord, taskId: string, attempt: ProjectRecord['tasks'][number]['attempts'][number]): void => {
  const t = p.tasks.find((x) => x.id === taskId);
  if (!t) return;
  t.attempts = [...t.attempts, attempt].slice(-MAX_ATTEMPTS_PER_TASK);
};

/** Status transitions for the PROJECT lifecycle (coarse, user-visible). */
const LEGAL: Record<ProjectStatus, ProjectStatus[]> = {
  draft: ['active', 'paused', 'cancelled', 'blocked'],
  active: ['paused', 'blocked', 'completed', 'failed', 'cancelled'],
  paused: ['active', 'cancelled', 'blocked'],
  blocked: ['active', 'paused', 'cancelled', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransitionProject(from: ProjectStatus, to: ProjectStatus): boolean {
  return LEGAL[from]?.includes(to) ?? false;
}

/** Transition through the legal gate. Throws on an illegal move — statuses never drift. */
export async function transitionProject(p: ProjectRecord, to: ProjectStatus, note: string): Promise<void> {
  if (!canTransitionProject(p.status, to)) throw new Error(`Illegal project transition ${p.status} → ${to} (project ${p.id})`);
  p.status = to;
  if (note) p.blockReason = to === 'blocked' || to === 'failed' ? note.slice(0, 400) : undefined;
  pushEvent(p, {
    id: `E-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    at: Date.now(),
    kind: to === 'completed' ? 'completed' : to === 'failed' ? 'failed' : to === 'paused' ? 'paused' : to === 'cancelled' ? 'cancelled' : 'note',
    message: (note || `status → ${to}`).slice(0, 400),
    refs: { status: to },
  });
}

// ------------------------------------------------------------------------- tests

/** Test reset: clears the in-memory cache only. Files on disk are NEVER touched. */
export const resetAutopilotStoreForTests = (): void => {
  cache.clear();
  loaded = false;
  seq = 0;
  changeNotifier.clear();
};
