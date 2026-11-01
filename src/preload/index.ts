import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  store: {
    get: (key: string) => ipcRenderer.invoke('store-get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('store-set', key, value)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings-get'),
    set: (patch: { apiKey?: string; groqKey?: string; tinyfishKey?: string; model?: string; fallbackModels?: string[]; voice?: string; awareness?: boolean }) => ipcRenderer.invoke('settings-set', patch)
  },
  tts: {
    synthesize: (text: string): Promise<Uint8Array> => ipcRenderer.invoke('tts-synthesize', text)
  },
  hud: {
    setMini: (on: boolean): Promise<void> => ipcRenderer.invoke('hud-set-mini', on),
    onMini: (cb: (on: boolean) => void): (() => void) => {
      const handler = (_event: unknown, on: boolean) => cb(on);
      ipcRenderer.on('hud-mini', handler);
      return () => ipcRenderer.removeListener('hud-mini', handler);
    }
  },
  telemetry: {
    get: (): Promise<unknown> => ipcRenderer.invoke('telemetry-get'),
    onUpdate: (cb: (t: unknown) => void): (() => void) => {
      const handler = (_event: unknown, t: unknown) => cb(t);
      ipcRenderer.on('telemetry', handler);
      return () => ipcRenderer.removeListener('telemetry', handler);
    }
  },
  stt: {
    load: (onProgress: (pct: number) => void): Promise<void> => {
      const handler = (_event: unknown, pct: number) => onProgress(pct);
      ipcRenderer.on('stt-progress', handler);
      return ipcRenderer.invoke('stt-load').finally(() => ipcRenderer.removeListener('stt-progress', handler));
    },
    transcribe: (audio: Float32Array): Promise<string> => ipcRenderer.invoke('stt-transcribe', audio)
  },
  confirm: {
    reply: (id: number, ok: boolean): Promise<void> => ipcRenderer.invoke('confirm-reply', id, ok)
  },
  ai: {
    chat: (text: string, onDelta: (delta: string) => void, onProgress?: (note: string) => void): Promise<string> => {
      const handler = (_event: unknown, delta: string) => onDelta(delta);
      const progress = (_event: unknown, note: string) => onProgress?.(note);
      ipcRenderer.on('ai-delta', handler);
      ipcRenderer.on('ai-progress', progress);
      return ipcRenderer.invoke('ai-chat', text).finally(() => {
        ipcRenderer.removeListener('ai-delta', handler);
        ipcRenderer.removeListener('ai-progress', progress);
      });
    },
    models: () => ipcRenderer.invoke('ai-models'),
    cancel: (): Promise<void> => ipcRenderer.invoke('ai-cancel')
  },
  modes: {
    get: () => ipcRenderer.invoke('mode-get'),
    set: (mode: 'interactive' | 'background') => ipcRenderer.invoke('mode-set', mode)
  },
  // The only push channels the renderer needs. A wide-open `on` would let a compromised
  // renderer eavesdrop on arbitrary main-process events (confirm prompts, telemetry, ...).
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
  ): (() => void) => {
    const handler = (_event: unknown, ...args: unknown[]) => func(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});

export {};
