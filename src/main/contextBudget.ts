/**
 * CONTEXT BUDGETING (Round 31 §3.5) — assemble per-turn context under a hard ceiling.
 *
 * Priority determines ownership and allocation; caller order determines display order.
 * The final text, including any omission notice, never exceeds the supplied budget.
 * Pure module: no fs, no electron, no model calls.
 */
export interface ContextBlock {
  id: string;
  text: string;
  /** 0 = critical, larger values = increasingly disposable. */
  priority: number;
}
export interface AssembledContext {
  text: string;
  included: string[];
  dropped: Array<{ id: string; reason: string }>;
  dedupedLines: number;
  totalChars: number;
}
const normLine = (line: string): string =>
  line.replace(/[*_#>]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const joinParts = (parts: Array<string | undefined>): string =>
  parts.filter((part): part is string => Boolean(part)).join('\n\n');

export function assembleTurnContext(blocks: ContextBlock[], budgetChars: number): AssembledContext {
  const budget = Number.isFinite(budgetChars) ? Math.max(0, Math.floor(budgetChars)) : 0;
  const usable = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => typeof block.text === 'string' && block.text.trim().length > 0);
  const seen = new Set<string>();
  const dedupedText = new Map<number, string>();
  const dropped: AssembledContext['dropped'] = [];
  let dedupedLines = 0;

  // Deduplicate in priority order so low-priority context cannot shadow a critical fact.
  const priorityOrder = [...usable].sort(
    (a, b) => a.block.priority - b.block.priority || a.index - b.index,
  );
  for (const { block, index } of priorityOrder) {
    const fresh: string[] = [];
    for (const line of block.text.split('\n')) {
      const key = normLine(line);
      if (key.length > 3 && seen.has(key)) {
        dedupedLines++;
        continue;
      }
      if (key.length > 3) seen.add(key);
      fresh.push(line);
    }
    dedupedText.set(index, fresh.join('\n').trim());
  }

  const totalDedupedChars = [...dedupedText.values()].reduce((sum, value) => sum + value.length, 0)
    + Math.max(0, [...dedupedText.values()].filter(Boolean).length - 1) * 2;
  const notice = '[CONTEXT BUDGET] Some context was omitted or deduplicated; use only the retained information.';
  const needsNotice = totalDedupedChars > budget || dedupedLines > 0;
  const contentBudget = needsNotice ? Math.max(0, budget - notice.length - 2) : budget;
  const parts: Array<string | undefined> = [];
  const includedSet = new Set<string>();
  let used = 0;

  for (const { block, index } of priorityOrder) {
    const value = dedupedText.get(index) ?? '';
    if (!value) continue;
    const separator = used > 0 ? 2 : 0;
    const remaining = Math.max(0, contentBudget - used - separator);
    if (value.length <= remaining) {
      parts[index] = value;
      includedSet.add(block.id);
      used += separator + value.length;
      continue;
    }

    if (block.priority <= 2 && remaining > 0) {
      const lines = value.split('\n');
      const kept: string[] = [];
      let chars = 0;
      for (const line of lines) {
        const next = chars + (kept.length ? 1 : 0) + line.length;
        if (next > remaining) break;
        kept.push(line);
        chars = next;
      }
      if (kept.length) {
        parts[index] = kept.join('\n');
        includedSet.add(block.id);
        used += separator + parts[index]!.length;
        dropped.push({
          id: block.id,
          reason: 'trimmed to fit the context budget (' + (lines.length - kept.length) + ' line(s) omitted)',
        });
        continue;
      }
    }
    dropped.push({ id: block.id, reason: 'context budget exhausted' });
  }

  const body = joinParts(parts);
  const showNotice = needsNotice || dropped.length > 0;
  let text = showNotice ? [body, notice].filter(Boolean).join('\n\n') : body;

  // Defensive final guard for tiny budgets and unexpected separator/accounting changes.
  if (text.length > budget) {
    text = showNotice ? notice.slice(0, budget) : body.slice(0, budget);
  }

  const included = usable
    .filter(({ index }) => includedSet.has(blocks[index].id) && Boolean(parts[index]))
    .map(({ block }) => block.id);

  return { text, included, dropped, dedupedLines, totalChars: text.length };
}
