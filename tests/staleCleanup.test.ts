import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cleanStale, STALE_FILES } from '../scripts/cleanStale.mjs';

/** Regression contract: every file removed in an earlier release round must stay listed,
 *  so an overlay extraction of a newer zip over an older folder self-heals before build. */
describe('stale cleanup (overlay self-heal)', () => {
  it('lists every file removed across previous release rounds', () => {
    for (const rel of [
      'src/main/mission.ts',
      'src/main/notify.ts',
      'src/renderer/components/ConfirmCard.tsx',
      'src/renderer/components/ActivityPanel.tsx',
      'src/renderer/components/MissionStrip.tsx',
      'src/renderer/lib/confirm.ts',
      'tests/mission.test.ts',
      'tests/visualAnswer.test.ts',
    ]) {
      expect(STALE_FILES).toContain(rel);
    }
  });

  it('moves stale files into stale-backup/ preserving relative paths', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-stale-'));
    try {
      for (const rel of STALE_FILES) {
        await fs.mkdir(path.join(root, path.dirname(rel)), { recursive: true });
        await fs.writeFile(path.join(root, rel), '// stale leftover\n');
      }
      const moved = cleanStale(root);
      expect(moved).toHaveLength(STALE_FILES.length);
      for (const rel of STALE_FILES) {
        await expect(fs.access(path.join(root, rel))).rejects.toThrow(); // gone from src/tests
        await fs.access(path.join(root, 'stale-backup', rel)); // preserved under stale-backup
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('never touches live files that are not on the stale list', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-stale-'));
    try {
      const live = ['src/main/completion.ts', 'src/main/index.ts', 'tests/coordinator.test.ts'];
      for (const rel of live) {
        await fs.mkdir(path.join(root, path.dirname(rel)), { recursive: true });
        await fs.writeFile(path.join(root, rel), 'export const live = true;\n');
      }
      expect(cleanStale(root)).toHaveLength(0);
      for (const rel of live) {
        await expect(fs.readFile(path.join(root, rel), 'utf8')).resolves.toBe('export const live = true;\n');
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('is idempotent: a second run finds nothing to move', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-stale-'));
    try {
      await fs.mkdir(path.join(root, 'src/main'), { recursive: true });
      await fs.writeFile(path.join(root, 'src/main/mission.ts'), 'export {};\n');
      expect(cleanStale(root)).toHaveLength(1);
      expect(cleanStale(root)).toHaveLength(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not clobber an existing backup on collision', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-stale-'));
    try {
      const rel = 'src/main/mission.ts';
      await fs.mkdir(path.join(root, 'src/main'), { recursive: true });
      await fs.mkdir(path.join(root, 'stale-backup/src/main'), { recursive: true });
      await fs.writeFile(path.join(root, rel), '// new leftover\n');
      await fs.writeFile(path.join(root, 'stale-backup', rel), '// earlier backup\n');
      const moved = cleanStale(root);
      expect(moved).toHaveLength(1);
      const backup = await fs.readFile(path.join(root, 'stale-backup', rel), 'utf8');
      expect(backup).toBe('// earlier backup\n'); // original backup untouched
      const movedFiles = await fs.readdir(path.join(root, 'stale-backup/src/main'));
      expect(movedFiles.some((f) => f.startsWith('mission.ts.') && f.endsWith('.bak'))).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
