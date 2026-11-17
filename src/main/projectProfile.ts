import { promises as fs } from 'fs';
import * as path from 'path';
import type { Dirent } from 'fs';
import { loadJson, atomicWrite } from './store';
import { FILES_ROOT } from './workspace';
import type { Tool } from './toolTypes';
import { emitActivity } from './modes';

/**
 * PROJECT INTELLIGENCE (Round 26, Phase 1) — a persistent, structured understanding of the
 * active workspace, built from ACTUAL project files, not from model guesses.
 *
 * Rules enforced here:
 *  - Facts are grounded: every fact names the file it came from, and says whether it was
 *    DETECTED (direct file evidence: a config file, a schema, a script) or INFERRED (a
 *    weaker signal: a dependency in package.json, a filename convention). A technology is
 *    never claimed as fact merely because a dependency exists.
 *  - The profile is incremental: every section carries a fingerprint of the files it
 *    watches, so a refresh re-inspects ONLY what changed — ordinary tasks never trigger a
 *    full-project rescan.
 *  - The profile is a contextual aid: the CURRENT filesystem stays authoritative. Stale
 *    sections are detectable and are refreshed on demand, never silently trusted forever.
 *  - Secrets never enter the profile: .env is never read; .env.example contributes key
 *    NAMES only.
 */

export type FactConfidence = 'detected' | 'inferred';

export interface ProfileFact {
  value: string;
  /** The concrete evidence behind the fact (file path, script name, directory). */
  source: string;
  confidence: FactConfidence;
}

export interface ProfileSection {
  id: SectionId;
  title: string;
  facts: ProfileFact[];
  updatedAt: number;
  /** Digest of the watched files (paths + mtimes + sizes) — the staleness signal. */
  fingerprint: string;
}

export type SectionId =
  | 'identity'
  | 'stack'
  | 'structure'
  | 'build'
  | 'tests'
  | 'config'
  | 'database'
  | 'api'
  | 'integrations'
  | 'conventions'
  | 'architecture'
  | 'git';

export const PROFILE_SECTIONS: Array<{ id: SectionId; title: string }> = [
  { id: 'identity', title: 'Project identity' },
  { id: 'stack', title: 'Technology stack' },
  { id: 'structure', title: 'Structure & entry points' },
  { id: 'build', title: 'Build & tooling' },
  { id: 'tests', title: 'Tests' },
  { id: 'config', title: 'Configuration' },
  { id: 'database', title: 'Data layer' },
  { id: 'api', title: 'API surface' },
  { id: 'integrations', title: 'External integrations' },
  { id: 'conventions', title: 'Development conventions' },
  { id: 'architecture', title: 'Architecture' },
  { id: 'git', title: 'Git state' },
];

export interface ProjectProfile {
  /** Absolute workspace root this profile describes. */
  root: string;
  name: string;
  /** Bumped every time a refresh changes at least one section. */
  version: number;
  sections: ProfileSection[];
  inspectedAt: number;
  durationMs: number;
}

// ------------------------------------------------------------------ fingerprinting

/** FNV-1a over a string — a stable, dependency-free section fingerprint. */
const digest = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
};

interface WatchFile {
  rel: string;
  mtime: number;
  size: number;
}

const fingerprintOf = (files: WatchFile[]): string =>
  digest(files.map((f) => `${f.rel}:${f.mtime}:${f.size}`).sort().join('|'));

// ------------------------------------------------------------------- fs inspection

const EXISTS_CANDIDATES = (rel: string): string[] => [rel, `${rel}.ts`, `${rel}.tsx`, `${rel}.js`, `${rel}.jsx`, `${rel}.mjs`, `${rel}.cjs`, `${rel}.py`, `${rel}.go`];

const ENTRY_CANDIDATES = [
  'src/main/index.ts', 'src/main.ts', 'src/index.ts', 'src/index.tsx', 'src/main.tsx', 'src/index.js',
  'src/app/page.tsx', 'src/App.tsx', 'app/page.tsx', 'main.ts', 'main.tsx', 'index.ts', 'index.js',
  'main.go', 'app.py', 'server.py', 'manage.py', 'src/main.rs', 'Program.cs', 'src/main/java',
];

const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript (React)', '.js': 'JavaScript', '.jsx': 'JavaScript (React)',
  '.mjs': 'JavaScript (ESM)', '.cjs': 'JavaScript (CJS)', '.py': 'Python', '.go': 'Go', '.rs': 'Rust',
  '.java': 'Java', '.kt': 'Kotlin', '.cs': 'C#', '.rb': 'Ruby', '.php': 'PHP', '.dart': 'Dart', '.vue': 'Vue',
};

const FRAMEWORK_BY_DEP: Record<string, string> = {
  react: 'React', 'react-dom': 'React', next: 'Next.js', vue: 'Vue', nuxt: 'Nuxt', svelte: 'Svelte',
  '@sveltejs/kit': 'SvelteKit', '@angular/core': 'Angular', express: 'Express', fastify: 'Fastify',
  '@nestjs/core': 'NestJS', electron: 'Electron', vite: 'Vite', webpack: 'Webpack', esbuild: 'esbuild',
  '@playwright/test': 'Playwright', jest: 'Jest', vitest: 'Vitest', mocha: 'Mocha', cypress: 'Cypress',
  '@vue/test-utils': 'Vue Test Utils', tailwindcss: 'Tailwind CSS', 'styled-components': 'styled-components',
  prisma: 'Prisma', '@prisma/client': 'Prisma', drizzle: 'Drizzle ORM', knex: 'Knex', sequelize: 'Sequelize',
  typeorm: 'TypeORM', mongoose: 'Mongoose', 'django': 'Django', 'flask': 'Flask', 'fastapi': 'FastAPI',
  'gin-gonic/gin': 'Gin', 'gorilla/mux': 'Gorilla Mux', actix: 'Actix', rocket: 'Rocket',
};

const INTEGRATION_BY_DEP: Record<string, string> = {
  stripe: 'Stripe', '@stripe/stripe-js': 'Stripe', '@aws-sdk/client-s3': 'AWS S3', 'aws-sdk': 'AWS SDK',
  boto3: 'AWS (boto3)', firebase: 'Firebase', '@firebase/app': 'Firebase', '@supabase/supabase-js': 'Supabase',
  '@sentry/node': 'Sentry', '@sentry/react': 'Sentry', twilio: 'Twilio', '@sendgrid/mail': 'SendGrid',
  nodemailer: 'SMTP mail (nodemailer)', openai: 'OpenAI API', '@anthropic-ai/sdk': 'Anthropic API',
  'googleapis': 'Google APIs', 'google-auth-library': 'Google Auth', passport: 'Passport auth',
  'oauth2orize': 'OAuth2 server', jsonwebtoken: 'JWT auth', keycloak: 'Keycloak', octokit: 'GitHub API (Octokit)',
  '@octokit/rest': 'GitHub API (Octokit)', 'slack-sdk': 'Slack', '@slack/web-api': 'Slack Web API',
};

const DEP_BY_DB: Record<string, string> = {
  prisma: 'Prisma ORM', '@prisma/client': 'Prisma ORM', sequelize: 'Sequelize ORM', typeorm: 'TypeORM',
  knex: 'Knex query builder', mongoose: 'MongoDB (Mongoose)', mongodb: 'MongoDB', redis: 'Redis',
  ioredis: 'Redis', pg: 'PostgreSQL (node-postgres)', mysql2: 'MySQL', sqlite3: 'SQLite', better: 'SQLite (better-sqlite3)',
  sqlalchemy: 'SQLAlchemy', 'alembic': 'Alembic migrations', psycopg2: 'PostgreSQL (psycopg2)', pymongo: 'MongoDB (PyMongo)',
};

const CONFIG_FILES = [
  'tsconfig.json', 'tsconfig.node.json', 'tsconfig.app.json', 'jsconfig.json', 'vite.config.ts', 'vite.config.js',
  'tailwind.config.js', 'tailwind.config.cjs', 'postcss.config.js', 'postcss.config.cjs', 'next.config.js',
  'nuxt.config.ts', 'angular.json', 'svelte.config.js', 'webpack.config.js', 'babel.config.js', '.babelrc',
  'vitest.config.ts', 'jest.config.js', 'playwright.config.ts', 'cypress.config.js', '.env.example',
  'docker-compose.yml', 'docker-compose.yaml', 'Dockerfile', '.editorconfig', 'eslint.config.js', '.eslintrc.json',
  '.eslintrc.cjs', '.prettierrc', 'prettier.config.js', 'pyproject.toml', 'alembic.ini', 'drizzle.config.ts',
  'knexfile.js', 'ormconfig.json', 'Makefile', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle',
];

const TEST_DIRS = ['tests', 'test', '__tests__', 'e2e', 'spec'];
const TEST_CONFIG_HINT = /(vitest|jest|playwright|cypress|karma|pytest|test)/i;

/** Bounded file walk: depth ≤ 2, ≤ maxEntries entries, symlink-safe, never descends into node_modules/.git/dist. */
async function boundedScan(root: string, maxEntries = 600): Promise<{ files: WatchFile[]; dirs: Set<string> }> {
  const files: WatchFile[] = [];
  const dirs = new Set<string>();
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'target', 'venv', '.venv', '__pycache__', '.cache', 'release']);
  let budget = maxEntries;
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (budget <= 0 || depth > 2) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (budget <= 0) break;
      const erel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
        dirs.add(erel);
        budget--;
        await walk(path.join(dir, e.name), erel, depth + 1);
      } else if (e.isFile()) {
        budget--;
        const relLower = erel.toLowerCase();
        const interesting =
          depth === 0 ||
          CONFIG_FILES.some((c) => c.toLowerCase() === relLower) ||
          ENTRY_CANDIDATES.includes(erel) ||
          /\.(ts|tsx|js|jsx|py|go|rs|java|kt|cs|rb|php|dart|vue|json|toml|ya?ml|sql|prisma|graphql|gradle|csproj|md|txt|mod|lock|example|env)$/.test(e.name) ||
          relLower.endsWith('.csproj') ||
          relLower === 'gemfile';
        if (!interesting) continue;
        try {
          const st = await fs.stat(path.join(dir, e.name));
          files.push({ rel: erel, mtime: st.mtimeMs, size: st.size });
        } catch {
          /* vanished mid-scan: not a fact */
        }
      }
    }
  };
  await walk(root, '', 0);
  return { files, dirs };
}

const firstExisting = async (root: string, rels: string[]): Promise<string | null> => {
  for (const rel of rels) {
    try {
      const st = await fs.stat(path.join(root, rel));
      if (st.isFile()) return rel;
    } catch {
      /* try next */
    }
  }
  return null;
};

const readText = async (root: string, rel: string, limit = 64 * 1024): Promise<string | null> => {
  try {
    const buf = await fs.readFile(path.join(root, rel));
    return buf.subarray(0, limit).toString('utf8');
  } catch {
    return null;
  }
};

// -------------------------------------------------------------- section inspectors

type SectionResult = { facts: ProfileFact[]; watched: WatchFile[] };

const fact = (value: string, source: string, confidence: FactConfidence = 'detected'): ProfileFact => ({ value, source, confidence });

async function inspectIdentity(root: string, scan: { files: WatchFile[] }): Promise<SectionResult> {
  const facts: ProfileFact[] = [];
  const watched: WatchFile[] = [];
  const pkgRel = await firstExisting(root, ['package.json']);
  if (pkgRel) {
    const pkg = await readText(root, pkgRel);
    watched.push(...scan.files.filter((f) => f.rel === pkgRel));
    try {
      const p = JSON.parse(pkg ?? '{}') as { name?: string; version?: string; description?: string };
      facts.push(fact(`project name: ${p.name ?? '(unnamed)'}`, pkgRel));
      if (p.version) facts.push(fact(`version: ${p.version}`, pkgRel));
      if (p.description) facts.push(fact(`description: ${String(p.description).slice(0, 140)}`, pkgRel));
    } catch {
      facts.push(fact('package.json present but unparseable', pkgRel));
    }
  }
  for (const marker of [
    ['go.mod', 'Go module'], ['Cargo.toml', 'Rust crate'], ['pom.xml', 'Maven (Java) project'],
    ['build.gradle', 'Gradle (Java) project'], ['requirements.txt', 'Python project (requirements.txt)'],
    ['pyproject.toml', 'Python project (pyproject.toml)'], ['composer.json', 'PHP (Composer) project'],
    ['Gemfile', 'Ruby (Bundler) project'], ['pubspec.yaml', 'Flutter/Dart project'],
  ] as const) {
    const rel = await firstExisting(root, [marker[0]]);
    if (rel) {
      facts.push(fact(marker[1], rel));
      watched.push(...scan.files.filter((f) => f.rel === rel));
    }
  }
  for (const cs of scan.files.filter((f) => f.rel.endsWith('.csproj')).slice(0, 3)) {
    facts.push(fact('.NET project', cs.rel));
    watched.push(cs);
  }
  const readme = await firstExisting(root, ['README.md', 'readme.md', 'README.txt', 'README']);
  if (readme) {
    watched.push(...scan.files.filter((f) => f.rel === readme));
    const text = await readText(root, readme, 4000);
    const line = (text ?? '').split('\n').find((l) => l.trim().length > 3);
    if (line) facts.push(fact(`README headline: ${line.replace(/^#+\s*/, '').slice(0, 120)}`, readme));
  }
  return { facts, watched };
}

async function inspectStack(root: string, scan: { files: WatchFile[]; dirs: Set<string> }): Promise<SectionResult> {
  const facts: ProfileFact[] = [];
  const watched: WatchFile[] = [];
  const extCount = new Map<string, number>();
  for (const f of scan.files) {
    const ext = path.extname(f.rel).toLowerCase();
    if (LANG_BY_EXT[ext]) extCount.set(ext, (extCount.get(ext) ?? 0) + 1);
  }
  const langs = [...extCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [ext, n] of langs) facts.push(fact(`language: ${LANG_BY_EXT[ext]} (${n} source file(s) indexed)`, `*${ext} files`, 'detected'));

  const pkgRel = await firstExisting(root, ['package.json']);
  let deps: Record<string, string> = {};
  if (pkgRel) {
    watched.push(...scan.files.filter((f) => f.rel === pkgRel));
    try {
      const p = JSON.parse((await readText(root, pkgRel)) ?? '{}') as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      deps = { ...(p.dependencies ?? {}), ...(p.devDependencies ?? {}) };
    } catch { /* unparseable was reported by identity */ }
  }
  // Framework claims from dependencies are INFERRED — a dependency alone is not proof of use.
  for (const [dep, name] of Object.entries(FRAMEWORK_BY_DEP)) {
    if (deps[dep] !== undefined) facts.push(fact(`framework (inferred from dependency): ${name} ${deps[dep]}`, `package.json#${dep}`, 'inferred'));
  }
  // Config-file evidence is DETECTED — the project carries the framework's own config.
  const configEvidence: Array<[string, string, string]> = [
    ['vite.config.ts', 'vite.config.js', 'Vite build tooling'],
    ['next.config.js', 'next.config.mjs', 'Next.js application config'],
    ['nuxt.config.ts', 'nuxt.config.ts', 'Nuxt application config'],
    ['tailwind.config.js', 'tailwind.config.cjs', 'Tailwind CSS config'],
    ['angular.json', 'angular.json', 'Angular workspace config'],
    ['svelte.config.js', 'svelte.config.js', 'Svelte config'],
  ];
  for (const [a, b, label] of configEvidence) {
    const rel = await firstExisting(root, [a, b]);
    if (rel) {
      facts.push(fact(label, rel));
      watched.push(...scan.files.filter((f) => f.rel === rel));
    }
  }
  if (scan.dirs.has('src/main') && scan.dirs.has('src/renderer') && deps['electron'] !== undefined) {
    facts.push(fact('Electron main/renderer split (src/main + src/renderer)', 'src/main, src/renderer'));
  }
  const pm = await firstExisting(root, ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb']);
  if (pm) {
    const name = pm === 'package-lock.json' ? 'npm' : pm === 'yarn.lock' ? 'Yarn' : pm === 'pnpm-lock.yaml' ? 'pnpm' : 'Bun';
    facts.push(fact(`package manager: ${name}`, pm));
    watched.push(...scan.files.filter((f) => f.rel === pm));
  }
  for (const marker of [['go.mod', 'Go modules'], ['Cargo.toml', 'Cargo'], ['requirements.txt', 'pip'], ['pyproject.toml', 'pyproject (pip/poetry)'], ['pom.xml', 'Maven'], ['build.gradle', 'Gradle']] as const) {
    if (scan.files.some((f) => f.rel === marker[0])) facts.push(fact(`dependency manager: ${marker[1]}`, marker[0]));
  }
  return { facts, watched };
}

async function inspectStructure(root: string, scan: { files: WatchFile[]; dirs: Set<string> }): Promise<SectionResult> {
  const facts: ProfileFact[] = [];
  const watched: WatchFile[] = [];
  const topDirs = [...scan.dirs].filter((d) => !d.includes('/')).slice(0, 14);
  if (topDirs.length) facts.push(fact(`top-level directories: ${topDirs.join(', ')}`, 'workspace root'));
  const entries = scan.dirs.has('src') || scan.dirs.has('app') ? 'src/app' : topDirs[0] ?? '';
  if (entries) facts.push(fact(`primary source directory: ${entries.split('/')[0]}`, 'directory layout'));
  for (const cand of ENTRY_CANDIDATES) {
    const rel = await firstExisting(root, EXISTS_CANDIDATES(cand).slice(0, 9));
    if (rel) {
      facts.push(fact(`entry point: ${rel}`, rel));
      watched.push(...scan.files.filter((f) => f.rel === rel));
      if (facts.filter((f) => f.value.startsWith('entry point')).length >= 3) break;
    }
  }
  return { facts, watched };
}

async function inspectBuild(root: string, scan: { files: WatchFile[]; dirs: Set<string> }): Promise<SectionResult> {
  const facts: ProfileFact[] = [];
  const watched: WatchFile[] = [];
  const pkgRel = await firstExisting(root, ['package.json']);
  if (pkgRel) {
    try {
      const p = JSON.parse((await readText(root, pkgRel)) ?? '{}') as { scripts?: Record<string, string> };
      const interesting = ['build', 'dev', 'start', 'test', 'typecheck', 'lint'];
      for (const k of interesting) {
        if (typeof p.scripts?.[k] === 'string') {
          facts.push(fact(`npm script ${k}: ${String(p.scripts[k]).slice(0, 100)}`, `${pkgRel}#scripts.${k}`));
        }
      }
      watched.push(...scan.files.filter((f) => f.rel === pkgRel));
    } catch { /* reported elsewhere */ }
  }
  for (const marker of [['Makefile', 'Make'], ['justfile', 'just'], ['Dockerfile', 'Docker image build']] as const) {
    const rel = await firstExisting(root, [marker[0]]);
    if (rel) facts.push(fact(`${marker[1]} build defined`, rel));
  }
  const ci = await firstExisting(root, ['.github/workflows']);
  if (!ci) {
    try {
      const st = await fs.stat(path.join(root, '.github/workflows'));
      if (st.isDirectory()) facts.push(fact('GitHub Actions CI workflows present', '.github/workflows'));
    } catch { /* none */ }
  }
  return { facts, watched };
}

async function inspectTests(root: string, scan: { files: WatchFile[]; dirs: Set<string> }): Promise<SectionResult> {
  const facts: ProfileFact[] = [];
  const watched: WatchFile[] = [];
  for (const d of TEST_DIRS) {
    if (scan.dirs.has(d)) {
      facts.push(fact(`test directory: ${d}/`, d));
      break;
    }
  }
  for (const f of scan.files) {
    if (TEST_CONFIG_HINT.test(path.basename(f.rel)) && /config|rc|json/i.test(f.rel) && !f.rel.includes('node_modules')) {
      facts.push(fact(`test config: ${f.rel}`, f.rel));
      watched.push(f);
      if (facts.length > 4) break;
    }
  }
  const pkgRel = await firstExisting(root, ['package.json']);
  if (pkgRel) {
    try {
      const p = JSON.parse((await readText(root, pkgRel)) ?? '{}') as { scripts?: Record<string, string> };
      if (typeof p.scripts?.test === 'string' && p.scripts.test !== 'echo \\"Error: no test specified\\" && exit 1') {
        facts.push(fact(`test command: npm test → ${String(p.scripts.test).slice(0, 80)}`, `${pkgRel}#scripts.test`));
      }
    } catch { /* ignore */ }
  }
  for (const marker of [['pyproject.toml', '[tool.pytest']]) {
    const text = await readText(root, marker[0], 16 * 1024);
    if (text?.includes(marker[1])) facts.push(fact('pytest configured via pyproject.toml', marker[0]));
  }
  return { facts, watched };
}

async function inspectConfig(root: string, scan: { files: WatchFile[]; dirs: Set<string> }): Promise<SectionResult> {
  const facts: ProfileFact[] = [];
  const watched: WatchFile[] = [];
  for (const f of scan.files) {
    const base = path.basename(f.rel).toLowerCase();
    if (CONFIG_FILES.some((c) => c.toLowerCase() === f.rel.toLowerCase()) || /^config\//.test(f.rel)) {
      facts.push(fact(`config file: ${f.rel}${f.size ? ` (${f.size}B)` : ''}`, f.rel));
      watched.push(f);
      if (facts.length >= 12) break;
    } else if (base === '.env.example') {
      // Key NAMES only — values are never read into the profile.
      const text = await readText(root, f.rel, 16 * 1024);
      const keys = (text ?? '').split('\n').map((l) => l.split('=')[0]?.trim() ?? '').filter((k) => /^[A-Z_][A-Z0-9_]*$/i.test(k)).slice(0, 12);
      facts.push(fact(`environment template keys: ${keys.join(', ') || '(none listed)'}`, '.env.example (names only)'));
      watched.push(f);
    }
  }
  return { facts, watched };
}

async function inspectDatabase(root: string, scan: { files: WatchFile[]; dirs: Set<string> }): Promise<SectionResult> {
  const facts: ProfileFact[] = [];
  const watched: WatchFile[] = [];
  const schema = await firstExisting(root, ['prisma/schema.prisma', 'schema.prisma']);
  if (schema) {
    facts.push(fact('database schema: Prisma', schema));
    watched.push(...scan.files.filter((f) => f.rel === schema));
    const text = await readText(root, schema, 32 * 1024);
    const providers = [...(text ?? '').matchAll(/provider\s*=\s*"([^"]+)"/g)].map((m) => m[1] ?? '').filter(Boolean);
    if (providers.length) facts.push(fact(`datasource provider(s): ${[...new Set(providers)].join(', ')}`, schema));
  }
  for (const rel of ['alembic.ini', 'drizzle.config.ts', 'knexfile.js', 'ormconfig.json']) {
    if (scan.files.some((f) => f.rel === rel)) facts.push(fact('migration/ORM config present', rel));
  }
  if (scan.dirs.has('migrations')) facts.push(fact('migrations directory present', 'migrations/'));
  for (const f of scan.files.slice(0, 400)) {
    if (f.rel.endsWith('.sql')) {
      facts.push(fact('SQL files present', f.rel));
      break;
    }
  }
  const pkgRel = await firstExisting(root, ['package.json']);
  if (pkgRel) {
    try {
      const p = JSON.parse((await readText(root, pkgRel)) ?? '{}') as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const deps = { ...(p.dependencies ?? {}), ...(p.devDependencies ?? {}) };
      for (const [dep, label] of Object.entries(DEP_BY_DB)) {
        if (deps[dep] !== undefined) facts.push(fact(`${label} (inferred from dependency)`, `package.json#${dep}`, 'inferred'));
      }
    } catch { /* ignore */ }
  }
  const compose = await firstExisting(root, ['docker-compose.yml', 'docker-compose.yaml']);
  if (compose) {
    const text = (await readText(root, compose, 32 * 1024)) ?? '';
    const services = [...text.matchAll(/^\s{2}([a-z0-9_-]+):/gim)].map((m) => m[1] ?? '').filter((s) => /postgres|mysql|mongo|redis|sqlite|mariadb|mssql/.test(s));
    if (services.length) facts.push(fact(`docker-compose data service(s): ${[...new Set(services)].join(', ')}`, compose));
    watched.push(...scan.files.filter((f) => f.rel === compose));
  }
  return { facts, watched };
}

async function inspectApi(root: string, scan: { files: WatchFile[]; dirs: Set<string> }): Promise<SectionResult> {
  const facts: ProfileFact[] = [];
  const watched: WatchFile[] = [];
  if (scan.dirs.has('pages/api') || [...scan.dirs].some((d) => d.startsWith('pages/api'))) facts.push(fact('API routes: Next.js pages/api', 'pages/api/'));
  if ([...scan.dirs].some((d) => d.startsWith('app/api') || d === 'src/app/api')) facts.push(fact('API routes: app router route handlers', 'app/api/'));
  if (scan.dirs.has('server') || scan.dirs.has('routes')) facts.push(fact('server-side routes directory', 'server/ or routes/'));
  for (const f of scan.files) {
    const base = path.basename(f.rel).toLowerCase();
    if (/^(openapi|swagger).*\.?(json|ya?ml|yaml)$/.test(base) || f.rel.endsWith('.graphql') || f.rel.endsWith('.gql')) {
      facts.push(fact('API specification file', f.rel));
      watched.push(f);
      break;
    }
  }
  const pkgRel = await firstExisting(root, ['package.json']);
  if (pkgRel) {
    try {
      const p = JSON.parse((await readText(root, pkgRel)) ?? '{}') as { dependencies?: Record<string, string> };
      if (p.dependencies?.['@trpc/server']) facts.push(fact('tRPC API layer (dependency)', 'package.json#@trpc/server', 'inferred'));
      if (p.dependencies?.['graphql']) facts.push(fact('GraphQL (dependency)', 'package.json#graphql', 'inferred'));
    } catch { /* ignore */ }
  }
  return { facts, watched };
}

async function inspectIntegrations(root: string, scan: { files: WatchFile[]; dirs: Set<string> }): Promise<SectionResult> {
  const facts: ProfileFact[] = [];
  const watched: WatchFile[] = [];
  const pkgRel = await firstExisting(root, ['package.json']);
  if (pkgRel) {
    try {
      const p = JSON.parse((await readText(root, pkgRel)) ?? '{}') as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const deps = { ...(p.dependencies ?? {}), ...(p.devDependencies ?? {}) };
      for (const [dep, label] of Object.entries(INTEGRATION_BY_DEP)) {
        if (deps[dep] !== undefined) facts.push(fact(`${label} (inferred from dependency)`, `package.json#${dep}`, 'inferred'));
      }
    } catch { /* ignore */ }
  }
  for (const req of ['requirements.txt']) {
    const text = await readText(root, req, 32 * 1024);
    if (!text) continue;
    for (const [pkg, label] of Object.entries(INTEGRATION_BY_DEP)) {
      if (new RegExp(`^${pkg.replace(/[@/]/g, '[@/]')}\\b`, 'im').test(text)) facts.push(fact(`${label} (inferred from dependency)`, req, 'inferred'));
    }
  }
  const envEx = await firstExisting(root, ['.env.example']);
  if (envEx) {
    const text = await readText(root, envEx, 16 * 1024) ?? '';
    const keys = text.split('\n').map((l) => l.split('=')[0]?.trim() ?? '').filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k));
    const notable = keys.filter((k) => /KEY|TOKEN|SECRET|WEBHOOK|URL|ENDPOINT|API/.test(k)).slice(0, 8);
    if (notable.length) facts.push(fact(`external service endpoints hinted (key names only): ${notable.join(', ')}`, '.env.example (names only)'));
    watched.push(...scan.files.filter((f) => f.rel === envEx));
  }
  return { facts, watched };
}

async function inspectConventions(root: string, scan: { files: WatchFile[]; dirs: Set<string> }): Promise<SectionResult> {
  const facts: ProfileFact[] = [];
  const watched: WatchFile[] = [];
  for (const [rel, label] of [
    ['.editorconfig', 'EditorConfig formatting rules'], ['eslint.config.js', 'ESLint (flat config)'],
    ['.eslintrc.json', 'ESLint'], ['.eslintrc.cjs', 'ESLint'], ['.prettierrc', 'Prettier formatting'],
    ['prettier.config.js', 'Prettier formatting'], ['.prettierrc.cjs', 'Prettier formatting'],
    ['commitlint.config.js', 'Conventional Commits (commitlint)'], ['CONTRIBUTING.md', 'Contribution guide'],
  ] as const) {
    const hit = await firstExisting(root, [rel]);
    if (hit) {
      facts.push(fact(label, rel));
      watched.push(...scan.files.filter((f) => f.rel === rel));
    }
  }
  const tsRel = await firstExisting(root, ['tsconfig.json']);
  if (tsRel) {
    try {
      const p = JSON.parse((await readText(root, tsRel, 16 * 1024).then((t) => t?.replace(/^\s*\/\/.*$/gm, '') ?? '{}')) ?? '{}') as { compilerOptions?: { strict?: boolean; noUncheckedIndexedAccess?: boolean } };
      if (p.compilerOptions?.strict) facts.push(fact('TypeScript strict mode', tsRel));
      if (p.compilerOptions?.noUncheckedIndexedAccess) facts.push(fact('TypeScript noUncheckedIndexedAccess', tsRel));
      watched.push(...scan.files.filter((f) => f.rel === tsRel));
    } catch { /* ignore */ }
  }
  const husky = await firstExisting(root, ['.husky']);
  if (!husky) {
    try {
      if ((await fs.stat(path.join(root, '.husky'))).isDirectory()) facts.push(fact('git hooks via husky', '.husky/'));
    } catch { /* none */ }
  }
  if (scan.dirs.has('docs')) facts.push(fact('documentation directory', 'docs/'));
  return { facts, watched };
}

/**
 * ROUND 31 (§2.2) — ARCHITECTURE UNDERSTANDING: how the application is put together,
 * detected from REAL evidence (routing files, state-management dependencies, styling
 * setup, backend directories, module weights). Never hardcoded to one stack: every
 * claim names the file or dependency it came from, and dependency-derived claims stay
 * 'inferred' — a dependency alone is not proof of use.
 */
async function inspectArchitecture(root: string, scan: { files: WatchFile[]; dirs: Set<string> }): Promise<SectionResult> {
  const facts: ProfileFact[] = [];
  const watched: WatchFile[] = [];
  const pkgRel = await firstExisting(root, ['package.json']);
  let deps: Record<string, string> = {};
  if (pkgRel) {
    try {
      const p = JSON.parse((await readText(root, pkgRel)) ?? '{}') as { dependencies?: Record<string, string> };
      deps = { ...(p.dependencies ?? {}) };
    } catch { /* reported elsewhere */ }
  }
  // Routing: framework-specific conventions and router dependencies.
  const routingEvidence: Array<[RegExp, string]> = [
    [/^src\/pages\//, 'file-based routing under src/pages/'],
    [/^(src\/)?app\/.*\/page\.(tsx|jsx)$/, 'Next.js app-router pages'],
    [/^(src\/)?pages\//, 'file-based routing under pages/'],
  ];
  for (const [re, label] of routingEvidence) {
    const hit = scan.files.find((f) => re.test(f.rel));
    if (hit) {
      facts.push(fact(`routing: ${label}`, hit.rel));
      break;
    }
  }
  for (const [dep, label] of Object.entries({ 'react-router-dom': 'React Router', 'react-router': 'React Router', 'next/navigation': 'Next.js built-in routing', '@angular/router': 'Angular Router', 'vue-router': 'Vue Router', svelte: 'Svelte routing' })) {
    if (deps[dep] !== undefined) {
      facts.push(fact(`routing library (inferred from dependency): ${label}`, `package.json#${dep}`, 'inferred'));
      break;
    }
  }
  // State management.
  for (const [dep, label] of Object.entries({ redux: 'Redux', '@reduxjs/toolkit': 'Redux Toolkit', zustand: 'Zustand', mobx: 'MobX', jotai: 'Jotai', recoil: 'Recoil', '@tanstack/react-query': 'TanStack Query (server state)', xstate: 'XState' })) {
    if (deps[dep] !== undefined) facts.push(fact(`state management (inferred from dependency): ${label}`, `package.json#${dep}`, 'inferred'));
  }
  // Styling architecture.
  const stylingEvidence: Array<[string, string]> = [
    ['tailwind.config.js', 'Tailwind CSS styling'], ['tailwind.config.cjs', 'Tailwind CSS styling'],
    ['postcss.config.js', 'PostCSS pipeline'], ['postcss.config.cjs', 'PostCSS pipeline'],
  ];
  for (const [rel, label] of stylingEvidence) {
    const hit = await firstExisting(root, [rel]);
    if (hit) {
      facts.push(fact(`styling: ${label}`, hit));
      watched.push(...scan.files.filter((f) => f.rel === hit));
      break;
    }
  }
  const styleDirs = [...scan.dirs].filter((d) => /styles?|css|scss|sass/i.test(d.split('/').pop() ?? ''));
  if (styleDirs.length) facts.push(fact(`styling directories: ${styleDirs.slice(0, 3).join(', ')}`, 'directory layout'));
  // Backend / server layer.
  if (deps['express'] !== undefined || deps['fastify'] !== undefined || scan.dirs.has('server') || scan.dirs.has('api')) {
    const which = deps['express'] ? 'Express' : deps['fastify'] ? 'Fastify' : 'server directory';
    facts.push(fact(`backend layer present: ${which}`, deps['express'] || deps['fastify'] ? 'package.json' : 'server/'));
  }
  // Module weights: the largest source directories, as a bounded structural signal.
  const weights = new Map<string, number>();
  for (const f of scan.files) {
    if (!/\.(ts|tsx|js|jsx|py|go|rs|java|kt|cs|rb|php|dart|vue)$/.test(f.rel)) continue;
    const top = f.rel.split('/')[0];
    if (top && top !== f.rel) weights.set(top, (weights.get(top) ?? 0) + 1);
  }
  const heavy = [...weights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (heavy.length) facts.push(fact(`major modules by source-file count: ${heavy.map(([d, n]) => `${d} (${n})`).join(', ')}`, 'indexed source files'));
  // Shared components/state conventions for React apps (directory evidence only).
  for (const d of ['components', 'shared', 'lib', 'hooks', 'utils', 'services', 'store', 'stores']) {
    if (scan.dirs.has(`src/${d}`) || scan.dirs.has(d)) {
      facts.push(fact(`shared module directory: ${d}/`, d));
      if (facts.filter((f) => f.value.startsWith('shared module directory')).length >= 3) break;
    }
  }
  return { facts, watched };
}

/**
 * ROUND 31 (§2.1) — GIT STATE: the branch the workspace is on and the last recorded
 * activity, read DIRECTLY from .git (no command execution, no index parsing). The
 * commit MESSAGE is taken from the reflog — author emails and timestamps beyond the
 * last entry are not needed for planning and are not read.
 */
async function inspectGit(root: string, _scan: { files: WatchFile[]; dirs: Set<string> }): Promise<SectionResult> {
  const facts: ProfileFact[] = [];
  const watched: WatchFile[] = [];
  const gitDir = path.join(root, '.git');
  try {
    const head = (await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
    const branch = head.match(/^ref: refs\/heads\/(.+)$/)?.[1];
    if (branch) facts.push(fact(`current branch: ${branch}`, '.git/HEAD'));
    else facts.push(fact(`detached HEAD (${head.slice(0, 12)})`, '.git/HEAD'));
    // .git is never walked by the bounded scan, so the watched-file entry is built by a
    // direct stat — this is what makes a branch switch a STALENESS signal (§2.5).
    try {
      const st = await fs.stat(path.join(gitDir, 'HEAD'));
      watched.push({ rel: '.git/HEAD', mtime: st.mtimeMs, size: st.size });
    } catch { /* vanished between read and stat: fingerprint just stays empty */ }
  } catch {
    return { facts, watched }; // not a git workspace: an honest empty section
  }
  try {
    const merge = await fs.stat(path.join(gitDir, 'MERGE_HEAD'));
    if (merge.isFile()) facts.push(fact('a merge is IN PROGRESS (MERGE_HEAD present)', '.git/MERGE_HEAD'));
  } catch { /* no merge in progress */ }
  try {
    const log = await fs.readFile(path.join(gitDir, 'logs', 'HEAD'), 'utf8');
    const last = log.trim().split('\n').filter(Boolean).pop() ?? '';
    const message = last.split('\t')[1] ?? '';
    const ts = Number(last.split(' ')[4] ?? 0);
    if (message) {
      const when = ts > 0 ? ` (last local commit activity: ${new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ')})` : '';
      const shortMsg = message.length > 90 ? `${message.slice(0, 87)}…` : message;
      facts.push(fact(`latest reflog entry: "${shortMsg}"${when}`, '.git/logs/HEAD'));
    }
  } catch { /* no reflog (fresh clone with commits but no local activity) */ }
  return { facts, watched };
}

const SECTION_INSPECTORS: Record<SectionId, (root: string, scan: { files: WatchFile[]; dirs: Set<string> }) => Promise<SectionResult>> = {
  identity: inspectIdentity,
  stack: inspectStack,
  structure: inspectStructure,
  build: inspectBuild,
  tests: inspectTests,
  config: inspectConfig,
  database: inspectDatabase,
  api: inspectApi,
  integrations: inspectIntegrations,
  conventions: inspectConventions,
  architecture: inspectArchitecture,
  git: inspectGit,
};

// ------------------------------------------------------------------- persistence

const profileFile = (root: string): string => {
  const key = digest(path.resolve(root));
  return path.join(FILES_ROOT, 'brain', 'profiles', `${key}.json`);
};

export const profilePathFor = (root: string): string => profileFile(root);

export async function loadProjectProfile(root: string): Promise<ProjectProfile | null> {
  const p = await loadJson<ProjectProfile | null>(profileFile(root), null);
  return p && Array.isArray(p.sections) ? p : null;
}

const saveProfile = async (profile: ProjectProfile): Promise<void> => {
  const file = profileFile(profile.root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, JSON.stringify(profile, null, 1));
};

// ---------------------------------------------------------------- public operations

/**
 * Inspect the workspace ONCE (full). Prefer `refreshProjectProfile` for updates — it
 * re-inspects only stale sections.
 */
export async function inspectProjectProfile(root: string): Promise<ProjectProfile> {
  const t0 = Date.now();
  const abs = path.resolve(root);
  const scan = await boundedScan(abs);
  const sections: ProfileSection[] = [];
  for (const { id, title } of PROFILE_SECTIONS) {
    const r = await SECTION_INSPECTORS[id](abs, scan);
    sections.push({ id, title, facts: r.facts.slice(0, 24), updatedAt: Date.now(), fingerprint: fingerprintOf(r.watched) });
  }
  const pkg = sections.find((s) => s.id === 'identity')?.facts.find((f) => f.value.startsWith('project name:'));
  const name = pkg ? pkg.value.slice('project name: '.length) : path.basename(abs);
  return { root: abs, name, version: 1, sections, inspectedAt: Date.now(), durationMs: Date.now() - t0 };
}

/** Which watched files of each section changed on disk (the staleness detector). */
export async function staleSections(profile: ProjectProfile): Promise<SectionId[]> {
  const scan = await boundedScan(profile.root);
  const stale: SectionId[] = [];
  for (const section of profile.sections) {
    const r = await SECTION_INSPECTORS[section.id](profile.root, scan);
    if (fingerprintOf(r.watched) !== section.fingerprint) stale.push(section.id);
  }
  return stale;
}

/**
 * INCREMENTAL refresh: re-inspect only the sections whose watched files changed (or that
 * are missing). Unchanged sections keep their facts and updatedAt untouched; the profile
 * version bumps only when something actually changed. Persists atomically.
 */
export async function refreshProjectProfile(root: string, opts: { force?: boolean } = {}): Promise<{ profile: ProjectProfile; refreshed: SectionId[]; stale: SectionId[] }> {
  const abs = path.resolve(root);
  const existing = await loadProjectProfile(abs);
  const t0 = Date.now();
  let changed = false;
  if (!existing || opts.force) {
    const profile = await inspectProjectProfile(abs);
    await saveProfile(profile);
    return { profile, refreshed: PROFILE_SECTIONS.map((s) => s.id), stale: PROFILE_SECTIONS.map((s) => s.id) };
  }
  const scan = await boundedScan(abs);
  const refreshed: SectionId[] = [];
  const stale: SectionId[] = [];
  const sections: ProfileSection[] = [];
  for (const { id, title } of PROFILE_SECTIONS) {
    const prev = existing.sections.find((s) => s.id === id);
    const r = await SECTION_INSPECTORS[id](abs, scan);
    const fp = fingerprintOf(r.watched);
    if (!prev || fp !== prev.fingerprint) {
      stale.push(id);
      refreshed.push(id);
      changed = true;
      sections.push({ id, title, facts: r.facts.slice(0, 24), updatedAt: Date.now(), fingerprint: fp });
    } else {
      sections.push(prev);
    }
  }
  const pkg = sections.find((s) => s.id === 'identity')?.facts.find((f) => f.value.startsWith('project name:'));
  const profile: ProjectProfile = {
    root: abs,
    name: pkg ? pkg.value.slice('project name: '.length) : path.basename(abs),
    version: changed ? existing.version + 1 : existing.version,
    sections,
    inspectedAt: changed ? Date.now() : existing.inspectedAt,
    durationMs: Date.now() - t0,
  };
  // No-write discipline: an unchanged workspace does not rewrite the store.
  if (changed) await saveProfile(profile);
  return { profile, refreshed, stale };
}

// ---------------------------------------------------------- task-aware context (1.4)

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'this', 'that', 'is', 'are', 'be', 'it', 'as', 'at', 'by', 'from', 'into', 'add', 'use', 'using', 'make', 'my', 'our', 'their', 'its', 'please', 'should', 'can', 'you', 'we', 'i']);

const tokenize = (text: string): string[] =>
  text.toLowerCase().match(/[a-z0-9_.@/-]{2,}/g)?.filter((t) => !STOP.has(t)) ?? [];

/**
 * TASK-AWARE PROJECT CONTEXT (1.4): return ONLY the profile sections relevant to the
 * request, ranked by keyword overlap, bounded in size. No relevant sections → '' (agents
 * never receive the whole profile unprompted).
 */
export function relevantProfileContext(profile: ProjectProfile, request: string, maxChars = 2400): string {
  const tokens = tokenize(request);
  if (!tokens.length) return '';
  const scored = profile.sections
    .map((s) => {
      const hay = `${s.title} ${s.facts.map((f) => f.value).join(' ')}`.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (s.facts.some((f) => f.value.toLowerCase().includes(t))) score += 2;
        else if (hay.includes(t)) score += 1;
      }
      return { s, score };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return '';
  const lines: string[] = [`PROJECT CONTEXT (${profile.name}, profile v${profile.version}${staleNote(profile)}):`];
  let budget = maxChars;
  for (const { s } of scored) {
    const block = `- ${s.title}: ${s.facts.slice(0, 6).map((f) => f.value + (f.confidence === 'inferred' ? ' (inferred)' : '')).join('; ')}`;
    if (block.length > budget) break;
    lines.push(block);
    budget -= block.length + 1;
  }
  return lines.join('\n');
}

const staleNote = (profile: ProjectProfile): string => {
  const oldest = Math.min(...profile.sections.map((s) => s.updatedAt));
  return Date.now() - oldest > 7 * 24 * 3600 * 1000 ? ', sections may be stale — verify against disk' : '';
};

// ------------------------------------------------------------------- tool surface

const resolveRoot = (arg: unknown): string => {
  const raw = String(arg ?? '').trim();
  if (!raw) return FILES_ROOT;
  return path.isAbsolute(raw) ? raw : path.join(FILES_ROOT, raw);
};

const renderProfile = (p: ProjectProfile): string =>
  [
    `PROJECT PROFILE — ${p.name} (v${p.version}, inspected ${new Date(p.inspectedAt).toISOString()}, ${p.durationMs}ms)`,
    ...p.sections.map((s) => `- ${s.title}: ${s.facts.length ? s.facts.map((f) => `${f.value} [${f.confidence}]`).join('; ') : '(nothing detected)'}`),
  ].join('\n');

export const profileTools: Record<string, Tool> = {
  inspect_project: {
    description: 'Inspect the current workspace and build/update its persistent project intelligence profile (stack, structure, tests, conventions). Incremental: only changed parts are re-analyzed.',
    parameters: {
      type: 'object',
      properties: { root: { type: 'string', description: 'Optional workspace-relative root to inspect (defaults to the workspace root).' } },
    },
    run: async (args) => {
      const { profile, refreshed } = await refreshProjectProfile(resolveRoot(args.root));
      // R27 §5.1: project CHANGE AWARENESS — a targeted profile update is visible activity,
      // not a silent rewrite (which sections changed is stated in the output either way).
      if (refreshed.length) {
        emitActivity({ kind: 'progress', label: 'Project intelligence updated', detail: `${profile.name}: ${refreshed.length} section(s) changed (${refreshed.join(', ')})`, status: 'ok' });
      }
      return `Profile v${profile.version} for ${profile.name}; sections refreshed this run: ${refreshed.join(', ') || 'none (already current)'}.\n\n${renderProfile(profile)}`;
    },
  },
  project_context: {
    description: 'Retrieve only the project-profile facts relevant to a query (bounded, task-aware). Returns an empty string when nothing in the profile is relevant.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The task or question to find relevant project context for.' } },
      required: ['query'],
    },
    run: async (args) => {
      const profile = await loadProjectProfile(FILES_ROOT);
      if (!profile) return '(no project profile yet — run inspect_project first)';
      return relevantProfileContext(profile, String(args.query ?? '')) || '(no profile sections are relevant to this query)';
    },
  },
};
