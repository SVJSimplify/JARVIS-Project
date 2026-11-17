/**
 * TASK SPECIFICATION (Module A) — a structured representation of a user's intention.
 *
 * Converts a natural-language request into the durable shape the rest of the engine works
 * with: what was asked (verbatim), what it means (objective), what must exist afterwards
 * (deliverables + acceptance criteria), what must not happen (constraints), how risky the
 * work is, and whether a clarifying question is genuinely warranted.
 *
 * Design rules, enforced here in code:
 *  - Casual requests stay casual: a question or a one-tool lookup produces a MINIMAL spec
 *    with no ceremony (no acceptance criteria beyond evidence, no clarification).
 *  - Only side-effect tasks can be high risk; an informational task never is.
 *  - Clarification is reserved for action tasks whose critical parameter is missing —
 *    never a personality trait of the agent.
 *  - The user's original intent is preserved verbatim in `request`; the interpretation
 *    lives in `objective` so later stages can tell the two apart.
 *
 * Pure module: no electron, no fs, no model calls. The provider may refine a spec with a
 * model later; the classifier here is the deterministic floor, not the ceiling.
 */

export type TaskKind = 'informational' | 'action' | 'project';
export type RiskClass = 'low' | 'medium' | 'high';

/**
 * ROUND 31 (§1.5) — TASK COMPLEXITY CLASSIFICATION.
 * The class drives PLANNING DEPTH and EXECUTION STRATEGY (delegation.ts maps it to the
 * coordinator's strategy; the planner prompt receives it) without creating a second
 * planning pathway. Classes:
 *  - simple           one self-contained action or a plain lookup
 *  - multi_step       several ordered actions in one request
 *  - research         information gathering and synthesis (no world change)
 *  - development      code work in a project workspace
 *  - desktop          driving real applications on this machine
 *  - integration      external services (GitHub, Vercel, deployments, repos)
 *  - long_running     substantial multi-part work; project-scale planning pays
 *  - approval_required carries high risk — human-proportioned oversight expected
 */
export type TaskComplexity =
  | 'simple'
  | 'multi_step'
  | 'research'
  | 'development'
  | 'desktop'
  | 'integration'
  | 'long_running'
  | 'approval_required';

/**
 * ROUND 31 (§1.2) — AMBIGUITY LEVELS, in increasing order of user attention required:
 *  - clear      the request names its goal, target and enough parameters
 *  - assumable  underspecified, but a reasonable low-risk assumption exists — JARVIS
 *               proceeds and RECORDS the assumption explicitly (never silently)
 *  - clarify    a missing detail materially affects the result; exactly one question
 *  - blocking   cannot safely proceed at all without explicit user input
 * Casual conversation and plain questions are always 'clear'.
 */
export type AmbiguityLevel = 'clear' | 'assumable' | 'clarify' | 'blocking';

/** ROUND 31 (§1.1) — one intermediate outcome the end goal depends on. */
export interface SubGoal {
  /** The intermediate outcome in one imperative line. */
  title: string;
  /** Why this outcome is needed for the end goal. */
  purpose: string;
  /** Indices (into subGoals) of the sub-goals that must be done first. */
  dependsOn: number[];
  /** Capability families this outcome needs ('browser','research','code','write','desktop','integration'). */
  capabilities: string[];
  /** Risk of the work this outcome implies. */
  risk: RiskClass;
  /** What observable evidence will show this outcome exists. */
  evidence: string;
}

export type CriterionKind =
  | 'file-exists' // a specific file must exist on disk
  | 'file-nonempty' // …and hold bytes
  | 'file-format' // …and reopen/validate as its format (artifact validators)
  | 'command-passes' // a specific command must exit 0
  | 'evidence-present' // the turn's tool evidence must cover the claim
  | 'sources-present' // research: at least N distinct fetched sources
  | 'custom'; // free-form, checked as text presence by the verifier

export interface AcceptanceCriterion {
  id: string;
  kind: CriterionKind;
  /** Human-readable statement; also what the verifier reports against. */
  detail: string;
  /** Machine parameter: path, command, minimum count… */
  target?: string;
  min?: number;
}

export interface TaskSpec {
  /** The user's request, verbatim. */
  request: string;
  /** The interpreted objective, one or two sentences. */
  objective: string;
  kind: TaskKind;
  /** ROUND 31 (§1.5): planning-depth class — drives delegation strategy and planner hints. */
  complexity: TaskComplexity;
  /** ROUND 31 (§1.2): how underspecified the request is. */
  ambiguity: AmbiguityLevel;
  /** ROUND 31 (§1.2): low-risk assumptions the engine is proceeding on (explicit, never silent). */
  assumptions: string[];
  /** ROUND 31 (§1.1): what is genuinely missing for a confident interpretation. */
  missingInfo: string[];
  /** ROUND 31 (§1.1): intermediate outcomes the end goal decomposes into (empty for simple work). */
  subGoals: SubGoal[];
  deliverables: string[];
  constraints: string[];
  acceptance: AcceptanceCriterion[];
  risk: RiskClass;
  /** Tool families the work needs (open/write/execute/browser/research). */
  capabilities: string[];
  needsClarification: boolean;
  /** The single question worth asking, when needsClarification. */
  clarification?: string;
  createdAt: number;
}

// ------------------------------------------------------------------ deterministic lexicon

// ROUND 28 (§1.5 usability): `do/does/did` open a QUESTION only when a personal subject
// follows ("do you…", "does it…"). The imperative "do the long running background work
// please" is an ACTION request and was misread as a question (startTask refused it) —
// an honest classifier must not turn a direct order into a refusal.
const QUESTION_RE = /^\s*(what|who|when|where|why|which|how|is|are|can|could|would|will|should)\b|^\s*(?:do|does|did)\s+(you|i|we|they|he|she|it|anyone|anybody|someone|somebody|one)\b|\?\s*$/i;
const ACTION_VERB_RE =
  /\b(open|launch|start|close|write|create|make|build|save|update|edit|fix|run|send|schedule|set|install|download|upload|type|click|move|copy|rename|convert|generate|draft|compose|reply|email|message|export|print|organize|organise|clean|sort|apply|checkout|buy|order|book|do|perform|execute|monitor|complete|finish|continue|deploy|ship|inspect|review|investigate|implement|publish|merge|push)\b/i;
const FILE_TARGET_RE =
  /\b(file|document|doc|report|notes?|letter|spreadsheet|sheet|slides?|presentation|deck|pdf|docx|xlsx|pptx|csv|txt|md|markdown|script|program|app|list|summary|plan)\b/i;
const WRITE_HINT_RE =
  /\b(write|create|make|save|update|edit|generate|draft|compose|export|fix|refactor|download|convert)\b/i;
const CODE_HINT_RE = /\b(code|script|program|app|function|bug|error|test|build|compile|refactor|npm|python|typescript)\b/i;
const RESEARCH_HINT_RE = /\b(research|find out|look up|search|compare|investigate|market|news|price|benchmark|latest|current)\b/i;
const BROWSER_HINT_RE = /\b(browser|website|web ?page|url|http|online|amazon|google|youtube|log ?in|form|checkout)\b/i;

const HIGH_RISK_RE =
  /\b(delete|remove all|format |diskpart|uninstall|payment|pay |purchase|buy |checkout|transfer|send money|credentials|password|api key|registry|reg add|shutdown|restart the (pc|computer)|factory reset)\b/i;
const MEDIUM_RISK_RE =
  /\b(send|email|message|post|publish|submit|upload|install|update the|overwrite|replace|move |rename|schedule|close_app|stop )\b/i;

const CLARIF_GAPS: Array<[RegExp, string]> = [
  [/\b(send|email|message)\b[^.?!]*\b(to (him|her|them|it|the group))\b/i, 'Who exactly should receive it?'],
  [/\b(send|email)\b(?!.*\b(to|at)\b)/i, 'Where should it go — which address or contact?'],
  [/\b(save|create|write|make)\b[^.?!]*\b(it|this|the (file|document|report))\b\s*$/i, 'Where should the result be saved — a file name or folder?'],
];

// ROUND 31 (§1.2) — VAGUENESS: requests whose TARGET is unnamed. The distinction that
// matters is whether proceeding on a reasonable assumption is LOW RISK or materially
// changes the result ("improve the design" of a personal note is assumable; "fix the
// application" before a deploy is not).
const VAGUE_TARGET_RE =
  /\b(?:make (?:it|this|them) better|improve (?:it|this|them)?|fix (?:it|this|the app(?:lication)?|the bugs?)|clean(?: ?up)? (?:it|this|the project|the code)|polish (?:it|this)|optimize (?:it|this)|do better|make (?:it|this) work)\b/i;
const ASSUMPTION_FOR_VAGUE: Record<string, string> = {
  improve: 'assume the most recently discussed or most obvious artifact of this workspace is the improvement target',
  fix: 'assume the reported problem is the primary defect in the current workspace and verify the actual state before changing anything',
  clean: 'assume cleanup means obvious dead code and inconsistencies only — behavior stays unchanged',
};
const vagueKindOf = (text: string): 'improve' | 'fix' | 'clean' | null => {
  if (/\b(?:improve|better|polish)\b/i.test(text)) return 'improve';
  if (/\bfix\b/i.test(text)) return 'fix';
  if (/\bclean\b/i.test(text)) return 'clean';
  return null;
};

// ROUND 31 (§1.5) — complexity lexicon.
const DESKTOP_HINT_RE =
  /\b(notepad|calculator|vs ?code|discord|whatsapp|spotify|explorer|file explorer|minimi[sz]e|maximi[sz]e|screen|mouse|keyboard|press (?:keys?|enter|ctrl)|click (?:on )?(?:the )?(?:button|icon|app)|window|screenshot|volume|brightness|clipboard)\b/i;
const INTEGRATION_HINT_RE =
  /\b(github|git ?lab|vercel|netlify|deploy(?:ment)?|pull ?request|\bPR\b|issues?\b|repo(?:sitory)?|workflow|CI\b|pipeline|release|npm publish|webhook|slack|jira|linear)\b/i;
const SEQUENCE_RE = /\b(?:then|after (?:that|this)|once (?:that|done|it)|and then|afterwards|next,?)\b/i;
const SCALE_HINT_RE = /\b(whole|entire|full|complete(?:ly)?|end[- ]to[- ]end|everything|all (?:the|of)|across|from scratch|overhaul|migration|migrate)\b/i;
/** Global-flag variant of ACTION_VERB_RE for counting distinct action verbs (match resets lastIndex). */
const ACTION_VERB_COUNT_RE = new RegExp(ACTION_VERB_RE.source, 'gi');

const clipWords = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  const words = t.split(' ');
  return words.length <= n ? t : `${words.slice(0, n).join(' ')}…`;
};

const criterion = (kind: CriterionKind, detail: string, target?: string, min?: number): AcceptanceCriterion => ({
  id: `${kind}-${Math.random().toString(36).slice(2, 8)}`,
  kind,
  detail,
  target,
  min,
});

// ------------------------------------------------------------------- round 31 classifiers

/**
 * ROUND 31 (§1.5) — classify the planning-depth class of the request. Deterministic
 * floor over the same lexicons the rest of the spec uses; specific classes win over
 * generic ones (a deployment that touches code is integration, not development).
 */
export function classifyComplexity(
  kind: TaskKind,
  capabilities: string[],
  lower: string,
  risk: RiskClass
): TaskComplexity {
  if (kind === 'informational') return RESEARCH_HINT_RE.test(lower) ? 'research' : 'simple';
  if (risk === 'high') return 'approval_required';
  const actionCount = new Set((lower.match(ACTION_VERB_COUNT_RE) ?? []).map((v) => v.toLowerCase())).size;
  const sequenced = SEQUENCE_RE.test(lower);
  const scaled = SCALE_HINT_RE.test(lower);
  if (INTEGRATION_HINT_RE.test(lower)) return 'integration';
  if (DESKTOP_HINT_RE.test(lower) && !capabilities.includes('code')) return 'desktop';
  if (capabilities.includes('code')) {
    if (scaled || (sequenced && actionCount >= 3)) return 'long_running';
    return 'development';
  }
  if (actionCount >= 3 || (sequenced && actionCount >= 2) || scaled) return 'long_running';
  if (actionCount === 2 || sequenced) return 'multi_step';
  if (RESEARCH_HINT_RE.test(lower)) return 'research';
  return 'simple';
}

/**
 * ROUND 31 (§1.2) — classify how underspecified the request is, and produce the explicit
 * assumption (when proceeding is reasonable) or the one question worth asking.
 * Order: blocking → clarify → assumable → clear. Informational requests are always clear.
 */
export function detectAmbiguity(
  kind: TaskKind,
  risk: RiskClass,
  lower: string
): { level: AmbiguityLevel; assumptions: string[]; missingInfo: string[]; question?: string } {
  if (kind === 'informational') return { level: 'clear', assumptions: [], missingInfo: [] };
  const assumptions: string[] = [];
  const missingInfo: string[] = [];

  // Genuinely blocking: the request cannot proceed safely without the user (no usable
  // target at all, or a high-risk action whose critical parameter is missing).
  const hasTarget = /\b(?:it|this|that|them)\b/.test(lower) || FILE_TARGET_RE.test(lower) || !VAGUE_TARGET_RE.test(lower);
  if (!hasTarget) {
    missingInfo.push('the target of the request (what exactly should change)');
    if (risk === 'high') {
      return { level: 'blocking', assumptions, missingInfo, question: 'What exactly should this action target? It is high-risk, so I will not guess.' };
    }
  }

  // Existing blocking gaps keep their precise questions (recipients, destinations).
  for (const [re, question] of CLARIF_GAPS) {
    if (re.test(lower)) {
      missingInfo.push(question.replace(/\?$/, ''));
      if (risk === 'high') return { level: 'blocking', assumptions, missingInfo, question };
      return { level: 'clarify', assumptions, missingInfo, question };
    }
  }

  // Vague-target requests: reasonable, LOW-RISK assumptions are made explicit and work
  // continues; medium-risk vagueness asks one question (the result differs materially
  // depending on the answer); high risk was already handled above.
  if (VAGUE_TARGET_RE.test(lower)) {
    const vague = vagueKindOf(lower);
    if (vague) {
      if (risk === 'medium') {
        return {
          level: 'clarify',
          assumptions,
          missingInfo: [...missingInfo, 'which specific part should be changed'],
          question:
            vague === 'fix'
              ? 'What specifically is broken — which behavior or error should I focus on?'
              : vague === 'improve'
                ? 'What should the improvement focus on — appearance, performance, or structure?'
                : 'What does "clean up" mean here — dead code, files, or formatting?',
        };
      }
      const a = ASSUMPTION_FOR_VAGUE[vague];
      if (a) assumptions.push(a);
    }
  }

  // Missing save destination for a written file is assumable at low risk (a sensible
  // workspace name is chosen and reported), never silent.
  if (kind === 'action' && FILE_TARGET_RE.test(lower) && WRITE_HINT_RE.test(lower) && !/\b(?:to|into|in|save (?:it )?(?:as|to)|folder|directory)\b[^.]*\b[\w-]+\.(?:txt|md|docx|xlsx|pptx|pdf|csv|json)\b/i.test(lower)) {
    assumptions.push('no destination named — the result will be saved into the workspace with a descriptive name and the path reported');
  }
  if (kind === 'action' && INTEGRATION_HINT_RE.test(lower) && /\bdeploy\b/i.test(lower) && !/\b(?:vercel|netlify|github pages|aws|fly\.io|render)\b/i.test(lower)) {
    missingInfo.push('the deployment platform (proceeding only if exactly one configured integration applies)');
  }

  const level: AmbiguityLevel = assumptions.length ? 'assumable' : missingInfo.length ? 'clarify' : 'clear';
  return {
    level,
    assumptions,
    missingInfo,
    question: level === 'clarify' ? (missingInfo[0] ? `Please specify: ${missingInfo[0]}.` : undefined) : undefined,
  };
}

/**
 * ROUND 31 (§1.1) — decompose a substantial request into intermediate OUTCOMES.
 * Deterministic: clauses the request itself separates (conjunctions, sequence words,
 * sentence boundaries carrying an action verb) become sub-goals; each carries the
 * capability hints, risk and evidence its own text implies. Dependencies are SEQUENTIAL
 * by default; only explicit independence markers ("also", "separately", "at the same
 * time") unchain a clause — dependencies are never invented. Simple work decomposes to
 * nothing (no ceremony).
 *
 * ROUND 32 (§5.1) — INDEPENDENCE FIX: the Round 31 implementation split the text with a
 * regex that CONSUMED the independence markers, then tried to detect those same markers
 * in the resulting clauses — independence could never be recognized. The split now
 * PRESERVES the marker that introduced each clause, and that marker (not a re-scan of
 * the stripped clause text) decides whether the clause chains to its predecessor or
 * stands free. Dependencies always reference valid sub-goal indices; a high-risk clause
 * still stops decomposition (the user decides first).
 */
export function decomposeGoals(text: string, complexity: TaskComplexity): SubGoal[] {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const decomposable: TaskComplexity[] = ['multi_step', 'development', 'integration', 'long_running'];
  if (!decomposable.includes(complexity)) return [];

  // Clause boundaries: hard sentence breaks and explicit sequence markers. The split is
  // CAPTURING — each boundary records WHICH marker separated the clauses, so the marker
  // that introduces a clause survives into the dependency decision (§5.1).
  const BOUNDARY_RE = /(\.\s+|;\s+|\band then\b|\bthen\b|\bafter (?:that|this)\b|\bonce (?:that|done|it)(?:'s done)?,?\b|\bnext,?\b|\b(?:and )?also\b|\bin addition\b|\bplus\b|\bseparately\b|\bat the same time\b|\bmeanwhile\b)/gi;
  const INDEPENDENT_MARKER = /\b(?:also|separately|in addition|at the same time|meanwhile|plus)\b/i;

  // Walk the text, collecting { marker, clause } pairs: `marker` is the boundary text
  // that PRECEDED the clause ('' for the first one).
  const clauses: Array<{ marker: string; text: string }> = [];
  let last = 0;
  for (const m of t.matchAll(BOUNDARY_RE)) {
    const clauseText = t.slice(last, m.index ?? 0).replace(/^[\s,]+|[\s,]+$/g, '');
    if (clauseText.length > 8) clauses.push({ marker: '', text: clauseText });
    last = (m.index ?? 0) + m[0].length;
    clauses.push({ marker: m[0].trim(), text: '' }); // placeholder for the clause this marker introduces
  }
  const tail = t.slice(last).replace(/^[\s,]+|[\s,]+$/g, '');
  if (tail.length > 8) clauses.push({ marker: '', text: tail });
  // Merge each marker placeholder into the clause that follows it.
  const rawClauses: Array<{ independent: boolean; text: string }> = [];
  let pendingMarker = '';
  for (const c of clauses) {
    if (!c.text) {
      pendingMarker = c.marker;
      continue;
    }
    rawClauses.push({ independent: INDEPENDENT_MARKER.test(pendingMarker), text: c.text });
    pendingMarker = '';
  }
  if (rawClauses.length < 2) return [];

  const subGoals: SubGoal[] = [];
  for (let i = 0; i < rawClauses.length && subGoals.length < 8; i++) {
    const { independent, text: clauseText } = rawClauses[i];
    const clause = clipWords(clauseText, 24);
    const lowerClause = clauseText.toLowerCase();
    const caps: string[] = [];
    if (BROWSER_HINT_RE.test(lowerClause)) caps.push('browser');
    if (RESEARCH_HINT_RE.test(lowerClause)) caps.push('research');
    if (CODE_HINT_RE.test(lowerClause)) caps.push('code');
    if (INTEGRATION_HINT_RE.test(lowerClause)) caps.push('integration');
    if (DESKTOP_HINT_RE.test(lowerClause)) caps.push('desktop');
    if (WRITE_HINT_RE.test(lowerClause) || FILE_TARGET_RE.test(lowerClause)) caps.push('write');
    if (!caps.length) caps.push('write');
    const risk: RiskClass = HIGH_RISK_RE.test(lowerClause) ? 'high' : MEDIUM_RISK_RE.test(lowerClause) ? 'medium' : 'low';
    // §5.1: explicitly independent tasks do NOT depend on the preceding task; sequential
    // tasks keep the dependency on the immediately preceding sub-goal. Indices always
    // reference an existing sub-goal.
    const dependsOn = independent || subGoals.length === 0 ? [] : [subGoals.length - 1];
    const evidence = FILE_TARGET_RE.test(lowerClause)
      ? 'the named artifact exists and holds the requested content'
      : caps.includes('integration')
        ? 'the external service reports the requested state (verified through its API, not assumed)'
        : caps.includes('research')
          ? 'the requested information is reported with real sources'
          : 'the described change is observable in the workspace or application';
    subGoals.push({
      title: clause,
      purpose: `intermediate outcome #${subGoals.length + 1} toward the end goal`,
      dependsOn,
      capabilities: caps.slice(0, 3),
      risk,
      evidence,
    });
    if (risk === 'high') break; // the user decides on the high-risk part first
  }
  return subGoals;
}

// ----------------------------------------------------------------------------- the builder

/**
 * Build a TaskSpec deterministically from the request text. `now` is injectable for tests.
 * The result is always a usable spec: degraded inputs produce a minimal spec, never an error.
 */
export function buildTaskSpec(request: string, now: number = Date.now()): TaskSpec {
  const text = String(request ?? '').trim();
  const lower = text.toLowerCase();

  // Kind: project-scale requests route to durable tasks; questions without action verbs stay
  // informational; everything that changes the world is an action.
  const isQuestion = QUESTION_RE.test(text);
  const wantsAction = ACTION_VERB_RE.test(text) || FILE_TARGET_RE.test(lower);
  const kind: TaskKind = !text ? 'informational' : isQuestion && !WRITE_HINT_RE.test(lower) ? 'informational' : wantsAction ? 'action' : 'informational';

  // Capabilities: what the work will need, used by routing and by the agent registry.
  const capabilities: string[] = [];
  if (BROWSER_HINT_RE.test(lower)) capabilities.push('browser');
  if (RESEARCH_HINT_RE.test(lower)) capabilities.push('research');
  if (CODE_HINT_RE.test(lower)) capabilities.push('code');
  if (kind === 'action') capabilities.push('write');

  // Risk: only action tasks can carry risk; informational work is always low.
  let risk: RiskClass = 'low';
  if (kind === 'action') {
    if (HIGH_RISK_RE.test(lower)) risk = 'high';
    else if (MEDIUM_RISK_RE.test(lower) || capabilities.includes('code')) risk = 'medium';
  }

  // Deliverables: what should exist when the work is done.
  const deliverables: string[] = [];
  if (FILE_TARGET_RE.test(lower) && WRITE_HINT_RE.test(lower)) deliverables.push('a saved file with the requested content');
  if (kind === 'action' && BROWSER_HINT_RE.test(lower) && !WRITE_HINT_RE.test(lower)) deliverables.push('the requested page or action completed in the browser');
  if (kind === 'informational') deliverables.push('a direct answer');

  // Constraints: explicit negatives and boundaries the user stated (captured up to a
  // clause break so "without X, do not Y" yields two constraints, not one merged blob).
  const constraints: string[] = [];
  for (const m of text.matchAll(/\b(?:without|don'?t|do not|never|except|only use|must (?:not )?|no )\s+([a-z0-9 '-]{3,60})/gi)) {
    const c = clipWords(m[0], 14);
    if (!constraints.includes(c)) constraints.push(c);
  }

  // Acceptance criteria: derivable, verifiable checks — never invented ones. A research
  // answer needs sources; a file deliverable must exist, be non-empty and reopen; code
  // changes must pass whatever command exists (the verifier skips what does not apply).
  const acceptance: AcceptanceCriterion[] = [];
  if (kind === 'action') {
    if (deliverables.some((d) => d.startsWith('a saved file'))) {
      acceptance.push(criterion('file-exists', 'the requested file exists on disk'));
      acceptance.push(criterion('file-nonempty', 'the file is non-empty'));
      acceptance.push(criterion('file-format', 'the file reopens and validates as its format'));
    }
    if (capabilities.includes('code')) acceptance.push(criterion('command-passes', 'the project typecheck/tests/build pass where such commands exist'));
    if (capabilities.includes('research')) acceptance.push(criterion('sources-present', 'at least 2 distinct sources were actually fetched', undefined, 2));
    if (!acceptance.length) acceptance.push(criterion('evidence-present', 'tool evidence in this task confirms the claimed actions'));
  } else if (kind === 'informational' && RESEARCH_HINT_RE.test(lower)) {
    acceptance.push(criterion('sources-present', 'at least 2 distinct sources were actually fetched', undefined, 2));
  }

  // ROUND 31 (§1.5) planning-depth class + (§1.2) ambiguity classification + (§1.1)
  // goal decomposition — all deterministic floors over the same lexicons.
  const complexity = classifyComplexity(kind, capabilities, lower, risk);
  const amb = detectAmbiguity(kind, risk, lower);
  const subGoals = decomposeGoals(text, complexity);

  // Clarification: derived from the ambiguity level — 'clarify' and 'blocking' ask
  // exactly ONE question; 'assumable' proceeds with recorded assumptions; 'clear' never
  // interrupts the user (do not ask unnecessary questions).
  const needsClarification = kind === 'action' && (amb.level === 'clarify' || amb.level === 'blocking');
  const clarification = needsClarification ? amb.question : undefined;

  const objective =
    kind === 'informational'
      ? `Answer the request directly${capabilities.includes('research') ? ', using live sources' : ''}.`
      : clipWords(text, 30);

  return {
    request: text,
    objective,
    kind,
    complexity,
    ambiguity: amb.level,
    assumptions: amb.assumptions,
    missingInfo: amb.missingInfo,
    subGoals,
    deliverables,
    constraints,
    acceptance,
    risk,
    capabilities,
    needsClarification,
    clarification,
    createdAt: now,
  };
}

/**
 * The spec as a compact prompt block for the model (used by the coordinator). ROUND 31:
 * carries the complexity class, explicit assumptions and the goal decomposition so the
 * planner understands the INTENDED OUTCOME structure, not just a tool-call sequence.
 */
export function specPrompt(s: TaskSpec): string {
  const parts = [
    `TASK OBJECTIVE: ${s.objective}`,
    `COMPLEXITY CLASS: ${s.complexity} (plan depth must match it — do not over-plan simple work)`,
    s.deliverables.length ? `DELIVERABLES: ${s.deliverables.join('; ')}` : '',
    s.constraints.length ? `CONSTRAINTS (must hold): ${s.constraints.join('; ')}` : '',
    s.assumptions.length ? `ASSUMPTIONS (proceeding on these, explicitly — surface them to the user in the report): ${s.assumptions.join('; ')}` : '',
    s.subGoals.length
      ? `INTENDED OUTCOMES (the plan must cover every one, in dependency order; mark genuinely independent ones dependsOn: []):\n${s.subGoals
          .map((g, i) => `  ${i + 1}. ${g.title} — evidence: ${g.evidence}${g.capabilities.length ? ` (needs: ${g.capabilities.join(', ')})` : ''}`)
          .join('\n')}`
      : '',
    s.acceptance.length ? `ACCEPTANCE (checked in code before COMPLETED): ${s.acceptance.map((a) => a.detail).join('; ')}` : '',
  ];
  return parts.filter(Boolean).join('\n');
}
