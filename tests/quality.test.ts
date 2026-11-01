import { describe, expect, it } from 'vitest';
import { STANDARDS, qualityTools } from '../src/main/quality';

const gate = (args: Record<string, unknown>) => qualityTools.quality_gate.run(args);

describe('quality_gate', () => {
  it('returns the checklist first and never PASS on the first call', () => {
    const out = String(gate({ kind: 'code' }));
    expect(out).toMatch(/QUALITY CHECKLIST \(code\)/);
    expect(out).not.toMatch(/PASS/);
    expect(out.split('\n').length - 1).toBe(STANDARDS.code.length);
  });

  it('fails the gate when answers are missing, not ok, or evidence-free', () => {
    const n = STANDARDS.general.length;
    const answers = [{ item: 1, ok: true, evidence: 'saw the file saved' }];
    const out = String(gate({ kind: 'general', answers }));
    expect(out).toMatch(/NOT DONE/);
    expect(out).toMatch(/not answered/);

    const noEvidence = Array.from({ length: n }, (_, i) => ({ item: i + 1, ok: true, evidence: i === 0 ? 'x' : 'seen in tool result' }));
    expect(String(gate({ kind: 'general', answers: noEvidence }))).toMatch(/evidence missing/);

    const failed = Array.from({ length: n }, (_, i) => ({ item: i + 1, ok: i !== 0, evidence: 'seen in tool result' }));
    expect(String(gate({ kind: 'general', answers: failed }))).toMatch(/\(failed\)/);
  });

  it('passes only when every item is ok with real evidence', () => {
    const answers = STANDARDS.research.map((_, i) => ({ item: i + 1, ok: true, evidence: `verified in tool result ${i + 1}` }));
    expect(String(gate({ kind: 'research', answers }))).toMatch(/^PASS/);
  });

  it('falls back to the general standard for an unknown kind', () => {
    const out = String(gate({ kind: 'nope' }));
    expect(out).toContain(STANDARDS.general[0].slice(0, 30));
  });

  it('standsards demand verification and honest gaps', () => {
    expect(STANDARDS.research.join(' ')).toMatch(/nothing is guessed/);
    expect(STANDARDS.browser.join(' ')).toMatch(/approval/);
    expect(STANDARDS.code.join(' ')).toMatch(/re-read or diagnostics ran/);
  });
});
