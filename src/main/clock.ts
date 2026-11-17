import { getBaseUrl } from './settings';

/**
 * The model must never trust its internal sense of "today". A live run shipped a report
 * dated a full year in the past that was internally self-consistent (its wrong date was a
 * Saturday, matching its own "this Saturday" advice) — nothing downstream can detect that
 * kind of wrong. The OS clock is the anchor; this module cross-checks it once per session
 * against the API host's own HTTP Date header (present on every response, even 401s) so a
 * badly wrong PC clock is warned about in the prompt instead of being trusted blindly.
 *
 * Fail-open by design: an unreachable probe returns null (unknown), never blocks a turn.
 */
export function driftFromHeader(dateHeader: string | null, now: number): number | null {
  if (!dateHeader) return null;
  const server = Date.parse(dateHeader);
  if (!Number.isFinite(server)) return null;
  return server - now;
}

/** Clocks within a day of each other are fine; the point is catching year-level wrongness. */
const TOLERANCE_MS = 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 4000;

let probe: Promise<number | null> | null = null;

/** Once per process: read the provider's Date header and return (server - local) ms. Cached. */
export function checkClockDrift(): Promise<number | null> {
  probe ??= (async () => {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
      try {
        const res = await fetch(`${await getBaseUrl()}/models`, { method: 'GET', signal: ctl.signal });
        return driftFromHeader(res.headers.get('date'), Date.now());
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return null; // fail open: the probe must never block or fail the turn
    }
  })();
  return probe;
}

/** Test hook: forget the cached probe so a later call re-runs it. */
export function resetClockProbe(): void {
  probe = null;
}

/** Human warning for the drift, or null when it is within tolerance / unknown. */
export function clockWarning(driftMs: number | null): string | null {
  if (driftMs === null || Math.abs(driftMs) <= TOLERANCE_MS) return null;
  const days = Math.round(Math.abs(driftMs) / 86_400_000);
  return (
    `the system clock is off by about ${days} day${days === 1 ? '' : 's'} ` +
    `(measured against the API host, so local time is ${driftMs > 0 ? 'behind' : 'ahead'}) — ` +
    'dates read from files or tool results may be wrong; trust the TODAY line above and say the clock looks wrong if the user asks about dates'
  );
}
