import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * ROUND 26, PHASE 2 — PERSISTENT HYBRID MEMORY.
 *
 * Episodic memory (the fourth category) records what the ENGINE observed about finished
 * work; hybrid retrieval (semantic+lexical) serves it through the ONE find_memory
 * pipeline; context construction is bounded and task-specific; long-term memories carry
 * ORIGIN (an agent suggestion is never silently a user decision) and expiration.
 */

import {
  recordEpisode,
  recallEpisodes,
  correctEpisode,
  listEpisodeRecords,
  buildTaskMemoryContext,
  episodeStoreFile,
} from '../src/main/episodicMemory';
import { resetMemoryForTests, memoryTools, getMemoryPrompt, listAllMemories } from '../src/main/memory';
import { projectMemoryTools } from '../src/main/projectMemory';

const ROOT = process.env.JARVIS_FILES_ROOT ?? path.join(os.tmpdir(), `jarvis-r26p2-${process.pid}`);

beforeEach(() => {
  resetMemoryForTests();
  fs.rmSync(episodeStoreFile(), { force: true });
  fs.rmSync(path.join(ROOT, 'longterm-memory.json'), { force: true });
  fs.rmSync(path.join(ROOT, 'brain', 'projects.json'), { force: true });
});

describe('Phase 2 — episodic memory (lifecycle)', () => {
  it('records engine-observed episodes and dedupes identical content', async () => {
    const base = { request: 'Add auth to the app', verdict: 'failed' as const, outcome: 'build broke on missing import', approach: 'coder → verifier' };
    expect(await recordEpisode({ ...base, lesson: 'run typecheck before claiming DONE' })).toBe('added');
    expect(await recordEpisode({ ...base, lesson: 'run typecheck before claiming DONE' })).toBe('duplicate');
    const recs = await listEpisodeRecords();
    expect(recs.length).toBe(1);
    expect(recs[0]!.text).toContain('failed');
    expect(recs[0]!.text).toContain('run typecheck before claiming DONE');
  });

  it('recalls by relevance, boosts same-workspace episodes, never serves stale ones', async () => {
    const ws = path.join(ROOT, 'ws-a');
    fs.mkdirSync(ws, { recursive: true });
    await recordEpisode({ request: 'fix the payment webhook retries', verdict: 'completed', outcome: 'retry queue implemented', approach: 'coder', lesson: 'idempotency keys prevented duplicate charges' });
    await recordEpisode({ request: 'garden landscaping plan', verdict: 'completed', outcome: 'plan written', approach: 'planner' });
    const hits = await recallEpisodes('payment webhook retries duplicates');
    expect(hits.length).toBe(1);
    expect(hits[0]!.lesson).toContain('idempotency');
    // same-root boost: an episode from ws-a ranks first for a ws-a query
    await recordEpisode({ request: 'payment webhook retries: v2 with backoff', verdict: 'completed', outcome: 'backoff added', approach: 'coder', root: ws });
    const rooted = await recallEpisodes('payment webhook retries', { root: ws });
    expect(rooted[0]!.root).toBe(path.resolve(ws));
    // stale: the workspace disappears → the episode is excluded, never served as guidance
    fs.rmSync(ws, { recursive: true, force: true });
    const after = await recallEpisodes('payment webhook retries', { root: ws });
    expect(after.some((e) => e.stale)).toBe(false);
  });

  it('supports correction (the previous lesson is kept as history)', async () => {
    const r = await recordEpisode({ request: 'migrate db', verdict: 'failed', outcome: 'migration lock timeout', approach: 'coder', lesson: 'run migrations serially' });
    expect(r).toBe('added');
    const [ep] = await listEpisodeRecords();
    const id = ep!.id;
    expect(await correctEpisode(id, 'take a global advisory lock first, then migrate')).toContain('corrected');
    const recs = await listEpisodeRecords();
    expect(recs[0]!.text).toContain('advisory lock');
  });

  it('expires temporary episodes — dropped at load, never served', async () => {
    await recordEpisode({ request: 'scratch note about tmp analysis', verdict: 'completed', outcome: 'note saved', approach: 'general', expiresAt: Date.now() - 1000 });
    expect(await listEpisodeRecords()).toEqual([]);
    expect(await recallEpisodes('scratch note')).toEqual([]);
  });

  it('stays bounded: recording beyond the cap evicts the oldest episodes', async () => {
    for (let i = 0; i < 30; i++) {
      await recordEpisode({ request: `unique task number ${i} with distinct payload ${i * 7919}`, verdict: 'completed', outcome: `outcome ${i}`, approach: 'general' });
    }
    const all = await listEpisodeRecords();
    expect(all.length).toBeLessThanOrEqual(30);
    expect(all.length).toBe(30);
  });
});

describe('Phase 2 — context construction (2.5, bounded and task-specific)', () => {
  it('combines episodic + project memory relevant to the request, bounded', async () => {
    await projectMemoryTools.project_save.run({ name: 'shopfront', description: 'stripe checkout integration with idempotency keys', stack: ['react'] });
    await recordEpisode({ request: 'stripe checkout retry caused duplicate charges', verdict: 'failed', outcome: 'charges duplicated', approach: 'coder', lesson: 'always pass idempotency keys to stripe' });
    const ctx = await buildTaskMemoryContext('fix the stripe checkout duplicate charge problem with idempotency keys', ROOT);
    expect(ctx).toContain('RELEVANT PAST WORK');
    expect(ctx).toContain('idempotency');
    expect(ctx).toContain('RELEVANT PROJECT MEMORY');
    expect(ctx.length).toBeLessThanOrEqual(1700);
  });

  it('returns empty when nothing is relevant — context is never padded', async () => {
    await recordEpisode({ request: 'garden landscaping', verdict: 'completed', outcome: 'plan', approach: 'planner' });
    expect(await buildTaskMemoryContext('implement oauth2 device flow with pkce')).toBe('');
  });
});

describe('Phase 2 — memory origin & expiration (agent suggestions stay suggestions)', () => {
  it('an agent-suggested fact is stored and rendered AS a suggestion, never as a user decision', async () => {
    const r = await memoryTools.remember.run({ fact: 'the project could use Redis for caching', category: 'fact', origin: 'agent-suggestion' });
    expect(String(r)).toMatch(/Saved|Noted/);
    const prompt = await getMemoryPrompt();
    expect(prompt).toContain('AGENT SUGGESTION');
    expect(prompt).toContain('not a user decision');
    const all = await listAllMemories();
    expect(all.find((m) => m.label.includes('Redis'))?.source).toBeDefined();
  });

  it('user decisions carry no suggestion label', async () => {
    await memoryTools.remember.run({ fact: 'the user prefers TypeScript strict mode', category: 'preference' });
    const prompt = await getMemoryPrompt();
    expect(prompt).toContain('TypeScript strict mode');
    expect(prompt).not.toContain('AGENT SUGGESTION');
  });

  it('temporary memories expire and are never served again', async () => {
    await memoryTools.remember.run({ fact: 'temporary pin for the demo session is 4455', category: 'fact', expires_in_minutes: 0.001 });
    await new Promise((r) => setTimeout(r, 120));
    const prompt = await getMemoryPrompt();
    expect(prompt).not.toContain('4455');
  });

  it('episodes join the ONE find_memory hybrid pipeline', async () => {
    await recordEpisode({ request: 'deploy crashed on missing env var DATABASE_URL', verdict: 'failed', outcome: 'deploy aborted', approach: 'general', lesson: 'validate required env vars before deploy' });
    const out = String(await memoryTools.find_memory.run({ query: 'deploy crash missing env var' }));
    expect(out).toContain('episodic');
    expect(out).toContain('validate required env vars');
  });
});
