import { afterEach, describe, expect, it } from 'vitest';
import { currentToolExecutionMetrics, runWithExecutionScope } from '../src/main/toolResult';
import {
  processResourceForCommand,
  processSchedulerSnapshot,
  resetProcessSchedulerForTests,
  runProcess,
} from '../src/main/execution/ProcessRunner';

const node = process.execPath;
const script = (source: string) => ['-e', source];

afterEach(() => resetProcessSchedulerForTests());

describe('shared process runner', () => {
  it('routes common build and test commands into the exclusive build resource', () => {
    expect(processResourceForCommand('npm run build')).toBe('build');
    expect(processResourceForCommand('npx --no-install tsc --noEmit')).toBe('build');
    expect(processResourceForCommand('pytest -q')).toBe('build');
    expect(processResourceForCommand('Get-ChildItem D:\\')).toBe('command');
    expect(processResourceForCommand('git status --short')).toBe('command');
  });

  it('returns stdout, exit code and separate queue/execution timings', async () => {
    const result = await runProcess({
      executable: node,
      args: script('process.stdout.write("hello");'),
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(result.status).toBe('success');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.queueWaitMs).toBeGreaterThanOrEqual(0);
  });

  it('attaches queue and process timings to the ambient tool execution scope', async () => {
    await runWithExecutionScope({}, async () => {
      const result = await runProcess({
        executable: node,
        args: script('process.stdout.write("timed");'),
        cwd: process.cwd(),
        timeoutMs: 5000,
      });
      const metrics = currentToolExecutionMetrics();
      expect(result.status).toBe('success');
      expect(metrics?.queueWaitMs).toBe(result.queueWaitMs);
      expect(metrics?.processMs).toBe(result.durationMs);
      expect(metrics?.processStatus).toBe('success');
      expect(metrics?.exitCode).toBe(0);
      expect(metrics?.pid).toBeTruthy();
    });
  });

  it('classifies a non-zero exit as failed, not as ordinary successful output', async () => {
    const result = await runProcess({
      executable: node,
      args: script('process.stderr.write("bad"); process.exit(7);'),
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain('bad');
  });

  it('distinguishes timeouts from normal exit failures', async () => {
    const result = await runProcess({
      executable: node,
      args: script('setTimeout(() => process.exit(0), 5000);'),
      cwd: process.cwd(),
      timeoutMs: 300,
    });
    expect(result.status).toBe('timed_out');
    expect(result.durationMs).toBeLessThan(4000);
  });

  it('honours cancellation and frees its scheduler slot', async () => {
    const controller = new AbortController();
    const pending = runProcess({
      executable: node,
      args: script('setTimeout(() => process.exit(0), 5000);'),
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 80);
    const result = await pending;
    expect(result.status).toBe('cancelled');
    expect(processSchedulerSnapshot().active).toBe(0);
  });

  it('bounds captured output without leaving pipe readers blocked', async () => {
    const result = await runProcess({
      executable: node,
      args: script('process.stdout.write("x".repeat(100000));'),
      cwd: process.cwd(),
      timeoutMs: 5000,
      maxOutputBytes: 16384,
    });
    expect(result.status).toBe('success');
    expect(result.outputTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(16384);
  });

  it('distinguishes a process launch failure from a command that ran and failed', async () => {
    const result = await runProcess({
      executable: 'jini-missing-executable-4c1e',
      args: [],
      cwd: process.cwd(),
      timeoutMs: 500,
      resource: 'command',
    });
    expect(result.status).toBe('launch_failed');
    expect(result.errorCode).toBeTruthy();
  });

  it('expires a queued process with a separate queue-timeout status', async () => {
    const first = runProcess({
      executable: node,
      args: script('setTimeout(() => process.exit(0), 420);'),
      cwd: process.cwd(),
      timeoutMs: 2000,
      resource: 'command',
    });
    const second = runProcess({
      executable: node,
      args: script('setTimeout(() => process.exit(0), 420);'),
      cwd: process.cwd(),
      timeoutMs: 2000,
      resource: 'command',
    });
    const started = Date.now();
    while (processSchedulerSnapshot().byResource.command < 2) {
      if (Date.now() - started > 1500) throw new Error('The two command slots did not become active.');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const queued = await runProcess({
      executable: node,
      args: script('process.exit(0);'),
      cwd: process.cwd(),
      timeoutMs: 1000,
      queueTimeoutMs: 250,
      resource: 'command',
    });
    expect(queued.status).toBe('queue_timed_out');
    expect(queued.queueWaitMs).toBeGreaterThanOrEqual(200);
    const active = await Promise.all([first, second]);
    expect(active.every((result) => result.status === 'success')).toBe(true);
  });


  it('never exceeds the command-process concurrency limit', async () => {
    let peak = 0;
    const observe = setInterval(() => {
      peak = Math.max(peak, processSchedulerSnapshot().byResource.command);
    }, 5);
    await Promise.all(Array.from({ length: 6 }, () => runProcess({
      executable: node,
      args: script('setTimeout(() => process.exit(0), 80);'),
      cwd: process.cwd(),
      timeoutMs: 5000,
      resource: 'command',
    })));
    clearInterval(observe);
    expect(peak).toBeLessThanOrEqual(2);
    expect(processSchedulerSnapshot().active).toBe(0);
    expect(processSchedulerSnapshot().queued).toBe(0);
  });
});
