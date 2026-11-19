import { describe, expect, it } from 'vitest';
import { runWithExecutionScope } from '../src/main/toolResult';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  beginTurn,
  emitActivity,
  endTurn,
  getMode,
  holdSpeech,
  initModes,
  modeInfo,
  setMode,
  toggleMode,
  type ActivityEvent,
  type NotifyPayload,
} from '../src/main/modes';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jmodes-'));
const fileIn = (dir: string) => path.join(dir, 'mode.json');

/** Fresh module state per test: initModes resets everything (ring, digest, mode). */
function boot(opts: { file?: string } = {}) {
  const pushes: Array<{ channel: string; payload: unknown }> = [];
  const notes: NotifyPayload[] = [];
  void initModes({
    file: opts.file,
    sink: (channel, payload) => pushes.push({ channel, payload }),
    notify: (p) => notes.push(p),
  });
  return { pushes, notes, channels: () => pushes.map((p) => p.channel) };
}

describe('session-scoped turn digests', () => {
  it('keeps progress counters and end-of-turn summaries independent', async () => {
    await initModes();
    await setMode('background');
    const a: string[] = [];
    const b: string[] = [];
    await runWithExecutionScope({ sessionId: 'mode-session-a' }, async () => {
      beginTurn('research task');
      emitActivity({ kind: 'tool', label: 'web_search', status: 'fail' });
    });
    await runWithExecutionScope({ sessionId: 'mode-session-b' }, async () => {
      beginTurn('writing task');
      emitActivity({ kind: 'tool', label: 'write_file', status: 'ok' });
      const result = endTurn({ reply: 'Written.' });
      b.push(result?.body ?? '');
    });
    await runWithExecutionScope({ sessionId: 'mode-session-a' }, async () => {
      const result = endTurn({ reply: 'Research incomplete.', failed: true });
      a.push(result?.body ?? '');
    });
    expect(a[0]).toContain('research task');
    expect(a[0]).toContain('1 steps failed');
    expect(b[0]).toContain('Written.');
    expect(b[0]).not.toContain('research task');
  });
});

describe('mode state and persistence', () => {
  it('defaults to interactive and offers both modes', () => {
    boot();
    expect(getMode()).toBe('interactive');
  });

  it('switches to background, broadcasts, and persists across a restart', async () => {
    const dir = tmp();
    const f = fileIn(dir);
    boot({ file: f });
    await setMode('background');
    expect(getMode()).toBe('background');
    expect(fs.readFileSync(f, 'utf8')).toContain('"background"');

    // A "restart": re-init from the same file restores the saved mode.
    const second = boot({ file: f });
    await new Promise((r) => setTimeout(r, 20));
    expect(getMode()).toBe('background');
    expect(second.channels()).toContain('mode-changed');
  });

  it('falls back to interactive on a corrupted mode file and still boots', async () => {
    const dir = tmp();
    fs.writeFileSync(fileIn(dir), '{not json at all');
    boot({ file: fileIn(dir) });
    await new Promise((r) => setTimeout(r, 20));
    expect(getMode()).toBe('interactive');
  });

  it('rejects unknown modes instead of silently accepting them', async () => {
    boot();
    await expect(setMode('stealth' as never)).rejects.toThrow(/Unknown mode/);
    expect(getMode()).toBe('interactive');
  });

  it('toggleMode flips between the two modes', async () => {
    boot();
    await toggleMode();
    expect(getMode()).toBe('background');
    await toggleMode();
    expect(getMode()).toBe('interactive');
  });
});

describe('interactive mode: live feed', () => {
  it('pushes every event to the HUD immediately with id and timestamp', () => {
    const t = boot();
    const ev = emitActivity({ kind: 'tool', label: 'read_file', detail: 'notes.txt', status: 'busy' });
    expect(ev.id).toBeGreaterThan(0);
    expect(ev.t).toBeGreaterThan(0);
    const live = t.pushes.filter((p) => p.channel === 'jarvis-activity');
    expect(live).toHaveLength(1);
    expect((live[0].payload as ActivityEvent).label).toBe('read_file');
    // and it is kept for a renderer's initial pull
    expect(modeInfo().events.some((e) => e.id === ev.id)).toBe(true);
  });

  it('an interactive turn ends without any notification (the user watched it)', () => {
    const t = boot();
    beginTurn('summarise the report');
    emitActivity({ kind: 'tool', label: 'read_file', status: 'ok' });
    expect(endTurn({ reply: 'Done, sir.' })).toBeNull();
    expect(t.notes).toHaveLength(0);
    expect(t.channels()).not.toContain('jarvis-notify');
  });
});

describe('background mode: silence + end-of-turn notification', () => {
  it('buffers events silently, then notifies once with the honest counts', async () => {
    const t = boot();
    await setMode('background');
    t.pushes.length = 0;
    beginTurn('research drone suppliers');
    emitActivity({ kind: 'tool', label: 'web_search', status: 'busy' });
    emitActivity({ kind: 'tool', label: 'web_search', status: 'ok', ms: 812 });
    emitActivity({ kind: 'tool', label: 'fetch_url', status: 'fail' });
    // nothing leaks while working
    expect(t.channels()).not.toContain('jarvis-activity');
    const p = endTurn({ reply: 'Three suppliers shortlisted, sir.' });
    expect(p).not.toBeNull();
    expect(t.notes).toHaveLength(1);
    expect(t.channels()).toContain('jarvis-notify');
    expect(p?.steps).toBe(3);
    expect(p?.failures).toBe(1);
    expect(p?.ok).toBe(true);
    expect(p?.body).toContain('Three suppliers');
    expect(p?.body).toContain('1 of 3 steps failed');
  });

  it('a background turn still updates the ring buffer for the initial feed pull', async () => {
    boot();
    await setMode('background');
    beginTurn('t');
    const ev = emitActivity({ kind: 'tool', label: 'list_files', status: 'ok' });
    endTurn({ reply: 'ok' });
    expect(modeInfo().events.some((e) => e.id === ev.id)).toBe(true);
  });

  it('switching to background MID-TURN still delivers the end notification', () => {
    const t = boot();
    beginTurn('long task');
    emitActivity({ kind: 'tool', label: 'read_file', status: 'ok' });
    void setMode('background');
    emitActivity({ kind: 'tool', label: 'web_search', status: 'ok' });
    expect(endTurn({ reply: 'Finished.' })).not.toBeNull();
    expect(t.notes).toHaveLength(1);
  });

  it('switching to background AFTER the turn does not notify a past interactive turn', () => {
    const t = boot();
    beginTurn('quick question');
    emitActivity({ kind: 'tool', label: 'get_current_time', status: 'ok' });
    expect(endTurn({ reply: 'It is noon, sir.' })).toBeNull();
    expect(t.notes).toHaveLength(0);
  });

  it('an interrupted background turn says interrupted, not done', async () => {
    const t = boot();
    await setMode('background');
    beginTurn('big build');
    emitActivity({ kind: 'tool', label: 'write_file', status: 'ok' });
    const p = endTurn({ interrupted: true });
    expect(p?.interrupted).toBe(true);
    expect(p?.ok).toBe(false);
    expect(p?.title).toMatch(/interrupted/i);
    expect(p?.body).toMatch(/Interrupted after 1 step/);
    expect(t.notes).toHaveLength(1);
  });

  it('a failed background turn reports the failure honestly', async () => {
    const t = boot();
    await setMode('background');
    beginTurn('fix the bug');
    emitActivity({ kind: 'tool', label: 'run_command', status: 'fail' });
    const p = endTurn({ failed: true, error: 'tests still failing' });
    expect(p?.ok).toBe(false);
    expect(p?.title).toMatch(/could not finish/i);
    expect(p?.body).toContain('tests still failing');
  });
});

describe('speech gate', () => {
  it('lets speech through in interactive mode', () => {
    boot();
    expect(holdSpeech('Sir, your timer has elapsed.')).toBe(false);
  });

  it('holds speech in background mode and records the hold honestly', async () => {
    const t = boot();
    await setMode('background');
    beginTurn('set a timer');
    expect(holdSpeech('Sir, your tea timer has elapsed.')).toBe(true);
    const held = modeInfo().events.find((e) => e.status === 'held');
    expect(held?.kind).toBe('speech');
    expect(held?.detail).toContain('tea timer');
    endTurn({ reply: 'ok' });
    expect(t.notes[0]?.held).toBe(1);
  });
});

describe('bulletproofing', () => {
  it('the ring buffer is capped no matter how long the turn runs', () => {
    boot();
    beginTurn('60-round turn');
    for (let i = 0; i < 250; i++) emitActivity({ kind: 'tool', label: `tool_${i}`, status: 'ok' });
    expect(modeInfo().events.length).toBeLessThanOrEqual(100);
    const ids = modeInfo().events.map((e) => e.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids); // monotonic ids survive the cap
    endTurn({ reply: 'done' });
  });

  it('clips oversized labels, details, tasks and replies', async () => {
    boot();
    await setMode('background');
    beginTurn('x'.repeat(500));
    emitActivity({ kind: 'tool', label: 'y'.repeat(500), detail: 'z'.repeat(500), status: 'ok' });
    const p = endTurn({ reply: 'r'.repeat(2000) });
    expect(p?.task.length).toBeLessThanOrEqual(161);
    expect(p?.reply.length).toBeLessThanOrEqual(301);
    const ev = modeInfo().events.find((e) => e.label.startsWith('y'));
    expect(ev?.label.length).toBeLessThanOrEqual(141);
    expect(ev?.detail?.length).toBeLessThanOrEqual(241);
  });

  it('a throwing sink never breaks the tool run being reported', () => {
    void initModes({ sink: () => { throw new Error('renderer gone'); } });
    expect(() => emitActivity({ kind: 'tool', label: 'read_file', status: 'ok' })).not.toThrow();
    expect(() => endTurn({ reply: 'fine' })).not.toThrow();
  });

  it('a throwing native notifier never fails the turn', async () => {
    void initModes({ notify: () => { throw new Error('no OS notifications'); } });
    await setMode('background');
    beginTurn('notify test');
    expect(() => endTurn({ reply: 'done, sir.' })).not.toThrow();
  });

  it('endTurn without a turn is a no-op (quick answers never notify)', () => {
    boot();
    expect(endTurn({ reply: 'hello' })).toBeNull();
  });

  it('concurrent setMode calls all land in the persisted state', async () => {
    const dir = tmp();
    boot({ file: fileIn(dir) });
    await Promise.all([setMode('background'), setMode('interactive'), setMode('background')]);
    await new Promise((r) => setTimeout(r, 20));
    expect(getMode()).toBe('background');
    expect(fs.readFileSync(fileIn(dir), 'utf8')).toContain('"background"');
  });
});
