import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Notification, safeStorage, shell } from 'electron';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chat, listModels, stopEverything } from './provider';
import { getPublicSettings, setSettings } from './settings';
import { migrateEmbeddingsKeyStorage, setEmbeddingsCipher } from './embeddings';
import { synthesize } from './tts';
import { attachPanel } from './panel';
import { attachHud, attentionHud, isMini, sendToHud, setMini } from './hud';
import { initModes, modeInfo, setMode } from './modes';
import { getProgressSnapshot, initProgress, noteActivity, noteTurnEnd, noteTurnStart, onProgress, refreshTasks, setAgentProvider, setInvocationProvider, setTaskProvider } from './progress';
import { invocationScopes, invocationSummary, noteInvocationEvent, openInvocationTurnScope, queryInvocations } from './invocations';
import { setTaskChangeNotifier, taskViews } from './taskStore';
import { loadStt, stopStt, transcribeStt } from './stt';
import { stopAwareness, syncAwareness } from './awareness';
import { latestTelemetry, startTelemetry, stopTelemetry } from './telemetry';
import { registerScheduledRunner, startScheduler, stopScheduler } from './scheduler';
import { checkStalls } from './coordinator';
import { processPendingEpisodes } from './episodicMemory';
import { registerIntegrationExecutor } from './integrations';
import { runToolDetailed } from './tools';
import { opsOverview, opsTaskDetail, opsTaskAction, opsRoutineAction, recoveryStatus, runRecoveryFor, setRecoverySettings, superviseOperations, type OpsTaskAction, type OpsRoutineAction } from './opsCenter';
import { restoreDynamicAgents } from './agentRegistry';
import { agentViews } from './agentTracker';
import { chatTurns, onChatsChanged, createChat, deleteChat, getActiveChatId, listChats, listConversations, renameChat, setActiveChat } from './history';
import { reconcileOnStartup, startAutopilotTicker, stopAutopilotTicker } from './autopilot/engine';
import { projectDetailView, listProjectViews } from './autopilot/views';
import { createProjectFromDescription, createProjectFromTemplate, executeProject, pauseProject, resumeProject, cancelProject, replanProject, updateRequirements } from './autopilot/engine';
import { PROJECT_TEMPLATES, templateList } from './autopilot/templates';
import {
  connectNativeBrowser,
  disconnectNativeBrowser,
  discoverInstalledBrowsers,
  nativeBrowserStatusView,
  setNativeConfig,
  getNativeConfig,
  setNativeProfileRoot,
  shutdownNativeBrowser,
  activateNativeTab,
  reconnectNativeBrowser,
  type NativeMode,
} from './nativeBrowser';
import { pendingApprovalViews, respondApproval, dismissApproval, setApprovalUiPush, setNativeConfirmationPresenter, type ApprovalRequestView } from './approval';
import { senderIsTrustedAppFrame, expectedRendererSpec, noteIpcTrustRefusal, setTrustedRendererSpec, type TrustedRendererSpec } from './ipcTrust';
import { onScreenshot } from './vision';
import { initDeviceLink, linkApprovalEvent, linkChatsChanged, linkProgress, linkTasksChanged, registerDeviceIpc } from './devices/desktopLink';
import { credentialInfoIpc, credentialSetIpc, credentialTestIpc, credentialRevokeIpc, setCredentialCipher } from './credentials';

// Failures must be observable, never silent: log them with the component that owns them.
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

// JINI rebrand: keep using the existing data folder so memories, settings, tasks and paired
// history from earlier JARVIS builds carry over. Must run before anything reads userData.
app.setPath('userData', path.join(app.getPath('appData'), 'JARVIS'));

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  const rendererFile = path.resolve(__dirname, '../../dist/renderer/index.html');
  const isDevRenderer = !app.isPackaged && process.env.NODE_ENV !== 'production';
  const rendererUrl = isDevRenderer ? 'http://localhost:5173' : pathToFileURL(rendererFile).href;
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#02060b',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#02060b',
      symbolColor: '#7fe9ff',
      height: 40
    },
    webPreferences: {
      preload: path.join(__dirname, '../../dist/preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      backgroundThrottling: false
    }
  });

  // The privileged application window must never be navigated to page-controlled
  // content. External links use the validated open-external IPC route instead.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    let trusted = false;
    try {
      const target = new URL(targetUrl);
      if (isDevRenderer) {
        trusted = target.origin === new URL(rendererUrl).origin;
      } else if (target.protocol === 'file:') {
        trusted = path.resolve(fileURLToPath(target)) === rendererFile;
      }
    } catch {
      trusted = false;
    }
    if (!trusted) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());

  if (isDevRenderer) {
    mainWindow.loadURL(rendererUrl);
  } else {
    mainWindow.loadFile(rendererFile);
  }

  attachHud(mainWindow);
  attachPanel(mainWindow);
  mainWindow.on('closed', () => { mainWindow = null; });

  // DevTools is no longer force-opened in dev: the bundled DevTools emits two benign but
  // alarming-looking console errors on every open ("'Autofill.enable' wasn't found" — a CDP
  // domain Electron does not implement), and in Electron 32 they are logged natively, so an
  // app cannot filter them (verified empirically: they never reach webContents
  // 'console-message'). Open DevTools when needed with Ctrl+Shift+I, or set
  // JARVIS_DEVTOOLS=1 to restore the old auto-open behaviour.
  if (!app.isPackaged && process.env.JARVIS_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

app.whenReady().then(() => {
  app.setName('JINI');

  // Round 29 (§1.1): the action-approval service pushes its cards to the renderer through
  // the same single push path every other live surface uses (the HUD window). The renderer
  // can only RESPOND to requests the main process created — it can never mint approvals.
  setApprovalUiPush((view, event, record) => {
    if (event === 'requested' && view) sendToHud('jarvis-approval-request', view);
    else if (event === 'resolved') sendToHud('jarvis-approval-resolved', { id: record?.id, status: record?.status });
    // JINI: paired phones get the same request/resolution (summary only) for remote approval.
    linkApprovalEvent(event, view, record);
  });

  // ROUND 32 (Phase 1 §1.1): the MAIN PROCESS owns the granting decision. The renderer
  // card is informational; its Approve click asks THIS presenter to open the native
  // Electron system confirmation dialog, and only the dialog's own result can grant.
  // Denial, dismissal, timeout, window closure and dialog cancellation never approve.
  setNativeConfirmationPresenter(async (view: ApprovalRequestView, ttlMs: number): Promise<'approved' | 'denied' | 'cancelled'> => {
    const i = view.intent;
    const lines = [
      `Website/application: ${i.origin}`,
      `Destination: ${i.form?.action || i.targetHref || i.pageUrl || i.origin}`,
      `Target: ${i.targetLabel || '(unnamed)'} (${i.targetRole})`,
      `Action: ${i.tool} — ${i.action}`,
      `Consequence: ${i.effect}`,
      i.form ? `Form: ${i.form.method.toUpperCase()} ${i.form.fields} field(s)${i.form.hasPassword ? ' · includes a PASSWORD field' : ''}${i.form.hasPayment ? ' · includes payment fields' : ''}${i.form.crossOrigin ? ' · submits to ANOTHER site' : ''}` : '',
      i.payloadSummary ? `Submits: ${i.payloadSummary}` : '',
      `Scope: this ONE action, once, for ${Math.max(5, Math.round(ttlMs / 1000))}s — bound to this exact page, tab, target and payload.`,
    ].filter(Boolean);
    const opts: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['Approve once', 'Deny', 'Cancel'],
      defaultId: 1,
      cancelId: 2,
      noLink: true,
      title: 'JINI — approval required',
      message: `JINI wants to ${i.action} on ${i.origin}`,
      detail: lines.join('\n'),
    };
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    try {
      const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
      if (response === 0) return 'approved';
      if (response === 1) return 'denied';
      return 'cancelled';
    } catch {
      // A destroyed window or a failed dialog NEVER grants.
      return 'cancelled';
    }
  });

  // ROUND 32 (Phase 3): integration credentials live OUTSIDE the workspace, encrypted
  // with the platform keychain (safeStorage) by the dedicated credential layer.
  setCredentialCipher({
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
  });

  // Round 28 (Phase 2): the native browser's dedicated profile lives OUTSIDE the workspace
  // and the packaged app (never shipped, never synced): Electron's own userData dir.
  setNativeProfileRoot(path.join(app.getPath('userData'), 'native-browser'));

  // Round 21 (CHANGE 3): credential encryption is MAIN-PROCESS ONLY. The embeddings API
  // key is encrypted with Electron safeStorage and decrypted here, never in the renderer;
  // a legacy plaintext key in brain/embeddings.json is migrated once, idempotently, with
  // verify-before-remove. The migration reports its outcome without ever logging the key.
  setEmbeddingsCipher({
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
  });
  void migrateEmbeddingsKeyStorage()
    .then((r) => {
      if (r.status === 'migrated') console.log('[credentials] embeddings API key migrated to safeStorage encryption.');
      else if (r.status === 'encryption-unavailable')
        console.warn('[credentials] safeStorage is unavailable on this system: the embeddings API key stays stored as PLAINTEXT (flagged in the config). It is NOT encrypted.');
      else if (r.status === 'failed') console.error('[credentials] embeddings key migration failed:', r.reason);
    })
    .catch((e) => console.error('[credentials] embeddings key migration error:', e instanceof Error ? e.message : e));

  createWindow();
  startTelemetry();
  void syncAwareness();

  // Interaction modes: the HUD push is the activity feed's sink; the native OS notification
  // is the background-mode end-of-task bell. Clicking it brings JARVIS to the front.
  // The onEvent/onTurn mirrors feed the LIVE TASK PROGRESS tracker — they fire in BOTH
  // modes, because "what is JARVIS doing right now" must answer in real time even when
  // the feed, speech and notifications follow the background-mode silence contract.
  // Round 23: the SAME events feed the invocation ledger (observer composition at this
  // one injection point — there is still exactly one emission path and no second engine);
  // a new conversational turn also opens a fresh activity scope so every follow-up
  // prompt starts with a clean activity context while previous scopes stay queryable.
  void initModes({
    file: path.join(app.getPath('userData'), 'mode.json'),
    sink: (channel, payload) => sendToHud(channel, payload),
    notify: (p) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: p.title, body: p.body });
      n.on('click', () => attentionHud());
      n.show();
    },
    onEvent: (e) => {
      // Ledger FIRST, progress mirror second: the mirror's push serialises the snapshot
      // (including the invocation summary), so it must observe the ledger state that
      // already includes THIS event — otherwise the header summary lags one call behind.
      noteInvocationEvent(e);
      noteActivity(e);
    },
    onTurn: (phase, task, res) => {
      if (phase === 'start') {
        noteTurnStart(task);
        openInvocationTurnScope();
      } else {
        noteTurnEnd(res ?? {});
      }
    },
  });

  // LIVE TASK PROGRESS: one snapshot (now-line, turn checklist, task boards)
  // pushed to the HUD on every change, in both interaction modes. The 10 s keepalive only
  // fires while work is running, so the panel can never silently go stale mid-task.
  initProgress({
    sink: (channel, payload) => sendToHud(channel, payload),
    mode: () => modeInfo().mode,
    keepaliveMs: 10_000,
  });
  // Round 23: the header's tool-activity summary comes from the invocation ledger's
  // incremental aggregates — an O(1) read at snapshot time, correct at any history size.
  setInvocationProvider(() => invocationSummary());
  setTaskProvider(taskViews);
  // Round 25: the HUD's Agents section reads the live agent-execution tracker — the
  // same snapshot push, the same push channel, no second UI pipeline.
  setAgentProvider(agentViews);
  // Round 25 §8: task-specific specialists registered before a restart are restored
  // (TTL-pruned) so resumed work can still name and reuse them.
  void restoreDynamicAgents()
    .then((n) => {
      if (n > 0) console.log(`[agents] restored ${n} dynamic specialist(s) from the persisted roster.`);
    })
    .catch(() => undefined);
  // Every durable-task mutation (transition, step status, note) refreshes the HUD board.
  setTaskChangeNotifier(() => {
    void refreshTasks();
    linkTasksChanged(taskViews);
  });
  onProgress(linkProgress);
  onScreenshot((url) => sendToHud('jini-screenshot', url));
  onChatsChanged(() => {
    sendToHud('chats-changed');
    linkChatsChanged();
  });
  void getNativeConfig().catch(() => undefined); // warms the cache the prompt reads synchronously
  void initDeviceLink();
  void refreshTasks();
  if (!globalShortcut.isRegistered('Control+Alt+B')) {
    globalShortcut.register('Control+Alt+B', () => void setMode(modeInfo().mode === 'background' ? 'interactive' : 'background'));
  }

  // Scheduled follow-ups: a task the user asked for earlier runs as a REAL turn when its
  // time comes. The runner is chat() with no renderer stream — the verdict travels by
  // notification and the session ledger, never by narrating into a window that may be shut.
  // F-13: the source is declared so a due scheduled task NEVER aborts an interactive
  // turn (or another scheduled one) — it queues behind whatever is running.
  registerScheduledRunner((text, opts) => chat(text, () => undefined, undefined, { source: opts.source }));
  startScheduler();

  // R27 §1.5: drain any episodic episodes that were durably queued but not yet recorded
  // (a crash between task completion and memory recording) — recoverable, bounded, honest.
  void processPendingEpisodes().then((r) => {
    if (r.recorded || r.failed) console.log(`[memory] pending-episode recovery: ${r.recorded} recorded, ${r.duplicates} duplicate(s), ${r.failed} failed, ${r.remaining} still pending`);
  });

  // R27 §1.4: the integration health-check executor is the CENTRAL dispatch — a check is
  // a real authorized tool call (guard → permission → receipts), never a side channel.
  // ROUND 29 (§3.3): the failure classification (auth / transient / denied) is derived
  // from the check's own result text and recorded as evidence flags, so the integration
  // state can honestly distinguish "expired credentials", "temporarily unavailable" and
  // "permission denied" instead of lumping them together.
  registerIntegrationExecutor(async (tool, args) => {
    const env = await runToolDetailed(tool, JSON.stringify(args ?? {}));
    const text = env.text.replace(/\s+/g, ' ').trim().slice(0, 200);
    return {
      ok: env.status === 'success' && !/^NOT (CONFIGURED|DONE)/i.test(text),
      detail: text || env.status,
      authRelated: /credential|token|unauthorized|forbidden|401|403|auth/i.test(text),
      transient: /unreachable|temporarily unavailable|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network|HTTP 5\d\d|rate limit/i.test(text),
      denied: /permission denied|forbidden|403|lacks? the required scope|not allowed/i.test(text) && !/unauthorized|401/i.test(text),
    };
  });

  // Task-coordinator watchdog (Module C): a RUNNING durable task whose driver stopped
  // renewing its claim is marked INTERRUPTED (honest, resumable) instead of running forever.
  const stallTimer = setInterval(() => void checkStalls().catch(() => undefined), 60_000);
  app.on('will-quit', () => clearInterval(stallTimer));

  // R27 §6.1/§6.2: event-driven supervision — a slow periodic pass detects MEASURABLE
  // problems (stuck tasks, abandoned occurrences, failed routines, EXPIRED/ERROR
  // integrations, stuck memory outbox) and reports each distinct issue once. No model
  // loop is burned on it; recovery stays in the existing resume/retry pathways.
  const supervisionTimer = setInterval(() => void superviseOperations(), 5 * 60_000);
  void superviseOperations();
  app.on('will-quit', () => clearInterval(supervisionTimer));

  // Round 22 (Project Autopilot): restart reconciliation recomputes every project from
  // the DURABLE task records (never from cached state), then the project scheduler
  // ticker runs — it only dispatches through the coordinator's own capacity gate.
  void reconcileOnStartup()
    .then((r) => {
      if (r.projects) console.log(`[projects] reconciled ${r.projects} project(s): ${r.recompleted} re-verified complete, ${r.interrupted} interrupted (explicit resume), ${r.blocked} policy-blocked, ${r.completed} completed`);
    })
    .catch((e) => console.error('[projects] startup reconciliation failed:', e instanceof Error ? e.message : e));
  startAutopilotTicker();
  app.on('will-quit', stopAutopilotTicker);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.handle('get-app-version', () => app.getVersion());
// Only web links may be handed to the OS shell; anything else (file:, ms-msdt:, ...) can execute code.
ipcMain.handle('open-external', (_, url: string) => {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https URLs are allowed.');
  return shell.openExternal(u.toString());
});
// ROUND 29 (§1.3): the unvalidated generic `store-get`/`store-set` bridge was REMOVED.
// It had no renderer consumers left, and it let a compromised renderer read or overwrite
// ARBITRARY electron-store keys (provider config included) — an unneeded, unvalidated
// surface. Durable renderer-relevant state goes through the validated, purpose-built
// channels below (settings, ops, projects, native-browser, approvals).

ipcMain.handle('settings-get', () => getPublicSettings());
ipcMain.handle('settings-set', (_, patch: { baseUrl?: string; apiKey?: string; groqKey?: string; tinyfishKey?: string; model?: string; fallbackModels?: string[]; voice?: string; awareness?: boolean }) =>
  setSettings(patch).then(() => (patch.awareness !== undefined ? syncAwareness() : undefined))
);
// Streaming to a closed window must never throw: the turn may outlive the window.
ipcMain.handle('ai-chat', (event, text: string) => {
  const deliver = (channel: string, payload: string): void => {
    if (!event.sender.isDestroyed()) event.sender.send(channel, payload);
  };
  return chat(text, (delta) => deliver('ai-delta', delta), (note) => deliver('ai-progress', note));
});
ipcMain.handle('ai-models', () => listModels());
ipcMain.handle('ai-cancel', () => { stopEverything(); });
ipcMain.handle('tts-synthesize', (_, text: string) => {
  const s = typeof text === 'string' ? text : '';
  if (!s.trim()) throw new Error('Nothing to speak.');
  if (s.length > 4000) throw new Error('Text is too long to speak.');
  return synthesize(s);
});
ipcMain.handle('stt-load', (event) =>
  loadStt((pct) => {
    if (!event.sender.isDestroyed()) event.sender.send('stt-progress', pct);
  })
);
ipcMain.handle('stt-transcribe', (_, audio: Float32Array) => {
  // Unvalidated audio used to become an empty recording (no error, empty transcript) or a huge WAV allocation.
  if (!(audio instanceof Float32Array)) throw new Error('Audio must be a Float32Array.');
  if (!Number.isFinite(audio.length) || audio.length < 480) throw new Error('Recording is empty or too short.');
  if (audio.length > 4_800_000) throw new Error('Recording is too long (over 5 minutes).');
  return transcribeStt(audio);
});
app.on('will-quit', stopStt);
app.on('will-quit', stopScheduler);
ipcMain.handle('hud-set-mini', (_, on: boolean) => setMini(Boolean(on)));
ipcMain.handle('mode-get', () => modeInfo());
// Live task progress for late subscribers (a freshly (re)loaded HUD pulls the current
// snapshot instead of waiting for the next event); the provider refreshes first so a
// snapshot taken right after boot already shows any durable task that exists on disk.
ipcMain.handle('progress-get', async () => {
  await refreshTasks();
  return getProgressSnapshot();
});
// Re-validated here: a compromised renderer must not reach the engine with garbage.
ipcMain.handle('mode-set', (_, m: unknown) => {
  if (m !== 'interactive' && m !== 'background') throw new Error('Unknown mode.');
  return setMode(m);
});
ipcMain.handle('telemetry-get', () => latestTelemetry());
// ------------------------------------------------------- Round 23: Activity query API
// Read-only observers over the invocation ledger. Inputs re-validated like every other
// handler (a compromised renderer must not reach the ledger with garbage); the records
// themselves carry only the clipped summaries the feed already shows — never raw args.
ipcMain.handle('activity-summary', (_, scope: unknown) => invocationSummary(typeof scope === 'string' && scope ? scope.slice(0, 80) : undefined));
ipcMain.handle('activity-scopes', () => invocationScopes());
ipcMain.handle('activity-query', (_, opts: unknown) => {
  const o = (typeof opts === 'object' && opts) as Record<string, unknown> | null;
  return queryInvocations({
    scope: typeof o?.scope === 'string' ? o.scope.slice(0, 80) : undefined,
    offset: typeof o?.offset === 'number' ? o.offset : 0,
    limit: typeof o?.limit === 'number' ? o.limit : 100,
  });
});
// Conversations panel: the full-fidelity, durable record of every turn (history.ts).
// Read-only: the renderer can list history, never write or mutate it.
ipcMain.handle('history-list', () => listConversations());
ipcMain.handle('chats-list', async () => ({ active: await getActiveChatId(), chats: await listChats() }));
ipcMain.handle('chats-turns', (_, id: unknown) => chatTurns(strArg(id, 80)));
ipcMain.handle('chats-create', () => createChat());
ipcMain.handle('chats-select', (_, id: unknown) => setActiveChat(strArg(id, 80)));
ipcMain.handle('chats-rename', (_, id: unknown, title: unknown) => renameChat(strArg(id, 80), strArg(title, 200)));
ipcMain.handle('chats-delete', (_, id: unknown) => deleteChat(strArg(id, 80)));

// -------------------------------------------------------------- Project Autopilot IPC
// Every handler re-validates its inputs (a compromised renderer must not reach the
// engine with garbage) and calls a REAL backend operation. No decorative channel exists.
const strArg = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '');

ipcMain.handle('projects-list', (_, opts: unknown) => {
  const o = (typeof opts === 'object' && opts) as Record<string, unknown> | null;
  return listProjectViews({
    offset: typeof o?.offset === 'number' ? o.offset : 0,
    limit: typeof o?.limit === 'number' ? o.limit : 12,
    query: strArg(o?.query, 200),
    status: strArg(o?.status, 20) as never,
  });
});
ipcMain.handle('projects-get', (_, id: unknown) => projectDetailView(strArg(id, 80)));
ipcMain.handle('projects-create', (_, description: unknown, templateId: unknown) => {
  const d = strArg(description, 8000);
  if (!d.trim()) throw new Error('A project needs a description.');
  return createProjectFromDescription(d, { templateId: strArg(templateId, 60) || undefined });
});
ipcMain.handle('projects-create-template', (_, templateId: unknown, description: unknown) =>
  createProjectFromTemplate(strArg(templateId, 60), strArg(description, 8000) || undefined)
);
ipcMain.handle('projects-templates', () => ({ templates: PROJECT_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, category: t.category, complexity: t.complexity })), list: templateList() }));
ipcMain.handle('projects-execute', (_, id: unknown) => executeProject(strArg(id, 80)));
ipcMain.handle('projects-pause', (_, id: unknown) => pauseProject(strArg(id, 80)));
ipcMain.handle('projects-resume', (_, id: unknown) => resumeProject(strArg(id, 80)));
ipcMain.handle('projects-cancel', (_, id: unknown) => cancelProject(strArg(id, 80)));
ipcMain.handle('projects-replan', (_, id: unknown, note: unknown) => {
  const r = replanProject(strArg(id, 80), strArg(note, 300) || 'user replan from the UI', { userTriggered: true });
  return r.then((x) => (x.ok ? `Replanned to plan v${x.version}; completed work preserved.` : `NOT DONE: ${x.reason}`));
});
ipcMain.handle('projects-update-requirements', (_, id: unknown, patch: unknown) => {
  const p = (typeof patch === 'object' && patch) as { add?: unknown; remove?: unknown; note?: unknown } | null;
  return updateRequirements(strArg(id, 80), {
    add: Array.isArray(p?.add) ? (p!.add as unknown[]).map((x) => strArg(x, 200)).filter(Boolean) : [],
    remove: Array.isArray(p?.remove) ? (p!.remove as unknown[]).map((x) => strArg(x, 200)).filter(Boolean) : [],
    note: strArg(p?.note, 300) || undefined,
  });
});
app.on('will-quit', stopTelemetry);
app.on('will-quit', stopAwareness);
ipcMain.handle('hud-get-mini', () => isMini());
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('will-quit', () => void shutdownNativeBrowser());

// ------------------------------------------------------------------ R27 §1.3: Operations Center
// Every handler is a projection of EXISTING durable state (opsCenter.ts owns no state);
// every control goes through the SAME authorized tool path the agent uses.
ipcMain.handle('ops-overview', () => opsOverview());
ipcMain.handle('ops-task', (_, id: unknown) => opsTaskDetail(strArg(id, 80)));
ipcMain.handle('ops-task-action', (_, id: unknown, action: unknown) => opsTaskAction(strArg(id, 80), strArg(action, 12) as OpsTaskAction));
ipcMain.handle('ops-routine-action', (_, id: unknown, action: unknown) => opsRoutineAction(strArg(id, 80), strArg(action, 12) as OpsRoutineAction));

// ---------------------------------------------------- Round 28 Phase 2: Native Browser
// Every handler re-validates its inputs and calls a REAL native-browser operation; the
// connect/disconnect handlers are explicit user actions (the same decision the agent's
// native_browser_connect tool records). No credential or cookie data ever crosses IPC.
ipcMain.handle('native-browser-status', () => nativeBrowserStatusView());
ipcMain.handle('native-browser-discover', () => discoverInstalledBrowsers());
ipcMain.handle('native-browser-connect', async (_, opts: unknown) => {
  const o = (typeof opts === 'object' && opts) as { browser?: unknown; mode?: unknown; port?: unknown } | null;
  const mode: NativeMode | undefined = o?.mode === 'A' ? 'A' : o?.mode === 'B' ? 'B' : undefined;
  return connectNativeBrowser({
    browser: typeof o?.browser === 'string' && o.browser.trim() ? o.browser.trim().slice(0, 200) : undefined,
    mode,
    port: typeof o?.port === 'number' && Number.isFinite(o.port) ? Math.floor(o.port) : undefined,
    authorizedBy: 'ui',
  });
});
ipcMain.handle('native-browser-disconnect', (_, opts: unknown) => {
  const o = (typeof opts === 'object' && opts) as { closeBrowser?: unknown } | null;
  return disconnectNativeBrowser({ closeBrowser: typeof o?.closeBrowser === 'boolean' ? o.closeBrowser : undefined });
});
ipcMain.handle('native-browser-reconnect', () => reconnectNativeBrowser('explicit reconnect from the JARVIS UI'));
ipcMain.handle('native-browser-set-config', async (_, patch: unknown) => {
  const p = (typeof patch === 'object' && patch) as Record<string, unknown> | null;
  if (!p) throw new Error('config patch required.');
  return setNativeConfig({
    selectedBrowser: typeof p.selectedBrowser === 'string' ? p.selectedBrowser.slice(0, 300) : undefined,
    mode: p.mode === 'A' ? 'A' : p.mode === 'B' ? 'B' : undefined,
    attachPort: typeof p.attachPort === 'number' && Number.isFinite(p.attachPort) ? Math.max(0, Math.floor(p.attachPort)) : undefined,
    visibility: p.visibility === 'minimized' || p.visibility === 'normal' ? p.visibility : undefined,
    autoReconnect: typeof p.autoReconnect === 'boolean' ? p.autoReconnect : undefined,
    keepOpenOnQuit: typeof p.keepOpenOnQuit === 'boolean' ? p.keepOpenOnQuit : undefined,
    defaultBrowser: p.defaultBrowser === 'native' || p.defaultBrowser === 'panel' ? p.defaultBrowser : undefined,
  });
});
ipcMain.handle('ops-recovery-status', () => recoveryStatus());
ipcMain.handle('ops-recovery-run', (_, about: unknown) => runRecoveryFor(strArg(about, 120)));
ipcMain.handle('ops-recovery-settings', (_, patch: unknown) => {
  const p = (typeof patch === 'object' && patch) as { autoRecovery?: unknown; maxActionsPerHour?: unknown } | null;
  return setRecoverySettings({
    autoRecovery: typeof p?.autoRecovery === 'boolean' ? p.autoRecovery : undefined,
    maxActionsPerHour: typeof p?.maxActionsPerHour === 'number' ? Math.floor(p.maxActionsPerHour) : undefined,
  });
});
ipcMain.handle('native-browser-activate-tab', (_, tabId: unknown) => {
  const id = strArg(tabId, 80);
  if (!id) throw new Error('tabId required.');
  return activateNativeTab(id).then(() => 'activated');
});

// --------------------------------------------------- Round 29 §1.1: user action approvals
// The renderer can ONLY respond to (or dismiss) approval requests the MAIN PROCESS created
// and pushed. It cannot mint, extend, replay or forge an approval — every state transition
// lives in approval.ts, and the tool pathway re-validates the approval's fingerprint
// against the exact action before anything consequential runs.
// ROUND 31 (Phase 0 audit hardening): the responding sender must be one of THIS app's own
// windows — a foreign webContents (an embedded iframe from another source that gained a
// channel, or an unexpected window) is refused before its answer is even considered. The
// approval state machine itself stays the only authority; this narrows WHO may answer.
/**
 * ROUND 32 (Phase 1 §1.3) — STRICT sender and frame validation for the approval channels.
 * ROUND 33 (Phase 3 §3.1/§3.2) — the checks now live in ONE shared module (ipcTrust.ts)
 * used by BOTH the approval and the credential channels, and are FAIL-CLOSED: a missing
 * senderFrame, an exception while inspecting the frame, an unidentifiable frame or a
 * frame without a verifiable URL REFUSES instead of passing (the Round 32 fail-open
 * defaults are gone). Child frames, foreign origins and unexpected windows are refused
 * BEFORE the approval service or the credential store ever sees the message.
 * ROUND 34 (Phase 5) — the expected renderer is the EXACT trusted resource: packaged mode
 * pins the bundled renderer entry (the same path loadFile uses — not "any file:// URL");
 * development mode pins the configured dev server (not any localhost port). Refusals are
 * counted for the Operations Center (real state, Phase 6).
 */
// The bundled renderer entry — the SAME path createWindow()'s loadFile uses, so the IPC
// trust decision and the window's actual resource can never drift apart.
const RENDERER_ENTRY_PATH = path.join(__dirname, '../../dist/renderer/index.html');
const TRUSTED_RENDERER: TrustedRendererSpec = expectedRendererSpec({
  isPackaged: app.isPackaged,
  nodeEnv: process.env.NODE_ENV,
  rendererEntryPath: RENDERER_ENTRY_PATH,
});
// ONE trust authority records the exact resource it validates against (Phase 6 projection).
setTrustedRendererSpec(TRUSTED_RENDERER);
const assertTrustedApprovalSender = (e: Electron.IpcMainInvokeEvent, what: string): void => {
  const trusted = senderIsTrustedAppFrame(
    { sender: e.sender, senderFrame: (e as unknown as { senderFrame?: { parent?: unknown; url?: string } | null }).senderFrame ?? null },
    { windows: BrowserWindow.getAllWindows(), expected: TRUSTED_RENDERER }
  );
  if (!trusted) {
    // ROUND 34 (Phase 6): the refusal is COUNTED at the real site — visible in the Ops Center.
    noteIpcTrustRefusal(`${what} — sender failed the trusted-renderer validation (${TRUSTED_RENDERER.kind} mode)`);
    throw new Error(`${what} are only accepted from a main frame of this application's own window, loaded from its own trusted renderer resource.`);
  }
};
registerDeviceIpc(assertTrustedApprovalSender);
ipcMain.handle('approval-list', (event) => {
  // ROUND 34 (§5.3): the SAME trusted-renderer validation protects the approval LISTING
  // too — one trust implementation, every sensitive channel.
  assertTrustedApprovalSender(event, 'approval listings');
  return pendingApprovalViews();
});
ipcMain.handle('approval-respond', (event, id: unknown, decision: unknown) => {
  assertTrustedApprovalSender(event, 'approval decisions');
  const rid = strArg(id, 60);
  if (!rid) throw new Error('approval request id required.');
  if (decision !== 'approve' && decision !== 'deny') throw new Error('decision must be "approve" or "deny".');
  return respondApproval(rid, decision);
});
ipcMain.handle('approval-dismiss', (event, id: unknown) => {
  assertTrustedApprovalSender(event, 'approval dismissals');
  const rid = strArg(id, 60);
  if (!rid) throw new Error('approval request id required.');
  return dismissApproval(rid);
});

// ------------------------------------------------ ROUND 32 Phase 3: integration credentials
// Save/replace/test/revoke operations for GitHub and Vercel credentials. The renderer
// receives PRESENCE metadata only — never a stored secret, never a decrypted value.
// ROUND 33 (Phase 3 §3.2): every credential channel now applies the SAME strict sender/
// main-frame/origin validation as the approval channels (ipcTrust.ts — fail-closed).
// Input sizes and service identifiers are validated before the store is touched; decrypted
// credentials and ciphertext never cross to the renderer.
ipcMain.handle('credentials-info', (event) => {
  assertTrustedApprovalSender(event, 'credential information requests');
  return credentialInfoIpc();
});
ipcMain.handle('credentials-set', (event, service: unknown, secret: unknown) => {
  assertTrustedApprovalSender(event, 'credential saves');
  const svc = strArg(service, 20);
  const sec = strArg(secret, 400);
  if (!svc) throw new Error('credential service identifier required (max 20 chars).');
  if (!sec) throw new Error('credential value required (max 400 chars).');
  return credentialSetIpc(svc, sec);
});
ipcMain.handle('credentials-test', (event, service: unknown) => {
  assertTrustedApprovalSender(event, 'credential tests');
  const svc = strArg(service, 20);
  if (!svc) throw new Error('credential service identifier required (max 20 chars).');
  return credentialTestIpc(svc);
});
ipcMain.handle('credentials-revoke', (event, service: unknown) => {
  assertTrustedApprovalSender(event, 'credential revocations');
  const svc = strArg(service, 20);
  if (!svc) throw new Error('credential service identifier required (max 20 chars).');
  return credentialRevokeIpc(svc);
});
