/**
 * CONTEXT BUDGETING (Round 31 §3.5) — how JARVIS assembles the per-turn context blocks
 * that accompany the system prompt.
 *
 * Rules enforced here, in one place:
 *  - PRIORITY: critical blocks survive budget pressure before disposable context.
 *  - DEDUPLICATION: higher-priority blocks own duplicate lines, regardless of input order.
 *  - BOUNDED: the FINAL output, including omission notices, never exceeds the budget.
 *  - HONESTY: omitted or trimmed context is disclosed within the same hard budget.
 *
 * Pure module: no fs, no electron, no model calls.
 */

export interface ContextBlock {
  /** Stable id for diagnostics ('memory', 'learning', 'user-model', ...). */
  id: string;
  /** The block body ('' blocks are skipped entirely — no padding). */
  text: string;
  /** Higher priority survives budget pressure first (0 = critical, 5 = disposable). */
  priority: number;
}

export interface AssembledContext {
  text: string;
  /** Blocks that were included, in assembly order. */
  included: string[];
  /** Blocks dropped entirely or trimmed, with the reason. */
  dropped: Array<{ id: string; reason: string }>;
  /** Lines removed because an earlier, higher-priority block already carried them. */
  dedupedLines: number;
  totalChars: number;
}

/** Strip markdown decoration for comparison; keeps identifiers intact. */
const normLine = (line: string): string => line.replace(/[*_`#>]/g, '').replace(/\\s+/g, ' ').trim().toLowerCase();

const joinParts = (parts: Array<string | undefined>): string => parts.filter((part): part is string => Boolean(part)).join('\\n\\n');

/**
 * Assemble context under a strict character ceiling. Dedupe ownership is decided in
 * priority order, while the final display order remains the caller's original order.
 */
export function assembleTurnContext(blocks: ContextBlock[], budgetChars: number): AssembledContext {
  const budget = Number.isFinite(budgetChars) ? Math.max(0, Math.floor(budgetChars)) : 0;
  const usable = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => typeof block.text === 'string' && block.text.trim().length > 0);
  const seen = new Set<string>();
  const dedupedText = new Map<number, string>();
  const dropped: AssembledContext['dropped'] = [];
  let dedupedLines = 0;

  // The highest-priority occurrence owns a line even when its block appears later.
  const ownershipOrder = [...usable].sort(
    (a, b) => a.block.priority - b.block.priority || a.index - b.index,
  );
  for (const { block, index } of ownershipOrder) {
    const fresh: string[] = [];
    for (const line of block.text.split('\\n')) {
      const key = normLine(line);
      if (key.length > 3 && seen.has(key)) {
        dedupedLines++;
        continue;
      }
      if (key.length > 3) seen.add(key);
      fresh.push(line);
    }
    dedupedText.set(index, fresh.join('\\n').trim());
  }

  const parts: Array<string | undefined> = [];
  const includedSet = new Set<string>();
  let used = 0;
  const allocationOrder = [...usable].sort(
    (a, b) => a.block.priority - b.block.priority || a.index - b.index,
  );

  for (const { block, index } of allocationOrder) {
    const value = dedupedText.get(index) ?? '';
    if (!value) continue;
    const separator = used > 0 ? 2 : 0;
    const remaining = Math.max(0, budget - used - separator);
    if (value.length <= remaining) {
      parts[index] = value;
      includedSet.add(block.id);
      used += separator + value.length;
      continue;
    }

    // Core blocks may be clipped on line boundaries; lower-priority blocks are dropped.
    if (block.priority <= 2 && remaining > 120) {
      const lines = value.split('\\n');
      const kept: string[] = [];
      let chars = 0;
      for (const line of lines) {
        const next = chars + (kept.length ? 1 : 0) + line.length;
        if (next > remaining - 80) break;
        kept.push(line);
        chars = next;
      }
      if (kept.length) {
        parts[index] = kept.join('\\n');
        includedSet.add(block.id);
        used += separator + parts[index]!.length;
        dropped.push({ id: block.id, reason: `trimmed to fit budget (${lines.length - kept.length} line(s) omitted)` });
        continue;
      }
    }
    dropped.push({ id: block.id, reason: 'context budget exhausted' });
  }

  const hasNotice = dropped.length > 0 || dedupedLines > 0;
  let notice = hasNotice
    ? `[CONTEXT BUDGET]${dedupedLines > 0 ? ` ${dedupedLines} duplicated line(s) removed (owned by higher-priority context)` : ''}${dropped.length ? ` · omitted for space: ${dropped.map((d) => `${d.id} (${d.reason})`).join(', ')}` : ''}. What you see here is everything that survived.`
    : '';

  // Reserve room for the disclosure and reclaim the excess from the lowest-priority
  // included blocks first. This closes the old edge case where the notice pushed the
  // final prompt over budget even though the blocks themselves fit.
  if (notice.length > budget) notice = notice.slice(0, budget);
  const contentBudget = Math.max(0, budget - notice.length - (notice ? 2 : 0));
  let body = joinParts(parts);
  if (body.length > contentBudget) {
    const trimOrder = [...usable].sort(
      (a, b) => b.block.priority - a.block.priority || b.index - a.index,
    );
    for (const { block, index } of trimOrder) {
      if (body.length <= contentBudget) break;
      const current = parts[index];
      if (!current) continue;
      const excess = body.length - contentBudget;
      const target = Math.max(0, current.length - excess);
      if (target === 0) {
        parts[index] = undefined;
        includedSet.delete(block.id);
        if (!dropped.some((item) => item.id === block.id)) {
          dropped.push({ id: block.id, reason: 'trimmed to make room for the context notice' });
        }
      } else {
        const prefix = current.slice(0, target);
        const lineBoundary = prefix.lastIndexOf('\\n');
        const kept = lineBoundary > 0 ? prefix.slice(0, lineBoundary) : '';
        parts[index] = kept || undefined;
        if (!kept) includedSet.delete(block.id);
        if (!dropped.some((item) => item.id === block.id)) {
          dropped.push({ id: block.id, reason: 'trimmed to make room for the context notice' });
        }
      }
      body = joinParts(parts);
    }
  }

  // Rebuild the notice after final trimming, then enforce the hard limit as a last guard.
  if (dropped.length || dedupedLines > 0) {
    notice = `[CONTEXT BUDGET]${dedupedLines > 0 ? ` ${dedupedLines} duplicated line(s) removed (owned by higher-priority context)` : ''}${dropped.length ? ` · omitted for space: ${dropped.map((d) => `${d.id} (${d.reason})`).join(', ')}` : ''}. What you see here is everything that survived.`;
  }
  let text = [body, notice].filter(Boolean).join('\\n\\n');
  if (text.length > budget) {
    // Extremely small budgets cannot carry a complete notice; keep the notice honest
    // and bounded rather than allowing prompt construction to exceed its contract.
    text = notice ? notice.slice(0, budget) : body.slice(0, budget);
  }

  const included = usable
    .filter(({ index }) => includedSet.has(blocks[index].id) && Boolean(parts[index]))
    .map(({ block }) => block.id);

  return {
    text,
    included,
    dropped,
    dedupedLines,
    totalChars: text.length,
  };
}
