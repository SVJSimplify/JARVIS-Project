import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentToolRegistry } from '../src/main/agentEngine/toolRegistry';

describe('Cline-shaped tools on an OpenCode-style registry', () => {
  let registry: AgentToolRegistry;
  afterEach(() => { registry = new AgentToolRegistry(); });

  it('registers namespaced plugin tools and passes execution context', async () => {
    registry = new AgentToolRegistry();
    const execute = vi.fn(async (_input: Record<string, unknown>, context: { agentId: string; pluginId?: string }) => ({
      ok: true, agent: context.agentId, plugin: context.pluginId,
    }));
    const registration = registry.registerPluginTools('sample.plugin', [{
      name: 'lookup',
      description: 'Look up a sample record.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      execute,
    }]);
    expect(registration.names).toEqual(['plugin_sample_plugin_lookup']);
    const tools = registry.toToolMap(() => ({ agentId: 'task:research#1' }));
    expect(await tools.plugin_sample_plugin_lookup.run({ id: '42' })).toBe('{"ok":true,"agent":"task:research#1","plugin":"sample.plugin"}');
    expect(execute).toHaveBeenCalledOnce();
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
      executionMode: 'parallel',
    }]);
    const name = 'plugin_sample_plugin_lookup';
    expect(registry.namespace('sample.plugin')).toBe('plugin_sample_plugin_');
    expect(registry.get(name)?.parallelSafe).toBe(true);
    registry.update(name, { enabled: false, description: 'Updated' });
    expect(registry.get(name)?.description).toBe('Updated');
    expect(registry.toToolMap()[name]).toBeUndefined();
    expect(registry.list({ includeDisabled: true })).toHaveLength(1);
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
