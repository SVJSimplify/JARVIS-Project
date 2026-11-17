import { promises as fs } from 'fs';
import * as path from 'path';
import { atomicWrite, withStoreLock } from './store';
import { FILES_ROOT } from './workspace';
import { redactText } from './redact';

/**
 * DURABLE WORKFLOW JOURNAL (Round 30, restored in Round 32 Phase 4 §4.1).
 *
 * The side-effect and recovery EVIDENCE layer that the task store does not provide. The
 * EXISTING task store remains the ONE authoritative task lifecycle; this journal records
 * what that lifecycle cannot carry:
 *  - settled workflow steps and their dependencies (as executed, not as planned);
 *  - verification outcomes;
 *  - CONSEQUENTIAL SIDE EFFECTS — every external write, with its outcome class
 *    (requested / executed-verified / executed-unverified / failed / unknown);
 *  - approval decisions that governed those effects;
 *  - UNKNOWN external outcomes — the durable requires-reconciliation markers;
 *  - resume and reconciliation information (the last checkpoint a resume can trust).
 *
 * Guarantees: atomic writes (store.atomicWrite), lock-serialized persistence
 * (withStoreLock — one writer at a time), bounded history (oldest entries compacted),
 * restart-safe (plain durable JSON), honest errors (a failed journal write is surfaced,
 * never swallowed as success).
 *
 * NOT a second task store: no lifecycle, no claims, no scheduling — append-only evidence.
 */

// ----------------------------------------------------------------------------- shape

export type SideEffectOutcome = 'requested' | 'executed-verified' | 'executed-unverified' | 'failed' | 'unknown';

export interface WorkflowJournalEntry {
  at: number;
  kind:
    | 'workflow-started'
    | 'step-settled'
    | 'side-effect'
    | 'approval'
    | 'unknown-outcome'
    | 'checkpoint'
    | 'resume'
    | 'reconciled';
  /** The durable task id when the workflow runs inside one. */
  taskId?: string;
  /** The project id when the workflow belongs to an autopilot project. */
  projectId?: string;
  /** The workflow/playbook name or the tool that produced the effect. */
  stage: string;
  /** Human-readable detail (no secrets, no credentials, no full payloads). */
  detail: string;
  /** For side effects: the honest outcome classification (§2.3). */
  outcome?: SideEffectOutcome;
  /** For unknown outcomes: what must be checked before a retry is even considered. */
  reconcile?: string;
}

// --------------------------------------------------------------------------- storage

const MAX_ENTRIES = 500;
const journalFile = (): string => path.join(FILES_ROOT, 'brain', 'workflow-journal.json');

let lastWriteError = '';
/** ROUND 32 (§6): journal health for the Operations Center — a failed write is visible. */
export const journalHealth = (): { lastError: string; quarantined?: string } => ({
  lastError: lastWriteError,
  quarantined: lastQuarantinePath || undefined,
});

/** ROUND 33 (§3.3): a corrupt journal's preserved original (never silently destroyed). */
let lastQuarantinePath = '';

/**
 * ROUND 33 (§3.3): a corrupt journal file is QUARANTINED byte-for-byte (workflow-journal.corrupt-<ts>.json)
 * and the journal restarts with an explicit recovery marker as the first entry — the
 * evidence is never silently destroyed, and the corruption stays visible (§4: no secret
 * ever reaches the journal either — details pass the centralized redactText).
 */
async function loadJournalOrQuarantine(): Promise<WorkflowJournalEntry[] | null> {
  const raw = await fs.readFile(journalFile(), 'utf8').catch((e) => {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '[]';
    throw e;
  });
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error('not a JSON array');
    const entries = parsed.filter((x): x is WorkflowJournalEntry => !!x && typeof x === 'object' && typeof (x as WorkflowJournalEntry).at === 'number');
    if (entries.length !== parsed.length) {
      const q = path.join(path.dirname(journalFile()), `workflow-journal.corrupt-${Date.now()}.json`);
      await fs.writeFile(q, raw, 'utf8').catch(() => undefined);
      lastQuarantinePath = q;
      lastWriteError = `the workflow journal contained malformed entries; the original was preserved at ${path.basename(q)}`;
      console.error('[workflow-journal] CORRUPTION detected:', lastWriteError);
      return null;
    }
    return entries;
  } catch (e) {
    const q = path.join(path.dirname(journalFile()), `workflow-journal.corrupt-${Date.now()}.json`);
    await fs.writeFile(q, raw, 'utf8').catch(() => undefined);
    lastQuarantinePath = q;
    lastWriteError = `the workflow journal file is corrupt (JSON unreadable: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}); the original was preserved at ${path.basename(q)}`;
    console.error('[workflow-journal] CORRUPTION detected:', lastWriteError);
    return null;
  }
}

/** Append one entry, atomically and serialized. Returns false when persistence FAILED.
 *  ROUND 33 (§4.2): the entry's detail and reconcile guidance pass the CENTRALIZED
 *  redaction (redact.ts) — a credential-shaped value (deploy-hook URL, token, cookie)
 *  can never enter the journal through any caller. Corruption is quarantined, never
 *  silently reset (§3.3). */
export async function recordWorkflowEntry(entry: Omit<WorkflowJournalEntry, 'at'>): Promise<boolean> {
  const e: WorkflowJournalEntry = { at: Date.now(), ...entry, detail: redactText(entry.detail), ...(entry.reconcile ? { reconcile: redactText(entry.reconcile) } : {}) };
  try {
    await withStoreLock(journalFile(), async () => {
      const existing = await loadJournalOrQuarantine();
      let log: WorkflowJournalEntry[];
      if (existing === null) {
        // The corrupted original is preserved; the journal restarts with a recovery marker.
        log = [{ at: Date.now(), kind: 'reconciled', stage: 'journal-recovery', detail: `a corrupt journal was quarantined (${path.basename(lastQuarantinePath)}) — inspect it; this entry begins the new journal` }];
      } else {
        log = existing;
      }
      log.push(e);
      await fs.mkdir(path.dirname(journalFile()), { recursive: true });
      await atomicWrite(journalFile(), JSON.stringify(log.slice(-MAX_ENTRIES), null, 1));
    });
    lastWriteError = '';
    return true;
  } catch (err) {
    lastWriteError = err instanceof Error ? err.message : String(err);
    console.error('[workflow-journal] write FAILED:', lastWriteError);
    return false;
  }
}

// --------------------------------------------------------------------------- queries

/** The last N entries, newest last (bounded). */
export async function workflowJournalView(limit = 30): Promise<WorkflowJournalEntry[]> {
  try {
    const raw = await fs.readFile(journalFile(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const log = Array.isArray(parsed) ? (parsed as WorkflowJournalEntry[]) : [];
    return log.slice(-Math.max(1, limit));
  } catch {
    return [];
  }
}

/** Unknown external outcomes still requiring reconciliation (newest first, bounded). */
export async function unknownOutcomes(limit = 20): Promise<WorkflowJournalEntry[]> {
  const all = await workflowJournalView(MAX_ENTRIES);
  return all
    .filter((e) => e.outcome === 'unknown' || e.kind === 'unknown-outcome')
    .slice(-limit)
    .reverse();
}

/** The last checkpoint recorded for a task or project (or undefined). */
export async function lastCheckpoint(filter: { taskId?: string; projectId?: string }): Promise<WorkflowJournalEntry | undefined> {
  const all = await workflowJournalView(MAX_ENTRIES);
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i];
    if (filter.taskId && e.taskId !== filter.taskId) continue;
    if (filter.projectId && e.projectId !== filter.projectId) continue;
    if (e.kind === 'checkpoint' || e.kind === 'side-effect' || e.kind === 'reconciled') return e;
  }
  return undefined;
}

/** Side effects recorded for a task/project (bounded, newest last). */
export async function sideEffectsFor(filter: { taskId?: string; projectId?: string }, limit = 20): Promise<WorkflowJournalEntry[]> {
  const all = await workflowJournalView(MAX_ENTRIES);
  return all
    .filter(
      (e) =>
        (e.kind === 'side-effect' || e.kind === 'unknown-outcome' || e.kind === 'approval') &&
        (!filter.taskId || e.taskId === filter.taskId) &&
        (!filter.projectId || e.projectId === filter.projectId)
    )
    .slice(-limit);
}

/** Test hook: state is entirely on disk; nothing to clear in memory. */
export const resetWorkflowJournalForTests = (): void => {
  lastWriteError = '';
  lastQuarantinePath = '';
};
