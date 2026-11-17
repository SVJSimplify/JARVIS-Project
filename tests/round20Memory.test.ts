import os from 'os';
import path from 'path';
import fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUND 20 CHANGE 7 — HYBRID MEMORY RELIABILITY.
 *
 * Pins:
 *   - superseded records can no longer swallow a corrected fact ("Already remembered.")
 *     or be overwritten as correction targets;
 *   - polarity flips ("likes tea" → "dislikes tea") supersede as contradictions;
 *   - project_save does not duplicate the same decision text; record ids are stable;
 *   - the openai embedding provider validates vector sanity before pinning dims, and a
 *     later dimension change throws (model compatibility);
 *   - a corpus-load failure is surfaced, never silently empty;
 *   - lexical fallback stays honestly labeled (no semantic claims without a provider).
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import { memoryTools, resetMemoryForTests } from '../src/main/memory';
import { projectMemoryTools, listAllProjectRecords } from '../src/main/projectMemory';
import { relevantMemoryBlock, hybridRetrieve, type RetrievableMemory } from '../src/main/semanticMemory';
import { resetEmbeddingsForTests, getEmbeddingProvider, setEmbeddingsConfig } from '../src/main/embeddings';
import { resetCallContext, setCallContext } from '../src/main/toolRecord';

const ROOT = process.env.JARVIS_FILES_ROOT ?? path.join(os.tmpdir(), `jarvis-test-${process.pid}`);
const uniq = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

beforeEach(() => {
  resetMemoryForTests();
  resetEmbeddingsForTests();
  resetCallContext();
  setCallContext({ agent: 'main' });
  fs.rmSync(path.join(ROOT, 'brain', 'projects.json'), { force: true });
  fs.rmSync(path.join(ROOT, 'longterm-memory.json'), { force: true });
});

describe('CHANGE 7 — corrections and contradictions', () => {
  it('a corrected fact is not swallowed by a superseded record', async () => {
    const remember = memoryTools.remember.run as (a: unknown) => Promise<string>;
    expect(await remember({ fact: 'the project budget is 5000 dollars', category: 'fact' })).toMatch(/Saved/);
    expect(await remember({ fact: 'the project budget is 8000 dollars', category: 'fact' })).toMatch(/Updated/); // supersedes
    // A THIRD value: the old code matched the superseded 5000-record and said "Already remembered.",
    // silently dropping the new value. Now only LIVE records take part in the dedupe.
    expect(await remember({ fact: 'the project budget is 12000 dollars', category: 'fact' })).toMatch(/Updated/);
    const list = (await import('../src/main/memory')).listAllMemories();
    const labels = (await list).map((m) => m.label);
    expect(labels.some((l) => l.includes('12000'))).toBe(true); // the newest value is live
    expect(labels.some((l) => l.includes('8000'))).toBe(false); // the middle value was superseded
    expect(labels.some((l) => l.includes('5000'))).toBe(false);
  });

  it('a polarity flip ("likes tea" → "dislikes tea") supersedes instead of coexisting', async () => {
    const remember = memoryTools.remember.run as (a: unknown) => Promise<string>;
    expect(await remember({ fact: 'The user likes tea in the morning', category: 'preference' })).toMatch(/Saved/);
    const r = await remember({ fact: 'The user dislikes tea in the morning', category: 'preference' });
    expect(r).toMatch(/Updated/);
    const labels = await (await import('../src/main/memory')).listAllMemories();
    expect(labels.some((m) => m.label.includes('dislikes tea'))).toBe(true);
    expect(labels.some((m) => m.label.includes('likes tea') && !m.label.includes('dislikes'))).toBe(false);
  });

  it('unrelated facts never supersede each other (no false polarity flip)', async () => {
    const remember = memoryTools.remember.run as (a: unknown) => Promise<string>;
    expect(await remember({ fact: 'The user works in Bengaluru', category: 'fact' })).toMatch(/Saved/);
    expect(await remember({ fact: 'The user does not work in Chennai', category: 'fact' })).toMatch(/Saved as|Saved/); // different content, kept
    const labels = await (await import('../src/main/memory')).listAllMemories();
    expect(labels.length).toBeGreaterThanOrEqual(2);
  });
});

describe('CHANGE 7 — project memory duplicates, ids and provenance', () => {
  it('re-saving the same decision does not duplicate it; ids are stable across edits', async () => {
    const save = projectMemoryTools.project_save.run as (a: unknown) => Promise<string>;
    await save({ name: 'proj-a', decision: 'Use SQLite for storage' });
    await save({ name: 'proj-a', decision: 'use sqlite for storage' }); // case-insensitive duplicate
    const recs1 = await listAllProjectRecords();
    const decisions1 = recs1.filter((r) => r.text.includes('decision')).map((r) => r.text);
    expect(decisions1.filter((t) => t.toLowerCase().includes('sqlite')).length).toBe(1);
    // Ids are content-addressed: re-saving other fields keeps the decision id stable.
    await save({ name: 'proj-a', progress: 'phase 2 started' });
    const recs2 = await listAllProjectRecords();
    const dec2 = recs2.find((r) => r.id.includes('dec-'));
    const dec1 = recs1.find((r) => r.id.includes('dec-'));
    expect(dec2?.id).toBe(dec1?.id);
  });
});

describe('CHANGE 7 — retrieval honesty and failure surfaces', () => {
  it('a corpus-load failure is reported, never silently treated as "no relevant memories"', async () => {
    const block = await relevantMemoryBlock('anything at all', async () => {
      throw new Error('simulated disk failure');
    });
    expect(block).toMatch(/could not be loaded/);
    expect(block).toMatch(/simulated disk failure/);
  });

  it('without a configured provider the block says LEXICAL and never claims embeddings', async () => {
    const corpus: RetrievableMemory[] = [
      { id: '1', text: 'The deploy script lives in scripts/deploy.sh', scope: 'fact' },
      { id: '2', text: 'The quarterly review is in March', scope: 'fact' },
    ];
    const block = await relevantMemoryBlock('where is the deploy script?', async () => corpus, 5, null);
    expect(block).toMatch(/lexical relevance/);
    expect(block).not.toMatch(/semantic/);
  });

  it('hybridRetrieve labels per-hit sources and never pads below the score floor', async () => {
    const corpus: RetrievableMemory[] = [
      { id: '1', text: 'kubernetes cluster runs on hetzner', scope: 'fact' },
      { id: '2', text: 'grandma recipe for pancakes', scope: 'fact' },
    ];
    const hits = await hybridRetrieve('kubernetes cluster location', corpus, { k: 5 });
    expect(hits[0]?.id).toBe('1');
    expect(hits.some((h) => h.id === '2')).toBe(false); // unrelated entry never padded in
  });
});

describe('CHANGE 7 — embedding provider validation', () => {
  it('the openai provider rejects malformed vectors instead of poisoning dims, and recovers on a good response', async () => {
    // Point the provider at a local HTTP server we control.
    const http = await import('http');
    let mode: 'bad' | 'good' | 'changed-dims' = 'bad';
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        const n = (JSON.parse(body || '{}') as { input: string[] }).input.length;
        if (mode === 'bad') {
          res.end(JSON.stringify({ data: [{ index: 0, embedding: [] }, { index: 1, embedding: [1, 2] }].slice(0, n) }));
        } else if (mode === 'changed-dims') {
          res.end(JSON.stringify({ data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: [0.1, 0.2, 0.3] })) }));
        } else {
          res.end(JSON.stringify({ data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: [0.1, 0.2, 0.3, 0.4] })) }));
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const addr = srv.address() as { port: number };
    await setEmbeddingsConfig({ provider: 'openai', baseUrl: `http://127.0.0.1:${addr.port}`, model: 'test-embed' });
    const provider = await getEmbeddingProvider();
    expect(provider).toBeTruthy();
    // Bad response: throws (lexical fallback), dims stay unpinned...
    await expect(provider!.embed(['a', 'b'])).rejects.toThrow(/malformed vectors/);
    // ...so a subsequent GOOD response still pins dims and works.
    mode = 'good';
    const good = await provider!.embed(['a']);
    expect(good[0].length).toBe(4);
    // A later response with a DIFFERENT dimensionality throws (model compatibility).
    mode = 'changed-dims';
    await expect(provider!.embed(['a'])).rejects.toThrow(/dimension mismatch/);
    srv.close();
  });
});
