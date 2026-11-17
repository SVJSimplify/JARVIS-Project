import { getApiKey, getBaseUrl } from './settings';

/** Fail if the provider has not even started responding after this long; a streaming body is never cut off once it flows. */
const FIRST_BYTE_TIMEOUT_MS = 180_000;

/**
 * A retired or restricted model (Google closed Gemini 2.5 to new accounts in Sep 2026; relays
 * wrap the upstream 404 in a 4xx/5xx of their own choosing) is a PERMANENT condition: retrying
 * only delays the honest failure. Match the model-level wording, not the HTTP status, because
 * gateways disagree on which status code carries it.
 */
const MODEL_GONE_RE =
  /no longer available|not available to new users|no endpoints found|model (is )?not found|does not exist|unsupported model|invalid model/i;

const oneLine = (t: string): string => t.replace(/\s+/g, ' ').trim();

/**
 * Classify one provider rejection. Returns the human-facing error message when the body says
 * the MODEL itself is gone (retired, restricted to existing users, unknown to the gateway),
 * regardless of which HTTP status the relay chose to carry it; null for every other failure,
 * which stays retryable. Pure function so the wording and the trigger words are unit-testable.
 */
export function providerRejection(status: number, body: string): string | null {
  if (!MODEL_GONE_RE.test(body)) return null;
  return (
    `This model was rejected by the provider (HTTP ${status}): ${oneLine(body).slice(0, 200)} ` +
    'It is likely retired or restricted — Gemini 2.5, for example, is closed to new accounts. Pick another model in Settings.'
  );
}

/** Thrown only for a PERMANENT model rejection (retired / restricted / unknown to the gateway). */
export class ModelGoneError extends Error {}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Part[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolSchema {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/**
 * Token usage, when the provider reports it (Module J). Purely observational: the provider
 * loop uses it for context-pressure decisions and the turn log; a gateway that omits the
 * field costs nothing.
 */
export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

let lastUsage: UsageInfo | null = null;

/** Record one response's usage (the newest wins; 0/negative values are ignored). */
export const noteUsage = (u: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined | null): void => {
  if (!u || typeof u !== 'object') return;
  const p = Number(u.prompt_tokens ?? 0);
  const c = Number(u.completion_tokens ?? 0);
  if (!Number.isFinite(p) && !Number.isFinite(c)) return;
  lastUsage = {
    promptTokens: Number.isFinite(p) ? p : 0,
    completionTokens: Number.isFinite(c) ? c : 0,
    totalTokens: Number.isFinite(Number(u.total_tokens)) ? Number(u.total_tokens) : (Number.isFinite(p) ? p : 0) + (Number.isFinite(c) ? c : 0),
  };
};

export const lastTokenUsage = (): UsageInfo | null => lastUsage;
export const resetTokenUsage = (): void => {
  lastUsage = null;
};

export async function send(path: string, method: 'GET' | 'POST', body?: unknown, signal?: AbortSignal): Promise<Response> {
  const key = await getApiKey();
  const baseUrl = await getBaseUrl();
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (let attempt = 0; ; attempt++) {
    // A listener added after a signal is already aborted never fires: check before every attempt.
    if (signal?.aborted) throw new Error('Interrupted');
    let res: Response;
    let timedOut = false;
    // A provider that never answers must not stall the turn forever: fail fast, retry, report.
    const ctl = new AbortController();
    const onCallerAbort = () => ctl.abort();
    signal?.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, FIRST_BYTE_TIMEOUT_MS);
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
      if (signal?.aborted) throw e; // the user cancelled: surface as-is
      // A silent hang is not a network blip: retrying it costs another full timeout window (~3 min each),
      // so fail the turn now with a message that says what actually happened.
      if (timedOut) throw new Error(`The provider accepted the connection but sent nothing for ${FIRST_BYTE_TIMEOUT_MS / 1000}s. It may be down or overloaded.`);
      if (attempt < 2) {
        await wait(800 * (attempt + 1));
        continue;
      }
      throw new Error(`Cannot reach ${baseUrl} (${e instanceof Error ? e.message : String(e)}). Check your internet connection and the API URL.`);
    }
    clearTimeout(timer); // headers arrived; the caller's abort stays wired so body reads remain cancellable
    if (res.ok) return res;
    signal?.removeEventListener('abort', onCallerAbort);
    const bodyText = await res.text();
    // A dead model must fail in ONE attempt with a message that says what to do about it;
    // burning retries on a permanent rejection just delays the honest answer.
    const rejection = providerRejection(res.status, bodyText);
    if (rejection) throw new ModelGoneError(rejection);
    // Hosted APIs rate-limit and hiccup; retry briefly before failing the turn.
    if ([429, 500, 502, 503, 504].includes(res.status) && attempt < 2) {
      const ra = Number(res.headers.get('retry-after'));
      await wait(ra > 0 ? Math.min(ra * 1000, 5000) : 800 * (attempt + 1));
      continue;
    }
    throw new Error(`Provider returned ${res.status}: ${bodyText.slice(0, 200)}`);
  }
}

/**
 * Run `job` with the first model in `chain`; a PERMANENT model rejection (retired, closed to
 * new users, unknown) automatically retries the SAME work on the next model. Anything else
 * (timeouts, rate limits, network) still fails the job: those are the honest errors they
 * always were. Falls back at most once per chain entry; with no fallback configured the
 * original error surfaces unchanged. `job` must be safe to re-run — completions are, because
 * a model that streams a body never throws ModelGoneError (the rejection happens at send time).
 */
export async function withModelFallback<T>(
  chain: string[],
  job: (model: string) => Promise<T>,
  onFallback?: (from: string, to: string) => void
): Promise<T> {
  const models = [...new Set(chain.map((m) => m.trim()).filter(Boolean))];
  let last: unknown;
  for (let i = 0; i < models.length; i++) {
    try {
      return await job(models[i]);
    } catch (e) {
      last = e;
      if (!(e instanceof ModelGoneError) || i === models.length - 1) throw e;
      console.warn(`[llm] model "${models[i]}" was rejected as unavailable — falling back to "${models[i + 1]}"`);
      onFallback?.(models[i], models[i + 1]);
    }
  }
  throw last; // unreachable: the loop either returns or throws
}

/** One non-streaming completion; used by sub-agents. */
export async function completeOnce(
  model: string,
  messages: Message[],
  tools: ToolSchema[],
  signal?: AbortSignal
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const res = await send('/chat/completions', 'POST', { model, messages, ...(tools.length ? { tools, tool_choice: 'auto' } : {}), stream: false }, signal);
  const data = (await res.json()) as { choices: Array<{ message: { content: string | null; tool_calls?: ToolCall[] } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
  noteUsage(data.usage);
  const msg = data.choices[0]?.message;
  if (!msg) throw new Error('Empty response from provider.');
  return { content: cleanThink(msg.content ?? ''), toolCalls: msg.tool_calls ?? [] };
}

/** Reasoning models may leak <think>...</think> into content; it must never be spoken, reported or kept in history. */
export const cleanThink = (t: string): string =>
  t
    .replace(/<think>[\s\S]*?<\/think>/g, '') // paired blocks
    .replace(/^[\s\S]*<\/think>/, '') // reasoning before the last close tag
    .replace(/<think>[\s\S]*$/, '') // a block truncated mid-reasoning never closes: strip the tail
    .trim();
