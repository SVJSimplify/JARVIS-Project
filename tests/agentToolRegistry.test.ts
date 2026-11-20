import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentToolRegistry } from '../src/main/agentEngine/toolRegistry';

describe('Cline-shaped tools on an OpenCode-style registry', () => {
  let registry: AgentToolRegistry;
  afterEach(() => { registry = new AgentToolRegistry(); });

  it('registers namespaced plugin tools and passes execution context', async () => {
    registry = new AgentToolRegistry();
    const execute = vi.fn(async (_input: Record<string, unknown>, context: { agentId: string; pluginId?: string; signal?: AbortSignal; sessionId?: string }) => ({
      ok: true, agent: context.agentId, plugin: context.pluginId, aborted: context.signal?.aborted ?? false, session: context.sessionId,
    }));
    const registration = registry.registerPluginTools('sample.plugin', [{
      name: 'lookup',
      description: 'Look up a sample record.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      execute,
      action: 'read',
      parallelSafe: true,
    }]);
    expect(registration.names).toEqual(['plugin_sample_plugin_lookup']);
    const controller = new AbortController();
    const tools = registry.toToolMap(() => ({ agentId: 'task:research#1', signal: controller.signal, sessionId: 'session:research' }));
    expect(await tools.plugin_sample_plugin_lookup.run({ id: '42' })).toBe('{"ok":true,"agent":"task:research#1","plugin":"sample.plugin","aborted":false,"session":"session:research"}');
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][1].signal).toBe(controller.signal);
    expect(execute.mock.calls[0][1].sessionId).toBe('session:research');
    registration.dispose();
    expect(registry.get('plugin_sample_plugin_lookup')).toBeUndefined();
  });

  it('validates a whole plugin contribution before adding any tool', () => {
    registry = new AgentToolRegistry();
    expect(() => registry.registerPluginTools('sample.plugin', [
      { name: 'valid', description: 'Valid', inputSchema: { type: 'object' }, execute: () => 'ok' },
      { name: 'invalid', description: 'Invalid', inputSchema: { type: 'array' }, execute: () => 'no' },
    ])).toThrow(/object inputSchema/);
    expect(registry.list()).toEqual([]);
  });

  it('prevents collisions and never allows plugins to replace built-ins', () => {
    registry = new AgentToolRegistry();
    registry.registerBuiltin('get_time', {
      description: 'Get time.',
      parameters: { type: 'object', properties: {} },
      run: () => 'now',
    });
    expect(() => registry.registerBuiltin('get_time', {
      description: 'Override.',
      parameters: { type: 'object' },
      run: () => 'bad',
    })).toThrow(/already registered/);
    expect(registry.remove('get_time')).toBe(false);
  });

  it('supports disable, update and namespace lifecycle operations', () => {
    registry = new AgentToolRegistry();
    registry.registerPluginTools('sample.plugin', [{
      name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' }, execute: () => 'ok',
      action: 'read', executionMode: 'parallel',
    }]);
    const name = 'plugin_sample_plugin_lookup';
    expect(registry.namespace('sample.plugin')).toBe('plugin_sample_plugin_');
    expect(registry.get(name)?.parallelSafe).toBe(true);
    registry.update(name, { enabled: false, description: 'Updated' });
    expect(registry.get(name)?.description).toBe('Updated');
    expect(registry.toToolMap()[name]).toBeUndefined();
    expect(registry.list({ includeDisabled: true })).toHaveLength(1);
  });

  it('defaults plugin tools to side-effect-capable and requires explicit read-only declarations for parallel tools', () => {
    registry = new AgentToolRegistry();
    registry.registerPluginTools('sample.plugin', [{ name: 'mutate', description: 'Mutate', inputSchema: { type: 'object' }, execute: () => 'ok' }]);
    expect(registry.executionPolicy('plugin_sample_plugin_mutate', {})).toEqual({ action: 'config', resource: 'tool:plugin_sample_plugin_mutate' });
    expect(() => registry.update('plugin_sample_plugin_mutate', { parallelSafe: true })).toThrow(/action: read/);
    expect(() => registry.registerPluginTools('parallel.plugin', [{ name: 'bad', description: 'Bad', inputSchema: { type: 'object' }, execute: () => 'no', parallelSafe: true }])).toThrow(/action: read/);
  });

  it('exposes declared delete actions for the central hard-block gate', () => {
    registry = new AgentToolRegistry();
    registry.registerPluginTools('sample.plugin', [{ name: 'remove_record', description: 'Remove a record', inputSchema: { type: 'object' }, execute: () => 'no', action: 'delete', resource: (input) => 'record:' + String(input.id ?? '') }]);
    expect(registry.executionPolicy('plugin_sample_plugin_remove_record', { id: '42' })).toEqual({ action: 'delete', resource: 'record:42' });
  });

  it('rejects invalid names and malformed schemas', () => {
    registry = new AgentToolRegistry();
    expect(() => registry.registerPluginTools('sample.plugin', [{
      name: '../escape', description: 'Bad', inputSchema: { type: 'object' }, execute: () => 'no',
    }])).toThrow(/invalid tool name/);
    expect(() => registry.registerPluginTools('sample.plugin', [{
      name: 'bad_schema', description: 'Bad', inputSchema: { type: 'object', properties: [] }, execute: () => 'no',
    }])).toThrow(/properties must be an object/);
  });
});


describe('plugin schema isolation', () => {
  it('takes a private schema snapshot and returns defensive model-facing schemas', () => {
    registry = new AgentToolRegistry();
    const schema: Record<string, unknown> = {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    };
    registry.registerPluginTools('isolated.plugin', [{
      name: 'search', description: 'Search', inputSchema: schema, execute: () => 'ok', action: 'read',
    }]);

    (schema.properties as Record<string, unknown>).query = { type: 'number' };
    (schema.required as string[]).push('mutated');
    const first = registry.toToolMap().plugin_isolated_plugin_search.parameters;
    expect(first).toEqual({ type: 'object', properties: { query: { type: 'string' } }, required: ['query'] });

    (first.properties as Record<string, unknown>).query = { type: 'boolean' };
    expect(registry.toToolMap().plugin_isolated_plugin_search.parameters).toEqual({
      type: 'object', properties: { query: { type: 'string' } }, required: ['query'],
    });
  });

  it('rejects invalid runtime action and execution-mode declarations', () => {
    registry = new AgentToolRegistry();
    expect(() => registry.registerPluginTools('invalid.plugin', [{
      name: 'bad_action', description: 'Bad action', inputSchema: { type: 'object' }, execute: () => 'no', action: 'root' as never,
    }])).toThrow(/invalid action class/);
    expect(() => registry.registerPluginTools('invalid.mode', [{
      name: 'bad_mode', description: 'Bad mode', inputSchema: { type: 'object' }, execute: () => 'no', action: 'read', executionMode: 'race' as never,
    }])).toThrow(/invalid execution mode/);
  });
});


describe('tool registry lifecycle parity', () => {
  it('keeps parallelSafe and executionMode synchronized when a plugin tool is updated', () => {
    registry = new AgentToolRegistry();
    registry.registerPluginTools('parallel.plugin', [{
      name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' }, execute: () => 'ok', action: 'read', executionMode: 'parallel',
    }]);
    const name = 'plugin_parallel_plugin_lookup';
    expect(registry.toToolMap()[name].parallelSafe).toBe(true);
    registry.update(name, { parallelSafe: false });
    expect(registry.toToolMap()[name].parallelSafe).toBe(false);
    expect(registry.get(name)?.parallelSafe).toBe(false);
  });
});
