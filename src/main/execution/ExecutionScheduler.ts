export type ExecutionResource = 'command' | 'system' | 'build' | 'persistent_shell';
export class QueueTimeoutError extends Error {
  constructor(readonly queueWaitMs: number) {
    super(`Execution queue wait exceeded ${Math.ceil(queueWaitMs / 1000)} seconds.`);
    this.name = 'QueueTimeoutError';
  }
}

interface Waiter {
  resource: ExecutionResource;
  signal?: AbortSignal;
  queuedAt: number;
  maxWaitMs: number;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (ticket: { queueWaitMs: number; release: () => void }) => void;
  reject: (error: Error) => void;
  onAbort: () => void;
}

const GLOBAL_LIMIT = 4;
const RESOURCE_LIMITS: Record<ExecutionResource, number> = {
  command: 2,
  system: 2,
  build: 1,
  persistent_shell: 1,
};

let activeTotal = 0;
const activeByResource: Record<ExecutionResource, number> = { command: 0, system: 0, build: 0, persistent_shell: 0 };
const waiters: Waiter[] = [];

const removeWaiter = (waiter: Waiter): boolean => {
  const index = waiters.indexOf(waiter);
  if (index < 0) return false;
  waiters.splice(index, 1);
  if (waiter.timer) clearTimeout(waiter.timer);
  waiter.signal?.removeEventListener('abort', waiter.onAbort);
  return true;
};

const pump = (): void => {
  while (activeTotal < GLOBAL_LIMIT) {
    const index = waiters.findIndex((waiter, i) =>
      activeByResource[waiter.resource] < RESOURCE_LIMITS[waiter.resource] &&
      !waiters.slice(0, i).some((prior) => prior.resource === waiter.resource)
    );
    if (index < 0) return;
    const [waiter] = waiters.splice(index, 1);
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener('abort', waiter.onAbort);
    activeTotal++;
    activeByResource[waiter.resource]++;
    let released = false;
    waiter.resolve({
      queueWaitMs: Math.max(0, Date.now() - waiter.queuedAt),
      release: () => {
        if (released) return;
        released = true;
        activeTotal = Math.max(0, activeTotal - 1);
        activeByResource[waiter.resource] = Math.max(0, activeByResource[waiter.resource] - 1);
        pump();
      },
    });
  }
};

/**
 * Fair, resource-aware process admission. Queue time is measured separately from process
 * time and has its own deadline. Cancellation removes a waiting job before it can launch.
 */
export function acquireExecutionSlot(
  resource: ExecutionResource,
  signal?: AbortSignal,
  maxQueueWaitMs = 60_000
): Promise<{ queueWaitMs: number; release: () => void }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Execution was cancelled before entering the queue.'));
      return;
    }
    const waiter: Waiter = {
      resource,
      signal,
      queuedAt: Date.now(),
      maxWaitMs: Math.max(250, Math.min(300_000, Number.isFinite(maxQueueWaitMs) ? Math.trunc(maxQueueWaitMs) : 60_000)),
      resolve,
      reject,
      onAbort: () => {
        if (!removeWaiter(waiter)) return;
        reject(new Error('Execution was cancelled while queued.'));
        pump();
      },
    };
    signal?.addEventListener('abort', waiter.onAbort, { once: true });
    waiter.timer = setTimeout(() => {
      if (!removeWaiter(waiter)) return;
      reject(new QueueTimeoutError(Date.now() - waiter.queuedAt));
      pump();
    }, waiter.maxWaitMs);
    waiter.timer.unref?.();
    waiters.push(waiter);
    pump();
  });
}

export const executionSchedulerSnapshot = () => ({
  active: activeTotal,
  queued: waiters.length,
  byResource: { ...activeByResource },
  queuedByResource: {
    command: waiters.filter((w) => w.resource === 'command').length,
    system: waiters.filter((w) => w.resource === 'system').length,
    build: waiters.filter((w) => w.resource === 'build').length,
    persistent_shell: waiters.filter((w) => w.resource === 'persistent_shell').length,
  },
});

export const resetExecutionSchedulerForTests = (): void => {
  if (activeTotal !== 0) throw new Error('Cannot reset the execution scheduler while work is active.');
  for (const waiter of [...waiters]) {
    removeWaiter(waiter);
    waiter.reject(new Error('Execution scheduler reset by test.'));
  }
};
