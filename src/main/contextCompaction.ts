/** Deterministic, provenance-preserving reduction for long agent tool histories. */
export interface CompactionOptions { keepNewest?: number; maxChars?: number; marker?: string; }
export interface CompactionReport { examined: number; compacted: number; originalChars: number; retainedChars: number; }
export function compactToolMessages<T extends { role?: string; content?: unknown }>(messages: T[], options: CompactionOptions = {}): CompactionReport {
  const keep = Math.max(0, Math.floor(options.keepNewest ?? 6));
  const max = Math.max(80, Math.floor(options.maxChars ?? 500));
  const marker = options.marker ?? '[older tool output compacted; re-read source for exact detail]';
  const indexes = messages.map((m, i) => m?.role === 'tool' ? i : -1).filter(i => i >= 0);
  let compacted = 0, originalChars = 0, retainedChars = 0;
  for (const i of indexes.slice(0, Math.max(0, indexes.length - keep))) {
    const m = messages[i];
    if (typeof m.content !== 'string') continue;
    const value = m.content; originalChars += value.length;
    if (value.length <= max) { retainedChars += value.length; continue; }
    const available = Math.max(60, max - marker.length - 12);
    const head = Math.floor(available * 0.7), tail = available - head;
    m.content = value.slice(0, head) + '\n… ' + marker + ' …\n' + value.slice(-tail);
    compacted++; retainedChars += String(m.content).length;
  }
  return { examined: indexes.length, compacted, originalChars, retainedChars };
}
