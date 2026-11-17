import { describe, expect, it } from 'vitest';
import { retrieve, relevantMemoryBlock, termsOf } from '../src/main/semanticMemory';

/**
 * SEMANTIC MEMORY RETRIEVAL (§10.2) — local relevance ranking for the hybrid memory
 * architecture. Pinned behaviors: stemming folds word forms, relevance ranking puts the
 * records that bear on the query first, unrelated records are NOT retrieved (no padding),
 * and the recency/frequency boosts behave as documented.
 */

const corpus = [
  { id: 'm1', text: 'User prefers concise replies, three sentences at most', scope: 'preference', count: 3, updated: Date.now() - 3600_000 },
  { id: 'm2', text: 'The quarterly pricing spreadsheet lives in reports/pricing.xlsx', scope: 'fact', count: 1, updated: Date.now() - 86_400_000 },
  { id: 'm3', text: 'User wakes at 6 and opens VS Code first thing', scope: 'habit', count: 5, updated: Date.now() - 7 * 86_400_000 },
  { id: 'm4', text: 'Project JARVIS uses Electron with TypeScript main process', scope: 'project:jarvis', count: 2, updated: Date.now() - 86_400_000 * 30 },
  { id: 'm5', text: 'Budget for the home office is ₹80,000', scope: 'fact', count: 1, updated: Date.now() - 86_400_000 * 3 },
];

describe('termsOf — tokenization, stemming, stopwords', () => {
  it('stems plurals and tenses and drops stopwords', () => {
    expect(termsOf('The boxes were delivered yesterday')).toEqual(['box', 'deliver', 'yesterday']);
    expect(termsOf('pricing spreadsheets and budgets')).toContain('spreadsheet');
    expect(termsOf('please reply briefly')).toEqual(['reply', 'briefly']);
  });
});

describe('retrieve — relevance ranking', () => {
  it('ranks the pricing memory first for a pricing-spreadsheet request', () => {
    const hits = retrieve('update the pricing spreadsheet with the new numbers', corpus, 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe('m2');
  });

  it('finds a brevity preference for a reply-style question (word forms differ)', () => {
    const hits = retrieve('how should replies look, short or detailed?', corpus, 3);
    expect(hits[0].id).toBe('m1');
  });

  it('does NOT pad with unrelated records (score floor)', () => {
    const hits = retrieve('quantum chromodynamics lecture notes', corpus, 5);
    expect(hits).toEqual([]);
  });

  it('respects the k limit and orders by score', () => {
    const hits = retrieve('spreadsheet pricing budget', corpus, 2);
    expect(hits.length).toBeLessThanOrEqual(2);
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
  });

  it('a reinforced record outranks an equally relevant rare one', () => {
    const c = [
      { id: 'rare', text: 'deploy checklist lives in docs/deploy.md', scope: 'fact', count: 1, updated: Date.now() },
      { id: 'strong', text: 'deploy checklist lives in docs/deploy.md', scope: 'fact', count: 9, updated: Date.now() },
    ];
    const hits = retrieve('where is the deploy checklist?', c, 2);
    expect(hits[0].id).toBe('strong');
  });

  it('an empty corpus returns nothing and never throws', () => {
    expect(retrieve('anything', [], 5)).toEqual([]);
    expect(retrieve('', corpus, 5)).toEqual([]);
  });
});

describe('relevantMemoryBlock — the prompt contract', () => {
  it('produces a bounded block only when something is relevant', async () => {
    const block = await relevantMemoryBlock('refresh the pricing spreadsheet', async () => corpus, 3);
    expect(block).toContain('MEMORIES RELEVANT TO THIS REQUEST');
    expect(block).toContain('pricing.xlsx');
    expect(block.split('\n').length).toBeLessThanOrEqual(1 + 3);
  });

  it('returns an empty string when nothing matches (never pads the prompt)', async () => {
    const block = await relevantMemoryBlock('thermodynamics homework help', async () => corpus, 3);
    expect(block).toBe('');
  });
});
