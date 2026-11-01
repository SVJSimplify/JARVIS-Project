/**
 * Electron type definitions
 */
import type { ActivityEvent, ModeInfo, NotifyPayload } from '../src/main/protocol';

declare namespace Electron {
  interface ipcRenderer {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    on(channel: string, listener: (event: Electron.IpcRendererEvent, ...args: unknown[]) => void): void;
    once(channel: string, listener: (event: Electron.IpcRendererEvent, ...args: unknown[]) => void): void;
  }
}

declare global {
  interface Window {
    electronAPI: {
      getAppVersion: () => Promise<string>;
      openExternal: (url: string) => Promise<void>;
      store: {
        get: (key: string) => Promise<unknown>;
        set: (key: string, value: unknown) => Promise<void>;
      };
      settings: {
        get: () => Promise<{ baseUrl: string; apiKeySet: boolean; groqKeySet: boolean; tinyfishKeySet: boolean; model: string; fallbackModels: string[]; voice: string }>;
        set: (patch: { apiKey?: string; groqKey?: string; tinyfishKey?: string; model?: string; fallbackModels?: string[]; voice?: string }) => Promise<void>;
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
      };
      modes: {
        get: () => Promise<ModeInfo>;
        set: (mode: 'interactive' | 'background') => Promise<unknown>;
      };
      on: (
        channel:
          | 'jarvis-say'
          | 'confirm-request'
          | 'confirm-clear'
          | 'jarvis-visual'
          | 'jarvis-activity'
          | 'jarvis-notify'
          | 'mode-changed',
        func: (...args: unknown[]) => void
      ) => () => void;
    };
  }
}

export type { ActivityEvent, ModeInfo, NotifyPayload };
