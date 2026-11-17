/**
 * SEMANTIC MEMORY RETRIEVAL (Pillar 5, §10.2 / Round 18 §7) — the retrieval layer over
 * the memory stores.
 *
 * TWO tiers, honestly labeled (the mandate forbids calling lexical matching "semantic"):
 *  - LEXICAL (always available): tokenization with light stemming + stopword removal,
 *    TF-IDF weighted cosine over the corpus, count/recency boosts, a score floor ("no
 *    padding"). Retrieved memories are labeled source 'lexical'.
 *  - HYBRID (Round 18 §7.3/§7.4): when a REAL embedding provider is configured
 *    (embeddings.ts — OpenAI-compatible endpoint or the optional local neural model),
 *    candidates are scored by BOTH lexical similarity and TRUE vector cosine, blended
 *    50/50, then boosted by count/recency and filtered by scope. Retrieved memories are
 *    labeled source 'vector' or 'hybrid'. This tier retrieves by MEANING: a memory about
 *    "SQL optimization" is reachable from a query about "database performance" even with
 *    zero shared stems — which is exactly what lexical matching cannot do.
 */

/** English stopwords that carry no retrieval signal. */
const STOPWORDS = new Set(
  ('a an and are as at be by for from has have i in is it its of on or that the this to was were will with user ' +
    'please should would could may might do does did done my me we our you your they them he she his her').split(' ')
);

/** Light suffix stemmer: good enough to fold plurals/tenses without a dictionary. */
function stem(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  // x/ch/sh + es loses both letters (boxes → box, watches → watch); a bare s+es loses
  // ONLY the s (uses → use, notes → note) — the Round 18 rule stripped "uses" to "us",
  // so a query for "use" could never match a memory saying "uses".
  if (/(?:x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1);
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2);
  return w;
}

/** Query/document terms: lowercased, stopword-free, stemmed. */
export function termsOf(text: string): string[] {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9₹$%+]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}

export interface RetrievableMemory {
  /** Stable record id (dedup + traceability). */
  id: string;
  /** The memory text (or a label/summary of the record). */
  text: string;
  /** Optional scope/category label, e.g. 'preference', 'project:jarvis'. */
  scope?: string;
  /** Times this record was reinforced (defaults to 1). */
  count?: number;
  /** Last update epoch ms (recency boost). */
  updated?: number;
}

export interface RetrievedMemory extends RetrievableMemory {
  score: number;
  /** How this memory was reached: 'lexical' (TF-IDF), 'vector' (embedding only), or
   *  'hybrid' (both agreed). Honest provenance for the caller. */
  source: 'lexical' | 'vector' | 'hybrid';
}

/** Inverted index over the corpus: term → record id → term frequency. */
function termFrequencies(text: string): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of termsOf(text)) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

/**
 * Retrieve the most relevant memories for `query`.
 * Score = cosine(TF-IDF) × (1 + 0.1·log2(count)) × (1 + 0.1·log2(1 + ageDays⁻¹ normalized))
 * Records below `minScore` are dropped (no padding). Pure and synchronous: the corpus is
 * small (≤ ~400 records), so an index-per-call is cheaper than maintaining incremental
 * state across stores that are each written rarely.
 */
export function retrieve(query: string, corpus: RetrievableMemory[], k = 6, minScore = 0.08): RetrievedMemory[] {
  const docs = corpus.filter((m) => m.text && String(m.text).trim());
  if (!docs.length) return [];
  const tfs = docs.map((d) => termFrequencies(`${d.text} ${d.scope ?? ''}`));
  // IDF over the corpus: rare terms are the informative ones.
  const df = new Map<string, number>();
  for (const tf of tfs) for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  const N = docs.length;
  const idf = (term: string): number => Math.log((N + 1) / ((df.get(term) ?? 0) + 0.5));
  const weight = (tf: Map<string, number>): Map<string, number> => {
    const out = new Map<string, number>();
    let norm = 0;
    for (const [term, freq] of tf) {
      const w = (1 + Math.log(freq)) * idf(term);
      out.set(term, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [term, w] of out) out.set(term, w / norm);
    return out;
  };
  const docVecs = tfs.map(weight);
  const qTf = termFrequencies(query);
  const qVec = weight(qTf);

  const now = Date.now();
  const scored: RetrievedMemory[] = [];
  for (let i = 0; i < docs.length; i++) {
    let dot = 0;
    for (const [term, w] of qVec) dot += w * (docVecs[i].get(term) ?? 0);
    if (dot <= 0) continue; // no shared terms at all → not a candidate
    const rec = docs[i];
    const countBoost = 1 + 0.1 * Math.log2(Math.max(1, rec.count ?? 1));
    const ageDays = Math.max(0, (now - (rec.updated ?? now)) / 86_400_000);
    const recencyBoost = 1 + 0.1 * Math.log2(1 + 30 / (1 + ageDays));
    const score = dot * countBoost * recencyBoost;
    if (score >= minScore) scored.push({ ...rec, score: Number(score.toFixed(4)), source: 'lexical' });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, Math.max(0, k));
}

export interface HybridOptions {
  k?: number;
  /** Lexical score floor (padding guard). */
  minScore?: number;
  /** REAL embedding provider (embeddings.ts) — omit for honest lexical-only retrieval. */
  provider?: { id: string; embed(texts: string[]): Promise<number[][]>; dims?: number } | null;
  /** Embedding similarity floor: vector-only candidates must clear this. */
  minVectorScore?: number;
  /** Keep only records whose scope matches this predicate (scope filtering, §7.3). */
  scopeFilter?: (scope: string | undefined) => boolean;
  /**
   * Round 19 (CHANGE 5): called when the provider was configured but FAILED (network,
   * bad model, dimension mismatch) and retrieval degraded to lexical. The caller uses
   * it to SAY the fallback happened — embedding retrieval is never claimed while a
   * lexical fallback actually produced the results.
   */
  onProviderError?: (e: Error) => void;
}

/**
 * HYBRID RETRIEVAL (§7.3/§7.4): lexical ∪ vector, blended, boosted, filtered,
 * deduplicated. With no provider this IS the lexical retriever (labeled honestly).
 * Pipeline: query understanding (the caller's request text) → query embedding (when a
 * provider exists) → candidate retrieval (TF-IDF cosine + vector cosine) → blended
 * scoring (50/50 where both exist) → relevance floor → scope filter → recency/count
 * adjustments → deduplication by record id → top-k context selection.
 */
export async function hybridRetrieve(query: string, corpus: RetrievableMemory[], opts: HybridOptions = {}): Promise<RetrievedMemory[]> {
  const k = opts.k ?? 6;
  const minScore = opts.minScore ?? 0.08;
  const minVector = opts.minVectorScore ?? 0.35;
  const docs = corpus.filter((m) => m.text && String(m.text).trim() && (opts.scopeFilter ? opts.scopeFilter(m.scope) : true));
  if (!docs.length) return [];

  // Tier 1: lexical scores (raw cosine, before boosts — computed here so the blend is
  // on comparable [0..1] scales rather than on boosted scores).
  const lexical = new Map<string, number>();
  {
    const tfs = docs.map((d) => termFrequencies(`${d.text} ${d.scope ?? ''}`));
    const df = new Map<string, number>();
    for (const tf of tfs) for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    const N = docs.length;
    const idf = (term: string): number => Math.log((N + 1) / ((df.get(term) ?? 0) + 0.5));
    const weight = (tf: Map<string, number>): Map<string, number> => {
      const out = new Map<string, number>();
      let norm = 0;
      for (const [term, freq] of tf) {
        const w = (1 + Math.log(freq)) * idf(term);
        out.set(term, w);
        norm += w * w;
      }
      norm = Math.sqrt(norm) || 1;
      for (const [term, w] of out) out.set(term, w / norm);
      return out;
    };
    const docVecs = tfs.map(weight);
    const qVec = weight(termFrequencies(query));
    docs.forEach((d, i) => {
      let dot = 0;
      for (const [term, w] of qVec) dot += w * (docVecs[i].get(term) ?? 0);
      lexical.set(d.id, dot); // normalized cosine ∈ [0..1]
    });
  }

  // Tier 2: vector cosine when a REAL provider is configured.
  const vector = new Map<string, number>();
  if (opts.provider) {
    try {
      const [qvec, ...dvecs] = await opts.provider.embed([query, ...docs.map((d) => d.text)]);
      // DIMENSION VALIDATION (Round 19, CHANGE 5): a provider returning vectors of the
      // wrong dimensionality (changed model, stale cache, misconfigured endpoint) must
      // never have its vectors silently truncated against the query — every vector
      // length must match the query's, and a declared dims (when known) must match too.
      const declared = opts.provider.dims;
      const qLen = qvec?.length ?? 0;
      const malformed =
        !qLen || dvecs.length !== docs.length || dvecs.some((v) => !v?.length || v.length !== qLen) || (declared !== undefined && declared > 0 && qLen !== declared);
      if (malformed) throw new Error(`embedding provider returned inconsistent vector dimensions (query ${qLen}${declared ? `, declared ${declared}` : ''})`);
      docs.forEach((d, i) => vector.set(d.id, cosineOf(qvec, dvecs[i])));
    } catch (e) {
      // provider failure degrades to lexical — retrieval never breaks because of it —
      // and the caller is TOLD (honest fallback, never a silent semantic claim).
      opts.onProviderError?.(e instanceof Error ? e : new Error(String(e)));
    }
  }
  const hasVector = vector.size > 0;

  const now = Date.now();
  const scored: RetrievedMemory[] = [];
  for (const d of docs) {
    const lex = lexical.get(d.id) ?? 0;
    const vec = vector.get(d.id) ?? 0;
    const blend = hasVector ? 0.5 * lex + 0.5 * vec : lex;
    if (hasVector) {
      // A record reachable ONLY through meaning must still clear its own floor.
      if (lex < minScore && vec < minVector) continue;
    } else if (lex < minScore) {
      continue; // no padding in lexical-only mode either
    }
    const countBoost = 1 + 0.1 * Math.log2(Math.max(1, d.count ?? 1));
    const ageDays = Math.max(0, (now - (d.updated ?? now)) / 86_400_000);
    const recencyBoost = 1 + 0.1 * Math.log2(1 + 30 / (1 + ageDays));
    const score = blend * countBoost * recencyBoost;
    const source: RetrievedMemory['source'] = hasVector ? (lex >= minScore ? 'hybrid' : 'vector') : 'lexical';
    scored.push({ ...d, score: Number(score.toFixed(4)), source });
  }
  // Dedup by record id (a corpus may legitimately carry duplicates across stores).
  const seen = new Set<string>();
  return scored
    .sort((a, b) => b.score - a.score)
    .filter((m) => !seen.has(m.id) && seen.add(m.id))
    .slice(0, Math.max(0, k));
}

const cosineOf = (a: number[], b: number[]): number => {
  if (!a?.length || !b?.length) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
};

/**
 * The prompt block for the CURRENT request: only the memories that actually bear on it.
 * Returns '' when nothing is relevant — never pad, never dump the store. The retrieval
 * tier used is stated HONESTLY in the block (lexical vs semantic+lexical), including a
 * visible note when a configured embedding provider failed and lexical fallback ran.
 *
 * ROUND 31 (§3.2) — SCOPE AFFINITY: when the request names a project that some records
 * are explicitly scoped to ("project:<name>"), those records get a bounded relevance
 * boost over unscoped records — work on a project surfaces that project's decisions and
 * constraints first.
 *
 * ROUND 32 (§5.2) — PROJECT ISOLATION (a different responsibility from ranking):
 * `allowedProjectScopes` is the canonical scope set the request legitimately touches
 * (computed by memory.projectScopesForRequest from the STABLE project registry). A
 * project-scoped record OUTSIDE this set is another project's private context and is
 * EXCLUDED — not merely demoted. When the request names no project, NO project-scoped
 * record is injected (never guess which project's memories to pull in). Filtering
 * happens BEFORE ranking; the affinity boost only orders what survived the filter.
 */
export async function relevantMemoryBlock(
  request: string,
  loadCorpus: () => Promise<RetrievableMemory[]>,
  k = 5,
  provider?: { id: string; embed(texts: string[]): Promise<number[][]>; dims?: number } | null,
  opts?: { allowedProjectScopes?: Set<string> }
): Promise<string> {
  const q = String(request ?? '').trim();
  if (!q) return '';
  // Round 20 (CHANGE 7): a corpus-load failure is no longer indistinguishable from "no
  // relevant memories" — the failure is surfaced in the block so the model knows the
  // store could not be read at all (and can tell the user), never silently empty.
  let corpusError = '';
  const loaded = (await loadCorpus().catch((e: unknown) => {
    corpusError = e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120);
    return [] as RetrievableMemory[];
  })).filter((m) => !(m as { superseded?: boolean }).superseded);
  // §5.2 ISOLATION FILTER (before any ranking): a project-scoped record survives only
  // when its scope is in the request's allowed set; unscoped records always survive.
  const allowed = opts?.allowedProjectScopes;
  const excludedPrivate = allowed ? loaded.filter((m) => (m.scope ?? '').startsWith('project:') && !allowed.has(m.scope ?? '')).length : 0;
  const corpus = allowed ? loaded.filter((m) => !(m.scope ?? '').startsWith('project:') || allowed.has(m.scope ?? '')) : loaded.filter((m) => !(m.scope ?? '').startsWith('project:'));
  let fallback = '';
  const hits = await hybridRetrieve(q, corpus, {
    k,
    provider,
    onProviderError: (e) => {
      fallback = provider ? ` (note: the configured embedding provider failed — ${e.message.slice(0, 120)} — so this result is LEXICAL, not semantic)` : '';
    },
  });
  if (corpusError) {
    return `MEMORIES: the memory corpus could not be loaded (${corpusError}) — nothing was retrieved. Do not pretend memories were checked.`;
  }
  // A provider failure is reported even when nothing matched: the model must not assume a
  // semantic search ran and found nothing.
  if (!hits.length) return fallback ? `MEMORIES RELEVANT TO THIS REQUEST: none found (retrieved by lexical relevance${fallback}).` : '';
  // ROUND 31 scope affinity (bounded re-rank, AFTER the isolation filter): a record
  // scoped to a project the request names outranks an equally-relevant unscoped record.
  const namedScopes = new Set(
    (q.toLowerCase().match(/\b[a-z][a-z0-9_-]{2,24}\b/g) ?? []).map((w) => `project:${w}`),
  );
  const scoped = hits.some((h) => (h.scope ?? '').startsWith('project:'));
  const ranked = scoped
    ? [...hits]
        .map((h) => {
          const s = h.scope ?? '';
          const affinity = s.startsWith('project:') && namedScopes.has(s) ? 0.5 : s.startsWith('project:') ? -0.1 : 0;
          return { ...h, score: Number((h.score + affinity).toFixed(4)) };
        })
        .sort((a, b) => b.score - a.score)
    : hits;
  const tier = hits.some((h) => h.source !== 'lexical') ? 'semantic + lexical relevance (embedding model in use)' : 'lexical relevance';
  const isolationNote = excludedPrivate > 0 ? ` (${excludedPrivate} record(s) from other projects withheld — project isolation)` : '';
  return [
    `MEMORIES RELEVANT TO THIS REQUEST (retrieved by ${tier}${fallback}; the full store was not injected${isolationNote}):`,
    ...ranked.map((h) => `- ${h.text}${h.scope && !h.text.startsWith(h.scope) ? ` [${h.scope}]` : ''}`),
  ].join('\n');
}
