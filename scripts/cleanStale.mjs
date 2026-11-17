#!/usr/bin/env node
/**
 * JARVIS — stale-file cleanup (overlay self-heal).
 *
 * WHY THIS EXISTS
 * Zip archives cannot delete files. If a newer JARVIS release zip is extracted
 * OVER a folder that still holds an older release, files that were REMOVED
 * between releases (mission engine, notify.ts, approval UI, ...) survive the
 * extraction. TypeScript compiles every *.ts under src/main and src/renderer,
 * so those leftovers break the build with errors that look like they come from
 * the new release, e.g.:
 *   src/main/mission.ts(9,10): error TS2305: Module '"./completion"' has no
 *   exported member 'recordMissionEnd'.
 *   src/main/notify.ts(97,78): error TS2353: ... 'missionId' does not exist ...
 *
 * This script runs automatically before dev / build / typecheck (npm pre-hooks)
 * and moves any known-obsolete file into stale-backup/ (preserving its relative
 * path). Nothing is ever deleted — every move is reversible by hand.
 *
 * The list below is the union of files removed across release rounds. Current
 * code imports none of them (verified by tests/staleCleanup.test.ts).
 */

import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Files removed in earlier rounds that break compilation if left behind by an overlay extraction. */
export const STALE_FILES = [
  'src/main/mission.ts',
  'src/main/notify.ts',
  'src/renderer/components/ConfirmCard.tsx',
  'src/renderer/components/ActivityPanel.tsx',
  'src/renderer/components/MissionStrip.tsx',
  'src/renderer/lib/confirm.ts',
  'tests/mission.test.ts',
  'tests/visualAnswer.test.ts',
];

/**
 * Move every known-obsolete file from rootDir into rootDir/stale-backup/,
 * preserving the relative path. Idempotent; never throws; never deletes.
 * @param {string} rootDir Repository root (defaults to the parent of this script's folder).
 * @returns {{ from: string, to: string }[]} what was moved
 */
export function cleanStale(rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const moved = [];
  for (const rel of STALE_FILES) {
    const abs = join(rootDir, rel);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue; // not present — nothing to do
    }
    if (!st.isFile()) continue; // never touch directories or odd entries
    let target = join(rootDir, 'stale-backup', rel);
    try {
      if (existsSync(target)) target = `${target}.${Date.now()}.bak`;
      mkdirSync(dirname(target), { recursive: true });
      renameSync(abs, target);
      moved.push({ from: rel, to: target });
    } catch (err) {
      console.warn(`[cleanStale] WARNING: could not move ${rel} (${err && err.message}).`);
      console.warn(`[cleanStale] WARNING: remove it manually or the build may fail on this leftover file.`);
    }
  }
  return moved;
}

function main() {
  const argRoot = process.argv[2];
  const root = argRoot ? resolve(argRoot) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const moved = cleanStale(root);
  if (moved.length === 0) {
    console.log('[cleanStale] no stale files from previous rounds — tree is clean.');
    return;
  }
  console.log(`[cleanStale] moved ${moved.length} stale file(s) from previous rounds into stale-backup/:`);
  for (const m of moved) console.log(`[cleanStale]   ${m.from} -> ${m.to}`);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) main();
