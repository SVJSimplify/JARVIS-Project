/**
 * Electron type definitions
 */
import type { ActivityEvent, ModeInfo, NotifyPayload, HistoryTurn } from '../src/main/protocol';
import type { ProgressSnapshot } from '../src/main/progressTypes';
import type { ActivityScopeInfo, InvocationQuery, InvocationSummary } from '../src/main/invocations';

declare namespace Electron {
  interface ipcRenderer {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    on(channel: string, listener: (event: Electron.IpcRendererEvent, ...args: unknown[]) => void): void;
    once(channel: string, listener: (event: Electron.IpcRendererEvent, ...args: unknown[]) => void): void;
  }
}

export interface JiniLinkStatus {
  enabled: boolean;
  listening: boolean;
  port: number;
  hosts: string[];
  pairing: { exp: number } | null;
  lastError: string;
  seq: number;
}

export interface JiniDeviceView {
  id: string;
  name: string;
  platform: string;
  createdAt: number;
  lastSeen: number;
  rotatedAt?: number;
  revokedAt?: number;
  revokeReason?: string;
  online: boolean;
}

declare global {
  interface Window {
    electronAPI: {
      getAppVersion: () => Promise<string>;
      openExternal: (url: string) => Promise<void>;
      devices: {
        status: () => Promise<{ status: JiniLinkStatus; devices: JiniDeviceView[] }>;
        enable: (on: boolean) => Promise<JiniLinkStatus>;
        pairStart: () => Promise<{ offer: string; exp: number }>;
        pairCancel: () => Promise<void>;
        revoke: (id: string) => Promise<boolean>;
        forget: (id: string) => Promise<boolean>;
      };
      settings: {
        get: () => Promise<{ baseUrl: string; apiKeySet: boolean; groqKeySet: boolean; tinyfishKeySet: boolean; model: string; fallbackModels: string[]; voice: string; awareness: boolean; autonomy: 'careful' | 'standard' | 'autonomous' }>;
        set: (patch: { baseUrl?: string; apiKey?: string; groqKey?: string; tinyfishKey?: string; model?: string; fallbackModels?: string[]; voice?: string; awareness?: boolean; autonomy?: 'careful' | 'standard' | 'autonomous' }) => Promise<void>;
      };
      tts: {
        synthesize: (text: string) => Promise<Uint8Array>;
      };
      hud: {
        setMini: (on: boolean) => Promise<void>;
        onMini: (cb: (on: boolean) => void) => () => void;
      };
      telemetry: {
        get: () => Promise<unknown>;
        onUpdate: (cb: (t: unknown) => void) => () => void;
      };
      stt: {
        load: (onProgress: (pct: number) => void) => Promise<void>;
        transcribe: (audio: Float32Array) => Promise<string>;
      };
      ai: {
        chat: (text: string, onDelta: (delta: string) => void, onProgress?: (note: string) => void) => Promise<string>;
        models: () => Promise<string[]>;
        cancel: () => Promise<void>;
      };
      modes: {
        get: () => Promise<ModeInfo>;
        set: (mode: 'interactive' | 'background') => Promise<unknown>;
      };
      progress: {
        get: () => Promise<ProgressSnapshot>;
      };
      /** Round 23: read-only activity queries over the main-process invocation ledger. */
      activity: {
        summary: (scope?: string) => Promise<InvocationSummary>;
        scopes: () => Promise<ActivityScopeInfo[]>;
        query: (opts?: { scope?: string; offset?: number; limit?: number }) => Promise<InvocationQuery>;
      };
      history: {
        list: () => Promise<HistoryTurn[]>;
      };
      onScreenshot: (cb: (dataUrl: string) => void) => () => void;
      /** Chats: separate conversation threads, shared with the paired phone. */
      chats: {
        list: () => Promise<{ active: string; chats: import('../src/main/protocol').ChatInfo[] }>;
        turns: (id: string) => Promise<HistoryTurn[]>;
        create: () => Promise<import('../src/main/protocol').ChatInfo>;
        select: (id: string) => Promise<void>;
        rename: (id: string, title: string) => Promise<void>;
        remove: (id: string) => Promise<void>;
        onChanged: (cb: () => void) => () => void;
      };
      /** Round 22 (Project Autopilot): the Projects workspace — every call maps to one
       *  real main-process operation. Shapes mirror autopilot/views.ts. */
      projects: {
        list: (opts?: { offset?: number; limit?: number; query?: string; status?: string }) => Promise<{
          total: number;
          offset: number;
          limit: number;
          projects: Array<{
            id: string; title: string; status: string; category: string; complexity: string; planVersion: number;
            createdAt: number; updatedAt: number; tasksTotal: number; tasksCompleted: number; tasksBlocked: number; tasksFailed: number;
            milestones: Array<{ id: string; title: string; done: number; total: number }>;
            deliverables: number; deliverablesVerified: number; blockReason?: string;
          }>;
          counts: Record<string, number>;
        }>;
        get: (id: string) => Promise<unknown>;
        create: (description: string, templateId?: string) => Promise<unknown>;
        createFromTemplate: (templateId: string, description?: string) => Promise<unknown>;
        templates: () => Promise<unknown>;
        execute: (id: string) => Promise<string>;
        pause: (id: string) => Promise<string>;
        resume: (id: string) => Promise<string>;
        cancel: (id: string) => Promise<string>;
        replan: (id: string, note?: string) => Promise<string>;
        updateRequirements: (id: string, patch: { add?: string[]; remove?: string[]; note?: string }) => Promise<string>;
      };
      /** Round 27 (§1.3): the Background Operations Control Center — read handlers
       *  project existing durable backend state (shapes mirror opsCenter.ts); the
       *  action handlers invoke the SAME authorized tools the agent uses. */
      ops: {
        overview: () => Promise<import('../src/main/opsCenter').OpsOverview>;
        task: (id: string) => Promise<import('../src/main/opsCenter').OpsTaskDetail | null>;
        taskAction: (id: string, action: 'pause' | 'resume' | 'cancel' | 'retry') => Promise<string>;
        routineAction: (id: string, action: 'enable' | 'disable' | 'cancel') => Promise<string>;
        recoveryStatus: () => Promise<import('../src/main/opsCenter').RecoveryStatus>;
        recoveryRun: (about: string) => Promise<string>;
        recoverySettings: (patch: { autoRecovery?: boolean; maxActionsPerHour?: number }) => Promise<import('../src/main/opsCenter').RecoverySettings>;
      };
      /** Round 28 (Phase 2): the Native Browser management interface — session state,
       *  installed-browser discovery, explicit connect/disconnect and configuration. */
      nativeBrowser: {
        status: () => Promise<import('../src/main/nativeBrowser').NativeBrowserStatusView>;
        discover: () => Promise<import('../src/main/nativeBrowser').InstalledBrowser[]>;
        connect: (opts?: { browser?: string; mode?: 'A' | 'B'; port?: number }) => Promise<import('../src/main/nativeBrowser').NativeSessionInfo>;
        disconnect: (opts?: { closeBrowser?: boolean }) => Promise<string>;
        reconnect: () => Promise<string>;
        setConfig: (patch: { selectedBrowser?: string; mode?: 'A' | 'B'; attachPort?: number; visibility?: 'normal' | 'minimized'; autoReconnect?: boolean; keepOpenOnQuit?: boolean; defaultBrowser?: 'panel' | 'native' }) => Promise<import('../src/main/nativeBrowser').NativeBrowserConfig>;
        activateTab: (tabId: string) => Promise<string>;
      };
      /** Round 29 (§1.1): user action approvals — respond to (or dismiss) approval
       *  requests the MAIN PROCESS created. The renderer can never mint an approval.
       *  ROUND 32: Approve asks the main process to open the native system confirmation
       *  dialog; only that dialog's result grants. */
      approvals: {
        list: () => Promise<import('../src/main/approval').ApprovalRequestView[]>;
        respond: (id: string, decision: 'approve' | 'deny') => Promise<{ ok: boolean; status: string; reason: string }>;
        dismiss: (id: string) => Promise<{ ok: boolean; reason: string }>;
      };
      /** ROUND 32 (Phase 3 §3.1): integration credential management — presence metadata
       *  only; a stored secret never crosses this bridge in either direction. */
      credentials: {
        info: () => Promise<import('../src/main/credentials').CredentialInfo[]>;
        set: (service: string, secret: string) => Promise<{ ok: boolean; reason: string }>;
        test: (service: string) => Promise<{ ok: boolean; reason: string }>;
        revoke: (service: string) => Promise<{ ok: boolean; reason: string }>;
      };
      on: (
        channel:
          | 'jarvis-say'
          | 'jarvis-visual'
          | 'jarvis-activity'
          | 'jarvis-notify'
          | 'jarvis-progress'
          | 'mode-changed'
          | 'projects-updated'
          | 'jarvis-approval-request'
          | 'jarvis-approval-resolved',
        func: (...args: unknown[]) => void
      ) => () => void;
    };
  }
}

export type { ActivityEvent, ModeInfo, NotifyPayload, ProgressSnapshot, HistoryTurn, ActivityScopeInfo, InvocationQuery, InvocationSummary };
