import { app, BrowserWindow, globalShortcut, ipcMain, Notification, shell } from 'electron';
import * as path from 'path';
import type { default as Store } from 'electron-store' with { 'resolution-mode': 'import' };
import { cancelChat, chat, listModels } from './provider';
import { answerConfirm } from './guard';
import { getPublicSettings, setSettings } from './settings';
import { synthesize } from './tts';
import { attachPanel } from './panel';
import { attachHud, attentionHud, isMini, sendToHud, setMini } from './hud';
import { initModes, modeInfo, setMode } from './modes';
import { loadStt, stopStt, transcribeStt } from './stt';
import { stopAwareness, syncAwareness } from './awareness';
import { latestTelemetry, startTelemetry, stopTelemetry } from './telemetry';
import { registerScheduledRunner, startScheduler, stopScheduler } from './scheduler';
import { recoverInterruptedJobs } from './longHorizon';

let store: Store | undefined;
const initStore = async (): Promise<Store> => {
  if (!store) {
    const S = (await import('electron-store')).default;
    store = new S();
  }
  return store;
};
// Failures must be observable, never silent: log them with the component that owns them.
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

let mainWindow: BrowserWindow | null = null;

function createWindow() {
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
      sandbox: false,
      backgroundThrottling: false
    }
  });

  if (app.isPackaged || process.env.NODE_ENV === 'production') {
    mainWindow.loadFile(path.join(__dirname, '../../dist/renderer/index.html'));
  } else {
    mainWindow.loadURL('http://localhost:5173');
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
  app.setName('JARVIS');
  createWindow();
  startTelemetry();
  void syncAwareness();

  // Interaction modes: the HUD push is the activity feed's sink; the native OS notification
  // is the background-mode end-of-task bell. Clicking it brings JARVIS to the front.
  void initModes({
    file: path.join(app.getPath('userData'), 'mode.json'),
    sink: (channel, payload) => sendToHud(channel, payload),
    notify: (p) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: p.title, body: p.body });
      n.on('click', () => attentionHud());
      n.show();
    },
  });
  if (!globalShortcut.isRegistered('Control+Alt+B')) {
    globalShortcut.register('Control+Alt+B', () => void setMode(modeInfo().mode === 'background' ? 'interactive' : 'background'));
  }

  // Scheduled follow-ups: a task the user asked for earlier runs as a REAL turn when its
  // time comes. The runner is chat() with no renderer stream — the verdict travels by
  // notification and the session ledger, never by narrating into a window that may be shut.
  registerScheduledRunner((text) => chat(text, () => undefined));
  startScheduler();
  void recoverInterruptedJobs().catch(() => undefined);

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
ipcMain.handle('store-get', async (_, key: string) => {
  const s = await initStore();
  return s.get(key);
});
ipcMain.handle('store-set', async (_, key: string, value: unknown) => {
  const s = await initStore();
  s.set(key, value);
});

ipcMain.handle('settings-get', () => getPublicSettings());
ipcMain.handle('settings-set', (_, patch: { apiKey?: string; groqKey?: string; tinyfishKey?: string; model?: string; voice?: string; awareness?: boolean }) =>
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
ipcMain.handle('ai-cancel', () => cancelChat());
ipcMain.handle('confirm-reply', (_e, id: number, ok: boolean) => answerConfirm(Number(id), ok === true));
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
// Re-validated here: a compromised renderer must not reach the engine with garbage.
ipcMain.handle('mode-set', (_, m: unknown) => {
  if (m !== 'interactive' && m !== 'background') throw new Error('Unknown mode.');
  return setMode(m);
});
ipcMain.handle('telemetry-get', () => latestTelemetry());
app.on('will-quit', stopTelemetry);
app.on('will-quit', stopAwareness);
ipcMain.handle('hud-get-mini', () => isMini());
app.on('will-quit', () => globalShortcut.unregisterAll());
