import { useRef, useSyncExternalStore } from 'react';
import { Preferences } from '@capacitor/preferences';

/** Everything the phone keeps between launches. Secrets live only in `link.secret`. */
export interface LinkState {
  deviceId: string;
  /** 32-byte link secret (base64url). App-private storage; see SETUP.md for the hardening note. */
  secret: string;
  desktopName: string;
  hosts: string[];
  port: number;
  host: string;
  pairedAt: number;
  revoked?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'jini';
  text: string;
  at: number;
  kind: 'chat' | 'task';
  /** queued = waiting for the desktop; running = desktop is working; done/failed = final. */
  state: 'queued' | 'sending' | 'running' | 'done' | 'failed';
  via?: 'desktop' | 'phone';
  replyTo?: string;
}

export interface TaskView {
  id: string;
  objective: string;
  status: string;
  note: string;
  done: number;
  total: number;
  updatedAt: number;
  steps?: Array<{ title: string; status: 'pending' | 'running' | 'done' | 'failed' | 'skipped' }>;
}

export interface MemoryView {
  id: string;
  label: string;
  category: string;
  scope?: string;
  updated: number;
}

export interface ApprovalView {
  id: string;
  tool: string;
  action: string;
  origin: string;
  target: string;
  effect: string;
  expiresAt: number;
}

export interface OutboxItem {
  cmdId: string;
  op: string;
  args: Record<string, unknown>;
  createdAt: number;
  error?: string;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AppState {
  link: LinkState | null;
  cursor: number;
  connection: 'unpaired' | 'offline' | 'connecting' | 'online';
  lastSync: number;
  messages: ChatMessage[];
  tasks: TaskView[];
  memories: MemoryView[];
  approvals: ApprovalView[];
  outbox: OutboxItem[];
  provider: ProviderConfig;
  toast: string;
}

const PERSISTED: Array<keyof AppState> = ['link', 'cursor', 'messages', 'tasks', 'memories', 'approvals', 'outbox', 'provider', 'lastSync'];

let state: AppState = {
  link: null,
  cursor: 0,
  connection: 'unpaired',
  lastSync: 0,
  messages: [],
  tasks: [],
  memories: [],
  approvals: [],
  outbox: [],
  provider: { baseUrl: '', apiKey: '', model: '' },
  toast: '',
};

const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const getState = (): AppState => state;

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
  if (PERSISTED.some((k) => k in p)) {
    // Batch writes: one persist per burst of changes (battery + flash wear).
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void persist(), 400);
  }
}

async function persist(): Promise<void> {
  const out: Record<string, unknown> = {};
  for (const k of PERSISTED) out[k] = state[k];
  // Keep the chat log bounded on the device.
  out.messages = state.messages.slice(-300);
  await Preferences.set({ key: 'jini.state.v1', value: JSON.stringify(out) });
}

export async function loadState(): Promise<void> {
  try {
    const { value } = await Preferences.get({ key: 'jini.state.v1' });
    if (value) {
      const saved = JSON.parse(value) as Partial<AppState>;
      state = { ...state, ...saved, connection: saved.link && !saved.link.revoked ? 'offline' : 'unpaired', toast: '' };
    }
  } catch {
    /* first launch or unreadable state: start clean */
  }
  for (const l of listeners) l();
}

const shallowEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
};

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

/** Select from the store. Selectors may build objects: results are cached by shallow equality
 *  (useSyncExternalStore requires a stable snapshot or it re-renders forever). */
export function useAppState<T>(pick: (s: AppState) => T): T {
  const cache = useRef<{ v: T } | null>(null);
  return useSyncExternalStore(subscribe, () => {
    const next = pick(state);
    if (cache.current && shallowEqual(cache.current.v, next)) return cache.current.v;
    cache.current = { v: next };
    return next;
  });
}

export function toast(text: string): void {
  setState({ toast: text });
  setTimeout(() => {
    if (state.toast === text) setState({ toast: '' });
  }, 3500);
}

export const uid = (p: string): string => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
