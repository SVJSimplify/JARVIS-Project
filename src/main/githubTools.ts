import type { Tool } from './toolTypes';
import { resolveCredential, noteCredentialRejected } from './credentials';
import { requireConsequentialApproval, isApprovalRequired } from './approvalGate';
import { recordWorkflowEntry } from './workflowJournal';

/**
 * GITHUB INTEGRATION (Round 29 Phase 3 §3.1; ROUND 32 Phase 2 §2.1 + Phase 3 §3.2).
 * REAL GitHub operations through the registered tool surface (runTool → guard →
 * permission → receipts), never a mock and never a "appears connected" front.
 *
 * AUTH (Round 32 §3.1): the token comes from the DEDICATED credential layer first (the
 * platform-encrypted credential store the user manages from the Operations Center), then
 * from the environment (`GITHUB_TOKEN` / `GH_TOKEN`). Values are resolved ONLY at call
 * time and never logged, echoed, or stored by this module. Without any token, read tools
 * that need no authentication still work against public repositories; anything about
 * "your" account, and every write, refuses with an honest NOT CONFIGURED message.
 *
 * APPROVAL (Round 32 §2.1): the consequential writes — issue creation and pull-request
 * creation — pass through the ONE shared consequential-action gate: the user approves the
 * EXACT write in the native system confirmation dialog before it can run. No external
 * side effect happens on a bare tool call.
 *
 * HONESTY CONTRACT: an operation is not "done" because the command was issued. Every
 * write VERIFIES its result by reading the created resource back from the API and
 * reporting the real number, URL and state. A network failure AFTER the request was sent
 * is reported as an UNKNOWN outcome (GitHub may have created the issue before the
 * connection dropped) — reconciliation guidance, never a blind retry. Read failures name
 * the actual HTTP outcome (401 auth rejected, 403 forbidden/rate limit, 404 not found,
 * network unreachable) so the integration state can be classified from evidence.
 *
 * This module is electron-free and owns no state.
 */

const API = 'https://api.github.com';
const TOKEN_KEY_PRIORITY = ['GITHUB_TOKEN', 'GH_TOKEN'] as const;
const TIMEOUT_MS = 15_000;
const MAX_LIST = 30;

const githubToken = async (): Promise<string | undefined> => {
  // ROUND 32 (§3.1): dedicated credential layer first (platform-encrypted store), the
  // environment second — one resolution path for every caller, credentials never logged.
  const stored = await resolveCredential('github');
  if (stored) return stored;
  for (const k of TOKEN_KEY_PRIORITY) {
    const v = process.env[k]?.trim();
    if (v) return v;
  }
  return undefined;
};

/** Where the ACTIVE token came from (presence metadata only — never the value). */
const githubTokenKeyName = async (): Promise<string | null> => {
  const stored = await resolveCredential('github');
  if (stored) return 'credential store';
  return TOKEN_KEY_PRIORITY.find((k) => !!process.env[k]?.trim()) ?? null;
};

/** Classify an HTTP failure into the honest, actionable message (and auth evidence). */
export class GitHubError extends Error {
  constructor(readonly status: number, message: string, readonly authRelated: boolean, readonly transient: boolean) {
    super(message);
    this.name = 'GitHubError';
  }
}

const errFor = (status: number, body: string): GitHubError => {
  const detail = body.replace(/\s+/g, ' ').slice(0, 200);
  if (status === 401) return new GitHubError(status, `GitHub rejected the configured token (HTTP 401 — unauthorized): ${detail}`, true, false);
  if (status === 403) {
    const rate = /rate limit/i.test(body);
    return new GitHubError(status, rate ? `GitHub rate limit reached (HTTP 403): ${detail}` : `GitHub refused the operation (HTTP 403 — forbidden; the token may lack the required scope): ${detail}`, !rate, false);
  }
  if (status === 404) return new GitHubError(status, `not found on GitHub (HTTP 404 — check the owner/repo name and your access to it): ${detail}`, false, false);
  if (status === 422) return new GitHubError(status, `GitHub rejected the request as invalid (HTTP 422): ${detail}`, false, false);
  return new GitHubError(status, `GitHub API returned HTTP ${status}: ${detail}`, false, status >= 500);
};

const networkError = (e: unknown): GitHubError => new GitHubError(0, `GitHub is unreachable from this machine (${e instanceof Error ? e.message : String(e)}) — temporarily unavailable`, false, true);

// --------------------------------------------------------------------------- core client

interface GhResponse<T> {
  status: number;
  ok: boolean;
  data: T;
  body: string;
}

async function gh<T>(method: string, path: string, body?: unknown): Promise<GhResponse<T>> {
  const token = await githubToken();
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'JARVIS-desktop-agent',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw networkError(e);
  }
  const raw = await res.text().catch(() => '');
  let data: unknown = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw errFor(res.status, raw || `HTTP ${res.status}`);
  return { status: res.status, ok: res.ok, data: (data ?? {}) as T, body: raw };
}

/** Validate and normalize `owner/repo` — never a URL, never an empty string. */
const repoId = (raw: unknown): string => {
  const r = String(raw ?? '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r)) throw new Error('Give the repository as owner/repo (e.g. "vercel/next.js").');
  return r;
};

const optEnum = (v: unknown, allowed: string[], fallback: string): string => {
  const s = String(v ?? '').trim().toLowerCase();
  return allowed.includes(s) ? s : fallback;
};

const optInt = (v: unknown, def: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : def;
};

interface GhUser { login?: string }
interface GhRepo { full_name?: string; private?: boolean; default_branch?: string; html_url?: string; description?: string; pushed_at?: string; open_issues_count?: number; language?: string }
interface GhBranch { name?: string; commit?: { sha?: string } }
interface GhCommit { sha?: string; html_url?: string; commit?: { message?: string; author?: { name?: string; date?: string } } }
interface GhIssue { number?: number; title?: string; state?: string; html_url?: string; user?: { login?: string }; created_at?: string; pull_request?: { html_url?: string }; body?: string }
interface GhPull { number?: number; title?: string; state?: string; html_url?: string; merged?: boolean; draft?: boolean; head?: { ref?: string }; base?: { ref?: string }; user?: { login?: string } }
interface GhRun { id?: number; name?: string; status?: string; conclusion?: string | null; head_branch?: string; html_url?: string; created_at?: string; event?: string }
interface GhJob { id?: number; name?: string; status?: string; conclusion?: string | null; html_url?: string; steps?: Array<{ name?: string; status?: string; conclusion?: string | null }> }

const clip = (t: unknown, n = 160): string => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// ------------------------------------------------------------------- verified mutations

/**
 * The verify-after-write contract (§3.1): a created issue/PR is read BACK from the API;
 * only a matching read earns a "created" statement. A mismatch or a failed read-back is
 * reported as what it is — created-but-unverified, or failed — never as success.
 *
 * ROUND 32 (§2.3) — UNKNOWN-OUTCOME CLASSIFICATION: a network failure during the POST
 * does NOT prove the operation failed — GitHub may have created the issue/PR before the
 * connection dropped. Such failures are recorded in the durable workflow journal as
 * outcome 'unknown' with explicit reconciliation guidance (CHECK FIRST, then only retry
 * after inspecting the external system), and the tool result says exactly that — never a
 * blind retry and never a failure claim.
 */
async function createAndVerify<T extends { number?: number; html_url?: string; state?: string }>(
  what: string,
  createPath: string,
  payload: Record<string, unknown>,
  verifyPath: (n: number) => string,
  describe: (d: T) => string
): Promise<string> {
  let created: GhResponse<{ number?: number; html_url?: string }>;
  try {
    created = await gh<{ number?: number; html_url?: string }>('POST', createPath, payload);
  } catch (e) {
    // A network error may have left the write in an UNKNOWN state — classify honestly.
    const msg = e instanceof Error ? e.message : String(e);
    if (/unreachable|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|network|socket hang up/i.test(msg)) {
      await recordWorkflowEntry({
        kind: 'unknown-outcome',
        stage: `github:${what}`,
        detail: `the ${what} request to ${createPath} failed with a network error — the operation may or may not have been created remotely`,
        outcome: 'unknown',
        reconcile: `inspect the repository (${createPath.split('/')[2] ?? ''}) — e.g. github_list_issues / github_list_pulls — before considering another attempt`,
      });
      return `OUTCOME UNKNOWN: the ${what} request failed with a network error (${msg.slice(0, 140)}) — the operation MAY have been created before the connection dropped. ` +
        `Do not blindly retry: first CHECK the repository (github_list_issues / github_list_pulls) for the ${what}; only create one when it is confirmed absent.`;
    }
    throw e;
  }
  const num = Number(created.data.number);
  if (!Number.isInteger(num) || num <= 0) {
    return `NOT VERIFIED: ${what} was submitted to GitHub but the response did not carry a ${what} number — do not treat it as created. Response: ${clip(created.body, 160)}`;
  }
  try {
    const back = await gh<T>('GET', verifyPath(num));
    await recordWorkflowEntry({
      kind: 'side-effect',
      stage: `github:${what}`,
      detail: `${what} #${num} created and verified (${back.data.html_url ?? 'n/a'})`,
      outcome: 'executed-verified',
    });
    return `CREATED AND VERIFIED: ${describe(back.data)}\n${back.data.html_url ?? ''}`.trim();
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    await recordWorkflowEntry({
      kind: 'side-effect',
      stage: `github:${what}`,
      detail: `${what} #${num} created but the verification read-back failed (${why.slice(0, 120)})`,
      outcome: 'executed-unverified',
    });
    return `SUBMITTED BUT NOT VERIFIED: ${what} #${num} was created (response URL: ${created.data.html_url ?? 'n/a'}), but the verification read-back failed (${why}). Check it before reporting it as done.`;
  }
}

// ----------------------------------------------------------------------------- tool set

export const githubTools: Record<string, Tool> = {
  github_status: {
    description:
      'Show the real GitHub integration state: whether a token is configured (credential store or GITHUB_TOKEN / GH_TOKEN), and — when it is — the authenticated account the API actually accepts (verified live, never assumed). Read-only.',
    parameters: { type: 'object', properties: {} },
    run: async () => {
      const key = await githubTokenKeyName();
      if (!key) {
        return [
          'GITHUB INTEGRATION: NOT CONFIGURED.',
          'No token in the credential store (Operations Center → Integrations) and none in the environment (looked for GITHUB_TOKEN, GH_TOKEN).',
          'Reads of PUBLIC repositories still work unauthenticated; anything about YOUR account, and every write (issues, pull requests), needs a token with the repo scope.',
          'Save a token in the Operations Center (encrypted with the platform keychain) or set GITHUB_TOKEN in the environment, then run integration_check.',
        ].join('\n');
      }
      try {
        const me = await gh<GhUser>('GET', '/user');
        return `GITHUB INTEGRATION: AUTHENTICATED as "${me.data.login ?? '?'}" (token: ${key}). The token was accepted by the API just now.`;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/401|unauthorized/i.test(msg)) await noteCredentialRejected('github', 'status check rejected (401)');
        return `GITHUB INTEGRATION: a token IS configured (${key}) but the API REJECTED IT: ${msg} — the credential is expired or invalid; renew it and run integration_check.`;
      }
    },
  },

  github_list_repos: {
    description: 'List the authenticated user’s GitHub repositories (name, visibility, language, last push). Requires a configured GitHub credential.',
    parameters: { type: 'object', properties: { limit: { type: 'number', description: 'Max repos to list (default 15, max 30).' } } },
    run: async (args) => {
      if (!(await githubToken())) return 'NOT CONFIGURED: listing your repositories needs a GitHub credential (save one in the Operations Center, or set GITHUB_TOKEN/GH_TOKEN). Reads of public repos work without one via github_repo_details.';
      const limit = optInt(args.limit, 15, MAX_LIST);
      const r = await gh<GhRepo[]>('GET', `/user/repos?per_page=${limit}&sort=pushed&affiliation=owner,collaborator`);
      if (!Array.isArray(r.data) || !r.data.length) return 'No repositories are visible for the authenticated account.';
      return r.data.map((x) => `${x.full_name}${x.private ? ' (private)' : ''} — ${x.language ?? '?'} · pushed ${x.pushed_at ? clip(x.pushed_at, 10) : '?'}${x.description ? ` · ${clip(x.description, 80)}` : ''}`).join('\n');
    },
  },

  github_repo_details: {
    description: 'Inspect one GitHub repository’s real details: default branch, visibility, language, open issues, last push, URL. Works for public repos without a token.',
    parameters: { type: 'object', properties: { repo: { type: 'string', description: 'owner/repo' } }, required: ['repo'] },
    run: async (args) => {
      const r = await gh<GhRepo>('GET', `/repos/${repoId(args.repo)}`);
      const d = r.data;
      return `${d.full_name ?? args.repo}\ndefault branch: ${d.default_branch ?? '?'} · ${d.private ? 'private' : 'public'} · language ${d.language ?? '?'} · open issues ${d.open_issues_count ?? '?'} · last push ${d.pushed_at ?? '?'}\n${d.html_url ?? ''}${d.description ? `\n${clip(d.description, 200)}` : ''}`;
    },
  },

  github_list_branches: {
    description: 'List the branches of a GitHub repository with their head commits (bounded).',
    parameters: { type: 'object', properties: { repo: { type: 'string' }, limit: { type: 'number' } }, required: ['repo'] },
    run: async (args) => {
      const r = await gh<GhBranch[]>('GET', `/repos/${repoId(args.repo)}/branches?per_page=${optInt(args.limit, 20, MAX_LIST)}`);
      if (!Array.isArray(r.data) || !r.data.length) return 'No branches returned (an empty repository has none).';
      return r.data.map((b) => `${b.name} → ${clip(b.commit?.sha, 12)}`).join('\n');
    },
  },

  github_list_commits: {
    description: 'List recent commits of a GitHub repository (sha, author, message, date), optionally on one branch.',
    parameters: { type: 'object', properties: { repo: { type: 'string' }, branch: { type: 'string' }, limit: { type: 'number' } }, required: ['repo'] },
    run: async (args) => {
      const repo = repoId(args.repo);
      const branch = String(args.branch ?? '').trim();
      const r = await gh<GhCommit[]>('GET', `/repos/${repo}/commits?per_page=${optInt(args.limit, 10, MAX_LIST)}${branch ? `&sha=${encodeURIComponent(branch)}` : ''}`);
      if (!Array.isArray(r.data) || !r.data.length) return 'No commits returned (an empty repository has none).';
      return r.data.map((c) => `${clip(c.sha, 12)} ${c.commit?.author?.date ? clip(c.commit.author.date, 10) : '?'} ${clip(c.commit?.author?.name, 20)}: ${clip(c.commit?.message, 90)}`).join('\n');
    },
  },

  github_get_commit: {
    description: 'Inspect one commit on GitHub: full message, author, files changed with additions/deletions.',
    parameters: { type: 'object', properties: { repo: { type: 'string' }, ref: { type: 'string', description: 'sha or branch name' } }, required: ['repo', 'ref'] },
    run: async (args) => {
      const r = await gh<{ sha?: string; html_url?: string; commit?: { message?: string; author?: { name?: string; date?: string } }; stats?: { additions?: number; deletions?: number }; files?: Array<{ filename?: string; status?: string; additions?: number; deletions?: number }> }>(
        'GET',
        `/repos/${repoId(args.repo)}/commits/${encodeURIComponent(String(args.ref ?? '').trim())}`
      );
      const d = r.data;
      const files = (d.files ?? []).slice(0, 12).map((f) => `  ${clip(f.status, 10)} ${f.filename} (+${f.additions ?? 0}/-${f.deletions ?? 0})`).join('\n');
      return `${clip(d.sha, 12)} by ${clip(d.commit?.author?.name, 40)} on ${clip(d.commit?.author?.date, 19)}\n${clip(d.commit?.message, 400)}\nstats: +${d.stats?.additions ?? '?'} -${d.stats?.deletions ?? '?'}\n${files}${d.html_url ? `\n${d.html_url}` : ''}`;
    },
  },

  github_list_issues: {
    description: 'List issues of a GitHub repository (number, state, title, author). PRs are excluded — use github_list_pulls for those.',
    parameters: { type: 'object', properties: { repo: { type: 'string' }, state: { type: 'string', description: 'open (default) | closed | all' }, limit: { type: 'number' } }, required: ['repo'] },
    run: async (args) => {
      const state = optEnum(args.state, ['open', 'closed', 'all'], 'open');
      const r = await gh<GhIssue[]>('GET', `/repos/${repoId(args.repo)}/issues?state=${state}&per_page=${optInt(args.limit, 15, MAX_LIST)}`);
      const issues = (Array.isArray(r.data) ? r.data : []).filter((i) => !i.pull_request);
      if (!issues.length) return `No ${state === 'all' ? '' : `${state} `}issues found.`;
      return issues.map((i) => `#${i.number} [${i.state}] ${clip(i.title, 90)} — ${clip(i.user?.login, 24)}${i.created_at ? ` · ${clip(i.created_at, 10)}` : ''}`).join('\n');
    },
  },

  github_get_issue: {
    description: 'Read one GitHub issue in full: title, state, author, body, labels, URL.',
    parameters: { type: 'object', properties: { repo: { type: 'string' }, number: { type: 'number' } }, required: ['repo', 'number'] },
    run: async (args) => {
      const num = Number(args.number);
      if (!Number.isInteger(num) || num <= 0) throw new Error('number must be the issue number.');
      const r = await gh<GhIssue & { labels?: Array<{ name?: string }> }>('GET', `/repos/${repoId(args.repo)}/issues/${num}`);
      const d = r.data;
      return `#${d.number} [${d.state}] ${d.title ?? ''}\nby ${clip(d.user?.login, 40)}${d.created_at ? ` · ${clip(d.created_at, 19)}` : ''}${d.labels?.length ? ` · labels: ${d.labels.map((l) => l.name).filter(Boolean).join(', ')}` : ''}\n\n${clip(d.body ?? '(no body)', 1200)}\n${d.html_url ?? ''}`;
    },
  },

  github_create_issue: {
    description:
      'Create a real issue in a GitHub repository (requires a credential; the user must have asked for this). CONSEQUENTIAL — it needs the user\u2019s approval in the system confirmation dialog: the first call returns APPROVAL REQUIRED with a request id; repeat the same call with approval=<id> after the user confirmed. The creation is VERIFIED by reading the new issue back from the API — the result reports the real number and URL, or an honest NOT VERIFIED / OUTCOME UNKNOWN.',
    parameters: {
      type: 'object',
      properties: { repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, approval: { type: 'string', description: 'The request id from a previous APPROVAL REQUIRED refusal, AFTER the user confirmed it in the system dialog. Never invent this id.' } },
      required: ['repo', 'title'],
    },
    run: async (args) => {
      if (!(await githubToken())) return 'NOT CONFIGURED: creating an issue needs a GitHub credential with repo scope (Operations Center → Integrations, or GITHUB_TOKEN/GH_TOKEN). Nothing was created.';
      const title = clip(args.title, 200);
      if (!title) throw new Error('The issue needs a title.');
      const repo = repoId(args.repo);
      // ROUND 32 (§2.1): the ONE shared consequential-action gate — the user approves
      // this EXACT write (repository, title) before anything is sent.
      try {
        await requireConsequentialApproval({
          tool: 'github_create_issue',
          action: 'create issue',
          origin: 'https://github.com',
          pageUrl: `https://github.com/${repo}`,
          targetLabel: title,
          targetRole: 'issue',
          targetHref: `https://github.com/${repo}`,
          effect: `create an issue titled "${title}" in ${repo}`,
          approval: typeof args.approval === 'string' ? args.approval : undefined,
        });
      } catch (e) {
        if (isApprovalRequired(e)) return e.message;
        throw e;
      }
      return createAndVerify<GhIssue>(
        'issue',
        `/repos/${repo}/issues`,
        { title, body: typeof args.body === 'string' ? args.body.slice(0, 8000) : undefined },
        (n) => `/repos/${repo}/issues/${n}`,
        (d) => `issue #${d.number} "${clip(d.title, 90)}" in ${repo} (state: ${d.state ?? '?'})`
      );
    },
  },

  github_list_pulls: {
    description: 'List pull requests of a GitHub repository (number, state, draft/merged, title, head→base).',
    parameters: { type: 'object', properties: { repo: { type: 'string' }, state: { type: 'string', description: 'open (default) | closed | all' }, limit: { type: 'number' } }, required: ['repo'] },
    run: async (args) => {
      const state = optEnum(args.state, ['open', 'closed', 'all'], 'open');
      const r = await gh<GhPull[]>('GET', `/repos/${repoId(args.repo)}/pulls?state=${state}&per_page=${optInt(args.limit, 15, MAX_LIST)}`);
      if (!Array.isArray(r.data) || !r.data.length) return `No ${state === 'all' ? '' : `${state} `}pull requests found.`;
      return r.data.map((p) => `#${p.number} [${p.merged ? 'merged' : p.draft ? 'draft' : p.state ?? '?'}] ${clip(p.title, 90)} — ${clip(p.head?.ref, 30)}→${clip(p.base?.ref, 30)} by ${clip(p.user?.login, 24)}`).join('\n');
    },
  },

  github_get_pull: {
    description: 'Read one GitHub pull request: title, state, branches, body, merge state, URL.',
    parameters: { type: 'object', properties: { repo: { type: 'string' }, number: { type: 'number' } }, required: ['repo', 'number'] },
    run: async (args) => {
      const num = Number(args.number);
      if (!Number.isInteger(num) || num <= 0) throw new Error('number must be the pull request number.');
      const r = await gh<GhPull & { body?: string; mergeable_state?: string }>('GET', `/repos/${repoId(args.repo)}/pulls/${num}`);
      const d = r.data;
      return `PR #${d.number} [${d.merged ? 'MERGED' : d.draft ? 'DRAFT' : d.state ?? '?'}] ${d.title ?? ''}\n${clip(d.head?.ref, 40)} → ${clip(d.base?.ref, 40)}${d.mergeable_state ? ` · merge state: ${d.mergeable_state}` : ''}\n\n${clip(d.body ?? '(no description)', 1000)}\n${d.html_url ?? ''}`;
    },
  },

  github_create_pull: {
    description:
      'Create a real pull request in a GitHub repository (requires a credential; the head branch must already exist and be pushed). CONSEQUENTIAL — it needs the user\u2019s approval in the system confirmation dialog: the first call returns APPROVAL REQUIRED with a request id; repeat the same call with approval=<id> after the user confirmed. The creation is VERIFIED by reading the PR back from the API — the result reports the real number, state and URL, or an honest NOT VERIFIED / OUTCOME UNKNOWN.',
    parameters: {
      type: 'object',
      properties: { repo: { type: 'string' }, head: { type: 'string', description: 'the branch with your changes' }, base: { type: 'string', description: 'the branch to merge into' }, title: { type: 'string' }, body: { type: 'string' }, approval: { type: 'string', description: 'The request id from a previous APPROVAL REQUIRED refusal, AFTER the user confirmed it in the system dialog. Never invent this id.' } },
      required: ['repo', 'head', 'base', 'title'],
    },
    run: async (args) => {
      if (!(await githubToken())) return 'NOT CONFIGURED: creating a pull request needs a GitHub credential with repo scope (Operations Center → Integrations, or GITHUB_TOKEN/GH_TOKEN). Nothing was created.';
      const repo = repoId(args.repo);
      const head = String(args.head ?? '').trim();
      const base = String(args.base ?? '').trim();
      const title = clip(args.title, 200);
      if (!head || !base) throw new Error('head and base branches are required.');
      if (!title) throw new Error('The pull request needs a title.');
      // ROUND 32 (§2.1): the ONE shared consequential-action gate.
      try {
        await requireConsequentialApproval({
          tool: 'github_create_pull',
          action: 'create pull request',
          origin: 'https://github.com',
          pageUrl: `https://github.com/${repo}`,
          targetLabel: title,
          targetRole: 'pull request',
          targetHref: `https://github.com/${repo}/compare/${base}...${head}`,
          effect: `open a pull request "${title}" (${head} → ${base}) in ${repo}`,
          approval: typeof args.approval === 'string' ? args.approval : undefined,
        });
      } catch (e) {
        if (isApprovalRequired(e)) return e.message;
        throw e;
      }
      return createAndVerify<GhPull>(
        'pull request',
        `/repos/${repo}/pulls`,
        { head, base, title, body: typeof args.body === 'string' ? args.body.slice(0, 8000) : undefined },
        (n) => `/repos/${repo}/pulls/${n}`,
        (d) => `pull request #${d.number} "${clip(d.title, 90)}" (${clip(d.head?.ref, 30)}→${clip(d.base?.ref, 30)}, state: ${d.merged ? 'merged' : d.draft ? 'draft' : d.state ?? '?'})`
      );
    },
  },

  github_list_workflow_runs: {
    description: 'List recent GitHub Actions workflow runs of a repository (name, branch, status, conclusion, URL) — the entry point for CI inspection.',
    parameters: { type: 'object', properties: { repo: { type: 'string' }, branch: { type: 'string' }, limit: { type: 'number' } }, required: ['repo'] },
    run: async (args) => {
      const repo = repoId(args.repo);
      const branch = String(args.branch ?? '').trim();
      const r = await gh<{ workflow_runs?: GhRun[] }>('GET', `/repos/${repo}/actions/runs?per_page=${optInt(args.limit, 10, MAX_LIST)}${branch ? `&branch=${encodeURIComponent(branch)}` : ''}`);
      const runs = r.data.workflow_runs ?? [];
      if (!runs.length) return 'No workflow runs found (Actions may not be enabled for this repository).';
      return runs.map((w) => `run ${w.id} [${w.conclusion ?? w.status ?? '?'}] ${clip(w.name, 30)} on ${clip(w.head_branch, 24)} (${clip(w.event, 12)}, ${clip(w.created_at, 19)})\n  ${w.html_url ?? ''}`).join('\n');
    },
  },

  github_workflow_failures: {
    description: 'Read the FAILURE information of one GitHub Actions run: the jobs that failed and their failing steps. Requires the run id (github_list_workflow_runs).',
    parameters: { type: 'object', properties: { repo: { type: 'string' }, run_id: { type: 'number' } }, required: ['repo', 'run_id'] },
    run: async (args) => {
      const repo = repoId(args.repo);
      const runId = Number(args.run_id);
      if (!Number.isInteger(runId) || runId <= 0) throw new Error('run_id must be the workflow run id.');
      const r = await gh<{ jobs?: GhJob[] }>('GET', `/repos/${repo}/actions/runs/${runId}/jobs?per_page=${MAX_LIST}`);
      const jobs = r.data.jobs ?? [];
      if (!jobs.length) return 'No jobs reported for this run yet.';
      const failed = jobs.filter((j) => j.conclusion === 'failure' || j.conclusion === 'cancelled' || j.conclusion === 'timed_out');
      if (!failed.length) return `No failed jobs in run ${runId} (statuses: ${jobs.map((j) => `${clip(j.name, 24)}=${j.conclusion ?? j.status}`).join(', ')}).`;
      return failed
        .map((j) => {
          const steps = (j.steps ?? []).filter((s) => s.conclusion === 'failure').map((s) => `    failed step: ${clip(s.name, 80)}`).join('\n');
          return `job "${clip(j.name, 60)}" — ${j.conclusion} — ${j.html_url ?? ''}\n${steps}`;
        })
        .join('\n');
    },
  },
};
