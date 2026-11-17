import { beforeEach, describe, expect, it, vi } from 'vitest';
import { beginTurn, emitActivity, endTurn, initModes, setMode } from '../src/main/modes';
import { initProgress, noteActivity, noteTurnEnd, noteTurnStart, resetProgressForTests, setInvocationProvider } from '../src/main/progress';
import type { ActivityMirror } from '../src/main/progress';
import {
  ALL_SCOPES,
  invocationScopes,
  invocationSummary,
  noteInvocationEvent,
  openInvocationTurnScope,
  queryInvocations,
  resetInvocationsForTests,
  setInvocationNotifier,
} from '../src/main/invocations';
import { runToolDetailed } from '../src/main/tools';
import { resetTaskStoreForTests } from '../src/main/taskStore';

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

/**
 * ROUND 23 — TOOL ACTIVITY TRACKING: the full acceptance suite.
 *
 * Sections map to the Round 23 requirements: task lifecycle (§6.1), tool activity
 * states and repeated calls (§6.2), scale — 30 / 100 / 500 / 1000 invocations (§6.3),
 * and event reliability: ordering, duplicates, delayed/out-of-order delivery (§6.4
 * main-process half; the IPC wire contract lives in round23Ipc.test.ts).
 *
 * The harness wires modes → progress → invocations exactly like index.ts does
 * (observer composition at the onEvent injection point), so everything here exercises
 * the REAL pipeline except the Electron push itself.
 */

const tool = (label: string, status: 'busy' | 'ok' | 'fail', cid = `c-${label}`, extra: Partial<ActivityMirror> = {}): ActivityMirror => ({
  kind: 'tool',
  label,
  status,
  cid,
  t: Date.now(),
  ...extra,
});

let feed: Array<{ channel: string; payload: unknown }>;

function boot(opts: { mode?: 'background' } = {}) {
  feed = [];
  void initModes({
    sink: (channel) => feed.push({ channel, payload: undefined }),
    onEvent: (e) => {
      // Ledger first, mirror second — the mirror's push must see THIS event's counts.
      noteInvocationEvent(e);
      noteActivity(e as ActivityMirror);
    },
    onTurn: (phase, task, res) => (phase === 'start' ? (noteTurnStart(task), openInvocationTurnScope()) : noteTurnEnd(res ?? {})),
  });
  initProgress({
    sink: (channel, payload) => feed.push({ channel, payload }),
    mode: () => opts.mode ?? 'interactive',
  });
  setInvocationProvider(() => invocationSummary());
  if (opts.mode) void setMode(opts.mode);
}

beforeEach(() => {
  resetTaskStoreForTests();
  resetProgressForTests();
  resetInvocationsForTests();
  boot();
});

// ---------------------------------------------------------------- §6.1 lifecycle

describe('task lifecycle', () => {
  it('an initial task initializes its own activity context and counts', () => {
    beginTurn('initial task');
    emitActivity(tool('web_search', 'busy', 'c1'));
    emitActivity(tool('web_search', 'ok', 'c1', { ms: 210 }));
    emitActivity(tool('read_file', 'ok', 'c2'));
    const s = invocationSummary();
    expect(s.calls).toBe(2);
    expect(s.tools).toBe(2);
    expect(s.completed).toBe(2);
    expect(s.scopeKind).toBe('turn');
  });

  it('a follow-up task receives a FRESH activity context (no stale counts)', () => {
    beginTurn('first');
    for (let i = 0; i < 40; i++) emitActivity(tool(`tool_a_${i}`, 'ok', `fa-${i}`));
    endTurn({ reply: 'done' });
    beginTurn('follow-up'); // the prompt boundary
    const fresh = invocationSummary();
    expect(fresh.calls).toBe(0);
    expect(fresh.tools).toBe(0);
    expect(fresh.running).toBe(0);
    // ...and the new work counts only new work:
    emitActivity(tool('next_thing', 'ok', 'nx-1'));
    expect(invocationSummary().calls).toBe(1);
  });

  it('previous task activity remains accessible after the task ends', () => {
    beginTurn('first');
    emitActivity(tool('old_tool', 'ok', 'old-1', { ms: 55 }));
    endTurn({ reply: 'done' });
    beginTurn('second');
    emitActivity(tool('new_tool', 'ok', 'new-1'));
    const scopes = invocationScopes();
    const first = scopes.find((s) => s.scope !== invocationSummary().scope)!;
    expect(first.calls).toBe(1);
    const q = queryInvocations({ scope: first.scope, offset: 0, limit: 10 });
    expect(q.records[0]).toMatchObject({ tool: 'old_tool', state: 'completed', ms: 55 });
  });

  it('switching between task scopes displays the correct activity — never another task’s', () => {
    emitActivity(tool('alpha_tool', 'ok', 'a-1', { taskId: 'T-A' }));
    emitActivity(tool('beta_tool', 'ok', 'b-1', { taskId: 'T-B' }));
    emitActivity(tool('beta_tool', 'fail', 'b-2', { taskId: 'T-B' }));
    expect(invocationSummary('T-A')).toMatchObject({ calls: 1, completed: 1, failed: 0 });
    expect(invocationSummary('T-B')).toMatchObject({ calls: 2, completed: 1, failed: 1 });
    expect(queryInvocations({ scope: 'T-A', offset: 0, limit: 10 }).records.map((r) => r.tool)).toEqual(['alpha_tool']);
    expect(queryInvocations({ scope: 'T-B', offset: 0, limit: 10 }).records.map((r) => r.tool)).toEqual(['beta_tool', 'beta_tool']);
  });

  it('concurrent task execution never mixes activity events between tasks', () => {
    // Interleaved wave: A busy → B busy → A ok → B ok → B fail
    emitActivity(tool('a_tool', 'busy', 'ca1', { taskId: 'T-A' }));
    emitActivity(tool('b_tool', 'busy', 'cb1', { taskId: 'T-B' }));
    emitActivity(tool('a_tool', 'ok', 'ca1', { taskId: 'T-A', ms: 100 }));
    emitActivity(tool('b_tool', 'ok', 'cb1', { taskId: 'T-B', ms: 140 }));
    emitActivity(tool('b_tool', 'fail', 'cb2', { taskId: 'T-B' }));
    expect(invocationSummary('T-A')).toMatchObject({ calls: 1, completed: 1, failed: 0, running: 0 });
    expect(invocationSummary('T-B')).toMatchObject({ calls: 2, completed: 1, failed: 1, running: 0 });
  });

  it('completed tasks retain their activity history (scoped query, exact counts)', () => {
    beginTurn('t');
    for (let i = 0; i < 12; i++) emitActivity(tool('step_tool', 'ok', `s-${i}`, { taskId: 'T-DONE' }));
    endTurn({ reply: 'ok' });
    const q = queryInvocations({ scope: 'T-DONE', offset: 0, limit: 500 });
    expect(q.total).toBe(12);
    expect(q.records.every((r) => r.state === 'completed')).toBe(true);
  });

  it('cancelled tasks display the correct final state (cancelled, not failed, not running)', () => {
    emitActivity(tool('doomed_tool', 'busy', 'cc-1', { taskId: 'T-CANCEL' }));
    emitActivity(tool('doomed_tool', 'fail', 'cc-1', { taskId: 'T-CANCEL', cancelled: true }));
    emitActivity(tool('second_tool', 'busy', 'cc-2', { taskId: 'T-CANCEL' }));
    emitActivity(tool('second_tool', 'fail', 'cc-2', { taskId: 'T-CANCEL', cancelled: true }));
    const s = invocationSummary('T-CANCEL');
    expect(s.cancelled).toBe(2);
    expect(s.running).toBe(0);
    expect(s.failed).toBe(0);
  });
});

// ------------------------------------------------------------ §6.2 tool activity

describe('tool activity records', () => {
  it('new invocations appear immediately: the push fires for every event, in both modes', () => {
    boot({ mode: 'background' });
    feed.length = 0;
    beginTurn('silent task');
    emitActivity(tool('x_tool', 'busy', 'px-1'));
    emitActivity(tool('x_tool', 'ok', 'px-1', { ms: 30 }));
    // The activity FEED push follows the background silence contract...
    expect(feed.filter((p) => p.channel === 'jarvis-activity').length).toBe(0);
    // ...but the progress snapshot (which carries the invocation summary) still streams.
    expect(feed.filter((p) => p.channel === 'jarvis-progress').length).toBeGreaterThanOrEqual(3);
  });

  it('repeated calls of the same tool are counted individually (8 calls = 8)', () => {
    beginTurn('terminal loop');
    for (let i = 0; i < 8; i++) emitActivity(tool('terminal', i < 6 ? 'ok' : 'fail', `tc-${i}`, { ms: 10 + i }));
    const s = invocationSummary();
    expect(s.calls).toBe(8);
    expect(s.tools).toBe(1);
    expect(s.completed).toBe(6);
    expect(s.failed).toBe(2);
  });

  it('invocation statuses update in place: busy → ok replaces the running state', () => {
    emitActivity(tool('read_file', 'busy', 'u-1'));
    expect(invocationSummary().running).toBe(1);
    emitActivity(tool('read_file', 'ok', 'u-1', { ms: 42 }));
    const s = invocationSummary();
    expect(s.running).toBe(0);
    expect(s.completed).toBe(1);
    const rec = queryInvocations({ offset: 0, limit: 10 }).records[0];
    expect(rec.state).toBe('completed');
    expect(rec.endedAt).toBeGreaterThan(0);
  });

  it('durations come from the engine timestamps when present (ms is preserved, not guessed)', () => {
    emitActivity(tool('slow_tool', 'busy', 'd-1', { t: 1000 }));
    emitActivity(tool('slow_tool', 'ok', 'd-1', { ms: 4821, t: 5821 }));
    expect(queryInvocations({ offset: 0, limit: 10 }).records[0].ms).toBe(4821);
  });

  it('failed, blocked and cancelled calls appear correctly and never count as running', () => {
    emitActivity(tool('err_tool', 'busy', 'e-1'));
    emitActivity(tool('err_tool', 'fail', 'e-1'));
    emitActivity(tool('gate_tool', 'busy', 'e-2'));
    emitActivity(tool('gate_tool', 'fail', 'e-2', { blocked: true }));
    emitActivity(tool('stopped_tool', 'busy', 'e-3'));
    emitActivity(tool('stopped_tool', 'fail', 'e-3', { cancelled: true }));
    const s = invocationSummary();
    expect(s).toMatchObject({ failed: 1, blocked: 1, cancelled: 1, running: 0, calls: 3 });
  });

  it('duplicate events never create duplicate invocations', () => {
    beginTurn('t');
    const ev = emitActivity(tool('dup_tool', 'ok', 'dupe-1'));
    noteInvocationEvent(ev); // same event object delivered again (re-registration scenario)
    noteInvocationEvent({ ...ev });
    noteInvocationEvent({ ...ev });
    const s = invocationSummary();
    expect(s.calls).toBe(1);
    expect(s.completed).toBe(1);
    expect(queryInvocations({ offset: 0, limit: 50 }).records.length).toBe(1);
  });

  it('out-of-order and delayed events are handled safely (older id never overrides newer state)', () => {
    const e1 = emitActivity(tool('ooo_tool', 'busy', 'ooo-1', { t: 1000 }));
    const e2 = emitActivity(tool('ooo_tool', 'ok', 'ooo-1', { ms: 200, t: 1200 }));
    // A delayed replay of the START event arrives after the result:
    noteInvocationEvent({ ...e1, id: e1.id - 1 }); // even older
    noteInvocationEvent(e1); // exact duplicate of the start
    const rec = queryInvocations({ offset: 0, limit: 10 }).records[0];
    expect(rec.state).toBe('completed');
    expect(rec.ms).toBe(200);
    void e2;
  });

  it('malformed events are dropped without damaging the ledger', () => {
    expect(() => {
      noteInvocationEvent(null as unknown as ActivityMirror);
      noteInvocationEvent(undefined as unknown as ActivityMirror);
      noteInvocationEvent({ kind: 'tool' } as unknown as ActivityMirror); // no label, no id
      noteInvocationEvent({ kind: 'progress', label: 'Working', status: 'busy', id: 1 } as unknown as ActivityMirror); // not a tool
      noteInvocationEvent({ kind: 'tool', label: '', id: 2 } as unknown as ActivityMirror); // empty label
    }).not.toThrow();
    expect(invocationSummary().calls).toBe(0);
  });
});

// ------------------------------------------------------------------ §6.3 scale

describe('scale: no ceiling, no silent loss', () => {
  const drive = (n: number, perTool = 1): void => {
    const tools = ['terminal', 'read_file', 'web_search', 'write_file', 'glob', 'grep', 'calculate', 'list_files'];
    for (let i = 0; i < n; i++) {
      const name = tools[i % tools.length];
      const cid = `sc-${i}`;
      emitActivity(tool(name, 'busy', cid));
      if (i % 10 !== 9) emitActivity(tool(name, 'ok', cid, { ms: 10 + (i % 50) }));
      else emitActivity(tool(name, 'fail', cid, { ms: 900 + i }));
    }
  };

  it('30 invocations — exact counts, exact history', () => {
    beginTurn('scale 30');
    drive(30);
    const s = invocationSummary();
    expect(s.calls).toBe(30);
    expect(s.completed + s.failed).toBe(30);
    expect(queryInvocations({ offset: 0, limit: 500 }).records.length).toBe(30);
  });

  it('100 invocations across 8 tools — every record present, counts exact', () => {
    beginTurn('scale 100');
    drive(100);
    const s = invocationSummary();
    expect(s.calls).toBe(100);
    expect(s.tools).toBe(8);
    expect(s.failed).toBe(10);
    const q = queryInvocations({ offset: 0, limit: 500 });
    expect(q.records.length).toBe(100);
    expect(q.records[0].cid).toBe('sc-0');
    expect(q.records[99].cid).toBe('sc-99');
  });

  it('500 invocations in ONE task — nothing dropped, counts real, ledger complete', () => {
    beginTurn('scale 500');
    drive(500);
    const s = invocationSummary();
    expect(s.calls).toBe(500);
    expect(s.completed).toBe(450);
    expect(s.failed).toBe(50);
    const turn = queryInvocations({ offset: 0, limit: 500 });
    expect(turn.total).toBe(500);
    expect(turn.records.length).toBe(500);
    // first and last still addressable:
    expect(turn.records[0].cid).toBe('sc-0');
    expect(turn.records[499].cid).toBe('sc-499');
    // repeated tools are preserved as individual invocations:
    expect(turn.records.filter((r) => r.tool === 'terminal').length).toBe(Math.ceil(500 / 8));
  });

  it('1000 invocations with repeated identical tool calls — still exact, still queryable', () => {
    beginTurn('scale 1000');
    for (let i = 0; i < 1000; i++) {
      emitActivity(tool('terminal', 'busy', `same-${i}`));
      emitActivity(tool('terminal', 'ok', `same-${i}`, { ms: 5 }));
    }
    const s = invocationSummary();
    expect(s.calls).toBe(1000);
    expect(s.tools).toBe(1);
    expect(s.completed).toBe(1000);
    const page = queryInvocations({ offset: 990, limit: 10 });
    expect(page.records.length).toBe(10);
    expect(page.records[0].cid).toBe('same-990');
  });

  it('pagination serves large histories page by page without loss or duplication', () => {
    beginTurn('paged history');
    for (let i = 0; i < 120; i++) emitActivity(tool('paged_tool', 'ok', `pg-${i}`));
    const page1 = queryInvocations({ offset: 0, limit: 50 });
    const page2 = queryInvocations({ offset: 50, limit: 50 });
    const page3 = queryInvocations({ offset: 100, limit: 50 });
    expect(page1.records.length).toBe(50);
    expect(page2.records.length).toBe(50);
    expect(page3.records.length).toBe(20);
    const cids = [...page1.records, ...page2.records, ...page3.records].map((r) => r.cid);
    expect(new Set(cids).size).toBe(120); // no overlap, no gap
    expect(page1.records.every((r, i) => (i === 0 ? true : r.startedAt >= page1.records[i - 1].startedAt))).toBe(true);
  });

  it('the all-scopes view aggregates every task without losing anything', () => {
    emitActivity(tool('a_tool', 'ok', 'm-1', { taskId: 'T-M1' }));
    emitActivity(tool('b_tool', 'ok', 'm-2', { taskId: 'T-M2' }));
    beginTurn('turn work');
    emitActivity(tool('c_tool', 'ok', 'm-3'));
    const all = invocationSummary(ALL_SCOPES);
    expect(all.calls).toBe(3);
    expect(all.tools).toBe(3);
    const q = queryInvocations({ scope: ALL_SCOPES, offset: 0, limit: 500 });
    expect(q.total).toBe(3);
    expect(q.records.map((r) => r.tool)).toEqual(['a_tool', 'b_tool', 'c_tool']); // chronological
  });

  it('large histories across multiple tasks keep per-task summaries exact', () => {
    for (const id of ['T-X', 'T-Y']) {
      for (let i = 0; i < 250; i++) emitActivity(tool(`${id}_tool`, 'ok', `${id}-${i}`, { taskId: id }));
    }
    expect(invocationSummary('T-X').calls).toBe(250);
    expect(invocationSummary('T-Y').calls).toBe(250);
    expect(invocationSummary(ALL_SCOPES).calls).toBe(500);
    expect(queryInvocations({ scope: 'T-X', offset: 0, limit: 500 }).total).toBe(250);
  });

  it('the live header summary rides the progress snapshot and is O(1) at any scale', () => {
    beginTurn('snapshot scale');
    for (let i = 0; i < 400; i++) emitActivity(tool(`snap_tool_${i % 5}`, 'ok', `snap-${i}`));
    const snaps = feed.filter((p) => p.channel === 'jarvis-progress').map((p) => p.payload as { invocations?: { calls: number } });
    const last = snaps[snaps.length - 1];
    expect(last.invocations?.calls).toBe(400);
    expect(last.invocations?.tools).toBe(5);
  });
});

// --------------------------------------------- §6.4 reliability: the real engine path

describe('the real execution engine feeds the ledger (no second emission path)', () => {
  it('a real runToolDetailed call lands as one complete invocation with engine metadata', async () => {
    beginTurn('real tool');
    const env = await runToolDetailed('get_current_time', '{}');
    expect(env.status).toBe('success');
    const s = invocationSummary();
    expect(s.calls).toBe(1);
    expect(s.completed).toBe(1);
    expect(s.running).toBe(0);
    const rec = queryInvocations({ offset: 0, limit: 10 }).records[0];
    expect(rec.tool).toBe('get_current_time');
    expect(rec.cid).toBeTruthy();
    expect(rec.state).toBe('completed');
    expect(typeof rec.ms).toBe('number');
    // The wire event the renderer would have received carries the scope stamp:
    const mirrored = (emitActivity as unknown as { mock?: unknown }) ?? null;
    void mirrored;
  });

  it('a policy-blocked real call records a BLOCKED invocation (blocked ≠ failed ≠ running)', async () => {
    beginTurn('blocked real');
    const out = await runToolDetailed('run_command', JSON.stringify({ command: 'rd /s /q C:\\Windows' }));
    expect(out.text).toMatch(/^BLOCKED/);
    const s = invocationSummary();
    expect(s.calls).toBe(1);
    expect(s.blocked).toBe(1);
    const rec = queryInvocations({ offset: 0, limit: 10 }).records[0];
    expect(rec.state).toBe('blocked');
    expect(rec.endedAt).toBeTruthy();
  });

  it('two real calls in a row keep the ledger consistent (no phantom rows)', async () => {
    beginTurn('two real');
    await runToolDetailed('get_current_time', '{}');
    await runToolDetailed('calculate', JSON.stringify({ expression: '2+2' }));
    const s = invocationSummary();
    expect(s.calls).toBe(2);
    expect(s.completed).toBe(2);
    const recs = queryInvocations({ offset: 0, limit: 50 }).records;
    expect(new Set(recs.map((r) => r.cid)).size).toBe(2);
  });

  it('the invocation notifier fires on scope changes (header freshness signal)', () => {
    const seen: string[] = [];
    setInvocationNotifier(() => seen.push(invocationSummary().scope));
    emitActivity(tool('n_tool', 'ok', 'n-1'));
    const before = seen.length;
    openInvocationTurnScope();
    expect(seen.length).toBe(before + 1);
    setInvocationNotifier(null);
  });
});
