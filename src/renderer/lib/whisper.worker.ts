import { pipeline } from '@huggingface/transformers';

type Req = { id: number; type: 'load' } | { id: number; type: 'run'; audio: Float32Array };

/** Minimal shape of the pipeline result and progress events we rely on. */
interface AsrModel {
  (audio: Float32Array): Promise<{ text?: string }>;
}
interface ProgressEvent {
  status?: string;
  progress?: number;
}

let asr: Promise<AsrModel> | undefined;
const progress_callback = (p: ProgressEvent) => postMessage({ type: 'progress', progress: p.progress ?? 0, status: p.status });

const build = () =>
  pipeline('automatic-speech-recognition', 'Xenova/whisper-base.en', { dtype: 'q8', device: 'wasm', progress_callback });
const load = () => (asr ??= build());

self.onmessage = async (e: MessageEvent<Req>) => {
  const req = e.data;
  try {
    const model = await load();
    if (req.type === 'load') return postMessage({ id: req.id, ok: true, text: '' });
    const out = await model(req.audio);
    postMessage({ id: req.id, ok: true, text: String(out.text ?? '') });
  } catch (err) {
    postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
