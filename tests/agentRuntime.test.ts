import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime, type AgentRuntimePersistence, type AgentSessionSnapshot } from '../src/main/agentEngine/runtime';

const setup = () => {
  const saved: AgentSessionSnapshot[][] = [];
  const persistence: AgentRuntimePersistence = {
    load: async () => saved.at(-1) ?? [],
    save: async (sessions) => { saved.push(sessions.map((s) => ({ ...s }))); },
  };
  const driver = {
    chat: vi.fn(async (_prompt: string, onDelta: (s: string) => void, onProgress: (s: string) => void) => {
      onProgress('working');
      onDelta('hello');
      return 'hello';
    }),
    cancelChat: vi.fn(),
  };
  return { runtime: new AgentRuntime(driver, persistence), driver, saved };
};

describe('Cline-compatible JINI agent session runtime', () => {
  it('creates, runs, snapshots and continues one persistent session', async () => {
    const { runtime, driver } = setup();
    const events: string[] = [];
    await runtime.subscribe((event) => events.push(event.type));
    const first = await runtime.run('first prompt', { sessionId: 'session-a' });
    expect(first).toBe('hello');
    expect((await runtime.snapshot('session-a')).status).toBe('completed');
    expect((await runtime.snapshot('session-a')).turnCount).toBe(1);
    await runtime.continue('session-a', 'continue prompt');
    expect(driver.chat).toHaveBeenCalledTimes(2);
    expect(events).toContain('session-created');
    expect(events).toContain('run-start');
    expect(events).toContain('delta');
    expect(events).toContain('progress');
    expect(events).toContain('run-end');
  });

  it('aborts only the requested active session', async () => {
    const { runtime, driver } = setup();
    await runtime.createSession('session-b');
    await runtime.run('work', { sessionId: 'session-b' });
    expect(await runtime.abort('session-b')).toBe(false);
    expect(driver.cancelChat).not.toHaveBeenCalled();
  });

  it('restores active snapshots as interrupted and validates session state', async () => {
    const { runtime } = setup();
    const restored = await runtime.restore({
      id: 'session-c', status: 'running', createdAt: 1, updatedAt: 2, turnCount: 3,
    });
    expect(restored.status).toBe('interrupted');
    expect((await runtime.list()).map((s) => s.id)).toContain('session-c');
  });
  it('forwards lifecycle hooks through the runtime to the provider driver', async () => {
    const { runtime, driver } = setup();
    const hooks = { beforeRun: vi.fn(), beforeModel: vi.fn(), afterModel: vi.fn(), afterRun: vi.fn() };
    await runtime.run('hooked prompt', { sessionId: 'hook-session', hooks });
    expect(driver.chat).toHaveBeenCalledWith('hooked prompt', expect.any(Function), expect.any(Function), expect.objectContaining({ chatId: 'hook-session', hooks }));
  });

});
