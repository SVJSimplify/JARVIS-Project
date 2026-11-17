import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

/**
 * ROUND 26, PHASE 1 — PROJECT INTELLIGENCE & CONTEXT ENGINE.
 *
 * The profile is built from ACTUAL files (detected facts vs inferred claims), persists
 * across restarts, refreshes INCREMENTALLY (only stale sections re-inspected; an unchanged
 * workspace rewrites nothing), detects staleness, and serves TASK-RELEVANT context only.
 */

import {
  inspectProjectProfile,
  refreshProjectProfile,
  loadProjectProfile,
  staleSections,
  relevantProfileContext,
  profilePathFor,
  PROFILE_SECTIONS,
} from '../src/main/projectProfile';

const ROOT = process.env.JARVIS_FILES_ROOT ?? path.join(os.tmpdir(), `jarvis-r26p1-${process.pid}`);
const PROJ = (): string => path.join(ROOT, 'sample-app');

const mkProject = (): string => {
  const p = PROJ();
  fs.rmSync(p, { recursive: true, force: true });
  fs.mkdirSync(path.join(p, 'src', 'components'), { recursive: true });
  fs.mkdirSync(path.join(p, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(p, 'prisma'), { recursive: true });
  fs.writeFileSync(
    path.join(p, 'package.json'),
    JSON.stringify({
      name: 'sample-app',
      version: '2.1.0',
      description: 'A sample web app',
      scripts: { build: 'vite build', test: 'vitest run', typecheck: 'tsc --noEmit', dev: 'vite' },
      dependencies: { react: '^18.2.0', 'react-dom': '^18.2.0', 'better-sqlite3': '^9.0.0', stripe: '^14.0.0' },
      devDependencies: { vite: '^5.0.0', vitest: '^1.0.0', typescript: '^5.0.0' },
    })
  );
  fs.writeFileSync(path.join(p, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(p, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));
  fs.writeFileSync(path.join(p, 'vite.config.ts'), 'export default {}');
  fs.writeFileSync(path.join(p, 'src', 'index.tsx'), 'import React from "react";');
  fs.writeFileSync(path.join(p, 'src', 'components', 'Button.tsx'), 'export const Button = () => null;');
  fs.writeFileSync(path.join(p, 'tests', 'app.test.ts'), 'it("works", () => {});');
  fs.writeFileSync(path.join(p, 'prisma', 'schema.prisma'), 'datasource db { provider = "sqlite" }');
  fs.writeFileSync(path.join(p, 'README.md'), '# Sample App\n\nA demo.');
  fs.writeFileSync(path.join(p, '.env.example'), 'STRIPE_API_KEY=\nDATABASE_URL=\nPORT=3000\n');
  return p;
};

const sectionOf = (profile: Awaited<ReturnType<typeof inspectProjectProfile>>, id: string) =>
  profile.sections.find((s) => s.id === id);

beforeEach(() => {
  fs.rmSync(path.join(ROOT, 'brain'), { recursive: true, force: true });
  mkProject();
});

afterEach(() => {
  fs.rmSync(PROJ(), { recursive: true, force: true });
});

describe('Phase 1 — workspace understanding (facts are grounded, not guessed)', () => {
  it('detects identity, package manager and build/test commands from real files', async () => {
    const profile = await inspectProjectProfile(PROJ());
    expect(profile.name).toBe('sample-app');
    const identity = sectionOf(profile, 'identity')!;
    expect(identity.facts.some((f) => f.value.includes('sample-app'))).toBe(true);
    const stack = sectionOf(profile, 'stack')!;
    expect(stack.facts.some((f) => f.value.includes('npm') && f.source === 'package-lock.json')).toBe(true);
    const build = sectionOf(profile, 'build')!;
    expect(build.facts.some((f) => f.value.includes('vite build'))).toBe(true);
    const tests = sectionOf(profile, 'tests')!;
    expect(tests.facts.some((f) => f.value.includes('vitest run'))).toBe(true);
    expect(tests.facts.some((f) => f.value.includes('tests/'))).toBe(true);
  });

  it('marks dependency-based framework claims INFERRED and config-file evidence DETECTED', async () => {
    const profile = await inspectProjectProfile(PROJ());
    const stack = sectionOf(profile, 'stack')!;
    // react exists only as a dependency → inferred, never silent fact
    const react = stack.facts.find((f) => f.value.startsWith('framework (inferred from dependency): React'));
    expect(react?.confidence).toBe('inferred');
    expect(react?.source).toBe('package.json#react');
    // vite.config.ts is direct file evidence → detected
    const vite = stack.facts.find((f) => f.value.includes('Vite build tooling'));
    expect(vite?.confidence).toBe('detected');
    expect(vite?.source).toBe('vite.config.ts');
  });

  it('detects the data layer from schema files (and never from thin air)', async () => {
    const profile = await inspectProjectProfile(PROJ());
    const db = sectionOf(profile, 'database')!;
    expect(db.facts.some((f) => f.value.includes('Prisma') && f.source === 'prisma/schema.prisma')).toBe(true);
    expect(db.facts.some((f) => f.value.includes('sqlite'))).toBe(true);
  });

  it('records .env.example key NAMES only — values never enter the profile', async () => {
    const profile = await inspectProjectProfile(PROJ());
    const text = JSON.stringify(profile);
    expect(text).toContain('STRIPE_API_KEY');
    expect(text).not.toContain('sk_live');
    const integrations = sectionOf(profile, 'integrations')!;
    expect(integrations.facts.some((f) => f.value.includes('key names only'))).toBe(true);
  });

  it('reports nothing detected for absent layers (honest empty, not invented)', async () => {
    const p = PROJ();
    fs.rmSync(path.join(p, 'prisma'), { recursive: true, force: true });
    const profile = await inspectProjectProfile(p);
    const db = sectionOf(profile, 'database')!;
    expect(db.facts.some((f) => f.value.includes('Prisma'))).toBe(false);
  });
});

describe('Phase 1 — persistence & incremental updates', () => {
  it('the profile survives a restart (fresh load from disk)', async () => {
    await refreshProjectProfile(PROJ());
    const restored = await loadProjectProfile(PROJ());
    expect(restored).not.toBeNull();
    expect(restored!.name).toBe('sample-app');
    expect(restored!.sections.length).toBe(PROFILE_SECTIONS.length);
    expect(fs.existsSync(profilePathFor(PROJ()))).toBe(true);
  });

  it('an unchanged workspace refreshes NOTHING and rewrites nothing (no needless rescan)', async () => {
    const first = await refreshProjectProfile(PROJ());
    const file = profilePathFor(PROJ());
    const before = fs.statSync(file).mtimeMs;
    const second = await refreshProjectProfile(PROJ());
    expect(second.refreshed).toEqual([]);
    expect(second.profile.version).toBe(first.profile.version);
    expect(second.profile.inspectedAt).toBe(first.profile.inspectedAt);
    expect(fs.statSync(file).mtimeMs).toBe(before); // store untouched
  });

  it('a changed file marks exactly its section stale; refresh updates only that section', async () => {
    const first = await refreshProjectProfile(PROJ());
    expect(first.refreshed.length).toBe(PROFILE_SECTIONS.length);
    // change only the build tooling
    await new Promise((r) => setTimeout(r, 15));
    fs.writeFileSync(path.join(PROJ(), 'vite.config.ts'), 'export default { server: { port: 5173 } };');
    const stale = await staleSections(first.profile);
    expect(stale).toContain('stack');
    expect(stale).not.toContain('tests');
    const second = await refreshProjectProfile(PROJ());
    // both the stack AND config sections watch vite.config.ts — only watched sections refresh
    expect(second.refreshed).toEqual(expect.arrayContaining(['stack', 'config']));
    expect(second.refreshed).not.toContain('tests');
    expect(second.refreshed).not.toContain('identity');
    expect(second.profile.version).toBe(first.profile.version + 1);
    const before = sectionOf(first.profile, 'tests')!.updatedAt;
    expect(sectionOf(second.profile, 'tests')!.updatedAt).toBe(before); // untouched section kept verbatim
    expect(sectionOf(second.profile, 'stack')!.facts.some((f) => f.value.includes('5173') || f.source === 'vite.config.ts')).toBe(true);
  });
});

describe('Phase 1 — task-aware context (1.4)', () => {
  it('returns only the relevant sections, bounded, with inferred facts labeled', async () => {
    const { profile } = await refreshProjectProfile(PROJ());
    const ctx = relevantProfileContext(profile, 'Fix the stripe integration and re-run the tests');
    expect(ctx).toContain('PROJECT CONTEXT');
    expect(ctx.toLowerCase()).toContain('tests');
    expect(ctx).toContain('(inferred)');
    expect(ctx.length).toBeLessThanOrEqual(2600);
  });

  it('returns empty for a request unrelated to anything in the profile (no context bloat)', async () => {
    const { profile } = await refreshProjectProfile(PROJ());
    expect(relevantProfileContext(profile, 'zzz qqq xyzzy')).toBe('');
  });
});
