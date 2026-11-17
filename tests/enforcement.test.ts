import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyToolAction, authorize, AUTONOMOUS_RULES, CHILD_DENIED, childRulesFor } from '../src/main/permission';
import { runCmd } from '../src/main/verifyExec';
import { uniqueDownloadPath } from '../src/main/fsTools';
import { shellVerdict } from '../src/main/policy';

/**
 * CODE-ENFORCEMENT PROOFS for the master hardening round:
 *   1. The verification-command runner is INSIDE the policy boundary (the old execFile bypass).
 *   2. Downloads can never overwrite (the page-driven write outside every gate).
 *   3. The deletion tooth at the authorization gate is LIVE for every agent — main included —
 *      independent of the risk assessors (the old child backstop was unreachable dead code).
 *   4. The child-agent rules still carry exactly one extra deny (deletion), same policy otherwise.
 */

let dir = '';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enforce-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe('verification commands run inside the policy boundary', () => {
  it('executes an ordinary command and returns exit + output', async () => {
    const out = await runCmd('echo hello-verify', dir, 30_000);
    expect(out).toMatch(/^exit 0/);
    expect(out).toContain('hello-verify');
  });

  it('refuses a deletion command BEFORE any process starts', async () => {
    const sentinel = path.join(dir, 'sentinel.txt');
    await fs.writeFile(sentinel, 'must survive');
    const out = await runCmd(`rm "${sentinel}"`, dir, 30_000);
    expect(out).toMatch(/^BLOCKED:/);
    expect(await fs.readFile(sentinel, 'utf8')).toBe('must survive');
  });

  it('refuses an OS-protected write target', async () => {
    const target = process.platform === 'win32' ? 'C:\\Windows\\evil.txt' : '/etc/evil.txt';
    const out = await runCmd(`echo x > "${target}"`, dir, 30_000);
    expect(out).toMatch(/^BLOCKED:/);
  });

  it('refuses OS configuration (services, shutdown) through the verifier too', async () => {
    const out = await runCmd('shutdown /r /t 0', dir, 30_000);
    expect(out).toMatch(/^BLOCKED:/);
  });
});

describe('downloads can never overwrite (page-driven writes are code-confined)', () => {
  it('returns the plain path when nothing exists', async () => {
    const p = await uniqueDownloadPath(dir, 'report.pdf');
    expect(p).toBe(path.join(dir, 'report.pdf'));
  });

  it('uniquifies instead of overwriting an existing file', async () => {
    await fs.writeFile(path.join(dir, 'report.pdf'), 'original');
    const p1 = await uniqueDownloadPath(dir, 'report.pdf');
    expect(p1).toBe(path.join(dir, 'report (1).pdf'));
    await fs.writeFile(p1, 'second');
    const p2 = await uniqueDownloadPath(dir, 'report.pdf');
    expect(p2).toBe(path.join(dir, 'report (2).pdf'));
    expect(await fs.readFile(path.join(dir, 'report.pdf'), 'utf8')).toBe('original');
  });

  it('confines hostile names to a bare filename inside the directory', async () => {
    const p = await uniqueDownloadPath(dir, '..\\..\\evil.txt');
    expect(path.dirname(p)).toBe(path.resolve(dir)); // stays inside the downloads dir — traversal flattened
    expect(path.basename(p)).not.toMatch(/[/\\]/); // a bare name, separators gone
    const p2 = await uniqueDownloadPath(dir, '../../evil.txt');
    expect(path.dirname(p2)).toBe(path.resolve(dir));
  });

  it('falls back to a safe name for empty or hostile-only suggestions', async () => {
    const p = await uniqueDownloadPath(dir, '???');
    expect(path.dirname(p)).toBe(path.resolve(dir));
    expect(path.basename(p)).not.toBe('???');
  });
});

describe('the deletion tooth at the gate is LIVE and agent-independent', () => {
  const q = (over: { tool?: string; action?: Parameters<typeof authorize>[0]['action']; resource?: string; risk?: null; agent?: string }) => ({
    tool: over.tool ?? 'delete_file',
    action: over.action ?? ('delete' as const),
    resource: over.resource ?? 'path:*',
    risk: over.risk ?? null,
    agent: over.agent,
  });

  it('classifyToolAction flags a future destructive tool by NAME even with no risk assessed', () => {
    expect(classifyToolAction('delete_record', { id: '7' }).action).toBe('delete');
    expect(classifyToolAction('wipe_disk', {}).action).toBe('delete');
    expect(classifyToolAction('purge_cache', {}).action).toBe('delete');
    // Ordinary tools are untouched by the tripwire:
    expect(classifyToolAction('remove_app', { name: 'spotify' }).action).not.toBe('delete'); // JARVIS's own launcher config
    expect(classifyToolAction('write_file', { path: 'notes/a.txt' }).action).toBe('write');
  });

  it('classifyToolAction flags an apply_patch Delete op independent of assessRisk', () => {
    const r = classifyToolAction('apply_patch', { patch: '*** Begin Patch\n*** Delete File: notes/a.txt\n*** End Patch' });
    expect(r.action).toBe('delete');
    const safe = classifyToolAction('apply_patch', { patch: '*** Begin Patch\n*** Update File: notes/a.txt\n@@\n' });
    expect(safe.action).toBe('write');
  });

  it('authorize DENIES a delete-classified call for the MAIN agent even when the risk assessor saw nothing', async () => {
    // This is the regression proof: before this round, action 'delete' could only arise
    // FROM a risk block (already denied in step 1), so this tooth could never fire.
    const d = await authorize(q({ agent: 'main' }));
    expect(d.allowed).toBe(false);
    expect(d.auth).toBe('blocked');
  });

  it('authorize DENIES a delete-classified call for CHILD agents even when the risk assessor saw nothing', async () => {
    const d = await authorize(q({ agent: 'task:research#2' }));
    expect(d.allowed).toBe(false);
    expect(d.auth).toBe('rule-denied');
  });

  it('allowed consequential work still runs autonomously for every agent', async () => {
    for (const agent of ['main', 'task:general#1']) {
      const pay = await authorize({ tool: 'browser_click', action: 'purchase', resource: 'web:checkout.stripe.com', risk: null, agent });
      expect(pay.allowed).toBe(true);
      const send = await authorize({ tool: 'run_command', action: 'execute', resource: 'shell:npm run build', risk: null, agent });
      expect(send.allowed).toBe(true);
    }
  });

  it('child rules stay: one allow-all policy plus ONLY the deletion deny', () => {
    expect(childRulesFor('autonomous', 'task:x#1')).toEqual([...AUTONOMOUS_RULES, ...CHILD_DENIED]);
    expect(CHILD_DENIED).toHaveLength(1);
    expect(CHILD_DENIED[0]).toMatchObject({ action: 'delete', effect: 'deny' });
  });
});

describe('the shell classifier still refuses indirect destruction (regression guard)', () => {
  it('node one-liners and git history destruction are deletion', () => {
    expect(shellVerdict('node -e "require(\'fs\').unlinkSync(\'x\')"').blocked).toBe(true);
    expect(shellVerdict('git push --force origin main').blocked).toBe(true);
    expect(shellVerdict('Remove-Item C:\\Users\\me\\file.txt').blocked).toBe(true);
  });

  it('ordinary development commands stay allowed', () => {
    expect(shellVerdict('npm test').blocked).toBe(false);
    expect(shellVerdict('npm uninstall left-pad').blocked).toBe(false); // dependency management is allowed
    expect(shellVerdict('git commit -m "wip"').blocked).toBe(false);
  });
});
