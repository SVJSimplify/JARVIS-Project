import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeEventBus, type JiniRuntimeEvents } from '../src/main/runtimeEvents';
describe('runtime event bus', () => {
  const bus = createRuntimeEventBus<JiniRuntimeEvents>();
  afterEach(() => bus.clear());
  it('delivers typed events in registration order', () => {
    const calls: string[] = [];
    bus.on('turn.started', (event) => calls.push('first:' + event.task));
    bus.on('turn.started', (event) => calls.push('second:' + event.task));
    bus.emit('turn.started', { task: 'ship feature', at: 10 });
    expect(calls).toEqual(['first:ship feature', 'second:ship feature']);
  });
  it('isolates listener failures and continues dispatch', () => {
    const report = vi.fn();
    const safeBus = createRuntimeEventBus<JiniRuntimeEvents>(report);
    const next = vi.fn();
    safeBus.on('turn.ended', () => { throw new Error('observer failed'); });
    safeBus.on('turn.ended', next);
    safeBus.emit('turn.ended', { outcome: 'ok', at: 20 });
    expect(report).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });
  it('supports once listeners and explicit unsubscription', () => {
    const once = vi.fn(), regular = vi.fn();
    bus.once('turn.started', once);
    const unsubscribe = bus.on('turn.started', regular);
    bus.emit('turn.started', { task: 'one', at: 1 });
    bus.emit('turn.started', { task: 'two', at: 2 });
    unsubscribe();
    bus.emit('turn.started', { task: 'three', at: 3 });
    expect(once).toHaveBeenCalledOnce();
    expect(regular).toHaveBeenCalledTimes(2);
    expect(bus.listenerCount('turn.started')).toBe(0);
  });
  it('uses snapshot dispatch when listeners unsubscribe during an event', () => {
    const calls: string[] = [];
    let removeSecond: () => void = () => undefined;
    bus.on('turn.started', () => { calls.push('first'); removeSecond(); });
    removeSecond = bus.on('turn.started', () => calls.push('second'));
    bus.emit('turn.started', { task: 'snapshot', at: 1 });
    expect(calls).toEqual(['first', 'second']);
    expect(bus.listenerCount('turn.started')).toBe(1);
  });
});
