import { afterEach, describe, expect, it } from 'vitest';
import { runProcess, runProcessChecked, ProcessExitError, ProcessRunError } from '../src/main/processRunner';

const spawned: Array<Promise<unknown>> = [];

describe('central process runner', () => {
  it('captures stdout, stderr, exit code and duration', async () => {
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err")']);
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns a real non-zero exit code instead of disguising it as success', async () => {
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("diagnostic"); process.exit(7)']);
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe('diagnostic');
  });

  it('checked execution rejects a non-zero exit with captured output', async () => {
    await expect(runProcessChecked(process.execPath, ['-e', 'process.stderr.write("bad"); process.exit(3)']))
      .rejects.toMatchObject({ name: 'ProcessExitError', result: { exitCode: 3, stderr: 'bad' } });
  });

  it('rejects a process that exceeds its timeout', async () => {
    await expect(runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 50 }))
      .rejects.toMatchObject({ name: 'ProcessRunError', kind: 'timeout' });
  });

  it('does not start a process when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runProcess(process.execPath, ['-e', 'process.exit(0)'], { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'ProcessRunError', kind: 'cancelled' });
  });

  it('uses the requested working directory and environment', async () => {
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(process.env.JINI_RUNNER_TEST + "|" + process.cwd())'], {
      cwd: process.cwd(),
      env: { ...process.env, JINI_RUNNER_TEST: 'isolated' },
    });
    expect(result.stdout).toBe(`isolated|${process.cwd()}`);
  });
});
