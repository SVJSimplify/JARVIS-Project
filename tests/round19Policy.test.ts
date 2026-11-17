import { describe, expect, it, vi } from 'vitest';

/**
 * ROUND 19 CHANGE 8 — TWO-RESTRICTION POLICY AUDIT ACROSS EXECUTION PATHS.
 *
 * Pins the central classifier's completeness: every side-effect-capable tool in the ONE
 * registry classifies as a non-read action at the ONE gate, so every such call gets a
 * durable receipt and the correct action class. Also pins the deletion tripwire for
 * future tools and the child-agent floor.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import { classifyToolAction, authorize } from '../src/main/permission';
import { toolRegistry } from '../src/main/tools';
import { toolIdempotencyClass } from '../src/main/toolRecord';

describe('CHANGE 8.1 — every side-effect tool classifies non-read at the central classifier', () => {
  const MUST_BE_NON_READ: Array<[string, Record<string, unknown>, string]> = [
    ['make_document', { path: 'reports/q3.docx', format: 'docx' }, 'write'],
    ['remember', { fact: 'likes tea' }, 'config'],
    ['save_contact', { name: 'Asha' }, 'config'],
    ['add_recurring_task', { task: 'weekly report', schedule: 'Fridays' }, 'config'],
    ['project_save', { name: 'jarvis-core' }, 'config'],
    ['forget', { text: 'old note' }, 'config'],
    ['write_file', { path: 'a.txt', content: 'x' }, 'write'],
    ['edit_file', { path: 'a.txt', old_text: 'a', new_text: 'b' }, 'write'],
    ['apply_patch', { patch: '*** Update File: a.txt\n@@\n-a\n+b\n' }, 'write'],
    ['move_file', { from: 'a.txt', to: 'b.txt' }, 'write'],
    ['run_command', { command: 'npm test' }, 'execute'],
    ['run_python', { code: 'print(1)' }, 'execute'],
  ];

  it.each(MUST_BE_NON_READ)('%s classifies as %s (never read)', (tool, args, action) => {
    const c = classifyToolAction(tool, args);
    expect(c.action).toBe(action);
  });

  it('every tool in the live registry that writes under a documented name classifies non-read', () => {
    const registry = toolRegistry();
    const writeShaped = ['make_document', 'remember', 'save_contact', 'add_recurring_task', 'project_save', 'forget'];
    for (const name of writeShaped) {
      expect(registry[name], `${name} must exist in the registry`).toBeTruthy();
      const c = classifyToolAction(name, {});
      expect(c.action, `${name} must not be classified read`).not.toBe('read');
    }
  });

  it('a future tool whose NAME declares destruction classifies as delete (tripwire)', () => {
    for (const name of ['delete_backups', 'purge_cache', 'wipe_partition', 'destroy_session']) {
      expect(classifyToolAction(name, {}).action).toBe('delete');
    }
  });
});

describe('CHANGE 8.2 — the two hard restrictions at the ONE gate', () => {
  it('delete-classified calls are denied for the main agent AND child agents, with no approval path', async () => {
    for (const agent of ['main', 'task:general#1']) {
      const r = await authorize({ tool: 'delete_backups', action: 'delete', resource: 'tool:delete_backups', risk: null, agent });
      expect(r.allowed).toBe(false);
      expect(['blocked', 'rule-denied']).toContain(r.auth);
    }
  });

  it('a blocked risk denies regardless of shape or agent', async () => {
    const r = await authorize({ tool: 'run_command', action: 'execute', resource: 'shell:rm x', risk: { title: 'Deleting is disabled on this laptop.', detail: '', block: true }, agent: 'main' });
    expect(r.allowed).toBe(false);
    expect(r.auth).toBe('blocked');
  });

  it('everything else runs autonomously for children and main alike (no permission modes)', async () => {
    for (const agent of ['main', 'task:general#1']) {
      const r = await authorize({ tool: 'run_command', action: 'execute', resource: 'shell:npm test', risk: null, agent });
      expect(r.allowed).toBe(true);
    }
  });
});

describe('CHANGE 8.3 — receipts cover the newly classified side effects', () => {
  it('the idempotency classification covers the newly classified tools (fail closed)', () => {
    expect(toolIdempotencyClass('make_document')).toBe('non-idempotent');
    expect(toolIdempotencyClass('remember')).toBe('non-idempotent');
    expect(toolIdempotencyClass('project_save')).toBe('non-idempotent');
  });
});
