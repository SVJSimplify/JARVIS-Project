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
