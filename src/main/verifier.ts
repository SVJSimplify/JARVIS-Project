import { promises as fs } from 'fs';
import * as path from 'path';
import type { AcceptanceCriterion } from './taskSpec';
import { recordsForTask, type ToolExecutionRecord } from './toolRecord';
import type { VerificationResult } from './taskStore';

/**
 * VERIFIER (Module H) — acceptance criteria checked against reality, not against claims.
 *
 * The model's statement that a task is complete is not evidence of completion. This module
 * evaluates each acceptance criterion of a task against two independent sources:
 *   1. The task's durable tool-execution records (the evidence ledger on disk), and
 *   2. The machine itself: files stat'd and reopened, formats structurally validated,
 *      commands executed.
 *
 * Rules enforced here:
 *  - Missing evidence stays missing: a criterion with nothing to check it FAILS — it is
 *    never silently waived, and a check that cannot run never reports a fake pass.
 *  - The result is tied criterion-by-criterion to concrete evidence lines, so a reviewer
 *    (human or model) can demand the proof behind every PASS.
 *  - An optional independent verifier sub-agent runs AFTER these mechanical checks and can
 *    only lower the verdict (its FAIL fails the criterion), never inflate it.
 */

export interface CriterionCheck {
  criterion: string;
  pass: boolean;
  evidence: string;
  /** Round 20 (CHANGE 5): HOW this check observed reality (the verification method). */
  method?: string;
  /** Round 20 (CHANGE 5): what was actually OBSERVED, as distinct from the tool's claim. */
  observed?: string;
}

const WRITE_FAMILY = /^(write_file|edit_file|multi_edit|apply_patch|copy_file|make_dir|move_file)$/;
const WEB_FAMILY = /^(tinyfish_search|tinyfish_fetch|web_search|fetch_url|search_and_read|code_search)$/;

/** Extract a file path from a tool record's argument preview (JSON args or text preview). */
const pathOf = (args: string): string | null => {
  const s = String(args ?? '');
  try {
    const a = JSON.parse(s) as Record<string, unknown>;
    const p = a.path ?? a.to;
    if (typeof p === 'string') return p;
  } catch {
    /* not JSON: fall through to the preview shape */
  }
  const m = /(?:^|[\s"'{}])(?:path|to)[:=]\s*"?([^"\s]+[\w./\\-])/.exec(s);
  return m ? m[1] : null;
};

/** Distinct URLs that actually flowed through web tools (evidence, not citations). */
export const urlsInEvidence = (records: ToolExecutionRecord[]): string[] => {
  const urls = new Set<string>();
  for (const r of records) {
    if (r.status !== 'ok' || !WEB_FAMILY.test(r.tool)) continue;
    for (const m of `${r.args} ${r.result ?? ''}`.matchAll(/https?:\/\/[^\s)\]}"'<>]+/g)) urls.add(m[0]);
  }
  return [...urls];
};

// ------------------------------------------------------------------ mechanical checks

async function checkFileExists(target: string | undefined, records: ToolExecutionRecord[]): Promise<CriterionCheck> {
  // The concrete path comes from the task's own write evidence — the last successful write.
  const write = [...records].reverse().find((r) => r.status === 'ok' && WRITE_FAMILY.test(r.tool));
  const p = target ?? (write ? pathOf(write.args) : null);
  if (!p) return { criterion: 'file-exists', pass: false, evidence: 'no successful write step recorded for this task — nothing to check', method: 'durable ledger + disk stat', observed: 'no write target to observe' };
  const full = path.isAbsolute(p) || /^[a-z]:[\\/]/i.test(p) ? p : path.resolve(process.env.JARVIS_FILES_ROOT ?? '.', p);
  try {
    const st = await fs.stat(full);
    return { criterion: 'file-exists', pass: st.isFile(), evidence: `${full} exists (${st.size} bytes)`, method: 'disk stat', observed: `${st.size}-byte file present on disk` };
  } catch (e) {
    return { criterion: 'file-exists', pass: false, evidence: `${full} does not exist (${e instanceof Error ? e.message : e})`, method: 'disk stat', observed: 'nothing at that path' };
  }
}

async function checkFileNonEmpty(target: string | undefined, records: ToolExecutionRecord[]): Promise<CriterionCheck> {
  const write = [...records].reverse().find((r) => r.status === 'ok' && WRITE_FAMILY.test(r.tool));
  const p = target ?? (write ? pathOf(write.args) : null);
  if (!p) return { criterion: 'file-nonempty', pass: false, evidence: 'no written file to size-check', method: 'durable ledger + disk stat', observed: 'no write target to observe' };
  const full = path.isAbsolute(p) || /^[a-z]:[\\/]/i.test(p) ? p : path.resolve(process.env.JARVIS_FILES_ROOT ?? '.', p);
  try {
    const st = await fs.stat(full);
    return { criterion: 'file-nonempty', pass: st.size > 0, evidence: `${full} holds ${st.size} bytes`, method: 'disk stat', observed: `${st.size} bytes on disk` };
  } catch {
    return { criterion: 'file-nonempty', pass: false, evidence: `${full} could not be stat'd`, method: 'disk stat', observed: 'nothing at that path' };
  }
}

/** Structural format validation WITHOUT inventing success: known signatures only. */
export async function fileFormatOk(full: string): Promise<{ ok: boolean; evidence: string }> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(full).then((b) => b.subarray(0, 512));
    const st = await fs.stat(full);
    if (st.size === 0) return { ok: false, evidence: `${full} is empty` };
  } catch (e) {
    return { ok: false, evidence: `cannot read ${full}: ${e instanceof Error ? e.message : e}` };
  }
  const ext = path.extname(full).toLowerCase();
  // OOXML containers (docx/pptx/xlsx) are ZIP archives starting with the PK signature.
  if (['.docx', '.pptx', '.xlsx'].includes(ext)) {
    const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
    return isZip
      ? { ok: true, evidence: `${full} carries the OOXML (ZIP) container signature` }
      : { ok: false, evidence: `${full} does not have the required OOXML (ZIP) container signature` };
  }
  if (ext === '.pdf') {
    const ok = buf.subarray(0, 5).toString('latin1') === '%PDF-';
    return { ok, evidence: ok ? `${full} starts with the %PDF- header` : `${full} lacks the %PDF- header` };
  }
  // Text formats: must decode as UTF-8 without NUL soup (a binary masquerading as text fails).
  if (['.json', '.md', '.txt', '.csv', '.html'].includes(ext)) {
    try {
      const raw = await fs.readFile(full);
      const text = raw.toString('utf8');
      const replacementRatio = (text.match(/\uFFFD/g) ?? []).length / Math.max(1, text.length);
      if (replacementRatio > 0.01) return { ok: false, evidence: `${full} is not valid UTF-8 text (${ext})` };
      if (ext === '.json') {
        JSON.parse(text);
        return { ok: true, evidence: `${full} parses as JSON` };
      }
      return { ok: true, evidence: `${full} decodes as clean ${ext} text (${raw.length} bytes)` };
    } catch (e) {
      return { ok: false, evidence: `${full} failed ${ext} validation: ${e instanceof Error ? e.message : e}` };
    }
  }
  // Unknown format: the honest answer is "cannot validate this format", which is a FAIL
  // for the criterion — never a silent pass.
  return { ok: false, evidence: `no structural validator for ${ext || '(no extension)'} — format unproven` };
}

async function checkFileFormat(target: string | undefined, records: ToolExecutionRecord[]): Promise<CriterionCheck> {
  const write = [...records].reverse().find((r) => r.status === 'ok' && WRITE_FAMILY.test(r.tool));
  const p = target ?? (write ? pathOf(write.args) : null);
  if (!p) return { criterion: 'file-format', pass: false, evidence: 'no written file to format-check' };
  const full = path.isAbsolute(p) || /^[a-z]:[\\/]/i.test(p) ? p : path.resolve(process.env.JARVIS_FILES_ROOT ?? '.', p);
  const r = await fileFormatOk(full);
  return { criterion: 'file-format', pass: r.ok, evidence: r.evidence, method: 'structural format validation', observed: r.evidence };
}

async function checkCommand(
  target: string | undefined,
  run: ((command: string) => Promise<string>) | undefined
): Promise<CriterionCheck> {
  if (!run || !target) {
    // No command exists to run: honest skip — the criterion fails ONLY if it was required
    // with a concrete command. The coordinator passes project verify scripts when known.
    return { criterion: 'command-passes', pass: false, evidence: target ? 'no command runner available — unverified' : 'no command specified for this criterion', method: 'command execution', observed: 'nothing executed' };
  }
  const out = await run(target);
  const ok = /^exit 0/.test(out);
  return { criterion: 'command-passes', pass: ok, evidence: `${target} → ${out.slice(0, 200).replace(/\s+/g, ' ')}`, method: 'command execution', observed: out.slice(0, 120).replace(/\s+/g, ' ') };
}

function checkSources(records: ToolExecutionRecord[], min: number): CriterionCheck {
  const urls = urlsInEvidence(records);
  const ok = urls.length >= Math.max(1, min);
  return {
    criterion: `sources-present (≥${min})`,
    pass: ok,
    evidence: ok ? `${urls.length} distinct URLs fetched by web tools: ${urls.slice(0, 3).join(', ')}${urls.length > 3 ? '…' : ''}` : `only ${urls.length} source URL(s) in the evidence — claims stay unverified`,
    method: 'durable ledger (successful web-tool records)',
    observed: `${urls.length} distinct URL(s) actually fetched`,
  };
}

function checkEvidence(records: ToolExecutionRecord[]): CriterionCheck {
  const ok = records.some((r) => r.status === 'ok');
  const okTools = records.filter((r) => r.status === 'ok').map((r) => r.tool);
  return {
    criterion: 'evidence-present',
    pass: ok,
    evidence: ok ? `successful tool runs recorded: ${[...new Set(okTools)].slice(0, 5).join(', ')}` : 'no successful tool execution recorded for this task',
    method: 'durable ledger scan',
    observed: ok ? 'successful executions in the ledger' : 'no successful executions in the ledger',
  };
}

// ------------------------------------------------------------------------ the verifier

/**
 * STEP EVIDENCE EVALUATION (Round 26 Phase 3, §3.6 — acceptance-driven completion).
 *
 * THE RULE: an agent's assertion that work is complete is NOT evidence that the work is
 * complete. A successful final response, an agent-written "verified"/"completed" claim,
 * the absence of thrown errors, a successful step execution, an empty error list, or a
 * completed task state WITHOUT evidence can never independently produce VERIFIED.
 *
 * Evidence is task-appropriate and comes ONLY from the existing model — the durable
 * tool-execution ledger and the disk:
 *   - file deliverables: claimed paths re-inspected on disk (existence, file-ness);
 *   - test/build tasks: a recorded, successful (exit 0) test/build/typecheck command;
 *   - research tasks: distinct source URLs actually fetched through web tools;
 *   - unresolved execution receipts keep the outcome honestly UNKNOWN.
 * If the evidence model cannot support a verification method, the honest answer is
 * UNVERIFIED — evidence is never invented here.
 */
export interface StepEvidenceFacts {
  /** The step's final report (the agent's CLAIM — never evidence by itself). */
  report: string;
  /** The report starts with a failure marker (coordinator's stepReportFailed). */
  failed: boolean;
  /** Executions of this step whose outcome is still unknown (unresolved receipts). */
  unresolved: Array<{ id: string }>;
  /** The step's own durable tool-execution records. */
  ledger: ToolExecutionRecord[];
  /** File deliverables claimed in the report (claimed, not verified). */
  claimedPaths: string[];
  /** How many of those were re-inspected on disk and exist as files. */
  verifiedPaths: number;
  /** Claimed paths that are missing (the difference). */
  missingPaths: string[];
}

export interface StepEvidenceEvaluation {
  status: 'verified' | 'partial' | 'unverified' | 'failed' | 'unknown' | 'unresolved';
  method: string;
  observed: string;
  evidence: string;
}

const CHECK_COMMAND = /^(run_command|verify_command)$/;
const CHECK_COMMAND_INTENT = /\b(test|tests|build|typecheck|tsc|lint|vitest|jest|pytest|mocha|cargo|gradle|make|compile)\b/i;

export function evaluateStepEvidence(f: StepEvidenceFacts): StepEvidenceEvaluation {
  if (f.failed) {
    return f.unresolved.length
      ? {
          status: 'unresolved',
          method: 'durable tool ledger + outcome reconciliation',
          observed: 'the step reports failure AND has unresolved execution receipt(s) — the outcome is not settled',
          evidence: `unresolved receipt(s): ${f.unresolved.map((r) => r.id).slice(0, 4).join(', ')}; report: ${f.report.slice(0, 220)}`,
        }
      : {
          status: 'failed',
          method: 'final report inspection + deliverable re-check where claimed',
          observed: 'the step reports failure; the verification attempt FAILED',
          evidence: f.report.slice(0, 400),
        };
  }
  if (f.unresolved.length) {
    return {
      status: 'unknown',
      method: 'durable tool ledger reconciliation',
      observed: `${f.unresolved.length} execution(s) still have UNKNOWN outcomes after the run — verification cannot establish the actual state`,
      evidence: `unresolved receipt(s): ${f.unresolved.map((r) => r.id).slice(0, 4).join(', ')}`,
    };
  }
  const okCmd = f.ledger.find(
    (r) => r.status === 'ok' && CHECK_COMMAND.test(r.tool) && /exit 0/.test(String(r.result ?? '')) && CHECK_COMMAND_INTENT.test(r.args)
  );
  const urls = urlsInEvidence(f.ledger);
  const allClaims = f.claimedPaths.length;
  const okClaims = f.verifiedPaths;
  const badClaims = f.missingPaths.length;
  const parts: string[] = [];
  if (allClaims > 0)
    parts.push(
      `${okClaims}/${allClaims} claimed deliverable(s) re-inspected on disk${badClaims ? `; NOT FOUND: ${f.missingPaths.slice(0, 4).join(', ')}` : ''}`
    );
  if (okCmd) parts.push(`successful check command recorded: ${okCmd.args.slice(0, 120).replace(/\s+/g, ' ')}`);
  if (urls.length >= 2) parts.push(`${urls.length} distinct source URL(s) actually fetched: ${urls.slice(0, 2).join(', ')}`);
  const evidence = parts.join('; ') || 'no independent evidence recorded — the step’s claims are the only support';
  if (allClaims > 0 && badClaims === 0 && okClaims > 0) {
    return {
      status: 'verified',
      method: 'claimed-deliverable re-inspection on disk + durable tool ledger',
      observed: `every claimed deliverable (${allClaims}) exists on disk as a file`,
      evidence,
    };
  }
  if (badClaims > 0 && (okClaims > 0 || !!okCmd || urls.length >= 2)) {
    return {
      status: 'partial',
      method: 'claimed-deliverable re-inspection on disk + durable tool ledger',
      observed: 'some requirements have evidence, others do not — the unconfirmed parts stay unverified',
      evidence,
    };
  }
  if (badClaims > 0) {
    return {
      status: 'unverified',
      method: 'claimed-deliverable re-inspection on disk',
      observed: `every claimed deliverable is missing from disk (${f.missingPaths.slice(0, 4).join(', ')})`,
      evidence,
    };
  }
  if (okCmd) {
    return {
      status: 'verified',
      method: 'recorded command execution (exit 0)',
      observed: 'a relevant check command (test/build/typecheck) actually ran and succeeded',
      evidence,
    };
  }
  if (urls.length >= 2) {
    return {
      status: 'verified',
      method: 'durable ledger (successful web-tool records)',
      observed: `${urls.length} distinct sources were actually fetched through web tools`,
      evidence,
    };
  }
  return {
    status: 'unverified',
    method: 'durable ledger scan + claimed-path disk inspection',
    observed: 'nothing independently observed — no deliverables claimed, no check command ran, no sources fetched',
    evidence,
  };
}

export interface VerifyOptions {
  /** Run a shell command (for command-passes criteria); the coordinator supplies verifyExec.runCmd. */
  runCommand?: (command: string) => Promise<string>;
  /** Optional independent reviewer verdict ("PASS"/"FAIL …") that can only LOWER the result. */
  reviewerVerdict?: string;
  /** Path overrides, e.g. when the model stated the deliverable path explicitly. */
  targets?: Record<string, string>;
}

/** Verify every acceptance criterion of a task. Never throws; every criterion gets a line. */
export async function verifyAcceptance(
  criteria: AcceptanceCriterion[],
  taskId: string,
  sinceTs: number,
  opts: VerifyOptions = {}
): Promise<VerificationResult> {
  const records = await recordsForTask(taskId, sinceTs);
  const results: CriterionCheck[] = [];
  for (const c of criteria) {
    const target = opts.targets?.[c.id] ?? c.target;
    switch (c.kind) {
      case 'file-exists':
        results.push(await checkFileExists(target, records));
        break;
      case 'file-nonempty':
        results.push(await checkFileNonEmpty(target, records));
        break;
      case 'file-format':
        results.push(await checkFileFormat(target, records));
        break;
      case 'command-passes':
        results.push(await checkCommand(target ?? opts.targets?.[c.id], opts.runCommand));
        break;
      case 'sources-present':
        results.push(checkSources(records, c.min ?? 2));
        break;
      case 'evidence-present':
        results.push(checkEvidence(records));
        break;
      case 'custom': {
        // Free-form: passes only when its text appears in the task's evidence or results.
        const needle = (target ?? c.detail).toLowerCase().slice(0, 80);
        const hay = records.map((r) => `${r.args} ${r.result ?? ''}`).join(' ').toLowerCase();
        const ok = needle.length > 3 && hay.includes(needle);
        results.push({ criterion: c.detail, pass: ok, evidence: ok ? `text found in the task's tool evidence` : `the phrase "${needle}" appears nowhere in the tool evidence`, method: 'ledger text search', observed: ok ? 'phrase present in recorded evidence' : 'phrase absent from recorded evidence' });
        break;
      }
      default:
        results.push({ criterion: c.detail, pass: false, evidence: 'unknown criterion kind — never auto-passed', method: 'none', observed: 'nothing observed' });
    }
  }
  // The independent reviewer can only LOWER: a "FAIL" verdict fails the whole check.
  const reviewer = String(opts.reviewerVerdict ?? '').trim();
  if (/^VERDICT:\s*FAIL/i.test(reviewer) || (!/^VERDICT:\s*PASS/i.test(reviewer) && reviewer && !results.length)) {
    results.push({ criterion: 'independent reviewer', pass: false, evidence: reviewer.slice(0, 300), method: 'independent review', observed: 'reviewer reported concrete flaws' });
  }
  const passed = results.length > 0 && results.every((r) => r.pass);
  return { checkedAt: Date.now(), passed, results };
}

/**
 * Round 20 (CHANGE 4): apply an independent reviewer's verdict to ALREADY-COMPUTED
 * mechanical results — without re-running a single check. The old flow called
 * verifyAcceptance a second time with the verdict folded in, re-stat'ing files and
 * RE-EXECUTING verification commands (npm test/build twice: cost, flakiness, and a
 * non-deterministic second outcome). The reviewer can only LOWER the verdict.
 */
export function applyReviewerVerdict(v: VerificationResult, reviewerVerdict: string): VerificationResult {
  const reviewer = String(reviewerVerdict ?? '').trim().replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!reviewer) return v;
  if (/^VERDICT:\s*FAIL/i.test(reviewer)) {
    const results = [...v.results, { criterion: 'independent reviewer', pass: false, evidence: reviewer.slice(0, 300) }];
    return { checkedAt: Date.now(), passed: false, results };
  }
  if (!v.results.length) {
    // Nothing mechanical ran: the reviewer IS the check (it can still fail it).
    const pass = /^VERDICT:\s*PASS/i.test(reviewer);
    return { checkedAt: Date.now(), passed: pass, results: [{ criterion: 'independent reviewer', pass, evidence: reviewer.slice(0, 300) }] };
  }
  return v; // a PASS reviewer never inflates the mechanical result
}
