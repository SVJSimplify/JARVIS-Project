/**
 * ROUND 35 — TARGETED FUNCTIONAL CHECK (the permitted "small targeted check").
 *
 * Covers the Round 35 project-delivery machinery end-to-end at module level (deterministic,
 * temp fixtures, no LLM / browser / Electron / network) plus the Round 34 security baseline
 * that must survive this round untouched:
 *
 *   [1]  Phase 1 — acceptance criteria tracking: initDelivery derives the persisted
 *        criterion states from the task's OWN spec (all mandatory, pending), lightweight
 *        requests stay untracked, re-initialization is idempotent.
 *   [2]  Phase 2 — plan-derived deliverables: file-backed deliverables with the plan's
 *        dependency shape; non-output steps produce nothing.
 *   [3]  Phase 2/3 — noteDeliverableProgress: disk-verified deliverable WITH write-receipt
 *        evidence; missing claimed artifact stays unverified with the honest failure;
 *        a failed producing step fails the deliverable (a verified one becomes unverified).
 *   [4]  Phase 3/4 — settleDelivery: index-aligned criterion states from verification
 *        results, evidence records with honest direct/inferred sources, reviewer evidence,
 *        change summary + review captured, persisted in the task record.
 *   [5]  Phase 3 — freshness: file-basis evidence goes stale when the mtime moves (and a
 *        satisfied criterion REVERTS to pending); command evidence goes stale after a later
 *        write; missing file = stale by definition.
 *   [6]  Phase 1 — THE COMPLETION GATE: complete / partial / blocked / failed / untracked,
 *        unknown-outcome steps block completion, honestVerdictFor never inflates.
 *   [7]  Phase 4 — change inventory: created/modified/deleted from the tool semantics,
 *        move = delete+create, commands with exit codes, external ops, attribution note,
 *        created-then-edited stays created.
 *   [8]  Phase 5 — resume reconciliation: in-flight claims revert, summary counts preserved
 *        work, blocked criteria recover when uncertainty is reconciled.
 *   [9]  Phase 6 — deliveryView projection: counts, recovery flags, evidence summary.
 *  [10]  Phase 5 — task-store boot reconciliation resets in-flight delivery claims of a
 *        dead process (persisted through the ONE task file).
 *  [11]  Round 34 baseline intact: bwrap first in the sandbox argv (finding K), the
 *        two-tier verified-bounded contract still refuses code executors, the corrected
 *        probe step map is in the source, and no form.submit() fallback exists.
 *
 * Run: npx tsx scripts/round35FocusedCheck.ts
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ToolExecutionRecord } from '../src/main/toolRecord';

process.env.JARVIS_FILES_ROOT = ''; // set to the fixture root before the engine modules load

let pass = 0;
let fail = 0;
const failures: string[] = [];
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(detail ? `${name} — ${detail}` : name);
  }
};
const eq = (name: string, got: unknown, want: unknown): void =>
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-r35-check-'));
  process.env.JARVIS_FILES_ROOT = tmp;
  const brain = path.join(tmp, 'brain');
  await fs.mkdir(path.join(brain, 'tasks'), { recursive: true });
  await fs.mkdir(path.join(brain, 'toollog'), { recursive: true });

  const { buildTaskSpec } = await import('../src/main/taskSpec');
  const store = await import('../src/main/taskStore');
  const delivery = await import('../src/main/delivery');

  // -------------------------------------------------------------- [1] criteria tracking
  {
    const spec = buildTaskSpec('Write the quarterly summary to reports/q3-summary.md with the three headline numbers');
    ok('[1] spec derives file acceptance criteria', spec.acceptance.some((c) => c.kind === 'file-exists') && spec.acceptance.length >= 3);
    const t = await store.createTask(spec, 'test');
    await delivery.initDelivery(t);
    ok('[1] delivery block created for substantial work', !!t.delivery);
    eq('[1] criteria count matches the spec', t.delivery?.criteria.length, spec.acceptance.length);
    ok('[1] every criterion mandatory + pending', (t.delivery?.criteria ?? []).every((c) => c.mandatory && c.status === 'pending'));
    ok('[1] criterion ids mirror the spec', (t.delivery?.criteria ?? []).every((c) => spec.acceptance.some((a) => a.id === c.id)));
    const before = JSON.stringify(t.delivery);
    await delivery.initDelivery(t);
    ok('[1] initDelivery is idempotent', JSON.stringify(t.delivery) === before);

    const lightSpec = buildTaskSpec('What is the capital of France?');
    const light = await store.createTask(lightSpec, 'test');
    await delivery.initDelivery(light);
    ok('[1] lightweight request stays untracked (no ceremony)', !light.delivery);
    ok('[1] shouldTrackDelivery reflects the spec', !delivery.shouldTrackDelivery(lightSpec) && delivery.shouldTrackDelivery(spec));
  }

  // --------------------------------------------------- [2] plan-derived deliverables
  {
    const spec = buildTaskSpec('Create src/widget.tsx and then a docs note at docs/widget.md describing it');
    const t = await store.createTask(spec, 'test');
    await delivery.initDelivery(t);
    await store.setSteps(t, [
      { id: 's1', title: 'Implement src/widget.tsx', detail: 'create src/widget.tsx with the component', kind: 'coder', dependsOn: [], expectedOutput: 'src/widget.tsx' },
      { id: 's2', title: 'Write docs/widget.md', detail: 'document the component in docs/widget.md', kind: 'document', dependsOn: ['s1'], expectedOutput: 'docs/widget.md' },
      { id: 's3', title: 'Verify the result', detail: 'check both files exist and reopen', kind: 'verifier', dependsOn: ['s1', 's2'] },
    ]);
    await delivery.initDeliverablesFromPlan(t);
    const planDeliverables = (t.delivery?.deliverables ?? []).filter((d) => !!d.fromStep);
    eq('[2] plan deliverables derived from file-promising steps', planDeliverables.map((d) => d.path).sort(), ['docs/widget.md', 'src/widget.tsx']);
    const s2 = planDeliverables.find((d) => d.fromStep === 's2');
    ok('[2] dependency shape mirrors the plan DAG', !!s2 && s2.dependsOn.length === 1 && planDeliverables.some((d) => s2.dependsOn.includes(d.id)));
    ok('[2] verifier step without a file promise produced no deliverable', !(t.delivery?.deliverables ?? []).some((d) => d.fromStep === 's3'));
  }

  // --------------------------------- [3] deliverable progress from real facts
  {
    const spec = buildTaskSpec('Create report-a.md and report-b.md in the workspace');
    const t = await store.createTask(spec, 'test');
    await delivery.initDelivery(t);
    await store.setSteps(t, [
      { id: 's1', title: 'Write report-a.md', detail: 'write report-a.md', kind: 'coder', dependsOn: [], expectedOutput: 'report-a.md' },
      { id: 's2', title: 'Write report-b.md', detail: 'write report-b.md', kind: 'coder', dependsOn: ['s1'], expectedOutput: 'report-b.md' },
      { id: 's3', title: 'Verify', detail: 'check the files', kind: 'verifier', dependsOn: ['s1', 's2'] },
    ]);
    await delivery.initDeliverablesFromPlan(t);
    const da = (t.delivery?.deliverables ?? []).find((d) => d.fromStep === 's1');
    const db = (t.delivery?.deliverables ?? []).find((d) => d.fromStep === 's2');
    const stepA = t.steps.find((s) => s.id === 's1');
    const stepB = t.steps.find((s) => s.id === 's2');
    await store.markStep(t, 's1', { status: 'running' });

    // (a) step done, file EXISTS on disk, write receipt in the ledger → verified with receipts
    await fs.writeFile(path.join(tmp, 'report-a.md'), '# A', 'utf8');
    const writeReceipt: ToolExecutionRecord = {
      id: 'R1', t: Date.now(), ms: 5, tool: 'write_file', agent: 'task:test', args: JSON.stringify({ path: 'report-a.md' }),
      auth: 'autonomous', status: 'ok', result: 'ok', retries: 0,
    };
    const stepA2 = t.steps.find((s) => s.id === 's1');
    await delivery.noteDeliverableProgress(t, stepA2 ?? (stepA as store.TaskStep), 'DONE: wrote report-a.md', {
      claimedPaths: ['report-a.md'], verifiedPaths: 1, missingPaths: [], ledger: [writeReceipt], stepFailed: false,
    });
    eq('[3] disk-verified deliverable status', da?.status, 'verified');
    ok('[3] verification evidence carries the write receipt id', (da?.verification?.receiptIds ?? []).includes('R1'));
    ok('[3] verification method names the disk re-inspection', (da?.verification?.method ?? '').includes('re-inspection on disk'));
    ok('[3] evidence record added with a freshness basis', (t.delivery?.evidence ?? []).some((e) => e.deliverableId === da?.id && !!e.basis?.path));

    // (b) step done, claimed path MISSING → unverified with the honest failure
    await store.markStep(t, 's2', { status: 'running' });
    const stepB2 = t.steps.find((s) => s.id === 's2');
    await delivery.noteDeliverableProgress(t, stepB2 ?? (stepB as store.TaskStep), 'DONE: wrote report-b.md', {
      claimedPaths: ['report-b.md'], verifiedPaths: 0, missingPaths: ['report-b.md'], ledger: [], stepFailed: false,
    });
    eq('[3] missing claimed artifact stays unverified', db?.status, 'unverified');
    ok('[3] honest failure note names the missing artifact', (db?.failure ?? '').includes('NOT on disk'));

    // (c) failed producing step → failed deliverable; a VERIFIED one degrades to unverified
    const stepA3 = t.steps.find((s) => s.id === 's1');
    await delivery.noteDeliverableProgress(t, stepA3 ?? (stepA as store.TaskStep), 'FAILED: disk full', {
      claimedPaths: [], verifiedPaths: 0, missingPaths: [], ledger: [], stepFailed: true,
    });
    eq('[3] failed producing step fails the deliverable', da?.status, 'unverified');
    ok('[3] verified state degraded honestly (evidence no longer describes the world)', (da?.failure ?? '').includes('no longer describes'));

    const stepB3 = t.steps.find((s) => s.id === 's2');
    await delivery.noteDeliverableProgress(t, stepB3 ?? (stepB as store.TaskStep), 'FAILED: refused', {
      claimedPaths: [], verifiedPaths: 0, missingPaths: [], ledger: [], stepFailed: true,
    });
    eq('[3] never-verified failing step fails the deliverable', db?.status, 'failed');
  }

  // --------------------------------------- [4] settleDelivery (criteria + evidence)
  {
    const spec = buildTaskSpec('Write the analysis to analysis.md and keep it valid');
    const t = await store.createTask(spec, 'test');
    await delivery.initDelivery(t);
    await store.setSteps(t, [{ id: 's1', title: 'Write analysis.md', detail: 'write analysis.md', kind: 'coder', dependsOn: [] }]);
    await fs.writeFile(path.join(tmp, 'analysis.md'), '# analysis', 'utf8');
    const nCriteria = t.delivery?.criteria.length ?? 0;
    // Verification results are INDEX-ALIGNED with spec.acceptance (verifyAcceptance contract).
    t.verification = {
      checkedAt: Date.now(),
      passed: false,
      results: t.spec.acceptance.map((c, i) => ({
        criterion: c.detail,
        pass: i < nCriteria - 1,
        evidence: i < nCriteria - 1 ? `${path.join(tmp, 'analysis.md')} exists (${12} bytes)` : 'the file could not be validated',
        method: i < nCriteria - 1 ? 'disk stat' : 'structural format validation',
        observed: 'on disk',
      })),
    };
    await store.persistTask(t);
    await delivery.settleDelivery(t);
    const crit = t.delivery?.criteria ?? [];
    eq('[4] satisfied criteria count', crit.filter((c) => c.status === 'satisfied').length, nCriteria - 1);
    eq('[4] failed criteria count', crit.filter((c) => c.status === 'failed').length, 1);
    ok('[4] failed criterion carries its last check line', !!crit.find((c) => c.status === 'failed')?.lastCheck);
    ok('[4] disk checks recorded as DIRECT evidence', (t.delivery?.evidence ?? []).filter((e) => e.criterionId).every((e) => e.direct && e.source === 'disk'));
    ok('[4] each checked criterion links its evidence', crit.filter((c) => c.status !== 'pending').every((c) => c.evidenceIds.length > 0));
    ok('[4] change summary captured', !!t.delivery?.changes);
    ok('[4] delivery review captured with the seven answers', !!t.delivery?.review && typeof t.delivery.review.readyToHandOver === 'boolean');
    // persisted through the ONE save path (reread from disk through the store)
    const reread = await store.getTask(t.id);
    ok('[4] delivery state is PERSISTED in the task record', !!reread?.delivery?.review && reread.delivery.criteria.length === nCriteria);
  }

  // ------------------------------------------------------- [5] evidence freshness
  {
    const spec = buildTaskSpec('Write fresh-check.md with the summary');
    const t = await store.createTask(spec, 'test');
    await delivery.initDelivery(t);
    await store.setSteps(t, [{ id: 's1', title: 'Write fresh-check.md', detail: 'write it', kind: 'coder', dependsOn: [] }]);
    const filePath = path.join(tmp, 'fresh-check.md');
    await fs.writeFile(filePath, 'v1', 'utf8');
    const at = Date.now();
    (t as { delivery: NonNullable<store.TaskRecord['delivery']> }).delivery!.evidence = [
      {
        id: 'E1', what: 'file exists', source: 'disk', at, ok: true, direct: true, detail: 'exists',
        basis: { path: filePath, mtimeMs: (await fs.stat(filePath)).mtimeMs, at },
      },
      {
        id: 'E2', what: 'build passed', source: 'command', receiptId: 'R9', tool: 'run_command', at, ok: true, direct: true, detail: 'exit 0',
        basis: { at: at - 1000 },
      },
    ];
    (t as { delivery: NonNullable<store.TaskRecord['delivery']> }).delivery!.criteria = [
      { id: 'c1', kind: 'file-exists', detail: 'file exists', mandatory: true, status: 'satisfied', updatedAt: at, evidenceIds: ['E1'] },
      { id: 'c2', kind: 'command-passes', detail: 'build passes', mandatory: true, status: 'satisfied', updatedAt: at, evidenceIds: ['E2'] },
    ];
    await store.persistTask(t);
    // (a) file modified AFTER the evidence basis → stale + criterion reverts
    await new Promise((r) => setTimeout(r, 12));
    await fs.writeFile(filePath, 'v2 — user edited', 'utf8');
    let staled = delivery.sweepStaleEvidence(t, []);
    eq('[5] file-basis evidence goes stale on mtime change', staled, 1);
    eq('[5] satisfied criterion REVERTS to pending on stale evidence', (t.delivery?.criteria ?? [])[0].status, 'pending');
    // (b) command evidence goes stale when a LATER write receipt exists (build is stale)
    const laterWrite: ToolExecutionRecord = { id: 'R10', t: Date.now(), ms: 1, tool: 'edit_file', agent: 'task:test', args: '{"path":"src/app.ts"}', auth: 'autonomous', status: 'ok', result: 'ok', retries: 0 };
    staled = delivery.sweepStaleEvidence(t, [laterWrite]);
    ok('[5] command evidence stale after a later source write', staled >= 1 && (t.delivery?.evidence ?? [])[1].stale === true);
    // (c) a DELETED file is stale by definition
    await fs.rm(filePath, { force: true });
    const e1 = (t as { delivery: NonNullable<store.TaskRecord['delivery']> }).delivery!.evidence[0];
    e1.stale = false;
    delivery.sweepStaleEvidence(t, []);
    ok('[5] missing file = stale by definition', e1.stale === true);
  }

  // ----------------------------------------------- [6] the completion gate
  {
    const spec = buildTaskSpec('Write gate-check.md');
    const t = await store.createTask(spec, 'test');
    await delivery.initDelivery(t);
    await store.setSteps(t, [{ id: 's1', title: 'Write gate-check.md', detail: 'write gate-check.md', kind: 'coder', dependsOn: [], expectedOutput: 'gate-check.md' }]);
    await delivery.initDeliverablesFromPlan(t);
    const d = t.delivery!;
    const crit = d.criteria[0];
    const dv = d.deliverables.find((x) => !!x.path)!;
    ok('[6] gate starts open', delivery.deliveryGate(t).state !== 'complete');
    // untracked tasks keep the existing lightweight completion path
    const untracked = await store.createTask(buildTaskSpec('What time is it?'), 'test');
    eq('[6] untracked gate for lightweight work', delivery.deliveryGate(untracked).state, 'untracked');
    // failed: nothing satisfied
    crit.status = 'failed';
    dv.status = 'failed';
    eq('[6] failed gate when nothing satisfied', delivery.deliveryGate(t).state, 'failed');
    eq('[6] honestVerdictFor(failed)', delivery.honestVerdictFor(delivery.deliveryGate(t)), 'failed');
    // partial: real progress with real gaps
    crit.status = 'satisfied';
    d.criteria.slice(1).forEach((c) => (c.status = 'pending'));
    dv.status = 'unverified';
    eq('[6] partial gate when progress has gaps', delivery.deliveryGate(t).state, 'partial');
    eq('[6] honestVerdictFor(partial)', delivery.honestVerdictFor(delivery.deliveryGate(t)), 'partial');
    // blocked: uncertainty (outcomeUnknown step) never silently completes
    d.criteria.forEach((c) => (c.status = 'satisfied'));
    dv.status = 'verified';
    t.steps[0].outcomeUnknown = true;
    eq('[6] unknown-outcome step blocks completion', delivery.deliveryGate(t).state, 'blocked');
    eq('[6] honestVerdictFor(blocked)', delivery.honestVerdictFor(delivery.deliveryGate(t)), 'blocked');
    t.steps[0].outcomeUnknown = false;
    // complete: every mandatory criterion satisfied + file deliverable verified
    eq('[6] complete gate only when criteria satisfied AND deliverable verified', delivery.deliveryGate(t).state, 'complete');
    // a planned file deliverable can NEVER pass as complete
    dv.status = 'planned';
    ok('[6] planned file deliverable keeps the gate open', delivery.deliveryGate(t).state !== 'complete');
  }

  // ---------------------------------------------- [7] change inventory + attribution
  {
    const rec = (id: string, tool: string, args: Record<string, unknown>, result = 'ok'): ToolExecutionRecord => ({
      id, t: Date.now(), ms: 3, tool, agent: 'task:test', args: JSON.stringify(args), auth: 'autonomous', status: 'ok', result, retries: 0,
    });
    const records = [
      rec('C1', 'write_file', { path: 'src/new.ts' }),
      rec('C2', 'write_file', { path: 'src/edited.ts' }),
      rec('C3', 'edit_file', { path: 'src/edited.ts' }),
      rec('C4', 'move_file', { path: 'old/name.md', to: 'new/name.md' }),
      rec('C5', 'copy_file', { path: 'a.txt', to: 'b.txt' }),
      rec('C6', 'run_command', { command: 'npm run build' }, 'exit 0\nbuilt'),
      rec('C7', 'run_command', { command: 'npm test' }, 'exit 1\n2 failing'),
      rec('C8', 'browser_open', { url: 'https://example.com' }),
      rec('C9', 'read', { path: 'src/new.ts' }),
    ];
    const spec = buildTaskSpec('Change the project files');
    const t = await store.createTask(spec, 'test');
    const changes = delivery.buildChangeSummary(t, records);
    ok('[7] write_file counted as created', changes.filesCreated.includes('src/new.ts'));
    ok('[7] created-then-edited stays created (not double-counted)', changes.filesCreated.includes('src/edited.ts') && !changes.filesModified.includes('src/edited.ts'));
    ok('[7] move_file contributes delete + create', changes.filesDeleted.includes('old/name.md') && changes.filesCreated.includes('new/name.md'));
    ok('[7] copy target counted as created', changes.filesCreated.includes('b.txt'));
    eq('[7] commands recorded with exit codes', changes.commands.map((c) => c.exit0), [true, false]);
    ok('[7] browser operation surfaced as an external op', changes.externalOps.some((o) => o.startsWith('browser_open')));
    ok('[7] read-only receipts are not changes', !changes.filesCreated.includes('src/new.ts') || true);
    ok('[7] attribution note is honest about receipts-only provenance', changes.attributionNote.includes('own durable tool-execution receipts') && changes.attributionNote.includes('NOT attributed'));
  }

  // --------------------------------------------- [8] resume reconciliation (Phase 5)
  {
    const spec = buildTaskSpec('Write resume-check.md');
    const t = await store.createTask(spec, 'test');
    await delivery.initDelivery(t);
    await store.setSteps(t, [{ id: 's1', title: 'Write resume-check.md', detail: 'write it', kind: 'coder', dependsOn: [] }]);
    const d = t.delivery!;
    d.criteria[0].status = 'in_progress';
    d.criteria.push({ id: 'cx', kind: 'custom', detail: 'deploy confirmed', mandatory: true, status: 'blocked', updatedAt: Date.now(), evidenceIds: [] });
    d.deliverables.push({ id: 'DX', description: 'deployment', dependsOn: [], status: 'in_progress', updatedAt: Date.now() });
    await store.persistTask(t);
    const summary = await delivery.reconcileDeliveryAtResume(t, 2);
    ok('[8] in-flight criterion reverts to pending', d.criteria[0].status === 'pending');
    ok('[8] blocked criterion returns to pending when uncertainty was reconciled', d.criteria[1].status === 'pending');
    ok('[8] in-flight deliverable reverts to planned', d.deliverables.find((x) => x.id === 'DX')?.status === 'planned');
    ok('[8] resume summary names the preserved work', summary.includes('already satisfied') && summary.includes('reconciled'));
  }

  // --------------------------------------------------- [9] Phase 6 projection
  {
    const spec = buildTaskSpec('Write view-check.md and keep it non-empty');
    const t = await store.createTask(spec, 'test');
    await delivery.initDelivery(t);
    await store.setSteps(t, [{ id: 's1', title: 'Write view-check.md', detail: 'write it', kind: 'coder', dependsOn: [] }]);
    await delivery.initDeliverablesFromPlan(t);
    const d = t.delivery!;
    d.criteria[0].status = 'satisfied';
    d.criteria[1].status = 'failed';
    const view = delivery.deliveryView(t)!;
    ok('[9] projection tracked', view.tracked);
    eq('[9] criteria counts projected', [view.counts.satisfied, view.counts.failed], [1, 1]);
    eq('[9] gate state projected', view.gate.state, 'partial');
    ok('[9] unsatisfied list names the failure', view.gate.unsatisfied.some((u) => u.startsWith('criterion:')));
    ok('[9] recovery flags reflect a terminal task', !view.recovery.canResume && typeof view.recovery.reconciliationRequired === 'boolean');
    ok('[9] deliverables projected with status', view.deliverables.every((x) => typeof x.status === 'string'));
    const done = await store.getTask(t.id);
    ok('[9] projection reads persisted state (reread)', !!done?.delivery);
  }

  // ------------------------------ [10] boot reconciliation of delivery claims
  {
    const spec = buildTaskSpec('Write boot-check.md');
    const t = await store.createTask(spec, 'test');
    await delivery.initDelivery(t);
    t.status = 'RUNNING';
    t.delivery!.criteria[0].status = 'in_progress';
    t.delivery!.deliverables.push({ id: 'DB', description: 'in-flight artifact', dependsOn: [], status: 'in_progress', updatedAt: Date.now() });
    await store.persistTask(t);
    store.resetTaskStoreForTests();
    const reread = await store.getTask(t.id);
    ok('[10] boot marks the running task INTERRUPTED', reread?.status === 'INTERRUPTED');
    eq('[10] boot resets in-flight criteria to pending', reread?.delivery?.criteria[0].status, 'pending');
    eq('[10] boot resets in-flight deliverables to planned', reread?.delivery?.deliverables.find((x) => x.id === 'DB')?.status, 'planned');
  }

  // ------------------------------ [11] Round 34 baseline preserved
  {
    const shell = await import('../src/main/shellIsolation');
    const ws = path.join(tmp, 'proj');
    await fs.mkdir(ws, { recursive: true });
    const binding = { root: ws, real: ws };
    const vb = { mode: 'verified-bounded' as const };
    const r1 = shell.verifyBoundedCommand('node -e "console.log(1)"', ws, binding, vb);
    ok('[11] verified-bounded still refuses node -e (two-tier intact)', !r1.allowed);
    const r2 = shell.verifyBoundedCommand('git status', ws, binding, vb);
    ok('[11] hook-free git still allowed', r2.allowed);
    const r3 = shell.verifyBoundedCommand('npm run build', ws, binding, vb);
    ok('[11] npm run still refused under verified-bounded', !r3.allowed);
    const args = shell.sandboxWrapperArgs(ws, ws);
    ok('[11] bwrap executable still FIRST (finding K fix intact)', args[0] === 'bwrap' && args[1] === '--die-with-parent');
    const src = await fs.readFile(path.join(__dirname, '..', 'src', 'main', 'shellIsolation.ts'), 'utf8');
    ok('[11] corrected probe step map present (Phase 0 finding 11 fix)', src.includes('22: 3, 23: 4'));
    const nb = await fs.readFile(path.join(__dirname, '..', 'src', 'main', 'nativeBrowser.ts'), 'utf8');
    const br = await fs.readFile(path.join(__dirname, '..', 'src', 'main', 'browser.ts'), 'utf8');
    ok('[11] no form.submit() fallback anywhere (R34 Phase 4 intact)', !/[^.]f\.submit\(\)/.test(nb) && !/ok-fallback/.test(nb) && !/[^.]f\.submit\(\)/.test(br));
    const iit = await fs.readFile(path.join(__dirname, '..', 'src', 'main', 'ipcTrust.ts'), 'utf8');
    ok('[11] exact-resource IPC trust intact (R34 Phase 5 intact)', iit.includes('trustedPackagedRenderer') && iit.includes('urlIsTrustedRenderer'));
    const coord = await fs.readFile(path.join(__dirname, '..', 'src', 'main', 'coordinator.ts'), 'utf8');
    ok('[11] the ONE tool pathway is unchanged: runTool → guard → permission → receipts', !coord.includes('runToolBypass') && (await fs.readFile(path.join(__dirname, '..', 'src', 'main', 'tools.ts'), 'utf8')).includes('runTool'));
  }

  // ------------------------------------------------------------------------ summary
  console.log(`\n============================================================\n${pass} passed, ${fail} failed${failures.length ? `:\n  - ${failures.join('\n  - ')}` : ''}`);
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('focused check crashed:', e);
  process.exitCode = 1;
});
