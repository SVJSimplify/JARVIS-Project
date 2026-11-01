import { describe, expect, it } from 'vitest';
import { checkArgs, parseArgs, resolveTool } from '../src/main/toolArgs';
import type { Tool } from '../src/main/toolTypes';

const tools: Record<string, Tool> = {
  browser_open: { description: '', parameters: {}, run: () => '' },
  web_search: { description: '', parameters: {}, run: () => '' },
  read: { description: '', parameters: {}, run: () => '' },
  launch_app: { description: '', parameters: {}, run: () => '' },
  list_files: { description: '', parameters: {}, run: () => '' },
  run_command: { description: '', parameters: {}, run: () => '' },
};

describe('resolveTool', () => {
  it('returns exact matches unchanged', () => {
    expect(resolveTool('browser_open', tools)).toBe('browser_open');
  });

  it('normalises punctuation and known aliases', () => {
    expect(resolveTool('functions.browser_open', tools)).toBe('browser_open');
    expect(resolveTool('ls', tools)).toBe('list_files');
    expect(resolveTool('screenshot', tools)).toBe(null); // see_screen is not in the local set: no guess
  });

  it('maps hallucinated names to the nearest read-only tool only', () => {
    expect(resolveTool('web_serch', tools, (n) => n === 'web_search')).toBe('web_search');
  });

  it('never fuzzy-matches an acting tool', () => {
    // 'launch_ap' is one edit from launch_app but acting tools must be named exactly
    expect(resolveTool('launch_ap', tools, () => false)).toBe(null);
  });

  it('returns null when nothing is close', () => {
    expect(resolveTool('completely_unrelated', tools)).toBe(null);
  });
});

describe('parseArgs', () => {
  it('parses plain JSON objects', () => {
    expect(parseArgs('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses empty and blank input to an empty object', () => {
    expect(parseArgs('')).toEqual({});
    expect(parseArgs('   ')).toEqual({});
  });

  it('repairs code fences, trailing commas and single-quoted keys', () => {
    expect(parseArgs('```json\n{"a":1,}\n```')).toEqual({ a: 1 });
    expect(parseArgs("{'a': 1}")).toEqual({ a: 1 });
    expect(parseArgs('{"a": "x”}')).toEqual({ a: 'x' });
  });

  it('extracts an object embedded in prose', () => {
    expect(parseArgs('Here you go: {"url":"https://x.test"} hope that helps')).toEqual({ url: 'https://x.test' });
  });

  it('unwraps a double-encoded JSON string', () => {
    expect(parseArgs('"{\\"a\\":2}"')).toEqual({ a: 2 });
  });

  it('throws with a short preview on hopeless input', () => {
    expect(() => parseArgs('not json at all')).toThrow(/not json at all/);
  });
});

describe('checkArgs', () => {
  const schema = {
    type: 'object',
    properties: {
      count: { type: 'number' },
      force: { type: 'boolean' },
      name: { type: 'string' },
      tags: { type: 'array' },
    },
    required: ['name'],
  };

  it('coerces stringly-typed numbers and booleans', () => {
    const out = checkArgs('t', { count: '5', force: 'true', name: 'x' }, schema);
    expect(out).toEqual({ count: 5, force: true, name: 'x' });
  });

  it('wraps a bare string into an array', () => {
    const out = checkArgs('t', { tags: 'alpha', name: 'x' }, schema);
    expect(out.tags).toEqual(['alpha']);
  });

  it('parses a JSON array string', () => {
    const out = checkArgs('t', { tags: '["a","b"]', name: 'x' }, schema);
    expect(out.tags).toEqual(['a', 'b']);
  });

  it('reports missing required arguments with the signature', () => {
    expect(() => checkArgs('mytool', {}, schema)).toThrow(/mytool is missing required argument\(s\): name/);
    expect(() => checkArgs('mytool', { name: '' }, schema)).toThrow(/missing required argument/);
  });

  it('leaves unknown extra keys untouched', () => {
    const out = checkArgs('t', { name: 'x', extra: 'kept' }, schema);
    expect(out.extra).toBe('kept');
  });
});
