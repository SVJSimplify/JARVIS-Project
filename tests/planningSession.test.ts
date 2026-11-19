import { describe, expect, it } from 'vitest';
import { planningTools, planGuard, resetPlanMode } from '../src/main/planning';
import { runWithExecutionScope } from '../src/main/toolResult';

describe('session-scoped plan mode', () => {
  it('does not let one conversation block writes in another', async () => {
    await runWithExecutionScope({ sessionId: 'plan-session-a' }, async () => {
      resetPlanMode();
      planningTools.plan_enter.run({});
      expect(planGuard('write_file')).toMatch(/read-only/);
    });
    await runWithExecutionScope({ sessionId: 'plan-session-b' }, async () => {
      resetPlanMode();
      expect(planGuard('write_file')).toBeNull();
    });
    await runWithExecutionScope({ sessionId: 'plan-session-a' }, async () => {
      expect(planGuard('write_file')).toMatch(/read-only/);
      resetPlanMode();
    });
  });
});
