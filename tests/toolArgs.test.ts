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

  it('coerces and validates integers without accepting fractions', () => {
    const integerSchema = { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['limit'] };
    expect(checkArgs('t', { limit: '4' }, integerSchema)).toEqual({ limit: 4 });
    expect(() => checkArgs('t', { limit: '4.5' }, integerSchema)).toThrow(/must be an integer/);
    expect(() => checkArgs('t', { limit: '11' }, integerSchema)).toThrow(/must be ≤ 10/);
  });

  it('does not silently coerce arbitrary strings to false', () => {
    expect(checkArgs('t', { force: 'false', name: 'x' }, schema).force).toBe(false);
    expect(() => checkArgs('t', { force: 'maybe', name: 'x' }, schema)).toThrow(/must be true or false/);
  });

  it('enforces array item counts and item types', () => {
    const arraySchema = { type: 'object', properties: { names: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string' } } } };
    expect(checkArgs('t', { names: ['a', 'b'] }, arraySchema).names).toEqual(['a', 'b']);
    expect(() => checkArgs('t', { names: [] }, arraySchema)).toThrow(/at least 1 item/);
    expect(() => checkArgs('t', { names: ['a', 2] }, arraySchema)).toThrow(/must be string/);
  });

  it('can reject undeclared parameters for closed schemas', () => {
    const closed = { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false };
    expect(() => checkArgs('t', { path: 'a', unexpected: 'b' }, closed)).toThrow(/unsupported argument/);
  });
});
