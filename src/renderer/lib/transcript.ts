// \s? inside the name: Whisper often splits it ("jar vis"), as called out in OPERATING_PRINCIPLES.
const WAKE = /^\W*(?:(?:hey|hi|ok|okay|yo)\W+)?(?:j[aeo]r?\s?[vw][ie]s+|jarvus|travis|gervais)\b\W*/i;
const NAME = /j[aeo]r?\s?[vw][ie]s+|jarvus|travis|gervais/i;
const TRAILING = new RegExp(`[\\s,.!?]*(?:${NAME.source})\\W*$`, 'i');
const STOP = /^(?:stop|quiet|silence|enough|cancel|shut up|be quiet|never ?mind|that'?s enough)\b/i;
const JUNK = new Set([
  'you', 'thank you', 'thanks', 'thanks for watching', 'thank you for watching', 'bye', 'okay', 'oh', 'uh', 'um', 'hmm', 'the', 'so',
]);

/** Strips Whisper noise tags ([BLANK_AUDIO], (music), *sigh*) and known silence hallucinations. */
export function cleanTranscript(raw: string): string {
  const text = raw.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪[^♪]*♪?/g, ' ').replace(/\s+/g, ' ').trim();
  const norm = text.toLowerCase().replace(/[^a-z' ]/g, '').trim();
  return norm.length < 2 || JUNK.has(norm) ? '' : text;
}

/** Recognises the name at the start or end of an utterance and strips it; never required. */
export function parseWake(text: string): { woke: boolean; command: string } {
  const lead = WAKE.exec(text);
  const rest = lead ? text.slice(lead[0].length).trim() : text;
  const trail = TRAILING.exec(rest);
  const command = trail && trail.index > 0 ? rest.slice(0, trail.index).trim() : rest;
  return { woke: Boolean(lead) || Boolean(trail), command: trail && trail.index === 0 ? '' : command };
}

export const isStop = (t: string): boolean => STOP.test(t.trim());

export function greeting(): string {
  const h = new Date().getHours();
  const part = h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return `${part}, sir. All systems are online.`;
}
