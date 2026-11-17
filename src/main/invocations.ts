/**
 * THE INVOCATION LEDGER (Round 23) — the complete, task-scoped record of every tool
 * invocation, replacing the "recent window" as the source of truth for activity counts
 * and history.
 *
 * WHY IT EXISTS: before Round 23 the only views of tool activity were (a) the modes.ts
 * ring, which keeps the last 200 events and serves a fresh subscriber only the last 100,
 * and (b) the turn checklist in progress.ts, which keeps the newest 30 steps and computes
 * its counters from that capped array. A 120-tool turn froze at "30 done", earlier rows
 * vanished, and nothing on the wire said WHICH task produced an event — so follow-up
 * prompts and durable-task work could not be scoped, and the interface appeared to stop
 * updating. This module fixes all of it at the root:
 *
 *  - EVERY invocation is recorded once (keyed by its correlation id), with its real
 *    terminal state, timestamps and duration — no silent loss, no arbitrary ceiling.
 *  - Records are grouped by execution scope: the durable task that ran them (taskId),
 *    the conversational turn that caused them (turn-N), or the pre-turn session.
 *  - Per-scope aggregates are maintained incrementally, so the live header summary is an
 *    O(1) read no matter how long the history grows.
 *
 * IT IS AN OBSERVER, NOT AN AUTHORITY: it only consumes the activity events the
 * execution engine already emits (wired at the modes.ts onEvent injection point next to
 * the progress mirror, see index.ts). It can never start, retry or authorize anything.
 * It stores the same clipped summaries the feed already shows (argPreview / clipText
 * conventions) — never raw arguments, never results, never credentials.
 *
 * Electron-free like modes.ts/progress.ts: unit tests need no mocks.
 */

import type { ActivityEvent } from './protocol';

// ------------------------------------------------------------------ wire types

/** Observable invocation states. 'pending' is a PLANNED step (task board); an invocation
 *  record exists only from the moment the engine actually started the call. */
export type InvocationState = 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked';

/** One recorded tool invocation. `detail` is the engine's own clipped, one-line summary. */
export interface InvocationRecord {
  /** modes.ts sequence id of the FIRST event seen for this invocation. */
  id: number;
  /** Tool-call correlation id: start and result share one. */
  cid: string;
  /** Durable task that owns the call, when one exists. */
  taskId?: string;
  /** Resolved tool name; `requested` keeps the original spelling when it differed. */
  tool: string;
  requested?: string;
  state: InvocationState;
  /** Epoch ms of the first event. */
  startedAt: number;
  /** Epoch ms of the terminal event, once terminal. */
  endedAt?: number;
  /** Wall-clock duration from the engine, when reported. */
  ms?: number;
  /** Latest clipped detail line (argument preview / outcome summary — feed conventions). */
  detail?: string;
}

export interface InvocationSummary {
  /** Stable scope key the summary describes. */
  scope: string;
  /** 'task' scopes are durable tasks, 'turn' scopes are conversational turns, 'session' predates both. */
  scopeKind: 'task' | 'turn' | 'session';
  /** Distinct tools used. */
  tools: number;
  /** Total invocations. */
  calls: number;
  running: number;
  completed: number;
  failed: number;
  blocked: number;
  cancelled: number;
  /** Epoch ms of the newest event seen in this scope (0 when empty). */
  lastAt: number;
}

export interface ActivityScopeInfo extends InvocationSummary {
  /** Human-readable label (task id, "turn N", or "session"). */
  label: string;
}

export interface InvocationQuery {
  scope?: string;
  offset: number;
  limit: number;
  total: number;
  /** Oldest → newest; the client reverses for display. */
  records: InvocationRecord[];
}

// ------------------------------------------------------------------ module state

const SESSION = 'session';
/** Sentinel scope meaning “every scope in this session” (Settings → Activity picker). */
export const ALL_SCOPES = 'all';
const ALL = ALL_SCOPES;

/** Per-scope ledger: insertion-ordered records (oldest first) + incremental aggregates. */
interface ScopeLedger {
  key: string;
  kind: 'task' | 'turn' | 'session';
  records: InvocationRecord[];
  byCid: Map<string, InvocationRecord>;
  /** Highest event id folded into each cid — duplicate/out-of-order delivery is idempotent. */
  lastEvent: Map<string, number>;
  counts: Record<InvocationState, number>;
  tools: Map<string, number>;
  lastAt: number;
}

const TERMINAL: ReadonlySet<InvocationState> = new Set(['completed', 'failed', 'cancelled', 'blocked']);

const ledgers = new Map<string, ScopeLedger>();
let seqTurn = 0;
/** Scope that received the most recent event — the live header summary follows it. */
let activeScope = SESSION;
let activeScopeVersion = 0;
/** Push sink wired from index.ts so the summary can announce scope changes cheaply; optional. */
let notifySummary: (() => void) | null = null;

const freshCounts = (): Record<InvocationState, number> => ({ running: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0 });

function ledgerFor(key: string, kind: ScopeLedger['kind']): ScopeLedger {
  let l = ledgers.get(key);
  if (!l) {
    l = { key, kind, records: [], byCid: new Map(), lastEvent: new Map(), counts: freshCounts(), tools: new Map(), lastAt: 0 };
    ledgers.set(key, l);
  }
  return l;
}

const stateOfEvent = (e: ActivityEvent): InvocationState => {
  if (e.blocked) return 'blocked';
  if (e.cancelled) return 'cancelled';
  if (e.status === 'ok') return 'completed';
  if (e.status === 'fail') return 'failed';
  return 'running';
};

const kindOfScope = (key: string): ScopeLedger['kind'] => (key === SESSION ? 'session' : key.startsWith('turn-') ? 'turn' : 'task');

// ------------------------------------------------------------------ ingestion

/**
 * Fold one activity event into the ledger. Only real tool invocations are recorded;
 * every other kind (progress notes, mode flips, held speech) is ignored. Safe to call
 * with anything the mirror sees: malformed shapes are dropped, duplicate or late events
 * are idempotent (per-record event-id water mark; terminal states only move forward to
 * a strictly newer terminal event, never backwards).
 */
export function noteInvocationEvent(e: ActivityEvent): void {
  try {
    if (!e || typeof e !== 'object') return;
    if (e.kind !== 'tool' || typeof e.label !== 'string' || !e.label) return;
    if (typeof e.id !== 'number' || !Number.isFinite(e.id)) return;
    const cid = typeof e.cid === 'string' && e.cid ? e.cid : `anon-${e.id}`;
    const scope = typeof e.taskId === 'string' && e.taskId ? e.taskId : activeScope;
    const l = ledgerFor(scope, kindOfScope(scope));
    const t = typeof e.t === 'number' && Number.isFinite(e.t) ? e.t : Date.now();
    const state = stateOfEvent(e);
    const found = l.byCid.get(cid);
    if (!found) {
      const rec: InvocationRecord = {
        id: e.id,
        cid,
        ...(e.taskId ? { taskId: e.taskId } : {}),
        tool: e.label,
        state,
        startedAt: t,
        ...(e.detail !== undefined ? { detail: e.detail } : {}),
        ...(typeof e.ms === 'number' ? { ms: e.ms } : {}),
        ...(state !== 'running' ? { endedAt: t } : {}),
      };
      l.records.push(rec);
      l.byCid.set(cid, rec);
      l.lastEvent.set(cid, e.id);
      l.counts[state]++;
      l.tools.set(rec.tool, (l.tools.get(rec.tool) ?? 0) + 1);
    } else {
      const lastId = l.lastEvent.get(cid) ?? found.id;
      if (e.id <= lastId) return; // duplicate or stale replay — nothing to change
      l.lastEvent.set(cid, e.id);
      if (TERMINAL.has(found.state)) {
        // Terminal states only refine to a strictly NEWER terminal event (e.g. a blocked
        // correction after a transport failure) — never backwards, never to running.
        if (!TERMINAL.has(state)) return;
        l.counts[found.state]--;
        l.counts[state]++;
        found.state = state;
        if (typeof e.ms === 'number') found.ms = e.ms;
        if (e.detail !== undefined) found.detail = e.detail;
        found.endedAt = t;
      } else {
        if (state !== 'running') {
          // running → terminal: move the aggregate counters, not just the record.
          l.counts.running--;
          l.counts[state]++;
          found.endedAt = t;
        }
        found.state = state;
        if (e.detail !== undefined) found.detail = e.detail;
        if (typeof e.ms === 'number' && e.ms >= 0) found.ms = e.ms;
      }
    }
    l.lastAt = Math.max(l.lastAt, t);
    activeScope = scope;
    activeScopeVersion++;
    // Stamp the scope onto the event itself: the mirror runs BEFORE the modes.ts feed
    // push, so the renderer receives every tool event already tagged with the scope it
    // belongs to — live pushes are filterable per task/prompt on the wire.
    (e as { scope?: string }).scope = scope;
    notifySummary?.();
  } catch {
    /* the ledger must never break the execution it observes */
  }
}

/** A new conversational turn opens a fresh scope: every follow-up prompt starts with a
 *  clean activity context (its own turn-N bucket), while all previous scopes stay
 *  queryable. Wired from the modes.ts onTurn 'start' hook in index.ts. */
export function openInvocationTurnScope(): string {
  try {
    seqTurn++;
    activeScope = `turn-${seqTurn}`;
    activeScopeVersion++;
    ledgerFor(activeScope, 'turn');
    notifySummary?.();
    return activeScope;
  } catch {
    return `turn-${seqTurn}`;
  }
}

// ------------------------------------------------------------------ reads

const summaryOf = (l: ScopeLedger): InvocationSummary => ({
  scope: l.key,
  scopeKind: l.kind,
  tools: l.tools.size,
  calls: l.records.length,
  running: l.counts.running,
  completed: l.counts.completed,
  failed: l.counts.failed,
  blocked: l.counts.blocked,
  cancelled: l.counts.cancelled,
  lastAt: l.lastAt,
});

/** The scope the live summary follows: the newest scope with a running invocation, else
 *  the most recently active one. A fresh turn (empty bucket) is active from turn start,
 *  so follow-up prompts begin with a clean summary instead of the previous task's. */
export function activeInvocationScope(): string {
  if (ledgers.get(activeScope)?.counts.running) return activeScope;
  for (const l of ledgers.values()) {
    if (l.counts.running > 0) return l.key;
  }
  return activeScope;
}

export function invocationSummary(scope?: string): InvocationSummary {
  const key = scope ?? activeInvocationScope();
  if (key === ALL) {
    // Aggregate across every scope in the session (Settings → Activity “All scopes”).
    const out = { scope: ALL, scopeKind: 'session' as const, tools: 0, calls: 0, running: 0, completed: 0, failed: 0, blocked: 0, cancelled: 0, lastAt: 0 };
    const toolNames = new Set<string>();
    for (const l of ledgers.values()) {
      out.calls += l.records.length;
      for (const name of l.tools.keys()) toolNames.add(name);
      for (const st of Object.keys(l.counts) as InvocationState[]) out[st] += l.counts[st];
      out.lastAt = Math.max(out.lastAt, l.lastAt);
    }
    out.tools = toolNames.size;
    return out;
  }
  const l = ledgers.get(key);
  return l ? summaryOf(l) : { scope: key, scopeKind: kindOfScope(key), tools: 0, calls: 0, running: 0, completed: 0, failed: 0, blocked: 0, cancelled: 0, lastAt: 0 };
}

/** All scopes with at least one record (newest activity first) — the Settings picker. */
export function invocationScopes(): ActivityScopeInfo[] {
  const out = [...ledgers.values()].filter((l) => l.records.length > 0).map(summaryOf);
  out.sort((a, b) => b.lastAt - a.lastAt || a.scope.localeCompare(b.scope));
  return out.map((s) => ({ ...s, label: s.scopeKind === 'turn' ? `prompt ${s.scope.replace('turn-', '#')}` : s.scope }));
}

/** Paged, ordered, lossless history. `scope: 'all'` serves every scope merged by start
 *  order. Inputs are re-validated (IPC boundary discipline); limit caps at 500. */
export function queryInvocations(opts: { scope?: unknown; offset?: unknown; limit?: unknown }): InvocationQuery {
  const scope = typeof opts.scope === 'string' && opts.scope ? opts.scope : undefined;
  let records: InvocationRecord[];
  if (scope === ALL) {
    records = [...ledgers.values()].flatMap((l) => l.records).sort((a, b) => a.startedAt - b.startedAt || a.id - b.id);
  } else {
    const l = scope ? ledgers.get(scope) : ledgers.get(activeInvocationScope());
    records = l?.records ?? [];
  }
  const total = records.length;
  let offset = typeof opts.offset === 'number' && Number.isFinite(opts.offset) ? Math.max(0, Math.floor(opts.offset)) : 0;
  let limit = typeof opts.limit === 'number' && Number.isFinite(opts.limit) ? Math.floor(opts.limit) : 100;
  if (limit > 500) limit = 500;
  if (limit < 1) limit = 1;
  if (offset > total) offset = total;
  return { scope: scope ?? activeInvocationScope(), offset, limit, total, records: records.slice(offset, offset + limit) };
}

// ------------------------------------------------------------------ wiring & tests

/** Optional sink poked whenever the active scope changes (index.ts re-pushes the snapshot). */
export const setInvocationNotifier = (fn: (() => void) | null): void => {
  notifySummary = fn;
};

/** Version counter for cheap change detection (tests / change coalescing). */
export const invocationScopeVersion = (): number => activeScopeVersion;

/** Test helper: reset every piece of module state. */
export function resetInvocationsForTests(): void {
  ledgers.clear();
  seqTurn = 0;
  activeScope = SESSION;
  activeScopeVersion = 0;
}
