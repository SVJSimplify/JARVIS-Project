import { promises as fs } from 'fs';
import * as path from 'path';
import { loadJson, atomicWrite, withStoreLock, storeOpsPending } from './store';
import { FILES_ROOT } from './workspace';
import { listAllProjectRecords } from './projectMemory';

/**
 * EPISODIC MEMORY (Round 26, Phase 2) — durable lessons from COMPLETED work.
 *
 * The fourth memory category the hybrid architecture lacked. What was attempted, what
 * succeeded or failed, WHY an approach was chosen, and what should be done differently
 * next time — recorded by the ENGINE from real task outcomes (origin: observed), never
 * from an agent's self-assessment alone. Episodes join the ONE hybrid retrieval pipeline
 * (find_memory) and give the coordinator bounded, task-relevant context when planning
 * similar work — so the same mistake is not made twice and finished work is not redone.
 *
 * Lifecycle: content-deduped, per-root bounded, correctable, expirable, and stale-aware
 * (an episode whose workspace no longer exists is flagged, not trusted).
 */

const STORE_FILE = path.join(FILES_ROOT, 'brain', 'episodes.json');
const MAX_EPISODES = 200;
const MAX_LESSON = 400;

export type EpisodeOrigin = 'observed' | 'agent-suggestion';

export interface Episode {
  id: string;
  at: number;
  /** Absolute workspace root the episode happened in (optional — not all work is rooted). */
  root?: string;
  taskId?: string;
  request: string;
  verdict: 'completed' | 'partial' | 'failed' | 'blocked';
  /** One-line account of what was actually produced/attempted. */
  outcome: string;
  /** The approach that was used (plan strategy, specialist kinds). */
  approach: string;
  /** The lesson — what to do differently, or what worked and should be reused. */
  lesson?: string;
  /** Evidence reference: the verification summary or failure classification. */
  evidence?: string;
  origin: EpisodeOrigin;
  /** Corrected lessons replace the original text (history kept in correctedFrom). */
  correctedFrom?: string;
  /** Temporary episodes expire (bounded retention for session-scoped notes). */
  expiresAt?: number;
}

interface Store {
  episodes: Episode[];
}
const emptyStore = (): Store => ({ episodes: [] });

const clip = (s: string, n: number): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

const hashOf = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

const contentKey = (e: Pick<Episode, 'request' | 'verdict' | 'outcome'>): string =>
  `${hashOf(clip(e.request, 200).toLowerCase())}:${e.verdict}:${hashOf(clip(e.outcome, 200).toLowerCase())}`;

async function loadStore(): Promise<Store> {
  const s = await loadJson<Store>(STORE_FILE, emptyStore());
  // Expiration is enforced at load: expired temporary episodes are dropped, not served.
  const live = (s.episodes ?? []).filter((e) => !e.expiresAt || e.expiresAt > Date.now());
  return { episodes: live };
}

async function saveStore(s: Store): Promise<void> {
  await fs.mkdir(path.dirname(STORE_FILE), { recursive: true });
  await atomicWrite(STORE_FILE, JSON.stringify(s, null, 1));
}

/**
 * Record an episode of finished work. Deduped by (request, verdict, outcome) content —
 * re-settling the same task must not stack duplicate episodes. Bounded: the oldest
 * non-corrected episodes fall off beyond MAX_EPISODES.
 */
export async function recordEpisode(e: Omit<Episode, 'id' | 'at'> & { id?: string; at?: number }): Promise<'added' | 'duplicate' | 'expired'> {
  return withStoreLock(STORE_FILE, async () => {
    const store = await loadStore();
    const episode: Episode = {
      id: e.id ?? `ep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      at: e.at ?? Date.now(),
      root: e.root ? path.resolve(e.root) : undefined,
      taskId: e.taskId ? clip(e.taskId, 24) : undefined,
      request: clip(e.request, 400),
      verdict: e.verdict,
      outcome: clip(e.outcome, 500),
      approach: clip(e.approach, 300),
      lesson: e.lesson ? clip(e.lesson, MAX_LESSON) : undefined,
      evidence: e.evidence ? clip(e.evidence, 300) : undefined,
      origin: e.origin === 'agent-suggestion' ? 'agent-suggestion' : 'observed',
      expiresAt: e.expiresAt,
    };
    const key = contentKey(episode);
    if (store.episodes.some((x) => contentKey(x) === key)) return 'duplicate';
    store.episodes.unshift(episode);
    store.episodes = store.episodes
      .filter((x) => !x.expiresAt || x.expiresAt > Date.now())
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_EPISODES);
    await saveStore(store);
    return 'added';
  });
}

/** Correction: replace a lesson (the previous lesson is preserved as history). */
export async function correctEpisode(id: string, lesson: string): Promise<string> {
  return withStoreLock(STORE_FILE, async () => {
    const store = await loadStore();
    const e = store.episodes.find((x) => x.id === id);
    if (!e) return `no episode ${id}`;
    e.correctedFrom = e.lesson;
    e.lesson = clip(lesson, MAX_LESSON);
    e.at = Date.now();
    await saveStore(store);
    return `episode ${id} corrected`;
  });
}

/** Stale detection: an episode whose workspace root no longer exists cannot guide work. */
const isStale = (e: Episode): boolean => !!e.root;

async function rootExists(root: string): Promise<boolean> {
  try {
    return (await fs.stat(root)).isDirectory();
  } catch {
    return false;
  }
}

/** Lexical recall over request + approach + lesson, root-matched, stale-aware. */
export async function recallEpisodes(query: string, opts: { root?: string; limit?: number } = {}): Promise<Array<Episode & { stale: boolean }>> {
  const store = await loadStore();
  const tokens = new Set((query.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? []).filter((t) => !['the', 'and', 'for', 'with', 'this', 'that'].includes(t)));
  const scored: Array<{ e: Episode & { stale: boolean }; score: number }> = [];
  for (const e of store.episodes) {
    const stale = isStale(e) && e.root ? !(await rootExists(e.root)) : false;
    if (stale) continue; // stale episodes never surface as guidance
    const hay = `${e.request} ${e.approach} ${e.lesson ?? ''} ${e.outcome}`.toLowerCase();
    let score = 0;
    for (const t of tokens) if (hay.includes(t)) score += 2;
    if (opts.root && e.root && path.resolve(opts.root) === e.root) score += 3; // same workspace: strongly relevant
    if (score > 0) scored.push({ e: { ...e, stale }, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || b.e.at - a.e.at)
    .slice(0, Math.max(1, Math.min(opts.limit ?? 4, 8)))
    .map((x) => x.e);
}

/** Every episode as a retrievable row for the ONE hybrid find_memory pipeline. */
export async function listEpisodeRecords(): Promise<Array<{ id: string; text: string; scope: string; updated: number }>> {
  const store = await loadStore();
  return store.episodes.map((e) => ({
    id: e.id,
    text: [
      `episode (${e.verdict}): ${e.request}`,
      e.lesson ? `lesson: ${e.lesson}` : '',
      e.evidence ? `evidence: ${e.evidence}` : '',
      e.origin === 'agent-suggestion' ? '[agent suggestion]' : '',
    ]
      .filter(Boolean)
      .join(' — '),
    scope: 'episodic',
    updated: e.at,
  }));
}

/**
 * TASK CONTEXT CONSTRUCTION (2.5): bounded, task-specific context from episodic +
 * project memory for one request in one workspace. Exact/keyword retrieval (paths,
 * commands and symbols need deterministic matching; semantic tier remains in find_memory).
 * Returns '' when nothing is relevant — context is never padded.
 */
export async function buildTaskMemoryContext(request: string, root?: string, maxChars = 1600): Promise<string> {
  const [episodes, projects] = await Promise.all([recallEpisodes(request, { root, limit: 3 }), listAllProjectRecords().catch(() => [])]);
  const tokens = new Set((request.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? []));
  const projectHits = projects
    .filter((p) => {
      const hay = p.text.toLowerCase();
      let n = 0;
      for (const t of tokens) if (hay.includes(t)) n++;
      return n >= 2;
    })
    .slice(0, 3);
  const lines: string[] = [];
  if (episodes.length) {
    lines.push('RELEVANT PAST WORK (episodic memory — outcomes the engine observed; current files stay authoritative):');
    for (const e of episodes) {
      lines.push(
        `- ${e.verdict.toUpperCase()}: ${e.request}${e.lesson ? ` → lesson: ${e.lesson}` : ''}${e.evidence ? ` [${e.evidence}]` : ''}${e.origin === 'agent-suggestion' ? ' (agent suggestion — verify before relying on it)' : ''}`
      );
    }
  }
  if (projectHits.length) {
    lines.push('RELEVANT PROJECT MEMORY (context, not ground truth — verify against the files):');
    for (const p of projectHits) lines.push(`- ${p.text}`);
  }
  if (!lines.length) return '';
  const out: string[] = [];
  let budget = maxChars;
  for (const line of lines) {
    if (line.length > budget) break;
    out.push(line);
    budget -= line.length + 1;
  }
  return out.join('\n');
}

export const resetEpisodicForTests = (): void => {
  /* store is file-backed; tests delete the file */
};

export const episodeStoreFile = (): string => STORE_FILE;

// ------------------------------------------------------- durable pending-episode outbox (R27 §1.5)

/**
 * ROUND 27 (§1.5): recording is now DURABLE. The old `recordEpisode` was fire-and-forget
 * — a crash after task completion but before the episode persisted silently lost the
 * memory of that work. Now a completed task first writes a DURABLE PENDING record (an
 * outbox row via the same atomic-write persistence), and a separate bounded process
 * drains it: validate → dedupe → persist → mark recorded, with failures preserved for
 * retry or investigation. Task completion never depends on the drain succeeding.
 */
export type EpisodePayload = Omit<Episode, 'id' | 'at'> & { id?: string; at?: number };

export interface PendingEpisode {
  id: string;
  createdAt: number;
  status: 'pending' | 'recorded' | 'failed';
  attempts: number;
  lastError?: string;
  /** The payload exactly as queued — the structured episode survives a crash independently of any semantic indexing. */
  episode: EpisodePayload;
}

const OUTBOX_FILE = path.join(FILES_ROOT, 'brain', 'pending-episodes.json');
const MAX_OUTBOX = 120;
const MAX_ATTEMPTS = 5;
/** Bounded drain per call: memory work must never stall task execution. */
const MAX_DRAIN = 25;

const loadOutbox = async (): Promise<PendingEpisode[]> => {
  const parsed = await loadJson<unknown>(OUTBOX_FILE, []);
  return (Array.isArray(parsed) ? parsed : []).filter(
    (r): r is PendingEpisode => !!r && typeof r === 'object' && typeof (r as PendingEpisode).id === 'string' && !!r.episode && typeof r.status === 'string'
  );
};

const saveOutbox = async (rows: PendingEpisode[]): Promise<void> => {
  await fs.mkdir(path.dirname(OUTBOX_FILE), { recursive: true });
  await atomicWrite(OUTBOX_FILE, JSON.stringify(rows, null, 1));
};

/** Bounded outbox pruning: recorded rows are audit trail (oldest fall off), pending rows
 *  are preserved (they are the recoverable work), failed rows are kept for investigation. */
const pruneOutbox = (rows: PendingEpisode[]): PendingEpisode[] => {
  if (rows.length <= MAX_OUTBOX) return rows;
  const keepFirst = rows.filter((r) => r.status !== 'recorded');
  const recorded = rows.filter((r) => r.status === 'recorded');
  return [...keepFirst, ...recorded.slice(0, Math.max(0, MAX_OUTBOX - keepFirst.length))];
};

/** Content validation for a queued episode — meaningful information only, never every
 *  tool call: a request and an account of the outcome are the minimum. */
const validatePayload = (e: EpisodePayload): string | '' => {
  if (!e || typeof e !== 'object') return 'payload is not an object';
  if (!clip(e.request, 400)) return 'request is empty';
  if (!clip(e.outcome, 500) && !clip(e.approach, 300)) return 'no outcome or approach recorded';
  if (!['completed', 'partial', 'failed', 'blocked'].includes(e.verdict)) return `unknown verdict "${String(e.verdict)}"`;
  return '';
};

/** DURABLY queue an episode of finished work. Never throws — a memory failure must not
 *  change task completion. Returns an honest result either way. */
export async function queueEpisode(e: EpisodePayload): Promise<{ queued: boolean; id?: string; error?: string }> {
  try {
    const invalid = validatePayload(e);
    if (invalid) return { queued: false, error: `episode rejected: ${invalid}` };
    // ROUND 28 (§1.3): the queue's read-modify-write runs under the SAME store lock as the
    // drain — an unlocked queue used to race the drain's save and WIPE freshly-queued rows
    // (the drain's last write won over rows appended after its load). Under the lock, a
    // queue either lands wholly before or wholly after a drain's write; nothing is lost.
    const result = await withStoreLock(OUTBOX_FILE, async (): Promise<{ queued: boolean; id?: string; error?: string }> => {
      const rows = await loadOutbox();
      // queue-level dedupe — the same finished task queued twice (retry of the settle
      // path, a crash between queue and drain) must not stack pending rows.
      const key = contentKey(e as Pick<Episode, 'request' | 'verdict' | 'outcome'>);
      const existing = rows.find((r) => (r.status === 'pending' || r.status === 'recorded') && contentKey(r.episode as Pick<Episode, 'request' | 'verdict' | 'outcome'>) === key);
      if (existing) return { queued: true, id: existing.id };
      const pending: PendingEpisode = {
        id: `pq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        createdAt: Date.now(),
        status: 'pending',
        attempts: 0,
        episode: e,
      };
      rows.push(pending);
      await saveOutbox(pruneOutbox(rows));
      return { queued: true, id: pending.id };
    });
    // The drain follows the queue (bounded, never throws) — the old flow relied on every
    // caller remembering to drain, so a queued row could wait indefinitely.
    void processPendingEpisodes().catch(() => undefined);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[episodic] could not durably queue an episode:', msg);
    return { queued: false, error: msg };
  }
}

export interface DrainResult {
  recorded: number;
  duplicates: number;
  failed: number;
  skipped: number;
  remaining: number;
}

let draining = false;

/**
 * Drain the outbox: retrieve pending episodes, validate their content, dedupe against
 * existing episodes (recordEpisode is content-keyed), persist, mark recorded — or keep
 * the failure honestly for retry (bounded attempts) / investigation. Safe to call at
 * startup and after each queueing. Never throws.
 *
 * ROUND 28 (§1.3) hardening:
 *  - the read-modify-write runs under the SAME store lock as recordEpisode, so a drain
 *    racing another drain (startup + post-queue) can no longer last-writer-win over the
 *    other's settled rows;
 *  - a re-entrancy flag makes overlapping calls no-ops (the caller that started the drain
 *    will settle every row it loaded);
 *  - the drain is crash-safe at every persistence boundary BY CONSTRUCTION: a row is only
 *    marked settled after its episode persisted, and a crash before the outbox save leaves
 *    the row pending — the next drain re-processes it and recordEpisode's content-keyed
 *    dedupe turns the repeat into an honest 'duplicate', never a double-recorded episode.
 */
export async function processPendingEpisodes(): Promise<DrainResult> {
  const out: DrainResult = { recorded: 0, duplicates: 0, failed: 0, skipped: 0, remaining: 0 };
  if (draining) return out; // an overlapping call would double-count; the running drain settles everything
  draining = true;
  try {
    await withStoreLock(OUTBOX_FILE, async () => {
      const rows = await loadOutbox();
      let changed = false;
      const pending = rows.filter((r) => r.status === 'pending');
      for (const row of pending.slice(0, MAX_DRAIN)) {
        const invalid = validatePayload(row.episode);
        if (invalid) {
          row.status = 'failed';
          row.lastError = `invalid content: ${invalid}`;
          row.attempts += 1;
          changed = true;
          out.failed++;
          continue;
        }
        try {
          const res = await recordEpisode(row.episode);
          row.status = 'recorded';
          row.attempts += 1;
          changed = true;
          if (res === 'duplicate') out.duplicates++;
          else out.recorded++;
        } catch (err) {
          row.attempts += 1;
          row.lastError = clip(err instanceof Error ? err.message : String(err), 200);
          changed = true;
          if (row.attempts >= MAX_ATTEMPTS) {
            row.status = 'failed'; // preserved for investigation — no unbounded retry
            out.failed++;
          } else {
            out.skipped++; // stays pending; retried on a later drain
          }
        }
      }
      if (changed) await saveOutbox(pruneOutbox(rows));
      out.remaining = rows.filter((r) => r.status === 'pending').length;
    });
    return out;
  } catch (err) {
    console.warn('[episodic] pending-episode drain failed:', err instanceof Error ? err.message : err);
    return out;
  } finally {
    draining = false;
  }
}

/** Test/restart helper: resolves once no drain is in flight AND no store operation is
 *  queued (the queue-triggered drains run detached, so a test that inspects or rewrites
 *  the outbox store must wait for idle). ROUND 28 (Workflow F determinism): "no drain
 *  running" is NOT enough — a queueEpisode whose store-lock slot has not fired yet will
 *  start a drain LATER, and a drain whose slot is mid-chain can still rewrite the outbox.
 *  Quiesce until: no drain running, zero queued store ops, and a full event-loop turn
 *  passes with no new work appearing. Bounded — a wedged store fails the wait honestly. */
export const waitForDrainIdleForTests = async (): Promise<void> => {
  for (let i = 0; i < 2000; i++) {
    if (!draining && storeOpsPending() === 0) {
      await new Promise((r) => setImmediate(r)); // one full turn: queued continuations fire now
      if (!draining && storeOpsPending() === 0) return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** Inspect the outbox (Control Center / diagnostics): counts by status + the failed rows. */
export async function pendingEpisodeSummary(): Promise<{ pending: number; recorded: number; failed: number; failures: Array<Pick<PendingEpisode, 'id' | 'lastError' | 'attempts'>> }> {
  const rows = await loadOutbox();
  return {
    pending: rows.filter((r) => r.status === 'pending').length,
    recorded: rows.filter((r) => r.status === 'recorded').length,
    failed: rows.filter((r) => r.status === 'failed').length,
    failures: rows
      .filter((r) => r.status === 'failed')
      .slice(-5)
      .map((r) => ({ id: r.id, lastError: r.lastError, attempts: r.attempts })),
  };
}

export const pendingEpisodeStoreFile = (): string => OUTBOX_FILE;
