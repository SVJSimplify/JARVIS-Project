import { actionVerifyLine, verifyAction, type ActionState, type ActionVerdict } from './externalContent';

/**
 * DESKTOP VISUAL VERIFICATION (Round 28, Phase 4) — the pure, platform-independent
 * verification core for screen-driven automation.
 *
 * The Windows PowerShell surfaces (screen_text / click_text OCR scripts) are the EXECUTION
 * layer; this module is the JUDGMENT layer, shared by every desktop tool and the desktop
 * agent contract:
 *
 *   observe → identify target → check ambiguity → act (authorized tool) → re-observe →
 *   verify the intended outcome (evidence-based; a click is never its own proof).
 *
 * Everything here is PURE and unit-tested. It runs identically on Windows (the primary
 * target), macOS and Linux — no platform-specific code paths, so nothing silently breaks
 * on an environment that only has the other half (Phase 4 §4.3).
 */

// ------------------------------------------------------------------ target identification

export interface ScreenMatch {
  /** The OCR line the target was identified in. */
  line: string;
  /** Screen coordinates of the match centre (already in the screenshot's pixel space). */
  x: number;
  y: number;
  /** 1-based occurrence among visually identical matches. */
  nth: number;
}

export interface AmbiguityAssessment {
  /** True when acting would guess: refuse and re-observe instead (Phase 4 §4.2 step 3). */
  ambiguous: boolean;
  reason: string;
  /** The candidates the observer actually saw. */
  candidates: string[];
}

const norm = (s: string): string => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * ROUND 29 (Phase 4): character-bigram Dice similarity between two texts (0..1). Used to
 * DESCRIBE ambiguity honestly — when two OCR lines are near-duplicates ("Save" vs "Save")
 * the refusal says so instead of implying two different controls; the refusal contract is
 * unchanged: several DISTINCT matching texts are never resolved by picking the closest.
 */
export function screenSimilarity(a: string, b: string): number {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (s: string): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const gx = grams(x);
  const gy = grams(y);
  let inter = 0;
  for (const g of gx) if (gy.has(g)) inter++;
  return (2 * inter) / (gx.size + gy.size || 1);
}

/**
 * Assess whether the intended target is sufficiently UNAMBIGUOUS before acting.
 * A single exact/containing match is unambiguous; several matches with no discriminator
 * are refused (the driver must disambiguate with a better window or a different label).
 * ROUND 29: the refusal names HOW the candidates differ (near-duplicates vs genuinely
 * different controls) and counts occurrences, so the recovery guidance is actionable.
 */
export function assessTargetAmbiguity(matches: string[], intended: string): AmbiguityAssessment {
  const want = norm(intended);
  const hits = matches.filter((m) => {
    const l = norm(m);
    return want ? l.includes(want) : l.length > 0;
  });
  if (!hits.length) return { ambiguous: true, reason: `no on-screen text matches "${intended}" — re-observe (screen_text) and adjust the target`, candidates: matches.slice(0, 6) };
  const distinct = [...new Set(hits.map(norm))];
  if (distinct.length === 1) return { ambiguous: false, reason: `one distinct target text (${hits.length} occurrence${hits.length > 1 ? 's' : ''}) — disambiguate by occurrence index`, candidates: distinct };
  const nearDuplicates = distinct.every((d) => screenSimilarity(d, distinct[0]) >= 0.95);
  return {
    ambiguous: true,
    reason: `${distinct.length} DIFFERENT texts match "${intended}" (${distinct.slice(0, 3).join(' | ')}${distinct.length > 3 ? ' …' : ''})${nearDuplicates ? ' — the candidates are near-duplicates, so this is likely the same control rendered more than once (check for dialog + background duplication)' : ' — genuinely different controls'} — refine the target text or the window before acting; never pick the closest match by default`,
    candidates: distinct.slice(0, 6),
  };
}

// ------------------------------------------------------------------- coordinates & scaling

/**
 * Map coordinates from the observation space (screenshot pixels) to the action space
 * (physical screen input). Windows display scaling (125%, 150%…) and multi-monitor
 * offsets are the classic silent killers: OCR sees capture pixels, SendInput wants
 * physical pixels. Pure math, unit-tested.
 * ROUND 29: hardening — a scale outside [0.5, 4] is refused with an honest error (a wrong
 * scale silently mis-aims every click), and non-finite origins/coordinates are rejected
 * instead of being rounded into a garbage point.
 */
export function mapCoordinates(x: number, y: number, opts: { scale?: number; originX?: number; originY?: number } = {}): { x: number; y: number } {
  const scale = opts.scale && opts.scale > 0 ? opts.scale : 1;
  if (scale < 0.5 || scale > 4 || !Number.isFinite(scale)) throw new Error(`display scale ${scale} is outside the plausible 0.5–4 range — refusing to map coordinates with it`);
  const originX = opts.originX ?? 0;
  const originY = opts.originY ?? 0;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(originX) || !Number.isFinite(originY)) throw new Error('coordinates and monitor origin must be finite numbers');
  return { x: Math.round(originX + x / scale), y: Math.round(originY + y / scale) };
}

// --------------------------------------------------------------------- action verification

/** The screen state of one observation, in the shape the shared verification engine expects. */
export interface ScreenState {
  /** Title of the foreground window ("the URL" of a desktop action). */
  windowTitle: string;
  /** The most relevant visible heading / first OCR line. */
  heading: string;
  /** Bounded visible text of the screen (OCR output). */
  text: string;
}

export interface DesktopVerifyInput {
  before: ScreenState | null;
  after: ScreenState | null;
  /** What was acted on ("the File menu", "the Save button"). */
  intent: string;
  /** The declared expected result ("the dialog closes and the document title shows saved"). */
  expected?: string;
  /** Consequential desktop actions (delete/pay/send/install semantics) need strong evidence. */
  consequential?: boolean;
}

const toActionState = (s: ScreenState | null): ActionState | null => (s ? { url: s.windowTitle, title: s.heading || s.windowTitle, content: s.text.slice(0, 1200) } : null);

/**
 * Verify a desktop action from BEFORE/AFTER screen observations using the SAME
 * evidence-based engine as the browser (one verification vocabulary across surfaces).
 * Returns the verdict plus the ready-to-render [ACTION VERIFY] line.
 */
export function verifyDesktopAction(input: DesktopVerifyInput): { verdict: ActionVerdict; line: string } {
  const verdict = verifyAction({
    before: toActionState(input.before),
    after: toActionState(input.after),
    intent: input.intent,
    expected: input.expected,
    consequential: input.consequential,
  });
  const line = actionVerifyLine({
    before: toActionState(input.before),
    after: toActionState(input.after),
    intent: input.intent,
    expected: input.expected,
    consequential: input.consequential,
  });
  return { verdict, line };
}

/**
 * STALE-TARGET DETECTION: was the observed target still on screen when we acted?
 * A target that vanished between observe and act must never be blindly re-clicked —
 * the interface changed under us (a dialog closed, a list re-rendered).
 */
export function isTargetStale(targetLine: string, reObservedLines: string[]): boolean {
  const t = norm(targetLine);
  if (!t) return true;
  return !reObservedLines.some((l) => norm(l).includes(t));
}

/**
 * WINDOW IDENTITY: a stable identity string for a window observation, used to notice
 * application switches between observe and act (the action would land somewhere else).
 */
export function windowIdentity(state: ScreenState): string {
  return norm(state.windowTitle).slice(0, 120);
}

/** True when the foreground window CHANGED between two observations (app-switch hazard). */
export function didWindowChange(before: ScreenState, after: ScreenState): boolean {
  return windowIdentity(before) !== windowIdentity(after) && norm(before.windowTitle) !== '' && norm(after.windowTitle) !== '';
}

/**
 * Compose the verification block a desktop action appends to its result: the verify line
 * plus (when the window changed or the verdict is weak) explicit re-observe guidance.
 * ROUND 29: a LOADING-STATE note — when the screen did not settle between before and
 * after AND the observation is identical, the app may simply not have re-rendered yet;
 * the block says so explicitly instead of implying the action failed outright.
 * Pure — the caller supplies real observations.
 */
export function desktopVerifyBlock(input: DesktopVerifyInput & { windowChanged?: boolean }): string {
  const { verdict, line } = verifyDesktopAction(input);
  const notes: string[] = [line];
  if (input.windowChanged) notes.push('[NOTE: the foreground window CHANGED between observe and act — confirm the action landed in the intended application; re-observe before continuing.]');
  if (input.before && input.after && isScreenSettled(input.before, input.after) && verdict.observed === 'interaction-only')
    notes.push('[NOTE: the screen is UNCHANGED and may still be rendering — wait briefly, re-observe (screen_text), and only then treat the action as failed.]');
  if (verdict.verdict !== 'confirmed') notes.push('[GUIDE: do not continue the sequence on an unverified outcome — re-observe the screen (screen_text/see_screen), re-identify the target, and either recover or report the blocker.]');
  return notes.join('\n');
}

/**
 * ROUND 29 (Phase 4): did the screen SETTLE between two observations? Two normalized
 * identical observations of the same window mean the UI is stable (either the action had
 * no visible effect or the app has not re-rendered yet — callers distinguish via the
 * verdict); any difference means the interface is still changing (loading states, dialogs).
 */
export function isScreenSettled(before: ScreenState, after: ScreenState): boolean {
  return norm(before.text) === norm(after.text) && norm(before.windowTitle) === norm(after.windowTitle) && norm(before.text).length > 0;
}
