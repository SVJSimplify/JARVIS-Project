/**
 * Sanitisation for model-supplied visual markup (show_visual's legacy html path).
 *
 * The strong guarantee is the VisualCard iframe: sandboxed WITHOUT allow-scripts and served
 * under a CSP that has no script-src at all, so nothing here is load-bearing for security.
 * This layer exists so obviously hostile or broken markup never even reaches the screen:
 * scripts, event handlers, javascript: URLs and embedding elements are stripped, and the
 * caller can see what was removed.
 */

const SCRIPT_BLOCK = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const SCRIPT_VOID = /<script\b[^>]*\/?>/gi;
const DANGEROUS_TAGS = /<\/?(?:iframe|object|embed|link|meta|base|applet|frame|frameset)\b[^>]*>/gi;
const EVENT_ATTR = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_URL = /(?:href|src|xlink:href|action|formaction)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|\s*javascript:[^\s>]*)/gi;
const JS_URL_BARE = /javascript:/gi;
const SRCDOC_ATTR = /\ssrcdoc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

export interface SanitizeResult {
  html: string;
  /** Human-readable list of what was removed, for the tool result and the activity feed. */
  stripped: string[];
}

export function sanitizeVisualHtml(input: string): SanitizeResult {
  const stripped: string[] = [];
  let html = String(input ?? '');

  const cut = (re: RegExp, label: string): void => {
    html = html.replace(re, (match) => {
      stripped.push(label);
      void match;
      return '';
    });
  };

  cut(SCRIPT_BLOCK, '<script> block');
  cut(SCRIPT_VOID, '<script> tag');
  cut(DANGEROUS_TAGS, 'embedding tag');
  cut(SRCDOC_ATTR, 'srcdoc attribute');
  cut(EVENT_ATTR, 'inline event handler');
  cut(JS_URL, 'javascript: URL');
  // Any javascript: that survived an unusual quoting shape is dead anyway under the CSP,
  // but blanking it keeps the payload honest about what will actually run.
  if (/javascript:/i.test(html)) {
    html = html.replace(JS_URL_BARE, 'blocked:');
    stripped.push('javascript: URL');
  }

  return { html: html.trim(), stripped: [...new Set(stripped)] };
}
