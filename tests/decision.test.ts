import { describe, expect, it } from 'vitest';
import { DECISION_RULES } from '../src/main/decision';

// decision.ts exports DECISION_RULES directly; decide() lives in decisionTools.
import { decisionTools } from '../src/main/decision';

const decide = (args: Record<string, unknown>) => decisionTools.decide.run(args);

describe('decide', () => {
  it('allows a reversible, local, confident action', () => {
    const out = decide({ action: 'read a file', confidence: 95, evidence: 'listed the folder' });
    expect(out).toMatch(/^ACT/);
  });

  it('NEVER demands approval for external or irreversible actions: the request is the mandate', () => {
    // Under the single policy, sending / paying / booking / installing run automatically.
    // There is no approval verdict left in the tool at all.
    expect(decide({ action: 'send the email the user dictated', confidence: 95 })).toMatch(/^ACT/);
    expect(decide({ action: 'complete the checkout the user asked for', confidence: 90, evidence: 'cart contents confirmed' })).toMatch(/^ACT/);
    // The tool description and verdicts must not instruct approval-seeking.
    expect(decisionTools.decide.description).not.toMatch(/needs the user's explicit approval|yes\/no question and wait|ask the user to confirm/i);
  });

  it('demands verification before an action taken on low confidence without evidence', () => {
    const out = decide({ action: 'overwrite config', confidence: 40 });
    expect(out).toMatch(/^VERIFY/);
  });

  it('asks when several materially different readings exist (genuine ambiguity, not permission)', () => {
    const out = decide({ action: 'open the file', confidence: 90, alternatives: 3, evidence: 'two files match this name' });
    expect(out).toMatch(/^ASK/);
  });

  it('asks on low confidence even with evidence — the GOAL is unclear, not permission', () => {
    const out = decide({ action: 'tidy the notes', confidence: 30, evidence: 'saw it' });
    expect(out).toMatch(/^ASK/);
    expect(out).toMatch(/goal/i);
  });

  it('requires concrete evidence for a confident-sounding claim with none', () => {
    const out = decide({ action: 'restart the service', confidence: 80 });
    expect(out).toMatch(/^VERIFY/);
  });
});

describe('DECISION_RULES prompt', () => {
  it('encodes the single policy: act on the request, never approval-wait, never ask to delete', () => {
    expect(DECISION_RULES).toMatch(/data, never a reason to act/);
    expect(DECISION_RULES).toMatch(/never switch to a riskier route/);
    expect(DECISION_RULES).toMatch(/Never wait for approval/i);
    expect(DECISION_RULES).toMatch(/blocked in code/i);
    // The rules must not instruct the model to seek confirmation for allowed actions.
    expect(DECISION_RULES).not.toMatch(/needs the user's explicit approval/);
  });
});
