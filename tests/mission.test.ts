import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  canContinue,
  checkpointEligible,
  classifyIntent,
  doneCount,
  markStep,
  missionStatusText,
  normalizePlan,
  restoreFrom,
  snapshotInto,
  verifyScripts,
  type Mission,
  type MissionStep,
} from '../src/main/mission';

const step = (over: Partial<MissionStep> = {}): MissionStep => ({
  title: 'Step',
  detail: 'd',
  kind: 'implement',
  status: 'pending',
  result: '',
  attempts: 0,
  ...over,
});

const mission = (steps: MissionStep[]): Mission => ({
  id: 7,
  goal: 'copy of the app',
  status: 'running',
  steps,
  note: '',
  report: '',
  checkpointFiles: [],
  checkpointError: '',
  createdAt: 1,
  updatedAt: 1,
});

describe('classifyIntent (code-enforced routing, not a prompt hint)', () => {
  const missions = [
    'Generate a copy of this app',
    'clone this project into a new folder',
    'build me an app that tracks my habits',
    'refactor the whole codebase to typescript',
    'rebuild this website from scratch',
    'migrate the project to vite',
    'create a copy of the dashboard',
    'make a game like pong',
  ];
  it.each(missions)('routes "%s" to a mission', (t) => expect(classifyIntent(t)).toBe('mission'));

  const normal = [
    'copy this file to downloads',
    'move the folder into documents',
    'fix this bug in main.ts',
    'create a note about the meeting',
    'build a report about the market',
    'write a summary of the article',
    'what time is it',
    'open youtube',
    'rename the image',
  ];
  it.each(normal)('keeps "%s" as normal turn work', (t) => expect(classifyIntent(t)).toBe('normal'));

  it('never throws on junk', () => {
    expect(classifyIntent('')).toBe('normal');
    expect(classifyIntent(undefined as unknown as string)).toBe('normal');
  });
});

describe('normalizePlan (a broken plan degrades, never breaks)', () => {
  it('falls back to one full-goal step when the model returns nothing usable', () => {
    const steps = normalizePlan(null, 'clone the app');
    expect(steps).toHaveLength(1);
    expect(steps[0].detail).toBe('clone the app');
    expect(steps[0].kind).toBe('implement');
  });

  it('caps length, drops empty titles and dedupes by title', () => {
    const raw = [
      { title: 'read the source', detail: 'a', kind: 'explore' },
      { title: 'read the source', detail: 'b' }, // duplicate
      { title: '', detail: 'no title' }, // skipped
      { title: 'implement', kind: 'bogus-kind' }, // coerced
      ...Array.from({ length: 20 }, (_, i) => ({ title: `step ${i}` })),
    ];
    const steps = normalizePlan(raw, 'g');
    expect(steps.length).toBeLessThanOrEqual(10);
    expect(steps[0].kind).toBe('explore');
    expect(steps[1].kind).toBe('implement'); // unknown kind coerced
    expect(steps.filter((s) => s.title === 'read the source')).toHaveLength(1);
  });

  it('defaults a missing detail to the title so sub-agents never get an empty instruction', () => {
    const [s] = normalizePlan([{ title: 'do the thing' }], 'g');
    expect(s.detail).toBe('do the thing');
  });
});

describe('mission state machine (failed step stops the mission)', () => {
  it('counts done steps and blocks continuation after a failure', () => {
    const m = mission([step(), step(), step()]);
    markStep(m, 0, { status: 'done', result: 'DONE: file written' });
    markStep(m, 1, { status: 'done', result: 'DONE: built' });
    expect(doneCount(m)).toBe(2);
    expect(canContinue(m)).toBe(true);
    markStep(m, 2, { status: 'failed', result: 'FAILED: no such folder' });
    expect(canContinue(m)).toBe(false);
    expect(doneCount(m)).toBe(2);
  });
});

describe('missionStatusText tells the truth', () => {
  it('shows per-step status, the failure reason and the checkpoint error', () => {
    const m = mission([
      step({ title: 'explore source', status: 'done', result: 'ok' }),
      step({ title: 'write code', status: 'failed', result: 'FAILED: EPERM on D:' }),
    ]);
    m.checkpointError = 'checkpoint incomplete';
    const text = missionStatusText(m);
    expect(text).toContain('#7');
    expect(text).toContain('1/2 steps done');
    expect(text).toContain('FAILED: EPERM on D:');
    expect(text).toContain('checkpoint incomplete');
  });
});

describe('verifyScripts (priority order, existing only)', () => {
  it('picks typecheck, test and build in that order and ignores unknown scripts', () => {
    expect(verifyScripts({ test: 'vitest run', dev: 'vite', build: 'vite build', typecheck: 'tsc' })).toEqual(['typecheck', 'test', 'build']);
    expect(verifyScripts({ dev: 'vite' })).toEqual([]);
  });
});

describe('checkpointEligible (bounded snapshots)', () => {
  it('respects the file-count, per-file and total-size caps', () => {
    expect(checkpointEligible('a.ts', 10, 0, 0)).toBe(true);
    expect(checkpointEligible('a.ts', 10, 99999, 0)).toBe(false);
    expect(checkpointEligible('huge.bin', 5 * 1024 * 1024, 0, 0)).toBe(false);
    expect(checkpointEligible('a.ts', 1024, 1, 60 * 1024 * 1024)).toBe(false);
  });
});

describe('snapshot/restore (real rollback, byte-exact, never deletes)', () => {
  it('snapshots source files, skips junk dirs, restores edited bytes and lists new files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jcp-root-'));
    const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'jcp-dest-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'node_modules', 'x'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'ORIGINAL A', 'utf8');
    await fs.writeFile(path.join(root, 'src', 'b.ts'), 'ORIGINAL B', 'utf8');
    await fs.writeFile(path.join(root, 'node_modules', 'x', 'i.js'), 'junk', 'utf8');

    const cp = await snapshotInto(root, dest);
    expect(cp.error).toBe('');
    expect(cp.files.sort()).toEqual(['src/a.ts', 'src/b.ts']);

    // The mission edits one file and creates a new one.
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'EDITED A', 'utf8');
    await fs.writeFile(path.join(root, 'src', 'new.ts'), 'brand new', 'utf8');

    const report = await restoreFrom(dest, cp.files, root);
    expect(report).toContain('Restored 2/2');
    expect(await fs.readFile(path.join(root, 'src', 'a.ts'), 'utf8')).toBe('ORIGINAL A'); // byte-exact rollback
    expect(await fs.readFile(path.join(root, 'src', 'new.ts'), 'utf8')).toBe('brand new'); // creation kept, never deleted
    expect(report).toContain('new.ts'); // and it is listed honestly
  });

  it('reports an empty workspace honestly instead of failing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jcp-empty-'));
    const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'jcp-emptyd-'));
    const cp = await snapshotInto(root, dest);
    expect(cp.files).toEqual([]);
    expect(cp.error).toContain('no checkpoint');
  });
});
