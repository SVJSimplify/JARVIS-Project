import { FILES_ROOT, isInsideRoot } from './workspace';
import * as path from 'path';
import type { Risk } from './guard';

/**
 * PERMISSION SERVICE (Module F) — centralized, code-enforced authorization.
 *
 * Every consequential tool action passes through `authorize` exactly once, at the single
 * tool-execution choke point (runTool). The model cannot bypass it: there is no other
 * execution path, and prompt instructions never reach this layer's inputs.
 *
 * SINGLE OPERATOR MODE — FULL AUTONOMY, ONE POLICY, NO ALTERNATE ROUTES:
 *
 *   ALL SUPPORTED ACTIONS ARE ALLOWED AUTOMATICALLY, EXCEPT DELETION AND MODIFICATION OF
 *   OPERATING-SYSTEM-RELATED FILES OR RESOURCES.
 *
 * Concretely, authorize() can return exactly three shapes of decision:
 *   1. `blocked`   — a risk marked block (deletion, OS-resource modification) denies
 *                    ALWAYS. Nothing overrides it. This is hard restriction A + B.
 *   2. `rule-denied` — the child-agent deletion backstop: a child that somehow reaches the
 *                    gate with the delete action class is denied here too (defense in
 *                    depth behind assessRisk, the SAME policy as the parent — not extra
 *                    restrictions).
 *   3. `allowed` / `autonomous` — everything else, for the main agent and child agents
 *                    alike. Purchases, credentials handling, configuration, installation,
 *                    sending, publishing: all ordinary allowed work.
 *
 * What deliberately does NOT exist here anymore:
 *   - No user-configured rule file (brain/permissions.json). A hand-written `ask` rule
 *     used to be the one remaining route to a confirmation prompt; the policy has no
 *     alternate route for introducing prompts, so the entire rule-file path is gone.
 *   - No ask effect, no confirmer, no session approvals. The type system enforces it:
 *     `Effect` is 'allow' | 'deny' only, and PermissionResult has no approval outcome.
 *   - No autonomy selector. Exactly one mode exists ('autonomous').
 *
 * This module is pure logic and electron-free.
 */

export type ActionClass =
  | 'read'
  | 'write'
  | 'delete'
  | 'execute'
  | 'install'
  | 'credentials'
  | 'communicate'
  | 'purchase'
  | 'config';

/** Only two effects exist. `ask` was removed: nothing may route back to a prompt. */
export type Effect = 'allow' | 'deny';
/** The one autonomy level. The selector is gone; the type exists so old callers still typecheck. */
export type Autonomy = 'autonomous';

export interface PermRule {
  action: ActionClass | '*';
  /** Glob-ish resource pattern (`*` matches anything); resources are namespaced (path:, shell:, …). */
  resource: string;
  effect: Effect;
  note?: string;
}

export interface PermissionQuery {
  tool: string;
  action: ActionClass;
  /** Namespaced resource, e.g. `path:C:\...\f.txt`, `shell:npm run build`, `py:<code>`, `proc:explorer`. */
  resource: string;
  /** The per-tool risk assessment (guard.assessRisk); null when the action was assessed safe. */
  risk: Risk | null;
  /** Calling agent ('main' or a child agent id). */
  agent?: string;
}

export interface PermissionResult {
  allowed: boolean;
  auth: 'allowed' | 'autonomous' | 'blocked' | 'rule-denied';
  rule?: PermRule;
  reason: string;
}

// --------------------------------------------------------------------- wildcard matching

/** Case-insensitive glob match where `*` matches any run of characters. Pure. */
export const wildcardMatch = (value: string, pattern: string): boolean => {
  const v = value.toLowerCase();
  const p = pattern.toLowerCase();
  if (!p.includes('*')) return v === p;
  const parts = p.split('*');
  let at = 0;
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    const found = v.indexOf(parts[i], at);
    if (i === 0 && found !== 0) return false; // first segment must anchor at the start
    if (found < 0) return false;
    at = found + parts[i].length;
  }
  if (parts[parts.length - 1] && at !== v.length && !p.endsWith('*')) return false;
  return true;
};

/** Last matching rule wins (OpenCode's evaluate()); undefined when nothing matches. */
export const evaluateRules = (action: ActionClass, resource: string, rules: PermRule[]): PermRule | undefined => {
  let hit: PermRule | undefined;
  for (const r of rules) {
    if ((r.action === '*' || r.action === action) && wildcardMatch(resource, r.resource)) hit = r;
  }
  return hit;
};

// ------------------------------------------------------------------------- default rules

/** The one policy for every agent: everything not hard-blocked runs. */
export const AUTONOMOUS_RULES: PermRule[] = [{ action: '*', resource: '*', effect: 'allow', note: 'full autonomy' }];

/**
 * The child-agent deletion backstop — the ONLY extra rule children carry, and it is not an
 * extra restriction: deletion is one of the two hard restrictions of the single policy,
 * already enforced through assessRisk for every agent. This rule is the belt behind that
 * suspenders, so a child that reaches the gate with a delete-classified action is denied
 * even if a future classifier gap marks it riskless. Children otherwise follow exactly the
 * same policy as the main agent (purchases, credentials work, configuration, installation
 * and every ordinary action run automatically).
 */
export const CHILD_DENIED: PermRule[] = [{ action: 'delete', resource: '*', effect: 'deny', note: 'deletion is disabled (same policy as the main agent)' }];

const CHILD_RULES: PermRule[] = [AUTONOMOUS_RULES[0], ...CHILD_DENIED];

export const childRulesFor = (_parent: Autonomy, agent: string): PermRule[] => {
  void _parent;
  void agent;
  return CHILD_RULES;
};

/** Always 'autonomous': the single operator mode. Kept async so callers do not change. */
export const currentAutonomy = async (): Promise<Autonomy> => 'autonomous';

// ------------------------------------------------------------------ action classification

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'apply_patch', 'copy_file', 'move_file', 'make_dir']);
const ABS = (p: unknown): string => String(p ?? '');

/**
 * Classify a tool call into an action class and a namespaced resource. Pure; exported for
 * tests. Tools not listed here are read-like: they observe, they do not change the world.
 */
export function classifyToolAction(tool: string, args: Record<string, unknown>, riskBlock = false): { action: ActionClass; resource: string } {
  const a = args ?? {};
  if (riskBlock) return { action: 'delete', resource: '*' }; // deletion attempts are denied regardless of shape
  // INDEPENDENT DELETION TRIPWIRE (defense in depth, not dependent on assessRisk):
  // a tool whose NAME declares destruction, or a patch op that deletes a file, classifies
  // as delete even if the risk assessment somehow returned null. This is what makes the
  // gate's deletion tooth (authorize step 2) live for every current and future tool —
  // a newly registered destructive tool cannot enter the registry below the policy.
  // Round 20 (CHANGE 10): the verb list was finite (delete/destroy/erase/wipe/purge/shred)
  // — a future `unlink_file` / `truncate_log` / `empty_trash` / `uninstall_app` tool would
  // have classified as read. The additional verbs are unambiguous destruction words.
  if (/^(?:delete|destroy|erase|wipe|purge|shred|unlink|truncate|uninstall|format)[-_]/i.test(tool) || /(?:^|_)(?:delete|destroy|unlink|truncate|uninstall|empty(?:_trash|_bin)|erase)(?:_|$)/i.test(tool))
    return { action: 'delete', resource: `tool:${tool}` };
  if (tool === 'apply_patch' && /^\s*\*\*\* Delete File: /m.test(String(a.patch ?? '')))
    return { action: 'delete', resource: `patch:${String(a.patch ?? '').slice(0, 120)}` };
  if (WRITE_TOOLS.has(tool)) {
    const p = ABS(tool === 'move_file' || tool === 'copy_file' ? a.to : a.path);
    const isWinDrive = /^[a-z]:[\\/]/i.test(p);
    const full = path.isAbsolute(p) || isWinDrive ? path.normalize(p) : path.join(FILES_ROOT, p);
    return { action: 'write', resource: isInsideRoot(full) ? `path:workspace:${full}` : `path:${full}` };
  }
  if (tool === 'run_command') return { action: 'execute', resource: `shell:${ABS(a.command).slice(0, 200)}` };
  if (tool === 'run_python') return { action: 'execute', resource: `py:${ABS(a.code).slice(0, 120)}` };
  if (tool === 'stop_process') return { action: 'execute', resource: `proc:${ABS(a.name) || ABS(a.pid)}` };
  if (tool === 'open_url' || tool === 'open_in_my_browser') {
    try {
      return { action: 'execute', resource: `url:${new URL(ABS(a.url)).host}` };
    } catch {
      return { action: 'execute', resource: 'url:*' };
    }
  }
  if (tool === 'open_anything' || tool === 'launch_app' || tool === 'open_app') return { action: 'execute', resource: `app:${ABS(a.target) || ABS(a.name)}` };
  if (tool === 'browser_upload') return { action: 'communicate', resource: `web:${ABS(a.path).slice(0, 120)}` };
  // ROUND 28 (Phase 2): native-browser actions are REAL actions, not reads — clicks and
  // typing get side-effect receipts (action ≠ read ⇒ durable 'started' record at the
  // choke point), navigation is execute-class like open_url, and the session lifecycle is
  // configuration-class. In-page destruction still trips the policy layer inside the tool.
  if (tool === 'native_browser_click') return { action: 'communicate', resource: `web:click:${ABS(a.ref)}` };
  if (tool === 'native_browser_type') return { action: 'communicate', resource: `web:type:${ABS(a.ref)}` };
  if (tool === 'native_browser_navigate' || tool === 'native_browser_open') {
    try {
      return { action: 'execute', resource: `url:${new URL(ABS(a.url)).host}` };
    } catch {
      return { action: 'execute', resource: 'url:*' };
    }
  }
  if (tool === 'native_browser_connect' || tool === 'native_browser_disconnect' || tool === 'native_browser_reconnect')
    return { action: 'config', resource: 'browser:native-session' };
  if (tool === 'native_browser_close_tab') return { action: 'write', resource: `web:tab:${ABS(a.tabId).slice(0, 80)}` };
  // ROUND 29 (Phase 3): GitHub/Vercel mutations are REAL external communications — they
  // get side-effect receipts like every other action class that can change the world.
  // Everything else in the github_*/vercel_* families is read-like (default 'read').
  if (tool === 'github_create_issue') return { action: 'communicate', resource: `web:github:issue:${ABS(a.repo).slice(0, 90)}` };
  if (tool === 'github_create_pull') return { action: 'communicate', resource: `web:github:pull:${ABS(a.repo).slice(0, 90)}:${ABS(a.head).slice(0, 60)}` };
  if (tool === 'vercel_deploy') return { action: 'communicate', resource: `web:vercel:deploy:${ABS(a.project).slice(0, 90)}` };
  if (tool === 'forget') return { action: 'config', resource: `memory:${ABS(a.text).slice(0, 80)}` };
  // Round 19 (CHANGE 8 audit): these tools WRITE but were misclassified as read-like —
  // make_document produces an artifact FILE on disk; remember/save_contact/
  // add_recurring_task/project_save mutate durable engine stores. Misclassification
  // meant no side-effect receipt and a wrong action class at the gate.
  if (tool === 'make_document') {
    const p = ABS(a.path ?? a.outPath ?? a.filename ?? a.title ?? '');
    const full = path.isAbsolute(p) ? path.normalize(p) : path.join(FILES_ROOT, p);
    return { action: 'write', resource: isInsideRoot(full) ? `path:workspace:${full}` : `path:${full}` };
  }
  if (tool === 'remember' || tool === 'save_contact' || tool === 'add_recurring_task')
    return { action: 'config', resource: `memory:${tool}` };
  if (tool === 'project_save') return { action: 'config', resource: `project:${ABS(a.name).slice(0, 80)}` };
  return { action: 'read', resource: tool };
}

// ------------------------------------------------------------------------------ authorize

/**
 * The one authorization gate. Never throws; a decision always comes back.
 * The caller MUST record the returned `auth` (toolRecord) and must not run the tool
 * unless `allowed` is true. There is no ask outcome: nothing here can surface a prompt.
 */
export async function authorize(q: PermissionQuery): Promise<PermissionResult> {
  const { action, risk } = q;

  // 1. Hard safety: blocked risks deny always. This is the single policy's two hard
  //    restrictions (deletion, OS-resource modification); no rule or setting can override.
  if (risk?.block) return { allowed: false, auth: 'blocked', reason: risk.title };

  // 2. THE DELETION TOOTH AT THE GATE — independent of assessRisk. A call that classifies
  //    as delete is denied for EVERY agent (main included) even when the risk assessment
  //    returned null. The old backstop was unreachable: 'delete' could only arise from a
  //    risk block, which step 1 had already denied. Now the tripwire in classifyToolAction
  //    feeds this line, so a future classifier gap can never let a destructive call through.
  if (action === 'delete')
    return {
      allowed: false,
      auth: q.agent && q.agent !== 'main' ? 'rule-denied' : 'blocked',
      reason: 'Deletion is disabled on this laptop (policy hard restriction A).',
    };

  // 3. Full autonomy for every agent: assessed risks and outside-workspace writes run
  //    without a prompt; purchases, credentials, installation, configuration and every
  //    ordinary action are the same for children as for the main agent.
  return { allowed: true, auth: risk || (q.agent && q.agent !== 'main') ? 'autonomous' : 'allowed', reason: 'full autonomy' };
}

// --------------------------------------------------------------------------- diagnostics

/** The effective ruleset for an agent, for the UI and debugging. */
export const effectiveRules = async (agent = 'main'): Promise<PermRule[]> => {
  return agent === 'main' ? AUTONOMOUS_RULES : CHILD_RULES;
};
