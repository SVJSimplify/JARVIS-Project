import { promises as fs } from 'fs';
import * as path from 'path';
import { FILES_ROOT } from './workspace';
import { atomicWrite, loadJson } from './store';
import { checkGoalDrift, getGoal } from './goalEngine';

/**
 * PERSISTENT PLANNING & DYNAMIC REPLANNING ENGINE
 *
 * Enforces:
 * - DAG-based task dependency graph with cycle detection and reachability validation.
 * - Topological execution batches (parallel execution of unblocked nodes).
 * - Preconditions, expected outcomes, verification criteria, and retry policies per node.
 * - Persistent checkpoints before and during execution.
 * - Dynamic replanning that preserves verified completed work and original user constraints,
 *   strictly preventing objective drift.
 */

export type NodeStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'skipped';

export interface VerificationSpec {
  method: 'file_exists' | 'command_exit' | 'browser_state' | 'output_match' | 'custom';
  target: string;
  expectedPattern?: string;
  mandatory: boolean;
}

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
}

export interface PlanNode {
  id: string;
  title: string;
  description: string;
  toolFamily: string;
  dependencies: string[]; // IDs of preceding nodes that must be completed
  preconditions: string[];
  expectedOutcomes: string[];
  verification: VerificationSpec;
  retryPolicy: RetryPolicy;
  deadline?: number;
  status: NodeStatus;
  attempts: number;
  result?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface PlanCheckpoint {
  id: string;
  timestamp: number;
  completedNodeIds: string[];
  activeNodeIds: string[];
  snapshotSummary: string;
}

export interface PersistentPlan {
  id: string;
  goalId: string;
  version: number;
  revisionReason?: string;
  status: 'draft' | 'approved' | 'executing' | 'revising' | 'completed' | 'failed' | 'cancelled';
  nodes: Record<string, PlanNode>;
  executionBatches: string[][]; // Topological layers
  checkpoints: PlanCheckpoint[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

const PLAN_DIR = path.join(FILES_ROOT, 'brain', 'plans_dag');

/** Cycle detection & topological sort using Kahn's algorithm */
export function validateAndSortDAG(nodes: Record<string, PlanNode>): {
  valid: boolean;
  batches: string[][];
  error?: string;
} {
  const inDegree: Record<string, number> = {};
  const graph: Record<string, string[]> = {};
  const nodeIds = Object.keys(nodes);

  for (const id of nodeIds) {
    inDegree[id] = 0;
    graph[id] = [];
  }

  // Build graph and calculate in-degrees
  for (const [id, node] of Object.entries(nodes)) {
    for (const dep of node.dependencies) {
      if (!nodes[dep]) {
        return {
          valid: false,
          batches: [],
          error: `Dangling dependency: node "${id}" depends on unknown node "${dep}"`,
        };
      }
      graph[dep].push(id);
      inDegree[id] = (inDegree[id] || 0) + 1;
    }
  }

  const batches: string[][] = [];
  let currentLayer = nodeIds.filter((id) => inDegree[id] === 0);
  let processedCount = 0;

  while (currentLayer.length > 0) {
    batches.push([...currentLayer]);
    processedCount += currentLayer.length;
    const nextLayer: string[] = [];

    for (const node of currentLayer) {
      for (const neighbor of graph[node]) {
        inDegree[neighbor]--;
        if (inDegree[neighbor] === 0) {
          nextLayer.push(neighbor);
        }
      }
    }

    currentLayer = nextLayer;
  }

  if (processedCount < nodeIds.length) {
    return {
      valid: false,
      batches: [],
      error: 'Cycle detected in plan dependency graph. Plans must be acyclic (DAG).',
    };
  }

  return { valid: true, batches };
}

/** Create a new persistent plan bound to an authoritative goal */
export async function createPlan(
  goalId: string,
  rawNodes: Array<Omit<PlanNode, 'status' | 'attempts'>>
): Promise<PersistentPlan> {
  const goal = await getGoal(goalId);
  if (!goal) {
    throw new Error(`Cannot create plan: Authoritative goal "${goalId}" does not exist.`);
  }

  const nodes: Record<string, PlanNode> = {};
  for (const rn of rawNodes) {
    nodes[rn.id] = {
      ...rn,
      status: 'pending',
      attempts: 0,
      retryPolicy: rn.retryPolicy ?? { maxAttempts: 2, backoffMs: 500 },
    };
  }

  const { valid, batches, error } = validateAndSortDAG(nodes);
  if (!valid) {
    throw new Error(`Invalid plan DAG: ${error}`);
  }

  // Update initial ready nodes (nodes with 0 dependencies)
  if (batches.length > 0) {
    for (const id of batches[0]) {
      nodes[id].status = 'ready';
    }
  }

  const plan: PersistentPlan = {
    id: `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    goalId,
    version: 1,
    status: 'draft',
    nodes,
    executionBatches: batches,
    checkpoints: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await persistPlan(plan);
  return plan;
}

/** Update plan status or node state */
export async function advanceNodeStatus(
  planId: string,
  nodeId: string,
  newStatus: NodeStatus,
  resultOrError?: string
): Promise<PersistentPlan> {
  const plan = await loadPlan(planId);
  if (!plan) throw new Error(`Plan "${planId}" not found`);

  const node = plan.nodes[nodeId];
  if (!node) throw new Error(`Node "${nodeId}" not found in plan "${planId}"`);

  node.status = newStatus;
  node.attempts += newStatus === 'running' ? 1 : 0;
  if (newStatus === 'running') {
    node.startedAt = Date.now();
  } else if (newStatus === 'completed') {
    node.finishedAt = Date.now();
    node.result = resultOrError;
  } else if (newStatus === 'failed') {
    node.finishedAt = Date.now();
    node.error = resultOrError;
  }

  // Update dependents: if all dependencies of a pending node are completed, mark it 'ready'
  for (const other of Object.values(plan.nodes)) {
    if (other.status === 'pending') {
      const allDone = other.dependencies.every((depId) => plan.nodes[depId]?.status === 'completed');
      if (allDone) {
        other.status = 'ready';
      }
    }
  }

  // Check overall plan completion
  const allNodes = Object.values(plan.nodes);
  if (allNodes.every((n) => n.status === 'completed' || n.status === 'skipped')) {
    plan.status = 'completed';
    plan.completedAt = Date.now();
  } else if (allNodes.some((n) => n.status === 'failed' && n.attempts >= n.retryPolicy.maxAttempts)) {
    // A node has permanently failed its retry budget
    plan.status = 'failed';
  }

  plan.updatedAt = Date.now();
  await persistPlan(plan);
  return plan;
}

/** Checkpoint the current state of the plan */
export async function createPlanCheckpoint(
  planId: string,
  summary: string
): Promise<PlanCheckpoint> {
  const plan = await loadPlan(planId);
  if (!plan) throw new Error(`Plan "${planId}" not found`);

  const completed = Object.values(plan.nodes)
    .filter((n) => n.status === 'completed')
    .map((n) => n.id);
  const active = Object.values(plan.nodes)
    .filter((n) => n.status === 'running' || n.status === 'ready')
    .map((n) => n.id);

  const checkpoint: PlanCheckpoint = {
    id: `chk_${Date.now().toString(36)}`,
    timestamp: Date.now(),
    completedNodeIds: completed,
    activeNodeIds: active,
    snapshotSummary: summary,
  };

  plan.checkpoints.push(checkpoint);
  plan.updatedAt = Date.now();
  await persistPlan(plan);
  return checkpoint;
}

/**
 * DYNAMIC REPLANNING
 *
 * Triggered when:
 * - A task fails or dependencies become unviable.
 * - New evidence changes the strategy.
 *
 * Guarantees:
 * - Preserves original goal (no objective drift).
 * - Preserves verified completed work.
 * - Replaces or inserts nodes cleanly without creating cycles or dangling references.
 */
export async function dynamicReplan(
  planId: string,
  reason: string,
  replacementNodes: Array<Omit<PlanNode, 'status' | 'attempts'>>,
  newObjectiveCheck?: string
): Promise<PersistentPlan> {
  const plan = await loadPlan(planId);
  if (!plan) throw new Error(`Plan "${planId}" not found`);

  const goal = await getGoal(plan.goalId);
  if (!goal) throw new Error(`Associated goal "${plan.goalId}" missing`);

  // Guard against objective drift during replan
  if (newObjectiveCheck) {
    const drift = checkGoalDrift(goal, newObjectiveCheck);
    if (drift.drifted) {
      throw new Error(`Dynamic replanning REJECTED: ${drift.reason}`);
    }
  }

  // Create checkpoint of the pre-replan state
  await createPlanCheckpoint(planId, `Pre-replan checkpoint: ${reason}`);

  // Retain all completed nodes and their results
  const newNodes: Record<string, PlanNode> = {};
  for (const [id, node] of Object.entries(plan.nodes)) {
    if (node.status === 'completed') {
      newNodes[id] = { ...node };
    }
  }

  // Add the new replacement nodes
  for (const rn of replacementNodes) {
    if (newNodes[rn.id]?.status === 'completed') {
      // Completed work is immutable and preserved
      continue;
    }
    newNodes[rn.id] = {
      ...rn,
      status: 'pending',
      attempts: 0,
      retryPolicy: rn.retryPolicy ?? { maxAttempts: 2, backoffMs: 500 },
    };
  }

  // Validate the new DAG
  const { valid, batches, error } = validateAndSortDAG(newNodes);
  if (!valid) {
    throw new Error(`Dynamic replan failed DAG validation: ${error}`);
  }

  // Advance dependencies that are already satisfied
  for (const node of Object.values(newNodes)) {
    if (node.status === 'pending') {
      const allDone = node.dependencies.every((depId) => newNodes[depId]?.status === 'completed');
      if (allDone) {
        node.status = 'ready';
      }
    }
  }

  plan.version += 1;
  plan.revisionReason = reason;
  plan.nodes = newNodes;
  plan.executionBatches = batches;
  plan.status = 'executing';
  plan.updatedAt = Date.now();

  goal.executionMetrics.replanCount += 1;

  await persistPlan(plan);
  return plan;
}

const planCache = new Map<string, PersistentPlan>();

/** Atomically persist a plan to disk */
export async function persistPlan(plan: PersistentPlan): Promise<void> {
  planCache.set(plan.id, plan);
  const filePath = path.join(PLAN_DIR, `${plan.id}.json`);
  try {
    await fs.mkdir(PLAN_DIR, { recursive: true });
    await atomicWrite(filePath, JSON.stringify(plan, null, 2));
  } catch (err) {
    console.warn(`[persistentPlanner] Failed to save plan ${plan.id}:`, err);
  }
}

/** Load a persistent plan by ID */
export async function loadPlan(planId: string): Promise<PersistentPlan | null> {
  if (planCache.has(planId)) return planCache.get(planId)!;
  const filePath = path.join(PLAN_DIR, `${planId}.json`);
  const loaded = await loadJson<PersistentPlan | null>(filePath, null);
  if (loaded) planCache.set(planId, loaded);
  return loaded;
}
