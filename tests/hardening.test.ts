import { describe, expect, it } from 'vitest';
import { planGuard, planningTools, resetPlanMode } from '../src/main/planning';
import { parsePatch } from '../src/main/patch';
import { atomicWrite, loadJson } from '../src/main/store';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('plan mode reset', () => {
  it('blocks write tools while planning and is cleared for a new turn', () => {
    resetPlanMode();
    planningTools.plan_enter.run({});
    expect(planGuard('edit_file')).toMatch(/Blocked: plan mode is read-only/);
    expect(planGuard('read')).toBeNull();
    resetPlanMode(); // every new turn starts here: an interrupted turn cannot call plan_exit
    expect(planGuard('edit_file')).toBeNull();
  });
});

describe('patch Add File validation', () => {
  it('rejects a body line without the + prefix instead of silently dropping it', () => {
    const patch = ['*** Begin Patch', '*** Add File: new.txt', '+first line', 'a forgotten prefix', '*** End Patch'].join('\n');
    expect(() => parsePatch(patch)).toThrow(/must start with "\+"/i);
  });

  it('still accepts well-formed add bodies', () => {
    const patch = ['*** Begin Patch', '*** Add File: new.txt', '+one', '+two', '*** End Patch'].join('\n');
    expect(parsePatch(patch)[0]).toMatchObject({ kind: 'add', lines: ['one', 'two'] });
  });
});

describe('atomic json store', () => {
  it('writes and reads back, and falls back cleanly on a damaged file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jstore-'));
    const file = path.join(dir, 'store.json');
    await atomicWrite(file, JSON.stringify({ a: 1 }));
    expect(await loadJson<{ a: number }>(file, { a: 0 })).toEqual({ a: 1 });
    await fs.writeFile(file, '{ torn json', 'utf8');
    expect(await loadJson<{ a: number }>(file, { a: 0 })).toEqual({ a: 0 }); // damaged data must not throw
    expect(await loadJson(file, [])).toEqual([]); // missing file is silent
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('leaves no temp file behind', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jstore-'));
    const file = path.join(dir, 'store.json');
    await atomicWrite(file, 'x');
    const leftovers = (await fs.readdir(dir)).filter((f) => f !== 'store.json');
    expect(leftovers).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
