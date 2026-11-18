/**
 * Remote access: a Cloudflare "quick tunnel" (no account) that forwards a public https URL to the
 * local link server, so the phone can reach the desktop from any network, including mobile data.
 * The link is end-to-end encrypted and authenticated by its own protocol, so the tunnel only
 * carries ciphertext. cloudflared is downloaded once into the app's data folder.
 */
import { spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';

const ASSET: Record<string, string> = { win32: 'cloudflared-windows-amd64.exe', linux: 'cloudflared-linux-amd64' };
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

let child: ChildProcess | null = null;
let wanted = false;
let backoff = 3000;

async function ensureBinary(dir: string): Promise<string> {
  const asset = ASSET[process.platform];
  if (!asset) throw new Error('Remote access is not supported on this platform yet.');
  const file = path.join(dir, asset);
  try {
    if ((await fs.stat(file)).size > 1_000_000) return file;
  } catch {
    /* not downloaded yet */
  }
  const res = await fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`);
  if (!res.ok) throw new Error(`Could not download the tunnel helper (HTTP ${res.status}).`);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${file}.part`;
  await fs.writeFile(tmp, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
  await fs.rename(tmp, file);
  return file;
}

/** Start (or keep alive) the tunnel; `onUrl` fires with the public URL, or '' when it drops. */
export function startTunnel(port: number, dir: string, onUrl: (url: string) => void, onError: (msg: string) => void): void {
  if (wanted) return;
  wanted = true;
  const run = async (): Promise<void> => {
    if (!wanted) return;
    try {
      const bin = await ensureBinary(dir);
      const p = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { windowsHide: true });
      child = p;
      const scan = (b: Buffer): void => {
        const m = URL_RE.exec(b.toString());
        if (m) {
          backoff = 3000;
          onUrl(m[0]);
        }
      };
      p.stdout.on('data', scan);
      p.stderr.on('data', scan);
      p.on('exit', () => {
        child = null;
        onUrl('');
        if (wanted) setTimeout(() => void run(), (backoff = Math.min(backoff * 2, 60_000)));
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      if (wanted) setTimeout(() => void run(), (backoff = Math.min(backoff * 2, 60_000)));
    }
  };
  void run();
}

export function stopTunnel(): void {
  wanted = false;
  child?.kill();
  child = null;
}
