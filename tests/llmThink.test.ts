import { describe, expect, it } from 'vitest';
import { cleanThink } from '../src/main/llm';

describe('cleanThink', () => {
  it('removes paired think blocks', () => {
    expect(cleanThink('<think>reasoning here</think>The answer.')).toBe('The answer.');
  });

  it('removes reasoning that precedes the last close tag even without an opener', () => {
    expect(cleanThink('partial reasoning</think>The answer.')).toBe('The answer.');
  });

  it('removes a block truncated mid-reasoning (stream ended inside <think>)', () => {
    expect(cleanThink('The answer.<think>unfinished reasoning')).toBe('The answer.');
    expect(cleanThink('<think>only reasoning, never closed')).toBe('');
  });

  it('leaves plain content untouched and trims whitespace', () => {
    expect(cleanThink('  Just the reply.  ')).toBe('Just the reply.');
  });

  it('handles several paired blocks plus a truncated tail', () => {
    expect(cleanThink('<think>a</think>mid<think>b</think>end<think>c')).toBe('midend');
  });
});
