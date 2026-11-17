import type { Tool } from './toolTypes';
import { resolveCredential, noteCredentialRejected } from './credentials';
import { requireConsequentialApproval, isApprovalRequired } from './approvalGate';
import { recordWorkflowEntry } from './workflowJournal';
import { redactText } from './redact';

/**
 * VERCEL INTEGRATION (Round 29 Phase 3 §3.2; ROUND 32 Phase 2 §2.1 + Phase 3 §3.3).
 * REAL Vercel operations through the registered tool surface, on top of the EXISTING
 * integration architecture.
 *
 * AUTH (Round 32 §3.1): `VERCEL_TOKEN` resolves through the DEDICATED credential layer
 * first (the platform-encrypted store managed from the Operations Center), then the
 * environment. The token is read only at call time and never logged, echoed or stored.
 *
 * DEPLOY-HOOK VALIDATION (Round 32 §3.3): a deploy-hook URL must match the OFFICIAL
 * endpoint — `https://api.vercel.com/v1/integrations/deploy/<hook-id>` — with no query
 * string and no fragment. Arbitrary HTTPS URLs, foreign hosts and unexpected paths are
 * rejected: a deploy hook must never become an arbitrary outbound endpoint. The request
 * uses `redirect: 'manual'` and REFUSES redirects instead of following them. Hook URLs
 * are sanitized out of error messages and durable receipts.
 *
 * APPROVAL (Round 32 §2.1): a deployment trigger is a consequential external write and
 * passes through the ONE shared consequential-action gate before anything is sent.
 *
 * HONESTY CONTRACT: deployments triggered here are POLLED to a terminal state and
 * reported with the REAL URL and readyState; a deployment that ends in ERROR, CANCELED
 * or never settles inside the budget is reported as exactly that. A network failure
 * after the trigger was sent is an UNKNOWN outcome (Vercel may have accepted the trigger
 * before the response was lost) — reconciliation guidance, never a blind retry.
 *
 * This module is electron-free and owns no state.
 */

const API = 'https://api.vercel.com';
const TIMEOUT_MS = 15_000;
const DEPLOY_SETTLE_BUDGET_MS = 90_000;
const DEPLOY_POLL_MS = 3_000;

export const VERCEL_TOKEN_KEY = 'VERCEL_TOKEN';

const vercelToken = async (): Promise<string | undefined> => {
  const stored = await resolveCredential('vercel');
  if (stored) return stored;
  return process.env[VERCEL_TOKEN_KEY]?.trim() || undefined;
};

export class VercelError extends Error {
  constructor(readonly status: number, message: string, readonly authRelated: boolean, readonly transient: boolean) {
    super(message);
    this.name = 'VercelError';
  }
}

const errFor = (status: number, code: string, message: string): VercelError => {
  const detail = `${code ? `${code}: ` : ''}${message}`.replace(/\s+/g, ' ').slice(0, 200);
  if (status === 401 || status === 403) return new VercelError(status, `Vercel rejected the token (HTTP ${status} — ${status === 401 ? 'unauthorized' : 'forbidden'}): ${detail}`, true, false);
  if (status === 404) return new VercelError(status, `not found on Vercel (HTTP 404 — check the project/deployment id): ${detail}`, false, false);
  if (status === 409) return new VercelError(status, `Vercel refused the request (HTTP 409 — conflict): ${detail}`, false, false);
  return new VercelError(status, `Vercel API returned HTTP ${status}: ${detail}`, false, status >= 500);
};

const networkError = (e: unknown): VercelError => new VercelError(0, `Vercel is unreachable from this machine (${e instanceof Error ? e.message : String(e)}) — temporarily unavailable`, false, true);

interface VcEnvelope<T> {
  data: T;
  pagination?: { count?: number; next?: number | null };
}

async function vc<T>(method: string, path: string, opts: { body?: unknown; teamId?: string } = {}): Promise<VcEnvelope<T>> {
  const token = await vercelToken();
  if (!token) throw new VercelError(0, 'NOT CONFIGURED: no VERCEL_TOKEN in the environment. Create a personal access token on Vercel and set VERCEL_TOKEN; then run integration_check.', false, false);
  const url = new URL(`${API}${path}`);
  const team = opts.teamId || process.env.VERCEL_TEAM_ID?.trim() || '';
  if (team) url.searchParams.set('teamId', team);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw networkError(e);
  }
  const raw = await res.text().catch(() => '');
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const errObj = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
    throw errFor(res.status, errObj?.code ?? '', errObj?.message ?? raw.slice(0, 160) ?? `HTTP ${res.status}`);
  }
  return { data: (parsed ?? {}) as T, pagination: (parsed as { pagination?: VcEnvelope<unknown>['pagination'] } | null)?.pagination };
}

interface VcProject {
  id?: string;
  name?: string;
  framework?: string | null;
  nodeVersion?: string | null;
  latestDeployments?: Array<{ readyState?: string; state?: string; createdAt?: number; url?: string }>;
  link?: { type?: string; org?: string; repo?: string };
  createdAt?: number;
  updatedAt?: number;
}

interface VcDeployment {
  uid?: string;
  id?: string;
  name?: string;
  url?: string;
  state?: string;
  readyState?: string;
  ready?: number;
  createdAt?: number;
  meta?: Record<string, string>;
  alias?: string[];
}

const clip = (t: unknown, n = 160): string => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const depState = (d: VcDeployment): string => d.readyState ?? d.state ?? 'unknown';
const depUrl = (d: VcDeployment): string => (d.url ? `https://${d.url}` : '(no url yet)');

export const vercelTools: Record<string, Tool> = {
  vercel_status: {
    description:
      'Show the real Vercel integration state: whether a token is configured (credential store or VERCEL_TOKEN) and, when it is, that the API actually accepts it (verified live with a real user call — never assumed). Read-only.',
    parameters: { type: 'object', properties: {} },
    run: async () => {
      if (!(await vercelToken())) {
        return [
          'VERCEL INTEGRATION: NOT CONFIGURED.',
          `No credential in the store (Operations Center → Integrations) and no ${VERCEL_TOKEN_KEY} in the environment. Create a Vercel personal access token (Account Settings → Tokens) and save it in the Operations Center (platform-encrypted), or set ${VERCEL_TOKEN_KEY} (optionally VERCEL_TEAM_ID for team scopes), then run integration_check.`,
        ].join('\n');
      }
      try {
        const r = await vc<{ user?: { username?: string; email?: string } }>('GET', '/v2/user');
        const team = process.env.VERCEL_TEAM_ID?.trim();
        return `VERCEL INTEGRATION: AUTHENTICATED as "${r.data.user?.username ?? '?'}"${r.data.user?.email ? ` (${clip(r.data.user.email, 60)})` : ''}${team ? ` · team scope ${team}` : ''}. The token was accepted by the API just now.`;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/401|403|unauthorized|forbidden/i.test(msg)) await noteCredentialRejected('vercel', 'status check rejected');
        return `VERCEL INTEGRATION: a token IS configured but the API REJECTED IT: ${msg} — renew the token and run integration_check.`;
      }
    },
  },

  vercel_list_projects: {
    description: 'List the Vercel projects the token can see, with framework and latest deployment state (real API data). Requires VERCEL_TOKEN.',
    parameters: { type: 'object', properties: { limit: { type: 'number', description: 'Max projects (default 10, max 30).' } } },
    run: async (args) => {
      const limit = Math.min(30, Math.max(1, Math.floor(Number(args.limit)) || 10));
      const r = await vc<{ projects?: VcProject[] }>('GET', `/v9/projects?limit=${limit}`);
      const projects = r.data.projects ?? [];
      if (!projects.length) return 'No projects are visible for this token (the account may have none, or the token lacks access).';
      return projects
        .map((p) => {
          const latest = p.latestDeployments?.[0];
          return `${p.name} — framework ${p.framework ?? '?'} · latest deploy: ${latest ? `${depState(latest as VcDeployment)} (${clip(latest.url, 40)})` : 'never'}${p.link?.repo ? ` · git ${p.link.org ?? '?'}/${p.link.repo}` : ''}`;
        })
        .join('\n');
    },
  },

  vercel_project_details: {
    description: 'Inspect one Vercel project’s configuration: framework, node version, git link, latest deployments. Requires VERCEL_TOKEN.',
    parameters: { type: 'object', properties: { project: { type: 'string', description: 'project name (or id)' } }, required: ['project'] },
    run: async (args) => {
      const name = String(args.project ?? '').trim();
      if (!name) throw new Error('project name required.');
      const r = await vc<VcProject>('GET', `/v9/projects/${encodeURIComponent(name)}`);
      const p = r.data;
      const deps = (p.latestDeployments ?? []).slice(0, 5).map((d) => `  ${depState(d as VcDeployment)} · ${depUrl(d as VcDeployment)} · ${d.createdAt ? new Date(d.createdAt).toISOString().slice(0, 19) : '?'}`);
      return [
        `PROJECT ${p.name ?? name}`,
        `framework: ${p.framework ?? '(none set)'} · node: ${p.nodeVersion ?? '(default)'} · created ${p.createdAt ? new Date(p.createdAt).toISOString().slice(0, 10) : '?'}`,
        p.link?.repo ? `git: ${p.link.type ?? 'git'} ${p.link.org ?? '?'}/${p.link.repo}` : 'git: (not linked)',
        deps.length ? `recent deployments:\n${deps.join('\n')}` : 'no deployments recorded',
      ].join('\n');
    },
  },

  vercel_list_deployments: {
    description: 'List recent deployments of a Vercel project (state, URL, age). Requires VERCEL_TOKEN.',
    parameters: { type: 'object', properties: { project: { type: 'string' }, limit: { type: 'number' } }, required: ['project'] },
    run: async (args) => {
      const project = String(args.project ?? '').trim();
      if (!project) throw new Error('project name required.');
      const limit = Math.min(20, Math.max(1, Math.floor(Number(args.limit)) || 8));
      const r = await vc<{ deployments?: VcDeployment[] }>('GET', `/v6/deployments?project=${encodeURIComponent(project)}&limit=${limit}`);
      const deps = r.data.deployments ?? [];
      if (!deps.length) return `No deployments recorded for "${project}".`;
      return deps
        .map((d) => {
          const commit = d.meta?.githubCommitMessage ?? d.meta?.gitlabCommitMessage ?? d.meta?.bitbucketCommitMessage;
          return `${d.uid ?? d.id} [${depState(d)}] ${depUrl(d)}${d.createdAt ? ` · ${new Date(d.createdAt).toISOString().slice(0, 19)}` : ''}${commit ? ` · ${clip(commit, 60)}` : ''}`;
        })
        .join('\n');
    },
  },

  vercel_deployment_details: {
    description: 'Inspect one Vercel deployment’s real state (READY / BUILDING / ERROR / CANCELED), its URL and aliases. Requires VERCEL_TOKEN.',
    parameters: { type: 'object', properties: { deployment: { type: 'string', description: 'deployment id or URL' } }, required: ['deployment'] },
    run: async (args) => {
      const id = String(args.deployment ?? '').trim().replace(/^https?:\/\//, '');
      if (!id) throw new Error('deployment id or URL required.');
      const r = await vc<VcDeployment>('GET', `/v13/deployments/${encodeURIComponent(id)}`);
      const d = r.data;
      return `DEPLOYMENT ${d.uid ?? d.id ?? id}\nstate: ${depState(d)} · project: ${d.name ?? '?'}\nurl: ${depUrl(d)}\naliases: ${d.alias?.length ? d.alias.slice(0, 4).join(', ') : '(none)'}\ncreated: ${d.createdAt ? new Date(d.createdAt).toISOString() : '?'}`;
    },
  },

  vercel_deployment_logs: {
    description: 'Read the failure/build information of one Vercel deployment: the build output events, filtered to errors and warnings first. Requires VERCEL_TOKEN.',
    parameters: { type: 'object', properties: { deployment: { type: 'string' }, limit: { type: 'number', description: 'Max event lines (default 30, max 80).' } }, required: ['deployment'] },
    run: async (args) => {
      const id = String(args.deployment ?? '').trim().replace(/^https?:\/\//, '');
      if (!id) throw new Error('deployment id or URL required.');
      const limit = Math.min(80, Math.max(5, Math.floor(Number(args.limit)) || 30));
      const r = await vc<{ events?: Array<{ type?: string; created?: number; payload?: { text?: string } }> }>('GET', `/v2/deployments/${encodeURIComponent(id)}/events?limit=${limit}`);
      const events = r.data.events ?? [];
      if (!events.length) return 'No build events recorded (the deployment may still be queued).';
      const lines = events.map((e) => `${e.created ? new Date(e.created).toISOString().slice(11, 19) : ''} [${e.type ?? '?'}] ${clip(e.payload?.text, 160)}`);
      const problems = lines.filter((l) => /error|warn|fail/i.test(l));
      return (problems.length ? `PROBLEM LINES:\n${problems.slice(0, 12).join('\n')}\n\n` : '') + `FULL OUTPUT (last ${lines.length} events):\n${lines.join('\n')}`;
    },
  },

  vercel_deploy: {
    description:
      'Trigger a REAL Vercel deployment for a project through the project\u2019s OFFICIAL Deploy Hook (https://api.vercel.com/v1/integrations/deploy/<hook-id> — arbitrary URLs are refused). CONSEQUENTIAL: the user must approve the trigger in the system confirmation dialog (first call returns APPROVAL REQUIRED with a request id; repeat with approval=<id>). The deployment is POLLED to a terminal state and the REAL URL and state are reported. Requires a Vercel credential for verification.',
    parameters: {
      type: 'object',
      properties: {
        hook_url: { type: 'string', description: 'The project’s Vercel Deploy Hook URL — the OFFICIAL endpoint shape https://api.vercel.com/v1/integrations/deploy/<hook-id>. Falls back to VERCEL_DEPLOY_HOOK_URL in the environment.' },
        project: { type: 'string', description: 'Project name, so the triggered deployment can be identified and verified.' },
        approval: { type: 'string', description: 'The request id from a previous APPROVAL REQUIRED refusal, AFTER the user confirmed it in the system dialog. Never invent this id.' },
      },
    },
    run: async (args) => {
      const hook = String(args.hook_url ?? '').trim() || process.env.VERCEL_DEPLOY_HOOK_URL?.trim() || '';
      if (!hook) {
        return 'NOT CONFIGURED: no deploy hook. In Vercel, open the project → Settings → Git → Deploy Hooks, create one, and pass it as hook_url (or set VERCEL_DEPLOY_HOOK_URL in the environment). JARVIS never fakes a deployment.';
      }
      // ROUND 32 (§3.3): OFFICIAL ENDPOINT VALIDATION. The hook must be exactly
      // https://api.vercel.com/v1/integrations/deploy/<hook-id> — no foreign host, no
      // unexpected path, no query string, no fragment. A deploy hook can never become
      // an arbitrary outbound endpoint.
      let u: URL;
      try {
        u = new URL(hook);
      } catch {
        return 'REFUSED: hook_url is not a valid URL.';
      }
      if (u.protocol !== 'https:' || u.username || u.password) return 'REFUSED: the deploy hook must be a plain https URL with no embedded credentials.';
      if (u.host.toLowerCase() !== 'api.vercel.com') return `REFUSED: the deploy hook host must be api.vercel.com (got "${u.host}") — arbitrary URLs are not accepted.`;
      if (!/^\/v1\/integrations\/deploy\/[A-Za-z0-9_-]+$/.test(u.pathname)) return 'REFUSED: the deploy hook path must be the official /v1/integrations/deploy/<hook-id> endpoint.';
      if (u.search || u.hash) return 'REFUSED: the deploy hook must carry no query string and no fragment.';
      // ROUND 32 (§2.1): the ONE shared consequential-action gate — the user approves
      // this EXACT trigger before anything is sent.
      const hookDisplay = `api.vercel.com/v1/integrations/deploy/${u.pathname.split('/').pop()?.slice(0, 4)}…`;
      try {
        await requireConsequentialApproval({
          tool: 'vercel_deploy',
          action: 'trigger deployment',
          origin: 'https://api.vercel.com',
          pageUrl: 'https://vercel.com',
          targetLabel: String(args.project ?? hookDisplay),
          targetRole: 'deployment',
          targetHref: hookDisplay,
          effect: `trigger a Vercel deployment${args.project ? ` for project "${clip(args.project, 60)}"` : ''} through the official deploy hook`,
          approval: typeof args.approval === 'string' ? args.approval : undefined,
        });
      } catch (e) {
        if (isApprovalRequired(e)) return e.message;
        throw e;
      }
      let res: Response;
      try {
        // redirect: 'manual' — a deploy hook must never be silently redirected elsewhere.
        res = await fetch(u, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (e) {
        // ROUND 32 (§2.3): a network failure AFTER the trigger was sent is an UNKNOWN
        // outcome — Vercel may have accepted the deployment before the response was lost.
        const msg = e instanceof Error ? e.message : String(e);
        await recordWorkflowEntry({
          kind: 'unknown-outcome',
          stage: 'vercel:deploy',
          detail: `the deploy-hook trigger for ${args.project ?? hookDisplay} failed with a network error — the deployment may or may not have been triggered`,
          outcome: 'unknown',
          reconcile: 'inspect the real deployment state on Vercel (vercel_list_deployments / vercel_project_details) before considering another trigger',
        });
        return `OUTCOME UNKNOWN: the deploy-hook request failed with a network error (${msg.slice(0, 140)}) — Vercel MAY have accepted the trigger before the response was lost. ` +
          `Do NOT re-trigger blindly: first check the real deployment state (vercel_list_deployments${args.project ? ` for "${clip(args.project, 60)}"` : ''}) and only trigger again when no new deployment appeared.`;
      }
      // Refuse redirects explicitly (fetch with redirect:'manual' returns an opaque
      // redirected response): a redirect means the endpoint moved — that is refused,
      // never followed.
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        await recordWorkflowEntry({ kind: 'side-effect', stage: 'vercel:deploy', detail: 'the deploy hook answered with a redirect — refused (the official endpoint never redirects)', outcome: 'failed' });
        return 'REFUSED: the deploy hook answered with a REDIRECT — the official Vercel deploy endpoint never redirects, so this request is refused (a redirect could send the trigger somewhere else). Verify the hook URL in Vercel.';
      }
      const raw = await res.text().catch(() => '');
      if (!res.ok) {
        // ROUND 33 (§4.2): central redaction — the hook URL (a bearer secret) and any
        // token-shaped content never enter the model-visible error or the receipt.
        const detail = redactText(clip(raw, 160));
        throw new VercelError(res.status, `the deploy hook refused the trigger (HTTP ${res.status}): ${detail}`, res.status === 401 || res.status === 403, res.status >= 500);
      }
      let job: { id?: string; uid?: string } = {};
      try {
        job = JSON.parse(raw) as { id?: string; uid?: string };
      } catch {
        /* some hooks answer with text */
      }
      const jobId = job.id ?? job.uid ?? '';
      if (!jobId) {
        await recordWorkflowEntry({ kind: 'side-effect', stage: 'vercel:deploy', detail: `the deploy hook accepted the trigger for ${args.project ?? hookDisplay} but returned no deployment id`, outcome: 'executed-unverified' });
        return `TRIGGERED BUT NOT VERIFIED: the hook accepted the request (HTTP ${res.status}) but returned no deployment id, so the result cannot be verified. Check the Vercel dashboard; do not report it as shipped. Hook response: ${redactText(clip(raw, 200))}`;
      }
      await recordWorkflowEntry({ kind: 'side-effect', stage: 'vercel:deploy', detail: `deployment ${jobId} triggered for ${args.project ?? hookDisplay} — polling the real state`, outcome: 'requested' });
      // Poll the real deployment to a terminal state — the report is the REAL outcome.
      const deadline = Date.now() + DEPLOY_SETTLE_BUDGET_MS;
      let last: VcDeployment | null = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, DEPLOY_POLL_MS));
        try {
          const d = await vc<VcDeployment>('GET', `/v13/deployments/${encodeURIComponent(jobId)}`);
          last = d.data;
          const s = depState(last).toUpperCase();
          if (s === 'READY' || s === 'ERROR' || s === 'CANCELED') break;
        } catch {
          // transient poll failures are tolerated inside the budget; the final answer is honest either way
        }
      }
      if (!last) {
        await recordWorkflowEntry({ kind: 'side-effect', stage: 'vercel:deploy', detail: `deployment ${jobId} did not settle within the ${Math.round(DEPLOY_SETTLE_BUDGET_MS / 1000)}s budget`, outcome: 'executed-unverified' });
        return `TRIGGERED (deployment id ${jobId}) but the deployment state could NOT be verified within the ${Math.round(DEPLOY_SETTLE_BUDGET_MS / 1000)}s budget — check the Vercel dashboard; do not report it as shipped.`;
      }
      const state = depState(last).toUpperCase();
      const outcome: 'executed-verified' | 'failed' = state === 'READY' ? 'executed-verified' : 'failed';
      await recordWorkflowEntry({ kind: 'side-effect', stage: 'vercel:deploy', detail: `deployment ${last.uid ?? jobId} settled in ${state} (${depUrl(last)})`, outcome });
      const head =
        state === 'READY'
          ? `DEPLOYED AND VERIFIED: ${depUrl(last)} is READY`
          : state === 'ERROR' || state === 'CANCELED'
            ? `DEPLOYMENT FAILED: ${depUrl(last)} ended in ${state}`
            : `NOT SETTLED: still ${state} after the ${Math.round(DEPLOY_SETTLE_BUDGET_MS / 1000)}s budget`;
      return `${head}\nproject: ${last.name ?? args.project ?? '?'} · deployment ${last.uid ?? jobId}${state === 'ERROR' ? '\nInspect the build output with vercel_deployment_logs for the failure lines.' : ''}`;
    },
  },
};
