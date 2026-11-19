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

  it('treats an empty model response as completed rather than cancelled', async () => {
    const persistence: AgentRuntimePersistence = { load: async () => [], save: async () => undefined };
    const runtime = new AgentRuntime({ chat: vi.fn(async () => ''), cancelChat: vi.fn() }, persistence);
    await runtime.run('empty response', { sessionId: 'empty-session' });
    expect((await runtime.snapshot('empty-session')).status).toBe('completed');
  });

  it('forks a session with an independent transcript and parent relationship', async () => {
    const restored: string[] = [];
    const persistence: AgentRuntimePersistence = { load: async () => [], save: async () => undefined };
    const driver = { chat: vi.fn(async () => 'done'), cancelChat: vi.fn(), snapshotHistory: () => [{ role: 'user' as const, content: 'original' }], restoreHistory: (id: string) => { restored.push(id); } };
    const runtime = new AgentRuntime(driver, persistence);
    await runtime.run('original', { sessionId: 'source-session' });
    const fork = await runtime.fork('source-session', 'fork-session');
    expect(fork.parentSessionId).toBe('source-session');
    expect(fork.status).toBe('idle');
    expect(fork.messages).toEqual([{ role: 'user', content: 'original' }]);
    expect(restored).toContain('fork-session');
  });

  it('restores active snapshots as interrupted and validates session state', async () => {
    const { runtime } = setup();
    const restored = await runtime.restore({
      id: 'session-c', status: 'running', createdAt: 1, updatedAt: 2, turnCount: 3, iteration: 0, pendingToolCalls: [],
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

  it('persists the provider transcript and restores it into the existing chat engine', async () => {
    const restored: string[] = [];
    const persistence: AgentRuntimePersistence = { load: async () => [], save: async () => undefined };
    const driver = {
      chat: vi.fn(async () => 'done'),
      cancelChat: vi.fn(),
      snapshotHistory: () => [{ role: 'user' as const, content: 'hello' }],
      restoreHistory: (id: string) => { restored.push(id); },
    };
    const runtime = new AgentRuntime(driver, persistence);
    await runtime.run('hello', { sessionId: 'history-session' });
    expect((await runtime.snapshot('history-session')).messages).toEqual([{ role: 'user', content: 'hello' }]);
    await runtime.restore({ id: 'restored-session', status: 'completed', createdAt: 1, updatedAt: 1, turnCount: 1, iteration: 2, pendingToolCalls: [], messages: [{ role: 'user', content: 'restored' }] });
    expect(restored).toContain('restored-session');
  });

  it('replaces only the active run in the same session', async () => {
    let finishFirst: ((value: string) => void) | undefined;
    const persistence: AgentRuntimePersistence = { load: async () => [], save: async () => undefined };
    const driver = {
      chat: vi.fn((prompt: string) => prompt === 'first' ? new Promise<string>((resolve) => { finishFirst = resolve; }) : Promise.resolve(prompt)),
      cancelChat: vi.fn(() => finishFirst?.('')),
    };
    const runtime = new AgentRuntime(driver, persistence);
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    driver.chat.mockImplementation((prompt: string) => {
      if (prompt === 'first') return new Promise<string>((resolve) => { finishFirst = resolve; started(); });
      return Promise.resolve(prompt);
    });
    const first = runtime.run('first', { sessionId: 'same-session' });
    await firstStarted;
    const second = runtime.run('second', { sessionId: 'same-session' });
    await expect(first).resolves.toBe('');
    await expect(second).resolves.toBe('second');
    expect(driver.cancelChat).toHaveBeenCalledWith('same-session');
    expect(driver.chat).toHaveBeenCalledTimes(2);
  });

});
