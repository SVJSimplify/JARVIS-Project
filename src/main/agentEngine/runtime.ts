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
import { chat, cancelChat } from '../provider';

export type AgentSessionStatus = 'idle' | 'running' | 'aborting' | 'completed' | 'failed' | 'aborted' | 'interrupted';
export interface AgentSessionSnapshot {
  id: string;
  status: AgentSessionStatus;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  lastOutput?: string;
  lastError?: string;
}
export interface AgentRuntimeEvent {
  type: 'session-created' | 'run-start' | 'delta' | 'progress' | 'run-end' | 'session-restored';
  sessionId: string;
  at: number;
  status: AgentSessionStatus;
  text?: string;
  error?: string;
}
export interface AgentRunOptions {
  sessionId?: string;
  source?: 'interactive' | 'scheduled';
  onDelta?: (delta: string) => void;
  onProgress?: (progress: string) => void;
}
export interface AgentRuntimeDriver {
  chat: typeof chat;
  cancelChat: typeof cancelChat;
}
export interface AgentRuntimePersistence {
  load(): Promise<unknown>;
  save(sessions: AgentSessionSnapshot[]): Promise<void>;
}
const defaultPersistence: AgentRuntimePersistence = {
  load: () => loadJson<unknown>(path.join(FILES_ROOT, 'brain', 'agent-runtime', 'sessions.json'), []),
  save: async (sessions) => {
    const dir = path.join(FILES_ROOT, 'brain', 'agent-runtime');
    await fs.mkdir(dir, { recursive: true });
    await atomicWrite(path.join(dir, 'sessions.json'), JSON.stringify(sessions));
  },
};
const validStatus = (v: unknown): v is AgentSessionStatus =>
  ['idle', 'running', 'aborting', 'completed', 'failed', 'aborted', 'interrupted'].includes(String(v));
const clone = (s: AgentSessionSnapshot): AgentSessionSnapshot => ({ ...s });

export class AgentRuntime {
  private readonly sessions = new Map<string, AgentSessionSnapshot>();
  private readonly listeners = new Set<(event: AgentRuntimeEvent) => void>();
  private readonly sessionListeners = new Map<string, Set<(event: AgentRuntimeEvent) => void>>();
  private hydrated: Promise<void> | null = null;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly driver: AgentRuntimeDriver,
    private readonly persistence: AgentRuntimePersistence = defaultPersistence,
  ) {}

  private async hydrate(): Promise<void> {
    if (!this.hydrated) {
      this.hydrated = (async () => {
        const raw = await this.persistence.load().catch(() => []);
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
            ...(typeof s.lastOutput === 'string' ? { lastOutput: s.lastOutput } : {}),
            ...(typeof s.lastError === 'string' ? { lastError: s.lastError } : {}),
          };
          this.sessions.set(restored.id, restored);
        }
      })();
    }
    await this.hydrated;
  }

  private emit(event: AgentRuntimeEvent): void {
    for (const listener of [...this.listeners, ...(this.sessionListeners.get(event.sessionId) ?? [])]) {
      try { listener(event); } catch (error) { console.warn('[agent-runtime] listener failed', error); }
    }
  }

  private save(): Promise<void> {
    const snapshot = [...this.sessions.values()].map(clone);
    this.persistChain = this.persistChain.catch(() => undefined).then(() => this.persistence.save(snapshot));
    return this.persistChain;
  }

  async createSession(id = randomUUID()): Promise<AgentSessionSnapshot> {
    await this.hydrate();
    if (this.sessions.has(id)) throw new Error(`Agent session "${id}" already exists.`);
    const now = Date.now();
    const session: AgentSessionSnapshot = { id, status: 'idle', createdAt: now, updatedAt: now, turnCount: 0 };
    this.sessions.set(id, session);
    await this.save();
    this.emit({ type: 'session-created', sessionId: id, at: now, status: session.status });
    return clone(session);
  }

  async run(prompt: string, options: AgentRunOptions = {}): Promise<string> {
    if (!prompt.trim()) throw new Error('Agent prompt cannot be empty.');
    await this.hydrate();
    const id = options.sessionId ?? randomUUID();
    let session = this.sessions.get(id);
    if (!session) session = await this.createSession(id);
    if (session.status === 'running' || session.status === 'aborting') {
      throw new Error(`Agent session "${id}" already has an active run.`);
    }
    session.status = 'running';
    session.updatedAt = Date.now();
    delete session.lastError;
    await this.save();
    this.emit({ type: 'run-start', sessionId: id, at: session.updatedAt, status: session.status });
    let output = '';
    try {
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
        { chatId: id, source: options.source ?? 'interactive' },
      );
      session.status = session.status === 'aborting' ? 'aborted' : 'completed';
      session.lastOutput = output;
      session.turnCount++;
      session.updatedAt = Date.now();
      await this.save();
      this.emit({ type: 'run-end', sessionId: id, at: session.updatedAt, status: session.status, text: output });
      return output;
    } catch (error) {
      session.status = 'failed';
      session.lastError = error instanceof Error ? error.message : String(error);
      session.updatedAt = Date.now();
      await this.save().catch(() => undefined);
      this.emit({ type: 'run-end', sessionId: id, at: session.updatedAt, status: 'failed', error: session.lastError });
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
    if (!session || (session.status !== 'running' && session.status !== 'aborting')) return false;
    session.status = 'aborting';
    session.updatedAt = Date.now();
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
    return clone(session);
  }

  async list(): Promise<AgentSessionSnapshot[]> {
    await this.hydrate();
    return [...this.sessions.values()].map(clone).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async restore(snapshot: AgentSessionSnapshot): Promise<AgentSessionSnapshot> {
    await this.hydrate();
    if (!snapshot || typeof snapshot.id !== 'string' || !snapshot.id || !validStatus(snapshot.status)) {
      throw new Error('Invalid agent session snapshot.');
    }
    const restored: AgentSessionSnapshot = {
      ...snapshot,
      status: snapshot.status === 'running' || snapshot.status === 'aborting' ? 'interrupted' : snapshot.status,
      turnCount: Math.max(0, Math.floor(snapshot.turnCount || 0)),
      updatedAt: Date.now(),
    };
    this.sessions.set(restored.id, restored);
    await this.save();
    this.emit({ type: 'session-restored', sessionId: restored.id, at: restored.updatedAt, status: restored.status });
    return clone(restored);
  }
}

export const agentRuntime = new AgentRuntime({ chat, cancelChat });
