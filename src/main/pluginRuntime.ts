/** JINI plugin contract. Plugins observe lifecycle facts; they cannot replace tools, mutate arguments or bypass authorization. */
import { runtimeEvents, type JiniRuntimeEvents, type RuntimeEventName } from './runtimeEvents';
export interface JiniPlugin {
  id: string;
  version: string;
  description?: string;
  events: Partial<{ [K in RuntimeEventName<JiniRuntimeEvents>]: (payload: JiniRuntimeEvents[K]) => void }>;
}
export interface PluginRegistration { id: string; dispose: () => void; }
const installed = new Map<string, PluginRegistration>();
export function registerPlugin(plugin: JiniPlugin): PluginRegistration {
  const id = String(plugin.id ?? '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(id)) throw new Error('Plugin id must be 2–64 safe characters.');
  if (installed.has(id)) throw new Error('Plugin "' + id + '" is already registered.');
  if (!plugin.version || plugin.version.length > 40) throw new Error('Plugin version is required and must be at most 40 characters.');
  const disposers: Array<() => void> = [];
  for (const [event, handler] of Object.entries(plugin.events ?? {})) {
    if (typeof handler === 'function') disposers.push(runtimeEvents.on(event as RuntimeEventName<JiniRuntimeEvents>, handler as (payload: never) => void));
  }
  const registration: PluginRegistration = { id, dispose: () => {
    if (installed.get(id) !== registration) return;
    installed.delete(id);
    for (const dispose of disposers.splice(0)) dispose();
  }};
  installed.set(id, registration);
  return registration;
}
export const listPlugins = (): Array<{ id: string }> => [...installed.keys()].sort().map(id => ({ id }));
export function disposePlugins(): void { for (const p of [...installed.values()]) p.dispose(); }
