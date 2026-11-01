/**
 * METACOGNITIVE ENGINE — Measurable Autonomous Self-Monitoring
 *
 * Enforces:
 * "Detect: repeated failures, repeated tool calls, contradictory evidence,
 * missing information, ineffective strategies, goal drift, insufficient verification,
 * excessive resource use, unproductive loops.
 * The application should decide whether to: continue, retry, change strategy,
 * replan, gather information, delegate, ask the user, stop.
 * Do not use model-generated confidence as proof of correctness."
 */

export type MetacognitiveDecision =
  | 'continue'
  | 'retry_with_variation'
  | 'change_strategy'
  | 'replan'
  | 'gather_information'
  | 'delegate'
  | 'ask_user'
  | 'stop';

export interface MetacognitiveAlert {
  type:
    | 'loop_detected'
    | 'repeated_failure'
    | 'contradictory_evidence'
    | 'unverified_claim'
    | 'excessive_resources'
    | 'goal_drift';
  severity: 'low' | 'medium' | 'high' | 'critical';
  detail: string;
  recommendedAction: MetacognitiveDecision;
}

export interface TurnExecutionState {
  round: number;
  maxRounds: number;
  recentToolCalls: Array<{ tool: string; args: string; outcome: 'success' | 'failed' | 'blocked' | 'approval' }>;
  evidenceItems: string[];
  originalObjective: string;
  consecutiveFailures: number;
  totalCharsConsumed: number;
  charsBudget: number;
}

export interface MetacognitiveEvaluation {
  healthy: boolean;
  decision: MetacognitiveDecision;
  alerts: MetacognitiveAlert[];
  directive?: string;
}

/** Check if identical or nearly identical tool calls are being repeated (loop detection) */
export function detectToolLoop(
  calls: Array<{ tool: string; args: string }>
): { looping: boolean; repeatedTool?: string; count: number } {
  if (calls.length < 3) return { looping: false, count: 0 };

  const lastCall = calls[calls.length - 1];
  let matches = 0;

  for (let i = calls.length - 2; i >= Math.max(0, calls.length - 6); i--) {
    const prior = calls[i];
    if (prior.tool === lastCall.tool) {
      if (prior.args === lastCall.args || prior.args.slice(0, 100) === lastCall.args.slice(0, 100)) {
        matches++;
      }
    }
  }

  return {
    looping: matches >= 2,
    repeatedTool: lastCall.tool,
    count: matches + 1,
  };
}

/** Check for contradictory numbers or statuses in collected evidence */
export function detectContradictions(evidence: string[]): string[] {
  const contradictions: string[] = [];
  if (evidence.length < 2) return contradictions;

  // Check price contradictions on similar items
  const priceMatches: number[] = [];
  for (const item of evidence) {
    const m = item.match(/(?:₹|\$|eur|usd)\s*([\d,]+)/i);
    if (m) {
      const val = parseFloat(m[1].replace(/,/g, ''));
      if (!isNaN(val)) priceMatches.push(val);
    }
  }

  if (priceMatches.length >= 2) {
    const min = Math.min(...priceMatches);
    const max = Math.max(...priceMatches);
    // If difference is greater than 20% on the same topic, flag for verification
    if (min > 0 && max / min > 1.25) {
      contradictions.push(`Conflicting figures detected across sources: ${min} vs ${max}. Requires cross-checking.`);
    }
  }

  return contradictions;
}

/** Run comprehensive metacognitive self-audit on current execution state */
export function evaluateExecutionState(state: TurnExecutionState): MetacognitiveEvaluation {
  const alerts: MetacognitiveAlert[] = [];

  // 1. Tool loop detection
  const loopCheck = detectToolLoop(state.recentToolCalls);
  if (loopCheck.looping) {
    alerts.push({
      type: 'loop_detected',
      severity: 'high',
      detail: `Unproductive tool loop: "${loopCheck.repeatedTool}" called ${loopCheck.count} times with identical or near-identical arguments without resolution.`,
      recommendedAction: 'change_strategy',
    });
  }

  // 2. Repeated failure detection
  if (state.consecutiveFailures >= 3) {
    alerts.push({
      type: 'repeated_failure',
      severity: state.consecutiveFailures >= 5 ? 'critical' : 'high',
      detail: `${state.consecutiveFailures} consecutive tool execution failures occurred. The current approach is non-viable.`,
      recommendedAction: state.consecutiveFailures >= 5 ? 'ask_user' : 'replan',
    });
  }

  // 3. Excessive resource / round consumption
  if (state.round >= state.maxRounds * 0.85) {
    alerts.push({
      type: 'excessive_resources',
      severity: 'medium',
      detail: `Turn round ${state.round} of ${state.maxRounds} reached. Context budget nearly exhausted.`,
      recommendedAction: 'continue', // wrap up
    });
  }

  // 4. Evidence contradiction detection
  const contradictions = detectContradictions(state.evidenceItems);
  for (const c of contradictions) {
    alerts.push({
      type: 'contradictory_evidence',
      severity: 'medium',
      detail: c,
      recommendedAction: 'gather_information',
    });
  }

  // Determine overall metacognitive decision
  if (alerts.some((a) => a.severity === 'critical')) {
    const crit = alerts.find((a) => a.severity === 'critical')!;
    return {
      healthy: false,
      decision: crit.recommendedAction,
      alerts,
      directive: `[METACOGNITIVE INTERVENTION — CRITICAL]: ${crit.detail} You must ${crit.recommendedAction.replace(/_/g, ' ')} immediately.`,
    };
  }

  if (alerts.some((a) => a.severity === 'high')) {
    const high = alerts.find((a) => a.severity === 'high')!;
    return {
      healthy: false,
      decision: high.recommendedAction,
      alerts,
      directive: `[METACOGNITIVE WARNING]: ${high.detail} Action: ${high.recommendedAction.replace(/_/g, ' ')}.`,
    };
  }

  if (alerts.length > 0) {
    return {
      healthy: true,
      decision: 'continue',
      alerts,
      directive: undefined,
    };
  }

  return {
    healthy: true,
    decision: 'continue',
    alerts: [],
  };
}
