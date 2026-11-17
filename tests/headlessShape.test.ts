import { describe, it, expect } from 'vitest';
import { UNTRUSTED, MAX_TEXT_CHARS, MAX_LINKS, pickLinks, shapePage, squeezeText } from '../src/main/headlessShape';

describe('headless browser shaping (pure)', () => {
  it('pickLinks keeps only absolute http(s) links, dedupes and caps the list', () => {
    const links = [
      'https://a.example/x',
      'https://a.example/x', // duplicate
      '#section',
      'javascript:void(0)',
      'mailto:a@b.c',
      'relative/path',
      'http://b.example/y',
    ];
    const out = pickLinks(links, 5);
    expect(out).toEqual(['https://a.example/x', 'http://b.example/y']);
    // The cap is honoured: 30 valid links in, 25 (MAX_LINKS) out.
    const many = Array.from({ length: 30 }, (_, i) => `https://x.example/${i}`);
    expect(pickLinks(many)).toHaveLength(MAX_LINKS);
  });

  it('squeezeText collapses DOM whitespace without eating paragraphs', () => {
    expect(squeezeText('  a \t b   c  ')).toBe('a b c');
    expect(squeezeText('para one\n\n\n\n\npara two')).toBe('para one\n\npara two');
    expect(squeezeText(undefined as unknown as string)).toBe('');
  });

  it('shapePage fences everything behind the untrusted banner and caps the text', () => {
    const long = 'w'.repeat(MAX_TEXT_CHARS + 5000);
    const out = shapePage({ title: 'Example', finalUrl: 'https://example.com/final', text: long, links: ['https://example.com/next'] });
    expect(out.startsWith(UNTRUSTED.trim())).toBe(true);
    expect(out).toContain('TITLE: Example');
    expect(out).toContain('URL: https://example.com/final');
    expect(out).toContain('[clipped 5000 chars]');
    expect(out).toContain('LINKS:\nhttps://example.com/next');
    // The raw unclipped payload must never survive into the prompt.
    expect(out).not.toContain('w'.repeat(MAX_TEXT_CHARS + 100));
  });

  it('shapePage reports pages that exposed no readable text instead of faking content', () => {
    const out = shapePage({ title: '', finalUrl: 'https://example.com/', text: '   ', links: [] });
    expect(out).toContain('TITLE: (untitled)');
    expect(out).toContain('TEXT: (the page exposed no readable text');
    expect(out).not.toContain('LINKS:');
  });
});
