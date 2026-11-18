import type { AgentKind } from './orchestrate';
import { routeIntent } from './intentRouter';

/**
 * Per-agent capability budget. The registry remains the hard permission allowlist;
 * this map only narrows which of those allowed schemas are exposed for this specific
 * instruction. The request's own intent can add a relevant family but cannot grant
 * capabilities outside the agent's registry contract.
 */
const ROLE_FAMILIES: Record<AgentKind, readonly string[]> = {
  explore: ['files', 'research', 'system'],
  research: ['research', 'files'],
  general: ['files'],
  document: ['documents', 'files', 'research'],
  browser: ['browser', 'research', 'files'],
  verifier: ['files', 'research', 'system', 'documents', 'integrations', 'browser'],
  desktop: ['desktop', 'system', 'files'],
  data: ['files', 'research', 'documents', 'system'],
  coder: ['files', 'research', 'integrations', 'system'],
  reviewer: ['files', 'research', 'system'],
  tester: ['files', 'research', 'system', 'integrations'],
  planner: ['files', 'research', 'system', 'desktop', 'browser', 'documents', 'productivity', 'integrations', 'memory', 'orchestration'],
};

export interface AgentToolScope {
  families: string[];
  intent: string;
  confidence: 'high' | 'medium' | 'low';
}

export function agentToolScope(kind: AgentKind, request = '', includeAllAllowed = false): AgentToolScope {
  const intent = routeIntent(request);
  const families = new Set<string>(ROLE_FAMILIES[kind] ?? ['files']);
  for (const family of intent.groups) families.add(family);

  if (kind === 'general' && !intent.groups.length) families.add('files');
  if (includeAllAllowed) families.add('advanced');

  return {
    families: includeAllAllowed ? ['*'] : [...families],
    intent: intent.primary.label,
    confidence: intent.primary.confidence,
  };
}
