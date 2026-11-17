import os from 'os';
import { readFileSync, rmSync } from 'fs';
import path from 'path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  accountableNumbers,
  isDerived,
  researchViolations,
  seenValues,
  todayParts,
  type Today,
} from '../src/main/quality';
import { resetSchedulerForTests, scheduleTask, scheduleTools, SCHEDULED_PREFIX, tick } from '../src/main/scheduler';
import { initModes, setMode } from '../src/main/modes';
import { memoryTools } from '../src/main/memory';

const { remember, list_memories } = memoryTools;

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() }, safeStorage: { isEncryptionAvailable: () => false } }));

const TODAY: Today = { day: 1, month: 'November', year: 2026, iso: '2026-11-01', weekday: 'Sunday' };
const base = (over: Partial<Parameters<typeof researchViolations>[0]>) => ({
  reply: '',
  reports: [] as string[],
  actions: [] as string[],
  today: TODAY,
  fresh: false,
  ...over,
});

/** Tool results the turn "saw": two real retailer pages and a calculate output. */
const EVIDENCE = [
  'Samsung Galaxy S24 5G price in India: ₹46,999 on samsung.com/in. Weight 167 g, battery 4,000 mAh, 7 years of OS and security updates.',
  'OnePlus 13R price: ₹39,999. 6,000 mAh battery, 206 g, 4 years of OS updates. Listed in stock on oneplus.in.',
  'ThinkPad X13 Gen 4: ₹78,490, 1.19 kg, 50 Wh battery, 16 GB RAM.',
  '6428.571428571429', // calculate("45000/7") output — its result is evidence like any tool result
];

const SOURCED_REPORT = `# Laptop Shortlist (₹80,000 Budget)

As of 1 November 2026.

| Model | Price | Weight | Battery | Updates |
| :--- | :--- | :--- | :--- | :--- |
| **Samsung Galaxy S24** | ₹46,999 | 167 g | 4,000 mAh | 7 Years |
| **OnePlus 13R** | ₹39,999 | 206 g | 6,000 mAh | 4 Years |
| **ThinkPad X13 Gen 4** | ₹78,490 | 1.19 kg | 50 Wh | 3 Years |

Price per update year for the S24: 45,000 / 7 = 6,428.57, about ₹6,429 per year.

Sources:
- https://www.samsung.com/in/
- https://www.oneplus.in/`;

describe('provenance gate — every figure must come from somewhere', () => {
  it('catches a price that no tool result, request or calculation produced (the D2 failure)', () => {
    const report = `${SOURCED_REPORT}\n\nBudget models: the Galaxy S24 is also listed at ₹43,000 this week.`;
    const v = researchViolations(base({ reply: report, evidence: EVIDENCE, request: 'budget ₹80,000', actions: ['tinyfish_search({"query":"laptop"})'] }));
    expect(v.some((x) => x.includes('figures stated with no source') && x.includes('₹43,000'))).toBe(true);
  });

  it('passes figures that the evidence, the request or a calculation actually contains', () => {
    const v = researchViolations(
      base({
        reply: SOURCED_REPORT,
        evidence: EVIDENCE,
        request: 'budget is firm at ₹80,000, keep it under ₹80,000',
        actions: ['tinyfish_search({"query":"laptop"})', 'calculate({"expression":"45000/7"})'],
      })
    );
    expect(v.some((x) => x.includes('figures stated with no source'))).toBe(false);
  });

  it('accepts derived figures: 6,428.57 is 45,000 ÷ 7, both seen this turn', () => {
    const seen = seenValues(['total ₹45,000 with 7 years of updates']);
    expect(seen).toContain(45000);
    expect(seen).toContain(7);
    expect(isDerived(6428.57, seen)).toBe(true);
    expect(isDerived(59000, seen)).toBe(false);
  });

  it('an UNVERIFIED line vouches for its own figures — honesty is never punished', () => {
    const report = `${SOURCED_REPORT}\n\nStreet price at local stores: ₹44,500 (UNVERIFIED — no listing found).`;
    const v = researchViolations(base({ reply: report, evidence: EVIDENCE, request: '', actions: ['tinyfish_search({"query":"x"})'] }));
    expect(v.some((x) => x.includes('figures stated with no source') && x.includes('44,500'))).toBe(false);
  });

  it('k and lakh shorthand normalise to the same value', () => {
    const a = accountableNumbers('the S24 sells at ₹45k');
    const b = accountableNumbers('the S24 sells at ₹45,000');
    expect(a.map((x) => x.value)).toEqual(b.map((x) => x.value));
    expect(accountableNumbers('under ₹1.5 lakh').map((x) => x.value)).toEqual([150000]);
  });

  it('no evidence pool means no opinion: a report without tool results skips the check', () => {
    const v = researchViolations(base({ reply: SOURCED_REPORT, actions: [] }));
    expect(v.some((x) => x.includes('figures stated with no source'))).toBe(false);
  });
});

describe('arithmetic audit — the gate recomputes the maths', () => {
  it('accepts a correct stated division and rejects a wrong one', () => {
    const good = researchViolations(base({ reply: 'Cost: 45,000 / 7 = 6,428.57 per year.' }));
    expect(good.some((x) => x.includes('arithmetic wrong'))).toBe(false);

    const bad = researchViolations(base({ reply: `Cost: 45,000 / 7 = 6,000 per year. ${'x'.repeat(400)}` }));
    expect(bad.some((x) => x.includes('arithmetic wrong') && x.includes('6428.57'))).toBe(true);
  });

  it('verifies the per-update-year figure against the totals on its own line', () => {
    const consistent = '| **Samsung Galaxy S24** | ₹45,000 | 7 years | ₹6,428.57 / year |';
    expect(researchViolations(base({ reply: consistent })).some((x) => x.includes('per-year figure unexplained'))).toBe(false);

    // The REAL failing-report pattern: ~₹6,428 / year next to a ₹43,000–47,000 range.
    const real = '| **Samsung Galaxy S24** | ₹43,000 – ₹47,000 | 7 Years (OS & Security) | 4,000 mAh | 167 g | ~₹6,428 / year |';
    expect(researchViolations(base({ reply: real })).some((x) => x.includes('per-year figure unexplained'))).toBe(true);
  });

  it('EMI-style rows pass when any total on the line divides to the figure', () => {
    const row = '| **ThinkPad X13** | ₹78,490 | 3 years | ₹26,163 / year | EMI ₹6,540 / month |';
    expect(researchViolations(base({ reply: row })).some((x) => x.includes('per-year figure unexplained'))).toBe(false);
  });

  it('an UNVERIFIED line is not arithmetic-audited', () => {
    const line = '| **Mystery X** | ₹50,000 (UNVERIFIED) | 7 years | ₹9,000 / year |';
    expect(researchViolations(base({ reply: line })).some((x) => x.includes('per-year figure unexplained'))).toBe(false);
  });
});

describe('scheduled follow-ups — the follow-through capability', () => {
  const notify = vi.fn();
  const runner = vi.fn(async (text: string) => `Checked, sir: price unchanged.`);

  beforeEach(async () => {
    resetSchedulerForTests();
    notify.mockClear();
    runner.mockClear();
    await initModes({ notify });
    const { registerScheduledRunner } = await import('../src/main/scheduler');
    registerScheduledRunner(runner);
  });

  afterEach(() => {
    resetSchedulerForTests();
  });

  it('schedules, runs at the due time as a REAL turn, records the outcome, persists to disk', async () => {
    const tool = scheduleTools.schedule_task;
    const out = String(
      await tool.run({ task: 'Re-check the ThinkPad X13 price; if it fell more than ₹1,000 update laptop-report.md', in_minutes: 15 })
    );
    expect(out).toMatch(/Scheduled \(#\w+\) for .+: Re-check the ThinkPad X13/);

    const notYet = await tick(Date.now() + 5 * 60_000);
    expect(notYet).toBeUndefined(); // resolved without running anything
    expect(runner).not.toHaveBeenCalled();

    await tick(Date.now() + 16 * 60_000);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0][0]).toContain(SCHEDULED_PREFIX);
    expect(runner.mock.calls[0][0]).toContain('Re-check the ThinkPad X13');

    const list = await scheduleTools.list_scheduled.run({});
    expect(list).toMatch(/done/);
    expect(list).toMatch(/price unchanged/);

    // Durable: the verifier and a restart both read it from Jarvis-Files.
    const raw = JSON.parse(readFileSync(path.join(process.env.JARVIS_FILES_ROOT ?? '/tmp', 'scheduled.json'), 'utf8')) as Array<{ status: string; reply?: string }>;
    expect(raw).toHaveLength(1);
    expect(raw[0].status).toBe('done');
    expect(raw[0].reply).toMatch(/price unchanged/);
  });

  it('schedules from an absolute ISO time and rejects the past and garbage', async () => {
    // The "future" time must be computed at run time: a hardcoded date rotted the day
    // after this test was written (2026-11-02T09:00 was the future on 2026-11-01 only).
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    const p = (n: number): string => String(n).padStart(2, '0');
    const at = `${soon.getFullYear()}-${p(soon.getMonth() + 1)}-${p(soon.getDate())}T${p(soon.getHours())}:${p(soon.getMinutes())}`;
    const out = String(await scheduleTools.schedule_task.run({ task: 'Check shipment', at }));
    expect(out).toMatch(new RegExp(`Scheduled \\(#\\w+\\) for ${soon.getDate()} \\w{3} ${soon.getFullYear()}`));
    await expect(scheduleTools.schedule_task.run({ task: 'x', at: '2020-01-01T00:00' })).rejects.toThrow(/past/);
    await expect(scheduleTools.schedule_task.run({ task: 'x', at: 'sometime after lunch' })).rejects.toThrow(/Cannot understand the time/);
    await expect(scheduleTools.schedule_task.run({ task: 'x', in_minutes: 0 })).rejects.toThrow(/in_minutes/);
    await expect(scheduleTools.schedule_task.run({ task: 'x' })).rejects.toThrow(/in_minutes \(number\) or at/);
  });

  it('cancel removes a pending task; unknown ids error honestly', async () => {
    const t = await scheduleTask('Watch the price', { in_minutes: 30 });
    expect(await scheduleTools.cancel_scheduled.run({ id: t.id })).toMatch(/Cancelled: Watch the price/);
    await expect(scheduleTools.cancel_scheduled.run({ id: t.id })).rejects.toThrow(/No pending task/);
    await tick(Date.now() + 60 * 60_000);
    expect(notify).not.toHaveBeenCalled(); // cancelled work never wakes the user
  });

  it('a failing runner is a FAILED task with an honest notification, never a fake success', async () => {
    await scheduleTask('Re-check price', { in_minutes: 1 });
    const boom = vi.fn(async () => {
      throw new Error('No model set.');
    });
    const { registerScheduledRunner } = await import('../src/main/scheduler');
    registerScheduledRunner(boom);
    await tick(Date.now() + 5 * 60_000);
    const list = await scheduleTools.list_scheduled.run({});
    expect(list).toMatch(/failed/);
    expect(list).toMatch(/No model set/);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ ok: false, title: 'J.A.R.V.I.S — scheduled follow-up failed' });
  });

  it('background mode suppresses the success toast — the turn itself already notified', async () => {
    await initModes({ notify });
    await setMode('background');
    await scheduleTask('Silent re-check', { in_minutes: 1 });
    const { registerScheduledRunner } = await import('../src/main/scheduler');
    registerScheduledRunner(runner);
    await tick(Date.now() + 5 * 60_000);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    await setMode('interactive');
  });

  it('parseWhen accepts minutes, ISO and plain date-times; bounds are enforced', async () => {
    const { parseWhen } = await import('../src/main/scheduler');
    const now = Date.parse('2026-11-01T10:00:00');
    expect(parseWhen({ in_minutes: 15 }, now)).toBe(now + 15 * 60_000);
    expect(parseWhen({ at: '2026-11-02T09:00' }, now)).toBe(Date.parse('2026-11-02T09:00:00'));
    expect(parseWhen({ at: '2026-11-02 09:00' }, now)).toBe(Date.parse('2026-11-02T09:00:00'));
    expect(() => parseWhen({ in_minutes: 60 * 24 * 31 }, now)).toThrow(/30 days|in_minutes/);
  });
});

describe('memory revisions — a changed value updates, it does not contradict', () => {
  beforeEach(async () => {
    rmSync(path.join(process.env.JARVIS_FILES_ROOT ?? os.tmpdir(), 'longterm-memory.json'), { force: true });
    const { resetMemoryForTests } = await import('../src/main/memory');
    resetMemoryForTests();
  });

  it('a revised budget updates the existing entry and says what it was (Round 18 §7.5: supersession — the old value is kept as history, never shown as current)', async () => {
    await remember.run({ fact: 'phone budget is firm at ₹50,000', category: 'preference' });
    const out = String(await remember.run({ fact: 'phone budget is firm at ₹80,000', category: 'preference' }));
    expect(out).toMatch(/Updated \(was: phone budget is firm at ₹50,000\)/);
    const list = String(await list_memories.run({ category: 'preference' }));
    expect(list).toMatch(/₹80,000/);
    expect(list).not.toMatch(/₹50,000/); // superseded history is not live memory
  });

  it('a different topic with a different amount is NOT merged (phone vs laptop budgets)', async () => {
    await remember.run({ fact: 'phone budget is firm at ₹50,000', category: 'preference' });
    const out = String(await remember.run({ fact: 'laptop budget is firm at ₹80,000', category: 'preference' }));
    expect(out).not.toMatch(/Updated/);
    const list = String(await list_memories.run({ category: 'preference' }));
    expect(list).toMatch(/₹50,000/);
    expect(list).toMatch(/₹80,000/);
  });

  it('an identical re-save is still just "Already remembered."', async () => {
    await remember.run({ fact: 'prefers quiet replies', category: 'preference' });
    expect(String(await remember.run({ fact: 'prefers quiet replies', category: 'preference' }))).toMatch(/Already remembered/);
  });
});

describe('todayParts sanity', () => {
  it('still computes the real date', () => {
    const t = todayParts(new Date(2026, 10, 1));
    expect(t.iso).toBe('2026-11-01');
    expect(t.weekday).toBe('Sunday');
  });
});
