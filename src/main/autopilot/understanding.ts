/**
 * PROJECT UNDERSTANDING (Round 22, §3.1) — natural language → structured project.
 *
 * Two-stage design, mirroring the Round 21 "deterministic floor, model ceiling" pattern
 * (taskSpec.ts): a PURE deterministic extractor always produces a usable understanding;
 * an optional model pass may refine it. The model's output is UNTRUSTED structured text:
 * fields are clipped, shape-checked and de-duplicated, and every field's provenance is
 * recorded in `sources`. Where the model cannot confidently provide a field, the
 * deterministic default stands — the project layer never invents certainty, and
 * assumptions stay assumptions (never silently promoted to requirements).
 *
 * No model call happens inside this module: the caller injects one (tests inject a
 * deterministic fake; the engine passes a completeOnce-based call). A missing or failing
 * model degrades to the deterministic floor, never to an error.
 */

import type { ProjectCategory, ProjectComplexity, ProjectUnderstanding, UnderstandingSources } from './types';

/** Local word clipper (same semantics as taskSpec's private helper — no shared-file edit). */
const clipWords = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  const words = t.split(' ');
  return words.length <= n ? t : `${words.slice(0, n).join(' ')}…`;
};

// ------------------------------------------------------------------ deterministic lexicon

const CATEGORY_HINTS: Array<[RegExp, ProjectCategory]> = [
  [/\b(app|website|api|service|script|program|software|refactor|migrat\w*|deploy|codebase|library|cli|extension|plugin|test suite|bug)\b/i, 'software'],
  [/\b(article|blog|post|book|chapter|newsletter|script for video|copywriting|video|podcast|presentation|deck|documentation|doc set)\b/i, 'content'],
  [/\b(research|survey|literature|market|competitor|benchmark|study|investigat\w*|landscape|analysis of trends)\b/i, 'research'],
  [/\b(dataset|data ?set|spreadsheet|dashboard|metrics|analytics|etl|pipeline|clean(?:ing|se)? the data|visualization|report on)\b/i, 'data'],
  [/\b(organize|organise|migrate files|backup|inventory|schedule|workflow|checklist|inventory|move|rename files|folder structure)\b/i, 'operations'],
];

const COMPLEXITY_HINTS: Array<[RegExp, ProjectComplexity]> = [
  [/\b(simple|quick|small|one-?page|single file|minimal|lightweight|just |only )\b/i, 'light'],
  [/\b(complex|large|multi-?(phase|stage|step)|platform|architecture|system|enterprise|production|integrat\w*|scalable)\b/i, 'complex'],
];

const splitList = (text: string): string[] =>
  text
    .split(/\r?\n|(?:;|(?:^|\s)- )/g)
    .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);

/** Deterministic requirement candidates: imperatives and "must/need/should" clauses. */
const REQUIREMENT_RE = /\b(?:must|needs? to|needs?|has to|should|require(?:s|d)?|make sure|ensure)\b[^.;!?]{3,120}/gi;
/** Constraint candidates: negatives and boundaries. */
const CONSTRAINT_RE = /\b(?:without|don'?t|do not|must not|never|no |except|avoid|only use|keep (?:it|the)? ?under|at most|limit(?:ed)? to)\b[^.;!?]{3,100}/gi;
/** Assumption markers: things the description leaves open. */
const ASSUMPTION_RE = /\b(?:assume|assuming|probably|presumably|likely|i think|should be(?:\s+\w+)?? ?already|existing)\b[^.;!?]{3,100}/gi;
/** Out-of-scope markers. */
const OUT_RE = /\b(?:out of scope|not (?:in|part of) (?:the )?scope|excluding|except|doesn'?t need|does not need|don'?t (?:build|include)|no need (?:to|for))\b[^.;!?]{3,100}/gi;
/** Success markers. */
const SUCCESS_RE = /\b(?:success(?:ful)?(?:ly)? ?(?:when|if|means|criteria)|done when|complete when|accepted (?:when|if)|ready when|passes?|approved)\b[^.;!?]{3,120}/gi;
/** Deliverable-ish nouns. */
const DELIVERABLE_NOUN_RE =
  /\b(?:a|an|the)?\s?(file|document|report|summary|spreadsheet|sheet|dashboard|slides?|presentation|deck|pdf|docx|xlsx|pptx|csv|website|web ?app|app|api|script|library|cli|database|schema|dataset|article|blog ?post|video ?script|design|mockup|diagram|plan|blueprint|checklist|inventory|list)\b[^.;!?]{0,60}/gi;

const dedupe = (items: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const s = raw.replace(/\s+/g, ' ').trim().replace(/[,;]$/, '');
    if (!s || s.length < 4) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s.slice(0, 160));
    if (out.length >= 12) break;
  }
  return out;
};

const collect = (text: string, re: RegExp, cap = 8): string[] => {
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    out.push(m[0].trim());
    if (out.length >= cap) break;
  }
  return dedupe(out);
};

const titleCase = (s: string): string =>
  s
    .split(/\s+/)
    .map((w) => (w.length > 3 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');

/** Deterministic title: the first sentence-like chunk, clipped. */
const defaultTitle = (text: string): string => {
  const first = text.split(/[.!?\n]/)[0] ?? text;
  const clean = first.replace(/^\s*(?:build|create|make|develop|write|produce|organize|organise|plan)\s+(?:me\s+)?(?:a|an|the)?\s*/i, '').trim();
  return titleCase(clipWords(clean || first, 8)) || 'Untitled project';
};

// --------------------------------------------------------------------- the extractor

/** The deterministic floor. Pure; injectable `now` for tests. */
export function extractUnderstanding(text: string, now: number = Date.now()): ProjectUnderstanding {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const requirements = collect(t, REQUIREMENT_RE);
  const constraints = collect(t, CONSTRAINT_RE);
  const assumptions = collect(t, ASSUMPTION_RE);
  const outOfScope = collect(t, OUT_RE);
  const successCriteria = collect(t, SUCCESS_RE);
  const deliverables = collect(t, DELIVERABLE_NOUN_RE, 8).map((d) => clipWords(d, 10));

  let category: ProjectCategory = 'general';
  for (const [re, c] of CATEGORY_HINTS) {
    if (re.test(t)) {
      category = c;
      break;
    }
  }
  let complexity: ProjectComplexity = 'standard';
  for (const [re, cx] of COMPLEXITY_HINTS) {
    if (re.test(t)) {
      complexity = cx;
      break;
    }
  }
  // Multi-list or multi-requirement descriptions are at least standard complexity.
  if (complexity === 'light' && (requirements.length >= 3 || splitList(t).length >= 6)) complexity = 'standard';

  const sources: UnderstandingSources = {
    title: 'default',
    objective: 'default',
    summary: 'default',
    requirements: requirements.length ? 'user' : 'default',
    constraints: constraints.length ? 'user' : 'default',
    assumptions: assumptions.length ? 'user' : 'default',
    outOfScope: outOfScope.length ? 'user' : 'default',
    successCriteria: successCriteria.length ? 'model' : 'default',
    deliverables: deliverables.length ? 'user' : 'default',
    category: 'default',
    complexity: 'default',
  };

  const title = defaultTitle(t);
  return {
    title,
    objective: clipWords(t, 40),
    summary: clipWords(t, 120),
    requirements: requirements.length ? requirements : ['fulfil the request as described'],
    constraints,
    assumptions,
    outOfScope,
    // Deterministic floor for success: honest, checkable, never invented.
    successCriteria: successCriteria.length ? successCriteria : ['the described outcome exists and is verified against reality'],
    deliverables,
    category,
    complexity,
    sources,
    understoodAt: now,
  };
}

// --------------------------------------------------------------------- model refinement

/** The shape the model must return. Every field optional — missing fields keep the floor. */
export type ModelUnderstanding = Partial<
  Pick<
    ProjectUnderstanding,
    'title' | 'objective' | 'summary' | 'category' | 'complexity'
  >
> & {
  requirements?: string[];
  constraints?: string[];
  assumptions?: string[];
  outOfScope?: string[];
  successCriteria?: string[];
  deliverables?: string[];
};

const asStringList = (v: unknown, cap = 12): string[] =>
  Array.isArray(v) ? dedupe(v.map((x) => String(x ?? '').trim()).filter(Boolean)).slice(0, cap) : [];

const CATEGORIES: ProjectCategory[] = ['software', 'content', 'research', 'data', 'operations', 'general'];
const COMPLEXITIES: ProjectComplexity[] = ['light', 'standard', 'complex'];

const clip = (s: string, n: number): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Merge an UNTRUSTED model understanding over the deterministic floor. Shape-checks
 * everything; a field the model did not confidently provide keeps its deterministic
 * default AND its provenance label. Assumptions from the model stay assumptions.
 */
export function mergeUnderstanding(floor: ProjectUnderstanding, model: ModelUnderstanding | null | undefined): ProjectUnderstanding {
  if (!model || typeof model !== 'object') return floor;
  const out: ProjectUnderstanding = { ...floor, sources: { ...floor.sources } };
  const modelTitle = clip(String((model as { title?: unknown }).title ?? ''), 80);
  if (modelTitle) {
    out.title = modelTitle;
    out.sources.title = 'model';
  }
  const modelObjective = clip(String(model.objective ?? ''), 200);
  if (modelObjective) {
    out.objective = modelObjective;
    out.sources.objective = 'model';
  }
  const modelSummary = clip(String(model.summary ?? ''), 600);
  if (modelSummary) {
    out.summary = modelSummary;
    out.sources.summary = 'model';
  }
  const listSources: Array<keyof UnderstandingSources> = ['requirements', 'constraints', 'assumptions', 'outOfScope', 'successCriteria', 'deliverables'];
  for (const key of listSources) {
    const list = asStringList((model as Record<string, unknown>)[key]);
    if (list.length) {
      (out[key] as string[]) = list;
      out.sources[key] = 'model';
    }
  }
  const cat = String((model as { category?: unknown }).category ?? '').trim().toLowerCase() as ProjectCategory;
  if (CATEGORIES.includes(cat)) {
    out.category = cat;
    out.sources.category = 'model';
  }
  const cx = String((model as { complexity?: unknown }).complexity ?? '').trim().toLowerCase() as ProjectComplexity;
  if (COMPLEXITIES.includes(cx)) {
    out.complexity = cx;
    out.sources.complexity = 'model';
  }
  out.understoodAt = Date.now();
  return out;
}

/** The understanding prompt (exported for the engine's model call and for tests). */
export const understandingPrompt = (description: string): string =>
  [
    'You analyse a project description the user gave. Extract a STRUCTURED understanding.',
    'Reply with ONLY JSON: {"title": short name, "objective": one sentence, "summary": short paragraph,',
    '"requirements": [must-haves], "constraints": [boundaries and prohibitions],',
    '"assumptions": [things you must ASSUME because the description leaves them open — never promote these to requirements],',
    '"outOfScope": [explicitly excluded work], "successCriteria": [checkable outcomes],',
    '"deliverables": [artifacts that must exist], "category": "software"|"content"|"research"|"data"|"operations"|"general",',
    '"complexity": "light"|"standard"|"complex"}.',
    'Never invent certainty: if a field is not determinable from the description, omit it.',
    'Keep assumptions as assumptions.',
    '',
    'PROJECT DESCRIPTION:',
    clip(description, 4000),
  ].join('\n');
