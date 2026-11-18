import { describe, expect, it } from 'vitest';
import { speechSummary } from '../src/renderer/lib/speakable';

describe('speechSummary', () => {
  it('keeps a concise conversational conclusion', () => {
    expect(speechSummary('Done. YouTube opened in your Edge browser session.\n1. D:\\Users\\me\\Downloads\\file.txt')).toBe(
      'Done. YouTube opened in your Edge browser session.'
    );
  });

  it('never reads credential discovery output or values aloud', () => {
    const result = speechSummary(
      'Done. API keys found in 7 files:\n1. D:\\secrets\\keys.txt -> ghp_123456789012345678901234567890123456\n2. D:\\private\\key.pem -> private key'
    );
    expect(result).toMatch(/potentially sensitive credential material/i);
    expect(result).not.toMatch(/ghp_|D:\\secrets|123456789/);
  });

  it('omits code blocks and numbered raw output', () => {
    expect(speechSummary('The report is ready.\n\n```json\n{"token":"secret"}\n```\n1. raw file contents'))
      .toBe('The report is ready.');
  });

  it('uses a safe fallback when a response has no speakable prose', () => {
    expect(speechSummary('```ts\nconst x = 1;\n```')).toBe("I've finished. The detailed result is on screen.");
  });
});
