import { requestApproval, validateApproval, type ApprovalIntent } from './approval';

/**
 * THE SHARED CONSEQUENTIAL-ACTION GATE (Round 30, restored in Round 32 Phase 2 §2.1).
 *
 * ONE user-approval mechanism for every consequential external action: native-browser
 * submissions and consequential clicks, GitHub issue/PR creation, Vercel deployment
 * triggers, and any other consequential external write. It is a thin, stateless front
 * over the ONE approval authority (`approval.ts`) — not a second permission system.
 * Every tool that uses it still runs through the authorized `runTool` pathway with its
 * own guard/permission/receipt layers.
 *
 * Contract, identical for every consumer:
 *   - With NO approval id, a request is created and pushed to the UI (the card is
 *     informational; the user approves in the main-process native confirmation dialog)
 *     and this gate throws an `ApprovalRequiredError` carrying the request id — the tool
 *     refuses and the model is told to repeat the EXACT call with `approval: "<id>"`.
 *   - With an id, the main process re-validates the id against the EXACT intent (tool,
 *     action, session/tab/origin, target identity, form destination/method, payload
 *     fingerprint, effect) immediately before the action. Mismatch, expiry, prior use,
 *     denial or dismissal refuses with the specific reason.
 */

/** Thrown when a consequential action needs the user's approval first. */
export class ApprovalRequiredError extends Error {
  constructor(readonly requestId: string, message: string) {
    super(message);
    this.name = 'ApprovalRequiredError';
  }
}

export interface ConsequentialAction {
  /** The registered tool performing the action (e.g. github_create_issue). */
  tool: string;
  /** The action verb ("create issue", "submit form", "trigger deployment"). */
  action: string;
  /** Where the effect lands — service origin or page origin (never with query strings). */
  origin: string;
  /** The page URL at request time (query strings stripped for receipts). */
  pageUrl: string;
  /** Visible label / accessible name of the target (or the resource title). */
  targetLabel: string;
  /** Element role/tag or resource kind. */
  targetRole: string;
  /** Link/destination when the action carries one (absolute). */
  targetHref?: string;
  /** Browser session/tab binding when the action is a browser action. */
  sessionId?: string;
  tabId?: string;
  /** The EXACT DOM target identity (browser actions — generated from the live DOM). */
  targetIdentity?: string;
  /** Form metadata when the action submits a form. */
  form?: ApprovalIntent['form'];
  /** The actual planned payload fingerprint (submissions). */
  payloadFingerprint?: string;
  /** A masked, human-readable summary of what will be sent (submissions). */
  payloadSummary?: string;
  /** Human-readable statement of the consequential effect. */
  effect: string;
  /** The approval id from a previous APPROVAL REQUIRED refusal, when repeating the call. */
  approval?: string;
}

/**
 * The gate. Returns only when the action is genuinely user-approved for THIS exact
 * scope; otherwise throws ApprovalRequiredError (the tool converts it into its own
 * refusal shape). The intent passed here MUST be rebuilt from the live execution-layer
 * state every time — never cached from a previous call.
 */
export async function requireConsequentialApproval(a: ConsequentialAction): Promise<void> {
  const intent: ApprovalIntent = {
    tool: a.tool,
    action: a.action,
    targetLabel: a.targetLabel,
    targetRole: a.targetRole,
    targetHref: a.targetHref,
    pageUrl: a.pageUrl,
    origin: a.origin,
    tabId: a.tabId ?? '',
    sessionId: a.sessionId ?? '',
    effect: a.effect,
    ...(a.targetIdentity ? { targetIdentity: a.targetIdentity } : {}),
    ...(a.form ? { form: a.form } : {}),
    ...(a.payloadFingerprint ? { payloadFingerprint: a.payloadFingerprint } : {}),
    ...(a.payloadSummary ? { payloadSummary: a.payloadSummary } : {}),
  };
  if (!a.approval) {
    const request = await requestApproval(intent);
    throw new ApprovalRequiredError(
      request.id,
      `APPROVAL REQUIRED: JARVIS intends to ${a.effect} (destination ${a.origin}). ` +
        `A model-generated confirm=true is not user approval — an approval card for this EXACT action is now shown in the JARVIS window; ` +
        `approving there opens the SYSTEM confirmation dialog, and only that dialog's result grants the action. ` +
        `When the user confirms it, repeat this exact call with approval="${request.id}". ` +
        `The approval is short-lived and single-use; changing the target, destination, payload or effect invalidates it. ` +
        `If the card was dismissed or denied, do not re-request or work around it — report it to the user.`
    );
  }
  const verdict = await validateApproval(a.approval, intent);
  if (!verdict.ok) throw new ApprovalRequiredError(a.approval, `NOT DONE: ${verdict.reason}`);
}

/** A consumer-friendly check: is this error the "needs approval" refusal? */
export const isApprovalRequired = (e: unknown): e is ApprovalRequiredError => e instanceof ApprovalRequiredError;
