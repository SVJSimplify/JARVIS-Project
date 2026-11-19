/**
 * JINI RUNTIME EVENT BUS
 * Dependency-free lifecycle notifications inspired by OpenCode's event-driven
 * execution architecture. Synchronous, ordered, and isolated from listener failures.
 * Events are facts, not commands: permissions and execution remain authoritative
 * in tools.ts, approval.ts, and coordinator.ts.
 */
export interface JiniRuntimeEvents {
  'turn.started': { task: string; at: number };
  'turn.ended': { outcome: 'ok' | 'fail' | 'interrupted'; at: number };
  'progress.updated': { updatedAt: number; busy: boolean };
  'tool.started': { id: string; name: string; agent: string; taskId?: string; at: number };
  'tool.finished': { id: string; name: string; agent: string; taskId?: string; status: string; durationMs: number; at: number };
}
export type RuntimeEventName<E> = Extract<keyof E, string>;
export type RuntimeListener<T> = (payload: T) => void;
export interface RuntimeEventBus<E extends { [K in keyof E]: unknown }> {
  on<K extends RuntimeEventName<E>>(event: K, listener: RuntimeListener<E[K]>): () => void;
  once<K extends RuntimeEventName<E>>(event: K, listener: RuntimeListener<E[K]>): () => void;
  emit<K extends RuntimeEventName<E>>(event: K, payload: E[K]): void;
  clear(): void;
  listenerCount<K extends RuntimeEventName<E>>(event: K): number;
}
export function createRuntimeEventBus<E extends { [K in keyof E]: unknown }>(
  onListenerError: (error: unknown, event: RuntimeEventName<E>) => void = () => undefined,
): RuntimeEventBus<E> {
  const listeners = new Map<RuntimeEventName<E>, Set<RuntimeListener<unknown>>>();
  const add = <K extends RuntimeEventName<E>>(event: K, listener: RuntimeListener<E[K]>, once: boolean): (() => void) => {
    if (typeof listener !== 'function') throw new TypeError('Runtime event listener must be a function.');
    let bucket = listeners.get(event);
    if (!bucket) { bucket = new Set(); listeners.set(event, bucket); }
    let active = true;
    const remove = (): void => {
      if (!active) return;
      active = false;
      bucket?.delete(wrapped);
      if (bucket?.size === 0) listeners.delete(event);
    };
    const wrapped: RuntimeListener<unknown> = (payload) => {
      if (once) remove();
      listener(payload as E[K]);
    };
    bucket.add(wrapped);
    return remove;
  };
  return {
    on: (event, listener) => add(event, listener, false),
    once: (event, listener) => add(event, listener, true),
    emit: (event, payload) => {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        try { listener(payload); }
        catch (error) { try { onListenerError(error, event); } catch { /* diagnostics are non-authoritative */ } }
      }
    },
    clear: () => listeners.clear(),
    listenerCount: (event) => listeners.get(event)?.size ?? 0,
  };
}
/** Shared process-local bus. It carries lifecycle facts only, never permission grants. */
export const runtimeEvents = createRuntimeEventBus<JiniRuntimeEvents>();
