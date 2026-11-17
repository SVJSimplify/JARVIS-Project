import { describe, expect, it } from 'vitest';
import { relevantMemoryBlock } from '../src/main/semanticMemory';

describe('focused: relevantMemoryBlock reports provider failure honestly', () => {
  const corpus = () => [{ id: 'x', text: 'Deploy happens every Friday', scope: 'fact', updated: Date.now() }];

  it('no-hit path still states the lexical fallback and the provider error', async () => {
    const block = await relevantMemoryBlock('database performance', async () => corpus(), 3, {
      id: 'down', embed: async () => { throw new Error('connection refused'); },
    });
    expect(block).toMatch(/none found/);
    expect(block).toMatch(/lexical relevance/);
    expect(block).toMatch(/connection refused/);
    expect(block).toMatch(/LEXICAL, not semantic/);
  });

  it('no provider and no hits returns empty (no spurious note)', async () => {
    expect(await relevantMemoryBlock('zzzz qqqq', async () => corpus(), 3, null)).toBe('');
  });
});
