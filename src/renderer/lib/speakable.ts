/**
 * Markdown and URLs are for reading, not hearing: TTS used to speak "**" literally as
 * "asterisk asterisk" and read raw links character by character. This is the renderer's
 * single choke point — `speech.enqueue` runs every job through it, so audio, the
 * system-voice fallback and captions stay consistent. The main process applies the same
 * rules again in tts.synthesize (defence in depth).
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

const CREDENTIAL_LABEL = /\b(?:api|access|private|secret|bearer)[\s_-]*(?:keys?|tokens?|credentials?)\b/i;
const CREDENTIAL_DISCOVERY = /\b(?:found|detected|located|extracted|discovered|identified|scanned)\b/i;
const SECRET_MATERIAL = /(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|(?:sk|rk|pk)_[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const FILE_PATH_LINE = /(?:^[A-Za-z]:\\|^\\\\|^\/(?:Users|home|etc|var|tmp)\/)/i;
const STRUCTURED_LINE = /^(?:\s*(?:[-*+]\s+|\d+[.)]\s+)|\s*[{[]|\s*[-=]{3,}\s*$)/;

/**
 * Produce the short, conversational voice response. The transcript keeps the complete
 * answer; speech deliberately does not read lists, code, paths, raw tool output or secrets.
 */
export function speechSummary(raw: string): string {
  const source = String(raw ?? '');
  const credentialContext = CREDENTIAL_LABEL.test(source) && CREDENTIAL_DISCOVERY.test(source);
  if (SECRET_MATERIAL.test(source) || credentialContext) {
    return "I found potentially sensitive credential material. I won't read any values aloud. Please review the on-screen result and rotate any exposed keys.";
  }

  const plain = source
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/\x60\x60\x60[\s\S]*?\x60\x60\x60/g, ' ')
    .replace(/\x60[^\x60]*\x60/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !STRUCTURED_LINE.test(line))
    .filter((line) => !FILE_PATH_LINE.test(line))
    .filter((line) => !/(?:api[_ -]?key|secret|password|bearer|access[_ -]?token|private[_ -]?key)\s*(?:=|:|->)/i.test(line))
    .join(' ');

  const cleaned = speakable(plain)
    .replace(/\b(?:[A-Za-z]:\\[^ ]+|\\\\[^ ]+)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return "I've finished. The detailed result is on screen.";

  const sentences = cleaned.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [cleaned];
  const selected: string[] = [];
  let words = 0;
  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;
    const count = s.split(/\s+/).length;
    if (selected.length >= 2 || words + count > 42) break;
    selected.push(s);
    words += count;
  }
  const summary = selected.join(' ').trim();
  return summary ? summary.slice(0, 360).trim() : "I've finished. The detailed result is on screen.";
}

