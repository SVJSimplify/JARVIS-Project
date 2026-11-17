/**
 * CONTEXT BUDGETING (Round 31 §3.5) — how JARVIS assembles the per-turn context blocks
 * that accompany the system prompt.
 *
 * Rules enforced here, in one place:
 *  - PRIORITY, not recency: critical blocks (standing instructions, constraints, task
 *    context) survive budget pressure first; decorative context is dropped first.
 *  - DEDUPLICATION: the same line never ships twice across blocks (memory retrieval,
 *    project context and the learning prompt overlap by design; the overlap must not
 *    consume the budget twice).
 *  - BOUNDED: the assembled context never exceeds the budget; each block is clipped on
 *    line boundaries, never mid-identifier.
 *  - HONESTY: when something was dropped for budget, a one-line note says so — the model
 *    is never left assuming it saw everything.
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
  /** Lines removed because an earlier block already carried them (dedupe, not loss). */
  dedupedLines: number;
  totalChars: number;
}

/** Strip markdown decoration for comparison; keeps identifiers intact. */
const normLine = (line: string): string => line.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Assemble the per-turn context under one budget. Blocks are placed in the given order
 * (callers own the display order) but CLIPPED by priority: when the budget is exhausted,
 * the lowest-priority remaining block is dropped (or trimmed to fit) with an explicit
 * note. Lines already seen in a higher-priority block are removed from later blocks so
 * duplicated memory/context never consumes the budget twice.
 */
export function assembleTurnContext(blocks: ContextBlock[], budgetChars: number): AssembledContext {
  const usable = blocks.filter((b) => b.text && b.text.trim());
  const seen = new Set<string>();
  const included: string[] = [];
  const dropped: AssembledContext['dropped'] = [];
  const parts: string[] = [];
  let total = 0;
  let dedupedLines = 0;

  // Pre-dedupe: count how much each block ADDS after dedupe against earlier blocks.
  const deduped = usable.map((b) => {
    const lines = b.text.split('\n');
    const fresh: string[] = [];
    for (const line of lines) {
      const key = normLine(line);
      if (key.length > 3 && seen.has(key)) {
        dedupedLines++;
        continue;
      }
      if (key.length > 3) seen.add(key);
      fresh.push(line);
    }
    const text = fresh.join('\n').trim();
    return { block: b, text };
  });

  // Greedy fill in priority order among the REMAINING budget, preserving the caller's
  // order for display: include a block fully when it fits; when it does not, either trim
  // it on a line boundary (priority ≤ 2 keeps a core) or drop it (priority ≥ 3).
  const order = [...deduped.entries()]
    .map(([idx, d]) => ({ idx, ...d }))
    .sort((a, b) => a.block.priority - b.block.priority);

  for (const { idx, block, text } of order) {
    const remaining = budgetChars - total;
    if (remaining <= 200 && block.priority >= 3) {
      dropped.push({ id: block.id, reason: 'context budget exhausted' });
      continue;
    }
    if (text.length <= remaining) {
      parts[idx] = text;
      included.push(block.id);
      total += text.length;
      continue;
    }
    // Trim on a line boundary, keeping whole lines; the cut is stated inside the block.
    if (block.priority <= 2 && remaining > 400) {
      const lines = text.split('\n');
      let acc = 0;
      let cut = 0;
      for (let i = 0; i < lines.length; i++) {
        if (acc + lines[i].length + 1 > remaining - 120) {
          cut = i;
          break;
        }
        acc += lines[i].length + 1;
        cut = i + 1;
      }
      if (cut > 0) {
        const kept = lines.slice(0, cut).join('\n');
        parts[idx] = `${kept}\n[... ${block.id} trimmed to fit the context budget — ${lines.length - cut} line(s) omitted]`;
        included.push(block.id);
        total += kept.length + 120;
        dropped.push({ id: block.id, reason: `trimmed to fit budget (${lines.length - cut} lines omitted)` });
        continue;
      }
    }
    dropped.push({ id: block.id, reason: 'context budget exhausted' });
  }

  const note = dropped.length || dedupedLines > 0
    ? `[CONTEXT BUDGET]${dedupedLines > 0 ? ` ${dedupedLines} duplicated line(s) removed (already present in a higher-priority block)` : ''}${dropped.length ? ` · omitted for space: ${dropped.map((d) => `${d.id} (${d.reason})`).join(', ')}` : ''}. What you see here is everything that survived.`
    : '';
  const text = [
    ...parts.filter(Boolean),
    ...(note ? [note] : []),
  ].join('\n\n');

  return {
    text,
    included,
    dropped: dropped.map((d) => ({ ...d })),
    dedupedLines,
    totalChars: text.length,
  };
}
