import { afterEach, describe, expect, it } from 'vitest';
import {
  processSchedulerSnapshot,
  resetProcessSchedulerForTests,
  runProcess,
} from '../src/main/execution/ProcessRunner';

const node = process.execPath;
const script = (source: string) => ['-e', source];

afterEach(() => resetProcessSchedulerForTests());

describe('shared process runner', () => {
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
