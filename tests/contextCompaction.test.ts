import { describe, expect, it } from 'vitest';
import { compactToolMessages } from '../src/main/contextCompaction';
describe('context compaction', () => {
 it('clips old tool outputs and preserves newest output', () => {
  const m=[{role:'tool',content:'A'.repeat(1000)},{role:'tool',content:'newest'}];
  const r=compactToolMessages(m,{keepNewest:1,maxChars:160});
  expect(r.compacted).toBe(1); expect(m[0].content).toContain('older tool output compacted'); expect(m[1].content).toBe('newest');
 });
 it('does not mutate user messages', () => {
  const m=[{role:'user',content:'U'.repeat(1000)}]; compactToolMessages(m,{keepNewest:0,maxChars:100});
  expect(m[0].content).toHaveLength(1000);
 });
});