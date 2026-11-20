import { readFileSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { beforeEach, describe, expect, it } from 'vitest';
import { recordOfEvent } from '../src/renderer/hooks/useActivity';
import { resetInvocationsForTests, invocationSummary, noteInvocationEvent } from '../src/main/invocations';
import type { ActivityEvent } from '../src/main/protocol';

/**
 * ROUND 23 — IPC + UI CONTRACT TESTS.
 *
 * The renderer components run inside Electron (not jsdom), so — exactly like the Round
 * 22 autopilotUi suite — the contract is pinned on the SOURCE: every channel the preload
 * exposes has a real ipcMain.handle wired to a real ledger operation; the UI components
 * really moved (header tabs gone, Settings sections present); no second implementation
 * of Activity or Transcript exists; and the old arbitrary caps are gone from every
 * activity path. Security boundaries are asserted on both ends.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const src = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

const preload = src('src/preload/index.ts');
const main = src('src/main/index.ts');
const jarvis = src('src/renderer/components/JarvisWindow.tsx');
const hud = src('src/renderer/components/HudPanels.tsx');
const settings = src('src/renderer/components/SettingsPanel.tsx');
const activity = src('src/renderer/components/ActivityFeed.tsx');
const summary = src('src/renderer/components/ToolActivitySummary.tsx');
const hook = src('src/renderer/hooks/useActivity.ts');
const app = src('src/renderer/App.tsx');
const progressSrc = src('src/main/progress.ts');
const invocationsSrc = src('src/main/invocations.ts');
const toolsSrc = src('src/main/tools.ts');

beforeEach(() => {
  resetInvocationsForTests();
});

// ------------------------------------------------------- the IPC wire contract

describe('the IPC wire contract — every exposed channel is backed by a real handler', () => {
  const channels = ['activity-summary', 'activity-scopes', 'activity-query'];

  it('the preload exposes exactly the three read-only activity channels', () => {
    for (const ch of channels) {
      expect(preload).toContain(`'${ch}'`);
    }
  });

  it('each channel has a real ipcMain.handle in index.ts calling a REAL ledger operation', () => {
    for (const ch of channels) {
      const re = new RegExp(`ipcMain\\.handle\\('${ch}'`);
      expect(main).toMatch(re);
    }
    expect(main).toContain('invocationSummary(');
    expect(main).toContain('invocationScopes()');
    expect(main).toContain('queryInvocations(');
  });

  it('the query handler re-validates renderer input before touching the ledger', () => {
    const handler = main.slice(main.indexOf("ipcMain.handle('activity-query'"), main.indexOf('ipcMain.handle', main.indexOf("ipcMain.handle('activity-query'") + 10));
    expect(handler).toContain('typeof o?.scope');
    expect(handler).toContain('typeof o?.offset');
    expect(handler).toContain('typeof o?.limit');
    expect(handler).toContain('slice(0, 80)');
  });

  it('the summary handler clamps a hostile scope string', () => {
    const handler = main.slice(main.indexOf("ipcMain.handle('activity-summary'"), main.indexOf("ipcMain.handle('activity-scopes'"));
    expect(handler).toContain('slice(0, 80)');
  });

  it('the ledger query API itself caps pages and normalises offsets (defence in depth)', () => {
    expect(invocationsSrc).toContain('if (limit > 500) limit = 500;');
    expect(invocationsSrc).toContain('if (limit < 1) limit = 1;');
    expect(invocationsSrc).toContain('if (offset > total) offset = total;');
  });

  it('there is NO write path: the ledger mutators are main-process only', () => {
    // The preload must never expose noteInvocationEvent / openInvocationTurnScope.
    expect(preload).not.toContain('noteInvocationEvent');
    expect(preload).not.toContain('openInvocationTurnScope');
    expect(preload).not.toContain('resetInvocationsForTests');
    // The push whitelist is unchanged: no new broadcast channels were added.
    expect(preload).toContain("'jarvis-activity'");
    expect(preload).toContain("'jarvis-progress'");
  });

  it('the observer is composed at the ONE injection point (no second emission path)', () => {
    expect(main).toMatch(/onEvent: \(e\) => \{\s*\/\/ Ledger FIRST[\s\S]*?noteInvocationEvent\(e\);\s*noteActivity\(e\);\s*\}/);
    expect(main).toMatch(/onTurn: \(phase, task, res\) => \{\s*if \(phase === 'start'\) \{\s*noteTurnStart\(task\);\s*openInvocationTurnScope\(\);/);
  });

  it('the engine stamps every tool emission with the owning task id and terminal flags', () => {
    expect(toolsSrc).toContain('taskId: who.taskId');
    expect(toolsSrc).toMatch(/cancelled: true, ms: Date\.now\(\) - t0/);
    expect(toolsSrc).toMatch(/detail: 'cancelled mid-run', status: 'fail', cancelled: true/);
    expect(toolsSrc.match(/blocked: true/g)?.length).toBeGreaterThanOrEqual(2);
    // No raw emitActivity tool calls remain in the dispatch choke point — the ONLY one
    // in the file is the emitTool helper definition itself, which stamps cid+taskId.
    expect(toolsSrc.match(/emitActivity\(\{ kind: 'tool'/g)?.length).toBe(1);
  });

  it('the header summary rides the EXISTING progress channel (no new subscription surface)', () => {
    expect(summary).toContain('useTaskProgress()');
    expect(summary).toContain('snap?.invocations');
  });
});

// ------------------------------------------------------------- the UI contract

describe('the UI contract — relocation, not duplication', () => {
  it('Activity and Transcript are GONE from the top-right execution header', () => {
    expect(hud).not.toMatch(/btn\('transcript'/);
    expect(hud).not.toMatch(/btn\('activity'/);
    expect(hud).not.toContain("'transcript' | 'activity' | 'tasks'");
    expect(hud).not.toContain('jarvis-right-tab');
    expect(hud).not.toContain('import ActivityFeed');
  });

  it('the right rail keeps the live task board (the “right now” view)', () => {
    expect(hud).toMatch(/export function RightRail\(\)/);
    expect(hud).toMatch(/return <TaskRailPanel \/>\;/);
  });

  it('the header gained the compact live tool-activity summary (expandable)', () => {
    expect(jarvis).toContain('<ToolActivitySummary');
    expect(summary).toContain('inv.calls');
    expect(summary).toContain('inv.running');
    expect(summary).toContain('ActivityInspector');
    expect(summary).toContain('Full history');
  });

  it('Settings hosts BOTH relocated sections behind real navigation', () => {
    expect(settings).toContain("id: 'activity'");
    expect(settings).toContain("id: 'transcript'");
    expect(settings).toContain('<SettingsActivitySection />');
    expect(settings).toContain('<CommandLog log={log} />');
    expect(settings).toContain("initialSection");
  });

  it('there is exactly ONE Activity implementation and ONE Transcript implementation', () => {
    // The shared list renderer is exported once and consumed by both mounts:
    expect(activity).toMatch(/export function ActivityList/);
    expect(summary).toContain("from './ActivityFeed'");
    expect(settings).toContain("from './ActivityFeed'");
    // The transcript renderer is exported once (HudPanels) and consumed by Settings:
    expect(hud).toMatch(/export function CommandLog/);
    expect(settings).toContain("from './HudPanels'");
    // No legacy aside-based feed left anywhere:
    expect(activity).not.toContain('<aside className="rail w-72">');
  });

  it('the relocated Transcript keeps its full functionality (entries + replies, plus durable pointer)', () => {
    const cmd = hud.slice(hud.indexOf('export function CommandLog'), hud.indexOf('export function CommandLog') + 2200);
    expect(cmd).toContain('e.text');
    expect(cmd).toContain('e.reply');
    expect(settings).toContain('Conversations');
  });

  it('empty states work in both Settings sections', () => {
    expect(activity).toContain('No tool activity has been recorded in this scope.');
    expect(hud).toContain('Nothing heard yet.');
  });

  it('large histories are handled: windowed rendering + paged loading, not hard caps', () => {
    // The hook has NO arbitrary slice cap on its records (the old `slice(0, limit)` is gone):
    expect(hook).not.toMatch(/\.slice\(0,\s*limit\)/);
    expect(hook).toContain('loadMore');
    // Round 24: pages advance by the SERVER-ECHOED offset + page length, so live records
    // landing between pages can no longer skew the next page window (the renderer's own
    // array length used to skip ledger rows in exactly that case).
    expect(hook).toContain("offset: loadedRef.current");
    expect(hook).toMatch(/\(q\.offset \?\? 0\) \+ fresh\.length/);
    // The list renderer windows DISPLAY while keeping the data complete:
    expect(activity).toMatch(/older = newest\.length - rows\.length/);
    expect(activity).toContain('earlier invocation');
    // The server caps page SIZE (500) as an RPC bound, not a data bound:
    expect(invocationsSrc).toContain('limit > 500');
  });

  it('the scope picker filters live pushes so tasks can never leak into each other', () => {
    expect(hook).toMatch(/if \(scope && ev\.scope !== scope\) return;/);
    expect(hook).toMatch(/if \(!ev\.scope\) return;/);
  });

  it('Round 24: every async result is generation-guarded — stale answers cannot overwrite the current view', () => {
    // Each effect run claims a monotonic generation; results apply only while current.
    expect(hook).toMatch(/const gen = \+\+genRef\.current;/);
    expect(hook).toMatch(/if \(!current\(\)\) return;/);
    expect(hook).toMatch(/genRef\.current !== gen\) return;/);
    // The summary pull is guarded too (both the initial one and the throttled live one).
    expect(hook).toMatch(/\.then\(\(s\) => current\(\) && setSummary\(s\)\)/);
  });

  it('Round 24: query pages MERGE with live pushes instead of replacing them', () => {
    // The old `setRecords(fresh)` wholesale replacement is exactly how pushes that
    // landed during the first page's flight used to vanish:
    expect(hook).not.toMatch(/setRecords\(fresh\)/);
    expect(hook).toContain('mergeRecords(recordsRef.current, fresh)');
    // Dedup keys on the correlation id; the merge helpers are pure and exported.
    expect(hook).toMatch(/export const mergeRecords/);
    expect(hook).toMatch(/export const upsertRecord/);
  });

  it('Round 24: the header inspector subscribes to its own scope — the undefined-scope leak is gone', () => {
    expect(summary).toMatch(/useInvocations\(scope\)/);
    expect(summary).not.toContain('useInvocations(undefined)');
  });

  it('subscriptions are cleaned up: every push listener has its unsubscribe in the effect cleanup', () => {
    // Round 24: the cleanup also invalidates the effect run's request generation, so a
    // page promise settling after a scope change or unmount can never touch the view.
    expect(hook).toMatch(/genRef\.current \+= 1;\s*off\?\.\(\);/);
    expect(summary).toMatch(/window\.removeEventListener\('keydown', onKey\);/);
    expect(summary).toMatch(/window\.removeEventListener\('mousedown', onDown\);/);
  });

  it('navigation between Settings and the execution view resets nothing and duplicates nothing', () => {
    // Settings unmounts sections when closed (`if (!open) return null`), so hooks subscribe
    // on open and unsubscribe on close — asserted by the cleanup contract above. The
    // session state that must survive navigation (log, ledger) lives OUTSIDE the panel:
    expect(app).toMatch(/const \[log, setLog\] = useState/);
    expect(settings).toMatch(/if \(!open\) return null;/);
  });

  it('the in-session transcript no longer truncates at 6 entries', () => {
    expect(app).toMatch(/const LOG_LIMIT = 500;/);
    expect(app).not.toMatch(/const LOG_LIMIT = 6;/);
  });

  it('the renderer never fabricates activity: only real engine events create records', () => {
    // The hook builds records ONLY from jarvis-activity pushes and activity.query results:
    expect(hook).toContain("on('jarvis-activity'");
    expect(hook).toContain('activity.query');
    expect(hook).not.toMatch(/ai\.chat|onDelta|content/);
    // And the summary comes from the main-process aggregate, never counted in the renderer:
    expect(summary).toContain('snap?.invocations');
  });

  it('the existing Settings functionality is preserved (provider form, autonomy, voice, awareness)', () => {
    for (const marker of ['id="api-key"', 'id="groq-key"', 'id="tinyfish-key"', 'rail-title">Provider', 'Autonomy', 'Awareness', 'Voice lock', 'Enrol voice']) {
      expect(settings).toContain(marker);
    }
  });
});

// --------------------------------------------------- wire shape + projection logic

describe('the record projection (shared by every live view)', () => {
  const ev = (over: Partial<ActivityEvent>): ActivityEvent => ({ id: 1, t: 1234, kind: 'tool', label: 'read_file', cid: 'c-1', ...over });

  it('maps the five observable states exactly', () => {
    expect(recordOfEvent(ev({ status: 'busy' })).state).toBe('running');
    expect(recordOfEvent(ev({ status: 'ok', ms: 12 })).state).toBe('completed');
    expect(recordOfEvent(ev({ status: 'fail' })).state).toBe('failed');
    expect(recordOfEvent(ev({ status: 'fail', cancelled: true })).state).toBe('cancelled');
    expect(recordOfEvent(ev({ status: 'fail', blocked: true })).state).toBe('blocked');
  });

  it('keeps task association, timestamps and durations', () => {
    const r = recordOfEvent(ev({ taskId: 'T-9', ms: 432, detail: 'path=notes.txt', status: 'ok' }));
    expect(r.taskId).toBe('T-9');
    expect(r.ms).toBe(432);
    expect(r.detail).toBe('path=notes.txt');
    expect(r.startedAt).toBe(1234);
    expect(r.endedAt).toBe(1234); // terminal event timestamp
  });

  it('a busy event has no endedAt (still running)', () => {
    expect(recordOfEvent(ev({ status: 'busy' })).endedAt).toBeUndefined();
  });

  it('malformed/duplicate pushes are rejected at the ingestion level (main-process mirror)', () => {
    noteInvocationEvent({ id: 1, t: 1, kind: 'tool', label: 'a_tool', cid: 'k1', status: 'ok' });
    noteInvocationEvent({ id: 1, t: 1, kind: 'tool', label: 'a_tool', cid: 'k1', status: 'ok' }); // exact duplicate
    noteInvocationEvent({ id: 0, t: 1, kind: 'tool', label: 'a_tool', cid: 'k1', status: 'fail' }); // stale replay
    expect(invocationSummary()).toMatchObject({ calls: 1, completed: 1, failed: 0 });
  });

  it('sensitive data never enters records: only the engine’s clipped summaries travel', () => {
    // The ledger stores label + detail exactly as the feed showed them — it has no API
    // that accepts raw args, results or credentials, by construction.
    const recordBlock = invocationsSrc.slice(invocationsSrc.indexOf('export interface InvocationRecord'), invocationsSrc.indexOf('export interface InvocationSummary'));
    expect(recordBlock).not.toMatch(/\b(result|output|args|raw|key|secret|token)\??\s*:/);
    expect(invocationsSrc).not.toContain('rawArgs');
    expect(invocationsSrc).not.toContain('apiKey');
  });
});
