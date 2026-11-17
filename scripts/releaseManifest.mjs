#!/usr/bin/env node
/**
 * ROUND 27 (§1.6) — RELEASE MANIFEST AUDIT.
 * Compares the packaged Round 26 baseline with the current working tree and prints the
 * EXACT added / modified / removed files plus module counts. File counts must reconcile
 * with the actual ZIP contents — this script is the source of truth for the report.
 *
 * Usage: node scripts/releaseManifest.mjs <baseline.zip> [projectRoot=current cwd]
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

const [, , baselineZip, rootArg] = process.argv;
if (!baselineZip) {
  console.error('Usage: node scripts/releaseManifest.mjs <baseline.zip> [projectRoot]');
  process.exit(1);
}
const root = path.resolve(rootArg ?? process.cwd());

const tmp = fs.mkdtempSync('/tmp/r27-baseline-');
try {
  execSync(`unzip -q ${JSON.stringify(path.resolve(baselineZip))} -d ${JSON.stringify(tmp)}`, { stdio: 'pipe' });
  // the zip contains a top-level jarvis/ folder (or files at its root — handle both)
  const baseRoot = fs.existsSync(path.join(tmp, 'jarvis')) ? path.join(tmp, 'jarvis') : tmp;

  const SKIP = new Set(['node_modules', '.git', 'release', 'dist', '.jarvis-test', 'coverage']);
  // The release REPORT ships beside the ZIP in every round — it is never part of the
  // packaged tree and never counts toward the reconciliation (R27 §1.6, kept for R28).
  const REPORT_RE = /^JARVIS_ROUND\d+_REPORT\.md$/;
  const EXCLUDE_FILES = new Set(['JARVIS_ROUND27_REPORT.md']);
  const excluded = (f) => EXCLUDE_FILES.has(f) || REPORT_RE.test(f);

  const walk = (dir, base) => {
    const out = new Map();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(base, abs).replace(/\\/g, '/');
      if (e.isDirectory()) {
        for (const [k, v] of walk(abs, base)) out.set(k, v);
      } else if (e.isFile()) {
        const buf = fs.readFileSync(abs);
        out.set(rel, createHash('sha256').update(buf).digest('hex'));
      }
    }
    return out;
  };

  const before = walk(baseRoot, baseRoot);
  const after = walk(root, root);

  const added = [];
  const modified = [];
  const removed = [];
  for (const [f, h] of after) {
    if (excluded(f)) continue;
    if (!before.has(f)) added.push(f);
    else if (before.get(f) !== h) modified.push(f);
  }
  for (const f of before.keys()) {
    if (excluded(f)) continue;
    if (!after.has(f)) removed.push(f);
  }
  added.sort();
  modified.sort();
  removed.sort();

  const srcFiles = [...after.keys()].filter((f) => f.startsWith('src/') && /\.tsx?$/.test(f));
  const testFiles = [...after.keys()].filter((f) => f.startsWith('tests/') && /\.test\.tsx?$/.test(f));

  const n = (arr) => `${arr.length}`;
  console.log('=== RELEASE MANIFEST (Round 26 baseline → Round 27 working tree) ===');
  console.log(`Baseline: ${path.resolve(baselineZip)}`);
  console.log('');
  console.log(`ADDED (${n(added)}):`);
  for (const f of added) console.log(`  + ${f}`);
  console.log('');
  console.log(`MODIFIED (${n(modified)}):`);
  for (const f of modified) console.log(`  ~ ${f}`);
  console.log('');
  console.log(`REMOVED (${n(removed)}):`);
  for (const f of removed) console.log(`  - ${f}`);
  console.log('');
  console.log(`Source modules (src/**/*.{ts,tsx}): ${srcFiles.length}`);
  console.log(`Test modules (tests/**/*.test.{ts,tsx}): ${testFiles.length}`);
  console.log(`Total tracked files: ${after.size}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
