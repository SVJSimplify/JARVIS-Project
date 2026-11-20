/**
 * JINI session runtime — a Cline-compatible run/continue/abort/subscribe/snapshot/restore
 * surface over JINI's existing provider, tool gate, coordinator, and durable task store.
 *
 * The runtime deliberately owns session lifecycle, not a second model/tool engine.
 * All tool execution remains inside provider.ts -> tools.ts -> JINI policy/receipts.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FILES_ROOT } from '../workspace';
import { atomicWrite, loadJson } from '../store';
import { chat, cancelChat, snapshotChatHistory, restoreChatHistory } from '../provider';
import type { Message } from '../llm';
import type { AgentRuntimeHooks } from '../agentRuntimeHooks';

export type AgentSessionStatus = 'idle' | 'running' | 'aborting' | 'completed' | 'failed' | 'aborted' | 'interrupted';
export interface AgentSessionSnapshot {
  id: string;
  /** Source session when this session was forked. */
  parentSessionId?: string;
  status: AgentSessionStatus;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  iteration: number;
  pendingToolCalls: string[];
  messages?: Message[];
  lastOutput?: string;
  lastError?: string;
}
export interface AgentRuntimeEvent {
  eventId: string;
  sequence: number;
  type: 'session-created' | 'abort-requested' | 'run-start' | 'model-start' | 'model-end' | 'tool-start' | 'tool-end' | 'delta' | 'progress' | 'run-end' | 'session-restored';
  sessionId: string;
  at: number;
  status: AgentSessionStatus;
  text?: string;
  error?: string;
  round?: number;
  tool?: string;
}
export interface AgentRunOptions {
  sessionId?: string;
  source?: 'interactive' | 'scheduled';
  onDelta?: (delta: string) => void;
  onProgress?: (progress: string) => void;
  hooks?: AgentRuntimeHooks;
}
export interface AgentRuntimeDriver {
  chat: typeof chat;
  cancelChat: typeof cancelChat;
  snapshotHistory?: (sessionId: string) => Message[];
  restoreHistory?: (sessionId: string, messages: readonly Message[]) => void;
}
export interface AgentRuntimePersistence {
  load(): Promise<unknown>;
  save(sessions: AgentSessionSnapshot[]): Promise<void>;
  loadEvents?(): Promise<unknown>;
  saveEvents?(events: AgentRuntimeEvent[]): Promise<void>;
}
const defaultPersistence: AgentRuntimePersistence = {
  load: () => loadJson<unknown>(path.join(FILES_ROOT, 'brain', 'agent-runtime', 'sessions.json'), []),
  save: async (sessions) => {
    const dir = path.join(FILES_ROOT, 'brain', 'agent-runtime');
    await fs.mkdir(dir, { recursive: true });
    await atomicWrite(path.join(dir, 'sessions.json'), JSON.stringify(sessions));
  },
  loadEvents: () => loadJson<unknown>(path.join(FILES_ROOT, 'brain', 'agent-runtime', 'events.json'), []),
  saveEvents: async (events) => {
    const dir = path.join(FILES_ROOT, 'brain', 'agent-runtime');
    await fs.mkdir(dir, { recursive: true });
    await atomicWrite(path.join(dir, 'events.json'), JSON.stringify(events));
  },
};
const validStatus = (v: unknown): v is AgentSessionStatus =>
  ['idle', 'running', 'aborting', 'completed', 'failed', 'aborted', 'interrupted'].includes(String(v));
const clone = (s: AgentSessionSnapshot): AgentSessionSnapshot => structuredClone(s);
const cloneEvent = (event: AgentRuntimeEvent): AgentRuntimeEvent => structuredClone(event);
const MAX_RUNTIME_EVENTS = 10_000;

export class AgentRuntime {
  private readonly sessions = new Map<string, AgentSessionSnapshot>();
  private readonly activeRuns = new Map<string, Promise<string>>();
  private readonly cancelRequested = new Set<string>();
  private readonly listeners = new Set<(event: AgentRuntimeEvent) => void>();
  private readonly sessionListeners = new Map<string, Set<(event: AgentRuntimeEvent) => void>>();
  private readonly eventLog: AgentRuntimeEvent[] = [];
  private eventSequence = 0;
  private hydrated: Promise<void> | null = null;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly driver: AgentRuntimeDriver,
    private readonly persistence: AgentRuntimePersistence = defaultPersistence,
  ) {}

  private async hydrate(): Promise<void> {
    if (!this.hydrated) {
      this.hydrated = (async () => {
        const [raw, rawEvents] = await Promise.all([
          this.persistence.load().catch(() => []),
          this.persistence.loadEvents?.().catch(() => []) ?? Promise.resolve([]),
        ]);
        if (Array.isArray(rawEvents)) {
          for (const item of rawEvents) {
            if (!item || typeof item !== 'object') continue;
            const event = item as Partial<AgentRuntimeEvent>;
            if (typeof event.eventId !== 'string' || !event.eventId || !Number.isSafeInteger(event.sequence) || !Number.isFinite(event.at) || typeof event.sessionId !== 'string' || !validStatus(event.status)) continue;
            if (!['session-created', 'abort-requested', 'run-start', 'model-start', 'model-end', 'tool-start', 'tool-end', 'delta', 'progress', 'run-end', 'session-restored'].includes(String(event.type))) continue;
            this.eventLog.push(event as AgentRuntimeEvent);
            this.eventSequence = Math.max(this.eventSequence, Number(event.sequence));
          }
          this.eventLog.sort((a, b) => a.sequence - b.sequence);
          if (this.eventLog.length > MAX_RUNTIME_EVENTS) this.eventLog.splice(0, this.eventLog.length - MAX_RUNTIME_EVENTS);
        }
        if (!Array.isArray(raw)) return;
        for (const item of raw) {
          if (!item || typeof item !== 'object') continue;
          const s = item as Partial<AgentSessionSnapshot>;
          if (typeof s.id !== 'string' || !s.id || !validStatus(s.status)) continue;
          const restored: AgentSessionSnapshot = {
            id: s.id,
            status: s.status === 'running' || s.status === 'aborting' ? 'interrupted' : s.status,
            createdAt: Number.isFinite(s.createdAt) ? Number(s.createdAt) : Date.now(),
            updatedAt: Number.isFinite(s.updatedAt) ? Number(s.updatedAt) : Date.now(),
            turnCount: Number.isFinite(s.turnCount) ? Math.max(0, Number(s.turnCount)) : 0,
            iteration: Number.isFinite(s.iteration) ? Math.max(0, Number(s.iteration)) : 0,
            pendingToolCalls: Array.isArray(s.pendingToolCalls) ? s.pendingToolCalls.filter((v): v is string => typeof v === 'string') : [],
            ...(Array.isArray(s.messages) ? { messages: s.messages as Message[] } : {}),
            ...(typeof s.parentSessionId === 'string' ? { parentSessionId: s.parentSessionId } : {}),
            ...(typeof s.lastOutput === 'string' ? { lastOutput: s.lastOutput } : {}),
            ...(typeof s.lastError === 'string' ? { lastError: s.lastError } : {}),
          };
          this.sessions.set(restored.id, restored);
          if (restored.messages) this.driver.restoreHistory?.(restored.id, restored.messages);
        }
      })();
    }
    await this.hydrated;
  }

  private emit(event: Omit<AgentRuntimeEvent, 'eventId' | 'sequence'>): AgentRuntimeEvent {
    const recorded: AgentRuntimeEvent = { ...event, eventId: randomUUID(), sequence: ++this.eventSequence };
    this.eventLog.push(recorded);
    if (this.eventLog.length > MAX_RUNTIME_EVENTS) this.eventLog.splice(0, this.eventLog.length - MAX_RUNTIME_EVENTS);
    for (const listener of [...this.listeners, ...(this.sessionListeners.get(recorded.sessionId) ?? [])]) {
      try { listener(cloneEvent(recorded)); } catch (error) { console.warn('[agent-runtime] listener failed', error); }
    }
    return recorded;
  }

  private save(): Promise<void> {
    const snapshot = [...this.sessions.values()].map(clone);
    const events = this.eventLog.map(cloneEvent);
    this.persistChain = this.persistChain.catch(() => undefined).then(async () => {
      await this.persistence.save(snapshot);
      await this.persistence.saveEvents?.(events);
    });
    return this.persistChain;
  }

  async createSession(id: string = randomUUID()): Promise<AgentSessionSnapshot> {
    if (typeof id !== 'string' || !id.trim() || id.length > 160) throw new Error('Agent session id must be 1–160 characters.');
    await this.hydrate();
    if (this.sessions.has(id)) throw new Error(`Agent session "${id}" already exists.`);
    const now = Date.now();
    const session: AgentSessionSnapshot = { id, status: 'idle', createdAt: now, updatedAt: now, turnCount: 0, iteration: 0, pendingToolCalls: [], messages: [] };
    this.sessions.set(id, session);
    await this.save();
    this.emit({ type: 'session-created', sessionId: id, at: now, status: session.status });
    await this.save();
    return clone(session);
  }

  async run(prompt: string, options: AgentRunOptions = {}): Promise<string> {
    if (!prompt.trim()) throw new Error('Agent prompt cannot be empty.');
    await this.hydrate();
    const id = options.sessionId ?? randomUUID();
    // OpenCode-style per-session ownership: a new interactive turn replaces only the
    // active run in the same session; scheduled work joins/queues behind that session.
    while (this.activeRuns.has(id)) {
      const active = this.activeRuns.get(id)!;
      if (options.source !== 'scheduled') await this.abort(id);
      await active.catch(() => undefined);
      // The run wrapper's finally may be queued just after this continuation. Retire
      // the exact settled promise here so a replacement cannot spin on a stale map entry
      // or observe the previous session's still-running snapshot.
      if (this.activeRuns.get(id) === active) this.activeRuns.delete(id);
    }
    this.cancelRequested.delete(id);
    const pending = this.runSession(prompt, { ...options, sessionId: id }, id);
    this.activeRuns.set(id, pending);
    try {
      return await pending;
    } finally {
      if (this.activeRuns.get(id) === pending) this.activeRuns.delete(id);
    }
  }

  private async runSession(prompt: string, options: AgentRunOptions, id: string): Promise<string> {
    await this.hydrate();
    let session = this.sessions.get(id);
    if (!session) {
      // createSession intentionally returns a defensive clone to callers. Re-read the
      // canonical map entry before mutating run state; mutating that clone left persisted
      // sessions stuck at "idle" and broke snapshots, lifecycle hooks and replacement.
      await this.createSession(id);
      session = this.sessions.get(id);
    }
    if (!session) throw new Error(`Agent session "${id}" could not be created.`);
    if (session.status === 'running' || session.status === 'aborting') {
      throw new Error(`Agent session "${id}" already has an active run.`);
    }
    session.status = 'running';
    session.iteration = 0;
    session.pendingToolCalls = [];
    session.updatedAt = Date.now();
    delete session.lastError;
    await this.save();
    if (this.cancelRequested.has(id)) {
      this.cancelRequested.delete(id);
      session.status = 'aborted';
      session.updatedAt = Date.now();
      await this.save();
      this.emit({ type: 'run-end', sessionId: id, at: session.updatedAt, status: 'aborted' });
      return '';
    }
    this.emit({ type: 'run-start', sessionId: id, at: session.updatedAt, status: session.status });
    await this.save();
    let output = '';
    try {
      const callerHooks = options.hooks;
      const hooks: AgentRuntimeHooks = {
        ...callerHooks,
        onEvent: async (event) => {
          try { await callerHooks?.onEvent?.(event); }
          finally {
            if (event.type === 'model-start') session!.iteration = Math.max(session!.iteration, (event.round ?? session!.iteration) + 1);
            if (event.type === 'tool-start' && event.tool) session!.pendingToolCalls.push(event.tool);
            if (event.type === 'tool-end' && event.tool) {
              const index = session!.pendingToolCalls.indexOf(event.tool);
              if (index >= 0) session!.pendingToolCalls.splice(index, 1);
            }
            this.emit({
              type: event.type,
              sessionId: id,
              at: Date.now(),
              status: session!.status,
              ...(event.round === undefined ? {} : { round: event.round }),
              ...(event.tool === undefined ? {} : { tool: event.tool }),
              ...(event.status === undefined ? {} : { text: event.status }),
            });
            // Model/tool boundaries are recovery checkpoints. Persist both execution state
            // and the provider's transcript projection so a crash can resume from known state.
            const checkpointMessages = this.driver.snapshotHistory?.(id);
            if (checkpointMessages) session!.messages = checkpointMessages;
            await this.save();
          }
        },
      };
      output = await this.driver.chat(
        prompt,
        (delta) => {
          output += delta;
          options.onDelta?.(delta);
          this.emit({ type: 'delta', sessionId: id, at: Date.now(), status: 'running', text: delta });
        },
        (progress) => {
          options.onProgress?.(progress);
          this.emit({ type: 'progress', sessionId: id, at: Date.now(), status: 'running', text: progress });
        },
        { chatId: id, source: options.source ?? 'interactive', hooks },
      );
      const wasAborted = this.cancelRequested.has(id);
      this.cancelRequested.delete(id);
      session.status = wasAborted ? 'aborted' : 'completed';
      session.lastOutput = output;
      session.messages = this.driver.snapshotHistory?.(id) ?? session.messages ?? [];
      session.pendingToolCalls = [];
      session.turnCount++;
      session.updatedAt = Date.now();
      await this.save();
      this.emit({ type: 'run-end', sessionId: id, at: session.updatedAt, status: session.status, text: output });
      await this.save();
      return output;
    } catch (error) {
      session.status = this.cancelRequested.has(id) || (session as AgentSessionSnapshot).status === 'aborting' ? 'aborted' : 'failed';
      this.cancelRequested.delete(id);
      session.lastError = error instanceof Error ? error.message : String(error);
      session.messages = this.driver.snapshotHistory?.(id) ?? session.messages ?? [];
      session.pendingToolCalls = [];
      session.updatedAt = Date.now();
      await this.save().catch(() => undefined);
      this.emit({ type: 'run-end', sessionId: id, at: session.updatedAt, status: session.status, error: session.lastError });
      await this.save().catch(() => undefined);
      throw error;
    }
  }

  async continue(sessionId: string, prompt: string, options: Omit<AgentRunOptions, 'sessionId'> = {}): Promise<string> {
    await this.hydrate();
    if (!this.sessions.has(sessionId)) throw new Error(`Unknown agent session "${sessionId}".`);
    return this.run(prompt, { ...options, sessionId });
  }

  async abort(sessionId: string): Promise<boolean> {
    await this.hydrate();
    const session = this.sessions.get(sessionId);
    const active = this.activeRuns.has(sessionId);
    if (!active && (!session || (session.status !== 'running' && session.status !== 'aborting'))) return false;
    if (session && session.status !== 'running' && session.status !== 'aborting' && session.status !== 'idle') return false;
    this.cancelRequested.add(sessionId);
    if (session) {
      session.status = 'aborting';
      session.updatedAt = Date.now();
      await this.save();
    }
    this.emit({ type: 'abort-requested', sessionId, at: Date.now(), status: session?.status ?? 'aborting' });
    await this.save();
    this.driver.cancelChat(sessionId);
    return true;
  }

  async subscribe(listener: (event: AgentRuntimeEvent) => void, sessionId?: string): Promise<() => void> {
    await this.hydrate();
    const target = sessionId ? (this.sessionListeners.get(sessionId) ?? new Set<(event: AgentRuntimeEvent) => void>()) : this.listeners;
    if (sessionId) this.sessionListeners.set(sessionId, target);
    target.add(listener);
    return () => {
      target.delete(listener);
      if (sessionId && target.size === 0) this.sessionListeners.delete(sessionId);
    };
  }

  async snapshot(sessionId: string): Promise<AgentSessionSnapshot> {
    await this.hydrate();
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown agent session "${sessionId}".`);
    const messages = this.driver.snapshotHistory?.(sessionId);
    if (messages) session.messages = messages;
    return clone(session);
  }

  /** Replay the durable session event stream after a sequence cursor. */
  async replay(sessionId: string, afterSequence = 0): Promise<AgentRuntimeEvent[]> {
    await this.hydrate();
    if (!this.sessions.has(sessionId)) throw new Error(`Unknown agent session \"${sessionId}\".`);
    const cursor = Number.isFinite(afterSequence) ? Math.max(0, Math.floor(afterSequence)) : 0;
    return this.eventLog.filter((event) => event.sessionId === sessionId && event.sequence > cursor).map(cloneEvent);
  }

  async list(): Promise<AgentSessionSnapshot[]> {
    await this.hydrate();
    return [...this.sessions.values()].map(clone).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Fork a completed/interrupted conversation without sharing mutable transcript state. */
  async fork(sessionId: string, newSessionId: string = randomUUID()): Promise<AgentSessionSnapshot> {
    await this.hydrate();
    const source = this.sessions.get(sessionId);
    if (!source) throw new Error(`Unknown agent session \"${sessionId}\".`);
    if (this.sessions.has(newSessionId)) throw new Error(`Agent session \"${newSessionId}\" already exists.`);
    if (this.activeRuns.has(sessionId)) throw new Error('Cannot fork a session while it is running.');
    const now = Date.now();
    const messages = this.driver.snapshotHistory?.(sessionId) ?? source.messages ?? [];
    const fork: AgentSessionSnapshot = { id: newSessionId, parentSessionId: sessionId, status: 'idle', createdAt: now, updatedAt: now, turnCount: 0, iteration: 0, pendingToolCalls: [], messages: structuredClone(messages) };
    this.sessions.set(newSessionId, fork);
    this.driver.restoreHistory?.(newSessionId, fork.messages ?? []);
    await this.save();
    this.emit({ type: 'session-created', sessionId: newSessionId, at: now, status: 'idle' });
    await this.save();
    return clone(fork);
  }

  async restore(snapshot: AgentSessionSnapshot): Promise<AgentSessionSnapshot> {
    await this.hydrate();
    if (!snapshot || typeof snapshot.id !== 'string' || !snapshot.id.trim() || snapshot.id.length > 160 || !validStatus(snapshot.status)) {
      throw new Error('Invalid agent session snapshot.');
    }
    if (this.activeRuns.has(snapshot.id)) throw new Error(`Cannot restore active agent session \"${snapshot.id}\".`);
    const restored: AgentSessionSnapshot = {
      ...snapshot,
      parentSessionId: typeof snapshot.parentSessionId === 'string' ? snapshot.parentSessionId : undefined,
      status: snapshot.status === 'running' || snapshot.status === 'aborting' ? 'interrupted' : snapshot.status,
      turnCount: Number.isFinite(snapshot.turnCount) ? Math.max(0, Math.floor(snapshot.turnCount)) : 0,
      iteration: Number.isFinite(snapshot.iteration) ? Math.max(0, Math.floor(snapshot.iteration)) : 0,
      pendingToolCalls: [],
      messages: Array.isArray(snapshot.messages) ? structuredClone(snapshot.messages) : [],
      updatedAt: Date.now(),
    };
    this.sessions.set(restored.id, restored);
    if (restored.messages) this.driver.restoreHistory?.(restored.id, restored.messages);
    await this.save();
    this.emit({ type: 'session-restored', sessionId: restored.id, at: restored.updatedAt, status: restored.status });
    await this.save();
    return clone(restored);
  }
}

export const agentRuntime = new AgentRuntime({ chat, cancelChat, snapshotHistory: snapshotChatHistory, restoreHistory: restoreChatHistory });
