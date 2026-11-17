/**
 * Electron glue for the JINI device link: owns the single DeviceHub, starts it if the user
 * enabled phone connections, forwards desktop events (approvals, task changes) to paired
 * phones, and registers the Devices panel IPC behind the trusted-renderer gate.
 */
import { app, ipcMain, Notification, safeStorage } from 'electron';
import * as os from 'os';
import * as path from 'path';
import { DeviceHub, type Cipher } from './deviceHub';
import { buildDeviceOps } from './deviceOps';
import type { ApprovalRequestView } from '../approval';
import type { ProgressSnapshot, TaskProgressView } from '../progressTypes';

let hub: DeviceHub | null = null;

const cipher: Cipher = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (stored) => safeStorage.decryptString(Buffer.from(stored, 'base64')),
};

export function deviceHub(): DeviceHub {
  if (!hub) {
    hub = new DeviceHub({
      dataDir: path.join(app.getPath('userData'), 'jini-link'),
      desktopName: `JINI on ${os.hostname()}`.slice(0, 60),
      cipher,
      ops: buildDeviceOps(() => deviceHub()),
      onSecurityEvent: (message) => {
        if (Notification.isSupported()) new Notification({ title: 'JINI devices', body: message }).show();
      },
    });
  }
  return hub;
}

export async function initDeviceLink(): Promise<void> {
  try {
    await deviceHub().startIfEnabled();
  } catch (e) {
    console.error('[jini-link] could not start:', e instanceof Error ? e.message : e);
  }
  app.on('will-quit', () => {
    void hub?.saveNow();
    void hub?.stop();
  });
}

/** Forward an approval request / resolution to paired phones (no secrets: the intent summary only). */
export function linkApprovalEvent(event: 'requested' | 'resolved', view: ApprovalRequestView | null, record?: { id?: string; status?: string }): void {
  if (!hub) return;
  if (event === 'requested' && view) {
    const i = view.intent;
    hub.append('approval', {
      id: view.id,
      tool: i.tool,
      action: i.action,
      origin: i.origin,
      target: i.targetLabel,
      effect: i.effect,
      expiresAt: view.requestExpiresAt,
    });
  } else if (event === 'resolved' && record?.id) {
    hub.append('approval-resolved', { id: record.id, status: record.status ?? '' });
  }
}

let taskTimer: NodeJS.Timeout | null = null;
/** Task boards change often: coalesce bursts into one 'tasks' event (≤ 250 ms behind). */
export function linkTasksChanged(views: () => Promise<TaskProgressView[]>): void {
  if (!hub || taskTimer) return;
  taskTimer = setTimeout(() => {
    taskTimer = null;
    void views()
      .then((v) =>
        hub?.replaceLatest('tasks', {
          tasks: v.slice(0, 30).map((t) => ({
            id: t.id,
            objective: t.objective.slice(0, 300),
            status: t.status,
            note: t.note.slice(0, 300),
            done: t.done,
            total: t.total,
            updatedAt: t.updatedAt,
            // Step titles + states drive the phone's live activity row.
            steps: t.steps.slice(0, 22).map((s) => ({ title: s.title.slice(0, 120), status: s.status })),
          })),
        })
      )
      .catch(() => undefined);
  }, 250);
}

/** Devices panel IPC — every channel goes through the caller's trusted-renderer assertion. */
export function registerDeviceIpc(assertTrusted: (e: Electron.IpcMainInvokeEvent, what: string) => void): void {
  ipcMain.handle('devices-status', async (e) => {
    assertTrusted(e, 'device link status requests');
    await deviceHub().load();
    return { status: deviceHub().status(), devices: deviceHub().listDevices() };
  });
  ipcMain.handle('devices-enable', async (e, on: unknown) => {
    assertTrusted(e, 'device link changes');
    return deviceHub().setEnabled(on === true);
  });
  ipcMain.handle('devices-pair-start', (e) => {
    assertTrusted(e, 'pairing requests');
    return deviceHub().startPairing();
  });
  ipcMain.handle('devices-pair-cancel', (e) => {
    assertTrusted(e, 'pairing requests');
    deviceHub().cancelPairing();
  });
  ipcMain.handle('devices-revoke', (e, id: unknown) => {
    assertTrusted(e, 'device revocations');
    if (typeof id !== 'string' || id.length > 40) throw new Error('device id required');
    return deviceHub().revokeDevice(id);
  });
  ipcMain.handle('devices-forget', (e, id: unknown) => {
    assertTrusted(e, 'device removals');
    if (typeof id !== 'string' || id.length > 40) throw new Error('device id required');
    return deviceHub().forgetDevice(id);
  });
}

let progressTimer: NodeJS.Timeout | null = null;
let pendingProgress: ProgressSnapshot | null = null;
/** Mirror the HUD's live progress snapshot (same source) to the phone, ≤ 4 updates/s. */
export function linkProgress(snap: ProgressSnapshot): void {
  if (!hub) return;
  pendingProgress = snap;
  if (progressTimer) return;
  progressTimer = setTimeout(() => {
    progressTimer = null;
    const p = pendingProgress;
    pendingProgress = null;
    if (!p || !hub) return;
    hub.replaceLatest('progress', {
      busy: p.busy,
      now: p.now ? { label: p.now.label.slice(0, 160), status: p.now.status } : null,
      turn: p.turn
        ? {
            task: p.turn.task,
            startedAt: p.turn.startedAt,
            endedAt: p.turn.endedAt ?? null,
            outcome: p.turn.outcome,
            done: p.turn.done,
            failed: p.turn.failed,
            calls: p.turn.calls,
            steps: p.turn.steps.slice(-14).map((s) => ({ label: s.label.slice(0, 120), status: s.status })),
          }
        : null,
      agents: (p.agents ?? []).slice(0, 8).map((a) => ({ name: a.agent.slice(0, 60), status: a.status })),
    });
  }, 250);
}
