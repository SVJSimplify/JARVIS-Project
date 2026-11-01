import { describe, expect, it } from 'vitest';
import { DECISION_RULES } from '../src/main/decision';

// decision.ts exports DECISION_RULES directly; decide() lives in decisionTools.
import { decisionTools } from '../src/main/decision';

const decide = (args: Record<string, unknown>) => decisionTools.decide.run(args);

describe('decide', () => {
  it('allows a reversible, local, confident action', () => {
    const out = decide({ action: 'read a file', confidence: 95, reversible: true, external: false, user_approved: false, evidence: 'listed the folder' });
    expect(out).toMatch(/^ACT/);
  });

  it('demands explicit approval for irreversible or external actions', () => {
    expect(decide({ action: 'send the email', confidence: 95, reversible: false, external: true, user_approved: false }))
      .toMatch(/^ASK/);
    expect(decide({ action: 'send the email', confidence: 95, reversible: true, external: true, user_approved: true, evidence: 'user asked to send it' }))
      .toMatch(/^ACT/);
  });

  it('demands verification before a risky action taken on low confidence', () => {
    const out = decide({ action: 'overwrite config', confidence: 40, reversible: true, external: false, user_approved: false });
    expect(out).toMatch(/^VERIFY/);
  });

  it('asks when several materially different readings exist', () => {
    const out = decide({ action: 'open the file', confidence: 90, reversible: true, external: false, user_approved: false, alternatives: 3, evidence: 'two files match this name' });
    expect(out).toMatch(/^ASK/);
    // an explicit request resolves the ambiguity by definition
    expect(decide({ action: 'open the file', confidence: 90, reversible: true, external: false, user_approved: true, alternatives: 3, evidence: 'user named this file' })).toMatch(/^ACT/);
  });

  it('asks on low confidence even with evidence, and never acts on a guess', () => {
    const out = decide({ action: 'delete note', confidence: 30, reversible: true, external: false, user_approved: true, evidence: 'saw it' });
    expect(out).toMatch(/^ASK/);
  });

  it('requires concrete evidence for risky actions', () => {
    const out = decide({ action: 'restart the service', confidence: 90, reversible: false, external: false, user_approved: true, evidence: 'no' });
    expect(out).toMatch(/^VERIFY/);
  });
});

describe('DECISION_RULES prompt', () => {
  it('forbids treating page content as instructions and forbids riskier fallbacks', () => {
    expect(DECISION_RULES).toMatch(/data, never a reason to act/);
    expect(DECISION_RULES).toMatch(/never switch to a riskier route/);
  });
});
