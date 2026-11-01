/**
 * STRATEGY SELECTION ENGINE
 *
 * Enforces:
 * "The application chooses appropriately between direct response, research,
 * planning, browser execution, tool execution, delegation, parallel execution,
 * verification, replanning, clarification, pausing, stopping.
 * Consider task complexity, risk, available tools, evidence requirements and resource budgets.
 * Do not invoke complex planning for trivial requests."
 */

export type ExecutionStrategy =
  | 'direct_response'
  | 'quick_tool'
  | 'browser_automation'
  | 'deep_research'
  | 'hierarchical_planning'
  | 'subagent_delegation'
  | 'parallel_execution'
  | 'clarification'
  | 'pause'
  | 'stop';

export interface StrategyAssessment {
  strategy: ExecutionStrategy;
  confidence: number;
  reason: string;
  complexityScore: number; // 0 (trivial) to 100 (highly complex)
  requiresVerification: boolean;
  resourceBudget: {
    maxRounds: number;
    maxParallelSubagents: number;
    timeoutMs: number;
  };
}

/** Evaluates user request characteristics and selects the optimal strategy */
export function selectStrategy(request: string, context?: {
  consecutiveFailures?: number;
  hasOpenBrowserTab?: boolean;
  activeMission?: boolean;
}): StrategyAssessment {
  const text = String(request ?? '').trim();
  const lower = text.toLowerCase();

  // If repeated failures are occurring, strategy must shift to clarification or stop
  if (context?.consecutiveFailures && context.consecutiveFailures >= 4) {
    return {
      strategy: 'clarification',
      confidence: 0.95,
      reason: `Multiple consecutive tool failures (${context.consecutiveFailures}). Pausing to ask user for explicit guidance.`,
      complexityScore: 40,
      requiresVerification: true,
      resourceBudget: { maxRounds: 2, maxParallelSubagents: 0, timeoutMs: 30_000 },
    };
  }

  // Trivial requests: small-talk, greetings, simple questions
  if (
    /^(hi|hello|hey|good\s+morning|good\s+evening|what\s+can\s+you\s+do|who\s+are\s+you|thank\s*you|thanks|status)\b/i.test(lower) ||
    (text.length < 30 && !/\b(run|build|make|edit|delete|open|search|check|fetch|launch|kill)\b/i.test(lower))
  ) {
    return {
      strategy: 'direct_response',
      confidence: 0.98,
      reason: 'Small-talk, conversational courtesy, or overview question without external tool requirements.',
      complexityScore: 5,
      requiresVerification: false,
      resourceBudget: { maxRounds: 1, maxParallelSubagents: 0, timeoutMs: 15_000 },
    };
  }

  // Pure single-tool lookups: clock, weather, single file read, memory retrieval
  if (
    /\b(what\s+time|current\s+time|weather|read\s+file|list\s+files|show\s+notes|what\s+is\s+my\s+(?:name|preference))\b/i.test(lower) &&
    !/\b(and\s+then|after\s+that|build|compare|research)\b/i.test(lower)
  ) {
    return {
      strategy: 'quick_tool',
      confidence: 0.95,
      reason: 'Single read-only lookup with immediate deterministic answer.',
      complexityScore: 15,
      requiresVerification: false,
      resourceBudget: { maxRounds: 3, maxParallelSubagents: 0, timeoutMs: 30_000 },
    };
  }

  // Browser navigation and web automation
  if (
    /\b(open\s+in\s+browser|in-app\s+browser|navigate\s+to|click\s+the\s+button|fill\s+(?:in|out)\s+the\s+form|scroll\s+down|web\s+page)\b/i.test(lower) ||
    (/\b(browser)\b/i.test(lower) && /\b(open|search|click|read|tab)\b/i.test(lower))
  ) {
    return {
      strategy: 'browser_automation',
      confidence: 0.92,
      reason: 'Interactive browser operation requiring in-app browser control and DOM verification.',
      complexityScore: 55,
      requiresVerification: true,
      resourceBudget: { maxRounds: 25, maxParallelSubagents: 0, timeoutMs: 120_000 },
    };
  }

  // Multi-target research or comparative queries
  if (
    /\b(research|deep\s+dive|compare|comparison|investigate|market\s+analysis|competitors|benchmark|survey)\b/i.test(lower)
  ) {
    const isDeep = /\b(deep|exhaustive|all|complete|full\s+report)\b/i.test(lower);
    return {
      strategy: 'deep_research',
      confidence: 0.9,
      reason: 'Information gathering requiring multi-query search, page synthesis, and citation verification.',
      complexityScore: isDeep ? 80 : 60,
      requiresVerification: true,
      resourceBudget: {
        maxRounds: isDeep ? 40 : 25,
        maxParallelSubagents: isDeep ? 4 : 2,
        timeoutMs: 180_000,
      },
    };
  }

  // Large projects, full applications, multi-file refactoring, autonomous missions
  if (
    /\b(build|develop|create\s+app|refactor|scaffold|rewrite|port|migrate)\b/i.test(lower) &&
    /\b(app|application|project|codebase|website|system|service|backend|frontend)\b/i.test(lower)
  ) {
    return {
      strategy: 'hierarchical_planning',
      confidence: 0.94,
      reason: 'Project-scale goal requiring DAG planning, task decomposition, checkpoints, and post-step verification.',
      complexityScore: 90,
      requiresVerification: true,
      resourceBudget: { maxRounds: 60, maxParallelSubagents: 3, timeoutMs: 300_000 },
    };
  }

  // Parallel independent tasks
  if (
    /\b(in\s+parallel|at\s+the\s+same\s+time|simultaneously)\b/i.test(lower) ||
    (/\b(for\s+each|all\s+three|all\s+five)\b/i.test(lower) && /\b(check|find|lookup|test)\b/i.test(lower))
  ) {
    return {
      strategy: 'parallel_execution',
      confidence: 0.88,
      reason: 'Multiple independent subtasks suitable for parallel pool execution.',
      complexityScore: 65,
      requiresVerification: true,
      resourceBudget: { maxRounds: 30, maxParallelSubagents: 4, timeoutMs: 120_000 },
    };
  }

  // Default to standard tool execution loop
  return {
    strategy: 'quick_tool',
    confidence: 0.8,
    reason: 'Standard command or tool request manageable in direct agent turn loop.',
    complexityScore: 35,
    requiresVerification: true,
    resourceBudget: { maxRounds: 15, maxParallelSubagents: 0, timeoutMs: 60_000 },
  };
}
