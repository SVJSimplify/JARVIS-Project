import * as path from 'path';
import { FILES_ROOT } from './workspace';
import { atomicWrite, loadJson } from './store';

/**
 * GOAL UNDERSTANDING ENGINE
 *
 * Enforces the invariant:
 * "The LLM may propose an interpretation. The application must validate and maintain
 * authoritative goal state. No uncontrolled objective drift."
 *
 * Normalizes user intents, extracts constraints, identifies success criteria,
 * flags ambiguities, prevents objective drift across replans and turn revisions.
 */

export type GoalPriority = 'critical' | 'high' | 'normal' | 'low';
export type GoalStatus = 'active' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'paused';

export interface GoalConstraint {
  type: 'time' | 'resource' | 'safety' | 'scope' | 'platform' | 'format';
  description: string;
  strict: boolean;
}

export interface GoalContract {
  id: string;
  rawRequest: string;
  normalizedIntent: string;
  objective: string;
  immutableObjectiveHash: string;
  constraints: GoalConstraint[];
  successCriteria: string[];
  dependencies: string[];
  ambiguities: string[];
  priority: GoalPriority;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  executionMetrics: {
    turnsUsed: number;
    toolsExecuted: number;
    replanCount: number;
  };
}

const GOALS_FILE = path.join(FILES_ROOT, 'brain', 'goals_authoritative.json');
const MAX_STORED_GOALS = 150;

let goalCache: GoalContract[] | null = null;

/** Deterministic hash of immutable objective tokens to strictly detect goal drift */
export function hashObjective(objective: string): string {
  const tokens = objective
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .sort();
  return tokens.join('|');
}

/** Intent normalization: extracts clean action verbs and principal noun targets */
export function normalizeIntent(request: string): { normalized: string; objective: string } {
  const clean = request.replace(/\s+/g, ' ').trim();
  const lower = clean.toLowerCase();

  // Strip conversational courtesy intros
  const stripped = lower
    .replace(/^(please\s+|jarvis\s+|hey\s+jarvis\s+|could\s+you\s+|can\s+you\s+|would\s+you\s+|kindly\s+|i\s+need\s+you\s+to\s+|i\s+want\s+you\s+to\s+|i'd\s+like\s+to\s+)/i, '')
    .trim();

  const objective = stripped.length > 0 ? stripped : lower;
  const normalized = `Goal: ${objective.slice(0, 160)}`;
  return { normalized, objective };
}

/** Extract explicit constraints from natural language */
export function extractConstraints(request: string): GoalConstraint[] {
  const constraints: GoalConstraint[] = [];
  const text = request.toLowerCase();

  // Time / deadline constraints
  if (/\b(before|by|within|in\s+\d+\s+(?:minutes?|hours?|days?)|deadline|today|tomorrow)\b/i.test(text)) {
    const timeMatch = text.match(/\b(?:by|before|within|in)\s+([^,.]+)/i);
    constraints.push({
      type: 'time',
      description: timeMatch ? timeMatch[0].trim() : 'Strict time limit specified',
      strict: true,
    });
  }

  // Safety / Non-destructive constraint
  if (/\b(don'?t\s+delete|never\s+delete|keep|preserve|do\s+not\s+modify|read[\s-]only|backup\s+first)\b/i.test(text)) {
    constraints.push({
      type: 'safety',
      description: 'Preserve existing files and configuration without destruction',
      strict: true,
    });
  }

  // Format / Output constraints
  if (/\b(json|markdown|table|csv|bullets?|two\s+sentences?|short|briefly|summary)\b/i.test(text)) {
    const formatMatch = text.match(/\b(json|markdown|table|csv|bullets?|two\s+sentences?|short|briefly|summary)\b/i);
    constraints.push({
      type: 'format',
      description: `Output format: ${formatMatch ? formatMatch[0] : 'structured'}`,
      strict: false,
    });
  }

  // Cost / Budget constraints
  if (/(?:under|below|budget|max(?:imum)?)\s*(?:₹|\$|eur|usd|rs\.?)\s*\d+/i.test(text)) {
    const costMatch = text.match(/(?:under|below|budget|max(?:imum)?)\s*(?:₹|\$|eur|usd|rs\.?)\s*[\d,]+/i);
    constraints.push({
      type: 'resource',
      description: costMatch ? costMatch[0] : 'Budget ceiling specified',
      strict: true,
    });
  }

  return constraints;
}

/** Detect ambiguities where proceeding without clarification could violate user intent */
export function detectAmbiguities(request: string): string[] {
  const ambiguities: string[] = [];
  const text = request.toLowerCase();

  // Check for ambiguous pronouns or targets without context
  if (/\b(do\s+it|fix\s+it|update\s+it|run\s+that|open\s+them)\b/i.test(text) && text.length < 25) {
    ambiguities.push('Referent is ambiguous: "it" / "that" does not specify the target file, process or task');
  }

  // Check for conflicting requests
  if (/\b(fast|quick)\b/i.test(text) && /\b(exhaustive|all|everything|deep|complete)\b/i.test(text)) {
    ambiguities.push('Conflicting speed vs exhaustiveness constraints');
  }

  // Check for multi-platform or uncertain target environments
  if (/\b(build|deploy|release)\b/i.test(text) && !/\b(web|renderer|main|electron|node|windows|mac|linux)\b/i.test(text)) {
    ambiguities.push('Target environment or platform not specified for build/deploy action');
  }

  return ambiguities;
}

/** Extract verifiable success criteria */
export function extractSuccessCriteria(objective: string, constraints: GoalConstraint[]): string[] {
  const criteria: string[] = [];
  criteria.push(`Objective accomplished: ${objective.slice(0, 100)}`);

  for (const c of constraints) {
    if (c.strict) {
      criteria.push(`Constraint satisfied: ${c.description}`);
    }
  }

  criteria.push('All side effects verified with outcome confirmation');
  return criteria;
}

/**
 * Validates a proposed plan or action against the authoritative goal to prevent objective drift.
 * Invariant 5: No uncontrolled objective drift.
 */
export function checkGoalDrift(
  goal: GoalContract,
  proposedObjective: string
): { drifted: boolean; similarity: number; reason?: string } {
  const origTokens = new Set(goal.immutableObjectiveHash.split('|').filter(Boolean));
  const newTokens = new Set(hashObjective(proposedObjective).split('|').filter(Boolean));

  if (!origTokens.size || !newTokens.size) {
    return { drifted: false, similarity: 1.0 };
  }

  let intersection = 0;
  for (const token of newTokens) {
    if (origTokens.has(token)) intersection++;
  }

  const union = new Set([...origTokens, ...newTokens]).size;
  const similarity = union > 0 ? intersection / union : 0;

  // If similarity to the original core objective drops below 0.35, reject as goal drift
  if (similarity < 0.35) {
    return {
      drifted: true,
      similarity,
      reason: `Proposed plan drifts from original objective "${goal.objective}" (semantic overlap: ${(similarity * 100).toFixed(0)}%). Original goal must be preserved.`,
    };
  }

  return { drifted: false, similarity };
}

/** Create an authoritative goal contract from user input */
export async function createGoal(
  request: string,
  priority: GoalPriority = 'normal'
): Promise<GoalContract> {
  const { normalized, objective } = normalizeIntent(request);
  const constraints = extractConstraints(request);
  const ambiguities = detectAmbiguities(request);
  const successCriteria = extractSuccessCriteria(objective, constraints);

  const goal: GoalContract = {
    id: `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    rawRequest: request,
    normalizedIntent: normalized,
    objective,
    immutableObjectiveHash: hashObjective(objective),
    constraints,
    successCriteria,
    dependencies: [],
    ambiguities,
    priority,
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    executionMetrics: {
      turnsUsed: 1,
      toolsExecuted: 0,
      replanCount: 0,
    },
  };

  await persistGoal(goal);
  return goal;
}

/** Persist a goal atomically */
export async function persistGoal(goal: GoalContract): Promise<void> {
  const all = await loadAllGoals();
  const index = all.findIndex((g) => g.id === goal.id);
  if (index >= 0) {
    all[index] = { ...goal, updatedAt: Date.now() };
  } else {
    all.push(goal);
  }

  if (all.length > MAX_STORED_GOALS) {
    all.splice(0, all.length - MAX_STORED_GOALS);
  }

  goalCache = all;
  try {
    await atomicWrite(GOALS_FILE, JSON.stringify(all, null, 2));
  } catch (err) {
    console.warn('[goalEngine] Failed to persist goal store:', err);
  }
}

/** Load all authoritative goals */
export async function loadAllGoals(): Promise<GoalContract[]> {
  if (goalCache) return goalCache;
  const loaded = await loadJson<GoalContract[]>(GOALS_FILE, []);
  goalCache = Array.isArray(loaded) ? loaded : [];
  return goalCache;
}

/** Retrieve active goal by ID */
export async function getGoal(id: string): Promise<GoalContract | null> {
  const all = await loadAllGoals();
  return all.find((g) => g.id === id) ?? null;
}

/** Update goal status */
export async function updateGoalStatus(
  id: string,
  status: GoalStatus,
  note?: string
): Promise<GoalContract | null> {
  const goal = await getGoal(id);
  if (!goal) return null;
  goal.status = status;
  goal.updatedAt = Date.now();
  if (status === 'completed' || status === 'failed') {
    goal.completedAt = Date.now();
  }
  if (note) {
    goal.successCriteria.push(`[Status Note]: ${note}`);
  }
  await persistGoal(goal);
  return goal;
}

/** Reset in-memory cache (for testing) */
export function resetGoalCacheForTests(): void {
  goalCache = null;
}
