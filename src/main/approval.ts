import { createHash, createHmac, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { atomicWrite, withStoreLock } from './store';
import { FILES_ROOT } from './workspace';

/**
 * USER-ORIGINATED ACTION APPROVAL (Round 29 Phase 1 §1.1; ROUND 32 Phase 1 hardening).
 *
 * A model-generated argument must NEVER count as user approval. Round 28's `confirm: true`
 * flag was an in-args token — the model could type it, so it proved nothing about the
 * user's intent. This module implements the real thing:
 *
 *   1. A pending approval REQUEST is created by the MAIN PROCESS when a consequential
 *      action is about to be refused for lack of approval. The request is bound by
 *      FINGERPRINT to the exact browser session, tab, page origin, target element (the
 *      EXACT DOM identity), intended action, consequential effect and — for form
 *      submissions — the actual PAYLOAD fingerprint.
 *   2. The request is pushed to the JARVIS UI. The renderer card is INFORMATIONAL: it
 *      shows the user what JARVIS intends to do, and its Approve button only ASKS the
 *      main process to open the NATIVE system confirmation dialog. The renderer can
 *      never grant an approval by itself.
 *   3. ONLY the main-process native confirmation result can move a request to `approved`.
 *      Denial, dismissal, timeout, window closure and dialog cancellation never approve.
 *      The renderer can only respond to requests the main process created; it cannot
 *      mint approvals.
 *   4. The main process INDEPENDENTLY VALIDATES the approval inside the tool, right
 *      before the action: approved, not expired (short-lived), not already used
 *      (single-use), and the fingerprint of the action about to run must equal the
 *      fingerprint the user approved — ANY meaningful change of session, tab,
 *      destination, target identity, payload or intended effect invalidates it.
 *   5. Every decision and consumption is written to a durable audit receipt
 *      (`brain/approval-log.json`, bounded). THE AUDIT IS FAIL-CLOSED (Round 32 §1.2):
 *      an approval transition that cannot be durably recorded leaves the request
 *      UNAPPROVED, and a consumed receipt that cannot be recorded REFUSES the action —
 *      an unrecordable grant is a grant that never happened.
 *
 * STATE-RACE FIX (Round 32 §1.2): every state transition of one request runs under a
 * PER-REQUEST serialization chain. The native dialog's result is applied by re-reading
 * the authoritative state under that chain: a request denied, cancelled, expired or
 * settled while the dialog was open can never be granted by a late dialog result, and
 * two concurrent confirmations of the same request cannot produce competing grants.
 *
 * The model's only role is to surface the request id it received from the refusal and
 * re-issue the SAME action with `approval: "<request-id>"`. It cannot create, approve,
 * extend, replay or forge an approval: every state transition lives in this module and
 * is reachable only through the validated UI/native-dialog response paths or the
 * validated consumption path.
 */

// ----------------------------------------------------------------------------- shape

/** What JARVIS intends to do — the exact scope the approval is bound to. */
export interface ApprovalIntent {
  /** The registered tool that will execute the action (e.g. native_browser_click). */
  tool: string;
  /** The action verb ("click", "submit form", "create issue"). */
  action: string;
  /** Visible label / accessible name of the target element (or resource title). */
  targetLabel: string;
  /** Element role or tag (button, a, input…), or the resource kind (repository, project). */
  targetRole: string;
  /** Link target when the element carries one (href) — absolute where resolvable. */
  targetHref?: string;
  /** Page URL at request time (query string stripped — tokens never enter receipts). */
  pageUrl: string;
  /** Page origin (scheme+host) — the destination scope. */
  origin: string;
  /** Browser tab the action targets ('' for non-browser actions). */
  tabId: string;
  /** Native browser session the tab belongs to ('' for non-browser actions). */
  sessionId: string;
  /** Human-readable statement of the consequential effect ("submit the order form"). */
  effect: string;
  /**
   * ROUND 32 (§1.4) — the EXACT DOM target identity, generated from the live DOM
   * (never supplied by the model): tag, id, name, type, role, accessible name, resolved
   * absolute destination, form ownership/action/method, structural position and
   * duplicate-element count. Participates in the approval fingerprint.
   */
  targetIdentity?: string;
  /**
   * ROUND 32 (§1.5) — the form the action submits, when one is involved: resolved
   * absolute action URL, HTTP method, field count, sensitive-field flags.
   * ROUND 33 (§2.2) — the binding is on the EFFECTIVE operation: the actual submitter's
   * formaction/formmethod overrides are applied (effectiveAction/effectiveMethod), and
   * hidden-field/file-input/novalidate/submitter facts participate in the fingerprint.
   */
  form?: {
    action: string;
    method: string;
    fields: number;
    hasPassword: boolean;
    hasPayment: boolean;
    crossOrigin: boolean;
    /** ROUND 33: the destination the submission will REALLY use (submitter override applied). */
    effectiveAction: string;
    /** ROUND 33: the method the submission will REALLY use. */
    effectiveMethod: string;
    /** ROUND 33: valued hidden controls carried by the submission (exfiltration signal). */
    hiddenFields: number;
    /** ROUND 33: file-upload controls present (files leave the machine). */
    hasFileInputs: boolean;
    /** ROUND 33: form/submitter novalidate (validation bypassed). */
    noValidate: boolean;
    /** ROUND 33: the bound submitter's control name ('' when implicit). */
    submitterName: string;
    /** ROUND 33: whether the submitter overrides destination/method at all. */
    submitterOverrides: boolean;
    /** ROUND 34 (§3.3): the submitter's own value (its payload contribution). */
    submitterValue?: string;
    /** ROUND 34 (§3.3): the submitter's control type (submit/image/button). */
    submitterType?: string;
    /** ROUND 34 (§3.3): submitter-level formnovalidate (validation behavior). */
    submitterFormNovalidate?: boolean;
    /** ROUND 34 (§3.3): submitter-level formtarget override. */
    submitterFormTarget?: string;
    /** ROUND 34 (§3.3): the submitter's EXACT stable DOM identity — tag, id, name, type,
     *  value, overrides, structural position and duplicate-signature count. Two submit
     *  buttons with identical labels or values are NOT the same target. */
    submitterIdentity?: string;
    /** ROUND 34 (§3.1): false when the payload could NOT be fully inspected (inspection
     *  limits exceeded) — such an approval is never created for consequential submissions. */
    inspectionComplete?: boolean;
  };
  /** ROUND 32 (§1.5) — fingerprint over the ACTUAL planned payload (field names, values, destination, operation). */
  payloadFingerprint?: string;
  /** ROUND 32 (§1.5) — a masked, human-readable summary of what will be sent where. */
  payloadSummary?: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'dismissed' | 'expired' | 'cancelled' | 'used';

export interface ApprovalRecord {
  id: string;
  createdAt: number;
  /** When the user responded (approved/denied/dismissed). */
  decidedAt?: number;
  /** When the approval was consumed by a validated action. */
  usedAt?: number;
  /** Hard deadline of the request itself (unanswered requests die here). */
  requestExpiresAt: number;
  /** Hard deadline of the APPROVAL after a user yes (short-lived). */
  approvalExpiresAt?: number;
  status: ApprovalStatus;
  intent: ApprovalIntent;
  /** sha256 binding of the intent — any meaningful change invalidates the approval. */
  fingerprint: string;
  /** The invalidation reason when a validation refused (evidence for the audit). */
  invalidReason?: string;
  /** ROUND 32 (§1.1): whether the native confirmation dialog is currently open for this request. */
  nativeConfirming?: boolean;
  /** ROUND 32 (§1.1): how the native confirmation concluded ('approved' | 'denied' | 'cancelled'). */
  nativeResult?: 'approved' | 'denied' | 'cancelled';
}

export interface ApprovalRequestView {
  id: string;
  createdAt: number;
  requestExpiresAt: number;
  intent: ApprovalIntent;
  /** True when the native confirmation dialog is open (the renderer card shows this state). */
  nativeConfirming?: boolean;
}

// ------------------------------------------------------------------------ lifecycle

/** An unanswered request dies after this long (the UI shows a countdown). */
const REQUEST_TTL_MS = 10 * 60_000;
/** Test/diagnostic hook: shorten the request TTL (the watchdog test uses this). */
let requestTtlMs = REQUEST_TTL_MS;
export const setRequestTtlForTests = (ms: number | null): void => {
  requestTtlMs = ms ?? REQUEST_TTL_MS;
};
/** An approved token is short-lived AND single-use. */
export const APPROVAL_TTL_MS = 2 * 60_000;
/** Bounded concurrent pending requests — an unbounded queue would let a loop flood the UI. */
const MAX_PENDING = 3;
const MAX_LOG = 200;

const requests = new Map<string, ApprovalRecord>();

/** Waiters for a user decision: the tool call that created the request does NOT block on
 *  it (it refuses immediately with the request id); nothing here holds execution. */
const decisionWaiters = new Map<string, Array<(r: ApprovalRecord) => void>>();

/**
 * ROUND 32 (§1.2) — PER-REQUEST TRANSITION SERIALIZATION. One promise chain per request
 * id: every state transition (respond, dismiss, expire, cancel, native-dialog result,
 * consume) enqueues on its request's chain, so two racing decisions execute strictly in
 * order and each re-reads the settled state before acting. No global lock framework —
 * just one chain per live request.
 */
const requestChains = new Map<string, Promise<unknown>>();
const withRequestLock = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
  const prev = requestChains.get(id) ?? Promise.resolve();
  const job = prev.then(fn, fn);
  // The settled slot stays for the request's lifetime (the requests map keeps settled
  // records for the audit projection anyway, so the growth profile is unchanged): a
  // live chain is what guarantees queued transitions stay serialized.
  requestChains.set(id, job.catch(() => undefined));
  return job;
};

let uiPush: ((view: ApprovalRequestView | null, event: 'requested' | 'resolved', record?: ApprovalRecord) => void) | null = null;

/**
 * Inject the UI push (index.ts wires it to the renderer). The module stays electron-free:
 * without an injected push, requests still validate — they are only not announced live.
 */
export const setApprovalUiPush = (fn: typeof uiPush): void => {
  uiPush = fn;
};

/**
 * ROUND 32 (§1.1) — the NATIVE CONFIRMATION PRESENTER, injected by index.ts (which owns
 * Electron). Given a pending request, it MUST show the main-process system confirmation
 * dialog and resolve with the dialog's real outcome. The module stays electron-free; the
 * injected implementation enforces: only the dialog result grants, never the renderer;
 * denial, dismissal, timeout and window closure resolve 'denied'/'cancelled'.
 */
export type NativeConfirmationOutcome = 'approved' | 'denied' | 'cancelled';
let nativePresenter: ((view: ApprovalRequestView, ttlMs: number) => Promise<NativeConfirmationOutcome>) | null = null;
export const setNativeConfirmationPresenter = (fn: typeof nativePresenter): void => {
  nativePresenter = fn;
};
const viewOf = (r: ApprovalRecord): ApprovalRequestView => ({
  id: r.id,
  createdAt: r.createdAt,
  requestExpiresAt: r.requestExpiresAt,
  intent: { ...r.intent },
  nativeConfirming: r.nativeConfirming === true,
});

// ------------------------------------------------------------------------ fingerprint

/**
 * The binding hash of the EXACT action scope. Built from session, tab, origin, target
 * identity (the EXACT DOM identity, Round 32 §1.4), form destination/method, payload
 * fingerprint and intended effect. A page navigation changes pageUrl — but the fingerprint
 * binds ORIGIN (not full URL): moving inside the same origin (a checkout wizard step)
 * keeps the approval valid ONLY while tab, session, target element, payload and effect
 * are identical; anything crossing origins, tabs, sessions, a different element, a
 * different payload or a different effect produces a different fingerprint and can never
 * consume the approval.
 */
export function fingerprintOf(intent: ApprovalIntent): string {
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const canonical = [
    intent.sessionId,
    intent.tabId,
    intent.origin,
    intent.tool,
    intent.action,
    norm(intent.targetLabel),
    norm(intent.targetRole),
    (intent.targetHref ?? '').trim(),
    norm(intent.effect),
    // ROUND 32 (§1.4/§1.5): the exact execution-layer bindings — an approval for one
    // element instance, one form destination or one payload never covers another.
    (intent.targetIdentity ?? '').trim(),
    intent.form
      ? [
          intent.form.action,
          intent.form.method.toUpperCase(),
          String(intent.form.fields),
          String(intent.form.hasPassword),
          String(intent.form.hasPayment),
          // ROUND 33 (§2.2): the EFFECTIVE operation is what the user approved — a
          // changed submitter, a changed override or a changed field mix invalidates it.
          intent.form.effectiveAction ?? '',
          (intent.form.effectiveMethod ?? '').toUpperCase(),
          String(intent.form.hiddenFields ?? 0),
          String(intent.form.hasFileInputs ?? false),
          String(intent.form.noValidate ?? false),
          intent.form.submitterName ?? '',
          String(intent.form.submitterOverrides ?? false),
          // ROUND 34 (§3.3): EVERY submitter fact participates — the exact identity (not
          // just the name), its value contribution, type, validation and target overrides.
          intent.form.submitterValue ?? '',
          (intent.form.submitterType ?? '').toLowerCase(),
          String(intent.form.submitterFormNovalidate ?? false),
          intent.form.submitterFormTarget ?? '',
          (intent.form.submitterIdentity ?? '').trim(),
        ].join('|')
      : '',
    (intent.payloadFingerprint ?? '').trim(),
  ].join('\u0000');
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * The process-ephemeral HMAC secret for value binding (ROUND 33 §2.3). A keyed digest is
 * required where an EXACT sensitive value must be bound (the typed password, hidden
 * values) without storing it: the digest is HMAC-SHA256 under a per-process random
 * secret, so it cannot be recomputed offline, replayed across restarts, or used as a
 * credential. It exists only in memory and dies with the process (approvals die with it).
 */
let valueDigestSecret: Buffer | null = null;
const digestSecret = (): Buffer => (valueDigestSecret ??= randomBytes(32));

/** A keyed digest of one named value — never the value itself, never reusable as a credential. */
export function keyedValueDigest(name: string, value: string): string {
  return createHmac('sha256', digestSecret()).update(`${name}\u0000${value}`).digest('hex');
}

/**
 * Keyed SHA-256 (HMAC) over the actual planned submission payload (field names, values,
 * destination, method). ROUND 33 (§2.3): the digest is KEYED with the process-ephemeral
 * secret — the hash of a payload cannot be recomputed offline from a guessed value, and
 * the digest can never serve as the credential itself.
 *
 * ROUND 34 (§3.4) — UNAMBIGUOUS CANONICALIZATION: the payload is canonicalized as a
 * JSON structure (destination, upper-cased method, submitter identity, and every field
 * as an ordered [name, value] PAIR), never as delimiter-concatenated `name=value`
 * strings. JSON escapes control characters, so the pairing is collision-free (`a=b`
 * as a value can never mimic a name), field ORDER and REPEATED names survive exactly,
 * and the exact submitter identity participates alongside destination and method.
 */
export function payloadFingerprintOf(
  fields: Array<{ name: string; value: string }>,
  destination: string,
  method: string,
  submitterIdentity = ''
): string {
  const canonical = JSON.stringify({
    d: destination,
    m: method.toUpperCase(),
    s: submitterIdentity,
    f: fields.map((f) => [f.name, f.value]),
  });
  return createHmac('sha256', digestSecret()).update(canonical).digest('hex');
}

// ------------------------------------------------------------------------ audit log

const auditFile = (): string => path.join(FILES_ROOT, 'brain', 'approval-log.json');

export interface ApprovalAuditEntry {
  at: number;
  id: string;
  event:
    | 'requested'
    | 'native-shown'
    | 'approved'
    | 'denied'
    | 'dismissed'
    | 'expired'
    | 'cancelled'
    | 'consumed'
    | 'validation-refused'
    | 'native-cancelled';
  tool: string;
  action: string;
  /** Origin + path only — never query strings, never page content, never secrets. */
  origin: string;
  pagePath: string;
  targetLabel: string;
  effect: string;
  detail?: string;
}

/** Strip query strings and fragments: a URL's query can carry tokens/session ids. */
const safeUrlParts = (url: string): { origin: string; pagePath: string } => {
  try {
    const u = new URL(url);
    return { origin: u.origin, pagePath: u.pathname.slice(0, 180) || '/' };
  } catch {
    return { origin: '(unparsed)', pagePath: '/' };
  }
};

const sanitizeEntry = (e: ApprovalAuditEntry): ApprovalAuditEntry => {
  const cleanText = (s: string): string =>
    s
      .replace(/[?&][^\s'"]+/g, '') // strip query/fragment debris defensively
      .replace(/\b(Bearer\s+|token[=:]|key[=:]\s?)[\w.\-+/=_]{8,}/gi, '$1[redacted]')
      .replace(/\s+/g, ' ')
      .trim();
  return { ...e, tool: cleanText(e.tool), action: cleanText(e.action), origin: cleanText(e.origin), targetLabel: cleanText(e.targetLabel).slice(0, 120), effect: cleanText(e.effect).slice(0, 220), detail: e.detail ? cleanText(e.detail).slice(0, 240) : undefined };
};

let auditFailures = 0;
let lastAuditError = '';
/** ROUND 32 (§1.2): durable-audit health for the Operations Center — never silent. */
export const auditHealth = (): { failures: number; lastError: string; quarantined?: string } => ({
  failures: auditFailures,
  lastError: lastAuditError,
  quarantined: lastQuarantinePath || undefined,
});

/**
 * ROUND 33 (§3.3): the path of the audit file quarantined after corruption (for the Ops
 * Center and the documented recovery procedure). Never silently destroyed evidence.
 */
let lastQuarantinePath = '';

/**
 * ROUND 33 (§3.3) — CORRUPT-AUDIT RECOVERY, fail-closed with evidence preservation.
 * A malformed/unreadable audit file is NEVER silently replaced with an empty history
 * (the Round 32 behavior). Instead:
 *   1. the corrupted file is preserved byte-for-byte under a quarantine name
 *      (approval-log.corrupt-<timestamp>.json) — evidence is never destroyed;
 *   2. the failing write REFUSES (fail-closed): the transition it belonged to does not
 *      happen, and the audit health surfaces the corruption loudly;
 *   3. subsequent writes start a NEW log whose first entry records the recovery event —
 *      the durable history is never silently empty, and the quarantine path is kept
 *      observable until the operator archives or removes the preserved original.
 * The explicit recovery procedure: inspect the quarantined file, merge or archive it, and
 * remove it — until then the corruption remains visible in the Operations Center.
 */
async function loadAuditLogOrQuarantine(): Promise<ApprovalAuditEntry[] | null> {
  const raw = await fs.readFile(auditFile(), 'utf8').catch((e) => {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '[]';
    throw e; // unreadable for another reason — the write fails closed below
  });
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error('the audit file is not a JSON array');
    const entries = parsed.filter((e): e is ApprovalAuditEntry => !!e && typeof e === 'object' && typeof (e as ApprovalAuditEntry).at === 'number');
    const dropped = parsed.length - entries.length;
    if (dropped > 0) {
      // Partially corrupt (some non-entry junk): quarantine the ORIGINAL and refuse this
      // write — the operator decides what happened before the audit continues.
      const q = path.join(path.dirname(auditFile()), `approval-log.corrupt-${Date.now()}.json`);
      await fs.writeFile(q, raw, 'utf8');
      lastQuarantinePath = q;
      lastAuditError = `the approval audit contained ${dropped} malformed entr(ies); the original file was preserved at ${path.basename(q)} — inspect it before continuing`;
      console.error('[approval] audit CORRUPTION detected (fail-closed):', lastAuditError);
      return null;
    }
    return entries;
  } catch (e) {
    // Wholly unparseable: quarantine the original bytes, refuse this write.
    const q = path.join(path.dirname(auditFile()), `approval-log.corrupt-${Date.now()}.json`);
    await fs.writeFile(q, raw, 'utf8').catch(() => undefined);
    lastQuarantinePath = q;
    lastAuditError = `the approval audit file is corrupt (JSON unreadable: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}); the original was preserved at ${path.basename(q)}`;
    console.error('[approval] audit CORRUPTION detected (fail-closed):', lastAuditError);
    return null;
  }
}

/**
 * ROUND 32 (§1.2) — STRICT, FAIL-CLOSED audit write. Returns false when the entry could
 * NOT be durably persisted. Callers that must not proceed without an audit trail treat
 * false as a refusal (an approval grant or a consumption never happens unrecorded).
 */
export async function writeAuditStrict(entry: ApprovalAuditEntry): Promise<boolean> {
  try {
    await withStoreLock(auditFile(), async () => {
      const existing = await loadAuditLogOrQuarantine();
      if (existing === null) {
        // Fail closed ON the transition that met the corruption: the state change it
        // belongs to does not happen (the caller refuses). The NEXT write starts the
        // fresh log with an explicit recovery marker — the history is never silently
        // empty and the corrupted original stays preserved.
        const marker: ApprovalAuditEntry = {
          at: Date.now(),
          id: 'audit-recovery',
          event: 'validation-refused',
          tool: '(audit)',
          action: 'audit-recovery',
          origin: '(local)',
          pagePath: '/',
          targetLabel: 'audit recovery',
          effect: `a corrupt audit file was quarantined (${path.basename(lastQuarantinePath)}) — inspect it; this entry begins the new log`,
        };
        await fs.mkdir(path.dirname(auditFile()), { recursive: true });
        await atomicWrite(auditFile(), JSON.stringify([marker], null, 1));
        throw new Error(lastAuditError);
      }
      const log = existing;
      log.push(sanitizeEntry(entry));
      await fs.mkdir(path.dirname(auditFile()), { recursive: true });
      await atomicWrite(auditFile(), JSON.stringify(log.slice(-MAX_LOG), null, 1));
    });
    return true;
  } catch (e) {
    auditFailures++;
    lastAuditError = e instanceof Error ? e.message : String(e);
    console.error('[approval] audit write FAILED (fail-closed):', lastAuditError);
    return false;
  }
}

// -------------------------------------------------------------------- request + response

const newId = (): string => `ap-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;

/**
 * Create a pending approval request for an EXACT consequential action and push it to the
 * UI. Bounded: when MAX_PENDING requests are already open, the oldest pending one is
 * cancelled (expired) first — a flood of requests must never stack up silently.
 * The creation audit is fail-closed too: an unrecordable request refuses.
 */
export async function requestApproval(intent: ApprovalIntent): Promise<ApprovalRequestView> {
  // retire expired pendings first so the bound is about real open requests
  const now = Date.now();
  for (const r of [...requests.values()]) {
    if (r.status === 'pending' && r.requestExpiresAt <= now) await settle(r, 'expired', 'the request expired unanswered');
  }
  const pending = [...requests.values()].filter((r) => r.status === 'pending');
  if (pending.length >= MAX_PENDING) {
    const oldest = pending.sort((a, b) => a.createdAt - b.createdAt)[0];
    await settle(oldest, 'cancelled', `superseded by a newer request for the same interface (${MAX_PENDING} open requests bound reached)`);
  }
  const record: ApprovalRecord = {
    id: newId(),
    createdAt: now,
    requestExpiresAt: now + requestTtlMs,
    status: 'pending',
    intent: { ...intent },
    fingerprint: fingerprintOf(intent),
  };
  requests.set(record.id, record);
  const { origin, pagePath } = safeUrlParts(intent.pageUrl);
  const recorded = await writeAuditStrict({ at: now, id: record.id, event: 'requested', tool: intent.tool, action: intent.action, origin, pagePath, targetLabel: intent.targetLabel, effect: intent.effect });
  if (!recorded) {
    requests.delete(record.id);
    throw new Error('the approval request could not be durably recorded (audit persistence failed) — the action is refused until the audit trail works again');
  }
  uiPush?.(viewOf(record), 'requested');
  return viewOf(record);
}

/** Resolve a record to a terminal (non-approved) state, notify waiters and the UI, and audit. */
async function settle(r: ApprovalRecord, status: 'denied' | 'dismissed' | 'expired' | 'cancelled', detail?: string): Promise<void> {
  r.status = status;
  r.decidedAt = Date.now();
  r.nativeConfirming = false;
  if (detail) r.invalidReason = detail;
  const waiters = decisionWaiters.get(r.id) ?? [];
  decisionWaiters.delete(r.id);
  for (const w of waiters) w(r);
  const { origin, pagePath } = safeUrlParts(r.intent.pageUrl);
  await writeAuditStrict({ at: r.decidedAt, id: r.id, event: status, tool: r.intent.tool, action: r.intent.action, origin, pagePath, targetLabel: r.intent.targetLabel, effect: r.intent.effect, detail });
  uiPush?.(null, 'resolved', r);
}

/**
 * THE renderer response path. ROUND 32 (§1.1): the renderer card is INFORMATIONAL — its
 * Approve click does NOT grant; it ASKS for the main-process native confirmation dialog.
 * A 'deny' click is honored directly (a refusal is always safe). The native dialog's
 * outcome is applied under the per-request lock with a FRESH state read, so a request
 * that was denied/dismissed/expired/cancelled while the dialog was open can never be
 * granted by the dialog's late result.
 */
export async function respondApproval(id: string, decision: 'approve' | 'deny'): Promise<{ ok: boolean; status: ApprovalStatus; reason: string }> {
  return withRequestLock(id, async (): Promise<{ ok: boolean; status: ApprovalStatus; reason: string }> => {
    const r = requests.get(id);
    if (!r) return { ok: false, status: 'expired', reason: `no approval request "${id}" is open (it may have expired) — ask JARVIS to request it again` };
    if (r.status !== 'pending') return { ok: false, status: r.status, reason: `the request is no longer open (${r.status})` };
    if (r.requestExpiresAt <= Date.now()) {
      await settle(r, 'expired', 'expired before the user responded');
      return { ok: false, status: 'expired', reason: 'the request expired before the response arrived' };
    }
    if (decision === 'deny') {
      await settle(r, 'denied', 'the user denied the action');
      return { ok: true, status: 'denied', reason: 'the user denied the action — JARVIS must not repeat it' };
    }
    // APPROVE = open the main-process NATIVE confirmation dialog. The renderer click never
    // grants by itself; only the dialog's own result does (and its outcome is applied
    // after a fresh state read, so races cannot grant).
    if (r.nativeConfirming) return { ok: false, status: r.status, reason: 'the native confirmation dialog for this request is already open — answer it there' };
    r.nativeConfirming = true;
    const { origin, pagePath } = safeUrlParts(r.intent.pageUrl);
    const dialogAuditRecorded = await writeAuditStrict({ at: Date.now(), id: r.id, event: 'native-shown', tool: r.intent.tool, action: r.intent.action, origin, pagePath, targetLabel: r.intent.targetLabel, effect: r.intent.effect });
    if (!dialogAuditRecorded) {
      // ROUND 33 (§3.3): a failed native-dialog audit leaves the request PENDING — a
      // recoverable, non-approved state. The dialog is NOT opened while the evidence
      // layer is broken (the grant itself is fail-closed anyway); the user can dismiss,
      // deny or let it expire, and the audit failure is surfaced by the Ops Center.
      r.nativeConfirming = false;
      return { ok: false, status: 'pending', reason: `the confirmation could not start: the native-dialog audit write FAILED (${lastAuditError.slice(0, 120)}) — the request stays pending and unapproved; dismiss it or fix the audit trail` };
    }
    uiPush?.(viewOf(r), 'requested');
    // Release the per-request lock while the (human-paced) dialog is open: other
    // transitions (dismiss, expire, cancel) must remain possible during confirmation.
    // The dialog outcome is re-applied through respondApprovalNativeResult, which takes
    // the lock itself and re-reads the authoritative state.
    const view = viewOf(r);
    const ttl = Math.max(1_000, r.requestExpiresAt - Date.now());
    // ROUND 33 (§3.3): a WATCHDOG bounds the presenter — a dialog that never resolves
    // (hung presenter, lost window) can never leave the request permanently
    // nativeConfirming: the watchdog settles 'cancelled' after ttl + grace (grace is
    // bounded by half the ttl, capped at 15 s), and a late real result still cannot
    // grant (it re-reads the settled state under the lock).
    const graceMs = Math.min(15_000, Math.max(250, Math.round(ttl / 2)));
    void Promise.race([
      Promise.resolve().then(() => (nativePresenter ? nativePresenter(view, ttl) : Promise.resolve('denied' as NativeConfirmationOutcome))),
      new Promise<NativeConfirmationOutcome>((resolve) => setTimeout(() => resolve('cancelled'), ttl + graceMs)),
    ])
      .then((outcome) => respondApprovalNativeResult(r.id, outcome))
      .catch(async (e) => {
        // A crashed or missing presenter NEVER grants: settle cancelled with the reason.
        await respondApprovalNativeResult(r.id, 'cancelled', e instanceof Error ? e.message : String(e));
      });
    return { ok: true, status: 'pending', reason: 'the system confirmation dialog is open — only its result can approve this request' };
  });
}

/**
 * ROUND 32 (§1.2) — the native dialog outcome path. Runs under the per-request lock and
 * RE-READS the authoritative state: if the request was denied, dismissed, cancelled or
 * expired while the dialog was open, the dialog result cannot grant it. Only a still-
 * pending, unexpired request transitions to approved, and only after the audit write has
 * durably succeeded (fail-closed).
 */
export async function respondApprovalNativeResult(id: string, outcome: NativeConfirmationOutcome, error?: string): Promise<{ ok: boolean; status: ApprovalStatus; reason: string }> {
  return withRequestLock(id, async (): Promise<{ ok: boolean; status: ApprovalStatus; reason: string }> => {
    const r = requests.get(id);
    // The request may have been denied/dismissed/cancelled while the dialog was open:
    // that decision STANDS — a late dialog result never resurrects it.
    if (!r) {
      return { ok: false, status: 'expired', reason: 'the request was already settled while the confirmation was open — the dialog result cannot grant it' };
    }
    if (r.status !== 'pending') {
      r.nativeConfirming = false;
      r.nativeResult = outcome;
      return { ok: false, status: r.status, reason: `the request was already ${r.status} while the confirmation was open — the dialog result cannot grant it` };
    }
    r.nativeConfirming = false;
    r.nativeResult = outcome;
    if (outcome !== 'approved') {
      const why = outcome === 'denied' ? 'the user denied the action in the system confirmation dialog' : `the confirmation was cancelled or dismissed${error ? ` (${error.slice(0, 120)})` : ''} — this is NOT approval`;
      await settle(r, outcome === 'denied' ? 'denied' : 'dismissed', why);
      return { ok: false, status: outcome === 'denied' ? 'denied' : 'dismissed', reason: why };
    }
    if (r.requestExpiresAt <= Date.now()) {
      await settle(r, 'expired', 'expired before the confirmation completed');
      return { ok: false, status: 'expired', reason: 'the request expired before the confirmation completed' };
    }
    // APPROVED — but the audit must be durable FIRST: a grant that cannot be recorded
    // never happened (Round 32 §1.2 fail-closed).
    r.decidedAt = Date.now();
    r.approvalExpiresAt = r.decidedAt + APPROVAL_TTL_MS;
    const { origin, pagePath } = safeUrlParts(r.intent.pageUrl);
    const recorded = await writeAuditStrict({ at: r.decidedAt, id: r.id, event: 'approved', tool: r.intent.tool, action: r.intent.action, origin, pagePath, targetLabel: r.intent.targetLabel, effect: r.intent.effect, detail: 'approved in the native system confirmation dialog' });
    if (!recorded) {
      r.status = 'cancelled';
      r.invalidReason = 'the approval could not be durably recorded (audit persistence failed) — it is NOT granted';
      uiPush?.(null, 'resolved', r);
      return { ok: false, status: 'cancelled', reason: r.invalidReason };
    }
    r.status = 'approved';
    const waiters = decisionWaiters.get(r.id) ?? [];
    decisionWaiters.delete(r.id);
    for (const w of waiters) w(r);
    uiPush?.(null, 'resolved', r);
    return { ok: true, status: 'approved', reason: `approved for ${Math.round(APPROVAL_TTL_MS / 1000)}s, one use, bound to this exact action` };
  });
}

/**
 * JINI device link: the user answers an approval on an AUTHENTICATED paired phone. This is a
 * second human confirmation channel, equivalent to the native dialog, so it goes through the
 * same fail-closed grant path (respondApprovalNativeResult re-reads state under the lock,
 * refuses expired/settled requests and requires a durable audit write). The phone's identity
 * is recorded in the audit trail BEFORE the grant; if that write fails, nothing is granted.
 */
export async function respondApprovalFromPairedDevice(
  id: string,
  decision: 'approve' | 'deny',
  deviceLabel: string
): Promise<{ ok: boolean; status: ApprovalStatus; reason: string }> {
  const r = requests.get(id);
  if (!r) return { ok: false, status: 'expired', reason: `no approval request "${id}" is open (it may have expired)` };
  if (r.status !== 'pending') return { ok: false, status: r.status, reason: `the request is no longer open (${r.status})` };
  const { origin, pagePath } = safeUrlParts(r.intent.pageUrl);
  const recorded = await writeAuditStrict({
    at: Date.now(),
    id: r.id,
    event: 'native-shown',
    tool: r.intent.tool,
    action: r.intent.action,
    origin,
    pagePath,
    targetLabel: r.intent.targetLabel,
    effect: r.intent.effect,
    detail: `answered (${decision}) on paired device "${deviceLabel.slice(0, 60)}"`,
  });
  if (!recorded) return { ok: false, status: 'pending', reason: 'the approval audit could not be written — nothing was granted; the request stays pending' };
  return respondApprovalNativeResult(id, decision === 'approve' ? 'approved' : 'denied');
}

/**
 * A dismissal/cancel from the UI: closing or dismissing a request NEVER approves it —
 * the request settles 'dismissed' and the model sees an explicit refusal. Serialized on
 * the same per-request chain, so it beats a dialog result racing for a grant.
 */
export async function dismissApproval(id: string): Promise<{ ok: boolean; reason: string }> {
  return withRequestLock(id, async () => {
    const r = requests.get(id);
    if (!r) return { ok: false, reason: 'no such open request' };
    if (r.status !== 'pending') return { ok: false, reason: `the request is no longer open (${r.status})` };
    await settle(r, 'dismissed', 'the user dismissed or closed the approval request (this is NOT approval)');
    return { ok: true, reason: 'the request was dismissed — not approved' };
  });
}

// ----------------------------------------------------------------------- validation

export interface ValidationResult {
  ok: boolean;
  reason: string;
  /** The record when validation succeeded (already marked used). */
  record?: ApprovalRecord;
}

/**
 * THE main-process validation gate, run INSIDE the tool immediately before the
 * consequential action. Checks, in order:
 *   exists → approved (not pending/denied/dismissed/expired) → not expired → not used →
 *   fingerprint equals the fingerprint of the action ABOUT TO RUN (target identity,
 *   form destination/method and payload fingerprint included).
 * On success the approval is consumed (single-use) BEFORE the action runs, and the
 * consumption receipt must be DURABLE before execution may proceed (Round 32 §1.2:
 * fail-closed) — a mechanically-failed action can never leave a live or an unrecorded
 * token behind. Any mismatch refuses with the specific reason — never a generic error.
 */
export async function validateApproval(id: string, intent: ApprovalIntent): Promise<ValidationResult> {
  // The consumption transition itself is serialized per request.
  return withRequestLock(id, async (): Promise<ValidationResult> => {
    const r = requests.get(id);
    if (!r) return { ok: false, reason: `approval "${id}" does not exist — approvals cannot be invented; request one first (the refused action creates the request and the UI card)` };
    if (r.status === 'pending') return { ok: false, reason: `approval "${id}" is still PENDING — the user has not approved it (waiting, dismissing or closing the card never approves anything)` };
    if (r.status === 'denied') return { ok: false, reason: `the user DENIED approval "${id}" — do not repeat this action` };
    if (r.status === 'dismissed') return { ok: false, reason: `approval "${id}" was DISMISSED by the user (dismissing is never approval)` };
    if (r.status === 'cancelled') return { ok: false, reason: `approval "${id}" was cancelled (${r.invalidReason ?? 'superseded'})` };
    if (r.status === 'used') return { ok: false, reason: `approval "${id}" was already used — approvals are single-use and cannot be replayed` };
    if (r.status === 'expired') return { ok: false, reason: `approval "${id}" expired` };
    // status === 'approved' from here on
    const now = Date.now();
    if (r.approvalExpiresAt !== undefined && now > r.approvalExpiresAt) {
      await settle(r, 'expired', `the approval expired ${Math.round((now - (r.approvalExpiresAt ?? now)) / 1000)}s after it was granted`);
      return { ok: false, reason: `approval "${id}" expired ${Math.round(APPROVAL_TTL_MS / 1000)}s after the user approved it — request it again` };
    }
    const fp = fingerprintOf(intent);
    if (fp !== r.fingerprint) {
      r.invalidReason = 'the action changed after the user approved it (different session, tab, origin, target, payload or effect)';
      const { origin, pagePath } = safeUrlParts(r.intent.pageUrl);
      await writeAuditStrict({
        at: now,
        id: r.id,
        event: 'validation-refused',
        tool: intent.tool,
        action: intent.action,
        origin,
        pagePath,
        targetLabel: intent.targetLabel,
        effect: intent.effect,
        detail: `fingerprint mismatch: approved for ${r.intent.tool}/${r.intent.action} on ${r.intent.origin}, refused for ${intent.tool}/${intent.action} on ${intent.origin}`,
      });
      return { ok: false, reason: `approval "${id}" does not cover THIS action — it was granted for a different session, tab, origin, target, payload or effect. Ask the user to approve the new exact action.` };
    }
    // Consume BEFORE the action runs: single-use, no replay window — and the consumption
    // must be durably audited BEFORE execution (fail-closed): an unrecordable consumption
    // refuses the action instead of running it unaccounted.
    r.status = 'used';
    r.usedAt = now;
    const { origin, pagePath } = safeUrlParts(intent.pageUrl);
    const recorded = await writeAuditStrict({ at: now, id: r.id, event: 'consumed', tool: intent.tool, action: intent.action, origin, pagePath, targetLabel: intent.targetLabel, effect: intent.effect });
    if (!recorded) {
      r.status = 'cancelled';
      r.invalidReason = 'the consumption could not be durably recorded (audit persistence failed) — the action was NOT executed';
      return { ok: false, reason: `the approval could not be durably consumed (${lastAuditError.slice(0, 120)}) — the action was NOT executed; retry when the audit trail works again.` };
    }
    return { ok: true, reason: `user-approved for this exact action (${Math.round((now - (r.decidedAt ?? now)) / 1000)}s earlier)`, record: r };
  });
}

// ------------------------------------------------------------------- invalidation hooks

/**
 * Invalidate every open/approved approval bound to a browser session — called when the
 * native session disconnects: an approval for a session that no longer exists must never
 * validate, even within its TTL.
 */
export async function invalidateSessionApprovals(sessionId: string, why: string): Promise<number> {
  let n = 0;
  const now = Date.now();
  for (const r of [...requests.values()]) {
    if (r.intent.sessionId !== sessionId) continue;
    if (r.status === 'pending') {
      await withRequestLock(r.id, async () => {
        const fresh = requests.get(r.id);
        if (fresh && fresh.status === 'pending') await settle(fresh, 'cancelled', `the browser session ended (${why})`);
      });
      n++;
    } else if (r.status === 'approved') {
      await withRequestLock(r.id, async () => {
        const fresh = requests.get(r.id);
        if (!fresh || fresh.status !== 'approved') return;
        fresh.status = 'cancelled';
        fresh.invalidReason = `the browser session ended (${why})`;
        const { origin, pagePath } = safeUrlParts(fresh.intent.pageUrl);
        await writeAuditStrict({ at: now, id: fresh.id, event: 'cancelled', tool: fresh.intent.tool, action: fresh.intent.action, origin, pagePath, targetLabel: fresh.intent.targetLabel, effect: fresh.intent.effect, detail: fresh.invalidReason });
        uiPush?.(null, 'resolved', fresh);
      });
      n++;
    }
  }
  return n;
}

// ------------------------------------------------------------------------ projections

/** Pending requests for the UI to restore (e.g. after a renderer reload). */
export const pendingApprovalViews = (): ApprovalRequestView[] =>
  [...requests.values()]
    .filter((r) => r.status === 'pending' && r.requestExpiresAt > Date.now())
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(viewOf);

/**
 * ROUND 32 (§6) — the security snapshot for the Operations Center, derived from REAL
 * state: currently pending requests, how the native confirmations concluded, the live
 * decision ledger with refusal reasons, and the durable-audit health.
 */
export const approvalSecuritySnapshot = (): {
  pending: ApprovalRequestView[];
  pendingInteractive: number;
  nativeOpen: number;
  recent: ApprovalAuditEntry[];
  audit: { failures: number; lastError: string };
} => {
  const live = [...requests.values()].sort((a, b) => b.createdAt - a.createdAt);
  return {
    pending: pendingApprovalViews(),
    pendingInteractive: live.filter((r) => r.status === 'pending' && r.requestExpiresAt > Date.now()).length,
    nativeOpen: live.filter((r) => r.nativeConfirming === true).length,
    recent: recentApprovalEvents(10),
    audit: auditHealth(),
  };
};

/** Recent decisions for the Operations Center (bounded, no secrets). */
export const recentApprovalEvents = (limit = 8): ApprovalAuditEntry[] =>
  requests.size === 0
    ? []
    : [...requests.values()].slice(-limit).map((r) => ({
        at: r.decidedAt ?? r.createdAt,
        id: r.id,
        event: r.status === 'pending' ? 'requested' : r.status === 'used' ? 'consumed' : (r.status as ApprovalAuditEntry['event']),
        tool: r.intent.tool,
        action: r.intent.action,
        ...safeUrlParts(r.intent.pageUrl),
        targetLabel: r.intent.targetLabel,
        effect: r.intent.effect,
        detail: r.invalidReason ?? (r.nativeResult ? `native confirmation: ${r.nativeResult}` : undefined),
      }));

/** Count of currently open pending requests (Operations Center). */
export const pendingApprovalCount = (): number => [...requests.values()].filter((r) => r.status === 'pending' && r.requestExpiresAt > Date.now()).length;

/** ROUND 34 (Phase 6): approvals actually CONSUMED by a validated action (real state).
 *  Bounded by the live request map, exactly like the pending count. */
export const approvalConsumedCount = (): number => [...requests.values()].filter((r) => r.status === 'used').length;

/** Read the durable audit log (Operations Center / report evidence). */
export async function approvalAuditLog(limit = 20): Promise<ApprovalAuditEntry[]> {
  try {
    const raw = await fs.readFile(auditFile(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return (Array.isArray(parsed) ? (parsed as ApprovalAuditEntry[]) : []).slice(-limit);
  } catch {
    return [];
  }
}

/** Test/diagnostics hook: the authoritative status of one request (undefined if unknown). */
export const approvalStatusForTests = (id: string): ApprovalStatus | undefined => requests.get(id)?.status;

/** Test hook: drop all in-memory state (restart simulation). */
export const resetApprovalsForTests = (): void => {
  requests.clear();
  decisionWaiters.clear();
  requestChains.clear();
  auditFailures = 0;
  lastAuditError = '';
  lastQuarantinePath = '';
};
