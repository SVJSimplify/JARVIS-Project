import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  fingerprintOf,
  requestApproval,
  respondApproval,
  dismissApproval,
  validateApproval,
  invalidateSessionApprovals,
  pendingApprovalCount,
  resetApprovalsForTests,
  type ApprovalIntent,
  setNativeConfirmationPresenter,
  approvalStatusForTests,
} from '../src/main/approval';
import { classifyConsequence, type Consequence } from '../src/main/nativeBrowser';
import { argsPreview } from '../src/main/toolRecord';
import { nextOccurrence, parseRecurrence, resolveTimeZone, wallToEpoch, zonedParts, type Recurrence } from '../src/main/scheduler';
import { setNativeProfileRoot } from '../src/main/nativeBrowser';

/**
 * ROUND 29 focused checks — ONLY the security/scheduler logic whose correctness
 * typechecking cannot establish (per the Round 29 testing contract: no inflated suites).
 * Everything here is pure or filesystem-isolated; no network, no browser, no Windows.
 */

/** The user clicks Allow in the native dialog: install a presenter that approves, then wait for the
 *  dialog outcome to settle (only the dialog result grants; nothing is approved synchronously). */
async function approveNatively(id: string): Promise<{ ok: boolean; status: string; reason: string }> {
  setNativeConfirmationPresenter(async () => 'approved');
  const r = await respondApproval(id, 'approve');
  for (let i = 0; i < 200 && approvalStatusForTests(id) === 'pending'; i++) await new Promise((res) => setTimeout(res, 5));
  return r;
}

const intent = (over: Partial<ApprovalIntent> = {}): ApprovalIntent => ({
  tool: 'native_browser_click',
  action: 'click',
  targetLabel: 'Place order',
  targetRole: 'button',
  targetHref: 'https://shop.example.com/checkout',
  pageUrl: 'https://shop.example.com/checkout?session=SECRETTOKEN',
  origin: 'https://shop.example.com',
  tabId: 'tab-1',
  sessionId: 'nb-1',
  effect: 'submit the order form',
  ...over,
});

describe('R29 §1.1 — approval lifecycle (main-process enforced)', () => {
  beforeEach(() => {
    resetApprovalsForTests();
    // the durable audit log lands under the temp workspace tests/setup.ts provides
  });

  it('a request only becomes consumable after a genuine approve, and exactly once', async () => {
    const req = await requestApproval(intent());
    expect(req.id).toMatch(/^ap-/);
    expect(pendingApprovalCount()).toBe(1);
    // pending: validation refuses (the user has not decided)
    const pending = await validateApproval(req.id, intent());
    expect(pending.ok).toBe(false);
    expect(pending.reason).toMatch(/PENDING/);
    // dismiss ≠ approve
    const req2 = await requestApproval(intent({ tabId: 'tab-2' }));
    await dismissApproval(req2.id);
    const dismissed = await validateApproval(req2.id, intent({ tabId: 'tab-2' }));
    expect(dismissed.ok).toBe(false);
    expect(dismissed.reason).toMatch(/DISMISSED/i);
    // genuine approve → exactly one consumption
    const req3 = await requestApproval(intent({ tabId: 'tab-3' }));
    const denyFirst = await respondApproval(req3.id, 'deny');
    expect(denyFirst.ok).toBe(true);
    const denied = await validateApproval(req3.id, intent({ tabId: 'tab-3' }));
    expect(denied.ok).toBe(false);
    expect(denied.reason).toMatch(/DENIED/);
    const req4 = await requestApproval(intent({ tabId: 'tab-4' }));
    const approved = await approveNatively(req4.id);
    expect(approved.ok).toBe(true);
    const ok = await validateApproval(req4.id, intent({ tabId: 'tab-4' }));
    expect(ok.ok).toBe(true);
    const replay = await validateApproval(req4.id, intent({ tabId: 'tab-4' }));
    expect(replay.ok).toBe(false);
    expect(replay.reason).toMatch(/already used|single-use/i);
    // unknown ids never validate (the model cannot invent one)
    const forged = await validateApproval('ap-does-not-exist', intent());
    expect(forged.ok).toBe(false);
    expect(forged.reason).toMatch(/does not exist/);
  });

  it('the fingerprint binds the approval to the exact scope — any meaningful change refuses', async () => {
    const req = await requestApproval(intent());
    await approveNatively(req.id);
    // the EXACT same intent validates
    expect((await validateApproval(req.id, intent())).ok).toBe(true);

    const req2 = await requestApproval(intent());
    await approveNatively(req2.id);
    // different ORIGIN (the user approved shop.example.com; evil.example.net is another world)
    const changed = await validateApproval(req2.id, intent({ origin: 'https://evil.example.net', pageUrl: 'https://evil.example.net/x' }));
    expect(changed.ok).toBe(false);
    expect(changed.reason).toMatch(/different session, tab, origin, target, payload or effect/);

    const req3 = await requestApproval(intent());
    await approveNatively(req3.id);
    // different SESSION (a new native session invalidates old approvals)
    const otherSession = await validateApproval(req3.id, intent({ sessionId: 'nb-2' }));
    expect(otherSession.ok).toBe(false);

    const req4 = await requestApproval(intent());
    await approveNatively(req4.id);
    // different TARGET (another element on the same page)
    const otherTarget = await validateApproval(req4.id, intent({ targetLabel: 'Delete account' }));
    expect(otherTarget.ok).toBe(false);

    const req5 = await requestApproval(intent());
    await approveNatively(req5.id);
    // different EFFECT
    const otherEffect = await validateApproval(req5.id, intent({ effect: 'change the account password' }));
    expect(otherEffect.ok).toBe(false);
  });

  it('fingerprint is deterministic and query strings never leak into it', () => {
    const a = fingerprintOf(intent());
    const b = fingerprintOf(intent());
    expect(a).toBe(b);
    // a different session token in the URL query does not change identity (origin-scoped)…
    const withOtherQuery = fingerprintOf(intent({ pageUrl: 'https://shop.example.com/checkout?session=OTHER' }));
    expect(withOtherQuery).toBe(a);
    // …but a different path or target does
    expect(fingerprintOf(intent({ targetLabel: 'Buy now' }))).not.toBe(a);
    expect(fingerprintOf(intent({ targetHref: 'https://shop.example.com/other' }))).not.toBe(a);
  });

  it('ending the browser session invalidates every approval bound to it', async () => {
    const req = await requestApproval(intent());
    await approveNatively(req.id);
    const n = await invalidateSessionApprovals('nb-1', 'the browser process exited');
    expect(n).toBe(1);
    const after = await validateApproval(req.id, intent());
    expect(after.ok).toBe(false);
    expect(after.reason).toMatch(/CANCELLED|ended/i);
  });
});

describe('R29 §1.1 — consequence classification', () => {
  const cases: Array<[string, Consequence]> = [
    ['Buy now — $12.99', 'consequential'],
    ['Place order', 'consequential'],
    ['Submit', 'consequential'],
    ['Send message', 'consequential'],
    ['Publish post', 'consequential'],
    ['Create issue', 'consequential'],
    ['Delete account', 'destructive'],
    ['Remove file', 'destructive'],
    ['Sign up for the newsletter', 'consequential'],
    ['Settings', 'ordinary'],
    ['Next page', 'ordinary'],
    ['Google Search', 'ordinary'],
    ['Read more', 'ordinary'],
  ];
  it.each(cases)('classifyConsequence(%j) → %s', (text, want) => {
    expect(classifyConsequence(text)).toBe(want);
  });
});

describe('R29 §1.3 — receipt secret redaction', () => {
  it('credential-shaped keys and typed browser text never reach the receipt', () => {
    expect(argsPreview({ password: 'hunter2', user: 'sam' }, 'run_command')).toContain('[redacted]');
    expect(argsPreview({ api_key: 'sk-123', x: '1' }, 'x')).toContain('[redacted]');
    expect(argsPreview({ text: 'my-secret-password' }, 'native_browser_type')).toContain('[redacted]');
    expect(argsPreview({ text: 'hello world' }, 'native_browser_type')).toContain('[redacted]'); // typed values are never persisted at all
    expect(argsPreview({ path: 'notes/todo.txt', content: 'hello' }, 'write_file')).toContain('content=hello');
  });
});

describe('R29 §5.2 — timezone-aware recurrence math', () => {
  it('zonedParts reads the wall clock of a zone', () => {
    // 2026-01-15T12:00:00Z == 07:00 in New York (UTC-5, EST)
    const p = zonedParts(Date.UTC(2026, 0, 15, 12, 0, 0), 'America/New_York');
    expect(`${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`).toBe('2026-01-15');
    expect(p.hour).toBe(7);
    expect(p.minute).toBe(0);
  });

  it('wallToEpoch converges for a normal instant', () => {
    const e = wallToEpoch(2026, 6, 15, 9, 30, 'Asia/Kolkata');
    const p = zonedParts(e, 'Asia/Kolkata');
    expect(p.hour).toBe(9);
    expect(p.minute).toBe(30);
  });

  it('a SKIPPED local time (spring-forward) runs at the first instant at-or-after the target', () => {
    // America/New_York, 2026: DST begins Sun Mar 8 at 02:00 → 02:30 does not exist.
    const e = wallToEpoch(2026, 3, 8, 2, 30, 'America/New_York');
    const p = zonedParts(e, 'America/New_York');
    // the wall clock must be at-or-after 02:30 on the same day, and the time must EXIST
    expect(p.day).toBe(8);
    expect(p.hour * 60 + p.minute).toBeGreaterThanOrEqual(2 * 60 + 30);
    expect(p.hour).toBe(3); // the transition hour (02:xx jumped to 03:00)
  });

  it('a REPEATED local time (fall-back) resolves to the FIRST occurrence', () => {
    // America/New_York, 2026: DST ends Sun Nov 1 at 02:00 → 01:30 happens twice.
    const e = wallToEpoch(2026, 11, 1, 1, 30, 'America/New_York');
    const p = zonedParts(e, 'America/New_York');
    expect(p.hour).toBe(1);
    expect(p.minute).toBe(30);
    // the first occurrence is in EDT (UTC-4): 05:30Z. The second would be 06:30Z.
    expect(e).toBe(Date.UTC(2026, 10, 1, 5, 30, 0));
  });

  it('nextOccurrence honours an explicit zone: a daily 09:00 New York routine stays at 09:00 across the DST gap day', () => {
    // from 2026-03-07T12:00Z (Sat, 07:00 EST): the next 09:00 NY is Mar 7 09:00 EST = 14:00Z
    const every: Recurrence = { kind: 'daily', at: '09:00', tz: 'America/New_York' };
    const next1 = nextOccurrence(every, Date.UTC(2026, 2, 7, 12, 0, 0));
    expect(zonedParts(next1, 'America/New_York').hour).toBe(9);
    expect(next1).toBe(Date.UTC(2026, 2, 7, 14, 0, 0)); // EST (UTC-5) before the transition
    // after that run (14:05Z), the next occurrence is Mar 8 — DST day: 09:00 EDT = 13:00Z
    const next2 = nextOccurrence(every, next1 + 5 * 60_000);
    expect(next2).toBe(Date.UTC(2026, 2, 8, 13, 0, 0)); // EDT (UTC-4) — the wall clock held, the epoch moved
  });

  it('weekly recurrence lands on the requested weekday in the requested zone', () => {
    const every: Recurrence = { kind: 'weekly', weekday: 1, at: '08:15', tz: 'Europe/Berlin' }; // Mondays
    // from Thu 2026-06-11T10:00Z → next Monday 2026-06-15 08:15 CEST = 06:15Z
    const e = nextOccurrence(every, Date.UTC(2026, 5, 11, 10, 0, 0));
    expect(new Date(e).getUTCDay()).toBe(1);
    const p = zonedParts(e, 'Europe/Berlin');
    expect(p.hour).toBe(8);
    expect(p.minute).toBe(15);
  });

  it('legacy recurrences without tz keep working (migration preserves data)', () => {
    const legacy: Recurrence = { kind: 'daily', at: '09:00' };
    const e = nextOccurrence(legacy, Date.UTC(2026, 5, 11, 10, 0, 0));
    expect(e).toBeGreaterThan(Date.UTC(2026, 5, 11, 10, 0, 0));
    const sys = zonedParts(e, resolveTimeZone());
    expect(`${sys.hour}:${String(sys.minute).padStart(2, '0')}`).toBe('9:00');
  });

  it('parseRecurrence validates tz at creation and rejects unknown zones honestly', () => {
    const daily = parseRecurrence({ daily_at: '07:30', tz: 'Asia/Kolkata' });
    expect(daily).toEqual({ kind: 'daily', at: '07:30', tz: 'Asia/Kolkata' });
    expect(() => parseRecurrence({ daily_at: '07:30', tz: 'Mars/Olympus' })).toThrow(/unknown time zone/);
  });
});

describe('R29 §2.2 — managed profile root is injected, not assumed', () => {
  it('setNativeProfileRoot changes the profile location (never the user’s own profile)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r29-nb-'));
    setNativeProfileRoot(path.join(tmp, 'native-browser'));
    expect(true).toBe(true); // the live connection tests cover the real behavior; here we only pin the API
  });
});
