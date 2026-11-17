import type { Tool } from './toolTypes';
import type { ToolResultEnvelope } from './toolResult';

/**
 * CROSS-APPLICATION WORKFLOW PLAYBOOKS (Round 30, restored in Round 32 Phase 4 §4.2).
 *
 * Three durable, useful workflows that span applications. They are GENUINE PLANS executed
 * by the EXISTING coordinator — this module owns no execution loop, no task store and no
 * scheduler. `run_playbook` composes the playbook's structured plan into a complete task
 * brief (with the playbook's tool names, approval requirements and verification points
 * stated per step) and starts a REAL durable task through start_task's coordinator
 * pipeline: plan → execute with scoped agents → verify against acceptance criteria →
 * honest verdict. Every step's wording preserves what Round 30 specified:
 *
 *   A. GitHub issue → verified PR
 *   B. Local project → Vercel deployment
 *   C. Browser research → verified artifact
 *
 * The consequential steps (PR creation, deployment trigger) name the shared
 * consequential-action gate explicitly — the plans route the executor THROUGH the
 * approval architecture, never around it.
 */

export interface PlaybookStep {
  /** Imperative step title (becomes plan guidance, not a scripted call). */
  title: string;
  /** What to do, which EXISTING tools to use, and what evidence the step must produce. */
  detail: string;
}

export interface Playbook {
  id: string;
  name: string;
  description: string;
  steps: PlaybookStep[];
  /** The acceptance criteria the coordinator's verifier can check mechanically. */
  acceptance: string[];
}

export const PLAYBOOKS: Playbook[] = [
  {
    id: 'github-issue-to-pr',
    name: 'GitHub issue → verified PR',
    description: 'Take a real GitHub issue, implement the requested change in the local project, push through the authorized pathway, and open a pull request after explicit user approval — with the remote PR and CI status verified from the API.',
    steps: [
      { title: 'Retrieve the actual issue', detail: 'Read the REAL issue with github_get_issue (repo + number). Work from the issue text, never from an assumption about what it says.' },
      { title: 'Inspect the repository and the local project', detail: 'Inspect the workspace with inspect_project and read the relevant modules; read the project conventions before editing anything.' },
      { title: 'Analyze impact before modification', detail: 'Run analyze_impact on every shared module you intend to change and state the blast radius in the work report before editing.' },
      { title: 'Implement the requested change', detail: 'Make the change with the ordinary file tools, inside the project workspace, following the existing architecture and naming.' },
      { title: 'Run the project\u2019s existing validation', detail: 'Use the project\u2019s OWN build/typecheck/test commands (detect them from package.json / the project profile). Never invent test suites or scripts that do not exist.' },
      { title: 'Commit and push through the authorized pathway', detail: 'Commit with a clear message and push via run_command (authorized local git). Report the pushed branch and commit hash.' },
      { title: 'Request approval before creating the PR', detail: 'github_create_pull is CONSEQUENTIAL: the first call returns APPROVAL REQUIRED with a request id — surface it to the user, wait for the system-confirmation approval, then repeat the call with approval=<id>.' },
      { title: 'Verify the real remote PR and CI status', detail: 'Read the created PR back (github_get_pull) and inspect CI with github_list_workflow_runs / github_workflow_failures. Never claim the PR exists without the real remote number/URL.' },
      { title: 'Report actual artifacts and unresolved issues', detail: 'Report the issue number, branch, commit, PR URL, CI state and anything unresolved. Unverified claims are failures.' },
    ],
    acceptance: [
      'the implemented change exists in the workspace and passes the project\u2019s existing validation command',
      'the pull request was created and VERIFIED (real remote number/URL) after user approval',
      'the report names the real CI state from the API, or states honestly that CI has not reported yet',
    ],
  },
  {
    id: 'local-project-to-vercel',
    name: 'Local project → Vercel deployment',
    description: 'Inspect the workspace, identify the Vercel project, check credentials and blockers, then trigger the deployment through the validated official deploy-hook pathway after explicit user approval — and reconcile the real deployment state.',
    steps: [
      { title: 'Inspect the actual workspace', detail: 'Inspect the project (inspect_project): framework, build commands, existing configuration. Never deploy a guess.' },
      { title: 'Identify the associated Vercel project', detail: 'Find the real project with vercel_list_projects / vercel_project_details (name, framework, git link, recent deployments).' },
      { title: 'Check credentials and deployment prerequisites', detail: 'vercel_status confirms the credential (credential store or VERCEL_TOKEN) is present and accepted. The deploy hook must be the OFFICIAL endpoint shape https://api.vercel.com/v1/integrations/deploy/<hook-id>.' },
      { title: 'Identify blockers before triggering anything', detail: 'List anything that would make the deployment fail (missing hook, rejected credential, failing build) and resolve or report it FIRST.' },
      { title: 'Request approval', detail: 'vercel_deploy is CONSEQUENTIAL: the first call returns APPROVAL REQUIRED with a request id — surface it to the user and wait for the system-confirmation approval.' },
      { title: 'Trigger through the validated deploy-hook pathway', detail: 'Repeat vercel_deploy with approval=<id>. Arbitrary URLs, foreign hosts, query strings and redirects are refused by design.' },
      { title: 'Reconcile the actual deployment state', detail: 'The tool polls the real deployment to a terminal state; if the trigger outcome was UNKNOWN (network error after send), inspect vercel_list_deployments BEFORE considering another trigger.' },
      { title: 'Report the real URL and deployment state', detail: 'Report the real deployment URL and readyState (READY / ERROR / CANCELED / not settled) — never an assumed success.' },
    ],
    acceptance: [
      'the deployment was triggered ONLY after user approval through the validated official endpoint',
      'the REAL deployment state and URL are reported from the Vercel API (or the outcome is stated as UNKNOWN with reconciliation done)',
    ],
  },
  {
    id: 'browser-research-to-artifact',
    name: 'Browser research → verified artifact',
    description: 'Research a topic from real sources, preserve the source evidence, produce the requested document, verify it exists and reopens, and report the actual artifact path and sources.',
    steps: [
      { title: 'Research using real sources', detail: 'Use the research/web tools (web_search, tinyfish_search, web_browse, fetch_url) against REAL pages. Every claim in the artifact must trace to a source you actually fetched.' },
      { title: 'Preserve source evidence', detail: 'Keep the source list (title + URL + what it supported) as you go; at least 2 distinct fetched sources are required by the acceptance check.' },
      { title: 'Produce the requested document', detail: 'Create the artifact with the ordinary document tools in the workspace, following the format the user asked for.' },
      { title: 'Verify the file exists and can be reopened', detail: 'The file must exist, be non-empty and reopen/validate as its format (the verifier checks file-exists / file-nonempty / file-format mechanically).' },
      { title: 'Open it in the desktop application when requested', detail: 'Only when the user asked: open the artifact with the appropriate desktop tool and confirm it opened.' },
      { title: 'Report the actual artifact path and sources', detail: 'Report the exact workspace path, the format, and the source list. A missing file or an unverified claim is a failure, not a summary.' },
    ],
    acceptance: [
      'at least 2 distinct sources were actually fetched (evidence present)',
      'the artifact file exists, is non-empty and reopens as its format',
      'the report names the real artifact path and the sources used',
    ],
  },
];

export const playbookById = (id: string): Playbook | undefined => PLAYBOOKS.find((p) => p.id === String(id ?? '').trim());

/** The composed task brief — the playbook becomes a REAL request the coordinator plans and executes. */
export function playbookBrief(p: Playbook, request: string): string {
  const steps = p.steps.map((s, i) => `${i + 1}. ${s.title} — ${s.detail}`).join('\n');
  return [
    `PLAYBOOK: ${p.name} (${p.id}).`,
    request.trim() ? `USER REQUEST: ${request.trim()}` : '',
    `Execute this workflow as a genuine plan — every step runs through the existing tools and the existing verification; nothing is pre-scripted:`,
    steps,
    `ACCEPTANCE (checked mechanically before COMPLETED): ${p.acceptance.join('; ')}.`,
    'Report actual artifacts, real remote identifiers and unresolved issues — an unverified claim is a failure.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export const playbookListText = (): string => PLAYBOOKS.map((p) => `${p.id}: ${p.name} — ${p.description} (${p.steps.length} steps)`).join('\n');

// ------------------------------------------------------------------------------- tool

/**
 * The playbook tool receives the ONE authorized runner from the registry assembly site
 * (tools.ts) — no import cycle, no second execution pathway.
 */
export const playbookTools = (runTool: (tool: string, rawArgs: string) => Promise<ToolResultEnvelope>): Record<string, Tool> => ({
  run_playbook: {
    description:
      'Run one of the built-in cross-application workflows as a REAL durable task (github-issue-to-pr | local-project-to-vercel | browser-research-to-artifact). The playbook\u2019s structured plan is executed by the coordinator — planned, executed with scoped agents, verified against the playbook\u2019s acceptance criteria. Consequential steps (PR creation, deployment) stop for the user\u2019s system-dialog approval exactly where the plan says so.',
    parameters: {
      type: 'object',
      properties: {
        playbook: { type: 'string', description: 'The playbook id (run_playbook with no playbook lists them).' },
        request: { type: 'string', description: 'The concrete request: which issue/repo, which project, which topic — the specifics of THIS run.' },
      },
    },
    run: async (args) => {
      const id = String(args.playbook ?? '').trim();
      if (!id) return `Available playbooks:\n${playbookListText()}`;
      const p = playbookById(id);
      if (!p) return `NOT DONE: unknown playbook "${id}". Available:\n${playbookListText()}`;
      const brief = playbookBrief(p, String(args.request ?? ''));
      // THROUGH THE EXISTING PATHWAY: the same start_task tool the model itself uses —
      // one coordinator, one task lifecycle, one verification pipeline. No second engine.
      const env = await runTool('start_task', JSON.stringify({ request: brief }));
      return `Playbook "${p.name}" handed to the durable task pipeline:\n${env.text}`;
    },
  },
});
