import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { storageTools } from '../src/main/storageTools';

let root = '';
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

describe('analyze_storage', () => {
  it('returns largest files and recursive directory totals from one read-only traversal', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'jini-storage-test-'));
    await mkdir(path.join(root, 'nested'), { recursive: true });
    await writeFile(path.join(root, 'small.txt'), '1234');
    await writeFile(path.join(root, 'nested', 'large.bin'), Buffer.alloc(128 * 1024, 1));

    const output = await storageTools.analyze_storage.run({ root, limit: 10, max_items: 1000 });
    expect(output).toContain('STORAGE ANALYSIS');
    expect(output).toContain('large.bin');
    expect(output).toContain('nested');
    expect(output).toContain('SCAN COMPLETE');
    expect(output).not.toContain('FAILED:');
  });

  it('fails early for a file path instead of silently returning an empty scan', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'jini-storage-test-'));
    const file = path.join(root, 'not-a-folder.txt');
    await writeFile(file, 'x');
    await expect(storageTools.analyze_storage.run({ root: file })).rejects.toThrow('not a folder');
  });
});
