import os from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dateContext,
  extractReportContents,
  parseDated,
  researchViolations,
  todayParts,
  type Today,
} from '../src/main/quality';
import { checkClockDrift, clockWarning, driftFromHeader, resetClockProbe } from '../src/main/clock';
import { getFallbackModels, setSettings } from '../src/main/settings';

// settings.ts (via clock.ts) reads its store under Electron's userData; the unit-test env
// has no Electron, so stand in a temp dir (the same isolation rule tests/setup.ts applies).
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() }, safeStorage: { isEncryptionAvailable: () => false } }));

const TODAY: Today = { day: 1, month: 'November', year: 2026, iso: '2026-11-01', weekday: 'Sunday' };

/**
 * The REAL failing report from the first live E2E run (Background Mode, 1 Nov 2026),
 * condensed but faithful: confidently wrong year, zero source URLs, zero UNVERIFIED
 * marks, and the 206 g card vs 213 g table contradiction. The gate must catch ALL of it.
 */
const FAILING_REPORT = `# Smartphone Shortlist & Long-Term Update Audit (₹50,000 Budget)

**Prepared for:** Executive Briefing (Lunch Reading)
**Date:** 1 November 2025
**Core Criteria:** Long-term update support (5+ years focus), Indian market availability, Firm budget ≤ ₹50,000.

## Executive Summary

To secure a device that lasts 5+ years, we evaluated top models under ₹50,000 currently retailed in India.

* **Samsung Galaxy S24** wins on longevity with its industry-leading **7 years** of software updates.
* **OnePlus 13R** offers the largest battery (6000 mAh) and solid 4-year support at a lower price point.
* **iQOO 13** pushes past the ₹50,000 mark (listed around ₹54,999+), making it over budget unless heavily discounted.

## Comparative Specifications & Cost Analysis

| Model | Price in India (approx.) | Promised Update Support | Battery Size | Weight | Cost per Update Year |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Samsung Galaxy S24** | ₹43,000 – ₹47,000 | 7 Years (OS & Security) | 4,000 mAh | 167 g | ~₹6,428 / year |
| **OnePlus 13R** | ₹37,900 – ₹39,999 | 4 Major OS Updates | 6,000 mAh | 206 g | ~₹9,750 / year |
| **iQOO 13** *(Out of budget)* | ₹54,999+ | 4 Major OS Updates | 6,000 mAh | 213 g | ~₹13,750 / year |

## Model Breakdowns

### 1. Samsung Galaxy S24 (Top Recommendation for 5+ Year Longevity)
* **Why it fits:** It is the only compact flagship under ₹50,000 offering a full **7 years of software and security updates**, ensuring support well into 2031.
* **Trade-offs:** Smaller battery (4,000 mAh) compared to Chinese competitors, but highly optimized Snapdragon 8 Gen 3 (for Galaxy) efficiency mitigates daily drain. Light and compact (167 g).

### 2. OnePlus 13R (Best Battery & Endurance)
* **Why it fits:** Equipped with a massive **6,000 mAh Silicon-Carbon battery** and powered by the Snapdragon 8 Gen 3, built for extreme durability and heavy multi-year use.
* **Trade-offs:** 4 years of OS updates (falls slightly short of your 5-year target, though security patches may persist longer).

### 3. iQOO 13 (Dropped / Over Budget)
* **Status:** Priced at ₹54,999+, breaching your firm ₹50,000 cap. While it packs a Snapdragon 8 Elite and a 6,000 mAh battery, the price point excludes it.

## Bangalore Weather Advisory (Saturday)
* **Forecast:** Clear sky, 34°C max, **0% chance of rain**.
* **Recommendation:** Safe to visit a retail store in Bangalore this Saturday, or order online at your convenience.`;

/** The digest cards the run ALSO shipped — 206 g for the iQOO, the 13R's weight, copy-pasted. */
const FAILING_CARDS = `Samsung Galaxy S24 ₹45k 7 Years Updates | 4000 mAh | 167g
Best for 5+ Year Longevity

OnePlus 13R ₹38k 4 Years Updates | 6000 mAh | 206g
Best Battery & Value

iQOO 13 ₹55k+ 4 Years Updates | 6000 mAh | 206g
Over Budget`;

const CLEAN_REPORT = `# Smartphone Shortlist & Long-Term Update Audit (₹50,000 Budget)

**Date:** 1 November 2026
As of 1 November 2026, the Indian retail market looks like this.

| Model | Price | Updates | Battery | Weight |
| :--- | :--- | :--- | :--- | :--- |
| **Samsung Galaxy S24** | ₹46,999 | 7 Years | 4,000 mAh | 167 g |
| **OnePlus 13R** | ₹39,999 | 4 Years | 6,000 mAh | 206 g |

Note: live stock levels not confirmed; prices UNVERIFIED outside the two sources below.

Sources:
- https://www.samsung.com/in/smartphones/galaxy-s24/
- https://www.oneplus.in/oneplus-13r`;

const base = (over: Partial<Parameters<typeof researchViolations>[0]>) => ({
  reply: '',
  reports: [] as string[],
  actions: [] as string[],
  today: TODAY,
  fresh: false,
  ...over,
});

describe('researchViolations — the gate that must have caught the live run', () => {
  it('catches every defect of the real failing report: year, sources, stamp, marks, specs', () => {
    const v = researchViolations(
      base({
        reply: FAILING_CARDS,
        reports: [FAILING_REPORT],
        actions: ['tinyfish_search({"query":"best phone under 50000 india"})', 'write_file({"path":"report.md"})'],
        fresh: true,
      })
    );
    expect(v.some((x) => x.includes('date anchoring wrong') && x.includes('2025-11-01'))).toBe(true);
    expect(v.some((x) => x.startsWith('no source URLs'))).toBe(true);
    expect(v.some((x) => x.includes('freshness not stamped'))).toBe(true);
    expect(v.some((x) => x.includes('neither sources nor UNVERIFIED'))).toBe(true);
    expect(
      v.some((x) => x.includes('self-contradicting spec: iqoo 13 g') && x.includes('206') && x.includes('213'))
    ).toBe(true);
    // And it must NOT invent problems: the web action ran, so no freshness-lookup violation.
    expect(v.some((x) => x.includes('no successful web search'))).toBe(false);
    // Consistent specs stay quiet: S24 167 g / 4,000 mAh agree across card and table.
    expect(v.some((x) => x.includes('samsung galaxy s24'))).toBe(false);
  });

  it('passes a sourced, dated, stamped, consistent report', () => {
    const v = researchViolations(
      base({
        reply: 'Saved, sir.',
        reports: [CLEAN_REPORT],
        actions: ['tinyfish_search({"query":"phone"})'],
        fresh: true,
      })
    );
    expect(v).toEqual([]);
  });

  it('demands the live web when the request says "right now" — and stamps the date', () => {
    const long = FAILING_REPORT; // reportish body, has prices
    const noLookup = researchViolations(base({ reply: long, actions: ['read({"path":"notes.txt"})'], fresh: true }));
    expect(noLookup.some((x) => x.includes('no successful web search or fetch ran'))).toBe(true);

    const failedLookup = researchViolations(base({ reply: long, actions: ['tinyfish_search({"query":"x"}) FAILED'], fresh: true }));
    expect(failedLookup.some((x) => x.includes('no successful web search or fetch ran'))).toBe(true);
  });

  it('flags a labelled stale date even without fresh wording', () => {
    const v = researchViolations(base({ reply: `Report\n\nDate: 25 December 2024\n\n${'x'.repeat(400)}` }));
    expect(v.some((x) => x.includes('date anchoring wrong') && x.includes('2024-12-25'))).toBe(true);
  });

  it('leaves genuine historical dates alone', () => {
    const body = `# Report\n\nThe Galaxy S24 launched globally on 17 January 2024 at $799.\n\nSources:\n- https://example.com/a\n- https://example.com/b`;
    const v = researchViolations(base({ reply: body }));
    expect(v).toEqual([]);
  });

  it('a short non-project reply with no report triggers nothing', () => {
    const v = researchViolations(base({ reply: 'The S24 is ₹49,999 right now, sir.', fresh: false }));
    expect(v).toEqual([]);
  });

  it('prices with neither sources nor marks fire on short fresh replies too', () => {
    const v = researchViolations(base({ reply: 'The S24 is ₹49,999 right now, sir.', fresh: true, actions: [] }));
    expect(v.some((x) => x.includes('no successful web search'))).toBe(true);
    expect(v.some((x) => x.includes('neither sources nor UNVERIFIED'))).toBe(true);
    expect(v.some((x) => x.includes('freshness not stamped'))).toBe(true);
  });

  it('a written report is gated even when the spoken reply is just "Done."', () => {
    const v = researchViolations(
      base({ reply: 'Done, sir.', reports: [FAILING_REPORT], actions: ['tinyfish_search({"query":"x"})'], fresh: true })
    );
    expect(v.some((x) => x.startsWith('no source URLs'))).toBe(true);
    expect(v.some((x) => x.includes('date anchoring wrong'))).toBe(true);
  });
});

describe('parseDated — the date formats reports actually use', () => {
  it('parses the common shapes', () => {
    expect(parseDated('1 November 2025')).toBe('2025-11-01');
    expect(parseDated('November 1, 2025')).toBe('2025-11-01');
    expect(parseDated('Nov 1st, 2025')).toBe('2025-11-01');
    expect(parseDated('2025-11-01')).toBe('2025-11-01');
  });

  it('rejects non-dates instead of guessing', () => {
    expect(parseDated('Foo 1, 2025')).toBeNull();
    expect(parseDated('13 Smarch 2025')).toBeNull();
  });
});

describe('dateContext — the anchor injected into every turn', () => {
  it('states the real date, weekday and ISO form', () => {
    const ctx = dateContext(todayParts(new Date(2026, 10, 1)), 'Asia/Calcutta');
    expect(ctx).toContain('Sunday, 1 November 2026 (2026-11-01)');
    expect(ctx).toContain('Asia/Calcutta');
    expect(ctx).toMatch(/Never trust your internal sense of the date/);
  });
});

describe('extractReportContents — write_file args only', () => {
  it('takes content from write_file-shaped args', () => {
    const out = extractReportContents([
      JSON.stringify({ path: 'Jarvis-Files/report.md', content: '# Report body' }),
      'not json at all',
      JSON.stringify({ content: 'clipboard text with no path' }), // clipboard_write shape: NOT a report
      JSON.stringify({ path: 'notes.md', old_text: 'a', new_text: 'b' }), // edit_file shape: NOT a report
    ]);
    expect(out).toEqual(['# Report body']);
  });
});

describe('clock drift — a wrong PC clock is warned about, not trusted', () => {
  const NOW = Date.parse('2026-11-01T10:00:00Z');

  it('reads the server Date header', () => {
    expect(driftFromHeader('Sun, 01 Nov 2026 10:00:00 GMT', NOW)).toBe(0);
    expect(driftFromHeader('Sun, 01 Nov 2026 09:30:00 GMT', NOW)).toBe(-1_800_000);
  });

  it('fails open on a missing or malformed header', () => {
    expect(driftFromHeader(null, NOW)).toBeNull();
    expect(driftFromHeader('not a date', NOW)).toBeNull();
  });

  it('warns only past a day of drift, in the right direction', () => {
    expect(clockWarning(0)).toBeNull();
    expect(clockWarning(null)).toBeNull();
    expect(clockWarning(30 * 86_400_000)).toMatch(/30 days/);
    expect(clockWarning(30 * 86_400_000)).toMatch(/behind/); // server ahead → local clock behind
    expect(clockWarning(-30 * 86_400_000)).toMatch(/ahead/);
  });

  it('the network probe fails open when nothing answers', async () => {
    resetClockProbe();
    // Nothing listens on the provider port in the unit-test env; must resolve null, not throw.
    await expect(checkClockDrift()).resolves.toBeNull();
    resetClockProbe();
  }, 10_000);
});

describe('fallback chain settings', () => {
  const ENV = 'JARVIS_FALLBACK_MODELS';
  const saved = process.env[ENV];

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  it('falls back to the environment list when nothing is stored', async () => {
    await setSettings({ fallbackModels: [] });
    process.env[ENV] = 'env/model-a, env/model-b ,';
    await expect(getFallbackModels()).resolves.toEqual(['env/model-a', 'env/model-b']);
  });

  it('a stored chain wins over the environment and is stored trimmed', async () => {
    process.env[ENV] = 'env/model-a';
    await setSettings({ fallbackModels: ['stored/one ', 'stored/two', ''] });
    await expect(getFallbackModels()).resolves.toEqual(['stored/one', 'stored/two']);
  });

  it('an empty stored chain and no env means no fallback (fail honestly, fast)', async () => {
    delete process.env[ENV];
    await setSettings({ fallbackModels: [] });
    await expect(getFallbackModels()).resolves.toEqual([]);
  });
});
