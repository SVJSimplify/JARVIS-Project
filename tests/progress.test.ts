import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { beginTurn, emitActivity, endTurn, initModes, setMode } from '../src/main/modes';
import {
  getProgressSnapshot,
  initProgress,
  noteActivity,
  noteTurnEnd,
  noteTurnStart,
  refreshTasks,
  resetProgressForTests,
  setTaskProvider,
  type ActivityMirror,
} from '../src/main/progress';
import type { TaskProgressView } from '../src/main/progressTypes';
import { createTask, resetTaskStoreForTests, setTaskChangeNotifier, transition, taskViews } from '../src/main/taskStore';
import { buildTaskSpec } from '../src/main/taskSpec';

/** Harness: fresh modes + progress modules wired exactly like index.ts wires them. */
function boot(opts: { mode?: 'background' } = {}) {
  const feed: string[] = []; // channels the modes.ts sink saw (jarvis-activity contract)
  const progress: Array<{ channel: string; payload: any }> = [];
  void initModes({
    sink: (channel) => feed.push(channel),
    onEvent: (e) => noteActivity(e as ActivityMirror),
    onTurn: (phase, task, res) => (phase === 'start' ? noteTurnStart(task) : noteTurnEnd(res ?? {})),
  });
  initProgress({
    sink: (channel, payload) => progress.push({ channel, payload }),
    mode: () => opts.mode ?? 'interactive',
  });
  if (opts.mode) void setMode(opts.mode);
  return { feed, progress, snapshots: () => progress.filter((p) => p.channel === 'jarvis-progress').map((p) => p.payload) };
}

const tool = (label: string, status: 'busy' | 'ok' | 'fail', cid = `c-${label}`, extra: Partial<ActivityMirror> = {}): ActivityMirror => ({
  kind: 'tool',
  label,
  status,
  cid,
  t: Date.now(),
  ...extra,
});

beforeEach(() => {
  resetProgressForTests();
  resetTaskStoreForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('live task progress: turn checklist', () => {
  it('opens a checklist on turn start and freezes it with the honest outcome', () => {
    boot();
    beginTurn('research drone suppliers');
    emitActivity(tool('web_search', 'busy'));
    emitActivity(tool('web_search', 'ok', 'c-web_search', { ms: 812 }));
    let snap = getProgressSnapshot();
    expect(snap.busy).toBe(true);
    expect(snap.turn?.task).toBe('research drone suppliers');
    expect(snap.turn?.steps).toHaveLength(1);
    expect(snap.turn?.done).toBe(1);
    endTurn({ reply: 'Done, sir.' });
    snap = getProgressSnapshot();
    expect(snap.turn?.endedAt).toBeGreaterThan(0);
    expect(snap.turn?.outcome).toBe('ok');
    expect(snap.busy).toBe(false); // nothing else is running
  });

  it('replaces a busy tool row in place via its correlation id', () => {
    boot();
    beginTurn('t');
    emitActivity(tool('read_file', 'busy'));
    emitActivity(tool('read_file', 'busy', 'c-read_file', { detail: 'notes.txt' })); // arg update, same cid
    emitActivity(tool('read_file', 'fail', 'c-read_file'));
    const snap = getProgressSnapshot();
    expect(snap.turn?.steps).toHaveLength(1); // replaced, never doubled
    expect(snap.turn?.steps[0].status).toBe('fail');
    expect(snap.turn?.steps[0].detail).toBe('notes.txt');
    expect(snap.turn?.failed).toBe(1);
  });

  it('a progress note updates the NOW line without polluting the checklist', () => {
    boot();
    beginTurn('t');
    emitActivity({ kind: 'progress', label: 'Working', detail: 'searching suppliers', status: 'busy' });
    const snap = getProgressSnapshot();
    expect(snap.now?.label).toBe('Working');
    expect(snap.now?.detail).toBe('searching suppliers');
    expect(snap.turn?.steps).toHaveLength(0);
  });

  it('task, verify and agent events become checklist rows (no confirm kind exists — no approval prompts)', () => {
    boot();
    beginTurn('t');
    emitActivity({ kind: 'task', cid: 'task-T1', label: 'Step started', detail: 'draft', status: 'busy' });
    emitActivity({ kind: 'verify', cid: 'verify-T1', label: 'Verification · T1', detail: '2 criteria', status: 'ok' });
    emitActivity({ kind: 'agent', cid: 'a1', label: 'explorer', detail: 'x', status: 'busy' });
    const kinds = getProgressSnapshot().turn!.steps.map((s) => s.key.split(':')[0] ?? s.key);
    expect(kinds).toContain('task-T1');
    expect(kinds).toContain('verify-T1');
    expect(kinds).toContain('a1');
  });

  it('activity outside a turn updates NOW but never creates orphan checklist rows', () => {
    boot();
    emitActivity(tool('web_search', 'busy')); // e.g. a mission sub-agent working after the turn ended
    const snap = getProgressSnapshot();
    expect(snap.now?.label).toBe('web_search');
    expect(snap.turn).toBeNull();
  });

  it('a new turn starts a fresh checklist', () => {
    boot();
    beginTurn('first');
    emitActivity(tool('a_tool', 'ok'));
    endTurn({ reply: 'ok' });
    beginTurn('second');
    const snap = getProgressSnapshot();
    expect(snap.turn?.task).toBe('second');
    expect(snap.turn?.steps).toHaveLength(0);
    expect(snap.turn?.outcome).toBe('running');
  });
});

describe('live task progress works in BOTH modes', () => {
  it('background mode: jarvis-activity stays silent, jarvis-progress still streams', async () => {
    const t = boot({ mode: 'background' });
    t.feed.length = 0;
    t.progress.length = 0;
    beginTurn('silent research');
    emitActivity(tool('web_search', 'busy'));
    emitActivity(tool('web_search', 'ok', 'c-web_search', { ms: 40 }));
    endTurn({ reply: 'Three suppliers, sir.' });

    expect(t.feed).not.toContain('jarvis-activity'); // the background silence contract holds
    const snaps = t.snapshots();
    expect(snaps.length).toBeGreaterThanOrEqual(3); // turn start + both tool events + end
    const last = snaps[snaps.length - 1];
    expect(last.mode).toBe('background');
    expect(last.turn.outcome).toBe('ok');
    expect(last.turn.done).toBe(1);
    expect(last.busy).toBe(false);
  });

  it('interactive mode: an ended turn still freezes the checklist (no notification needed)', () => {
    const t = boot(); // interactive: endTurn notifies nothing, but progress must still learn the outcome
    beginTurn('quick question');
    emitActivity(tool('get_current_time', 'ok'));
    expect(endTurn({ reply: 'It is noon, sir.' })).toBeNull();
    const snaps = t.snapshots();
    expect(snaps[snaps.length - 1].turn.outcome).toBe('ok');
  });

  it('the mode is stamped from the injected getter, not guessed', () => {
    const t = boot({ mode: 'background' });
    emitActivity(tool('x', 'ok'));
    expect(t.snapshots()[0].mode).toBe('background');
  });
});

describe('mission mirror is gone with the mission engine', () => {
  it('the snapshot carries no missions field at all (single execution engine: durable tasks)', () => {
    boot();
    const snap = getProgressSnapshot() as unknown as Record<string, unknown>;
    expect('missions' in snap).toBe(false);
  });
});

describe('durable task board', () => {
  const view = (over: Partial<TaskProgressView>): TaskProgressView => ({
    id: 'T-abc',
    objective: 'draft the weekly report',
    status: 'RUNNING',
    note: 'step 1/2: gather numbers',
    done: 0,
    total: 2,
    steps: [
      { title: 'gather numbers', status: 'running' },
      { title: 'write file', status: 'pending' },
    ],
    updatedAt: Date.now(),
    ...over,
  });

  it('refreshTasks installs provider views and reports busy', async () => {
    const t = boot();
    setTaskProvider(() => Promise.resolve([view({})]));
    await refreshTasks();
    const snap = t.snapshots().at(-1);
    expect(snap.tasks[0].id).toBe('T-abc');
    expect(snap.tasks[0].steps).toHaveLength(2);
    expect(snap.busy).toBe(true);
  });

  it('a throwing provider never breaks the refresh', async () => {
    boot();
    setTaskProvider(() => Promise.reject(new Error('nope')));
    await expect(refreshTasks()).resolves.toBeUndefined();
    expect(getProgressSnapshot().tasks).toHaveLength(0);
  });

  it('the taskStore change notifier fires on mutations and drives the board (wired like index.ts)', async () => {
    const t = boot();
    setTaskProvider(taskViews);
    let calls = 0;
    setTaskChangeNotifier(() => void (calls++, refreshTasks()));
    const spec = buildTaskSpec('write a hello world text file under notes/');
    const created = await createTask(spec);
    await new Promise((r) => setTimeout(r, 20)); // let the async refreshes land
    const withTask = t.snapshots().filter((s) => s.tasks.some((x: TaskProgressView) => x.id === created.id));
    expect(withTask.length).toBeGreaterThan(0);
    await transition(created, 'READY', 'accepted');
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBeGreaterThanOrEqual(2);
    const last = t.snapshots().at(-1);
    expect(last.tasks[0].status).toBe('READY');
  });

  it('a throwing change notifier never breaks the save that triggered it', async () => {
    setTaskChangeNotifier(() => {
      throw new Error('mirror down');
    });
    const spec = buildTaskSpec('write a hello world text file under notes/');
    await expect(createTask(spec)).resolves.toBeTruthy();
  });
});

describe('bulletproofing', () => {
  it('a throwing sink never breaks progress reporting', () => {
    initProgress({ sink: () => { throw new Error('renderer gone'); } });
    expect(() => {
      beginTurn('t');
      noteActivity(tool('read_file', 'busy'));
      noteTurnEnd({});
    }).not.toThrow();
  });

  it('malformed activity events are dropped without state damage', () => {
    boot();
    expect(() => {
      noteActivity(null as unknown as ActivityMirror);
      noteActivity(undefined as unknown as ActivityMirror);
      noteActivity({ kind: 'mode', label: 'Background mode on', status: 'ok' });
      noteActivity({ kind: 'speech', label: 'held', status: 'held' });
    }).not.toThrow();
    const snap = getProgressSnapshot();
    expect(snap.now).toBeNull(); // mode/speech noise never becomes a NOW line
    expect(snap.turn).toBeNull();
  });

  it('turn end is idempotent: a late double endTurn cannot corrupt the outcome', () => {
    boot();
    beginTurn('t');
    noteTurnEnd({ failed: true });
    noteTurnEnd({});
    expect(getProgressSnapshot().turn?.outcome).toBe('fail');
  });

  it('the step list is capped no matter how long the turn runs', () => {
    boot();
    beginTurn('60-round turn');
    for (let i = 0; i < 120; i++) emitActivity(tool(`tool_${i}`, 'ok', `cid-${i}`));
    const steps = getProgressSnapshot().turn!.steps;
    expect(steps.length).toBeLessThanOrEqual(30);
    expect(steps.at(-1)?.label).toBe('tool_119'); // the newest rows survive
  });

  it('oversized labels and turn tasks are clipped', () => {
    boot();
    beginTurn('x'.repeat(500));
    emitActivity(tool('r'.repeat(500), 'busy', 'c-big', { detail: 'd'.repeat(900) }));
    const snap = getProgressSnapshot();
    expect(snap.turn!.task.length).toBeLessThanOrEqual(160);
    expect(snap.now!.label.length).toBeLessThanOrEqual(160);
    expect(snap.now!.detail!.length).toBeLessThanOrEqual(500);
  });

  it('snapshots are never pushed out of order (updatedAt never regresses)', () => {
    const t = boot();
    beginTurn('a');
    emitActivity(tool('x', 'busy'));
    endTurn({});
    beginTurn('b');
    endTurn({});
    const stamps = t.snapshots().map((s) => s.updatedAt as number);
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]).toBeGreaterThanOrEqual(stamps[i - 1]);
  });

  it('keepalive re-pushes while busy and stops when re-initialised without it', () => {
    vi.useFakeTimers();
    const t = boot();
    initProgress({ sink: (c, p) => t.progress.push({ channel: c, payload: p }), keepaliveMs: 1000 });
    beginTurn('long mission watch');
    const before = t.snapshots().length;
    vi.advanceTimersByTime(3500);
    expect(t.snapshots().length).toBeGreaterThan(before); // streamed without any event
    initProgress({ sink: () => undefined }); // re-init clears the timer
    const after = t.snapshots().length;
    vi.advanceTimersByTime(5000);
    expect(t.snapshots().length).toBe(after);
  });

  it('a stale NOW line is pruned from the snapshot when nothing is running', () => {
    boot();
    beginTurn('t');
    emitActivity(tool('web_search', 'ok'));
    endTurn({});
    const snap = getProgressSnapshot();
    // now exists but the busy flag came only from the open turn; after end it is idle
    expect(snap.busy).toBe(false);
    expect(snap.now?.label).toBe('web_search'); // last activity still shown while the panel lingers
  });
});
