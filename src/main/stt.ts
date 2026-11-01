import { app } from 'electron';
import { spawn, execFile, type ChildProcess } from 'child_process';
import { createWriteStream, existsSync, promises as fs } from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { getGroqKey } from './settings';

const BIN_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-bin-x64.zip';
const MODEL = 'ggml-small.en-q5_1.bin'; // swap for ggml-base.en-q5_1.bin if you need more speed
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL}`;
const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = 'whisper-large-v3-turbo';
const PROMPT = 'Jarvis. Hey Jarvis, what time is it? Open the browser. Search the web.';

let ready: Promise<void> | undefined;
let proc: ChildProcess | undefined;
let port = 0;

async function download(url: string, dest: string, onPct: (pct: number) => void): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}): ${url}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  let got = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      got += chunk.length;
      if (total) onPct(Math.round((got / total) * 100));
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as never), counter, createWriteStream(`${dest}.part`));
  if (total && got !== total) {
    await fs.rm(`${dest}.part`, { force: true });
    throw new Error(`Incomplete download (${got} of ${total} bytes). Check your connection and retry.`);
  }
  await fs.rename(`${dest}.part`, dest);
}

async function findExe(dir: string): Promise<string | undefined> {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const found = await findExe(p);
      if (found) return found;
    } else if (/^(whisper-)?server\.exe$/i.test(e.name)) return p;
  }
}

const run = (cmd: string, args: string[]) =>
  new Promise<void>((resolve, reject) => execFile(cmd, args, (err) => (err ? reject(err) : resolve())));

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port: p } = s.address() as net.AddressInfo;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });

async function waitUp(): Promise<void> {
  for (let i = 0; i < 240; i++) {
    if (!proc) throw new Error('Whisper server exited during start-up.');
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error('Whisper server did not start.');
}

async function init(onPct: (pct: number) => void): Promise<void> {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Native Whisper supports Windows x64 only.');
  const dir = path.join(app.getPath('userData'), 'whisper');
  await fs.mkdir(dir, { recursive: true });

  let exe = await findExe(dir);
  if (!exe) {
    const zip = path.join(dir, 'bin.zip');
    try {
      await download(BIN_URL, zip, onPct);
      await run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`,
      ]);
    } finally {
      await fs.rm(zip, { force: true });
    }
    exe = await findExe(dir);
    if (!exe) throw new Error('whisper-server.exe not found in the downloaded release.');
  }
  const model = path.join(dir, MODEL);
  if (!existsSync(model)) await download(MODEL_URL, model, onPct);

  port = await freePort();
  const threads = Math.min(8, Math.max(2, os.cpus().length - 1));
  proc = spawn(
    exe,
    ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-t', String(threads), '-l', 'en', '-bs', '1', '-bo', '1', '-nt', '--prompt', PROMPT],
    { cwd: path.dirname(exe), windowsHide: true }
  );
  proc.on('exit', () => {
    proc = undefined;
    ready = undefined;
  });
  try {
    await waitUp();
  } catch (e) {
    // A failed start must not leave the spawned server orphaned: the next attempt would
    // otherwise spawn a second process while the first keeps its port and hundreds of MB.
    proc?.kill();
    throw e;
  }
}

function loadLocal(onPct: (pct: number) => void): Promise<void> {
  return (ready ??= init(onPct).catch((e) => {
    ready = undefined;
    throw e;
  }));
}

function toWav(samples: Float32Array): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
  return buf;
}

/** With a Groq key, start instantly and warm the local model in the background as the fallback. */
export async function loadStt(onPct: (pct: number) => void): Promise<void> {
  if (await getGroqKey()) {
    void loadLocal(() => {}).catch(() => {});
    return;
  }
  return loadLocal(onPct);
}

let cloudPausedUntil = 0;

async function transcribeGroq(samples: Float32Array, key: string): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(toWav(samples))], { type: 'audio/wav' }), 'a.wav');
  form.append('model', GROQ_MODEL);
  form.append('language', 'en');
  form.append('temperature', '0');
  form.append('response_format', 'json');
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after')) || 30;
      cloudPausedUntil = Date.now() + Math.min(Math.max(wait, 5), 120) * 1000;
    } else if (res.status === 401 || res.status === 403) {
      cloudPausedUntil = Date.now() + 10 * 60 * 1000; // bad key: stop hammering
    }
    throw new Error(`Groq STT error ${res.status}`);
  }
  return (((await res.json()) as { text?: string }).text ?? '').trim();
}

async function transcribeLocal(samples: Float32Array): Promise<string> {
  await loadLocal(() => {});
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(toWav(samples))], { type: 'audio/wav' }), 'a.wav');
  form.append('response_format', 'json');
  form.append('temperature', '0.0');
  const res = await fetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Whisper server error ${res.status}`);
  return (((await res.json()) as { text?: string }).text ?? '').trim();
}

/** Groq hosted Whisper when a key is set and not rate-limited; otherwise the local whisper.cpp server. */
export async function transcribeStt(audio: Float32Array): Promise<string> {
  const samples = audio instanceof Float32Array ? audio : new Float32Array((audio as ArrayBufferView).buffer);
  const key = await getGroqKey();
  if (key && Date.now() >= cloudPausedUntil) {
    try {
      return await transcribeGroq(samples, key);
    } catch (e) {
      console.warn('Groq STT failed, using local Whisper:', e);
    }
  }
  return transcribeLocal(samples);
}

export const stopStt = (): void => {
  proc?.kill();
};
