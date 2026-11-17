/**
 * IPC SENDER TRUST VALIDATION (Round 33 Phase 3 §3.1/§3.2; ROUND 34 Phase 5 — EXACT
 * trusted-renderer resource validation).
 *
 * The ONE sender-trust implementation shared by every sensitive IPC channel — the approval
 * channels (list/respond/dismiss, Round 34 §5.3) and the credential-management channels.
 * A handler may only proceed when the invoking sender is:
 *   1. an EXACT app-owned webContents (alive, one of this app's own windows' primary
 *      webContents — never a detached/child webContents such as DevTools or a guest);
 *   2. on its MAIN frame (a child frame's message can never act for the app);
 *   3. loaded from THIS application's trusted renderer resource — ROUND 34: PACKAGED mode
 *      validates the EXACT bundled renderer entry (the same file the window loads with
 *      loadFile), NOT "any file:// URL"; DEVELOPMENT mode validates the exact configured
 *      dev-server origin, never another localhost port or foreign origin;
 *   4. and the window still exists (destroyed or navigated-away senders refuse).
 *
 * ROUND 34 §5.1 packaged-resource matching accounts for:
 *   - the actual packaged entry-point path (built from the main module's __dirname, the
 *     same path loadFile uses — asar layout included);
 *   - URL encoding differences (both sides are DECODED before comparison);
 *   - Windows drive-letter normalization and path-separator differences
 *     (pathToFileURL on the expected side; case-folded comparison on win32);
 *   - query and fragment handling (the SAME resource with a hash or SPA query is still
 *     the app's renderer — a DIFFERENT path never is);
 *   - unexpected local navigation (any other file: path refuses — e.g. file:///etc/passwd);
 *   - navigation after the window has loaded (the frame's CURRENT url is validated on
 *     every event, so a renderer that navigated away refuses);
 *   - child frames (parent check), detached windows and destroyed webContents.
 *
 * FAIL-CLOSED (Round 33 §3.1): every indeterminate input refuses. A missing senderFrame,
 * an exception while inspecting the frame, or an unidentifiable frame is NOT proof of a
 * trusted main frame. On the app's Electron (v32) `IpcMainInvokeEvent.senderFrame` is
 * always present; its absence is treated as untrusted, and the frame's own URL must match
 * the trusted resource too, not just the webContents'.
 *
 * The electron-shaped inputs arrive as narrow structural types so the checks are unit-
 * testable without loading Electron. Refusals are COUNTED (Round 34 Phase 6): the
 * Operations Center shows real refused-attempt state, never invented numbers.
 */

import { pathToFileURL } from 'url';

export interface IpcFrameLike {
  parent?: unknown;
  /** WebFrameMain.url (Electron ≥ 12) — the frame's own current URL, when available. */
  url?: string;
}

export interface IpcEventLike {
  sender?: { isDestroyed(): boolean; getURL(): string } | null;
  senderFrame?: IpcFrameLike | null;
}

export interface IpcWindowLike {
  isDestroyed(): boolean;
  webContents: unknown;
}

/**
 * The TRUSTED RENDERER resource this application expects (Round 34 §5). EXACT, not an
 * origin class: packaged mode pins the bundled renderer entry file; development mode
 * pins the configured dev-server origin.
 */
export interface TrustedRendererSpec {
  /** 'packaged' → exact bundled renderer entry; 'development' → exact dev-server origin. */
  kind: 'packaged' | 'development';
  /** Packaged: the exact file:// URL of the bundled renderer entry (normalized, encoded). */
  fileUrl?: string;
  /** Development: the exact origin (protocol + host) of the configured dev server. */
  origin?: string;
}

/** The EXACT packaged trusted renderer: the file URL of the bundled renderer entry. */
export const trustedPackagedRenderer = (rendererEntryPath: string): TrustedRendererSpec => ({
  kind: 'packaged',
  fileUrl: pathToFileURL(rendererEntryPath).toString(),
});

/** The EXACT development trusted renderer: the configured dev-server origin. */
export const trustedDevelopmentOrigin = (devServerOrigin = 'http://localhost:5173'): TrustedRendererSpec => ({
  kind: 'development',
  origin: devServerOrigin,
});

/**
 * The single decision point for WHICH renderer to trust (mirrors the window's own
 * loadFile/loadURL branch in index.ts — one truth, no second implementation).
 */
export const expectedRendererSpec = (opts: {
  isPackaged: boolean;
  nodeEnv?: string;
  rendererEntryPath: string;
  devServerOrigin?: string;
}): TrustedRendererSpec =>
  opts.isPackaged || opts.nodeEnv === 'production'
    ? trustedPackagedRenderer(opts.rendererEntryPath)
    : trustedDevelopmentOrigin(opts.devServerOrigin);

/** Decode a file: URL's pathname (encoding-independent comparison); null when not file:. */
const decodedFilePath = (url: string): string | null => {
  try {
    const u = new URL(url);
    if (u.protocol !== 'file:') return null;
    try {
      return decodeURIComponent(u.pathname);
    } catch {
      return null;
    }
  } catch {
    return null;
  }
};

const foldPath = (p: string): string =>
  process.platform === 'win32' ? p.toLowerCase().replace(/\\/g, '/') : p;

/**
 * Does this frame/webContents URL identify the EXACT trusted renderer resource?
 * (Round 34 §5.1/§5.2.) Packaged: protocol file:, no (or localhost) host, and the
 * DECODED, case-folded pathname must EQUAL the trusted entry's — any other local file
 * refuses. Development: exact protocol+host match of the configured dev server.
 * Query and fragment are ignored (the same resource; navigation state lives there).
 */
export const urlIsTrustedRenderer = (frameUrl: string, spec: TrustedRendererSpec): boolean => {
  try {
    if (spec.kind === 'development') {
      const u = new URL(frameUrl);
      return `${u.protocol}//${u.host}` === spec.origin;
    }
    const u = new URL(frameUrl);
    if (u.protocol !== 'file:') return false;
    if (u.host && u.host !== 'localhost') return false;
    const got = decodedFilePath(frameUrl);
    const want = spec.fileUrl ? decodedFilePath(spec.fileUrl) : null;
    if (!got || !want) return false;
    return foldPath(got) === foldPath(want);
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------- refusal accounting (Phase 6)

let refusedAttempts = 0;
let lastRefusal: { at: number; detail: string } | null = null;
/** The configured trusted-renderer spec (set once by index.ts at startup). */
let configuredSpec: TrustedRendererSpec | null = null;

/** Called once by index.ts — the ONE trust authority records its configured resource. */
export const setTrustedRendererSpec = (spec: TrustedRendererSpec): void => {
  configuredSpec = spec;
};

/** Called at the REAL refusal site (index.ts) when an untrusted sender is rejected. */
export const noteIpcTrustRefusal = (detail?: string): void => {
  refusedAttempts += 1;
  lastRefusal = { at: Date.now(), detail: String(detail ?? '').slice(0, 200) };
};

/** Real IPC-trust state for the Operations Center (Round 34 Phase 6). */
export const ipcTrustHealth = (): {
  mode: 'packaged' | 'development' | 'unconfigured';
  expectedRenderer: string;
  refusedAttempts: number;
  lastRefusal?: { at: number; detail: string };
} => ({
  mode: configuredSpec?.kind ?? 'unconfigured',
  expectedRenderer: configuredSpec?.kind === 'packaged' ? (configuredSpec.fileUrl ?? '') : (configuredSpec?.origin ?? ''),
  refusedAttempts,
  lastRefusal: lastRefusal ?? undefined,
});

/** Test hook: reset the refusal counters (focused checks). */
export const resetIpcTrustForTests = (): void => {
  refusedAttempts = 0;
  lastRefusal = null;
};

/**
 * THE main-frame decision — FAIL-CLOSED. A missing senderFrame, an exception during
 * inspection, or a frame whose own URL is not the EXACT trusted renderer resource is
 * UNTRUSTED. Only a present, parentless (top-level) frame whose URL matches passes.
 */
export const frameIsMainTrusted = (e: IpcEventLike, expected: TrustedRendererSpec): boolean => {
  try {
    const f = e.senderFrame;
    if (!f) return false; // fail closed: an unidentifiable frame is never "main"
    if (f.parent) return false; // a child frame never acts for the app
    // The frame's OWN url must be the trusted renderer resource (a main frame navigated
    // elsewhere refuses) — when the frame exposes a URL; a frame without a readable URL
    // refuses.
    if (typeof f.url === 'string' && f.url.length > 0) {
      if (!urlIsTrustedRenderer(f.url, expected)) return false;
    } else {
      return false; // fail closed: no frame URL → cannot verify → refuse
    }
    return true;
  } catch {
    return false; // fail closed: an inspection error is never proof of trust
  }
};

/**
 * THE full sender decision — exact webContents identity + main frame + EXACT trusted
 * renderer resource. `windows` is the live window list (BrowserWindow.getAllWindows()
 * at call time).
 */
export const senderIsTrustedAppFrame = (
  e: IpcEventLike,
  opts: { windows: IpcWindowLike[]; expected: TrustedRendererSpec }
): boolean => {
  try {
    const sender = e.sender;
    if (!sender || sender.isDestroyed()) return false;
    // 1. Exact identity: one of THIS app's own windows' primary webContents.
    const own = opts.windows.some((w) => !w.isDestroyed() && w.webContents === sender);
    if (!own) return false;
    // 2. The webContents' CURRENT URL must be the trusted renderer resource (a
    //    navigated-away renderer is refused).
    if (!urlIsTrustedRenderer(sender.getURL(), opts.expected)) return false;
    // 3. FAIL-CLOSED main-frame check (Round 33 §3.1).
    if (!frameIsMainTrusted(e, opts.expected)) return false;
    return true;
  } catch {
    return false;
  }
};
