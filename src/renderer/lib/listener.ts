const RATE = 16000;
const FRAME = 1024;
const FRAME_MS = (FRAME / RATE) * 1000;
const PRE_FRAMES = 5;
const END_QUIET_MS = 850;
const MIN_VOICE_MS = 400;
const MAX_MS = 20000;
const MIN_THRESHOLD = 0.02;

/** 'barge': JARVIS is talking, so demand louder/longer speech. 'deaf': ignore the mic. */
export type ListenGate = 'normal' | 'barge' | 'deaf';

export interface ListenerOptions {
  gate: () => ListenGate;
  onLevel: (level: number) => void;
  onStart: (barge: boolean) => void;
  onEnd: (audio: Float32Array | null, barge: boolean) => void;
}

const concat = (frames: Float32Array[]): Float32Array => {
  const out = new Float32Array(frames.length * FRAME);
  frames.forEach((f, i) => out.set(f, i * FRAME));
  return out;
};

/** Always-on mic with energy-based voice activity detection. */
export async function startListener(o: ListenerOptions): Promise<{ stop: () => void }> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  const ctx = new AudioContext({ sampleRate: RATE });
  await ctx.resume();
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(FRAME, 1, 1);

  let pre: Float32Array[] = [];
  let seg: Float32Array[] = [];
  let inSpeech = false;
  let barge = false;
  let loud = 0;
  let quiet = 0;
  let floor = 0.01;

  proc.onaudioprocess = (e) => {
    const f = new Float32Array(e.inputBuffer.getChannelData(0));
    let sum = 0;
    for (const v of f) sum += v * v;
    const rms = Math.sqrt(sum / f.length);
    o.onLevel(Math.min(1, rms * 6));

    const gate = o.gate();
    // While JARVIS talks, a barge capture must be deliberate: a higher threshold and
    // ~250 ms of sustained voice (vs 96 ms otherwise) reject speaker echo, clicks and
    // door slams instead of letting them start an interrupt capture mid-sentence.
    const voiced = rms > Math.max(MIN_THRESHOLD, floor * 3) * (gate === 'barge' ? 2.4 : 1);

    if (!inSpeech) {
      if (gate === 'deaf') {
        loud = 0;
        pre = [];
        return;
      }
      pre.push(f);
      if (pre.length > PRE_FRAMES) pre.shift();
      if (!voiced) {
        loud = 0;
        floor = floor * 0.95 + rms * 0.05;
        return;
      }
      if (++loud >= (gate === 'barge' ? 8 : 3)) {
        inSpeech = true;
        barge = gate === 'barge';
        seg = [...pre];
        quiet = 0;
        o.onStart(barge);
      }
      return;
    }

    seg.push(f);
    quiet = voiced ? 0 : quiet + 1;
    if (quiet * FRAME_MS >= END_QUIET_MS || seg.length * FRAME_MS >= MAX_MS) {
      const voiceMs = (seg.length - quiet) * FRAME_MS;
      const audio = voiceMs >= MIN_VOICE_MS ? concat(seg.slice(0, seg.length - Math.max(0, quiet - 3))) : null;
      const wasBarge = barge;
      inSpeech = false;
      loud = 0;
      seg = [];
      pre = [];
      o.onEnd(audio, wasBarge);
    }
  };

  src.connect(proc);
  proc.connect(ctx.destination); // output buffer is never written: silent

  return {
    stop: () => {
      proc.onaudioprocess = null;
      proc.disconnect();
      src.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}
