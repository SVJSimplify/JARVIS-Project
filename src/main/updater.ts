import { app, BrowserWindow, ipcMain } from 'electron';
import { createHash } from 'node:crypto';
import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { compareDesktopVersions } from './updateVersion';

const RELEASE_API = 'https://api.github.com/repos/SVJSimplify/JARVIS-Project/releases/tags/desktop-latest';
const RELEASE_ASSET_PREFIX = 'https://github.com/SVJSimplify/JARVIS-Project/releases/download/desktop-latest/';
const INSTALLER_NAME = 'JINI-Desktop-Setup.exe';

export interface DesktopUpdateStatus {
  state: 'disabled' | 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'installing' | 'error';
  currentVersion: string;
  availableVersion?: string;
  progress?: number;
  message?: string;
  releaseNotes?: string;
}

interface UpdateManifest {
  version: string;
  sha256: string;
  assetName: typeof INSTALLER_NAME;
  releaseNotes?: string;
}
interface ReleaseAsset { name?: string; browser_download_url?: string }

let status: DesktopUpdateStatus = { state: 'idle', currentVersion: app.getVersion() };
let manifest: UpdateManifest | null = null;
let installerUrl: string | null = null;
let downloadedInstaller: string | null = null;
let initialized = false;
let checkInFlight: Promise<DesktopUpdateStatus> | null = null;
let downloadInFlight: Promise<DesktopUpdateStatus> | null = null;

function publish(next: DesktopUpdateStatus): DesktopUpdateStatus {
  status = next;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('updates:status', status);
  }
  return status;
}

async function readRelease(): Promise<{ nextManifest: UpdateManifest; url: string }> {
  const releaseResponse = await fetch(RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'JINI-Desktop-Updater' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!releaseResponse.ok) throw new Error(`Release lookup failed (HTTP ${releaseResponse.status}).`);
  const release = await releaseResponse.json() as { assets?: ReleaseAsset[] };
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const manifestAsset = assets.find((asset) => asset.name === 'latest.json');
  const installerAsset = assets.find((asset) => asset.name === INSTALLER_NAME);
  const manifestUrl = manifestAsset?.browser_download_url;
  const url = installerAsset?.browser_download_url;
  if (!manifestUrl || !url || !url.startsWith(RELEASE_ASSET_PREFIX)) {
    throw new Error('The latest desktop release is missing its installer or update manifest.');
  }
  const manifestResponse = await fetch(manifestUrl, { headers: { 'User-Agent': 'JINI-Desktop-Updater' }, signal: AbortSignal.timeout(20_000) });
  if (!manifestResponse.ok) throw new Error(`Update manifest download failed (HTTP ${manifestResponse.status}).`);
  const raw = await manifestResponse.json() as Partial<UpdateManifest>;
  if (typeof raw.version !== 'string' || !versionParts(raw.version) ||
      typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(raw.sha256) ||
      raw.assetName !== INSTALLER_NAME) {
    throw new Error('The latest desktop release contains an invalid update manifest.');
  }
  return {
    nextManifest: {
      version: raw.version,
      sha256: raw.sha256.toLowerCase(),
      assetName: INSTALLER_NAME,
      releaseNotes: typeof raw.releaseNotes === 'string' ? raw.releaseNotes.slice(0, 2000) : undefined,
    },
    url,
  };
}

async function checkForUpdates(): Promise<DesktopUpdateStatus> {
  if (!app.isPackaged || process.platform !== 'win32') {
    return publish({ state: 'disabled', currentVersion: app.getVersion(), message: 'Automatic installation is currently available for packaged Windows builds.' });
  }
  if (checkInFlight) return checkInFlight;
  checkInFlight = (async () => {
    publish({ state: 'checking', currentVersion: app.getVersion(), message: 'Checking the JINI desktop release channel…' });
    try {
      const latest = await readRelease();
      manifest = latest.nextManifest;
      installerUrl = latest.url;
      if (compareDesktopVersions(manifest.version, app.getVersion()) <= 0) {
        downloadedInstaller = null;
        return publish({ state: 'not-available', currentVersion: app.getVersion(), availableVersion: manifest.version, message: 'You are running the latest desktop version.' });
      }
      return publish({ state: 'available', currentVersion: app.getVersion(), availableVersion: manifest.version, releaseNotes: manifest.releaseNotes, message: 'A newer desktop build is ready to download.' });
    } catch (error) {
      return publish({ state: 'error', currentVersion: app.getVersion(), message: error instanceof Error ? error.message : 'Could not check for updates.' });
    } finally {
      checkInFlight = null;
    }
  })();
  return checkInFlight;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function downloadUpdate(): Promise<DesktopUpdateStatus> {
  if (!app.isPackaged || process.platform !== 'win32') {
    return publish({ state: 'disabled', currentVersion: app.getVersion(), message: 'Updates can only be installed from the packaged Windows desktop app.' });
  }
  if (downloadInFlight) return downloadInFlight;
  downloadInFlight = (async () => {
    try {
      if (!manifest || !installerUrl || compareDesktopVersions(manifest.version, app.getVersion()) <= 0) await checkForUpdates();
      if (!manifest || !installerUrl || status.state !== 'available') return status;
      const response = await fetch(installerUrl, { headers: { 'User-Agent': 'JINI-Desktop-Updater' }, signal: AbortSignal.timeout(10 * 60_000) });
      if (!response.ok || !response.body) throw new Error(`Installer download failed (HTTP ${response.status}).`);
      const tempDir = path.join(app.getPath('temp'), 'JINI-updates');
      await mkdir(tempDir, { recursive: true });
      const target = path.join(tempDir, `JINI-Update-${manifest.version}.exe`);
      await rm(target, { force: true });
      const total = Number(response.headers.get('content-length')) || 0;
      let received = 0;
      publish({ state: 'downloading', currentVersion: app.getVersion(), availableVersion: manifest.version, progress: 0, message: 'Downloading the verified desktop installer…' });
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          publish({
            state: 'downloading',
            currentVersion: app.getVersion(),
            availableVersion: manifest?.version,
            progress: total > 0 ? Math.min(99, (received / total) * 100) : 0,
            message: total > 0 ? `Downloaded ${Math.round(received / total * 100)}%…` : 'Downloading update…',
          });
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), meter, createWriteStream(target));
      if (await sha256File(target) !== manifest.sha256) {
        await rm(target, { force: true });
        throw new Error('Update verification failed: installer checksum does not match the release manifest.');
      }
      downloadedInstaller = target;
      return publish({ state: 'downloaded', currentVersion: app.getVersion(), availableVersion: manifest.version, progress: 100, message: 'Update downloaded and verified. Restart JINI to install it.' });
    } catch (error) {
      return publish({ state: 'error', currentVersion: app.getVersion(), availableVersion: manifest?.version, message: error instanceof Error ? error.message : 'Update download failed.' });
    } finally {
      downloadInFlight = null;
    }
  })();
  return downloadInFlight;
}

async function installDownloadedUpdate(): Promise<void> {
  if (process.platform !== 'win32' || !downloadedInstaller || !manifest) throw new Error('There is no verified desktop update ready to install.');
  const installDirectory = path.dirname(app.getPath('exe'));
  publish({ state: 'installing', currentVersion: app.getVersion(), availableVersion: manifest.version, message: 'Launching the installer. JINI will close to complete installation.' });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(downloadedInstaller as string, ['/S', `/D=${installDirectory}`], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  app.quit();
}

export function initializeUpdateService(): void {
  if (initialized) return;
  initialized = true;
  ipcMain.handle('updates:get', () => status);
  ipcMain.handle('updates:check', () => checkForUpdates());
  ipcMain.handle('updates:download', () => downloadUpdate());
  ipcMain.handle('updates:install', () => installDownloadedUpdate());
  if (!app.isPackaged || process.platform !== 'win32') {
    publish({ state: 'disabled', currentVersion: app.getVersion(), message: 'Automatic installation is currently available for packaged Windows builds.' });
    return;
  }
  const startupCheck = setTimeout(() => { void checkForUpdates(); }, 8_000);
  startupCheck.unref();
  const periodicCheck = setInterval(() => { void checkForUpdates(); }, 6 * 60 * 60 * 1000);
  periodicCheck.unref();
}
