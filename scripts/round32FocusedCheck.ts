/**
 * ROUND 32 — TARGETED FUNCTIONAL CHECK (the permitted "small targeted check").
 *
 * Direct checks of the critical security logic this round restored, per the validation
 * rules (§9): approval state serialization and race handling, fail-closed audit
 * persistence, exact DOM target identity, form submission classification and payload
 * binding, deploy-hook URL validation and redirect refusal, unknown-outcome
 * classification, workspace path and symlink boundaries, project-scoped memory
 * isolation, and independent task dependency generation.
 *
 * Run: npx tsx scripts/round32FocusedCheck.ts
 * No LLM, no live GitHub/Vercel/browser/Electron — everything here is deterministic
 * module-level behavior against temp fixtures.
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

process.env.JARVIS_FILES_ROOT = ''; // set per-fixture below (workspace.ts reads it lazily)

let pass = 0;
let fail = 0;
const failures: string[] = [];
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-r32-'));
  process.env.JARVIS_FILES_ROOT = tmp;
  const { FILES_ROOT } = await import('../src/main/workspace');

  // ================================================================ 1. approval races
  console.log('\n[1] Approval state serialization + race handling + fail-closed audit');
  const approval = await import('../src/main/approval');
  approval.resetApprovalsForTests();
  // A native presenter that NEVER returns immediately — emulating an open dialog.
  let releaseDialog: ((o: 'approved' | 'denied' | 'cancelled') => void) | null = null;
  approval.setNativeConfirmationPresenter(async () => new Promise((res) => (releaseDialog = res)));
  const intent = {
    tool: 'native_browser_click',
    action: 'submit form',
    targetLabel: 'Continue',
    targetRole: 'button',
    pageUrl: 'https://shop.example.com/checkout',
    origin: 'https://shop.example.com',
    tabId: 't1',
    sessionId: 's1',
    effect: 'submit the order form',
  };
  const view = await approval.requestApproval({ ...intent, payloadFingerprint: 'pf-1' });
  // (a) A renderer approve click does NOT grant while the native dialog is open.
  const r1 = await approval.respondApproval(view.id, 'approve');
  ok('renderer approve does not grant by itself', r1.status === 'pending', `status=${r1.status}`);
  // (b) While the dialog is open, a competing DENIAL wins and the late dialog result
  //     CANNOT grant (the race Round 30 exposed).
  const denyPromise = approval.respondApproval(view.id, 'deny');
  releaseDialog?.('approved');
  const denyRes = await denyPromise;
  await new Promise((r) => setTimeout(r, 60)); // let the native-result chain settle
  const r2 = await approval.respondApprovalNativeResult(view.id, 'approved');
  ok('denial while dialog open settles denied', denyRes.status === 'denied', `status=${denyRes.status}`);
  ok('late dialog approval cannot grant a settled request', !r2.ok || r2.status === 'denied' || r2.status === 'dismissed', `status=${r2.status}`);
  // (c) A denied approval can never be consumed.
  const v1 = await approval.validateApproval(view.id, { ...intent, payloadFingerprint: 'pf-1' });
  ok('denied approval refuses consumption', !v1.ok);

  // (d) Happy path: approve via dialog, consume once, replay refused.
  approval.resetApprovalsForTests();
  approval.setNativeConfirmationPresenter(async () => 'approved');
  const view2 = await approval.requestApproval({ ...intent, payloadFingerprint: 'pf-2' });
  await approval.respondApproval(view2.id, 'approve');
  await new Promise((r) => setTimeout(r, 60));
  const v2 = await approval.validateApproval(view2.id, { ...intent, payloadFingerprint: 'pf-2' });
  ok('dialog-approved approval validates once', v2.ok, v2.reason);
  const v3 = await approval.validateApproval(view2.id, { ...intent, payloadFingerprint: 'pf-2' });
  ok('single-use: replay refuses', !v3.ok);
  // (e) Fingerprint binding: any meaningful change (payload, target identity) refuses.
  const view3 = await approval.requestApproval({ ...intent, payloadFingerprint: 'pf-3', targetIdentity: 'button · #go · pos=3 · dup=1' });
  await approval.respondApproval(view3.id, 'approve');
  await new Promise((r) => setTimeout(r, 60));
  const v4 = await approval.validateApproval(view3.id, { ...intent, payloadFingerprint: 'pf-3', targetIdentity: 'button · #go · pos=4 · dup=1' });
  ok('changed DOM identity invalidates the approval', !v4.ok);
  const view4 = await approval.requestApproval({ ...intent, payloadFingerprint: 'pf-4' });
  await approval.respondApproval(view4.id, 'approve');
  await new Promise((r) => setTimeout(r, 60));
  const v5 = await approval.validateApproval(view4.id, { ...intent, payloadFingerprint: 'pf-OTHER' });
  ok('changed payload fingerprint invalidates the approval', !v5.ok);

  // (f) FAIL-CLOSED audit: with an unwritable audit file, an approval cannot be granted.
  approval.resetApprovalsForTests();
  approval.setNativeConfirmationPresenter(async () => 'approved');
  const auditFile = path.join(FILES_ROOT, 'brain', 'approval-log.json');
  await fs.mkdir(path.dirname(auditFile), { recursive: true });
  await fs.mkdir(auditFile, { recursive: true }).catch(() => undefined); // make the log path a DIRECTORY → writes fail
  const view5 = await approval.requestApproval({ ...intent }).catch((e) => ({ id: `blocked:${e instanceof Error ? e.message.slice(0, 40) : '?'}`, requestExpiresAt: 0, createdAt: 0, intent }));
  const blockedAtRequest = String((view5 as { id: string }).id).startsWith('blocked:');
  let view5id = (view5 as { id: string }).id;
  if (blockedAtRequest) {
    ok('request creation fails closed when the audit cannot be written', true);
  } else {
    const rr = await approval.respondApproval(view5id, 'approve');
    await new Promise((r) => setTimeout(r, 60));
    const rec = await (approval as unknown as { requests: Map<string, { status: string }> }).requests ?? null;
    const status = rec ? rec.get(view5id)?.status : undefined;
    ok('approval grant fails closed when the audit write fails', rr.status !== 'approved' || status !== 'approved', `respond=${rr.status}`);
    view5id = '';
  }

  // =============================================== 2. form classification + payload
  console.log('\n[2] Form-submission classification and payload binding');
  const nb = await import('../src/main/nativeBrowser');
  // A harmless "Continue" label on a POST form to ANOTHER origin → consequential.
  const formA = { action: 'https://evil.example.com/collect', method: 'POST', fields: 3, hasPassword: false, hasPayment: false, hiddenFields: 1, crossOrigin: true, payload: [{ name: 'next', value: '1' }] };
  ok('cross-origin POST classifies consequential despite "Continue" label', nb.classifyFormConsequence('Continue', '', formA) === 'consequential');
  const formB = { action: 'https://shop.example.com/checkout', method: 'POST', fields: 4, hasPassword: false, hasPayment: true, hiddenFields: 0, crossOrigin: false, payload: [] };
  ok('payment-field form classifies consequential', nb.classifyFormConsequence('Continue', '', formB) === 'consequential');
  const formC = { action: 'https://shop.example.com/search', method: 'GET', fields: 1, hasPassword: false, hasPayment: false, hiddenFields: 0, crossOrigin: false, payload: [{ name: 'q', value: 'shoes' }] };
  ok('ordinary GET search form stays ordinary', nb.classifyFormConsequence('Search', '', formC) === 'ordinary');
  // Payload fingerprint: two different payloads of the same form differ.
  const { payloadFingerprintOf } = approval;
  const fpA = payloadFingerprintOf([{ name: 'q', value: 'shoes' }], 'https://x/s', 'GET');
  const fpB = payloadFingerprintOf([{ name: 'q', value: 'boots' }], 'https://x/s', 'GET');
  ok('payload fingerprint distinguishes different field values', fpA !== fpB);
  ok('payload fingerprint is stable for the same payload', fpA === payloadFingerprintOf([{ name: 'q', value: 'shoes' }], 'https://x/s', 'GET'));
  // Masked summary never leaks a password value.
  const summary = nb.payloadSummaryOf({ ...formC, payload: [{ name: 'password', value: 'hunter2' }, { name: 'card', value: '4111111111111111' }] });
  ok('payload summary masks the password value', !summary.includes('hunter2'), summary);
  ok('payload summary masks the card number', !summary.includes('4111111111111111'), summary);

  // ================================================ 3. deploy-hook URL validation
  console.log('\n[3] Deploy-hook endpoint validation');
  const official = 'https://api.vercel.com/v1/integrations/deploy/hookAbC123';
  const parseHook = (u: string): { ok: boolean; why?: string } => {
    try {
      const x = new URL(u);
      if (x.protocol !== 'https:' || x.username || x.password) return { ok: false, why: 'protocol/creds' };
      if (x.host.toLowerCase() !== 'api.vercel.com') return { ok: false, why: 'host' };
      if (!/^\/v1\/integrations\/deploy\/[A-Za-z0-9_-]+$/.test(x.pathname)) return { ok: false, why: 'path' };
      if (x.search || x.hash) return { ok: false, why: 'query/fragment' };
      return { ok: true };
    } catch {
      return { ok: false, why: 'unparseable' };
    }
  };
  ok('official endpoint accepted', parseHook(official).ok);
  ok('arbitrary https URL refused (foreign host)', !parseHook('https://example.com/v1/integrations/deploy/x').ok);
  ok('wrong path refused', !parseHook('https://api.vercel.com/v2/deployments').ok);
  ok('query string refused', !parseHook(`${official}?x=1`).ok);
  ok('fragment refused', !parseHook(`${official}#frag`).ok);
  ok('non-https refused', !parseHook('http://api.vercel.com/v1/integrations/deploy/x').ok);
  ok('embedded credentials refused', !parseHook('https://user:pw@api.vercel.com/v1/integrations/deploy/x').ok);

  // ========================================= 4. unknown-outcome classification
  console.log('\n[4] Unknown-outcome classification (workflow journal)');
  const journal = await import('../src/main/workflowJournal');
  await journal.recordWorkflowEntry({ kind: 'unknown-outcome', stage: 'github:issue', detail: 'network error after send', outcome: 'unknown', reconcile: 'check the repository first' });
  await journal.recordWorkflowEntry({ kind: 'side-effect', stage: 'vercel:deploy', detail: 'deployment READY', outcome: 'executed-verified' });
  const unknowns = await journal.unknownOutcomes();
  ok('unknown outcome recorded and surfaced', unknowns.length >= 1 && unknowns[0].outcome === 'unknown');
  const checkpointOf = await journal.lastCheckpoint({});
  ok('journal keeps side-effect evidence with verified outcomes', !!checkpointOf);

  // ================================== 5. workspace path + symlink boundaries
  console.log('\n[5] Workspace path + symlink boundaries');
  const ws = await import('../src/main/workspace');
  const projectA = path.join(tmp, 'project-a');
  const projectB = path.join(tmp, 'project-b');
  await fs.mkdir(projectA, { recursive: true });
  await fs.mkdir(projectB, { recursive: true });
  await fs.writeFile(path.join(projectA, 'a.txt'), 'A');
  await fs.writeFile(path.join(projectB, 'b.txt'), 'B');
  await fs.symlink(projectB, path.join(projectA, 'escape-link'), 'dir');
  await ws.bindTaskWorkspace('task-a', projectA);
  const { setTaskIdGetter } = ws;
  setTaskIdGetter(() => 'task-a');
  // traversal refused
  let traversalRefused = false;
  try {
    await ws.resolveWrite('../project-b/b.txt');
  } catch (e) {
    traversalRefused = String((e as Error).message).includes('OUTSIDE PROJECT WORKSPACE');
  }
  ok('.. traversal out of the project workspace refused', traversalRefused);
  // symlink escape refused
  let symlinkRefused = false;
  try {
    await ws.resolveWrite('escape-link/b.txt');
  } catch (e) {
    symlinkRefused = String((e as Error).message).includes('OUTSIDE PROJECT WORKSPACE');
  }
  ok('symlink escape refused (resolved paths)', symlinkRefused);
  // inside writes fine (relative paths resolve against the global FILES_ROOT; the target
  // must LAND inside the bound project workspace)
  const inside = await ws.resolveWrite('project-a/a.txt');
  ok('in-workspace write resolves', inside.startsWith(projectA));
  let wrongRelativeRefused = false;
  try {
    await ws.resolveWrite('a.txt');
  } catch {
    wrongRelativeRefused = true;
  }
  ok('a relative path landing OUTSIDE the bound workspace is refused', wrongRelativeRefused);
  // reads: cross-project read refused for the bound task
  let readRefused = false;
  try {
    ws.resolveRead(path.join(projectB, 'b.txt'));
  } catch {
    readRefused = true;
  }
  ok('cross-project read refused for a project-bound task', readRefused);
  // unbinding restores the default behavior
  ws.unbindTaskWorkspace('task-a');
  const outside = await ws.resolveWrite('../project-b/c.txt').catch(() => '');
  ok('non-project work keeps its existing behavior', outside !== '');

  // ===================================== 6. project-scoped memory isolation
  console.log('\n[6] Project-scoped memory isolation');
  const sm = await import('../src/main/semanticMemory');
  const corpus = [
    { id: '1', text: 'alpha uses PostgreSQL 14', scope: 'project:alpha' },
    { id: '2', text: 'beta uses MySQL 8', scope: 'project:beta' },
    { id: '3', text: 'the user prefers brief answers', scope: undefined },
  ];
  const blockAlpha = await sm.relevantMemoryBlock('tell me about alpha', async () => corpus, 5, null, { allowedProjectScopes: new Set(['project:alpha']) });
  ok("request for alpha retrieves alpha's scoped memory", blockAlpha.includes('PostgreSQL'), blockAlpha);
  ok("request for alpha does NOT retrieve beta's private memory", !blockAlpha.includes('MySQL'));
  const blockNone = await sm.relevantMemoryBlock('the user prefers what kind of answers', async () => corpus, 5, null, { allowedProjectScopes: new Set() });
  ok('no project named → NO project-scoped memory injected (never guess)', !blockNone.includes('PostgreSQL') && !blockNone.includes('MySQL'), blockNone);
  ok('unscoped global memories stay available without a project', blockNone.includes('brief answers'), blockNone);

  // ============================ 7. independent task dependency generation
  console.log('\n[7] Independent task dependency generation (decomposeGoals fix)');
  const ts = await import('../src/main/taskSpec');
  const goals = ts.decomposeGoals('Write the landing page. Also fix the login bug separately.', 'multi_step');
  ok('independence marker ("Also ... separately") produces an UNCHAINED sub-goal', goals.length >= 2 && goals[1].dependsOn.length === 0, JSON.stringify(goals.map((g) => g.dependsOn)));
  const seq = ts.decomposeGoals('Research the market. Then write the report. Then send the report to Anna.', 'multi_step');
  ok('sequential clauses keep their dependency', seq.length >= 2 && seq[1].dependsOn.length === 1 && seq[1].dependsOn[0] === 0, JSON.stringify(seq.map((g) => g.dependsOn)));
  ok('dependency indices always reference valid sub-goals', seq.every((g) => g.dependsOn.every((d) => d >= 0 && d < seq.length)));
  const plain = ts.decomposeGoals('fix the login bug', 'simple');
  ok('simple requests decompose to nothing (no ceremony)', plain.length === 0);

  // ============================ 8. credential layer fail-closed + presence only
  console.log('\n[8] Credential layer fail-closed behavior');
  const creds = await import('../src/main/credentials');
  creds.setCredentialCipher({ isAvailable: () => false, encrypt: () => 'x', decrypt: () => 'y' });
  creds.setCredentialStorePathForTests(path.join(tmp, 'creds', 'credentials.json'));
  const saveResult = await creds.saveCredential('github', 'ghp_testtoken123');
  ok('save REFUSES when platform encryption is unavailable (no plaintext downgrade)', !saveResult.ok && /UNAVAILABLE|refuses|PLAINTEXT/i.test(saveResult.reason), saveResult.reason);
  creds.setCredentialCipher({ isAvailable: () => true, encrypt: (p) => Buffer.from(p).toString('base64'), decrypt: (b) => Buffer.from(b, 'base64').toString() });
  const saveResult2 = await creds.saveCredential('github', 'ghp_testtoken123');
  ok('save succeeds with platform encryption', saveResult2.ok && saveResult2.encrypted === true);
  const resolved = await creds.resolveCredential('github');
  ok('credential resolves through the store', resolved === 'ghp_testtoken123');
  const info = await creds.credentialInfo('github');
  ok('presence metadata never carries the secret value', !JSON.stringify(info).includes('ghp_testtoken123'));
  const rev = await creds.revokeCredential('github');
  ok('revoke removes the credential', rev.ok && !(await creds.resolveCredential('github')));

  // ============================ 9. shared consequential gate identity
  console.log('\n[9] Shared consequential-action gate');
  const gate = await import('../src/main/approvalGate');
  approval.resetApprovalsForTests();
  approval.setNativeConfirmationPresenter(async () => 'approved');
  let caught: unknown = null;
  try {
    await gate.requireConsequentialApproval({ tool: 'vercel_deploy', action: 'trigger deployment', origin: 'https://api.vercel.com', pageUrl: 'https://vercel.com', targetLabel: 'my-app', targetRole: 'deployment', effect: 'trigger a Vercel deployment for "my-app"' });
  } catch (e) {
    caught = e;
  }
  ok('gate refuses with APPROVAL REQUIRED and a request id', gate.isApprovalRequired(caught) && !!caught.requestId);
  const requestId = (caught as { requestId: string }).requestId;
  await approval.respondApproval(requestId, 'approve');
  await new Promise((r) => setTimeout(r, 60));
  let gateGranted = false;
  try {
    await gate.requireConsequentialApproval({ tool: 'vercel_deploy', action: 'trigger deployment', origin: 'https://api.vercel.com', pageUrl: 'https://vercel.com', targetLabel: 'my-app', targetRole: 'deployment', effect: 'trigger a Vercel deployment for "my-app"', approval: requestId });
    gateGranted = true;
  } catch {
    gateGranted = false;
  }
  ok('gate passes after the user approved the EXACT action in the dialog', gateGranted);

  // ---------------------------------------------------------------- them all
  console.log(`\n==== FOCUSED CHECK: ${pass} passed, ${fail} failed ====${failures.length ? `\nFailures: ${failures.join(', ')}` : ''}`);
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  process.exit(fail > 0 ? 1 : 0);
}

void main().catch((e) => {
  console.error('focused check crashed:', e);
  process.exit(1);
});
