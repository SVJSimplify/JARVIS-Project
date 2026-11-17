/**
 * CENTRALIZED SECRET REDACTION (Round 33, Phase 4).
 *
 * THE one redaction implementation for every durable and model-visible surface: tool
 * receipts (arguments + result previews), error messages that reach the model, workflow
 * journal entries, and audit details. Tools do NOT implement their own masking — there is
 * exactly one place that decides what a secret looks like, so a new secret shape is fixed
 * once and every surface is covered.
 *
 * Round 33's driving case: the Vercel deploy-hook URL is a BEARER SECRET — whoever holds
 * the URL can trigger a deployment. It used to reach the STARTED tool receipt verbatim
 * (the arguments preview was written before the tool ran, so the URL was durably recorded
 * before any sanitization had a chance to run). The fix has two halves:
 *   1. toolRecord redacts credential-shaped ARGUMENT KEYS before any record is written
 *      (vercel_deploy.hook_url joins native_browser_type.text on the per-tool list, and
 *      the key-name classifier now matches hook/deploy-hook/url-token shapes);
 *   2. redactText() below strips secret-SHAPED substrings from any text that could reach
 *      a receipt, a log, a journal entry, an error preview or the model — deploy-hook
 *      URLs, API tokens, Authorization headers, cookies, passwords/OTPs in query strings,
 *      session identifiers and private key blocks.
 *
 * Never prints the original secret in an error explaining that it was redacted. Redaction
 * is conservative for secret-shaped content and preserves ordinary execution evidence.
 */

const REDACTED = '[redacted]';

// --- URL patterns that ARE credentials -------------------------------------------------
/** Vercel deploy hook (the official endpoint embeds the hook id = bearer secret). */
const DEPLOY_HOOK_URL = /https?:\/\/[^\s"'<>]*api\.vercel\.com\/v1\/integrations\/deploy\/[A-Za-z0-9_-]+/gi;
/** Any URL carrying a credential-ish query parameter value. */
const URL_WITH_SECRET_QUERY = /([?&#](?:token|access_token|key|api[_-]?key|apikey|password|passwd|pwd|secret|otp|sig|signature|session[_-]?id|sessionid|auth)=[^\s"'&<>]+)/gi;
/** Any URL with embedded userinfo (https://user:pass@host). */
const URL_USERINFO = /(https?:\/\/)[^\s/"'<>:@]+:[^\s/"'<>@]+@/gi;

// --- token-shaped secrets --------------------------------------------------------------
/** Bearer/Authorization headers. */
const BEARER = /\b(bearer|basic|token)\s+[\w.\-+/=_]{8,}/gi;
/** Known provider token shapes (GitHub classic/fine-grained, Vercel, AWS, Slack, OpenAI-ish). */
const PROVIDER_TOKENS = /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}|(?:sk|rk|pk)_[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|vrm\.[A-Za-z0-9._-]{10,}/g;
/** set-cookie / cookie header values. */
const COOKIE_HEADER = /\b(set-cookie|cookie)\s*:\s*[^\r\n"']+/gi;
/** Private key blocks (never quote even a fragment). */
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g;

/**
 * Redact secret-shaped substrings from arbitrary text destined for a durable record, a
 * log, a journal entry or the model. Ordinary evidence (paths, ids, statuses, error
 * classes) passes through untouched.
 */
export function redactText(text: string): string {
  let t = String(text ?? '');
  if (!t) return '';
  t = t.replace(PRIVATE_KEY_BLOCK, '[private-key-redacted]');
  t = t.replace(DEPLOY_HOOK_URL, '<deploy-hook-url-redacted>');
  t = t.replace(PROVIDER_TOKENS, REDACTED);
  t = t.replace(BEARER, (_m, kind) => `${kind} ${REDACTED}`);
  t = t.replace(COOKIE_HEADER, (_m, kind) => `${kind}: ${REDACTED}`);
  t = t.replace(URL_USERINFO, (_m, scheme) => `${scheme}[userinfo-redacted]@`);
  t = t.replace(URL_WITH_SECRET_QUERY, (_m, pair) => `${String(pair).split('=')[0]}=${REDACTED}`);
  return t;
}

/** Credential-shaped ARGUMENT KEYS — values under these names are always masked. */
export const SECRET_KEY_RE =
  /pass(?:word|wd)?|secret|token|api[-_]?key|authorization|credential|cookie|session[-_]?id|hook[-_]?url|deploy[-_]?hook|webhook[-_]?url|otp|private[-_]?key/i;

/** Whether a key name is credential-shaped (used by toolRecord's args preview). */
export const isSecretKeyName = (key: string): boolean => SECRET_KEY_RE.test(String(key ?? ''));

/** The canonical redaction marker (one truth — receipts and tests compare against this). */
export const REDACTION_MARKER = REDACTED;
