interface Reply { id?: number; type?: 'progress'; ok?: boolean; text?: string; error?: string; progress?: number }

let worker: Worker | undefined;
let seq = 0;
let onProgress: ((pct: number) => void) | undefined;
let chain: Promise<unknown> = Promise.resolve();
const pending = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<Reply>) => {
    const d = e.data;
    if (d.type === 'progress') return onProgress?.(Math.round(d.progress ?? 0));
    const p = d.id === undefined ? undefined : pending.get(d.id);
    if (!p) return;
    pending.delete(d.id!);
    if (d.ok) p.resolve(d.text ?? '');
    else p.reject(new Error(d.error));
  };
  return worker;
}

function call(msg: object, transfer: Transferable[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, ...msg }, transfer);
  });
}

let native = false;

/** Prefers the native whisper.cpp server (main process); falls back to in-browser WASM Whisper. */
export async function loadWhisper(progress?: (pct: number) => void): Promise<void> {
  try {
    await window.electronAPI.stt.load((pct) => progress?.(pct));
    native = true;
  } catch (e) {
    console.warn('Native Whisper unavailable, using WASM:', e);
    onProgress = progress;
    await call({ type: 'load' });
  }
}

/** 16 kHz mono PCM -> text. Runs strictly one at a time. */
export function transcribe(audio: Float32Array): Promise<string> {
  const run = chain.then(() => (native ? window.electronAPI.stt.transcribe(audio) : call({ type: 'run', audio }, [audio.buffer])));
  chain = run.catch(() => {});
  return run;
}
