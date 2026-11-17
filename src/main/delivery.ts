import * as fsSync from 'fs';
import * as path from 'path';
import {
  failedSteps,
  persistTask,
  stepsBlockedByFailure,
  validVerification,
  type DeliveryChangeSummary,
  type DeliveryCriterionStatus,
  type DeliveryEvidence,
  type DeliveryEvidenceSource,
  type DeliveryReview,
  type DeliverableStatus,
  type TaskRecord,
  type TaskStep,
} from './taskStore';
import { recordsForTask, type ToolExecutionRecord } from './toolRecord';
import { FILES_ROOT, isInsideRoot } from './workspace';

/**
 * PROJECT DELIVERY ENGINE (Round 35, Phases 1–5) — the ONE delivery module.
 *
 * WHAT THIS IS: the acceptance-criteria / deliverable / evidence / change-summary layer of
 * the EXISTING task lifecycle. It owns NO new store, NO second task system, NO second
 * receipt ledger: every state lives inside the task's own TaskRecord (`t.delivery`,
 * persisted by the task store's single save path), and every piece of evidence POINTS AT
 * existing proof — durable tool-execution receipts (`toolRecord.ts`), disk inspections, or
 * the verifier's own results (`verifier.ts`). The model cannot write any of it: every
 * state transition is computed here, by engine code, from records.
 *
 * THE COMPLETION GATE (Phase 1): a task is COMPLETE only when every mandatory acceptance
 * criterion is `satisfied` (or honestly `not_applicable`) and every mandatory file-backed
 * deliverable is `verified` (or `skipped`). A successful last tool call, a stopped
 * coordinator, a step agent's DONE report, or an exhausted plan never complete a task by
 * themselves — `deliveryGate()` is the code-enforced gate the coordinator consults before
 * COMPLETED, and it can only keep the task from being called complete, never inflate it.
 *
 * HONESTY RULES (Phases 2–3):
 *  - A planned artifact is never represented as an existing one; a produced artifact is
 *    never `verified` without verification evidence; an attempted external operation is
 *    never `verified` without its confirmation receipt.
 *  - Evidence is DIRECT (disk stat, executed command, durable receipt) or INFERRED (text
 *    in recorded evidence) — and says which.
 *  - Evidence goes STALE: file-basis evidence is invalidated when the file's mtime moves
 *    past the recorded basis; command-basis evidence (build/typecheck) is invalidated when
 *    a LATER write to the project is recorded (the build no longer describes the source).
 *    A criterion whose evidence all went stale reverts to `pending` — never silently
 *    carried as satisfied on stale proof.
 *  - Change attribution (Phase 4): every entry in the change summary comes from THIS
 *    task's own receipts. Files modified after the task's last write receipt are reported
 *    as possible user/external changes — never claimed by the task.
 *
 * Lightweight requests (no acceptance criteria, no deliverables) get NO delivery block at
 * all — no planning overhead, no ceremony; the existing completion path is unchanged.
 */

const MAX_CRITERIA = 12;
const MAX_DELIVERABLES = 8;
const MAX_EVIDENCE = 40;
const MAX_CHANGE_ENTRIES = 8;
const MAX_COMMAND_ENTRIES = 6;

/** File-path-looking tokens (the same shape the coordinator's deliverable checker scans for). */
const FILE_TOKEN_RE = /(?:[\w.@-]+\/)*[\w.@-]+\.(?:txt|md|json|csv|xlsx?|docx?|pdf|pptx|html?|log|tsx?|jsx?|py|css|ya?ml)\b/gi;

const WRITE_FAMILY = /^(write_file|edit_file|multi_edit|apply_patch|copy_file|make_dir|move_file)$/;
const COMMAND_FAMILY = /^(run_command|diagnostics|verify_command)$/;
const EXTERNAL_FAMILY = /^(browser_|github_|vercel_|deploy)/;

const clip = (s: string, n: number): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// ---------------------------------------------------------------- lifecycle entry points

/** True when the task carries substantial delivery work worth tracking (never for simple lookups). */
export const shouldTrackDelivery = (spec: { acceptance: unknown[]; deliverables: unknown[] }): boolean =>
  Array.isArray(spec.acceptance) && spec.acceptance.length > 0 && spec.acceptance.length <= MAX_CRITERIA;

/**
 * Phase 1 entry point: create the persisted acceptance-criteria states from the task's OWN
 * spec (the deterministic floor the spec builder already derived — nothing is invented
 * here, nothing is dropped, the user's original request stays in spec.request verbatim).
 * Every criterion from the spec is mandatory: the spec's acceptance list IS the contract.
 * Idempotent: an existing delivery block is never rebuilt (revisions go through
 * settleDelivery, not re-initialization).
 */
export async function initDelivery(t: TaskRecord): Promise<void> {
  if (t.delivery) return;
  if (!shouldTrackDelivery(t.spec)) return;
  const now = Date.now();
  t.delivery = {
    criteria: t.spec.acceptance.slice(0, MAX_CRITERIA).map((c) => ({
      id: c.id,
      kind: c.kind,
      detail: clip(c.detail, 200),
      mandatory: true, // spec acceptance criteria are the requested contract — all mandatory
      status: 'pending' as DeliveryCriterionStatus,
      updatedAt: now,
      evidenceIds: [],
    })),
    deliverables: t.spec.deliverables.slice(0, MAX_DELIVERABLES).map((d, i) => ({
      id: `D${i + 1}`,
      description: clip(d, 160),
      status: 'planned' as DeliverableStatus,
      dependsOn: [],
      updatedAt: now,
    })),
    evidence: [],
    updatedAt: now,
  };
  await persistTask(t);
}

/**
 * Phase 2 entry point: derive deliverable records from the PLAN (after setSteps). Each
 * step that promises a concrete output (`expectedOutput`, or a step title/detail naming a
 * file) gets a deliverable record with the step's dependency shape — a dependent
 * deliverable can never be verified while its prerequisite deliverable is failed or
 * unverified. Complements (never replaces) the spec-level deliverables created by
 * initDelivery; file-backed plan deliverables are what the completion gate checks.
 */
export async function initDeliverablesFromPlan(t: TaskRecord): Promise<void> {
  if (!t.delivery) await initDelivery(t);
  if (!t.delivery) return;
  const now = Date.now();
  const deliverables = t.delivery.deliverables;
  const nextSeq = deliverables.length;
  const stepDeliverable = new Map<string, string>(); // step id -> deliverable id
  for (const step of t.steps) {
    const promised = [step.expectedOutput ?? '', step.title, step.detail].join(' ');
    const tokens = [...new Set((promised.match(FILE_TOKEN_RE) ?? []).map((m) => m.trim()))].filter(
      (tok) => !/^(package(-lock)?|tsconfig|vite\.config|vitest\.config|tslint)\.(json|ts)/i.test(tok)
    );
    const isVerifyStep = step.kind === 'verifier';
    if (!tokens.length && !isVerifyStep) continue;
    if (tokens.length && deliverables.length < MAX_DELIVERABLES && !deliverables.some((d) => d.fromStep === step.id)) {
      const id = `D${nextSeq + deliverables.length + 1}`.slice(0, 8);
      const depIds = step.dependsOn
        .map((dep) => stepDeliverable.get(dep))
        .filter((x): x is string => !!x);
      deliverables.push({
        id,
        description: clip(step.expectedOutput ?? step.title, 160),
        path: tokens[0],
        dependsOn: depIds,
        fromStep: step.id,
        status: 'planned',
        updatedAt: now,
      });
      stepDeliverable.set(step.id, id);
    } else if (!tokens.length) {
      stepDeliverable.set(step.id, '');
    }
  }
  t.delivery.updatedAt = now;
  await persistTask(t);
}

/** Mark every still-pending criterion as in progress once execution actually starts (never downgrades). */
export async function markCriteriaInProgress(t: TaskRecord): Promise<void> {
  if (!t.delivery) return;
  let changed = false;
  for (const c of t.delivery.criteria) {
    if (c.status === 'pending') {
      c.status = 'in_progress';
      c.updatedAt = Date.now();
      changed = true;
    }
  }
  if (changed) {
    t.delivery.updatedAt = Date.now();
    await persistTask(t);
  }
}

// ------------------------------------------------------------------------ evidence

let evidenceSeq = 0;
const newEvidenceId = (t: TaskRecord): string => `${t.id}-E${++evidenceSeq}${Math.random().toString(36).slice(2, 5)}`;

/**
 * Append ONE evidence record (bounded) and optionally link it to a criterion. Evidence is
 * a POINTER to proof that already exists (a receipt id, a disk inspection, the verifier's
 * own check) — never a second record of the tool call itself.
 */
function addEvidence(
  t: TaskRecord,
  e: Omit<DeliveryEvidence, 'id' | 'at'> & { criterionId?: string }
): string {
  if (!t.delivery) return '';
  const id = newEvidenceId(t);
  const rec: DeliveryEvidence = { ...e, id, at: Date.now() };
  t.delivery.evidence = [...t.delivery.evidence, rec].slice(-MAX_EVIDENCE);
  if (e.criterionId) {
    const c = t.delivery.criteria.find((x) => x.id === e.criterionId);
    if (c) c.evidenceIds = [...c.evidenceIds, id].slice(-4);
  }
  return id;
}

const sourceFromMethod = (method: string): { source: DeliveryEvidenceSource; direct: boolean } => {
  const m = String(method ?? '');
  if (/disk stat|structural format/.test(m)) return { source: 'disk', direct: true };
  if (/command execution/.test(m)) return { source: 'command', direct: true };
  if (/independent review/.test(m)) return { source: 'reviewer', direct: true };
  if (/ledger/.test(m)) return { source: 'receipt', direct: false };
  return { source: 'receipt', direct: false };
};

// ------------------------------------------------------------------- step completion hook

/**
 * Phase 2/3 hook — called by the coordinator's runOneStep AFTER it has computed the step's
 * report, its claimed/verified/missing deliverable paths and its durable ledger. Updates
 * the deliverable records this step produces, with verification evidence bound to the
 * ACTUAL receipts and disk checks (never to the agent's DONE line):
 *   step failed → the deliverable fails (a verified one becomes unverified — its evidence
 *                 no longer describes the current world);
 *   step done  → the deliverable is produced; when its path was re-inspected on disk it
 *                is verified with the write receipts as evidence; when the claimed path
 *                is missing it stays unverified with the honest failure note.
 */
export async function noteDeliverableProgress(
  t: TaskRecord,
  step: TaskStep,
  report: string,
  facts: { claimedPaths: string[]; verifiedPaths: number; missingPaths: string[]; ledger: ToolExecutionRecord[]; stepFailed: boolean }
): Promise<void> {
  if (!t.delivery) return;
  const mine = t.delivery.deliverables.filter((d) => d.fromStep === step.id);
  if (!mine.length) return;
  const now = Date.now();
  const writeReceiptsFor = (p: string): string[] =>
    facts.ledger
      .filter((r) => r.status === 'ok' && WRITE_FAMILY.test(r.tool) && `${r.args}`.includes(p))
      .map((r) => r.id)
      .slice(0, 3);
  for (const d of mine) {
    if (facts.stepFailed) {
      if (d.status === 'verified') {
        d.status = 'unverified';
        d.failure = 'the producing step failed after an earlier verification — the old evidence no longer describes the current state';
      } else if (d.status !== 'skipped') {
        d.status = 'failed';
        d.failure = clip(report, 200);
      }
      d.updatedAt = now;
      continue;
    }
    // Step done. The deliverable is at least produced — the report claimed it.
    d.status = 'produced';
    d.producedAt = now;
    let method = 'step report + durable ledger (produced; not independently re-inspected)';
    let ok = false;
    let evidenceText = clip(report, 200);
    const receiptIds: string[] = [];
    if (d.path) {
      const dp = d.path;
      const claimedIdx = facts.claimedPaths.findIndex((p) => p === dp || p.endsWith(dp) || dp.endsWith(p));
      if (claimedIdx >= 0 && !facts.missingPaths.includes(facts.claimedPaths[claimedIdx])) {
        ok = true;
        method = 'claimed-deliverable re-inspection on disk';
        evidenceText = `${dp} exists on disk`;
        receiptIds.push(...writeReceiptsFor(dp));
      } else if (facts.missingPaths.some((p) => p === dp || p.endsWith(dp) || dp.endsWith(p))) {
        d.status = 'unverified';
        d.failure = `the claimed artifact ${dp} is NOT on disk — the claim is unsupported`;
      }
    }
    // Non-file deliverables (browser workflows, deployments): verified ONLY through the
    // step's own evidence-based verification record (Round 26 machinery) — never through
    // the agent's assertion.
    if (!ok && !d.path) {
      const sv = validVerification(step);
      if (sv?.status === 'verified') {
        ok = true;
        method = `step verification: ${sv.method}`;
        evidenceText = clip(sv.evidence, 200);
        receiptIds.push(...facts.ledger.filter((r) => r.status === 'ok').map((r) => r.id).slice(0, 2));
      } else if (sv) {
        d.status = 'unverified';
        d.failure = `the step's own verification is ${sv.status} — ${clip(sv.observed, 120)}`;
      }
    }
    if (ok && d.status !== 'unverified') {
      d.status = 'verified';
      d.verification = { at: now, method, ok: true, evidence: evidenceText, receiptIds };
      addEvidence(t, {
        what: `deliverable ${d.id}: ${clip(d.description, 80)}`,
        source: method.startsWith('claimed-deliverable') ? 'disk' : 'receipt',
        receiptId: receiptIds[0],
        tool: 'coordinator',
        deliverableId: d.id,
        ok: true,
        direct: true,
        detail: evidenceText,
        basis: d.path ? { path: resolveWorkspacePath(d.path), at: now } : undefined,
      });
    }
    d.updatedAt = now;
  }
  t.delivery.updatedAt = now;
  await persistTask(t);
}

// ------------------------------------------------------------------------ freshness

const resolveWorkspacePath = (p: string): string => {
  if (path.isAbsolute(p) || /^[a-z]:[\\/]/i.test(p)) return p;
  const joined = path.join(FILES_ROOT, p);
  return isInsideRoot(path.resolve(path.sep, p)) ? path.resolve(path.sep, p) : joined;
};

/**
 * Phase 3 freshness sweep. File-basis evidence goes stale when the file's mtime moved past
 * the recorded basis (the proof no longer describes the file). Command-basis evidence
 * (build/typecheck) goes stale when a LATER write-family receipt exists for the task (the
 * source changed after the command ran). A criterion whose evidence is ALL stale reverts
 * to pending — staleness never silently satisfies anything. Bounded and cheap: one pass.
 */
export function sweepStaleEvidence(t: TaskRecord, records: ToolExecutionRecord[]): number {
  if (!t.delivery) return 0;
  let staled = 0;
  const lastWriteAt = Math.max(-1, ...records.filter((r) => r.status === 'ok' && WRITE_FAMILY.test(r.tool)).map((r) => r.t));
  for (const e of t.delivery.evidence) {
    if (e.stale || !e.basis) continue;
    if (e.basis.path) {
      try {
        const st = fsSync.statSync(e.basis.path);
        if (st.mtimeMs > (e.basis.mtimeMs ?? 0) + 1) {
          e.stale = true;
          staled++;
        }
      } catch {
        e.stale = true; // the file the evidence described is GONE — the evidence is stale by definition
        staled++;
      }
    } else if (e.source === 'command' && lastWriteAt > e.basis.at) {
      e.stale = true;
      staled++;
    }
  }
  if (staled) {
    for (const c of t.delivery.criteria) {
      const mine = c.evidenceIds.map((id) => t.delivery?.evidence.find((e) => e.id === id)).filter((e): e is DeliveryEvidence => !!e);
      if (mine.length && mine.every((e) => e.stale) && (c.status === 'satisfied' || c.status === 'in_progress')) {
        c.status = 'pending';
        c.updatedAt = Date.now();
        c.lastCheck = 'previous evidence went stale (the underlying files changed) — re-verification required';
      }
    }
    t.delivery.updatedAt = Date.now();
  }
  return staled;
}

// ------------------------------------------------------------------------- settle

/**
 * Phase 1/3/4 settle — called by the coordinator right after verifyAcceptance stored the
 * task's VerificationResult. Maps each criterion check (index-aligned with spec.acceptance,
 * which is exactly how verifyAcceptance emits them) into the persisted criterion states,
 * records the evidence for each, applies the deliverable dependency gate, captures the
 * change summary and runs the lightweight delivery review. PERSISTS everything.
 */
export async function settleDelivery(t: TaskRecord): Promise<void> {
  if (!t.delivery) return;
  const now = Date.now();
  const records = await recordsForTask(t.id, t.createdAt).catch(() => [] as ToolExecutionRecord[]);
  sweepStaleEvidence(t, records);

  // 1. Criterion states from the verification results (index-aligned; extra rows are the
  //    reviewer's and become their own evidence).
  const results = t.verification?.results ?? [];
  t.delivery.criteria.forEach((c, i) => {
    const r = results[i];
    if (!r) return; // criterion not checked this round — its state stands
    const { source, direct } = sourceFromMethod(r.method ?? '');
    const blockedWorld =
      !r.pass &&
      (/no command runner|no write step|no written file|nothing executed|unverified/i.test(r.evidence) ||
        stepsBlockedByFailure(t).length > 0 ||
        failedSteps(t).length > 0);
    const prev = c.status;
    c.status = r.pass ? 'satisfied' : blockedWorld && prev !== 'satisfied' ? 'blocked' : 'failed';
    c.updatedAt = now;
    c.lastCheck = clip(r.evidence, 220);
    addEvidence(t, {
      what: `criterion: ${clip(c.detail, 100)}`,
      source,
      tool: r.method ? undefined : 'verifier',
      criterionId: c.id,
      ok: r.pass,
      direct,
      detail: clip(r.evidence, 240),
      limits: r.pass ? undefined : 'the check did not pass — the criterion is not satisfied',
    });
  });
  // The independent reviewer's row (appended by verifyAcceptance) is evidence too — it can
  // only lower the verdict, never inflate one.
  for (const r of results.slice(t.delivery.criteria.length)) {
    const { source, direct } = sourceFromMethod(r.method ?? 'independent review');
    addEvidence(t, {
      what: 'independent reviewer verdict',
      source,
      ok: r.pass,
      direct,
      detail: clip(r.evidence, 240),
    });
  }

  // 2. Deliverable dependency gate: a deliverable whose prerequisite failed or is unverified
  //    cannot be verified in this round — it is blocked, never quietly complete.
  for (const d of t.delivery.deliverables) {
    if (d.status === 'verified' || d.status === 'skipped' || d.status === 'failed') continue;
    const unsoundDep = d.dependsOn.some((depId) => {
      const dep = t.delivery?.deliverables.find((x) => x.id === depId);
      return !!dep && (dep.status === 'failed' || dep.status === 'unverified' || dep.status === 'blocked');
    });
    if (unsoundDep && d.status !== 'blocked') {
      d.status = 'blocked';
      d.failure = 'a prerequisite deliverable failed or is unverified — this deliverable cannot be verified yet';
      d.updatedAt = now;
    }
  }

  // 3. Change summary + review (Phase 4), captured on the same settle.
  t.delivery.changes = buildChangeSummary(t, records);
  t.delivery.review = reviewDelivery(t);
  t.delivery.updatedAt = now;
  await persistTask(t);
}

// -------------------------------------------------------------- Phase 4: change awareness

/**
 * The change inventory, built ONLY from this task's own durable receipts. Created vs
 * modified follows the tool semantics (write_file/apply_patch-Add/copy/move-target =
 * created; edit_file/multi_edit/apply_patch-Update = modified); move_file contributes both
 * a deletion (source) and a creation (target). Files written by the task AND modified
 * again after the task's LAST write receipt are listed as possible user/external changes —
 * explicitly NOT claimed by the task.
 */
export function buildChangeSummary(t: TaskRecord, records: ToolExecutionRecord[]): DeliveryChangeSummary {
  const created = new Set<string>();
  const modified = new Set<string>();
  const deleted = new Set<string>();
  const commands: DeliveryChangeSummary['commands'] = [];
  const externalOps: string[] = [];
  let lastWriteAt = -1;
  const writeTouched = new Map<string, number>(); // path -> latest write receipt time

  const argPath = (r: ToolExecutionRecord): string | null => {
    try {
      const a = JSON.parse(r.args) as Record<string, unknown>;
      const p = a.path ?? a.to;
      return typeof p === 'string' ? p : null;
    } catch {
      return null;
    }
  };

  for (const r of records) {
    if (r.status !== 'ok') continue;
    if (WRITE_FAMILY.test(r.tool)) {
      lastWriteAt = Math.max(lastWriteAt, r.t);
      const patchAdds = r.tool === 'apply_patch' ? [...r.args.matchAll(/\*\*\* Add File: (.+)/g)].map((m) => m[1].trim()) : [];
      const patchUpdates = r.tool === 'apply_patch' ? [...r.args.matchAll(/\*\*\* Update File: (.+)/g)].map((m) => m[1].trim()) : [];
      for (const f of patchAdds) created.add(f);
      for (const f of patchUpdates) modified.add(f);
      // Target resolution follows the TOOL semantics (the same convention the completion
      // engine uses): copy_file/move_file write their TARGET (`to`), everything else its
      // `path`; move_file additionally deletes its source.
      const isMoveOrCopy = r.tool === 'move_file' || r.tool === 'copy_file';
      const argObj: Record<string, unknown> = (() => {
        try {
          return JSON.parse(r.args) as Record<string, unknown>;
        } catch {
          return {};
        }
      })();
      const p = isMoveOrCopy
        ? typeof argObj.to === 'string'
          ? argObj.to
          : null
        : typeof argObj.path === 'string'
          ? argObj.path
          : argPath(r);
      if (p) {
        if (r.tool === 'write_file' || r.tool === 'copy_file' || r.tool === 'make_dir' || r.tool === 'move_file') {
          created.add(p);
          writeTouched.set(p, Math.max(writeTouched.get(p) ?? 0, r.t));
        } else if (r.tool === 'edit_file' || r.tool === 'multi_edit') {
          modified.add(p);
          writeTouched.set(p, Math.max(writeTouched.get(p) ?? 0, r.t));
        }
      }
      if (r.tool === 'move_file' && typeof argObj.path === 'string') {
        deleted.add(argObj.path);
        writeTouched.delete(argObj.path); // the source is gone — nothing left to suspect
      }
    } else if (COMMAND_FAMILY.test(r.tool) && commands.length < MAX_COMMAND_ENTRIES) {
      commands.push({ tool: r.tool, command: clip(r.args, 120), exit0: /exit 0/.test(String(r.result ?? '')) });
    } else if (EXTERNAL_FAMILY.test(r.tool) && externalOps.length < MAX_CHANGE_ENTRIES) {
      externalOps.push(clip(`${r.tool}: ${r.args}`, 80));
    }
  }
  created.forEach((f) => modified.delete(f)); // a path created then edited stays "created"
  const userTouchedSuspects = lastWriteAt > 0
    ? [...writeTouched.entries()]
        .filter(([, at]) => at === lastWriteAt)
        .map(([p]) => p)
        .filter((p) => {
          try {
            return fsSync.statSync(resolveWorkspacePath(p)).mtimeMs > lastWriteAt + 1500;
          } catch {
            return false;
          }
        })
        .slice(0, MAX_CHANGE_ENTRIES)
    : [];
  return {
    filesCreated: [...created].slice(0, MAX_CHANGE_ENTRIES),
    filesModified: [...modified].slice(0, MAX_CHANGE_ENTRIES),
    filesDeleted: [...deleted].slice(0, MAX_CHANGE_ENTRIES),
    commands,
    externalOps,
    attributionNote:
      'every entry comes from this task\'s own durable tool-execution receipts; content that pre-dated the task and edits made outside the task\'s tools are NOT attributed to it',
    userTouchedSuspects,
    capturedAt: Date.now(),
  };
}

// --------------------------------------------------------------- Phase 4: delivery review

/**
 * The lightweight pre-completion review (proportional to the task — no re-verification, no
 * new commands): seven honest answers derived from the persisted state, and a
 * ready-to-hand-over flag that is TRUE only when nothing is unresolved.
 */
export function reviewDelivery(t: TaskRecord): DeliveryReview {
  const d = t.delivery;
  const unsatisfied = (d?.criteria ?? []).filter((c) => c.mandatory && c.status !== 'satisfied' && c.status !== 'not_applicable');
  const unverifiedDeliverables = (d?.deliverables ?? []).filter((x) => x.status !== 'verified' && x.status !== 'skipped' && x.status !== 'not_applicable' as DeliverableStatus);
  const produced = (d?.deliverables ?? []).filter((x) => x.status === 'verified' || x.status === 'produced');
  const failedChecks = (d?.evidence ?? []).filter((e) => !e.ok);
  const unresolvedSteps = t.steps.filter((s) => s.outcomeUnknown || s.status === 'pending' || s.status === 'running');
  const ready =
    unsatisfied.length === 0 && unverifiedDeliverables.length === 0 && unresolvedSteps.length === 0 && failedChecks.length === 0;
  return {
    at: Date.now(),
    producedOutputs:
      produced.length || (d?.changes?.filesCreated.length ?? 0) + (d?.changes?.filesModified.length ?? 0) > 0
        ? `${produced.length} tracked deliverable(s) produced, ${d?.changes?.filesCreated.length ?? 0} file(s) created and ${d?.changes?.filesModified.length ?? 0} modified by this task`
        : 'no concrete outputs recorded yet',
    criteriaState:
      (d?.criteria ?? []).length === 0
        ? 'no tracked criteria (lightweight task)'
        : `${(d?.criteria ?? []).filter((c) => c.status === 'satisfied').length}/${d?.criteria.length} satisfied` +
          (unsatisfied.length ? ` — unsatisfied: ${unsatisfied.map((c) => clip(c.detail, 60)).join('; ')}` : ''),
    unexpectedChanges: (d?.changes?.userTouchedSuspects.length ?? 0)
      ? `${d?.changes?.userTouchedSuspects.length} file(s) were modified after the task's last write (possible user/external change): ${d?.changes?.userTouchedSuspects.join(', ')}`
      : 'no unexpected changes observed',
    verificationFailures: failedChecks.length
      ? `${failedChecks.length} failed check(s) recorded: ${failedChecks.slice(-2).map((e) => clip(e.what, 60)).join('; ')}`
      : 'no failed verification checks',
    unresolvedDeps: unresolvedSteps.length
      ? `${unresolvedSteps.length} step(s) pending/running/unknown: ${unresolvedSteps.slice(0, 3).map((s) => clip(s.title, 40)).join('; ')}`
      : 'no unresolved step dependencies',
    securityLimits: (d?.changes?.externalOps.length ?? 0)
      ? `${d?.changes?.externalOps.length} external operation(s) ran under the existing approval/permission gates`
      : 'none beyond the standing policy gates',
    readyToHandOver: ready,
  };
}

// -------------------------------------------------------------- Phase 1: the completion gate

export interface DeliveryGate {
  /** complete = every mandatory criterion satisfied and every mandatory file deliverable verified. */
  state: 'complete' | 'partial' | 'blocked' | 'failed' | 'untracked';
  /** The unsatisfied mandatory criteria and unverified mandatory file deliverables (the honest "why not complete"). */
  unsatisfied: string[];
  /** How much IS done (for the honest partial message). */
  satisfiedCount: number;
  mandatoryCount: number;
}

/**
 * THE COMPLETION GATE. Reads ONLY persisted state. A task with no delivery block is
 * 'untracked' (lightweight path — the existing completion rules apply unchanged).
 * 'blocked' means genuine uncertainty (unknown-outcome steps / unresolved work) — never a
 * silent pass; 'partial' means real progress with real gaps; 'failed' means the mandatory
 * work did not land.
 */
export function deliveryGate(t: TaskRecord): DeliveryGate {
  const d = t.delivery;
  if (!d || (!d.criteria.length && !d.deliverables.length)) return { state: 'untracked', unsatisfied: [], satisfiedCount: 0, mandatoryCount: 0 };
  const mandatory = d.criteria.filter((c) => c.mandatory);
  const unsatisfied: string[] = [];
  let uncertainty = false;
  for (const c of mandatory) {
    if (c.status === 'satisfied' || c.status === 'not_applicable') continue;
    if (c.status === 'blocked') uncertainty = true;
    unsatisfied.push(`criterion: ${clip(c.detail, 80)} (${c.status})`);
  }
  // File-backed deliverables gate completion — a planned file must never pass as existing.
  const fileDeliverables = d.deliverables.filter((x) => !!x.path);
  for (const dv of fileDeliverables) {
    if (dv.status === 'verified' || dv.status === 'skipped') continue;
    if (dv.status === 'blocked') uncertainty = true;
    unsatisfied.push(`deliverable: ${clip(dv.description, 70)} (${dv.status})`);
  }
  const satisfiedCount =
    mandatory.filter((c) => c.status === 'satisfied' || c.status === 'not_applicable').length +
    fileDeliverables.filter((x) => x.status === 'verified' || x.status === 'skipped').length;
  const mandatoryCount = mandatory.length + fileDeliverables.length;
  // Honest unknown-outcome steps block completion by themselves (Phase 5: never mark an
  // uncertain operation as successful without evidence) — even when every tracked
  // criterion happens to be satisfied, an UNRECONCILED uncertainty keeps the gate open.
  if (t.steps.some((s) => s.outcomeUnknown)) uncertainty = true;
  let state: DeliveryGate['state'];
  if (unsatisfied.length === 0 && !uncertainty) state = 'complete';
  else if (uncertainty) state = 'blocked';
  else if (satisfiedCount > 0) state = 'partial';
  else state = 'failed';
  return { state, unsatisfied: unsatisfied.slice(0, 6), satisfiedCount, mandatoryCount };
}

/** The honest verdict for a task that did NOT pass the gate (never inflates a failure into a success). */
export const honestVerdictFor = (gate: DeliveryGate): 'partial' | 'blocked' | 'failed' =>
  gate.state === 'blocked' ? 'blocked' : gate.state === 'partial' ? 'partial' : 'failed';

// ----------------------------------------------------------------- Phase 5: resume support

/**
 * Resume reconciliation for the delivery block (runs INSIDE the existing resumeTask flow —
 * it is not a second recovery manager): in-flight claims revert to honest non-claims,
 * evidence freshness is re-checked against the CURRENT receipts, and criteria blocked by
 * previously-unknown outcomes return to pending once those outcomes were reconciled.
 * Returns a one-line summary for the resume message.
 */
export async function reconcileDeliveryAtResume(t: TaskRecord, reconciledUnknowns: number): Promise<string> {
  if (!t.delivery) {
    // A pre-Round-35 task resuming under Round 35: initialize tracking from its spec.
    await initDelivery(t);
    if (!t.delivery) return '';
  }
  const d = t.delivery!;
  const now = Date.now();
  for (const c of d.criteria) {
    if (c.status === 'in_progress') {
      c.status = 'pending';
      c.updatedAt = now;
    }
    // Criteria blocked by uncertainty that has now been reconciled get another chance.
    if (c.status === 'blocked' && reconciledUnknowns === 0) {
      const stillUncertain = t.steps.some((s) => s.outcomeUnknown);
      if (!stillUncertain) {
        c.status = 'pending';
        c.updatedAt = now;
      }
    }
  }
  for (const dv of d.deliverables) {
    if (dv.status === 'in_progress') {
      dv.status = 'planned';
      dv.updatedAt = now;
    }
  }
  const records = await recordsForTask(t.id, t.createdAt).catch(() => [] as ToolExecutionRecord[]);
  const staled = sweepStaleEvidence(t, records);
  d.updatedAt = now;
  await persistTask(t);
  const done = d.criteria.filter((c) => c.status === 'satisfied').length;
  const parts = [
    `${done}/${d.criteria.length} acceptance criterion(a) already satisfied`,
    `${d.deliverables.filter((x) => x.status === 'verified').length}/${d.deliverables.length} deliverable(s) verified`,
  ];
  if (staled) parts.push(`${staled} evidence record(s) went stale and were reset for re-verification`);
  if (reconciledUnknowns) parts.push(`${reconciledUnknowns} previously-unknown execution outcome(s) were reconciled`);
  return `delivery: ${parts.join('; ')}`;
}

// ------------------------------------------------------------------- projections (Phase 6)

/** One-line delivery summary for task_status / the HUD prompt block (bounded, honest). */
export function deliveryStatusLine(t: TaskRecord): string {
  const d = t.delivery;
  if (!d) return '';
  const sat = d.criteria.filter((c) => c.status === 'satisfied').length;
  const ver = d.deliverables.filter((x) => x.status === 'verified').length;
  const evOk = d.evidence.filter((e) => e.ok && !e.stale).length;
  const gate = deliveryGate(t);
  const ready = d.review?.readyToHandOver ? 'ready to hand over' : 'NOT ready to hand over';
  return `DELIVERY: criteria ${sat}/${d.criteria.length} satisfied · deliverables ${ver}/${d.deliverables.length} verified · evidence ${evOk} direct record(s)${d.evidence.some((e) => e.stale) ? ` (some stale)` : ''} · gate: ${gate.state}${d.review ? ` · ${ready}` : ''}`;
}

export interface DeliveryView {
  tracked: boolean;
  criteria: Array<{ detail: string; status: DeliveryCriterionStatus; mandatory: boolean; lastCheck?: string }>;
  counts: { satisfied: number; failed: number; pending: number; blocked: number; inProgress: number; notApplicable: number; total: number };
  deliverables: Array<{ id: string; description: string; status: DeliverableStatus; path?: string; verification?: string; failure?: string }>;
  evidence: { total: number; ok: number; stale: number; failed: number; recent: Array<{ what: string; source: DeliveryEvidenceSource; ok: boolean; stale?: boolean; detail: string }> };
  changes?: DeliveryChangeSummary;
  review?: DeliveryReview;
  gate: { state: DeliveryGate['state']; unsatisfied: string[] };
  recovery: { canResume: boolean; reconciliationRequired: boolean; approvalRequired: boolean };
}

/**
 * The Operations Center projection of ONE task's delivery state — every value read from
 * the persisted record (never from the renderer's optimistic state), bounded for display.
 */
export function deliveryView(t: TaskRecord): DeliveryView | undefined {
  const d = t.delivery;
  if (!d) return undefined;
  const counts = {
    satisfied: 0, failed: 0, pending: 0, blocked: 0, inProgress: 0, notApplicable: 0, total: d.criteria.length,
  };
  for (const c of d.criteria) {
    if (c.status === 'satisfied') counts.satisfied++;
    else if (c.status === 'failed') counts.failed++;
    else if (c.status === 'blocked') counts.blocked++;
    else if (c.status === 'in_progress') counts.inProgress++;
    else if (c.status === 'not_applicable') counts.notApplicable++;
    else counts.pending++;
  }
  const ok = d.evidence.filter((e) => e.ok && !e.stale).length;
  const stale = d.evidence.filter((e) => e.stale).length;
  const failedEv = d.evidence.filter((e) => !e.ok).length;
  const gate = deliveryGate(t);
  const unresolvedSteps = t.steps.some((s) => s.outcomeUnknown || s.status === 'pending' || s.status === 'running');
  return {
    tracked: true,
    criteria: d.criteria.slice(0, 8).map((c) => ({ detail: c.detail, status: c.status, mandatory: c.mandatory, lastCheck: c.lastCheck })),
    counts,
    deliverables: d.deliverables.slice(0, 8).map((x) => ({
      id: x.id,
      description: x.description,
      status: x.status,
      path: x.path,
      verification: x.verification ? `${x.verification.method} — ${clip(x.verification.evidence, 120)}` : undefined,
      failure: x.failure,
    })),
    evidence: {
      total: d.evidence.length,
      ok,
      stale,
      failed: failedEv,
      recent: d.evidence.slice(-5).reverse().map((e) => ({ what: clip(e.what, 70), source: e.source, ok: e.ok, stale: e.stale, detail: clip(e.detail, 110) })),
    },
    changes: d.changes,
    review: d.review,
    gate: { state: gate.state, unsatisfied: gate.unsatisfied },
    recovery: {
      canResume: t.status === 'INTERRUPTED' || t.status === 'PAUSED' || t.status === 'RECOVERING',
      reconciliationRequired: unresolvedSteps || stale > 0 || gate.state === 'blocked',
      approvalRequired: t.status === 'WAITING_FOR_INPUT',
    },
  };
}
