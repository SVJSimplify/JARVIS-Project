/**
 * Standalone mode: when the desktop is unreachable, the phone can still talk to the user's own
 * OpenAI-compatible provider (base URL + API key + model set in Settings). It uses the memories
 * already synced to the phone as context. Desktop-only work (computer control, files, agents)
 * is never pretended: those requests are queued for the desktop instead.
 */
import { getState, type ChatMessage, type MemoryView } from './store';

const words = (t: string) => new Set(t.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);

/** Small lexical relevance pick from the synced memory cache (no network, no model calls). */
export function relevantMemories(query: string, all: MemoryView[], n = 8): MemoryView[] {
  const q = words(query);
  return all
    .map((m) => {
      const w = words(m.label);
      let score = 0;
      for (const t of q) if (w.has(t)) score += 1;
      if (m.category === 'preference' || m.category === 'instruction') score += 0.5;
      return { m, score };
    })
    .filter((x) => x.score > 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((x) => x.m);
}

export const providerReady = (): boolean => {
  const p = getState().provider;
  return Boolean(p.baseUrl && p.model);
};

export async function askProvider(text: string, history: ChatMessage[]): Promise<string> {
  const p = getState().provider;
  if (!providerReady()) throw new Error('Set an AI provider in Settings to chat while the desktop is offline.');
  const mems = relevantMemories(text, getState().memories);
  const system =
    'You are JINI, the user\'s personal intelligence, answering from their phone while their desktop is offline. ' +
    'Be concise and candid. You cannot operate the computer, files or agents right now; if the user asks for that, say it will run when the desktop is back. ' +
    (mems.length ? `\nWhat you know about the user:\n${mems.map((m) => `- ${m.label}`).join('\n')}` : '');
  const turns = history
    .filter((m) => m.state === 'done' && m.text)
    .slice(-12)
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }));
  const res = await fetch(`${p.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}) },
    body: JSON.stringify({ model: p.model, messages: [{ role: 'system', content: system }, ...turns, { role: 'user', content: text }], stream: false }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Provider returned ${res.status}: ${body.slice(0, 160)}`);
  const data = JSON.parse(body) as { choices?: Array<{ message?: { content?: string } }> };
  const out = data.choices?.[0]?.message?.content?.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!out) throw new Error('The provider returned an empty answer.');
  return out;
}

/** Validate settings with one real request (the onboarding "Test connection" button). */
export async function testProvider(): Promise<string> {
  const reply = await askProvider('Reply with the single word: ready', []);
  return reply.slice(0, 80);
}
