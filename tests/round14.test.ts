import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect, vi } from 'vitest';
import { electronStub } from './helpers/electronStub';

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());
vi.mock('../src/main/hud', () => ({ attentionHud: vi.fn(), sendToHud: vi.fn(), focusHud: vi.fn(), setMini: vi.fn() }));

import { toolRegistry } from '../src/main/tools';
import { startTask } from '../src/main/coordinator';
import { ACTIVE_STATUSES } from '../src/main/taskStore';

/**
 * ROUND 14 REGRESSION GUARDS — the release must contain exactly what the report claims.
 *
 *  - ONE authoritative task engine (the durable coordinator); no mission engine, no
 *    unreachable mission tools, no stale mission IPC/types.
 *  - NO approval infrastructure: no confirmation components, no confirmation IPC, no
 *    approval-era options on the coordinator API.
 *  - TRUTHFUL verdict vocabulary: the approval-era `needs_user` verdict is renamed to
 *    `blocked`; genuine clarification (WAITING_FOR_INPUT) is preserved.
 *  - The renderer IPC type surface and the preload allowlist never drift apart.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Recursively list .ts/.tsx files under a directory (node_modules excluded). */
function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) tsFiles(full, acc);
    else if (/\.(tsx?|mjs)$/.test(name)) acc.push(full);
  }
  return acc;
}

const sourceOf = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

/** Pull the push-channel union out of a preload/d.ts file: the quoted literals of the
 *  `on: (channel: ... )` push allowlist (anchored so other `channel:` mentions never leak in). */
function channelUnion(text: string): string[] {
  const m = text.match(/on:\s*\(\s*channel:([\s\S]*?)func:/);
  if (!m) return [];
  return [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]).sort();
}

describe('round 14 — one authoritative task engine', () => {
  it('the live tool registry has no mission tools', () => {
    const names = Object.keys(toolRegistry());
    expect(names.filter((n) => n.startsWith('mission'))).toEqual([]);
  });

  it('the durable task tools are registered and reachable', () => {
    const names = Object.keys(toolRegistry());
    for (const t of ['start_task', 'task_status', 'task_cancel', 'task_resume', 'list_tasks']) {
      expect(names, `missing ${t}`).toContain(t);
    }
  });

  it('no mission engine file or mission IPC/type remains anywhere', () => {
    for (const gone of [
      'src/main/mission.ts',
      'src/main/notify.ts',
      'tests/mission.test.ts',
      'src/renderer/components/MissionStrip.tsx',
      'src/renderer/components/ActivityPanel.tsx',
    ]) {
      expect(existsSync(path.join(ROOT, gone)), `${gone} must not exist`).toBe(false);
    }
    const forbidden = [/mission-progress/, /missionIntentNote/, /mission_start/, /mission_status/, /mission_rollback/, /recordMissionEnd/];
    for (const f of tsFiles(path.join(ROOT, 'src')).concat(tsFiles(path.join(ROOT, 'types')))) {
      const text = readFileSync(f, 'utf8');
      for (const re of forbidden) {
        expect(re.test(text), `${path.relative(ROOT, f)} matches stale token ${re}`).toBe(false);
      }
    }
  });

  it('renderer IPC type surface matches the preload allowlist exactly', () => {
    expect(channelUnion(sourceOf('types/electron.d.ts'))).toEqual(channelUnion(sourceOf('src/preload/index.ts')));
  });
});

describe('round 14 — no approval infrastructure', () => {
  it('no confirmation component or confirmation lib exists', () => {
    for (const gone of ['src/renderer/components/ConfirmCard.tsx', 'src/renderer/lib/confirm.ts']) {
      expect(existsSync(path.join(ROOT, gone)), `${gone} must not exist`).toBe(false);
    }
  });

  it('startTask takes only (request, deps) — no approval-era option survives', () => {
    expect(startTask.length).toBe(2);
    for (const f of tsFiles(path.join(ROOT, 'src'))) {
      expect(/confirmHighRisk/.test(readFileSync(f, 'utf8')), `${f} mentions confirmHighRisk`).toBe(false);
    }
  });

  it('push channels contain no confirm-request channel', () => {
    const channels = channelUnion(sourceOf('src/preload/index.ts'));
    expect(channels.some((c) => c.includes('confirm'))).toBe(false);
  });
});

describe('round 14 — truthful verdict vocabulary', () => {
  it('the approval-era needs_user verdict name is gone from the source', () => {
    for (const f of tsFiles(path.join(ROOT, 'src'))) {
      expect(/needs_user/.test(readFileSync(f, 'utf8')), `${f} still uses needs_user`).toBe(false);
    }
  });

  it('no "Needs your approval" wording exists anywhere in the source', () => {
    for (const f of tsFiles(path.join(ROOT, 'src'))) {
      expect(/needs your approval/i.test(readFileSync(f, 'utf8')), `${f} carries approval wording`).toBe(false);
    }
  });

  it('genuine clarification is preserved: WAITING_FOR_INPUT is an active task state', () => {
    expect(ACTIVE_STATUSES).toContain('WAITING_FOR_INPUT');
  });
});
