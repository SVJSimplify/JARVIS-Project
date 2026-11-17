/**
 * DELIVERABLES (Round 22, §3.5) — expected artifacts, verified against the DISK.
 *
 * A deliverable is verified by EVIDENCE, never by an agent's claim:
 *   - existence: stat on the real path (resolveRead discipline; workspace-relative
 *     paths resolve against FILES_ROOT exactly like ordinary reads);
 *   - readability: the bytes actually open;
 *   - format: verifier.fileFormatOk (the ONE Round 21 structural validator — OOXML
 *     signatures, %PDF- header, UTF-8/JSON validation; unknown extensions are an honest
 *     null, never a pass);
 *   - integrity: SHA-256 over the full content;
 *   - provenance: the producing durable task's verdict must be 'completed' (the project
 *     layer never marks a deliverable produced merely because the agent said so).
 *
 * SECURITY: this module is READ-ONLY on user data. Deliverable FILES are written by the
 * executing agents through the normal tool pipeline (write_file → guard → permission →
 * writeCoord lock → resolveWrite/revalidateWriteTarget) — the exact same authoritative
 * Round 21 path protections as every ordinary JARVIS write. There is no Autopilot
 * filesystem bypass: no direct writes here, no allowlist, no tri-state override.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { FILES_ROOT, resolveRead } from '../workspace';
import { fileFormatOk } from '../verifier';
import type { DeliverableExpectation, DeliverableVerification, ProjectRecord } from './types';

const clip = (s: string, n: number): string => String(s ?? '').slice(0, n);

/** Resolve a deliverable path for READING. Relative paths live inside FILES_ROOT, the
 *  same rule as every read in the engine. No write ever happens here. */
const deliverablePath = (p: string): string => {
  const raw = String(p ?? '').trim();
  const isAbsolute = path.isAbsolute(raw) || /^[a-z]:[\\/]/i.test(raw);
  return isAbsolute ? path.resolve(raw) : resolveRead(raw);
};

/** sha256 of a file, streamed (bounded memory for large artifacts). */
async function sha256File(full: string): Promise<string | null> {
  try {
    const hash = createHash('sha256');
    const stream = (await import('fs')).createReadStream(full);
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
    return hash.digest('hex');
  } catch {
    return null;
  }
}

/**
 * Verify ONE deliverable expectation against reality. Never throws; every outcome is an
 * honest verdict with evidence. `producingTaskCompleted` is supplied by the caller from
 * the DURABLE task record (verdict === 'completed'), never from the agent's report.
 */
export async function verifyDeliverable(
  d: DeliverableExpectation,
  producingTaskCompleted: boolean
): Promise<DeliverableVerification> {
  const full = deliverablePath(d.path);
  const base: DeliverableVerification = {
    at: Date.now(),
    exists: false,
    readable: false,
    bytes: null,
    formatOk: null,
    formatEvidence: '',
    sha256: null,
    producingTaskId: producingTaskCompleted ? d.producingTaskId : null,
    producedByVerifiedTask: producingTaskCompleted,
    verdict: 'missing',
    evidence: '',
  };
  let st;
  try {
    st = await fs.stat(full);
  } catch (e) {
    return { ...base, verdict: 'missing', evidence: `${clip(d.path, 200)} does not exist on disk (${e instanceof Error ? e.message : e})` };
  }
  base.exists = st.isFile();
  if (!st.isFile()) return { ...base, verdict: 'missing', evidence: `${clip(d.path, 200)} is not a regular file` };
  // Readability: open the bytes.
  let buf: Buffer | null = null;
  try {
    buf = await fs.readFile(full);
    base.readable = true;
    base.bytes = buf.length;
  } catch (e) {
    return { ...base, verdict: 'unreadable', evidence: `${clip(d.path, 200)} exists but could not be read: ${e instanceof Error ? e.message : e}` };
  }
  // Format: the ONE structural validator (Round 21 verifier). An extension with no
  // structural validator is an HONEST UNKNOWN (formatOk: null) that never fails the
  // deliverable and never silently passes as "validated"; a KNOWN validator that fails
  // marks the artifact invalid. The distinction reads the shared validator's evidence —
  // there is still exactly one format-validation implementation in the engine.
  const fmt = await fileFormatOk(full);
  const unknownFormat = /no structural validator/.test(fmt.evidence);
  base.formatOk = unknownFormat ? null : fmt.ok;
  base.formatEvidence = clip(fmt.evidence, 200);
  // Integrity.
  base.sha256 = await sha256File(full);
  // Verdict: every required property must actually hold.
  if (!producingTaskCompleted) {
    return {
      ...base,
      verdict: 'unverified',
      evidence: `the file exists (${st.size} bytes) but its producing task is NOT verified-complete — the artifact is not yet trusted`,
    };
  }
  if (!fmt.ok && !unknownFormat) {
    return { ...base, verdict: 'invalid-format', evidence: `format check failed: ${clip(fmt.evidence, 240)}` };
  }
  return {
    ...base,
    verdict: 'verified',
    evidence: `${clip(d.path, 160)} exists, is readable (${st.size} bytes), format check ${fmt.ok ? 'passed' : unknownFormat ? 'unknown (no structural validator for this extension)' : 'failed'}: ${clip(fmt.evidence, 120)}; sha256 ${base.sha256?.slice(0, 16) ?? 'n/a'}…; produced by verified task`,
  };
}

/**
 * Verify every deliverable of a project (or one milestone). Returns the fresh
 * verifications WITHOUT persisting — the engine decides what to record (append-only).
 */
export async function verifyProjectDeliverables(
  p: ProjectRecord,
  filter?: { milestoneId?: string; deliverableId?: string }
): Promise<DeliverableVerification[]> {
  const list = p.deliverables.filter(
    (d) => (!filter?.milestoneId || d.milestoneId === filter.milestoneId) && (!filter?.deliverableId || d.id === filter.deliverableId)
  );
  const out: DeliverableVerification[] = [];
  for (const d of list) {
    const producing = p.tasks.find((t) => t.id === d.producingTaskId);
    const completed = producing?.state === 'completed';
    out.push(await verifyDeliverable(d, completed));
  }
  return out;
}

/** Are all REQUIRED deliverables of this scope verified (latest verification each)? */
export const requiredDeliverablesVerified = (p: ProjectRecord, scope?: { milestoneId?: string }): boolean => {
  const list = p.deliverables.filter((d) => d.required && (!scope?.milestoneId || d.milestoneId === scope.milestoneId));
  if (!list.length) return true; // nothing required — the milestone's own criteria decide
  return list.every((d) => {
    const v = [...p.verifications].reverse().find((x) => x.producingTaskId === d.producingTaskId && x.verdict !== 'unverified');
    return !!v && v.verdict === 'verified';
  });
};

/** Short human summary of a deliverable's latest verification (for views/receipts). */
export const deliverableStatusLine = (p: ProjectRecord, d: DeliverableExpectation): string => {
  const v = [...p.verifications].reverse().find((x) => x.producingTaskId === d.producingTaskId);
  if (!v) return `${d.name}: never verified`;
  return `${d.name}: ${v.verdict} (${v.bytes ?? '?'} bytes${v.sha256 ? `, sha256 ${v.sha256.slice(0, 12)}…` : ''}, at ${new Date(v.at).toISOString()})`;
};

/**
 * The workspace folder where project agents are INSTRUCTED to write deliverables.
 * Pure string algebra on FILES_ROOT — no writes, no policy bypass; the actual writes
 * happen only through the agents' guarded tools.
 */
export const projectWorkspaceDir = (projectTitle: string): string =>
  path.join(FILES_ROOT, 'projects', String(projectTitle ?? 'project').toLowerCase().replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project');
