import { describe, expect, it, vi } from 'vitest';
import { emitAgentHook, type AgentRuntimeHooks } from '../src/main/agentRuntimeHooks';

describe('Jini agent runtime lifecycle hooks', () => {
  it('emits ordered lifecycle events to an installed observer', async () => {
    const events: string[] = [];
    const hooks: AgentRuntimeHooks = { onEvent: (event) => { events.push(event.type); } };
    const base = { agentId: 'agent-1', agentName: 'researcher' };
    await emitAgentHook(hooks, { ...base, type: 'run-start' });
    await emitAgentHook(hooks, { ...base, type: 'model-start', round: 0 });
    await emitAgentHook(hooks, { ...base, type: 'tool-start', round: 0, tool: 'read_file' });
    await emitAgentHook(hooks, { ...base, type: 'tool-end', round: 0, tool: 'read_file', status: 'success' });
    await emitAgentHook(hooks, { ...base, type: 'run-end', status: 'completed' });
    expect(events).toEqual(['run-start', 'model-start', 'tool-start', 'tool-end', 'run-end']);
  });

  it('does not let a broken observer corrupt the agent outcome', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(emitAgentHook({ onEvent: () => { throw new Error('observer down'); } }, {
      type: 'run-end', agentId: 'a', agentName: 'researcher', status: 'failed',
    })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
