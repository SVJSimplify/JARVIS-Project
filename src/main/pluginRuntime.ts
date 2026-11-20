/**
 * JINI plugin contract. Plugins can observe lifecycle facts and contribute namespaced tools.
 * Tool execution still passes through tools.ts: schema validation, risk classification,
 * authorization, durable started/outcome receipts, cancellation and audit cannot be bypassed.
 */
import { runtimeEvents, type JiniRuntimeEvents, type RuntimeEventName } from './runtimeEvents';
import { agentToolRegistry, type AgentTool } from './agentEngine/toolRegistry';

export interface JiniPlugin {
  id: string;
  version: string;
  description?: string;
  manifest?: { capabilities?: readonly string[] };
  tools?: readonly AgentTool[];
  events: Partial<{ [K in RuntimeEventName<JiniRuntimeEvents>]: (payload: JiniRuntimeEvents[K]) => void }>;
}
export interface PluginRegistration { id: string; dispose: () => void; }
const installed = new Map<string, PluginRegistration>();

export function registerPlugin(plugin: JiniPlugin): PluginRegistration {
  const id = String(plugin.id ?? '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(id)) throw new Error('Plugin id must be 2–64 safe characters.');
  if (installed.has(id)) throw new Error('Plugin "' + id + '" is already registered.');
  if (!plugin.version || plugin.version.length > 40) throw new Error('Plugin version is required and must be at most 40 characters.');

  const contributedTools = plugin.tools ?? [];
  if (contributedTools.length && !plugin.manifest?.capabilities?.includes('tools')) {
    throw new Error('Plugin "' + id + '" must declare the "tools" capability before registering tools.');
  }

  const toolRegistration = contributedTools.length
    ? agentToolRegistry.registerPluginTools(id, contributedTools)
    : undefined;
  const disposers: Array<() => void> = [];
  try {
    for (const event of Object.keys(plugin.events ?? {}) as RuntimeEventName<JiniRuntimeEvents>[]) {
      const handler = plugin.events?.[event];
      if (typeof handler === 'function') {
        // Keep the event key and payload type correlated; runtime bus validates listeners.
        disposers.push(runtimeEvents.on(event, handler));
      }
    }
  } catch (error) {
    toolRegistration?.dispose();
    for (const dispose of disposers.splice(0)) dispose();
    throw error;
  }

  const registration: PluginRegistration = {
    id,
    dispose: () => {
      if (installed.get(id) !== registration) return;
      installed.delete(id);
      for (const dispose of disposers.splice(0)) dispose();
      toolRegistration?.dispose();
    },
  };
  installed.set(id, registration);
  return registration;
}
export const listPlugins = (): Array<{ id: string }> => [...installed.keys()].sort().map(id => ({ id }));
export function disposePlugins(): void { for (const p of [...installed.values()]) p.dispose(); }
