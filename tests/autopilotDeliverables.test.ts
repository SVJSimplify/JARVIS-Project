import fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUND 22 §3.5 — DELIVERABLES: honest, disk-grounded verification.
 * A deliverable is verified by EVIDENCE (existence, readability, format, SHA-256,
 * producing-task verdict), never by an agent's claim. The format validator is the ONE
 * Round 21 verifier implementation — asserted here by shared behavior, not re-implemented.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import { resetTaskStoreForTests } from '../src/main/taskStore';
import { resetAutopilotStoreForTests } from '../src/main/autopilot/store';
import { verifyDeliverable, verifyProjectDeliverables, requiredDeliverablesVerified, deliverableStatusLine, projectWorkspaceDir } from '../src/main/autopilot/deliverables';
import { fileFormatOk } from '../src/main/verifier';
import { FILES_ROOT, resolveRead } from '../src/main/workspace';
import type { DeliverableExpectation, ProjectRecord } from '../src/main/autopilot/types';

const mkDeliverable = (relPath: string, over: Partial<DeliverableExpectation> = {}): DeliverableExpectation => ({
  id: over.id ?? 'D-1',
  name: over.name ?? 'Report',
  path: relPath,
  producingTaskId: over.producingTaskId ?? 'PT-1',
  format: over.format ?? relPath.split('.').pop() ?? '',
  required: over.required ?? true,
  milestoneId: over.milestoneId ?? 'M-1',
});

const mkProject = (deliverables: DeliverableExpectation[], taskState: ProjectRecord['tasks'][number]['state'] = 'completed'): ProjectRecord => ({
  id: 'P-test',
  title: 'Deliverable test',
  status: 'active',
  understanding: {} as never,
  milestones: [],
  tasks: [{ id: 'PT-1', title: 'produce', detail: '', kind: 'general', dependsOn: [], acceptance: [], deliverableIds: deliverables.map((d) => d.id), milestoneId: 'M-1', retryMax: 1, state: taskState, attempts: [] }],
  deliverables,
  verifications: [],
  decisions: [],
  events: [],
  planVersion: 1,
  planHistory: [],
  replans: 0,
  request: 'test',
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

beforeEach(() => {
  resetTaskStoreForTests();
  resetAutopilotStoreForTests();
  fs.mkdirSync(FILES_ROOT, { recursive: true });
});

describe('honest deliverable states', () => {
  it('MISSING: a deliverable that was never produced fails honestly with the real path named', async () => {
    const rel = 'projects/deliv-missing/gone.md';
    const v = await verifyDeliverable(mkDeliverable(rel), true);
    expect(v.exists).toBe(false);
    expect(v.readable).toBe(false);
    expect(v.verdict).toBe('missing');
    expect(v.evidence).toMatch(/does not exist/);
    expect(v.sha256).toBeNull();
    expect(typeof v.at).toBe('number');
  });

  it('VERIFIED: an existing, readable, valid-format artifact from a verified task passes with sha256 + bytes', async () => {
    const rel = 'projects/deliv-ok/report.md';
    const abs = resolveRead(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const body = '# Deliverable OK\n\ncontent for hashing';
    fs.writeFileSync(abs, body);
    const v = await verifyDeliverable(mkDeliverable(rel), true);
    expect(v.exists).toBe(true);
    expect(v.readable).toBe(true);
    expect(v.bytes).toBe(Buffer.byteLength(body));
    expect(v.formatOk).toBe(true);
    expect(v.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(v.producedByVerifiedTask).toBe(true);
    expect(v.verdict).toBe('verified');
    expect(v.evidence).toMatch(/sha256/);
  });

  it('UNVERIFIED: the artifact exists but the producing task is not verified-complete — not trusted', async () => {
    const rel = 'projects/deliv-unverified/claim.md';
    const abs = resolveRead(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'an agent claims this is done');
    const v = await verifyDeliverable(mkDeliverable(rel), false);
    expect(v.exists).toBe(true);
    expect(v.producedByVerifiedTask).toBe(false);
    expect(v.producingTaskId).toBeNull();
    expect(v.verdict).toBe('unverified');
    expect(v.evidence).toMatch(/NOT verified-complete/);
  });

  it('INVALID-FORMAT: a file whose bytes do not match its claimed format fails the structural check', async () => {
    const rel = 'projects/deliv-format/fake.pdf';
    const abs = resolveRead(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'this is definitely not a PDF, no matter the extension');
    const v = await verifyDeliverable(mkDeliverable(rel, { format: 'pdf' }), true);
    expect(v.formatOk).toBe(false);
    expect(v.verdict).toBe('invalid-format');
    expect(v.evidence).toMatch(/%PDF-|format check failed/);
  });

  it('UNKNOWN format extensions are an honest null, never a pass', async () => {
    const rel = 'projects/deliv-unknown/data.xyz';
    const abs = resolveRead(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'content');
    const v = await verifyDeliverable(mkDeliverable(rel, { format: 'xyz' }), true);
    expect(v.formatOk).toBeNull();
    expect(v.formatEvidence).toMatch(/no structural validator/);
    // But the deliverable can still be verified on the other properties (existence+readable
    // and provenance) — the honest null is surfaced in the evidence.
    expect(v.verdict).toBe('verified');
    expect(v.evidence).toMatch(/format check/);
  });

  it('UNREADABLE: an unreadable artifact (dir where file expected) fails honestly', async () => {
    const rel = 'projects/deliv-dir/thing.md';
    const abs = resolveRead(rel);
    fs.mkdirSync(abs, { recursive: true }); // a directory, not a file
    const v = await verifyDeliverable(mkDeliverable(rel), true);
    expect(v.exists).toBe(false);
    expect(v.verdict).toBe('missing');
    expect(v.evidence).toMatch(/not a regular file/);
  });
});

describe('format validation is THE Round 21 verifier (one implementation)', () => {
  it('deliverable format verdicts agree with verifier.fileFormatOk on the same file', async () => {
    const abs = resolveRead('projects/deliv-agree/doc.md');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'plain markdown text');
    const v = await verifyDeliverable(mkDeliverable('projects/deliv-agree/doc.md'), true);
    const direct = await fileFormatOk(abs);
    expect(v.formatOk).toBe(direct.ok);
    expect(v.formatEvidence).toBe(direct.evidence);
  });
});

describe('project-level deliverable verification', () => {
  it('verifyProjectDeliverables verifies every expectation and records append-only history', async () => {
    const relA = 'projects/deliv-many/a.md';
    const absA = resolveRead(relA);
    fs.mkdirSync(path.dirname(absA), { recursive: true });
    fs.writeFileSync(absA, 'A content');
    const p = mkProject([mkDeliverable(relA, { producingTaskId: 'PT-1' }), mkDeliverable('projects/deliv-many/b.md', { id: 'D-2', producingTaskId: 'PT-1', name: 'Missing B' })]);
    const fresh = await verifyProjectDeliverables(p);
    expect(fresh).toHaveLength(2);
    expect(fresh.find((v) => v.producingTaskId === 'PT-1' && v.verdict === 'verified')).toBeDefined();
    expect(fresh.some((v) => v.verdict === 'missing')).toBe(true);
  });

  it('requiredDeliverablesVerified: honest aggregation over the LATEST verification of each required deliverable', async () => {
    const rel = 'projects/deliv-req/req.md';
    const abs = resolveRead(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'required content');
    const d = mkDeliverable(rel);
    const p = mkProject([d]);
    expect(requiredDeliverablesVerified(p)).toBe(false); // never verified
    p.verifications.push(await verifyDeliverable(d, false)); // produced by unverified task
    expect(requiredDeliverablesVerified(p)).toBe(false); // 'unverified' is not trust
    p.verifications.push(await verifyDeliverable(d, true)); // now with a verified task
    expect(requiredDeliverablesVerified(p)).toBe(true);
    // A project with no required deliverables is not blocked by them
    const empty = mkProject([]);
    expect(requiredDeliverablesVerified(empty)).toBe(true);
  });

  it('deliverableStatusLine reports the latest verification honestly', async () => {
    const d = mkDeliverable('projects/nowhere/x.md');
    const p = mkProject([d]);
    expect(deliverableStatusLine(p, d)).toMatch(/never verified/);
    p.verifications.push(await verifyDeliverable(d, true));
    expect(deliverableStatusLine(p, d)).toMatch(/missing/);
  });
});

describe('workspace layout (pure string algebra — no writes, no bypass)', () => {
  it('projectWorkspaceDir stays inside FILES_ROOT and is filename-safe', () => {
    const dir = projectWorkspaceDir('My Strange Project!! ("v2")');
    expect(dir.startsWith(FILES_ROOT)).toBe(true);
    expect(dir).toMatch(/my-strange-project-v2$/);
    expect(projectWorkspaceDir('')).toMatch(/project$/);
  });
});
