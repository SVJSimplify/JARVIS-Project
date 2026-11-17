import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import {
  authorize,
  classifyToolAction,
  childRulesFor,
  currentAutonomy,
  effectiveRules,
  evaluateRules,
  wildcardMatch,
  type PermRule,
  type PermissionQuery,
} from '../src/main/permission';
import { argsPreview, idempotencyKeyFor, recordExecution, recordsForDay, recentExecutions, resetCallContext, setCallContext } from '../src/main/toolRecord';

const q = (over: Partial<PermissionQuery>): PermissionQuery => ({
  tool: 'write_file',
  action: 'write',
  resource: 'path:workspace:C:\\w\\notes.txt',
  risk: null,
  agent: 'main',
  ...over,
});

const rulesFile = (): string => path.join(process.env.JARVIS_FILES_ROOT ?? '/tmp', 'brain', 'permissions.json');

beforeEach(() => {
  resetCallContext();
  fs.rmSync(rulesFile(), { force: true }); // no user rules leak between tests
});

afterEach(() => {
  fs.rmSync(rulesFile(), { force: true });
});

describe('permission rules engine', () => {
  it('wildcard matching anchors the first segment and supports * anywhere', () => {
    expect(wildcardMatch('path:workspace:C:\\w\\a.txt', 'path:workspace:*')).toBe(true);
    expect(wildcardMatch('path:C:\\outside.txt', 'path:workspace:*')).toBe(false);
    expect(wildcardMatch('shell:npm run build', 'shell:*')).toBe(true);
    expect(wildcardMatch('anything', '*')).toBe(true);
    expect(wildcardMatch('proc:explorer', 'proc:explorer')).toBe(true);
  });

  it('the last matching rule wins (OpenCode evaluate semantics)', () => {
    const rules: PermRule[] = [
      { action: 'write', resource: '*', effect: 'deny' },
      { action: 'write', resource: 'path:workspace:*', effect: 'allow' },
    ];
    expect(evaluateRules('write', 'path:workspace:x', rules)?.effect).toBe('allow');
    expect(evaluateRules('write', 'path:C:\\x', rules)?.effect).toBe('deny');
    expect(evaluateRules('read', 'path:workspace:x', rules)).toBeUndefined();
  });

  it('there is exactly one autonomy level and it is autonomous', async () => {
    expect(await currentAutonomy()).toBe('autonomous');
  });
});

describe('action classification', () => {
  it('maps write tools to namespaced path resources, workspace-aware', () => {
    expect(classifyToolAction('write_file', { path: 'notes/a.txt' })).toEqual({ action: 'write', resource: expect.stringContaining('path:workspace:') });
    const outside = classifyToolAction('edit_file', { path: 'C:\\Users\\x\\file.txt' });
    expect(outside.action).toBe('write');
    expect(outside.resource.startsWith('path:C:')).toBe(true);
    expect(classifyToolAction('move_file', { from: 'a', to: 'b' }).resource).toContain('b');
  });

  it('maps execution classes and defaults everything else to read', () => {
    expect(classifyToolAction('run_command', { command: 'npm run build' })).toEqual({ action: 'execute', resource: 'shell:npm run build' });
    expect(classifyToolAction('run_python', { code: 'print(1)' }).resource).toBe('py:print(1)');
    expect(classifyToolAction('stop_process', { name: 'explorer' })).toEqual({ action: 'execute', resource: 'proc:explorer' });
    expect(classifyToolAction('read', { path: 'x' }).action).toBe('read');
    // A deletion attempt is classified as delete regardless of the tool shape.
    expect(classifyToolAction('run_command', { command: 'rm -rf /' }, true).action).toBe('delete');
  });
});

describe('authorize — full autonomy, single mode, no alternate routes', () => {
  it('hard-blocked risks deny ALWAYS — no rule, setting or approval can override', async () => {
    const d = await authorize(q({ action: 'delete', resource: '*', risk: { title: 'Deleting is disabled.', detail: '', block: true } }));
    expect(d.allowed).toBe(false);
    expect(d.auth).toBe('blocked');
  });

  it('safe actions (no risk) keep their prompt-free path', async () => {
    const d = await authorize(q({ tool: 'read', action: 'read', resource: 'read', risk: null }));
    expect(d.allowed).toBe(true);
    expect(d.auth).toBe('allowed');
  });

  it('risky actions run WITHOUT asking — no confirmer exists anywhere in the module', async () => {
    const d = await authorize(q({ tool: 'edit_file', action: 'write', resource: 'path:C:\\Users\\x\\f.txt', risk: { title: 'Modify the file?', detail: '' } }));
    expect(d.allowed).toBe(true);
    expect(d.auth).toBe('autonomous');
  });

  it('risky actions run unattended with nobody present (no ask exists anymore)', async () => {
    const d = await authorize(q({ risk: { title: 'Run?', detail: '' } }));
    expect(d.allowed).toBe(true);
    expect(d.auth).toBe('autonomous');
  });

  it('a leftover brain/permissions.json is IGNORED: ask and deny rules cannot reintroduce prompts or restrictions', async () => {
    // The old alternate route: a hand-written ask rule used to raise a confirmation card.
    // That route is deleted — the file is not even read. Whatever it contains, the single
    // policy decides.
    fs.mkdirSync(path.dirname(rulesFile()), { recursive: true });
    fs.writeFileSync(
      rulesFile(),
      JSON.stringify({
        rules: [
          { action: 'execute', resource: 'shell:curl*', effect: 'deny', note: 'no curl' },
          { action: 'write', resource: 'path:*', effect: 'ask' },
          { action: 'delete', resource: '*', effect: 'allow' },
        ],
      })
    );
    // The ask rule does NOT ask — the risky write just runs.
    const asked = await authorize(q({ resource: 'path:C:\\somewhere\\else.txt', risk: { title: 'Overwrite the file?', detail: '' } }));
    expect(asked.allowed).toBe(true);
    expect(asked.auth).toBe('autonomous');
    // The deny rule does NOT deny — ordinary execution is allowed by policy.
    const curl = await authorize(q({ tool: 'run_command', action: 'execute', resource: 'shell:curl http://x', risk: null }));
    expect(curl.allowed).toBe(true);
    // The allow rule does NOT lift a hard block — deletion stays blocked by the risk layer.
    const del = await authorize(q({ action: 'delete', resource: '*', risk: { block: true, title: 'Deleting is disabled.', detail: '' } }));
    expect(del.allowed).toBe(false);
    expect(del.auth).toBe('blocked');
  });

  it('the decision vocabulary contains no ask outcomes at all', async () => {
    // Every decision authorize can produce for a spread of inputs is allow-shaped or block-shaped.
    const decisions = await Promise.all([
      authorize(q({ risk: null })),
      authorize(q({ risk: { title: 'x', detail: '' } })),
      authorize(q({ agent: 'task:general#1', risk: null })),
      authorize(q({ agent: 'task:general#1', risk: { title: 'x', detail: '' } })),
    ]);
    for (const d of decisions) {
      expect(['allowed', 'autonomous', 'blocked', 'rule-denied']).toContain(d.auth);
      expect(d.allowed).toBe(true); // none of these inputs is a hard block
    }
  });
});

describe('child agents follow the SAME policy as the main agent', () => {
  it('purchase, credentials, configuration and installation run autonomously for children', async () => {
    for (const [tool, action, resource] of [
      ['open_url', 'execute', 'url:shop.example.com'],
      ['clipboard_read', 'credentials', 'credentials:*'],
      ['forget', 'config', 'memory:x'],
      ['run_command', 'install', 'install:npm install left-pad'],
    ] as Array<[string, 'execute' | 'credentials' | 'config' | 'install', string]>) {
      const d = await authorize(q({ tool, action, resource, agent: 'task:general#1', risk: null }));
      expect(d.allowed, `${tool} must run for a child like it does for main`).toBe(true);
      expect(d.auth).toBe('autonomous');
    }
  });

  it('the deletion backstop denies a delete-classified action at the gate — belt behind assessRisk', async () => {
    // Even if a future classifier gap hands the gate a riskless delete action, a child
    // cannot delete. (For the main agent the risk layer is the enforcement point.)
    const d = await authorize(q({ action: 'delete', resource: '*', agent: 'task:explore#1', risk: null }));
    expect(d.allowed).toBe(false);
    expect(d.auth).toBe('rule-denied');
  });

  it('a hard-blocked risk denies children exactly like the main agent', async () => {
    for (const agent of ['main', 'task:general#1', 'task:research#2']) {
      const d = await authorize(q({ action: 'execute', resource: 'shell:rm -rf x', risk: { block: true, title: 'Deleting is disabled.', detail: '' }, agent }));
      expect(d.allowed, `${agent} must not delete either`).toBe(false);
      expect(d.auth).toBe('blocked');
    }
  });

  it('ordinary child work (even risky-looking) runs without a prompt, like the parent', async () => {
    const childWrite = await authorize(q({ agent: 'task:general#1', risk: null }));
    expect(childWrite.allowed).toBe(true);
    expect(childWrite.auth).toBe('autonomous');
    const childRisky = await authorize(q({ agent: 'task:research#2', risk: { title: 'Run a command?', detail: '' } }));
    expect(childRisky.allowed).toBe(true);
    expect(childRisky.auth).toBe('autonomous');
  });

  it('childRulesFor carries the single allow-all policy plus ONLY the deletion backstop', () => {
    const rules = childRulesFor('autonomous', 'task:explore#2');
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({ action: '*', resource: '*', effect: 'allow', note: 'full autonomy' });
    expect(rules[1].action).toBe('delete');
    expect(evaluateRules('delete', 'anything', rules)?.effect).toBe('deny');
    expect(evaluateRules('write', 'path:workspace:x', rules)?.effect).toBe('allow');
    expect(evaluateRules('purchase', 'purchase:x', rules)?.effect).toBe('allow');
    expect(evaluateRules('install', 'install:x', rules)?.effect).toBe('allow');
    expect(evaluateRules('credentials', 'credentials:*', rules)?.effect).toBe('allow');
    expect(evaluateRules('config', 'memory:x', rules)?.effect).toBe('allow');
  });

  it('effectiveRules mirrors the one-policy split for the UI', async () => {
    const main = await effectiveRules('main');
    const child = await effectiveRules('task:explore#1');
    expect(main).toEqual([{ action: '*', resource: '*', effect: 'allow', note: 'full autonomy' }]);
    expect(child).toHaveLength(2);
    expect(child.some((r) => r.effect === 'deny' && r.action === 'delete')).toBe(true);
  });
});

describe('durable tool execution records (Module G)', () => {
  it('records are appended to the daily JSONL and read back with their full shape', async () => {
    setCallContext({ agent: 'task:research#1', taskId: 't-42', stepId: 's-2' });
    const t = Date.now();
    await recordExecution({
      id: 'r1',
      t,
      ms: 12,
      tool: 'web_search',
      agent: 'task:research#1',
      taskId: 't-42',
      stepId: 's-2',
      args: argsPreview({ query: 'the   answer   to everything'.padEnd(400, 'x') }),
      auth: 'allowed',
      status: 'ok',
      result: '42',
      retries: 1,
      idempotencyKey: idempotencyKeyFor('web_search', { query: 'q' }),
    });
    resetCallContext();
    const day = await recordsForDay(t);
    const rec = day.find((r) => r.id === 'r1');
    expect(rec).toBeTruthy();
    expect(rec?.agent).toBe('task:research#1');
    expect(rec?.taskId).toBe('t-42');
    expect(rec?.retries).toBe(1);
    expect(rec?.result).toBe('42');
    // The argument preview is clipped — records are an audit, not a payload store.
    expect((rec?.args ?? '').length).toBeLessThanOrEqual(301);
    expect(recentExecutions(5).some((r) => r.id === 'r1')).toBe(true);
    expect(recentExecutions(5, true).some((r) => r.id === 'r1')).toBe(false);
  });

  it('a torn final line from a crash does not destroy earlier records', async () => {
    const t = Date.now();
    const day = path.join(process.env.JARVIS_FILES_ROOT ?? '/tmp', 'brain', 'toollog', `records-${new Date(t).getFullYear()}-${String(new Date(t).getMonth() + 1).padStart(2, '0')}-${String(new Date(t).getDate()).padStart(2, '0')}.jsonl`);
    fs.mkdirSync(path.dirname(day), { recursive: true });
    const good = JSON.stringify({ id: 'ok1', t, ms: 1, tool: 'read', agent: 'main', args: '', auth: 'allowed', status: 'ok', retries: 0 });
    fs.writeFileSync(day, `${good}\n{"id":"torn","t":`);
    const rows = await recordsForDay(t);
    expect(rows.some((r) => r.id === 'ok1')).toBe(true);
    expect(rows.some((r) => r.id === 'torn')).toBe(false);
  });
});
