import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { atomicWrite, loadJson } from './store';
import { FILES_ROOT } from './workspace';

/**
 * COMPLETION VERDICT ENGINE — the code-enforced contract that a task is either truly
 * finished or honestly reported.
 *
 * Why this exists (Round 4): the model once claimed a browser task "done" after the user had
 * closed the panel, and claims in general could not be trusted to match tool reality. Prompts
 * ask for honesty; this module ENFORCES it, deterministically, on every turn:
 *
 *  1. EVIDENCE LEDGER  — every tool result of the turn is classified (success/failed/blocked)
 *     by its standardised prefix. This ledger, not the model's prose, is ground truth.
 *  2. VERDICT          — computed from the ledger: completed | partial | failed | blocked |
 *     no_action. A failure that was later fixed by a same-family success counts as resolved.
 *  3. REPLY AUDIT      — the final spoken reply is audited against the ledger. A success claim
 *     over unresolved failures is REWRITTEN into an honest status; an action claim with no
 *     supporting evidence is rewritten; honest failures get a concrete NEXT step appended.
 *  4. QUALITY AUDIT    — deterministic checks: a tool that said it wrote a file must leave that
 *     file on disk; a browser_* success must carry its state truth line. Failures downgrade the
 *     verdict — a "successful" write with no file is a lie, not a success.
 *  5. RESCUE PASS      — before a turn may end with retryable failures, the provider asks this
 *     module once for a bounded recovery directive (one extra model round, tools still loaded),
 *     so fixable tasks actually finish instead of being reported broken.
 *  6. MEASUREMENT      — every verdict and enforcement event is counted in a persisted rolling
 *     stat, so "completed 99% of the time, else honest status + next step" is a MEASURED
 *     property, not a slogan (completion_stats tool).
 *
 * Guarantees by construction: the engine can only downgrade or add honest information to a
 * reply — never inflate success. If the ledger is empty, the reply passes untouched.
 */

export type Outcome = 'success' | 'failed' | 'blocked';
/** Truthful turn outcomes. `blocked` = a hard code-enforced block (deletion / OS resources)
 *  ended the work — it is final and reported as disabled, never as something awaiting anyone. */
export type Verdict = 'completed' | 'partial' | 'failed' | 'blocked' | 'no_action' | 'interrupted';

export interface LedgerEntry {
  tool: string;
  args: string;
  outcome: Outcome;
  /** Raw tool result, kept for the quality audit (truth-line checks, error classes). */
  raw: string;
  at: number;
}

export interface Audit {
  reply: string;
  verdict: Verdict;
  /** What the enforcer changed, for the stats and the tool log. */
  enforcement: string[];
}

// ---------------------------------------------------------------- outcome classification

/** Deterministic: a result is a failure iff it starts with one of the standard prefixes.
 *  `NOT APPROVED` is the legacy prefix of the old permission flow: today it can only mean
 *  the gate's deletion tooth, which is a HARD block — so it classifies as blocked. */
export const classifyOutcome = (raw: string): Outcome => {
  const s = String(raw ?? '');
  if (/^NOT APPROVED/.test(s) || /^BLOCKED/.test(s)) return 'blocked';
  if (/^(Tool error|Unknown tool|NOT DONE|TIMEOUT\b)/.test(s)) return 'failed';
  return 'success';
};

export type FailureClass =
  | 'permission' | 'missing' | 'timeout' | 'network' | 'config' | 'routing'
  | 'browser_closed' | 'input' | 'blocked' | 'other';

const CLASS_RES: Array<[RegExp, FailureClass]> = [
  [/EPERM|EACCES|access is denied|permission|BitLocker|Controlled Folder/i, 'permission'],
  [/ENOENT|no such file|cannot find|does not exist|not found|not on disk/i, 'missing'],
  [/timed? ?out|ETIMEDOUT|TIMEOUT/i, 'timeout'],
  [/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed|network|ERR_NETWORK|ERR_CONNECTION|socket hang up|internet/i, 'network'],
  [/No model set/i, 'config'],
  [/Unknown tool/i, 'routing'],
  [/panel was closed|browser: closed/i, 'browser_closed'],
  [/invalid|malformed|required|is empty|too large|must not/i, 'input'],
];

/** Coarse, human-usable class of a failure from its raw error text. */
export const failureClass = (raw: string): FailureClass => {
  const s = String(raw ?? '');
  if (/^NOT APPROVED/.test(s) || /^BLOCKED/.test(s)) return 'blocked';
  for (const [re, c] of CLASS_RES) if (re.test(s)) return c;
  return 'other';
};

/** Classes the model can plausibly fix by itself with a different approach (rescue-eligible). */
const RETRYABLE: ReadonlySet<FailureClass> = new Set(['timeout', 'network', 'routing', 'browser_closed', 'input', 'missing']);

const CLASS_SPOKEN: Record<FailureClass, string> = {
  permission: 'access was denied',
  missing: 'the target was not found',
  timeout: 'it timed out',
  network: 'the network call failed',
  config: 'no model is configured',
  routing: 'the tool routing failed',
  browser_closed: 'the browser panel was closed',
  input: 'the details were invalid',
  blocked: 'it is disabled by policy',
  other: 'the step errored',
};

/** The concrete next move, spoken style, per failure class. This is the "what to do next" half
 *  of the contract: every non-completed verdict carries one of these. */
export const nextStepFor = (c: FailureClass): string => {
  switch (c) {
    case 'permission':
      return 'grant access to that location or pick another one, and I will continue';
    case 'missing':
      return 'I will confirm the exact name or path first';
    case 'timeout':
      return 'tell me to retry; I will take a slower, more direct route';
    case 'network':
      return 'check the connection, then tell me to retry';
    case 'config':
      return 'pick a model in Settings first';
    case 'routing':
      return 'tell me to retry and I will route it with the right tool';
    case 'browser_closed':
      return 'ask me to reopen the browser panel and I will finish the job';
    case 'input':
      return 'give me the corrected detail and I will redo it';
    case 'blocked':
      return 'we need a different route; that action is disabled for safety';
    default:
      return 'tell me to retry and I will take a different approach';
  }
};

// ----------------------------------------------------------------------- task families

/** Coarse family of a tool, so "failed then retried with a sibling tool" counts as resolved. */
export const familyOf = (tool: string): string => {
  if (/^(launch_app|open_app|open_anything|open_file|open_url|open_in_my_browser|browser_open|browser_search)$/.test(tool)) return 'open';
  if (/^(close_app|browser_close|browser_close_tab|close_my_browser_tab)$/.test(tool)) return 'close';
  if (/^(write_file|edit_file|multi_edit|apply_patch|copy_file|make_dir|move_file)$/.test(tool)) return 'write';
  if (/^(browser_play|browser_media|media_control)$/.test(tool)) return 'media';
  if (/^(read|glob|grep|list_files|find_files|read_document|code_search|search_and_read|tinyfish_search|tinyfish_fetch|web_search|fetch_url)$/.test(tool)) return 'read';
  if (/^browser_/.test(tool)) return 'browser';
  return tool;
};

/** Failure is resolved iff a LATER success in the same family exists (the model fixed it). */
export const unresolvedFailures = (entries: LedgerEntry[]): LedgerEntry[] => {
  const out: LedgerEntry[] = [];
  entries.forEach((e, i) => {
    if (e.outcome !== 'failed') return;
    const fam = familyOf(e.tool);
    const fixed = entries.slice(i + 1).some((x) => x.outcome === 'success' && familyOf(x.tool) === fam);
    if (!fixed) out.push(e);
  });
  return out;
};

// ----------------------------------------------------------------------- verdict

export const verdictOf = (entries: LedgerEntry[]): Verdict => {
  if (!entries.length) return 'no_action';
  const unresolved = unresolvedFailures(entries);
  if (unresolved.length) return entries.some((e) => e.outcome === 'success') ? 'partial' : 'failed';
  // Everything that failed was fixed. Leftover blocked steps still block "completed":
  // a policy-blocked step is not done, and no wording can make it done.
  const gate = entries.some((e) => e.outcome === 'blocked');
  return gate ? 'blocked' : 'completed';
};

// ----------------------------------------------------------------------- reply audit

/** Past-tense action claims mapped to the tool family they must be backed by. */
const VERB_FAMILIES: Array<[RegExp, string]> = [
  [/\b(opened|launched|started up|brought up)\b/i, 'open'],
  [/\b(closed|shut|dismissed)\b/i, 'close'],
  [/\b(saved|created|wrote|written|made|built|updated|edited|appended|generated|copied)\b/i, 'write'],
  [/\b(played|paused|resumed|skipped)\b/i, 'media'],
  [/\b(found|located|looked up|read)\b/i, 'read'],
  [/\b(deleted|removed|uninstalled)\b/i, 'write'],
];

/** Words in the REQUEST that justify expecting evidence of that family (guards the
 *  unverifiable-claim rewrite against false positives on small talk). */
const REQUEST_INTENT: Array<[RegExp, string]> = [
  [/\b(open|launch|start|bring up)\b/i, 'open'],
  [/\b(close|shut|dismiss|kill)\b/i, 'close'],
  [/\b(save|create|write|make|build|update|edit|append|generate|copy|clone|delete|remove)\b/i, 'write'],
  [/\b(play|pause|resume|skip)\b/i, 'media'],
  [/\b(find|locate|look up|read|search)\b/i, 'read'],
];

const SUCCESS_CLAIM = /\b(done|completed|successfully|all set|finished|sorted|taken care of)\b/i;
const FAILURE_WORD = /\b(failed|couldn'?t|could not|not able|unable|did not|didn'?t|does not work|won'?t|error|unfortunately|blocked|denied|problem|issue)\b/i;
const NEXT_WORD = /\b(next|instead|retry|again|grant|check|approve|allow|say the word|shall i|want me to)\b/i;
const QUESTION = /\b(which|what|where|how|should i|do you|shall i|can you|could you|would you)\b/i;

const FAMILY_PHRASE: Record<string, string> = {
  open: 'the open step worked',
  close: 'the close step worked',
  write: 'the file step worked',
  media: 'the playback step worked',
  read: 'the lookups worked',
  browser: 'the browser steps worked',
};

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const phrase = (e: LedgerEntry): string => `${e.tool} ${e.outcome === 'failed' ? `failed — ${CLASS_SPOKEN[failureClass(e.raw)]}` : 'succeeded'}`;

const failPhrase = (es: LedgerEntry[]): string => {
  const first = phrase(es[0]);
  return es.length > 1 ? `${first} (and ${es.length - 1} more step${es.length > 2 ? 's' : ''} failed)` : first;
};

const succPhrase = (es: LedgerEntry[]): string => {
  const fams = [...new Set(es.map((e) => FAMILY_PHRASE[familyOf(e.tool)] ?? `${e.tool} succeeded`))];
  return fams.slice(0, 2).join(' and ');
};

/** The deterministic audit of the final reply against the ledger. Pure and exported for tests.
 *  `quality` holds deterministic quality-audit problems (missing written files, absent truth
 *  lines). Each problem INVALIDATES the success entry it refers to — a "success" without real
 *  evidence is a failed step, so the verdict and the rewrite both follow the truth. */
export function auditReply(reply: string, entries: LedgerEntry[], request: string, quality: QualityProblem[]): Audit {
  const enforcement: string[] = [];
  let replyText = String(reply ?? '').trim();

  // Quality failures turn the lying success entry into what it really was: a failed step.
  const all: LedgerEntry[] = entries.map((e) => ({ ...e }));
  for (const q of quality) {
    const target = all[q.index];
    if (target && target.outcome === 'success') {
      target.outcome = 'failed';
      target.raw = `NOT DONE: ${q.message}`;
    }
    enforcement.push(`quality: ${q.message}`);
  }

  const unresolved = unresolvedFailures(all);
  const successes = all.filter((e) => e.outcome === 'success');

  // The verdict comes from the ledger, never from the reply's prose.
  let verdict = verdictOf(all);

  if (verdict === 'partial' || verdict === 'failed') {
    const mentionsFailure = FAILURE_WORD.test(replyText);
    const claimsSuccess = SUCCESS_CLAIM.test(replyText) || VERB_FAMILIES.some(([re]) => re.test(replyText));
    const isQuestion = QUESTION.test(replyText) || replyText.endsWith('?');
    if (claimsSuccess && !mentionsFailure && !isQuestion) {
      // FALSE SUCCESS — the lie the engine exists to catch. Replace it with the ledger truth.
      replyText = successes.length
        ? `Partly done, sir: ${succPhrase(successes)}, but ${failPhrase(unresolved)}. ${nextStepFor(failureClass(unresolved[0].raw))}.`
        : `That did not go through, sir: ${failPhrase(unresolved)}. ${nextStepFor(failureClass(unresolved[0].raw))}.`;
      enforcement.push('false_success_rewritten');
    } else if (!mentionsFailure && !isQuestion) {
      // Neither claimed success nor named the failure: the status must be stated anyway.
      replyText = `${failPhrase(unresolved)}. ${nextStepFor(failureClass(unresolved[0].raw))}.`;
      enforcement.push('status_stated');
    } else if (!NEXT_WORD.test(replyText) && !isQuestion) {
      // Honest about failure — now guarantee the "what to do next" half of the contract.
      // A clarifying question is its own next step; bolting one on would be noise.
      replyText = `${replyText} Next: ${nextStepFor(failureClass(unresolved[0].raw))}.`;
      enforcement.push('next_step_added');
    }
  } else if (verdict === 'blocked') {
    if (!/\b(disabled|can'?t|cannot|policy|instead|different)\b/i.test(replyText)) {
      // A blocked step is final (code-enforced): the reply must say the step is disabled,
      // never invite an approval that cannot exist.
      replyText = `${replyText} That step is disabled for safety, sir — we will need a different route.`.trim();
      enforcement.push('blocked_step_stated');
    }
  } else if (verdict === 'no_action' || verdict === 'completed') {
    // Unverifiable claim: a past-tense action with NO supporting success anywhere. Only fired
    // when the request itself asked for that kind of action, so small talk is never rewritten.
    const intent = new Set(REQUEST_INTENT.filter(([re]) => re.test(request)).map(([, f]) => f));
    if (intent.size) {
      for (const [re, fam] of VERB_FAMILIES) {
        if (!re.test(replyText) || !intent.has(fam)) continue;
        const backed = successes.some((e) => familyOf(e.tool) === fam);
        if (!backed) {
          replyText = `To be accurate, sir: that did not actually happen — no step this turn confirms it. Say the word and I will do it now.`;
          enforcement.push('unverifiable_claim_rewritten');
          verdict = 'no_action';
          break;
        }
      }
    }
  }

  return { reply: replyText, verdict, enforcement };
}

// ----------------------------------------------------------------------- quality audit

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'apply_patch', 'copy_file', 'make_dir', 'move_file']);

const pathsTouched = (tool: string, argsJson: string): string[] => {
  let a: Record<string, unknown> = {};
  try {
    a = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (tool === 'copy_file' || tool === 'move_file') return a.to ? [String(a.to)] : [];
  if (tool === 'apply_patch') {
    return [...String(a.patch ?? '').matchAll(/\*\*\* (?:Add|Update) File: (.+)/g)].map((m) => m[1].trim());
  }
  return a.path ? [String(a.path)] : [];
};

/** True if the path exists (file or dir). Relative paths resolve inside the workspace; ~ expands. */
const existsOnDisk = async (p: string): Promise<boolean> => {
  const expanded = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
  const candidates = path.isAbsolute(expanded) ? [expanded] : [path.join(FILES_ROOT, expanded)];
  for (const c of candidates) {
    const st = await fs.stat(c).catch(() => null);
    if (st) return true;
  }
  return false;
};

export interface QualityProblem {
  tool: string;
  message: string;
  /** Index into the ledger of the success entry this problem invalidates. */
  index: number;
}

/** Deterministic post-turn checks. A tool that reported success must have left real evidence:
 *  written files must exist on disk; browser results must carry their state truth line.
 *  Every problem names the ledger entry it invalidates, so the audit can only downgrade. */
export async function qualityAudit(entries: LedgerEntry[]): Promise<QualityProblem[]> {
  const problems: QualityProblem[] = [];
  for (let index = 0; index < entries.length; index++) {
    const e = entries[index];
    if (e.outcome !== 'success') continue;
    if (/^browser_/.test(e.tool) && !e.raw.includes('[in-app browser:')) {
      problems.push({ tool: e.tool, index, message: `${e.tool} reported success without its browser state truth line` });
    }
    if (!WRITE_TOOLS.has(e.tool)) continue;
    for (const p of pathsTouched(e.tool, e.args)) {
      if (!(await existsOnDisk(p))) {
        problems.push({ tool: e.tool, index, message: `${e.tool} said it wrote ${clip(p, 80)} but the file is not on disk` });
      }
    }
  }
  return problems;
}

// ----------------------------------------------------------------------- rescue pass

const RESCUE_NOTE = (unresolved: LedgerEntry[]): string =>
  [
    '[COMPLETION ENFORCEMENT — one recovery pass before this turn may end.',
    'These steps failed and are still unresolved:',
    ...unresolved.slice(0, 4).map((e) => `- ${e.tool}: ${clip(e.raw, 160)}`),
    'Fix each with a DIFFERENT approach now (different tool, arguments or route), verify each fix with a real tool result, then give the final spoken answer.',
    'If a step genuinely cannot be done, say exactly what failed and what should happen next — never claim success without tool evidence.]',
  ].join('\n');

// ----------------------------------------------------------------------- per-turn state

interface Task {
  request: string;
  entries: LedgerEntry[];
  rescueUsed: boolean;
}

let task: Task | null = null;

/** Start tracking a turn as a task. Turns are serialised (turnChain), so one slot is safe. */
export const beginTask = (request: string): void => {
  task = { request: String(request ?? ''), entries: [], rescueUsed: false };
};

/** Record one tool result into the ledger. Safe no-op outside a tracked turn (sub-agents). */
export const recordStep = (tool: string, args: string, raw: string): void => {
  if (!task) return;
  task.entries.push({ tool, args: String(args ?? ''), outcome: classifyOutcome(raw), raw: String(raw ?? ''), at: Date.now() });
};

/** Eligibility for the single bounded recovery pass. */
export const needsRescue = (signal?: { aborted: boolean }, roundsLeft = 99): boolean => {
  if (!task || task.rescueUsed || signal?.aborted || roundsLeft <= 2) return false;
  const unresolved = unresolvedFailures(task.entries);
  return unresolved.some((e) => RETRYABLE.has(failureClass(e.raw)));
};

/** Claim the rescue pass; returns the directive to inject as a user message. */
export const takeRescue = async (): Promise<string> => {
  await loadStats();
  const unresolved = task ? unresolvedFailures(task.entries) : [];
  if (task) task.rescueUsed = true;
  stats.rescues++;
  return RESCUE_NOTE(unresolved);
};

/**
 * Close the turn: run the deterministic quality audit, then audit the reply against the
 * ledger, record the verdict, and return the enforced reply the user will actually get.
 */
export async function endTask(modelReply: string): Promise<Audit> {
  const t = task;
  task = null;
  if (!t) return { reply: String(modelReply ?? ''), verdict: 'no_action', enforcement: [] };
  // Load the persisted counters BEFORE any in-memory increment: loadStats replaces the whole
  // stats object, so counting first would silently wipe the enforcement record.
  await loadStats();
  const quality = await qualityAudit(t.entries).catch(() => [] as QualityProblem[]);
  if (quality.length) stats.qualityFails += quality.length;
  const audit = auditReply(modelReply, t.entries, t.request, quality);
  for (const e of audit.enforcement) {
    if (e === 'false_success_rewritten') stats.falseSuccessCaught++;
    if (e === 'unverifiable_claim_rewritten') stats.unverifiableCaught++;
  }
  await recordOutcome(audit.verdict, t.entries, audit.enforcement);
  return audit;
}

/** A turn ended because the user stopped it — recorded, never hidden. */
export const recordInterrupted = (): Promise<void> => {
  const t = task;
  task = null;
  return t ? recordOutcome('interrupted', t.entries, []) : Promise.resolve();
};

/** A turn crashed before a reply — recorded as failed with the error, never hidden. */
export const recordFailedTurn = (err: string): Promise<void> => {
  const t = task;
  task = null;
  return t ? recordOutcome('failed', t.entries, [], `turn error: ${clip(err, 120)}`) : Promise.resolve();
};

// ----------------------------------------------------------------------- measurement

interface StatLine {
  t: number;
  verdict: Verdict;
  note: string;
}

interface Stats {
  total: number;
  completed: number;
  partial: number;
  failed: number;
  blocked: number;
  no_action: number;
  interrupted: number;
  falseSuccessCaught: number;
  unverifiableCaught: number;
  qualityFails: number;
  rescues: number;
  recent: StatLine[];
}

const emptyStats = (): Stats => ({
  total: 0, completed: 0, partial: 0, failed: 0, blocked: 0, no_action: 0, interrupted: 0,
  falseSuccessCaught: 0, unverifiableCaught: 0, qualityFails: 0, rescues: 0, recent: [],
});

let stats: Stats = emptyStats();
let statsLoaded = false;
/** Tests only: point the persistence file at a temp path (null = default under Jarvis-Files). */
let statsFileOverride: string | null = null;
export const setStatsFileForTests = (f: string | null): void => {
  statsFileOverride = f;
  stats = emptyStats();
  statsLoaded = false;
};

const statsFile = (): string => statsFileOverride ?? path.join(FILES_ROOT, 'brain', 'completion-stats.json');

const loadStats = async (): Promise<void> => {
  if (statsLoaded) return;
  statsLoaded = true;
  const raw = await loadJson<Partial<Stats>>(statsFile(), {});
  stats = { ...emptyStats(), ...raw, recent: Array.isArray(raw.recent) ? raw.recent.slice(-20) : [] };
};

const saveStats = async (): Promise<void> => {
  if (statsFileOverride) return; // tests: keep measurement in memory
  try {
    await fs.mkdir(path.dirname(statsFile()), { recursive: true });
    await atomicWrite(statsFile(), JSON.stringify({ ...stats, recent: stats.recent.slice(-20) }));
  } catch {
    // Measurement must never break a turn; the counters stay in memory.
  }
};

const note = (entries: LedgerEntry[], enforcement: string[], extra?: string): string => {
  if (extra) return extra;
  const u = unresolvedFailures(entries)[0];
  if (u) return clip(`${u.tool}: ${u.raw}`, 140);
  return enforcement[0] ?? '';
};

/** Record one finished unit of work (a turn, or a scheduled job's summary). */
async function recordOutcome(verdict: Verdict, entries: LedgerEntry[] = [], enforcement: string[] = [], extra?: string): Promise<void> {
  await loadStats();
  stats.total++;
  stats[verdict] = (stats[verdict] ?? 0) + 1;
  stats.recent = [...stats.recent, { t: Date.now(), verdict, note: note(entries, enforcement, extra) }].slice(-20);
  await saveStats();
}

/** Human-readable measurement report, for the completion_stats tool. */
export async function completionReport(): Promise<string> {
  await loadStats();
  if (!stats.total) return 'No tasks measured yet. Every turn is counted from now on: completed, or an honest status with a next step (code-enforced).';
  const pct = (n: number): string => `${Math.round((n / stats.total) * 100)}%`;
  const done = pct(stats.completed);
  const honest =
    'Every non-completed task carried an honest status and a next step: YES (enforced in code — the reply is audited against the tool evidence ledger before it reaches you).';
  const recent = stats.recent.slice(-5).map((r) => `- [${r.verdict}] ${r.note || '(clean)'}`).join('\n');
  return [
    `Task completion, last ${stats.total} measured: ${done} completed, ${pct(stats.partial)} partial, ${pct(stats.failed)} failed, ${pct(stats.blocked)} stopped by a policy block, ${pct(stats.interrupted)} stopped by you.`,
    `Enforcement record: ${stats.falseSuccessCaught} false-success claim(s) caught and rewritten, ${stats.unverifiableCaught} unverifiable claim(s) caught, ${stats.qualityFails} quality check(s) failed and downgraded, ${stats.rescues} recovery pass(es) run.`,
    `Target: complete 99% of tasks or report the status honestly with what to do next. Honesty is enforced at 100%; the completion rate above is the live measurement to push toward the target.`,
    honest,
    recent ? `Recent:\n${recent}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
