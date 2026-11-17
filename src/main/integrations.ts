import * as path from 'path';
import { promises as fs } from 'fs';
import { loadJson, atomicWrite } from './store';
import { FILES_ROOT } from './workspace';
import type { Tool } from './toolTypes';

/**
 * UNIVERSAL INTEGRATIONS & CAPABILITY DISCOVERY (Round 26, Phase 5).
 *
 * A standardized registry that DESCRIBES external-service capabilities on top of the
 * EXISTING tool registry — it never executes anything. Every operation names the
 * already-registered tool(s) that perform it, so every execution still flows through the
 * ONE authorized path (`runTool → guard.assessRisk → permission.authorize → durable
 * receipts`). Discovery maps a user request to the integrations that can serve it and
 * reports UNAVAILABLE integrations honestly (missing auth, disabled by the user) — the
 * coordinator never invents a capability that is not installed.
 *
 * Credentials are only ever referenced by KEY NAME for presence checks; values are
 * neither read here nor exposed to agents.
 */

export type IntegrationCategory = 'repository' | 'web-research' | 'filesystem' | 'desktop' | 'database' | 'automation' | 'deployment' | 'productivity' | 'browser';

export interface IntegrationOperation {
  name: string;
  description: string;
  /** The EXISTING registered tool(s) that execute this operation — no second engine. */
  via: string[];
  risk: 'low' | 'medium' | 'high';
  requiresAuth: boolean;
  /** R27 §4.1: what the executor tool actually needs (the honest input schema hint). */
  inputHint?: string;
}

export interface IntegrationDescriptor {
  id: string;
  name: string;
  description: string;
  category: IntegrationCategory;
  operations: IntegrationOperation[];
  /** How authentication is satisfied under the existing credential architecture. */
  auth: 'none' | 'apikey' | 'oauth';
  /** Environment variable NAMES whose PRESENCE (never value) indicates a connection. */
  configKeys: string[];
  /** Discovery keywords matched against the user's request. */
  keywords: string[];
  /**
   * ROUND 27 (§1.4): an OPTIONAL read-only health check that can establish TESTED state —
   * executed through the normal authorized tool path (never a side channel), recorded
   * with its real outcome. Integrations without one are honestly validated statically
   * only (AUTHENTICATED = credentials present and sane, never TESTED).
   */
  healthCheck?: { tool: string; args: Record<string, unknown>; description: string };
}

const BUILT_INS: IntegrationDescriptor[] = [
  {
    id: 'web-research',
    name: 'Web research & fetching',
    description: 'Search the web, fetch pages and extract structured information for research tasks.',
    category: 'web-research',
    operations: [
      { name: 'search', description: 'Search the web for sources', via: ['tinyfish_search', 'web_search'], risk: 'low', requiresAuth: false },
      { name: 'read-page', description: 'Fetch and read a page’s content', via: ['tinyfish_fetch', 'fetch_url', 'search_and_read'], risk: 'low', requiresAuth: false },
      { name: 'interactive', description: 'Drive a real browser page (login walls, dynamic apps)', via: ['browser_open', 'browser_read', 'browser_click'], risk: 'medium', requiresAuth: false },
    ],
    auth: 'none',
    configKeys: [],
    keywords: ['research', 'search', 'web', 'website', 'compare', 'pricing', 'review', 'news', 'documentation', 'fetch', 'online'],
    healthCheck: { tool: 'web_search', args: { query: 'JARVIS integration health check' }, description: 'a read-only web search proves outbound search access works' },
  },
  {
    id: 'filesystem',
    name: 'Local filesystem & project workspace',
    description: 'Read, inspect, create and modify files and directories in the JARVIS workspace.',
    category: 'filesystem',
    operations: [
      { name: 'read', description: 'Read files and documents', via: ['read', 'read_document', 'find_files'], risk: 'low', requiresAuth: false },
      { name: 'write', description: 'Create or modify files', via: ['write_file', 'edit_file'], risk: 'medium', requiresAuth: false },
      { name: 'organize', description: 'Create directories, move and copy files', via: ['make_dir', 'move_file', 'copy_file'], risk: 'medium', requiresAuth: false },
    ],
    auth: 'none',
    configKeys: [],
    keywords: ['file', 'folder', 'document', 'spreadsheet', 'report', 'save', 'write', 'workspace', 'project files', 'organize'],
  },
  {
    id: 'repository',
    name: 'Local git repository',
    description:
      'Work with a LOCAL git repository through run_command: inspect history, branches and diffs; stage and commit changes; push where the user configured credentials. GitHub-specific operations (issues, pull requests, Actions CI) live in the github integration.',
    category: 'repository',
    operations: [
      { name: 'inspect', description: 'Status, log, diff, branch listing', via: ['run_command'], risk: 'low', requiresAuth: false, inputHint: 'git status / git log / git diff — read-only commands' },
      { name: 'commit', description: 'Stage and commit changes', via: ['run_command'], risk: 'medium', requiresAuth: false, inputHint: 'git add <paths> && git commit -m <message>' },
      { name: 'push', description: 'Push to the remote (needs remote credentials)', via: ['run_command'], risk: 'high', requiresAuth: true, inputHint: 'git push <remote> <branch>' },
      { name: 'prepare-pull-request', description: 'Create a branch, push it and open a pull request (branch/commit locally via run_command; the PR itself via github_create_pull)', via: ['run_command', 'github_create_pull'], risk: 'high', requiresAuth: true, inputHint: 'git checkout -b <branch> && … && git push -u origin <branch>, then github_create_pull {repo, head, base, title}' },
    ],
    auth: 'apikey',
    configKeys: ['GITHUB_TOKEN', 'GIT_AUTHOR_NAME'],
    keywords: ['git', 'repository', 'commit', 'branch', 'repo', 'merge', 'diff', 'working tree'],
  },
  {
    id: 'github',
    name: 'GitHub (issues, pull requests, Actions CI)',
    description:
      'REAL GitHub operations through the GitHub REST API with the user’s token (GITHUB_TOKEN / GH_TOKEN): list repositories, branches, commits, issues and pull requests; inspect commits and Actions runs including CI failure steps; create issues and pull requests with VERIFIED results (every write is read back from the API before it is reported). No token = public-repo reads only, stated honestly.',
    category: 'repository',
    operations: [
      { name: 'list-repos', description: 'List the authenticated user’s repositories', via: ['github_list_repos'], risk: 'low', requiresAuth: true, inputHint: 'github_list_repos {}' },
      { name: 'inspect-repo', description: 'Repository details, branches, commits', via: ['github_repo_details', 'github_list_branches', 'github_list_commits', 'github_get_commit'], risk: 'low', requiresAuth: false, inputHint: 'github_repo_details {repo: "owner/repo"} — public repos work without a token' },
      { name: 'inspect-issues', description: 'List and read issues', via: ['github_list_issues', 'github_get_issue'], risk: 'low', requiresAuth: false, inputHint: 'github_get_issue {repo, number}' },
      { name: 'inspect-pulls', description: 'List and read pull requests', via: ['github_list_pulls', 'github_get_pull'], risk: 'low', requiresAuth: false, inputHint: 'github_get_pull {repo, number}' },
      { name: 'inspect-ci', description: 'List Actions runs and read CI failure steps', via: ['github_list_workflow_runs', 'github_workflow_failures'], risk: 'low', requiresAuth: false, inputHint: 'github_list_workflow_runs {repo} → github_workflow_failures {repo, run_id}' },
      { name: 'create-issue', description: 'Create an issue (verified by read-back)', via: ['github_create_issue'], risk: 'high', requiresAuth: true, inputHint: 'github_create_issue {repo, title, body}' },
      { name: 'create-pull', description: 'Create a pull request (verified by read-back)', via: ['github_create_pull'], risk: 'high', requiresAuth: true, inputHint: 'github_create_pull {repo, head, base, title, body} — the head branch must already be pushed' },
    ],
    auth: 'apikey',
    configKeys: ['GITHUB_TOKEN', 'GH_TOKEN'],
    keywords: ['github', 'issue', 'pull request', 'pr', 'code review', 'actions', 'ci', 'workflow', 'pipeline', 'commit', 'branch', 'repo'],
    healthCheck: { tool: 'github_status', args: {}, description: 'a live GitHub /user read proves the configured token is accepted' },
  },
  {
    id: 'vercel',
    name: 'Vercel (projects & deployments)',
    description:
      'REAL Vercel operations through the Vercel REST API with the user’s token (VERCEL_TOKEN): list projects and deployments, inspect project configuration and deployment state, read build/failure output, and trigger deployments through the project’s Deploy Hook with the resulting deployment POLLED to its real terminal state. Missing or expired tokens are reported as exactly that — no invented projects or deployments.',
    category: 'deployment',
    operations: [
      { name: 'list-projects', description: 'List the projects the token can see', via: ['vercel_list_projects'], risk: 'low', requiresAuth: true, inputHint: 'vercel_list_projects {}' },
      { name: 'project-config', description: 'Inspect a project’s configuration (framework, git link, recent deployments)', via: ['vercel_project_details'], risk: 'low', requiresAuth: true, inputHint: 'vercel_project_details {project}' },
      { name: 'list-deployments', description: 'List a project’s deployments with state and URLs', via: ['vercel_list_deployments'], risk: 'low', requiresAuth: true, inputHint: 'vercel_list_deployments {project}' },
      { name: 'deployment-status', description: 'Inspect one deployment’s real state (READY/BUILDING/ERROR/CANCELED)', via: ['vercel_deployment_details'], risk: 'low', requiresAuth: true, inputHint: 'vercel_deployment_details {deployment}' },
      { name: 'deployment-logs', description: 'Read build output and failure lines of a deployment', via: ['vercel_deployment_logs'], risk: 'low', requiresAuth: true, inputHint: 'vercel_deployment_logs {deployment}' },
      { name: 'deploy', description: 'Trigger a deployment via the project’s Deploy Hook and poll it to its real terminal state', via: ['vercel_deploy'], risk: 'high', requiresAuth: true, inputHint: 'vercel_deploy {project, hook_url?} — hook from VERCEL_DEPLOY_HOOK_URL or explicit' },
    ],
    auth: 'apikey',
    configKeys: ['VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_DEPLOY_HOOK_URL'],
    keywords: ['vercel', 'deploy', 'deployment', 'hosting', 'production', 'ship', 'preview', 'build failed'],
    healthCheck: { tool: 'vercel_status', args: {}, description: 'a live Vercel /v2/user read proves the configured token is accepted' },
  },
  {
    id: 'desktop',
    name: 'Desktop applications & OS',
    description: 'Inspect and operate local applications, processes and system state where supported.',
    category: 'desktop',
    operations: [
      { name: 'observe', description: 'See the screen / window state (grounded observation)', via: ['see_screen'], risk: 'low', requiresAuth: false },
      { name: 'open', description: 'Open an application or target', via: ['open_anything'], risk: 'medium', requiresAuth: false },
      { name: 'processes', description: 'List and manage local processes', via: ['list_processes', 'stop_process'], risk: 'high', requiresAuth: false },
    ],
    auth: 'none',
    configKeys: [],
    keywords: ['desktop', 'application', 'app', 'screen', 'window', 'process', 'open', 'install'],
  },
  {
    id: 'database',
    name: 'Project database tooling',
    description: 'Run queries and migrations against a project-local database through the project’s own CLI (prisma/drizzle/psql…). Availability depends on the project.',
    category: 'database',
    operations: [
      { name: 'query', description: 'Run a read query via the project CLI', via: ['run_command'], risk: 'medium', requiresAuth: false },
      { name: 'migrate', description: 'Apply schema migrations', via: ['run_command'], risk: 'high', requiresAuth: false },
    ],
    auth: 'none',
    configKeys: ['DATABASE_URL'],
    keywords: ['database', 'sql', 'query', 'migration', 'prisma', 'schema', 'table', 'postgres', 'sqlite', 'mysql'],
  },
  {
    id: 'native-browser',
    name: 'Native browser (your real Chrome/Edge)',
    description:
      'Operate the REAL installed browser (Round 28 Phase 2): background-tab research across multiple sites, reading authenticated pages through a session the USER explicitly connected, filling forms and preparing submissions — all in background tabs that never steal focus. Connect once with native_browser_connect; the session identity is carried on every result.',
    category: 'browser',
    operations: [
      { name: 'background-research', description: 'Open several sites in background tabs and extract structured information with source URLs', via: ['native_browser_open', 'native_browser_read', 'native_browser_snapshot'], risk: 'low', requiresAuth: false, inputHint: 'native_browser_open {url} → native_browser_read {tabId} — one tab per source, references preserved' },
      { name: 'authenticated-read', description: 'Read a page that needs YOUR sign-in (Mode A attach, or your manual sign-in in the managed profile)', via: ['native_browser_connect', 'native_browser_read'], risk: 'medium', requiresAuth: true, inputHint: 'user connects first (native_browser_connect / the Native Browser panel), then native_browser_read — credentials are never read, the browser itself holds the session' },
      { name: 'act-on-page', description: 'Click/type on a page with evidence-based outcome verification (consequential actions require explicit confirm)', via: ['native_browser_snapshot', 'native_browser_click', 'native_browser_type'], risk: 'high', requiresAuth: false, inputHint: 'native_browser_snapshot → native_browser_click {ref, expect, confirm?} — verification is evidence-based, never assumed' },
    ],
    auth: 'none',
    configKeys: [],
    keywords: ['native browser', 'my browser', 'chrome', 'edge', 'background tab', 'authenticated', 'logged in', 'sign in to site', 'browser session'],
  },
  {
    id: 'deployment',
    name: 'Deployment platforms (project CLI)',
    description:
      'Deploy and inspect releases through the project’s own CLI tooling (netlify / fly / wrangler / ssh), executed via run_command with the credentials the USER configured. Vercel has its own dedicated integration (id: vercel) with real API operations. An unconfigured deployment tool refuses honestly instead of pretending.',
    category: 'deployment',
    operations: [
      { name: 'deploy', description: 'Deploy the current project (project CLI or ssh)', via: ['run_command'], risk: 'high', requiresAuth: true, inputHint: 'netlify deploy / fly deploy / wrangler deploy — the exact command comes from the project’s own configuration' },
      { name: 'status', description: 'Inspect the latest deployment status/logs', via: ['run_command'], risk: 'low', requiresAuth: false, inputHint: 'netlify status / fly status — read-only' },
    ],
    auth: 'apikey',
    configKeys: ['NETLIFY_AUTH_TOKEN', 'FLY_API_TOKEN', 'CLOUDFLARE_API_TOKEN'],
    keywords: ['deploy', 'deployment', 'release', 'netlify', 'fly.io', 'cloudflare', 'production', 'hosting', 'ship'],
  },
  {
    id: 'productivity',
    name: 'Notes, timers & routines (local productivity)',
    description: 'Capture and retrieve notes, set timers, schedule follow-ups and manage recurring routines through JARVIS’s own durable productivity tools — no external service required.',
    category: 'productivity',
    operations: [
      { name: 'note', description: 'Add, read and organize notes', via: ['add_note', 'read_notes'], risk: 'low', requiresAuth: false },
      { name: 'timer', description: 'Set, list and cancel timers', via: ['set_timer', 'list_timers', 'cancel_timer'], risk: 'low', requiresAuth: false },
      { name: 'schedule', description: 'Schedule follow-up tasks and durable recurring routines', via: ['schedule_task', 'add_recurring_task', 'list_scheduled'], risk: 'medium', requiresAuth: false },
    ],
    auth: 'none',
    configKeys: [],
    keywords: ['note', 'notes', 'timer', 'reminder', 'briefing', 'routine', 'to-do', 'todo', 'schedule', 'follow-up'],
  },
];

// ------------------------------------------------------------------ registry + state

const stateFile = (): string => path.join(FILES_ROOT, 'brain', 'integrations.json');

interface IntegrationState {
  /** User-controlled enable/disable — a disabled integration is honestly unavailable. */
  disabled: string[];
  /** Connections the user established (id → at). Presence only; no secrets here. */
  connected: Record<string, number>;
  /**
   * ROUND 27 (§1.4): recorded validation / health-check outcomes (id → bounded history,
   * oldest last). A persisted connection record is NOT proof of authentication — only a
   * recorded successful check is. Values are never stored here, only outcomes.
   */
  checks?: Record<string, IntegrationCheck[]>;
}

export interface IntegrationCheck {
  at: number;
  ok: boolean;
  kind: 'static' | 'health';
  detail?: string;
  error?: string;
  /** Auth-class failures drive EXPIRED (was working, credentials no longer valid). */
  authRelated?: boolean;
  /**
   * ROUND 29 (§3.3): a TRANSIENT failure (network unreachable, 5xx) is honest evidence of
   * "temporarily unavailable" — NOT of a broken configuration. Permission-denied failures
   * (403 on a non-rate path) carry `denied`. The state mapping uses these instead of
   * guessing from message text.
   */
  transient?: boolean;
  denied?: boolean;
}
const MAX_CHECKS = 10;
const emptyState = (): IntegrationState => ({ disabled: [], connected: {} });

/**
 * ROUND 28 (§1.4): SHAPE-CHECK the persisted state — a hand-edited or partially corrupted
 * integrations.json must never crash connectionState (it used to throw straight out of
 * checksFor when `checks[id]` was not an array) and must never let a malformed check row
 * be served as evidence. Invalid rows are dropped, never invented around.
 */
const isCheck = (c: unknown): c is IntegrationCheck =>
  !!c && typeof c === 'object' && typeof (c as IntegrationCheck).at === 'number' && typeof (c as IntegrationCheck).ok === 'boolean' && ((c as IntegrationCheck).kind === 'static' || (c as IntegrationCheck).kind === 'health');
const loadState = async (): Promise<IntegrationState> => {
  const st = await loadJson<IntegrationState>(stateFile(), emptyState());
  const safe: IntegrationState = {
    disabled: Array.isArray(st?.disabled) ? st.disabled.filter((x): x is string => typeof x === 'string') : [],
    connected: st?.connected && typeof st.connected === 'object' ? Object.fromEntries(Object.entries(st.connected).filter(([, v]) => typeof v === 'number')) : {},
    checks: st?.checks && typeof st.checks === 'object'
      ? Object.fromEntries(
          Object.entries(st.checks)
            .filter(([, v]) => Array.isArray(v))
            .map(([k, v]) => [k, (v as unknown[]).filter(isCheck).slice(-MAX_CHECKS)])
        )
      : undefined,
  };
  return safe;
};

const registered: IntegrationDescriptor[] = [...BUILT_INS];

/** Register an additional integration (id must be unique; bounded). */
export function registerIntegration(d: IntegrationDescriptor): 'added' | 'replaced' {
  const i = registered.findIndex((x) => x.id === d.id);
  if (i >= 0) {
    registered[i] = d;
    return 'replaced';
  }
  registered.push(d);
  return 'added';
}

export const listIntegrations = (): IntegrationDescriptor[] => registered.map((d) => ({ ...d }));

async function saveState(s: IntegrationState): Promise<void> {
  await fs.mkdir(path.dirname(stateFile()), { recursive: true });
  await atomicWrite(stateFile(), JSON.stringify(s, null, 1));
}

export type IntegrationPhase = 'NOT_CONFIGURED' | 'CONFIGURED' | 'CONNECTED' | 'AUTHENTICATED' | 'TESTED' | 'AVAILABLE' | 'EXPIRED' | 'ERROR';

export interface ConnectionState {
  configured: boolean;
  enabled: boolean;
  connected: boolean;
  /**
   * ROUND 27 (§1.4): availability is EARNED, not assumed. auth-'none' integrations are
   * available when enabled; auth-class integrations are available only after a recorded
   * successful validation (static credential check) or health check. A stored connection
   * record or key presence alone is CONNECTED, never AVAILABLE.
   */
  available: boolean;
  /** The honest lifecycle state — see IntegrationPhase. */
  phase: IntegrationPhase;
  /** Honest reason when not available ('' otherwise). */
  reason: string;
  /** The last recorded check, when any validation was ever performed. */
  lastCheck?: IntegrationCheck;
  /**
   * ROUND 28 (§1.4): the last SUCCESSFUL check is older than CHECK_STALE_MS. Evidence
   * carries a timestamp; an old validation is honest but AGING — surfaced everywhere the
   * state is shown so “validated” never quietly means “validated months ago”.
   */
  staleCheck?: boolean;
  /** Epoch ms of the last successful check (undefined = never validated successfully). */
  lastOkAt?: number;
  /**
   * ROUND 29 (§3.3): WHY the last check failed, classified from the check's own evidence
   * flags — 'auth' (expired credentials), 'transient' (temporarily unavailable),
   * 'denied' (permission denied), 'connection' (everything else). Undefined when the
   * last check passed or none was ever recorded. Every displayed state reflects this
   * actual evidence — never the mere existence of configuration values.
   */
  failureKind?: 'auth' | 'transient' | 'denied' | 'connection';
}

/** Key PRESENCE check only — values are never read. */
const keyPresent = (k: string): boolean => !!process.env[k]?.trim();

const checksFor = (st: IntegrationState, id: string): IntegrationCheck[] => (st.checks?.[id] ?? []).slice(-MAX_CHECKS);

/**
 * A successful validation is EVIDENCE with a TIMESTAMP — it does not stay equally strong
 * forever. ROUND 28 (§1.4): auth-class integrations whose last successful check is older
 * than this are flagged `staleCheck` (surfaced in status/discovery/ops) so “validated” can
 * never quietly mean “validated once, long ago”. Availability semantics are unchanged:
 * the recorded check still earns the state; staleness is honest evidence age, not a
 * fabricated failure.
 */
export const CHECK_STALE_MS = 30 * 24 * 3600_000;

/** Record the ACTUAL outcome of a validation or health check (never an invented one). */
export async function recordIntegrationCheck(id: string, check: Omit<IntegrationCheck, 'at'>): Promise<void> {
  const st = await loadState();
  st.checks = st.checks ?? {};
  st.checks[id] = [...checksFor(st, id), { ...check, at: Date.now() }].slice(-MAX_CHECKS);
  await saveState(st);
}

export async function connectionState(id: string): Promise<ConnectionState> {
  const d = registered.find((x) => x.id === id);
  const st = await loadState();
  if (!d)
    return { configured: false, enabled: false, connected: false, available: false, phase: 'NOT_CONFIGURED', reason: `unknown integration "${id}"` };
  const enabled = !st.disabled.includes(id);
  const history = checksFor(st, id);
  const last = history.length ? history[history.length - 1] : undefined;
  const hadOk = history.some((c) => c.ok);
  const hasConfigKeys = d.configKeys.length > 0;
  // CONFIGURED: required configuration has actually been saved (key present, name only,
  // or a recorded connection). An integration with NO required configuration (no keys,
  // no auth layer — e.g. the built-in web research) is configured by construction.
  const configured = hasConfigKeys || d.auth !== 'none' ? d.configKeys.some(keyPresent) || st.connected[id] !== undefined : true;
  // CONNECTED: a connection exists — a recorded connection, a present key, or nothing to
  // establish for a built-in no-config integration.
  const connected = st.connected[id] !== undefined || (hasConfigKeys && d.configKeys.some(keyPresent)) || (!hasConfigKeys && d.auth === 'none');
  // PHASE: only what the recorded evidence actually establishes. ROUND 28 (§1.4): recorded
  // evidence OUTRANKS the current instant — an auth-related failure after a recorded
  // success means the credentials EXPIRED, even when the key has since vanished from the
  // environment (Workflow H: validated yesterday, token gone today). Reporting
  // NOT_CONFIGURED there would contradict the recorded history and hide the real problem.
  let phase: IntegrationPhase;
  if (last && !last.ok && last.authRelated && hadOk) phase = 'EXPIRED';
  else if (!configured) phase = 'NOT_CONFIGURED';
  else if (!connected) phase = 'CONFIGURED';
  else if (last && !last.ok) phase = 'ERROR';
  else if (last?.ok && last.kind === 'health') phase = 'TESTED';
  else if (d.auth === 'none') phase = 'AVAILABLE'; // nothing to authenticate — enabled means ready
  else if (last?.ok) phase = 'AUTHENTICATED';
  else phase = 'CONNECTED'; // a record/key exists, but authentication was never established
  // AVAILABLE is EARNED: auth-class integrations need a recorded successful check before
  // they count as available (a stored record or key presence alone is CONNECTED); no-auth
  // integrations are available out of the box, and a recorded FAILED check revokes it.
  const available = enabled && configured && connected && (last ? last.ok : d.auth === 'none');
  // ROUND 29 (§3.3): the failure classification comes from the CHECK'S OWN FLAGS —
  // transient (network/5xx) = temporarily unavailable, denied = permission denied,
  // authRelated after success = expired; everything else is a connection failure. These
  // states must reflect ACTUAL EVIDENCE, never the mere existence of config values.
  const failureKind: ConnectionState['failureKind'] = !last || last.ok || (!last.error && !last.detail) ? undefined : last.authRelated && hadOk ? 'auth' : last.transient ? 'transient' : last.denied ? 'denied' : 'connection';
  let reason = '';
  if (!enabled) reason = 'disabled by the user (integration_connect can re-enable it)';
  else if (last && !last.ok && last.authRelated && hadOk)
    reason = `the last check FAILED (${last.error ?? last.detail ?? 'reason not recorded'}) — the credentials no longer authenticate${configured ? '' : ' and the credential is no longer present'}; renew them and run integration_check to re-validate`;
  else if (!configured) reason = d.auth !== 'none' ? `not connected: missing ${d.auth} configuration (one of: ${d.configKeys.join(', ')})` : `not configured: missing configuration (one of: ${d.configKeys.join(', ')})`;
  else if (!available)
    reason =
      last && !last.ok
        ? last.transient
          ? `temporarily unavailable — the last check failed on a TRANSIENT error (${last.error ?? 'reason not recorded'}); retry integration_check rather than reconfiguring anything`
          : last.denied
            ? `permission denied — the last check was REFUSED (${last.error ?? 'reason not recorded'}); the credential may lack the required scope or the account lacks access`
            : `the last check FAILED (${last.error ?? last.detail ?? 'reason not recorded'}) — not available until a validation succeeds; run integration_check after fixing the credentials`
        : `connection recorded but never validated — authentication required: run integration_check to establish it (state: CONNECTED, not AVAILABLE)`;
  // ROUND 28 (§1.4): evidence age. The last SUCCESSFUL check drives staleness; a failed
  // or missing check is never flagged stale (it is already not available). `reason` keeps
  // its strict meaning ("why not available") — staleness surfaces via staleCheck/lastOkAt.
  const lastOk = [...history].reverse().find((c) => c.ok);
  const staleCheck = !!lastOk && Date.now() - lastOk.at > CHECK_STALE_MS;
  return { configured, enabled, connected, available, phase, reason, lastCheck: last, staleCheck, lastOkAt: lastOk?.at, failureKind };
}

/** Connect/disconnect + enable/disable — explicit user actions, persisted. */
export async function setIntegrationEnabled(id: string, enabled: boolean): Promise<string> {
  if (!registered.some((d) => d.id === id)) return `NOT DONE: unknown integration "${id}". Known: ${registered.map((d) => d.id).join(', ')}.`;
  const st = await loadState();
  const had = st.disabled.includes(id);
  if (enabled && had) st.disabled = st.disabled.filter((x) => x !== id);
  else if (!enabled && !had) st.disabled.push(id);
  if (!enabled && !had) {
    /* keep connection record; availability alone flips */
  }
  await saveState(st);
  return `integration ${id} ${enabled ? 'enabled' : 'disabled'}`;
}

export async function setIntegrationConnected(id: string, connected: boolean): Promise<string> {
  if (!registered.some((d) => d.id === id)) return `NOT DONE: unknown integration "${id}".`;
  const st = await loadState();
  if (connected) st.connected[id] = Date.now();
  else delete st.connected[id];
  await saveState(st);
  return `integration ${id} ${connected ? 'connected' : 'disconnected'}`;
}

// ---------------------------------------------------- connection validation (R27 §1.4)

/**
 * The ONE executor hook for health checks: index.ts injects a wrapper around the central
 * `runToolDetailed` dispatch, so a health check is executed through the SAME authorized
 * pathway as every other tool call (`guard.assessRisk → permission.authorize → receipts`)
 * — never a side channel. No injection = health checks honestly unavailable.
 */
let executor: ((tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; detail: string; authRelated?: boolean; transient?: boolean; denied?: boolean }>) | null = null;
export const registerIntegrationExecutor = (fn: (tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; detail: string; authRelated?: boolean; transient?: boolean; denied?: boolean }>): void => {
  executor = fn;
};

/**
 * STATIC CONNECTION VALIDATION (§1.4 step 1–3): inspect the configuration, check
 * credential availability WITHOUT exposing values, and record the actual result.
 * Establishes at most AUTHENTICATED — only a real health check (or a successful real
 * operation) establishes TESTED.
 */
export async function validateIntegration(id: string): Promise<ConnectionState> {
  const d = registered.find((x) => x.id === id);
  if (!d) throw new Error(`unknown integration "${id}"`);
  // Nothing to validate only when there is no auth layer AND no required configuration.
  if (d.auth === 'none' && d.configKeys.length === 0) {
    await recordIntegrationCheck(id, { ok: true, kind: 'static', detail: 'no authentication or configuration required for this integration' });
    return connectionState(id);
  }
  const present = d.configKeys.filter((k) => keyPresent(k));
  if (!present.length) {
    const st = await connectionState(id);
    if (!st.configured) return st; // never configured: nothing to validate — the honest state is NOT_CONFIGURED, not a recorded failure
    await recordIntegrationCheck(id, { ok: false, kind: 'static', error: `validation FAILED: no credentials/configuration present (need one of: ${d.configKeys.join(', ')})`, authRelated: true });
    return connectionState(id);
  }
  // Minimal sanity WITHOUT exposing values: an implausibly short credential is reported.
  const truncated = present.filter((k) => (process.env[k] ?? '').trim().length < 8);
  if (truncated.length) {
    await recordIntegrationCheck(id, { ok: false, kind: 'static', error: `validation FAILED: the configured ${truncated.join(', ')} value looks truncated or invalid (length < 8; value not shown)`, authRelated: true });
    return connectionState(id);
  }
  await recordIntegrationCheck(id, { ok: true, kind: 'static', detail: `credentials present for: ${present.join(', ')} (values never read or exposed)` });
  return connectionState(id);
}

/**
 * HEALTH CHECK (§1.4 step 3–4): run the integration's declared read-only check through
 * the injected central executor (authorized path), record the ACTUAL result, and update
 * the connection state. Integrations without a health check are validated statically and
 * the limit is stated honestly — authentication is never invented.
 */
export async function runIntegrationHealthCheck(id: string): Promise<string> {
  const d = registered.find((x) => x.id === id);
  if (!d) throw new Error(`unknown integration "${id}"`);
  const st = await connectionState(id);
  if (!st.enabled) return `NOT DONE: ${id} is disabled — enable it first (integration_connect).`;
  if (!st.configured) return `NOT DONE: ${id} is ${st.phase} — save its ${d.auth} configuration first (one of: ${d.configKeys.join(', ')}).`;
  // static validation first: credential presence/sanity is a precondition
  await validateIntegration(id);
  if (!d.healthCheck) {
    const after = await connectionState(id);
    return after.available
      ? `Validated (static) — ${after.phase}: ${after.lastCheck?.detail ?? 'credentials verified for presence and sanity; values not exposed'}. No health check is defined for ${id}, so TESTED can only be established by a first successful real operation.`
      : `Validation FAILED — ${after.phase}: ${after.lastCheck?.error ?? after.reason}`;
  }
  if (!executor) {
    const after = await connectionState(id);
    return `Validated (static) — ${after.phase}. The health-check executor is not registered in this environment, so the check could not run (reported honestly, not invented).`;
  }
  const res = await executor(d.healthCheck.tool, d.healthCheck.args);
  await recordIntegrationCheck(id, { ok: res.ok, kind: 'health', detail: res.ok ? `${d.healthCheck.description} — succeeded: ${res.detail}` : undefined, error: res.ok ? undefined : res.detail, authRelated: !res.ok ? res.authRelated : undefined, transient: !res.ok ? res.transient : undefined, denied: !res.ok ? res.denied : undefined });
  const after = await connectionState(id);
  return res.ok
    ? `Health check SUCCEEDED — ${after.phase}: ${res.detail}`
    : `Health check FAILED — ${after.phase}${after.failureKind === 'transient' ? ' (temporarily unavailable)' : after.failureKind === 'denied' ? ' (permission denied)' : ''}: ${res.detail}${res.authRelated ? ' (auth-related: if this integration worked before, its credentials may have expired)' : ''}`;
}

// ----------------------------------------------------------------------- discovery

export interface DiscoveredIntegration {
  id: string;
  name: string;
  score: number;
  state: ConnectionState;
  matchedOperations: IntegrationOperation[];
}

/**
 * CAPABILITY DISCOVERY: which registered integrations can serve this request, ranked by
 * keyword relevance, each with its HONEST availability. Unavailable integrations are
 * returned too — with the reason — so the coordinator can say what is missing instead of
 * inventing a capability.
 */
export async function discoverIntegrations(request: string, limit = 4): Promise<DiscoveredIntegration[]> {
  const q = String(request ?? '').toLowerCase();
  if (!q.trim()) return [];
  const scored: DiscoveredIntegration[] = [];
  for (const d of registered) {
    let score = 0;
    for (const kw of d.keywords) if (q.includes(kw)) score += 2;
    if (q.includes(d.name.toLowerCase()) || q.includes(d.id)) score += 2;
    if (score === 0) continue;
    // R27 §1.4: discovery reports the HONEST lifecycle phase — a stored connection record
    // alone is CONNECTED, never AVAILABLE; only a recorded successful check earns it.
    const state = await connectionState(d.id);
    const matchedOperations = d.operations.filter((op) => op.name.split(/[-_\s]+/).some((w) => q.includes(w)) || d.keywords.some((kw) => op.description.toLowerCase().includes(kw))).slice(0, 4);
    scored.push({ id: d.id, name: d.name, score, state, matchedOperations: matchedOperations.length ? matchedOperations : d.operations.slice(0, 3) });
  }
  return scored.sort((a, b) => b.score - a.score || (Number(b.state.available) - Number(a.state.available))).slice(0, Math.max(1, Math.min(limit, 6)));
}

const renderDiscovery = (hits: DiscoveredIntegration[]): string =>
  hits
    .map((h) =>
      [
        `- ${h.name} [${h.id}] — state ${h.state.phase}${h.state.available ? ' (AVAILABLE)' : ` (UNAVAILABLE: ${h.state.reason})`}`,
        ...h.matchedOperations.map((op) => `    · ${op.name}: ${op.description} — runs via existing tool(s): ${op.via.join(', ')} (${op.risk} risk${op.requiresAuth ? ', needs auth' : ''})${op.inputHint ? ` [args: ${op.inputHint}]` : ''}`),
      ].join('\n')
    )
    .join('\n');

// ------------------------------------------------------------------------ tool surface

export const integrationTools: Record<string, Tool> = {
  integration_discover: {
    description: 'Discover which registered integrations (web research, filesystem, git/repository, desktop, database) can serve a request — with their operations, the EXISTING tools that execute them, and HONEST availability (missing auth or disabled integrations are reported, never invented).',
    parameters: { type: 'object', properties: { request: { type: 'string', description: 'The user request or task to find capabilities for.' } }, required: ['request'] },
    run: async (args) => {
      const hits = await discoverIntegrations(String(args.request ?? ''));
      if (!hits.length) return 'No registered integration matches this request. Use the base tools directly.';
      return `AVAILABLE CAPABILITIES for this request (all operations execute through the normal authorized tool path):\n${renderDiscovery(hits)}`;
    },
  },
  integration_connect: {
    description: 'Enable/disable a registered integration, record that its connection was established/removed, or VALIDATE it (validate: true runs the static credential check and, where defined, the read-only health check — availability is earned by a recorded successful check, never assumed from a stored record). The credential itself is managed by the secure credential store — this only records state and NEVER receives secret values.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Integration id (see integration_discover).' },
        enabled: { type: 'boolean', description: 'Enable (true) or disable (false) the integration.' },
        connected: { type: 'boolean', description: 'Record the connection as established (true) or removed (false).' },
        validate: { type: 'boolean', description: 'Run connection validation (static credential check + health check where defined) and record the actual result.' },
      },
      required: ['id'],
    },
    run: async (args) => {
      const id = String(args.id ?? '').trim();
      if (!id) throw new Error('id is required.');
      const out: string[] = [];
      if (typeof args.enabled === 'boolean') out.push(await setIntegrationEnabled(id, args.enabled));
      if (typeof args.connected === 'boolean') out.push(await setIntegrationConnected(id, args.connected));
      if (args.validate === true) out.push(await runIntegrationHealthCheck(id));
      const st = await connectionState(id);
      out.push(`state: ${st.phase}${st.available ? ' (AVAILABLE)' : ` (UNAVAILABLE: ${st.reason})`}`);
      return out.join('; ');
    },
  },
  integration_check: {
    description: 'Run connection validation for one integration: the static credential check (presence and sanity, values never exposed) plus its declared read-only health check through the normal authorized tool path. Records the ACTUAL outcome — CONFIGURED/CONNECTED integrations only become AUTHENTICATED/TESTED (and AVAILABLE) through a recorded successful check; expired or failing credentials are reported honestly (EXPIRED/ERROR), never invented away.',
    parameters: { type: 'object', properties: { id: { type: 'string', description: 'Integration id (see integration_status).' } }, required: ['id'] },
    run: async (args) => runIntegrationHealthCheck(String(args.id ?? '').trim()),
  },
  integration_status: {
    description: 'List all registered integrations with their operations and their honest lifecycle state (NOT_CONFIGURED / CONFIGURED / CONNECTED / AUTHENTICATED / TESTED / AVAILABLE / EXPIRED / ERROR) — missing auth, user-disabled, unvalidated connections and failed checks are all stated, never invented.',
    parameters: { type: 'object', properties: {} },
    run: async () => {
      const lines = await Promise.all(
        registered.map(async (d) => {
          const st = await connectionState(d.id);
          const check = st.lastCheck ? `; last check ${st.lastCheck.kind} ${st.lastCheck.ok ? 'OK' : 'FAILED'}: ${st.lastCheck.ok ? st.lastCheck.detail ?? 'ok' : st.lastCheck.error ?? 'failed'}` : '';
          const stale = st.staleCheck && st.lastOkAt ? `; VALIDATION STALE: the last successful check was ${new Date(st.lastOkAt).toISOString()} (over 30 days ago) — run integration_check to re-validate` : '';
          return `- ${d.name} [${d.id}] (${d.category}, auth: ${d.auth}) — ${st.phase}${st.available ? '' : ` (UNAVAILABLE: ${st.reason})`}${check}${stale}; operations: ${d.operations.map((o) => `${o.name}→${o.via.join('/')}`).join(', ')}`;
        })
      );
      return `REGISTERED INTEGRATIONS:\n${lines.join('\n')}`;
    },
  },
};
