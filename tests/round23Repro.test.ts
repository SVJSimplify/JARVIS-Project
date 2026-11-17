import { describe, expect, it, beforeEach } from 'vitest';
import { beginTurn, emitActivity, endTurn, initModes, modeInfo } from '../src/main/modes';
import {
  getProgressSnapshot,
  initProgress,
  noteActivity,
  noteTurnEnd,
  noteTurnStart,
  resetProgressForTests,
  setInvocationProvider,
  setTaskProvider,
} from '../src/main/progress';
import type { ActivityMirror } from '../src/main/progress';
import {
  invocationScopes,
  invocationSummary,
  noteInvocationEvent,
  openInvocationTurnScope,
  queryInvocations,
  resetInvocationsForTests,
} from '../src/main/invocations';

/**
 * ROUND 23 — ROOT-CAUSE REGRESSIONS (formerly the Phase-1 reproduction suite).
 *
 * Phase 1 ran this suite against the untouched Round 22 code and ESTABLISHED both
 * reported defects mechanically (8/8 assertions confirmed the broken behaviour — see
 * JARVIS_ROUND23_TEST_REPORT.md §1 for the pre-fix evidence):
 *
 *  BUG 1 — "the activity display stops updating after approximately 30 tools":
 *    progress.ts computed done/failed/total FROM its 30-row display window and spliced
 *    everything older away; the modes ring kept only 200 events and served a fresh
 *    subscriber only the last 100.
 *
 *  BUG 2 — "subsequent tasks and follow-up prompts do not correctly refresh activity":
 *    ActivityEvent carried no task identity; durable-task (sub-agent) work never entered
 *    any checklist (no beginTurn); the feed view mixed every task unmarked; cancelled
 *    calls left their "running" row stale forever.
 *
 * These assertions now pin the CORRECTED behaviour. The 30-row checklist RENDER WINDOW
 * stays (a display choice for the floating panel, not a data limit) — the counters are
 * real, the full history lives in the invocation ledger, and every scope is queryable.
 */

const tool = (label: string, status: 'busy' | 'ok' | 'fail', cid = `c-${label}`, extra: Partial<ActivityMirror> = {}): ActivityMirror => ({
  kind: 'tool',
  label,
  status,
  cid,
  t: Date.now(),
  ...extra,
});

function boot() {
  void initModes({
    sink: () => undefined,
    onEvent: (e) => {
      // Ledger first, mirror second — the mirror's push must see THIS event's counts.
      noteInvocationEvent(e);
      noteActivity(e as ActivityMirror);
    },
    onTurn: (phase, task, res) => (phase === 'start' ? (noteTurnStart(task), openInvocationTurnScope()) : noteTurnEnd(res ?? {})),
  });
  initProgress({ sink: () => undefined, mode: () => 'interactive' });
  setInvocationProvider(() => invocationSummary());
}

beforeEach(() => {
  resetProgressForTests();
  resetInvocationsForTests();
  boot();
});

describe('BUG 1 fixed — counts are real at any scale, nothing is lost', () => {
  it('a 120-invocation turn keeps the newest 30 rows in the render window but counts all 120', () => {
    beginTurn('long turn');
    for (let i = 0; i < 120; i++) emitActivity(tool(`tool_${i}`, 'ok', `cid-${i}`));
    const turn = getProgressSnapshot().turn!;
    expect(turn.steps.length).toBe(30); // display window (newest rows)
    expect(turn.steps[0].label).toBe('tool_90'); // newest survive
    expect(turn.done).toBe(120); // REAL total, not the window size
    expect(turn.calls).toBe(120);
  });

  it('500 invocations: every one is in the ledger, counts exact, none dropped', () => {
    beginTurn('500-call turn');
    for (let i = 0; i < 500; i++) emitActivity(tool('terminal', i % 10 === 9 ? 'fail' : 'ok', `cid-${i}`));
    const s = invocationSummary();
    expect(s.calls).toBe(500);
    expect(s.completed).toBe(450);
    expect(s.failed).toBe(50);
    expect(s.tools).toBe(1);
    const q = queryInvocations({ offset: 0, limit: 500 });
    expect(q.total).toBe(500);
    expect(q.records.length).toBe(500);
    expect(q.records[0].cid).toBe('cid-0');
    expect(q.records[499].cid).toBe('cid-499');
  });

  it('a fresh subscriber can reach the whole history through the query API (not just the ring)', () => {
    for (let i = 0; i < 250; i++) emitActivity(tool(`tool_${i}`, 'ok', `cid-${i}`));
    expect(modeInfo().events.length).toBe(100); // the live-feed ring stays bounded by design
    expect(queryInvocations({ offset: 0, limit: 500 }).total).toBe(250); // the history does not
  });

  it('the progress snapshot carries the live invocation summary for the header', () => {
    beginTurn('summary turn');
    emitActivity(tool('web_search', 'ok', 'c1'));
    emitActivity(tool('terminal', 'fail', 'c2'));
    emitActivity(tool('read_file', 'busy', 'c3'));
    const inv = getProgressSnapshot().invocations!;
    expect(inv.calls).toBe(3);
    expect(inv.tools).toBe(3);
    expect(inv.running).toBe(1);
    expect(inv.completed).toBe(1);
    expect(inv.failed).toBe(1);
    expect(inv.scopeKind).toBe('turn');
  });
});

describe('BUG 2 fixed — task-scoped, fresh per prompt, never stale', () => {
  it('activity events can carry their durable task id', () => {
    beginTurn('first task');
    const ev = emitActivity(tool('read_file', 'ok', 'c1', { taskId: 'T-42' }));
    expect(ev.taskId).toBe('T-42');
    const s = invocationSummary('T-42');
    expect(s.scope).toBe('T-42');
    expect(s.scopeKind).toBe('task');
    expect(s.calls).toBe(1);
  });

  it('durable-task (sub-agent) activity is recorded and queryable even with no open turn', () => {
    emitActivity(tool('write_file', 'busy', 't-abc', { taskId: 'T-7' }));
    emitActivity(tool('write_file', 'ok', 't-abc', { taskId: 'T-7', ms: 320 }));
    const snap = getProgressSnapshot();
    expect(snap.now?.label).toBe('write_file');
    const s = invocationSummary('T-7');
    expect(s.calls).toBe(1);
    expect(s.completed).toBe(1);
    expect(queryInvocations({ scope: 'T-7', offset: 0, limit: 10 }).records[0].ms).toBe(320);
  });

  it('every follow-up prompt gets a fresh scope; previous scopes stay queryable', () => {
    beginTurn('first task');
    emitActivity(tool('web_search', 'ok', 'c1'));
    endTurn({ reply: 'done' });
    beginTurn('follow-up task'); // fresh scope opens here
    const fresh = invocationSummary();
    expect(fresh.scope).not.toBe('session');
    expect(fresh.scopeKind).toBe('turn');
    expect(fresh.calls).toBe(0); // clean context for the new prompt
    emitActivity(tool('read_file', 'ok', 'c2'));
    expect(invocationSummary().calls).toBe(1);
    // the earlier scope still exists with its own record — history preserved, not leaked
    const scopes = invocationScopes();
    expect(scopes.length).toBe(2);
    expect(scopes.map((s) => s.calls).sort()).toEqual([1, 1]);
    const firstScope = scopes.find((s) => s.scope !== fresh.scope)!;
    expect(queryInvocations({ scope: firstScope.scope, offset: 0, limit: 10 }).records[0].tool).toBe('web_search');
  });

  it('concurrent task scopes never mix: each summary reflects only its own calls', () => {
    emitActivity(tool('a_tool', 'ok', 'ca', { taskId: 'T-1' }));
    emitActivity(tool('b_tool', 'busy', 'cb', { taskId: 'T-2' }));
    emitActivity(tool('b_tool', 'ok', 'cb', { taskId: 'T-2' }));
    expect(invocationSummary('T-1')).toMatchObject({ calls: 1, completed: 1 });
    expect(invocationSummary('T-2')).toMatchObject({ calls: 1, completed: 1 });
    expect(new Set(invocationScopes().map((s) => s.scope))).toEqual(new Set(['T-1', 'T-2']));
  });

  it('cancelled and blocked invocations reach their true terminal state (no stale running row)', () => {
    beginTurn('t');
    emitActivity(tool('write_file', 'busy', 'c-run'));
    emitActivity(tool('write_file', 'fail', 'c-run', { cancelled: true })); // cancelled mid-run
    emitActivity(tool('run_command', 'busy', 'c-block'));
    emitActivity(tool('run_command', 'fail', 'c-block', { blocked: true })); // policy block
    const s = invocationSummary();
    expect(s.cancelled).toBe(1);
    expect(s.blocked).toBe(1);
    expect(s.running).toBe(0);
    expect(s.completed + s.failed + s.cancelled + s.blocked).toBe(s.calls);
    const [run, block] = queryInvocations({ offset: 0, limit: 10 }).records;
    expect(run.state).toBe('cancelled');
    expect(block.state).toBe('blocked');
    expect(run.endedAt).toBeGreaterThan(0);
  });

  it('terminal states are final: a genuinely stale ok never resurrects a cancelled call', () => {
    const busy = emitActivity(tool('x_tool', 'busy', 'c1'));
    emitActivity(tool('x_tool', 'fail', 'c1', { cancelled: true }));
    // A duplicate of the ORIGINAL busy event (same/older id) changes nothing:
    noteInvocationEvent({ ...tool('x_tool', 'ok', 'c1'), id: busy.id });
    noteInvocationEvent({ ...tool('x_tool', 'busy', 'c1'), id: busy.id - 1 });
    const s = invocationSummary();
    expect(s.cancelled).toBe(1);
    expect(s.completed).toBe(0);
    expect(s.calls).toBe(1);
    // A strictly NEWER terminal event may refine (newer information wins), never run backwards:
    emitActivity(tool('x_tool', 'ok', 'c1'));
    const refined = invocationSummary();
    expect(refined.completed).toBe(1);
    expect(refined.cancelled).toBe(0);
  });

  it('duplicate event delivery is idempotent (no phantom invocations)', () => {
    beginTurn('t');
    const mk = () => tool('dup_tool', 'ok', 'c-dup');
    const first = emitActivity(mk());
    noteInvocationEvent({ ...first }); // same event delivered twice
    noteInvocationEvent({ ...first }); // and a third time
    const s = invocationSummary();
    expect(s.calls).toBe(1);
    expect(s.completed).toBe(1);
  });

  it('repeated invocations of the same tool are counted individually', () => {
    beginTurn('terminal loop');
    for (let i = 0; i < 8; i++) emitActivity(tool('terminal', 'ok', `c-term-${i}`, { ms: 40 + i }));
    const s = invocationSummary();
    expect(s.calls).toBe(8); // 8 invocations of the SAME tool
    expect(s.tools).toBe(1);
    expect(s.completed).toBe(8);
  });
});
