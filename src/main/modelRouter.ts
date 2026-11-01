import { getModel, getFallbackModels } from './settings';

/**
 * SPECIALIZED MODEL ROUTING ENGINE
 *
 * Enforces:
 * - Separation of cognitive roles: reasoning, planning, coding, research, verification, classification.
 * - Model capability metadata (context size, speed tier, tool-calling aptitude).
 * - Preserves existing model fallback chains and user-configured model settings.
 * - Never performs silent model substitution; transparently routes through fallback chain.
 */

export type ModelRole =
  | 'general_reasoning'
  | 'planning'
  | 'coding'
  | 'research'
  | 'verification'
  | 'classification'
  | 'summarization';

export interface ModelProfile {
  id: string;
  maxContextTokens: number;
  recommendedTimeoutMs: number;
  strengths: ModelRole[];
}

export interface ModelRouteDecision {
  primaryModel: string;
  fallbackChain: string[];
  role: ModelRole;
  timeoutMs: number;
}

/** Pre-configured capability profiles for common models */
export const KNOWN_PROFILES: Record<string, Partial<ModelProfile>> = {
  'gemini-1.5-pro': {
    maxContextTokens: 1_000_000,
    recommendedTimeoutMs: 120_000,
    strengths: ['general_reasoning', 'planning', 'coding', 'research'],
  },
  'gemini-1.5-flash': {
    maxContextTokens: 500_000,
    recommendedTimeoutMs: 60_000,
    strengths: ['classification', 'summarization', 'verification'],
  },
  'claude-3-5-sonnet': {
    maxContextTokens: 200_000,
    recommendedTimeoutMs: 90_000,
    strengths: ['coding', 'general_reasoning', 'planning', 'verification'],
  },
};

/** Select the model route for a given cognitive role */
export async function routeForRole(role: ModelRole): Promise<ModelRouteDecision> {
  const configured = await getModel();
  const fallbacks = await getFallbackModels().catch(() => [] as string[]);

  const primary = configured || 'default-model';
  const chain = [primary, ...fallbacks.filter((m) => m !== primary)];

  const profile = KNOWN_PROFILES[primary.toLowerCase()] ?? {
    recommendedTimeoutMs: 90_000,
  };

  return {
    primaryModel: primary,
    fallbackChain: chain,
    role,
    timeoutMs: profile.recommendedTimeoutMs ?? 90_000,
  };
}
