import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { FILES_ROOT } from './workspace';
import { atomicWrite, loadJson, withStoreLock } from './store';

export type GoalStatus = 'active' | 'waiting' | 'completed' | 'blocked';
export interface GoalFact {
  value: string;
  source: 'user' | 'assistant_assumption' | 'system';
  confidence: number;
  updatedAt: number;
  supersedes?: string;
}
export interface GoalState {
  schemaVersion: 1;
  chatId: string;
  revision: number;
  updatedAt: number;
  status: GoalStatus;
  objective: GoalFact | null;
  entities: GoalFact[];
  requirements: GoalFact[];
  decisions: GoalFact[];
  preferences: GoalFact[];
  assumptions: GoalFact[];
  unresolvedQuestions: GoalFact[];
  progress: string[];
  lastUserMessage: string;
  lastError?: string;
}
interface GoalStore { schemaVersion: 1; chats: Record<string, GoalState> }

const FILE = path.join(FILES_ROOT, 'goal-state.json');
let override: string | null = null;
let cache: GoalStore | null = null;
const file = (): string => override ?? FILE;
const empty = (chatId: string): GoalState => ({
  schemaVersion: 1, chatId, revision: 0, updatedAt: Date.now(), status: 'active',
  objective: null, entities: [], requirements: [], decisions: [], preferences: [],
  assumptions: [], unresolvedQuestions: [], progress: [], lastUserMessage: '',
});
const normalize = (v: string): string => v.toLowerCase().replace(/\s+/g, ' ').trim();
const uniquePush = (items: GoalFact[], value: string, source: GoalFact['source'] = 'user'): void => {
  const clean = value.replace(/\s+/g, ' ').trim().slice(0, 240);
  if (!clean || items.some((x) => normalize(x.value) === normalize(clean))) return;
  items.push({ value: clean, source, confidence: source === 'user' ? 0.98 : 0.65, updatedAt: Date.now() });
};
async function load(): Promise<GoalStore> {
  if (cache) return cache;
  const raw = await loadJson<unknown>(file(), { schemaVersion: 1, chats: {} });
  const value = raw && typeof raw === 'object' ? raw as Partial<GoalStore> : {};
  cache = { schemaVersion: 1, chats: value.chats && typeof value.chats === 'object' ? value.chats : {} };
  return cache;
}
async function persist(store: GoalStore): Promise<void> {
  await fs.mkdir(path.dirname(file()), { recursive: true });
  await atomicWrite(file(), JSON.stringify(store));
}
function applyUserFacts(state: GoalState, input: string): void {
  const text = input.trim();
  if (!text) return;
  state.lastUserMessage = text.slice(0, 2000);
  const objective = text.match(/\b(?:build|create|make|develop|design|launch|implement|research|compare|audit|plan)\b[^.!?\n]{0,180}/i)?.[0];
  if (objective && (!state.objective || /^(?:yes|yeah|yep|no|nope|continue|go on|do it|proceed|unofficial|that one|exactly|correct)\b/i.test(text))) {
    if (!state.objective || !/^(?:yes|yeah|yep|no|nope|continue|go on|do it|proceed)\b/i.test(text)) {
      state.objective = { value: objective.trim(), source: 'user', confidence: 0.96, updatedAt: Date.now(), ...(state.objective ? { supersedes: state.objective.value } : {}) };
    }
  }
  for (const match of text.matchAll(/\bfor\s+([A-Z][A-Za-z0-9&.-]*(?:\s+[A-Z][A-Za-z0-9&.-]*){0,3})/g)) uniquePush(state.entities, match[1]);
  for (const match of text.matchAll(/\b(?:about|regarding|for)\s+(SpaceX|NASA|OpenAI|Google|Microsoft|Apple|Tesla)\b/gi)) uniquePush(state.entities, match[1]);
  if (/\b(unofficial|fan\s*site|fan\s*website)\b/i.test(text)) {
    uniquePush(state.decisions, 'The website must be clearly unofficial and presented as a fan site.');
  }
  if (/\bmobile[- ]first\b/i.test(text)) uniquePush(state.preferences, 'Mobile-first experience.');
  if (/\bno\s+(?:backend|authentication|login)\b/i.test(text)) uniquePush(state.requirements, text.match(/\bno\s+(?:backend|authentication|login)\b/i)?.[0] ?? '');
  if (/\b(?:include|with|featuring)\b/i.test(text)) {
    const featurePart = text.match(/\b(?:include|with|featuring)\b([^.!?]{3,180})/i)?.[1];
    if (featurePart) uniquePush(state.requirements, featurePart);
  }
  if (/\b(?:prefer|i want|make it|use)\b/i.test(text) && text.length < 300 && !/^(?:yes|yeah|yep|no|nope|continue)\b/i.test(text)) {
    uniquePush(state.preferences, text);
  }
  if (/\b(?:done|finished|complete[d]?)\b/i.test(text)) state.status = 'completed';
  else if (state.status !== 'blocked') state.status = 'active';
  state.updatedAt = Date.now();
  state.revision++;
}
export async function updateGoalFromUser(chatId: string, input: string): Promise<GoalState> {
  return withStoreLock(file(), async () => {
    cache = null;
    const store = await load();
    const state = store.chats[chatId] ?? empty(chatId);
    applyUserFacts(state, input);
    store.chats[chatId] = state;
    await persist(store);
    return structuredClone(state);
  });
}
export async function recordGoalOutcome(chatId: string, reply: string, error?: string): Promise<void> {
  await withStoreLock(file(), async () => {
    cache = null;
    const store = await load();
    const state = store.chats[chatId] ?? empty(chatId);
    if (error) {
      state.lastError = error.slice(0, 500);
      state.status = 'active';
    } else if (reply.trim()) {
      state.progress = [...state.progress, reply.replace(/\s+/g, ' ').slice(0, 240)].slice(-12);
      delete state.lastError;
    }
    state.updatedAt = Date.now();
    state.revision++;
    store.chats[chatId] = state;
    await persist(store);
  });
}
export async function getGoalState(chatId: string): Promise<GoalState> {
  const store = await load();
  return structuredClone(store.chats[chatId] ?? empty(chatId));
}
export async function getGoalContext(chatId: string): Promise<string> {
  const state = await getGoalState(chatId);
  if (!state.revision) return '';
  const lines = [
    'PERSISTENT GOAL STATE (authoritative user-provided decisions; merge this turn into it, do not restart discovery):',
    state.objective ? `Objective: ${state.objective.value}` : '',
    state.entities.length ? `Entities: ${state.entities.map((x) => x.value).join(', ')}` : '',
    state.requirements.length ? `Requirements: ${state.requirements.map((x) => x.value).join('; ')}` : '',
    state.decisions.length ? `Decisions: ${state.decisions.map((x) => x.value).join('; ')}` : '',
    state.preferences.length ? `Preferences: ${state.preferences.map((x) => x.value).join('; ')}` : '',
    state.assumptions.length ? `Assumptions (not user-confirmed): ${state.assumptions.map((x) => x.value).join('; ')}` : '',
    state.unresolvedQuestions.length ? `Unresolved: ${state.unresolvedQuestions.map((x) => x.value).join('; ')}` : '',
    state.progress.length ? `Progress: ${state.progress.slice(-4).join(' | ')}` : '',
    state.lastError ? `Last error (goal retained): ${state.lastError}` : '',
    `Status: ${state.status}; revision: ${state.revision}`,
  ].filter(Boolean);
  return lines.join('\n');
}
/** Isolated persistence hook for unit tests. */
export const setGoalStateFileForTests = (value: string | null): void => { override = value; cache = null; };
