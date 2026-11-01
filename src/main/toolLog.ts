/** Rolling record of tool calls so failures are visible to JARVIS, the user and the dev console. */
interface Entry {
  t: number;
  name: string;
  ms: number;
  ok: boolean;
  error?: string;
}

const MAX = 80;
const log: Entry[] = [];

export function recordTool(name: string, ms: number, error?: string): void {
  log.push({ t: Date.now(), name, ms, ok: !error, error: error?.slice(0, 200) });
  if (log.length > MAX) log.shift();
  if (error) console.warn(`[tool] FAIL ${name} (${ms}ms): ${error}`);
  else if (ms > 8000) console.warn(`[tool] SLOW ${name} (${ms}ms)`);
}

export function recentTools(count = 15, failedOnly = false): string {
  const rows = log.filter((e) => !failedOnly || !e.ok).slice(-count);
  if (!rows.length) return failedOnly ? 'No tool failures recorded.' : 'No tool calls recorded yet.';
  return rows
    .map((e) => {
      const time = new Date(e.t).toLocaleTimeString('en-GB');
      return `${time} ${e.ok ? 'OK  ' : 'FAIL'} ${e.name} ${e.ms}ms${e.error ? ` - ${e.error}` : ''}`;
    })
    .join('\n');
}
