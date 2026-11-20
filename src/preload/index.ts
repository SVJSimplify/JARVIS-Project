import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  updates: {
    get: () => ipcRenderer.invoke('updates:get'),
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install'),
    onStatus: (cb: (status: unknown) => void): (() => void) => {
      const handler = (_event: unknown, status: unknown) => cb(status);
      ipcRenderer.on('updates:status', handler);
      return () => ipcRenderer.removeListener('updates:status', handler);
    },
  },
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  devices: {
    status: () => ipcRenderer.invoke('devices-status'),
    enable: (on: boolean) => ipcRenderer.invoke('devices-enable', on),
    pairStart: () => ipcRenderer.invoke('devices-pair-start'),
    pairCancel: () => ipcRenderer.invoke('devices-pair-cancel'),
    revoke: (id: string) => ipcRenderer.invoke('devices-revoke', id),
    forget: (id: string) => ipcRenderer.invoke('devices-forget', id),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings-get'),
    set: (patch: { baseUrl?: string; apiKey?: string; groqKey?: string; tinyfishKey?: string; model?: string; fallbackModels?: string[]; voice?: string; awareness?: boolean }) => ipcRenderer.invoke('settings-set', patch)
  },
  tts: {
    synthesize: (text: string): Promise<Uint8Array> => ipcRenderer.invoke('tts-synthesize', text)
  },
  windowControl: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window-minimize'),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('window-toggle-maximize'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window-is-maximized'),
    close: (): Promise<void> => ipcRenderer.invoke('window-close'),
    onMaximizedChange: (cb: (maximized: boolean) => void): (() => void) => {
      const handler = (_event: unknown, maximized: boolean) => cb(maximized);
      ipcRenderer.on('window-maximized', handler);
      return () => ipcRenderer.removeListener('window-maximized', handler);
    },
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
  ai: {
    chat: (text: string, onDelta: (delta: string) => void, onProgress?: (note: string) => void, onRuntimeEvent?: (event: unknown) => void): Promise<string> => {
      const handler = (_event: unknown, delta: string) => onDelta(delta);
      const progress = (_event: unknown, note: string) => onProgress?.(note);
      const runtimeEvent = (_event: unknown, value: unknown) => onRuntimeEvent?.(value);
      ipcRenderer.on('ai-delta', handler);
      ipcRenderer.on('ai-progress', progress);
      ipcRenderer.on('agent-runtime-event', runtimeEvent);
      return ipcRenderer.invoke('ai-chat', text).finally(() => {
        ipcRenderer.removeListener('ai-delta', handler);
        ipcRenderer.removeListener('ai-progress', progress);
        ipcRenderer.removeListener('agent-runtime-event', runtimeEvent);
      });
    },
    models: () => ipcRenderer.invoke('ai-models'),
    cancel: (): Promise<void> => ipcRenderer.invoke('ai-cancel')
  },
  /** Cline/OpenCode-style session management and durable event replay. */
  agent: {
    sessions: (): Promise<unknown[]> => ipcRenderer.invoke('agent-sessions-list'),
    snapshot: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('agent-session-snapshot', sessionId),
    replay: (sessionId: string, afterSequence = 0): Promise<unknown[]> => ipcRenderer.invoke('agent-session-replay', sessionId, afterSequence),
    fork: (sessionId: string, newSessionId?: string): Promise<unknown> => ipcRenderer.invoke('agent-session-fork', sessionId, newSessionId),
    abort: (sessionId: string): Promise<boolean> => ipcRenderer.invoke('agent-session-abort', sessionId),
    tools: {
      list: () => ipcRenderer.invoke('agent-tools-list'),
      setEnabled: (name: string, enabled: boolean): Promise<unknown[]> => ipcRenderer.invoke('agent-tools-set-enabled', name, enabled),
    },
    plugins: { list: () => ipcRenderer.invoke('agent-plugins-list') }
  },
  modes: {
    get: () => ipcRenderer.invoke('mode-get'),
    set: (mode: 'interactive' | 'background') => ipcRenderer.invoke('mode-set', mode)
  },
  // Live task progress: the current snapshot on demand (late subscribers), plus the
  // always-on push channel below.
  progress: {
    get: () => ipcRenderer.invoke('progress-get')
  },
  // Round 23: read-only activity queries over the main-process invocation ledger —
  // the live summary counts, the scope list and the paged full history. There is no
  // write path: the renderer observes execution, it never drives it.
  activity: {
    summary: (scope?: string): Promise<unknown> => ipcRenderer.invoke('activity-summary', scope),
    scopes: (): Promise<unknown> => ipcRenderer.invoke('activity-scopes'),
    query: (opts?: { scope?: string; offset?: number; limit?: number }): Promise<unknown> => ipcRenderer.invoke('activity-query', opts)
  },
  // Conversations panel: read-only access to the durable full-fidelity turn history.
  history: {
    list: (): Promise<unknown> => ipcRenderer.invoke('history-list')
  },
  // Chats: separate conversation threads (same list the paired phone sees).
  /** Screenshots JINI takes during a turn (shown inline in the thread). */
  onScreenshot: (cb: (dataUrl: string) => void): (() => void) => {
    const h = (_: unknown, url: string) => cb(url);
    ipcRenderer.on('jini-screenshot', h);
    return () => ipcRenderer.removeListener('jini-screenshot', h);
  },
  chats: {
    list: (): Promise<{ active: string; chats: Array<{ id: string; title: string; createdAt: number; updatedAt: number; turns: number }> }> => ipcRenderer.invoke('chats-list'),
    turns: (id: string): Promise<Array<{ t: number; user: string; reply: string; actions: string[]; error?: string }>> => ipcRenderer.invoke('chats-turns', id),
    create: (): Promise<{ id: string; title: string }> => ipcRenderer.invoke('chats-create'),
    select: (id: string): Promise<void> => ipcRenderer.invoke('chats-select', id),
    rename: (id: string, title: string): Promise<void> => ipcRenderer.invoke('chats-rename', id, title),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('chats-delete', id),
    onChanged: (cb: () => void): (() => void) => {
      const h = () => cb();
      ipcRenderer.on('chats-changed', h);
      return () => ipcRenderer.removeListener('chats-changed', h);
    }
  },
  // Round 22 (Project Autopilot): the Projects workspace. Every call maps to one real
  // backend operation in the main process; there are no decorative channels.
  projects: {
    list: (opts?: { offset?: number; limit?: number; query?: string; status?: string }): Promise<unknown> => ipcRenderer.invoke('projects-list', opts),
    get: (id: string): Promise<unknown> => ipcRenderer.invoke('projects-get', id),
    create: (description: string, templateId?: string): Promise<unknown> => ipcRenderer.invoke('projects-create', description, templateId),
    createFromTemplate: (templateId: string, description?: string): Promise<unknown> => ipcRenderer.invoke('projects-create-template', templateId, description),
    templates: (): Promise<unknown> => ipcRenderer.invoke('projects-templates'),
    execute: (id: string): Promise<string> => ipcRenderer.invoke('projects-execute', id),
    pause: (id: string): Promise<string> => ipcRenderer.invoke('projects-pause', id),
    resume: (id: string): Promise<string> => ipcRenderer.invoke('projects-resume', id),
    cancel: (id: string): Promise<string> => ipcRenderer.invoke('projects-cancel', id),
    replan: (id: string, note?: string): Promise<string> => ipcRenderer.invoke('projects-replan', id, note),
    updateRequirements: (id: string, patch: { add?: string[]; remove?: string[]; note?: string }): Promise<string> => ipcRenderer.invoke('projects-update-requirements', id, patch)
  },
  // Round 27 (§1.3): the Background Operations Control Center. Read handlers project
  // EXISTING durable backend state; the action handlers invoke the SAME authorized task /
  // routine tools the agent uses (task_pause/task_resume/task_cancel, cancel_recurring).
  ops: {
    overview: (): Promise<unknown> => ipcRenderer.invoke('ops-overview'),
    task: (id: string): Promise<unknown> => ipcRenderer.invoke('ops-task', id),
    taskAction: (id: string, action: 'pause' | 'resume' | 'cancel' | 'retry'): Promise<string> => ipcRenderer.invoke('ops-task-action', id, action),
    routineAction: (id: string, action: 'enable' | 'disable' | 'cancel'): Promise<string> => ipcRenderer.invoke('ops-routine-action', id, action),
    recoveryStatus: (): Promise<unknown> => ipcRenderer.invoke('ops-recovery-status'),
    recoveryRun: (about: string): Promise<string> => ipcRenderer.invoke('ops-recovery-run', about),
    recoverySettings: (patch: { autoRecovery?: boolean; maxActionsPerHour?: number }): Promise<unknown> => ipcRenderer.invoke('ops-recovery-settings', patch)
  },
  // Round 28 (Phase 2): the Native Browser panel. Reads project the live session state;
  // connect/disconnect are EXPLICIT user actions (the same authorized operations the
  // agent's native_browser_connect/disconnect tools perform). No secrets cross this bridge.
  nativeBrowser: {
    status: (): Promise<unknown> => ipcRenderer.invoke('native-browser-status'),
    discover: (): Promise<unknown> => ipcRenderer.invoke('native-browser-discover'),
    connect: (opts?: { browser?: string; mode?: 'A' | 'B'; port?: number }): Promise<unknown> => ipcRenderer.invoke('native-browser-connect', opts),
    disconnect: (opts?: { closeBrowser?: boolean }): Promise<string> => ipcRenderer.invoke('native-browser-disconnect', opts),
    reconnect: (): Promise<string> => ipcRenderer.invoke('native-browser-reconnect'),
    setConfig: (patch: { selectedBrowser?: string; mode?: 'A' | 'B'; attachPort?: number; visibility?: 'normal' | 'minimized'; autoReconnect?: boolean; keepOpenOnQuit?: boolean; defaultBrowser?: 'panel' | 'native' }): Promise<unknown> => ipcRenderer.invoke('native-browser-set-config', patch),
    activateTab: (tabId: string): Promise<string> => ipcRenderer.invoke('native-browser-activate-tab', tabId)
  },
  // Round 29 (§1.1): user action approvals. The renderer can only RESPOND to requests
  // the main process created and pushed — it can never mint, extend or forge an approval.
  // ROUND 32: the Approve button asks the MAIN PROCESS to open the native system
  // confirmation dialog; only that dialog's result grants.
  approvals: {
    list: (): Promise<unknown> => ipcRenderer.invoke('approval-list'),
    respond: (id: string, decision: 'approve' | 'deny'): Promise<unknown> => ipcRenderer.invoke('approval-respond', id, decision),
    dismiss: (id: string): Promise<unknown> => ipcRenderer.invoke('approval-dismiss', id)
  },
  // ROUND 32 (Phase 3 §3.1): integration credential management. Only PRESENCE metadata
  // crosses this bridge — a stored secret never leaves the main process, decrypted or not.
  credentials: {
    info: (): Promise<unknown> => ipcRenderer.invoke('credentials-info'),
    set: (service: string, secret: string): Promise<{ ok: boolean; reason: string }> => ipcRenderer.invoke('credentials-set', service, secret),
    test: (service: string): Promise<{ ok: boolean; reason: string }> => ipcRenderer.invoke('credentials-test', service),
    revoke: (service: string): Promise<{ ok: boolean; reason: string }> => ipcRenderer.invoke('credentials-revoke', service)
  },
  // The only push channels the renderer needs. A wide-open `on` would let a compromised
  // renderer eavesdrop on arbitrary main-process events (telemetry, notifications, ...).
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
  ): (() => void) => {
    const handler = (_event: unknown, ...args: unknown[]) => func(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});

export {};
