import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { getVoice } from './settings';

/**
 * Markdown, URLs and emoji are for reading, not hearing: TTS used to speak "**" literally
 * as "asterisk asterisk". The renderer strips before enqueueing; this main-process copy is
 * the second, independent enforcement at the only choke point all neural audio passes
 * through — so no caller, current or future, can ever synthesize markup.
 */
export function speakable(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/```[a-z]*\n?/gi, ' ') // code fences: keep the code, drop the fence markers
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](url) → text
    .replace(/\bhttps?:\/\/\S+/gi, (u) => {
      try {
        return new URL(u).host.replace(/^www\./, '');
      } catch {
        return '';
      }
    }) // bare URLs → just the domain
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // headings
    .replace(/^\s{0,3}>\s?/gm, '') // blockquotes
    .replace(/^\s{0,3}[-*+]\s+/gm, '') // bullet markers
    .replace(/(\*\*\*|\*\*|__|\*|~~|`)/g, '') // emphasis markers (snake_case underscores survive)
    .replace(/\|/g, ' ') // table pipes
    .replace(/^\s{0,3}(-{3,}|={3,})\s*$/gm, '') // horizontal rules
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}]\u{FE0F}?/gu, '') // emoji/arrows mangled by TTS
    .replace(/\s+/g, ' ')
    .trim();
}

interface Engine {
  voice: string;
  ready: Promise<MsEdgeTTS>;
}

let engine: Engine | undefined;

function getEngine(voice: string): Promise<MsEdgeTTS> {
  if (engine?.voice === voice) return engine.ready;
  void engine?.ready.then((t) => t.close()).catch(() => {});

  const tts = new MsEdgeTTS();
  const ready = tts
    .setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
    .then(() => tts);
  engine = { voice, ready };
  ready.catch(() => {
    if (engine?.ready === ready) engine = undefined; // allow a clean retry
  });
  return ready;
}

/** A stalled Edge-TTS socket used to leave synthesize pending forever, and the renderer's speech queue then never played again. */
const COLLECT_TIMEOUT_MS = 30_000;

function collect(tts: MsEdgeTTS, text: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const { audioStream } = tts.toStream(text);
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => reject(new Error('Speech synthesis stalled.')), COLLECT_TIMEOUT_MS);
    const settle = (fn: () => void): void => {
      clearTimeout(timer);
      fn();
    };
    audioStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    audioStream.on('error', (e) => settle(() => reject(e)));
    audioStream.on('close', () => settle(() => (chunks.length ? resolve(Buffer.concat(chunks)) : reject(new Error('No audio received.')))));
  });
}

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Synthesize speech with Edge neural voices. Throws when the voice is set to
 * the system voice or the service is unreachable; the renderer then falls back
 * to the built-in speech engine.
 */
export async function synthesize(text: string): Promise<Uint8Array> {
  const voice = await getVoice();
  if (voice === 'system') throw new Error('System voice selected.');
  const safe = escapeXml(speakable(text));
  if (!safe) throw new Error('Nothing speakable in that text.');

  try {
    return await collect(await getEngine(voice), safe);
  } catch {
    // The socket may have gone stale: rebuild once.
    void engine?.ready.then((t) => t.close()).catch(() => {});
    engine = undefined;
    return collect(await getEngine(voice), safe);
  }
}
