import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * ROUND 18 PRIORITY FIVE — GENUINE SEMANTIC MEMORY (§7).
 *
 * Pins the corrected retrieval architecture:
 *   - the lexical retriever is labeled LEXICAL (never sold as semantic — §7.2 honesty);
 *   - hybridRetrieve blends TF-IDF cosine with REAL embedding cosine when a provider is
 *     configured, and retrieves by MEANING (a paraphrase with zero shared stems is
 *     reachable — the exact failure mode of lexical matching);
 *   - with no provider configured, retrieval degrades to lexical, honestly labeled;
 *   - the vector cache embeds each text once;
 *   - corrections SUPERSEDE the old fact (history preserved, prompts show only current);
 *   - the embedding provider abstraction resolves configuration honestly ('none' → null).
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import { hybridRetrieve, relevantMemoryBlock, retrieve, type RetrievableMemory } from '../src/main/semanticMemory';
import { cosine, embedWithCache, getEmbeddingProvider, getEmbeddingsConfig, setEmbeddingsConfig, resetEmbeddingsForTests, type EmbeddingProvider } from '../src/main/embeddings';
import { memoryTools, resetMemoryForTests } from '../src/main/memory';

beforeEach(() => {
  resetMemoryForTests();
  resetEmbeddingsForTests();
});

afterEach(() => {
  resetMemoryForTests();
  resetEmbeddingsForTests();
});

/**
 * A deterministic fake NEURAL embedder: a tiny hand-built semantic space where
 * {database, sql, query} cluster on axis 0, {css, styling} on axis 1, {cooking, recipe}
 * on axis 2. Words outside the space embed near the origin (no signal).
 */
const fakeNeuralProvider = (embedCalls: string[] = []): EmbeddingProvider & { calls: number } => {
  const axis = (word: string): number[] => {
    const w = word.toLowerCase();
    if (['database', 'sql', 'query', 'postgres'].includes(w)) return [1, 0, 0];
    if (['css', 'styling', 'layout'].includes(w)) return [0, 1, 0];
    if (['cooking', 'recipe', 'kitchen'].includes(w)) return [0, 0, 1];
    return [0, 0, 0];
  };
  const embedOne = (text: string): number[] => {
    const v = [0, 0, 0];
    for (const word of text.split(/\W+/)) {
      const a = axis(word);
      if (a.some((x) => x !== 0)) for (let i = 0; i < 3; i++) v[i] += a[i];
    }
    const norm = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2) || 1;
    return v.map((x) => x / norm);
  };
  let calls = 0;
  return {
    id: 'fake-neural',
    dims: 3,
    get calls(): number {
      return calls;
    },
    set calls(n: number) {
      calls = n;
    },
    async embed(texts: string[]) {
      (this as unknown as { calls: number }).calls += 1;
      embedCalls.push(...texts);
      return texts.map(embedOne);
    },
  } as unknown as EmbeddingProvider & { calls: number };
};

describe('§7.2 honesty: lexical vs semantic are distinct, labeled tiers', () => {
  const corpus: RetrievableMemory[] = [
    { id: 'm1', text: 'she knows SQL optimization and query tuning', scope: 'fact' },
    { id: 'm2', text: 'prefers concise replies', scope: 'preference' },
  ];

  it('pure lexical retrieval CANNOT bridge "database" → "SQL" (the gap embeddings close)', () => {
    const lexical = retrieve('who can help with database performance', corpus);
    expect(lexical.find((h) => h.id === 'm1')).toBeUndefined(); // zero shared stems
    expect(lexical.every((h) => h.source === 'lexical')).toBe(true);
  });

  it('hybrid retrieval with a REAL embedding provider bridges the SAME query by meaning', async () => {
    const provider = fakeNeuralProvider();
    const hybrid = await hybridRetrieve('who can help with database performance', corpus, { provider, minVectorScore: 0.3 });
    const hit = hybrid.find((h) => h.id === 'm1');
    expect(hit).toBeDefined(); // found despite zero shared stems — semantic generalization
    expect(['vector', 'hybrid']).toContain(hit!.source);
  });

  it('with NO provider, hybrid retrieval IS lexical retrieval and says so', async () => {
    const hits = await hybridRetrieve('SQL optimization', corpus);
    expect(hits[0]?.id).toBe('m1');
    expect(hits.every((h) => h.source === 'lexical')).toBe(true);
    const block = await relevantMemoryBlock('SQL optimization', async () => corpus, 5, null);
    expect(block).toContain('lexical relevance');
    expect(block).not.toContain('semantic');
  });

  it('relevantMemoryBlock states the semantic tier honestly when a provider is in use', async () => {
    const block = await relevantMemoryBlock('who can help with database performance', async () => corpus, 5, fakeNeuralProvider());
    expect(block).toContain('semantic + lexical relevance');
    expect(block).toContain('SQL optimization');
  });

  it('scope filtering keeps unrelated scopes out of the candidate set (§7.3)', async () => {
    const provider = fakeNeuralProvider();
    const scoped = await hybridRetrieve('database performance', corpus, { provider, scopeFilter: (s) => s === 'preference' });
    expect(scoped.find((h) => h.id === 'm1')).toBeUndefined(); // fact scope excluded
    expect(scoped.every((h) => h.scope === 'preference')).toBe(true);
  });
});

describe('the embedding provider abstraction (§7.2)', () => {
  it("default configuration is 'none' and resolves to NO provider (honest lexical mode)", async () => {
    const cfg = await getEmbeddingsConfig();
    expect(cfg.provider).toBe('none');
    expect(await getEmbeddingProvider()).toBeNull();
  });

  it('configuration persists and the openai provider activates with baseUrl+model', async () => {
    await setEmbeddingsConfig({ provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'text-embedding-3-small' });
    const cfg = await getEmbeddingsConfig();
    expect(cfg.provider).toBe('openai');
    const p = await getEmbeddingProvider();
    expect(p).not.toBeNull();
    expect(p!.id).toBe('openai:text-embedding-3-small');
  });

  it('cosine: identical vectors → 1, orthogonal → 0, mismatched lengths → 0', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1], [1, 0])).toBe(0);
  });

  it('the vector cache embeds each text ONCE across repeated calls', async () => {
    const calls: string[] = [];
    const provider = fakeNeuralProvider(calls);
    const first = await embedWithCache(provider, ['hello world', 'second text']);
    const second = await embedWithCache(provider, ['hello world', 'second text', 'third text']);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(3);
    expect(calls.filter((t) => t === 'hello world')).toHaveLength(1); // embedded once, cached after
    expect(second[0]).toEqual(first[0]); // cache returns the SAME vector
  });
});

describe('§7.5 memory lifecycle: corrections supersede, history survives', () => {
  it('a revised fact supersedes the old record; prompts and retrieval show only the current one', async () => {
    const first = String(await memoryTools.remember.run({ fact: 'the project budget is ₹10 lakh', category: 'fact' }));
    expect(first).toMatch(/Saved/i);
    const second = String(await memoryTools.remember.run({ fact: 'the project budget is ₹12 lakh', category: 'fact' }));
    expect(second).toMatch(/Updated \(was: .*₹10 lakh\)/);
    // retrieval sees ONLY the current value
    const find = String(await memoryTools.find_memory.run({ query: 'project budget' }));
    expect(find).toContain('₹12 lakh');
    expect(find).not.toContain('₹10 lakh');
    // the full prompt also shows only the current record
    const { getMemoryPrompt } = await import('../src/main/memory');
    const prompt = String(await getMemoryPrompt());
    expect(prompt).toContain('₹12 lakh');
    expect(prompt).not.toContain('₹10 lakh');
  });

  it('a correction never overwrites an UNRELATED fact (§7.5 safety)', async () => {
    await memoryTools.remember.run({ fact: 'the deployment deadline is ₹5 lakh over budget', category: 'fact' });
    await memoryTools.remember.run({ fact: 'her sister lives in Toronto', category: 'fact' });
    await memoryTools.remember.run({ fact: 'the deployment deadline is ₹9 lakh over budget', category: 'fact' });
    const find = String(await memoryTools.find_memory.run({ query: 'sister Toronto' }));
    expect(find).toContain('sister lives in Toronto'); // untouched by the unrelated correction
  });
});
