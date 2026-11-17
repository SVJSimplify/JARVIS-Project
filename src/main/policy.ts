import * as path from 'path';
import { lstatSync, readlinkSync, realpathSync } from 'fs';

/**
 * POLICY — the single, centralized enforcement brain.
 *
 * ONE operating policy governs every execution route (main agent, browser agent, coding
 * agent, research agents, child agents, background jobs, scheduled tasks, and any tool
 * registered in the future):
 *
 *   ALL SUPPORTED ACTIONS ARE ALLOWED AUTOMATICALLY, EXCEPT DELETION AND MODIFICATION OF
 *   OPERATING-SYSTEM-RELATED FILES OR RESOURCES.
 *
 * There are no permission modes and no ask-before-action defaults. The only two hard
 * restrictions live HERE, as classifiers, and they are consulted from exactly one place
 * (guard.assessRisk, which feeds the authorization gate). Individual tools call the same
 * exported verdict functions as a second layer, but never with their own private rules —
 * there is one source of truth and new tools cannot bypass it.
 *
 * Design rules this module follows:
 *   - Fail closed: anything that cannot be reliably classified as safe (dynamic code
 *     constructs, opaque execution payloads, ambiguous destructive controls) is blocked,
 *     not waved through.
 *   - Assume an adversary: paths arrive in alternate representations (device prefixes,
 *     8.3 short names, environment variables, traversal, symlinks), commands arrive
 *     wrapped in cmd /c, PowerShell aliases and encoded payloads, and destruction hides
 *     behind innocuous button labels or JavaScript APIs. The classifiers below are built
 *     to survive those shapes, and tests/policyAdversarial.test.ts pins them.
 *   - Do not over-classify: ordinary project files, development configuration, application
 *     settings and user documents stay editable. Only genuinely OS-critical targets are
 *     protected.
 *   - Pure and electron-free: every function is deterministic and unit-testable.
 */

// --------------------------------------------------------------------- protected paths

/**
 * Paths JARVIS must never modify (writes, deletes, moves INTO them). Windows-first — the
 * product runs on Windows — with the common POSIX system roots included so a Linux test
 * run or a future port is covered by the same classifier.
 *
 * Deliberately NOT on this list: ordinary user folders, project folders, development
 * configuration (package.json, tsconfig, .env), application settings under the user
 * profile, and documents. Mis-classifying every config file as an OS file is a defect.
 */
const OS_PATH_PATTERNS: RegExp[] = [
  // Windows system roots
  /^[a-z]:\\windows(\\|$)/i,
  /^[a-z]:\\program files( \(x86\))?(\\|$)/i,
  /^[a-z]:\\programdata(\\|$)/i,
  /^[a-z]:\\(\$recycle\.bin|system volume information|boot|recovery|efi)(\\|$)/i,
  // Windows internals that live under user-visible roots too
  /\\system32\\(config|drivers|driverstore|spool|logfiles)(\\|$)/i,
  /\\syswow64(\\|$)/i,
  // Persistence and security-sensitive locations
  /\\appdata\\roaming\\microsoft\\windows\\start menu(\\|$)/i,
  /\\\.ssh(\\|$)/i,
  // Browser profiles hold credentials, cookies and session tokens
  /\\appdata\\(local|roaming)\\(google\\chrome|microsoft\\edge|bravesoftware|mozilla\\firefox|chromium)(\\|$)/i,
  // Registry hives as files
  /\\ntuser\.dat$/i,
  /\\config\\(system|software|sam|default)(\.log.*)?$/i,
  // Remote administration shares of OS volumes
  /^\\\\[^\\]+\\[a-z]\$(\\|$)/i,
  // POSIX equivalents
  /^\/(etc|boot|bin|sbin|usr|lib|lib64|sys|proc|dev|system)\/|^\/(etc|boot|bin|sbin|usr|lib|lib64|sys|proc|dev|system)$/i,
  /^\/private\/etc(\/|$)/i,
  /\/\.ssh(\/|$)/i,
];

/**
 * Expand the well-known OS environment variables to their canonical Windows locations, so
 * `%SystemRoot%\System32\config\SAM` or `$env:ProgramFiles\Untrusted\writer.cmd` classify
 * like the literal paths they name. Unknown variables are left untouched — expanding
 * everything would mis-classify ordinary application paths. Order matters: long names
 * before their prefixes.
 */
const OS_ENV_MAP: Record<string, string> = {
  systemroot: 'C:\\Windows',
  windir: 'C:\\Windows',
  programfiles: 'C:\\Program Files',
  'programfiles(x86)': 'C:\\Program Files (x86)',
  programdata: 'C:\\ProgramData',
  systemdrive: 'C:',
};

export function expandWinEnv(p: string): string {
  let out = String(p ?? '');
  out = out.replace(/\$env:([a-z_()0-9]+)/gi, (m, name: string) => OS_ENV_MAP[name.toLowerCase()] ?? m);
  out = out.replace(/%([a-z_()0-9]+)%/gi, (m, name: string) => OS_ENV_MAP[name.toLowerCase()] ?? m);
  return out;
}

/** Rewrite 8.3 short names that alias protected roots (PROGRA~1 → program files). Only the drive-root aliases are folded: a PROGRA~1 under an ordinary folder is that folder's own 8.3 name, not Program Files. */
const foldShortNames = (p: string): string =>
  p
    .replace(/^([a-z]:\\)progra~1(\s|\\|$)/i, '$1program files$2')
    .replace(/^([a-z]:\\)progra~2(\s|\\|$)/i, '$1program files (x86)$2');

/**
 * True when `p` (absolute or relative, in any of its representations — forward/backward
 * slashes, `\\?\` device prefixes, file:// URLs, 8.3 short names, %ENV% or $env: forms)
 * resolves to an OS-protected location. Pure; adversarial representations are normalized
 * before matching, so a rewrite cannot become a bypass.
 */
export function osProtectedPath(p: unknown): boolean {
  let raw = String(p ?? '').trim();
  if (!raw) return false;
  // file:// URLs name the same file system targets as their decoded path.
  if (/^file:\/\//i.test(raw)) {
    try {
      raw = decodeURIComponent(new URL(raw).pathname);
    } catch {
      /* keep as-is; the literal form still cannot match protected roots */
    }
  }
  // Windows device prefixes: \\?\C:\Windows\... , \\.\C:\..., \\?\UNC\server\share\...
  raw = raw.replace(/^\\{1,4}[.?](?:\??)?\\(?:unc\\)?/i, (m) => (/unc\\/i.test(m) ? '\\\\' : ''));
  // Alternate environment-variable representations of the OS roots.
  raw = expandWinEnv(raw);
  // 8.3 short-name aliases of protected roots.
  raw = foldShortNames(raw);
  const full = path.isAbsolute(raw) || /^[a-z]:[\\/]/i.test(raw) ? path.normalize(raw) : path.resolve(raw);
  const folded = full.replace(/\//g, '\\');
  // UNC admin shares (\\host\c$\...) never survive normalization on POSIX — test the raw form too.
  const unc = /^\\\\[^\\]+\\[a-z]\$(\\|$)/i.test(raw);
  return unc || OS_PATH_PATTERNS.some((re) => re.test(full) || re.test(folded));
}

// ------------------------------------------------------------------- shell classification

/** Package-manager dependency removal is ordinary project management (explicitly allowed by policy), so removal words preceded by these tokens are exempt from the deletion class. */
const DEP_MGMT_BEHIND = String.raw`(?<!\b(?:npm|yarn|pnpm|bun|pip3?|choco)\s)`;

/** Irreversible data removal, including through PowerShell aliases, Node/JS APIs and .NET method calls. System-level uninstallers (winget, Remove-Appx) stay blocked. */
const DELETION_CMD = new RegExp(
  [
    // PowerShell/cmd file removal + package removal words (with the dependency-management exemption)
    `${DEP_MGMT_BEHIND}\\b(?:rm|rmdir|del|erase|unlink|shred|uninstall)\\b`,
    String.raw`\bri\s+[^-\s]`,
    String.raw`\bri\s+-\w+\s+[^-\s]`, // Remove-Item alias with flags: ri -Path x -Recurse
    String.raw`\brd\s`,
    String.raw`\bRemove-Item\b`,
    String.raw`\bRemove-ItemProperty\b`,
    String.raw`\bClear-Content\b`,
    String.raw`\.\s*Delete\s*\(\s*\)`, // $item.Delete(), [System.IO.File]::Delete() with any receiver
    String.raw`(?:format|Format-Volume|Initialize-Disk|Clear-Disk)\s+[a-z0-9]:`,
    String.raw`\bdiskpart\b`,
    String.raw`\bcipher\s+/w\b`,
    String.raw`\bvssadmin\s+delete\b`,
    String.raw`\bwbadmin\s+delete\b`,
    // node / JS destruction through a shell one-liner (node -e "fs.unlinkSync('x')")
    String.raw`\brimraf\b`,
    String.raw`\bfs\s*\.\s*(?:rm|rmdir|unlink)\b`,
    String.raw`\b(?:unlink|rm|rmdir)Sync\b`,
    // git history/worktree destruction
    String.raw`\bgit\s+(?:clean|reset\s+--hard)\b`,
    String.raw`\bgit\s+(?:checkout\s+--|restore)\b`,
    String.raw`\bgit\s+push\s+(?:-f|--force)\b`,
    // records / logs / shadow copies
    String.raw`\breg\s+delete\b`,
    String.raw`\bschtasks\s+/delete\b`,
    String.raw`\bwevtutil\s+(?:cl|clear-log)\b`,
    String.raw`\bwmic\s+[^&|]*\bdelete\b`,
    String.raw`\[System\.IO\.(?:File|Directory)\]::Delete`,
    // interpreter-API destruction inside one-liners (python/ruby/general .unlink) —
    // payload code is ALSO classified structurally in shellVerdict (layer 4); these word
    // forms are the belt to that suspenders so a payload can never slip the parser.
    String.raw`\bos\s*\.\s*(?:remove|unlink|rmdir|removedirs)\s*\(`,
    String.raw`\bshutil\s*\.\s*(?:rmtree|unlink|rmdir)\b`,
    String.raw`\.\s*unlink\s*\(`,
    String.raw`\bFile\s*\.\s*(?:delete|unlink)\s*\(`,
    String.raw`\bFileUtils\s*\.\s*(?:rm(?:_(?:rf|r|dir|lr))?|remove|unlink|chmod|chown)\b`,
    // application removal (system-level uninstallers)
    String.raw`\bwinget\s+uninstall\b`,
    String.raw`\bRemove-AppxPackage\b`,
    String.raw`\bRemove-Service\b`,
  ].join('|'),
  'i'
);

/** Operating-system configuration, services, boot, drivers, protected registry, accounts, security software, power state — and opaque payloads that bypass command classification. */
const OS_CONFIG_CMD = new RegExp(
  [
    String.raw`\bbcd(?:edit|boot)\b`,
    String.raw`\breg\s+(?:add|copy|load|unload|restore|import|compare)\s+hk(?:lm|cr|u)\b`,
    String.raw`\breg\s+add\s+hkcu.*\\run(?:once)?\b`, // startup persistence
    String.raw`\b(?:Set|New|Remove)-ItemProperty\b[^&|]*\bhklm:`,
    String.raw`\bsc\s+(?:config|create|delete|stop|failure|sdset)\b`,
    String.raw`\b(?:Set|Stop|Restart|New)-Service\b`,
    String.raw`\bnet\s+(?:user|localgroup)\b`,
    String.raw`\bpnputil\b`,
    String.raw`\btakeown\b`,
    String.raw`\bicacls\b`,
    String.raw`\bSet-(?:Mp|WM)Preference\b|\bAdd-MpPreference\b`,
    String.raw`\b(?:shutdown|restart-computer|stop-computer|logoff)\b`,
    // Opaque payloads bypass command classification — fail closed.
    String.raw`\b(?:iex|Invoke-Expression)\b`,
    String.raw`\b(?:curl|wget|irm|Invoke-WebRequest)\b[^&|]*\|\s*(?:iex|sh|bash|powershell)`,
    String.raw`\bpowershell(?:\.exe)?\b[^&|]*\s-(?:enc|ec|encodedcommand)\b`, // encoded payloads
    String.raw`\bpwsh(?:\.exe)?\b[^&|]*\s-(?:enc|ec|encodedcommand)\b`,
    String.raw`\bFromBase64String\b`,
  ].join('|'),
  'i'
);

/** Verbs/operators that WRITE something on disk: copies, moves, content setters, archivers, redirect operators, permission/attribute changers. */
const SHELL_WRITEISH = new RegExp(
  [
    String.raw`\b(?:copy|copy-item|cp|x.copy|xcopy|robocopy|move|move-item|mv)\b`,
    String.raw`\b(?:ren|rename|rename-item)\b`,
    String.raw`\b(?:set-content|add-content|out-file|export-\w+|new-item|new-itemproperty)\b`,
    String.raw`\b(?:tee|tee-object|install|msiexec|expand|unzip|tar|makecab|compact)\b`,
    String.raw`\b(?:chmod|chown|chgrp|setfacl|attrib|icacls|takeown|cacls)\b`,
    String.raw`\b(?:touch|truncate|dd|mkfs(?:\.\w+)?)\b`,
    String.raw`>{1,2}`, // shell redirection writes
  ].join('|'),
  'i'
);

/**
 * Path-shaped tokens inside a command: quoted strings, drive paths, UNC, %VAR% and $env:
 * forms, and absolute POSIX paths. Round 21 (CHANGE 7 audit): the POSIX branch used to
 * recognize only the well-known OS roots (/etc, /usr, …) — an ordinary ABSOLUTE workspace
 * path (/home/…/link/file, /tmp/…) was not a token at all, so the symlink closure never
 * saw it and a workspace symlink into OS territory stayed a live bypass on POSIX. General
 * absolute POSIX paths are tokens now; the character after "/" must be name-like so a
 * bare "/" or a "//" URL protocol separator cannot match.
 */
/** Characters that terminate an unquoted path token (whitespace, pipes, redirection, quotes; \x60 = backtick). Same class as the pre-Round-21 token pattern, plus the general POSIX branch. */
const NOTSEP = '[^\\s"\'|;&<>\\)\\x60]';
const POSIX_ABS_TOKEN = String.raw`(?:/(?:etc|boot|bin|sbin|usr|lib|lib64|sys|proc|dev|system)(?:/` + NOTSEP + `*)?|/[A-Za-z0-9._~+@%-]` + NOTSEP + `*)`;
const TOKEN_BODY = '"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|(?:[a-z]:[\\\\/]' + NOTSEP + '*)|(?:\\\\\\\\' + NOTSEP + '+)|(?:%[A-Za-z_()0-9]+%' + NOTSEP + '*)|(?:\\$env:[A-Za-z_()0-9]+' + NOTSEP + '*)|' + POSIX_ABS_TOKEN;
const SHELL_PATH_TOKEN = new RegExp(TOKEN_BODY, 'gi');

/** Flagless copy of the token pattern: `.test()` on a /g regex is stateful and must not be used for the source check. */
const SHELL_PATH_TOKEN_SRC = new RegExp(TOKEN_BODY, 'i');

/**
 * Strip a leading VARNAME= (INSTALLDIR=, -DCMAKE_INSTALL_PREFIX=/etc) from a token.
 * A single letter followed by ':' that starts a drive path (C:\…) is NEVER a variable name.
 */
const stripAssign = (t: string): string => {
  let out = t;
  const m = /^([a-z_][\w.()-]*)\s*([=:])\s*/i.exec(out);
  const isDrive = !!m && m[1].length === 1 && m[2] === ':' && /^[a-z]:[\\/]/i.test(out);
  if (m && !isDrive) out = out.slice(m[0].length);
  return out.replace(/^-[a-z][\w-]*\s*[=\s]\s*/i, '');
};

/** Expand a token to a comparable path: unquote, expand OS env vars, fold short names. */
const normalizeToken = (t: string): string => foldShortNames(expandWinEnv(t.replace(/^["']|["']$/g, '')));

/**
 * Collect path-shaped tokens, DESCENDING into quoted strings: a whole quoted command blob
 * ("Set-Content -Path C:\Windows\x") is one token to the plain extractor, and the write
 * target hides inside it.
 */
function collectPaths(s: string): Array<{ raw: string; start: number }> {
  const out: Array<{ raw: string; start: number }> = [];
  for (const m of s.matchAll(SHELL_PATH_TOKEN)) {
    out.push({ raw: m[0], start: m.index ?? 0 });
    const unq = m[0].replace(/^["']|["']$/g, '');
    if (unq !== m[0]) out.push(...collectPaths(unq));
  }
  return out;
}

export type ShellVerdict = { blocked: boolean; kind?: 'deletion' | 'os-resource'; reason?: string };

/**
 * Round 20 (CHANGE 10): SYMLINK/JUNCTION CLOSURE for shell and interpreter paths.
 * The file-tool route resolves symlinks (guard.classifyPathRisk); the shell layer used to
 * classify LITERAL strings only — a workspace symlink pointing into C:\Windows made
 * `echo x > C:\ws\link\win.ini` an undetected OS write. Resolution: for the candidate
 * path, realpath the DEEPEST EXISTING ANCHOR (the target itself need not exist — its
 * parent may already be a junction) and classify the REAL path. Relative paths resolve
 * against the JARVIS workspace (the run_command cwd), then the process cwd. Sync on
 * purpose: policy classification is synchronous by contract.
 */
/**
 * Round 21 (CHANGE 2): explicit path-resolution outcome. The old `realpathProtected()`
 * boolean collapsed every resolution failure into `false` ("not protected") — an
 * unresolvable path was silently classified as safe, which is a fail-open security
 * defect. Three outcomes now exist:
 *   - 'protected'     — the resolved real path lands in an OS-protected location.
 *   - 'not-protected' — the path RESOLVED and the real target is an ordinary location.
 *   - 'unresolved'    — the path could NOT be resolved (nonexistent chain with no existing
 *                       anchor, symbolic-link cycle, hop limit exhausted, or a filesystem
 *                       error such as EACCES). The caller must fail closed: an unresolved
 *                       candidate that could name an OS-protected target is never treated
 *                       as confirmed safe.
 */
export type RealPathClass = 'protected' | 'not-protected' | 'unresolved';

/** Deepest-existing-ancestor walk budget. This bounds ANCESTOR climbing for nonexistent
 *  tails; symbolic-link depth itself is resolved (and bounded) by the OS via realpathSync
 *  — a link cycle surfaces as ELOOP and maps to 'unresolved', never to a silent pass. */
const MAX_RESOLVE_HOPS = 16;

export const classifyRealPath = (candidate: string): RealPathClass => {
  const raw = String(candidate ?? '').trim();
  if (!raw) return 'not-protected';
  // Literal shapes (Windows drive roots, UNC admin shares, 8.3 aliases, %ENV% forms,
  // POSIX OS roots) classify WITHOUT touching the disk — on any operating system.
  if (osProtectedPath(raw)) return 'protected';
  if (!/(?:[\\/][^\\/]*)/.test(raw)) return 'not-protected'; // not path-shaped: names no filesystem target
  const full =
    path.isAbsolute(raw) || /^[a-z]:[\\/]/i.test(raw)
      ? path.resolve(raw)
      : path.resolve(process.env.JARVIS_FILES_ROOT ?? process.cwd(), raw);
  // Phase 1 — deepest EXISTING ancestor through realpathSync (handles all symlink
  // indirection of existing parts; a link cycle among them surfaces as ELOOP → unresolved).
  let probe = full;
  let real = '';
  let anchored = false;
  for (let hops = 0; hops <= MAX_RESOLVE_HOPS; hops++) {
    try {
      real = realpathSync(probe);
      anchored = true;
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code ?? '';
      if (code === 'ENOENT') {
        const parent = path.dirname(probe);
        if (parent === probe) return 'unresolved'; // nothing exists to resolve through
        probe = parent;
        continue;
      }
      // ELOOP (symlink cycle), EACCES, EPERM, …: the path cannot be verified — fail closed.
      return 'unresolved';
    }
  }
  if (!anchored) return 'unresolved'; // hop budget exhausted without a resolvable anchor
  if (osProtectedPath(real)) return 'protected';
  const tail = path.relative(probe, full);
  if (!tail || tail === '.') return 'not-protected';
  // Phase 2 — the tail did not exist for realpath, so a DANGLING symbolic-link chain can
  // hide in it (a broken final link whose target still points into OS territory, or a
  // chain of broken links). Walk the chain manually: readlink → follow, bounded, with
  // explicit cycle detection. A cycle or a non-ENOENT error is UNRESOLVED, never "safe".
  let cur = path.join(real, tail);
  const seen = new Set<string>();
  for (let linkHops = 0; ; linkHops++) {
    if (linkHops > MAX_RESOLVE_HOPS) return 'unresolved';
    if (osProtectedPath(cur)) return 'protected';
    let st: import('fs').Stats;
    try {
      st = lstatSync(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') break; // cur is the final static expansion
      return 'unresolved';
    }
    if (!st.isSymbolicLink()) break;
    if (seen.has(cur)) return 'unresolved'; // symlink cycle in the tail
    seen.add(cur);
    let target: string;
    try {
      target = readlinkSync(cur);
    } catch {
      return 'unresolved';
    }
    cur = path.isAbsolute(target) || /^[a-z]:[\\/]/i.test(target) ? path.resolve(target) : path.resolve(path.dirname(cur), target);
  }
  // Phase 3 — classify the final static expansion; an EXISTING result is re-resolved so a
  // deeper existing link structure is judged by its real destination.
  try {
    return osProtectedPath(realpathSync(cur)) ? 'protected' : 'not-protected';
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return osProtectedPath(cur) ? 'protected' : 'not-protected';
    return 'unresolved';
  }
};

/** Convenience for callers that think in booleans: true only when CONFIRMED protected. */
export const realPathProtected = (candidate: string): boolean => classifyRealPath(candidate) === 'protected';

/**
 * Classify a shell command (run_command, or any tool that shells out). Pure; exported for
 * tests and for the tools' own second-layer checks.
 *
 * Three layers, in order: (1) destruction words anywhere in the command — wrappers like
 * `cmd /c` or `bash -lc` cannot hide them; (2) OS-configuration and opaque-payload words;
 * (3) writes aimed at an OS-protected location, detected by pairing a write-ish verb or
 * redirect with a path token that classifies as protected (env-var and 8.3 forms included).
 */
export function shellVerdict(command: string): ShellVerdict {
  const c = String(command ?? '');
  if (!c.trim()) return { blocked: false };
  if (DELETION_CMD.test(c)) return { blocked: true, kind: 'deletion', reason: 'Deleting is disabled on this laptop.' };
  if (OS_CONFIG_CMD.test(c))
    return {
      blocked: true,
      kind: 'os-resource',
      reason: 'Operating-system configuration (boot, services, drivers, protected registry, accounts, security software, power state) is read-only for JARVIS.',
    };
  if (SHELL_WRITEISH.test(c)) {
    for (const m of collectPaths(c)) {
      const candidate = normalizeToken(stripAssign(m.raw));
      // Round 20 (CHANGE 10): the literal check is joined by REALPATH resolution — a
      // symlinked or junctioned target into OS territory is caught exactly like a direct
      // write there, closing the workspace-symlink bypass for shell one-liners.
      // Round 21 (CHANGE 2): resolution is a TRI-STATE. An UNRESOLVED write target
      // (symlink cycle, unresolvable chain, hop exhaustion, fs error) can never be
      // confirmed safe, so the write fails closed instead of silently passing.
      if (!osProtectedPath(candidate)) {
        const real = classifyRealPath(candidate);
        if (real === 'not-protected') continue;
        if (real === 'unresolved')
          return {
            blocked: true,
            kind: 'os-resource',
            reason: `The write target "${clip(candidate, 80)}" could not be resolved on the filesystem, so it cannot be confirmed to be outside OS-protected locations; the operation fails closed.`,
          };
      }
      // Narrow source exception: COPY FROM a protected path (backup reading) followed by
      // another path token — the protected path is the SOURCE, not the write target.
      // MOVE is deliberately NOT exempt (F-02): moving content OUT of an OS-protected
      // location removes it from where the operating system keeps it, which is a
      // modification of that resource. Only copy semantics preserve the original.
      const before = c.slice(Math.max(0, m.start - 40), m.start);
      const after = c.slice(m.start + m.raw.length);
      // robocopy /MOV and /MOVE MOVE the source (it is deleted after the copy), so the
      // copy exception must not apply to a move-flagged robocopy (F-02).
      const moveFlaggedRobocopy = /\brobocopy\b[^&|;]*\/(?:mov|move)\b/i.test(c);
      const sourceOfCopy = !moveFlaggedRobocopy && /\b(?:copy|copy-item|cp|xcopy|robocopy|tar)\s*$/i.test(before.trimEnd()) && SHELL_PATH_TOKEN_SRC.test(after);
      if (!sourceOfCopy) {
        const sourceOfMove = /\b(?:move|move-item|mv)\s*$/i.test(before.trimEnd()) && SHELL_PATH_TOKEN_SRC.test(after);
        return {
          blocked: true,
          kind: 'os-resource',
          reason: sourceOfMove
            ? 'Moving content out of an operating-system location is disabled (OS resources are read-only). Copy it instead if a backup is needed.'
            : 'Writing to an operating-system location through the shell is disabled.',
        };
      }
    }
  }
  // Layer 4 — embedded interpreter payloads (F-01): code after `python -c`, `node -e`,
  // `perl -e` … is executable payload, not command text. Python/Node payloads are
  // classified with their dedicated classifiers; every other interpreter (perl, ruby,
  // php, lua) fails closed on destruction markers and OS-protected targets, because no
  // reliable per-language classifier exists for them.
  for (const p of interpreterPayloads(c)) {
    const v = classifyInterpreterPayload(p);
    if (v.blocked)
      return {
        blocked: true,
        kind: v.kind,
        reason: `${v.reason ?? 'Interpreter payload blocked by policy.'} (embedded one-liner)`,
      };
  }
  // Layer 5 — kill verbs (F-05): stopping an OS-critical process through the shell is the
  // same violation as stop_process by name. Any kill-shaped command that names a
  // protected process — including in arguments and comments — is blocked.
  const kill = killVerbVerdict(c);
  if (kill.blocked) return kill;
  return { blocked: false };
}

/**
 * Extract executable payloads handed to an interpreter through the shell: `python -c …`,
 * `node -e …`, `perl -e …`, `ruby -e …`, `php -r …`, `lua -e …`. The payload is the first
 * quoted chunk after the flag, or (unquoted) the text up to the next unquoted command
 * separator. Extraction is quote-aware so nesting (`python -c "import os; os.remove('x')"`)
 * survives, and an unterminated quote fails closed (the whole remainder is treated as
 * payload). `interpreter` names the binary AS WRITTEN (`python3` stays `python3`); `kind`
 * folds it into the classifier family ('python' | 'node' | 'other'). `payload` and `code`
 * are the same string under both historical field names — callers of either round's API
 * read the same extraction. Ordinary tool invocations (`python -m pytest`,
 * `node server.js`, `gcc -c foo.c`) yield nothing — a compile step is not a payload.
 */
export interface InterpreterPayload {
  interpreter: string;
  payload: string;
  kind: 'python' | 'node' | 'other';
  /** Same string as `payload` (Round 17 field name kept for compatibility). */
  code: string;
}

export function interpreterPayloads(command: string): Array<InterpreterPayload> {
  const c = String(command ?? '');
  if (!c.trim()) return [];
  // Each interpreter with its one-shot evaluation flag(s). gcc/cc's `-c` is deliberately
  // absent: a compile flag is not an execution payload.
  const scanners: Array<{ names: string; flags: string }> = [
    { names: '(?:python3?(?:\\.\\d{1,2})?|py)', flags: '-c' },
    { names: 'node(?:js)?', flags: '(?:-e|--eval|-p|--print)' },
    { names: 'perl', flags: '(?:-e|--execute)' },
    { names: 'ruby', flags: '(?:-e|--eval)' },
    { names: 'php', flags: '(?:-r|--run)' },
    { names: 'lua(?:5\\.\\d)?', flags: '-e' },
  ];
  const found: Array<{ at: number; interpreter: string; payload: string }> = [];
  for (const { names, flags } of scanners) {
    // Round 20 (CHANGE 10): the scanner previously required a command-boundary prefix
    // ([&|;(]) AND whitespace after the flag — payloads on a CONTINUATION LINE
    // ("cmd\npython -c \"…\"") and quote-attached flags (python -c"…") were invisible to
    // extraction. Newlines count as boundaries now, and the post-flag whitespace is
    // optional (extractPayload handles both quoted and bare payloads).
    const re = new RegExp(`(?:^|[&|;(\\r\\n])\\s*\\b(${names})(?:\\.exe)?\\b[^&|;\\r\\n]*?\\s${flags}\\s*`, 'gi');
    for (const m of c.matchAll(re)) {
      const rest = c.slice((m.index ?? 0) + m[0].length);
      const payload = extractPayload(rest);
      if (payload.trim()) found.push({ at: m.index ?? 0, interpreter: m[1].toLowerCase(), payload });
    }
  }
  // Command order is report order: `node -e "a()" ; python3 -c '…'` lists node first.
  return found
    .sort((a, b) => a.at - b.at)
    .map(({ interpreter, payload }) => ({
      interpreter,
      payload,
      kind: (interpreter.startsWith('py') ? 'python' : interpreter.startsWith('node') ? 'node' : 'other') as InterpreterPayload['kind'],
      code: payload,
    }));
}

/** The payload after an interpreter flag: a quoted chunk (with escapes) or the unquoted run up to a command separator. */
function extractPayload(rest: string): string {
  const q = rest[0];
  if (q === '"' || q === "'") {
    let body = '';
    for (let i = 1; i < rest.length; i++) {
      const ch = rest[i];
      if (ch === '\\' && i + 1 < rest.length) {
        body += ch + rest[i + 1];
        i++;
        continue;
      }
      if (ch === q) return body;
      body += ch;
    }
    // Unterminated quote: fail closed — treat the whole remainder as the payload.
    return body || rest.slice(1);
  }
  // Unquoted: the payload ends at the first unquoted separator sequence.
  const cut = rest.search(/&&|\|\||;|\|/);
  return cut === -1 ? rest : rest.slice(0, cut);
}

// ---------------------------------------------------------------- node payload classification

const NODE_WRITEISH =
  /\bwriteFileSync\b|\bwriteFile\b|\bappendFileSync?\b|\bopenSync?\b|\bcreateWriteStream\b|\bfsp?\s*\.\s*open\b|\bfs\s*\.\s*promises\b|\brequire\s*\(\s*['"]fs['"]\s*\)/;

/** Destruction APIs in a Node/JS payload — blocked outright, target-independent. */
const NODE_DELETION =
  /\brmSync\b|\brmdirSync\b|\bunlinkSync\b|\bfs\s*\.\s*(?:rm|rmdir|unlink)\b|\bfs\s*\.\s*promises\s*\.\s*(?:rm|rmdir|unlink)\b|\brimraf\b|\.\s*unlink\s*\(/;

/** Dynamic evaluation cannot be classified — fail closed (F-01). */
const NODE_DYNAMIC = /\beval\s*\(|\bnew\s+Function\s*\(/;

/** Raw process termination through a one-liner: the pid cannot be identity-verified (F-05). */
const NODE_PROCESS_KILL = /\bprocess\s*\.\s*(?:kill|abort)\s*\(/;

/**
 * Classify a Node/JS one-liner payload the way pythonVerdict classifies Python: destruction
 * APIs are blocked outright (target-independent), dynamic evaluation fails closed, raw pid
 * termination fails closed, and a write API plus an OS-protected path literal is blocked.
 */
export function nodeVerdict(code: string): CodeVerdict {
  const raw = String(code ?? '');
  if (!raw.trim()) return { blocked: false };
  if (NODE_DELETION.test(raw))
    return { blocked: true, kind: 'deletion', reason: 'Node one-liner blocked: deleting files is disabled. Use the dedicated tools.' };
  if (NODE_PROCESS_KILL.test(raw))
    return { blocked: true, kind: 'os-resource', reason: 'Node one-liner blocked: terminating processes through a one-liner is disabled (the pid cannot be identity-verified).' };
  if (NODE_DYNAMIC.test(raw))
    return { blocked: true, kind: 'os-resource', reason: 'Node one-liner blocked: dynamically constructed code cannot be classified, so it fails closed.' };
  const literals = [...raw.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)]
    .map((m) => (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\([\\'"`])/g, '$1'))
    .filter((l) => l.length > 3);
  // Round 20 (CHANGE 10): realpath closure joins the literal check (template literals
  // included in the scan) — a symlinked workspace target is caught like a direct one.
  // Round 21 (CHANGE 2): unresolved targets fail closed for write-capable payloads.
  const touchesProtected = literals.some((l) => writeTargetUnsafe(l));
  if (touchesProtected && NODE_WRITEISH.test(raw))
    return { blocked: true, kind: 'os-resource', reason: 'Node one-liner blocked: writing to an operating-system location is disabled.' };
  return nodeProcessVerdict(raw);
}

/** Back-compat alias (Round 17 name) — one implementation. */
export const nodeJsVerdict = nodeVerdict;

/**
 * Round 21 (CHANGE 1 + audit): process creation through a Node one-liner is ordinary and
 * allowed — but the spawned command must satisfy the SAME two restrictions as a shell
 * one-liner. `child_process` exec/spawn calls with STATIC literal arguments are
 * reassembled and classified with shellVerdict; dynamic arguments fail closed (the target
 * cannot be resolved). Fires only when child_process is actually in play, so an ordinary
 * payload that happens to define its own exec() helper is untouched.
 */
export function nodeProcessVerdict(code: string): CodeVerdict {
  const raw = String(code ?? '');
  if (!raw.trim()) return { blocked: false };
  if (!/\bchild_process\b/.test(raw)) return { blocked: false };
  const callRe = /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(/g;
  for (const m of matchInCodeRegions(raw, callRe, 'js')) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const args = callArgsText(raw, open);
    if (args === null)
      return { blocked: true, kind: 'os-resource', reason: 'Node one-liner blocked: the child_process call is never closed — its command cannot be classified, so it fails closed.' };
    if (!args.trim()) continue;
    const literals: string[] = [];
    const residue = args.replace(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g, (_all, dq: string, sq: string) => {
      literals.push((dq ?? sq ?? '').replace(/\\([\\'])/g, '$1'));
      return ' ';
    });
    // Node exec options are identifier=value pairs (cwd, env, shell, timeout…); anything
    // else (a variable, a template substitution) is an unresolvable command → fail closed.
    const OPT = /^(?:cwd|env|shell|timeout|killSignal|maxBuffer|encoding|uid|gid|stdio|detached|windowsHide|windowsVerbatimArguments|argv0|serialization)$/i;
    const staticArgs = residue
      .split(/[^\w.]+/)
      .filter(Boolean)
      .every((tok) => OPT.test(tok) || /^(?:true|false|null|undefined|\d+(?:\.\d+)?)$/i.test(tok));
    if (!staticArgs)
      return {
        blocked: true,
        kind: 'os-resource',
        reason: 'Node one-liner blocked: the child_process command is not a static literal, so its target cannot be resolved; it could name a destructive or OS-protected operation and fails closed.',
      };
    if (!literals.length) continue;
    const plain = literals.join(' ');
    const quoted = literals.map((l) => `"${l.replace(/"/g, '\\"')}"`).join(' ');
    for (const command of [plain, quoted]) {
      const v = shellVerdict(command);
      if (v.blocked)
        return { blocked: true, kind: v.kind, reason: `${v.reason ?? 'Blocked by policy.'} (spawned from Node)` };
    }
  }
  return { blocked: false };
}

/**
 * Round 21 (CHANGE 2): the shared literal-target gate for write-capable code payloads.
 * A literal is unsafe when it IS a protected location (literally or through symlinks) or
 * when it names a filesystem target that cannot be resolved — an unresolvable write target
 * must fail closed, not pass as "not protected". Non-path strings (words, URLs without a
 * filesystem shape) resolve to 'not-protected' and never block on their own.
 */
const writeTargetUnsafe = (literal: string): boolean => {
  if (osProtectedPath(literal)) return true;
  return classifyRealPath(literal) !== 'not-protected';
};

/**
 * GENERIC INTERPRETER PAYLOAD CLASSIFIER (F-01) — perl, ruby, php, lua and any future
 * one-liner host have no reliable per-language parser, so the policy fails closed on
 * the two hard restrictions: destruction markers anywhere in the payload are deletion;
 * ANY operation (a call) touching an OS-protected path is a modification attempt.
 * Benign output payloads (print, puts, echo) stay allowed.
 */
const GENERIC_DELETION =
  /\bunlink\s*\(|\brmtree\b|\bos\s*\.\s*(?:remove|unlink|rmdir|removedirs)\s*\(|\bunlinkSync\b|\brmdirSync\b|\bFileUtils\s*\.\s*(?:rm|remove|unlink)\b|\bFile\s*\.\s*(?:delete|unlink)\s*\(|\brimraf\b|\bRemove-Item\b/;

function classifyInterpreterPayload(p: { interpreter: string; payload: string }): CodeVerdict {
  if (p.interpreter.startsWith('py')) return pythonVerdict(p.payload);
  if (p.interpreter.startsWith('node')) return nodeVerdict(p.payload);
  const code = String(p.payload ?? '');
  if (!code.trim()) return { blocked: false };
  if (GENERIC_DELETION.test(code))
    return { blocked: true, kind: 'deletion', reason: `${p.interpreter} one-liner blocked: deleting files is disabled.` };
  const literals = [...code.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
  // Round 21 (CHANGE 2): unresolved targets fail closed here too.
  const touchesProtected = literals.some((l) => writeTargetUnsafe(l)) || writeTargetUnsafe(code);
  if (touchesProtected && /\w\s*\(/.test(code))
    return { blocked: true, kind: 'os-resource', reason: `${p.interpreter} one-liner blocked: an unclassifiable operation against an operating-system location fails closed.` };
  return { blocked: false };
}

/**
 * Classify a WHOLE command line for its interpreter payloads (public second-layer API
 * used by tools and tests): every embedded payload is classified; the first block wins.
 */
export function interpreterVerdict(command: string): CodeVerdict {
  for (const p of interpreterPayloads(command)) {
    const v = classifyInterpreterPayload(p);
    if (v.blocked) return v;
  }
  return { blocked: false };
}

// ------------------------------------------------------------------ python classification

/** Strip comments and string literals so deny patterns cannot hide in (or be falsely created by) quoted text. Escapes are handled inside the literals, so nothing is corrupted mid-string. */
export function stripPythonStrings(code: string): string {
  return String(code ?? '')
    .replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, '""') // docstrings / triple quotes
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""') // single-line literals
    .replace(/#[^\n]*/g, ''); // comments last: a "#" inside a literal is already gone
}

const PY_DENY_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\bos\.(remove|unlink|rmdir|removedirs)\b|\bshutil\.rmtree\b|\bshutil\.unlink\b|\bsend2trash\b|\.(unlink|rmdir)\(/, why: 'deleting files' },
  // Round 21 (CHANGE 1): the blanket `subprocess` / `os.system` deny was a THIRD
  // restriction the policy does not have — ordinary process creation (running tests,
  // builds, git, dev tools) from Python is allowed. Process-spawning calls are now
  // classified against the two hard restrictions by pythonProcessVerdict below: the
  // spawned command text is classified with shellVerdict; a non-static command fails
  // closed because its target cannot be resolved.
  { re: /\b__import__\b|\bimportlib\b/, why: 'dynamic imports' },
  { re: /\beval\s*\(|\bexec\s*\(|\bcompile\s*\(/, why: 'dynamic execution' },
  { re: /\bctypes\b|\bpythonnet\b|\bwin32api\b|\bwin32com\b|\bwmi\b|\bwinreg\b/, why: 'native OS / registry access' },
  { re: /\bgetattr\s*\(|\bsetattr\s*\(|\bglobals\s*\(|\blocals\s*\(|\bvars\s*\(/, why: 'dynamic attribute access (fail-closed)' },
];

export type CodeVerdict = { blocked: boolean; kind?: 'deletion' | 'os-resource'; reason?: string };

/** Clip a string for use inside a one-line policy reason. */
const clip = (t: string, n = 120): string => (t.length > n ? `${t.slice(0, n)}…` : t);

/**
 * Extract the balanced-parentheses argument text after a call site (single/double-quoted
 * Python string literals with escapes are skipped whole so parens inside strings cannot
 * unbalance the scan). Returns null when the parens never close (unterminated — caller
 * fails closed).
 */
function callArgsText(code: string, openIdx: number): string | null {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"' || ch === "'") {
      const q = ch;
      i++;
      while (i < code.length && code[i] !== q) {
        if (code[i] === '\\') i++;
        i++;
      }
      continue; // closing quote (or end — the outer loop then also ends)
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return code.slice(openIdx + 1, i);
    }
  }
  return null;
}

/** Process-spawning calls, per module family: subprocess.*, os.* and their aliases. */
const PY_PROC_CALLS = /^(?:run|call|check_call|check_output|Popen|getoutput|getstatusoutput|system|popen|exec\w*|spawn\w*|startfile|fork)$/;

/**
 * Round 21 (CHANGE 1): classify process creation from Python against the TWO hard
 * restrictions, not against a third "no subprocess" rule. Every spawning call site
 * (subprocess.run and Popen, os.system / popen / exec-family / spawn-family / startfile /
 * fork, their "import … as" aliases and "from subprocess import run" names) has its
 * argument text extracted:
 *   - STATIC arguments (string literals, lists/tuples of them, keyword arguments like
 *     shell=False, cwd="…", booleans and numbers) have their command text reassembled and
 *     classified with shellVerdict — deletion words, OS-configuration words and
 *     OS-protected write targets are caught exactly like a shell one-liner.
 *   - DYNAMIC arguments (variables, f-string substitutions, concatenation with
 *     non-literals) name an unresolvable command that could be anything — they fail
 *     closed (ambiguous target).
 * Ordinary dev commands (`subprocess.run(["npm", "test"])`) classify as allowed.
 * Matches are located in CODE regions only (a scanner skips string literals, f-string
 * braces excluded, and comments), so a quoted or commented example cannot trigger — or
 * hide — a verdict.
 */
export function pythonProcessVerdict(rawCode: string): CodeVerdict {
  const raw = String(rawCode ?? '');
  if (!raw.trim()) return { blocked: false };
  // Alias tracking: `import subprocess as sp` / `from os import system` make the call
  // sites appear under other names; collect the names so the scan cannot be dodged by
  // renaming, while ordinary user functions with those names are only matched when such
  // an import is actually present (comments/strings excluded by the region scan).
  const aliases = new Set<string>(['subprocess', 'os']);
  let sawProcImport = false; // bare-name calls only classify when such an import exists
  for (const m of matchInCodeRegions(raw, /\bimport\s+(?:subprocess|os)(?:\s+as\s+(\w+))?|\bfrom\s+(?:subprocess|os)\s+import\s+([\w\s,]+)/g)) {
    sawProcImport = true;
    if (m[1]) aliases.add(m[1]);
    for (const name of (m[2] ?? '').split(',')) {
      const n = name.trim();
      if (n) aliases.add(n);
    }
  }
  const fns = [...new Set(['run', 'call', 'check_call', 'check_output', 'Popen', 'getoutput', 'getstatusoutput', 'system', 'popen', 'startfile', 'fork', 'exec', 'execl', 'execle', 'execlp', 'execv', 'execve', 'execvp', 'spawn', 'spawnl', 'spawnv'])].map(escapeRe).join('|');
  const mods = [...aliases].map(escapeRe).join('|');
  // Module-qualified call sites always classify; BARE call sites (from subprocess import
  // run → run(…)) only classify when the matching import is actually present, so an
  // ordinary helper that happens to be named `run` is never swept in.
  const callRe = new RegExp(`\\b(?:${mods})\\s*\\.\\s*\\b(${fns})\\s*\\(`, 'g');
  const bareRe = sawProcImport ? new RegExp(`\\b(${fns})\\s*\\(`, 'g') : null;
  for (const m of [...matchInCodeRegions(raw, callRe), ...(bareRe ? matchInCodeRegions(raw, bareRe) : [])]) {
    const fn = m[1];
    if (!PY_PROC_CALLS.test(fn)) continue;
    const open = (m.index ?? 0) + m[0].length - 1; // the '(' the regex ended on
    const args = callArgsText(raw, open);
    if (args === null)
      return { blocked: true, kind: 'os-resource', reason: `Python code blocked: ${fn}(…) is never closed — the spawned command cannot be classified, so it fails closed.` };
    if (!args.trim()) continue; // argument-less (os.fork())
    // Static check: after removing literals, only structural punctuation and whitelisted
    // keyword arguments may remain.
    const literals: string[] = [];
    const residue = args.replace(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g, (_all, dq: string, sq: string) => {
      literals.push((dq ?? sq ?? '').replace(/\\([\\'"])/g, '$1'));
      return ' ';
    });
    const KW = /^(?:shell|check|capture_output|text|cwd|env|timeout|input|errors|bufsize|close_fds|creationflags|stdout|stderr|stdin|universal_newlines|expanduser|start_new_session|restore_signals|group|user|extra_groups|umask|pipesize|process_group)$/i;
    const staticArgs = residue
      .split(/[^\w.]+/)
      .filter(Boolean)
      .every((tok) => KW.test(tok) || /^(?:True|False|None)$/.test(tok) || /^\d+(?:\.\d+)?$/.test(tok));
    if (!staticArgs)
      return {
        blocked: true,
        kind: 'os-resource',
        reason: `Python code blocked: the command given to ${fn}(…) is not a static literal, so its target cannot be resolved; it could name a destructive or OS-protected operation and fails closed.`,
      };
    if (!literals.length) continue; // only keyword flags — no command text to classify
    // Reassemble the command BOTH ways: a plain join preserves multi-word command grammar
    // (`reg add HKLM\…`, `git clean`), a quoted join preserves script payloads handed to
    // interpreters (`python -c "import os; os.remove('x')"`). Either shape blocking = block.
    const plain = literals.join(' ');
    const quoted = literals.map((l) => `"${l.replace(/"/g, '\\"')}"`).join(' ');
    for (const command of [plain, quoted]) {
      const v = shellVerdict(command);
      if (v.blocked)
        return { blocked: true, kind: v.kind, reason: `${v.reason ?? 'Blocked by policy.'} (spawned from Python)` };
    }
  }
  return { blocked: false };
}

/**
 * Run a regex over ONLY the code regions of a source snippet: string literals (single,
 * double, triple-quoted; backticks for 'js') and comments (# for Python, // and slash-star
 * for js) are skipped, so text inside them can neither trigger nor be mistaken for a
 * call site. Returns all matches with their indices.
 */
function matchInCodeRegions(code: string, re: RegExp, lang: 'python' | 'js' = 'python'): RegExpMatchArray[] {
  const regions: Array<[number, number]> = [];
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    const lineComment = lang === 'python' ? ch === '#' : ch === '/' && code[i + 1] === '/';
    const blockComment = lang === 'js' && ch === '/' && code[i + 1] === '*';
    if (lineComment || blockComment) {
      if (blockComment) {
        const end = code.indexOf('*/', i + 2);
        const stop = end < 0 ? n : end + 2;
        regions.push([i, stop]);
        i = stop;
      } else {
        const nl = code.indexOf('\n', i);
        regions.push([i, nl < 0 ? n : nl]);
        i = nl < 0 ? n : nl + 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || (lang === 'js' && ch === '`')) {
      const triple = lang === 'python' && code.slice(i, i + 3) === ch.repeat(3);
      const q = triple ? ch.repeat(3) : ch;
      let j = i + q.length;
      while (j < n) {
        if (code[j] === '\\') { j += 2; continue; }
        if (code.startsWith(q, j)) { j += q.length; break; }
        j++;
      }
      regions.push([i, Math.min(j, n)]);
      i = Math.min(j, n);
      continue;
    }
    i++;
  }
  const inString = (at: number): boolean => regions.some(([a, b]) => at >= a && at < b);
  const out: RegExpMatchArray[] = [];
  for (const m of code.matchAll(re)) {
    if (!inString(m.index ?? 0)) out.push(m);
  }
  return out;
}

/**
 * Classify Python source before execution. Regex-based by design (no parser dependency),
 * but fail-closed: every dynamic-access construct that could smuggle a forbidden call is
 * itself denied, and OS-protected path literals combined with any write-capable call are
 * denied. `stripPythonStrings` runs first so "os.remove" mentioned inside a string cannot
 * cause a false block — and code hidden behind escapes cannot cause a false allow.
 */
export function pythonVerdict(code: string): CodeVerdict {
  const raw = String(code ?? '');
  if (!raw.trim()) return { blocked: false };
  const clean = stripPythonStrings(raw);
  for (const { re, why } of PY_DENY_PATTERNS) {
    if (re.test(clean)) return { blocked: true, kind: 'deletion', reason: `Python code blocked: ${why} is disabled. Use the dedicated tools.` };
  }
  // Writes aimed at OS-protected locations: literals are read from the RAW code (the stripped copy replaced them with "").
  // Round 20 (CHANGE 10): realpath closure joins the literal check.
  // Round 21 (CHANGE 2): unresolved targets fail closed for write-capable code.
  const literals = [...raw.matchAll(/"""([\s\S]*?)"""|'''([\s\S]*?)'''|"([^"\n]+)"|'([^'\n]+)'/g)]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? '')
    .flatMap((l) => l.split(/[\n\r]/));
  const touchesProtected = literals.some((l) => l.length > 3 && writeTargetUnsafe(l));
  const writeCapable = /\bopen\s*\(|\bshutil\.|\bos\.(replace|rename|truncate|makedirs|mkdir)\b|pathlib/i.test(clean);
  if (touchesProtected && writeCapable)
    return { blocked: true, kind: 'os-resource', reason: 'Python code blocked: writing to an operating-system location is disabled.' };
  return pythonProcessVerdict(raw);
}

// ---------------------------------------------------------------- browser JS classification

/**
 * Round 21 (CHANGE 1): .reg file content verdict. A registry-import file names its write
 * targets in its section headers, so the two hard restrictions are enforced against the
 * REAL targets: writes into HKLM / HKCR / HKU / HKCC are OS-resource modification; HKCU
 * persistence points (Run / RunOnce / Policies / System) are OS configuration. Ordinary
 * HKCU application settings stay allowed (consistent with `reg add hkcu` handling).
 */
export function regFileVerdict(content: string): CodeVerdict {
  const text = String(content ?? '');
  if (!text.trim()) return { blocked: false };
  for (const m of text.matchAll(/^\s*\[([^\]]+)\]/gm)) {
    const h = m[1].trim();
    if (/^HKEY_(?:LOCAL_MACHINE|CLASSES_ROOT|USERS|CURRENT_CONFIG)(?:\\|$)/i.test(h))
      return { blocked: true, kind: 'os-resource', reason: `The registry file writes to a protected hive (${h}) — operating-system configuration is read-only for JARVIS.` };
    if (/^HKEY_CURRENT_USER\\(?:[^\\]+\\)*(?:Run|RunOnce|Policies|System)(?:\\|$)/i.test(h))
      return { blocked: true, kind: 'os-resource', reason: `The registry file writes to an operating-system configuration area (${h}) which is read-only for JARVIS.` };
  }
  return { blocked: false };
}

/**
 * Round 21 (CHANGE 1): generic script-content verdict for script families without a
 * dedicated classifier (.vbs/.vbe/.wsf/.hta). Only the two hard restrictions are judged —
 * the script runs otherwise; opacity is not a restriction. Destruction markers: the
 * Scripting.FileSystemObject deletion methods and the VBS `Kill` statement.
 */
export function genericScriptVerdict(content: string): CodeVerdict {
  const text = String(content ?? '');
  if (!text.trim()) return { blocked: false };
  if (/\.DeleteFile\s*\(|\.DeleteFolder\s*\(|\.DeleteKey\s*\(|\bKill\s+(?:"|'|[A-Za-z_])/i.test(text))
    return { blocked: true, kind: 'deletion', reason: 'The script deletes files or folders, and deleting is disabled on this laptop.' };
  return { blocked: false };
}

const BROWSER_JS_DENY = new RegExp(
  [
    String.raw`\blocalStorage\.clear\s*\(`,
    String.raw`\bsessionStorage\.clear\s*\(`,
    String.raw`\bindexedDB\.deleteDatabase\s*\(`,
    String.raw`\bcaches\.delete\s*\(`,
    String.raw`\bcookieStore\.delete\s*\(`,
    String.raw`document\.cookie\s*=[^;\n]*expires\s*=\s*[^;\n]*1970`,
  ].join('|'),
  'i'
);

/** Classify JavaScript handed to browser_eval: wiping site storage / cookies is deletion of browser data. */
export function browserJsVerdict(js: string): CodeVerdict {
  const j = String(js ?? '');
  if (!j.trim()) return { blocked: false };
  if (BROWSER_JS_DENY.test(j))
    return { blocked: true, kind: 'deletion', reason: 'Blocked: clearing site storage, cookies or caches is deletion of browser data, which is disabled.' };
  return { blocked: false };
}

// --------------------------------------------------------------------- UI label classification

/**
 * DELETION-class controls: clicking them destroys data, so under the single policy they are
 * hard-blocked (no dialog exists to approve them). Account/session management (sign out,
 * unsubscribe) is ordinary account management and stays ALLOWED; so are the consequential
 * actions the policy explicitly permits (send, publish, purchase).
 */
const DESTRUCTIVE_LABEL =
  /\b(delete|deleted|deleting|remove|removed|removing|erase|wipe|discard|discarding|trash|move to trash|empty (?:the )?(?:recycle|trash|bin)|uninstall|deactivate|permanently delete|close account|cancel account|delete (?:my )?account|format (?:this |the )?(?:pc|device|drive|disk)|factory reset|reset (?:this )?(?:pc|device|phone)|clear (?:all|history|browsing data|data))\b/i;

/**
 * DELETION-class URL endpoints: the link target often states the real effect when the
 * button label does not ("Continue" → /account/delete). Word-delimited so /delivery or
 * /nodelete-all never match; deliberately tight (delete/destroy/erase/purge/wipe/unlink/
 * uninstall/deactivate) to limit over-blocking of ordinary page URLs.
 */
const DESTRUCTIVE_URL = /(?:^|[\W_])(?:delete|deleted|destroy|destroyed|erase|purge|wipe|unlink|uninstall|deactivate)(?:[\W_]|$)/i;

/** Consequential-but-allowed controls, kept as a named export for the capability manifest and tests. */
export const CONSEQUENTIAL_LABEL =
  /\b(send|post|publish|submit|pay|purchase|buy|checkout|place order|confirm (?:order|purchase|payment)|transfer|withdraw|overwrite|replace all|save|update|install)\b/i;

export type LabelVerdict = { blocked: boolean; kind?: 'deletion'; reason?: string };

/** Classify a button/menu/screen label before clicking it. */
export function labelVerdict(label: string): LabelVerdict {
  const l = String(label ?? '');
  if (!l.trim()) return { blocked: false };
  if (DESTRUCTIVE_LABEL.test(l)) return { blocked: true, kind: 'deletion', reason: `"${l.trim().slice(0, 60)}" deletes something, and deleting is disabled on this laptop.` };
  return { blocked: false };
}

/**
 * Classify the URL behind a click or navigation. Only the path and query are judged (a
 * host named delete.example.com must not block every link on it). KNOWN LIMIT, pinned by
 * tests: a destructive action whose label AND URL reveal nothing (a POST handler behind a
 * neutral route, or a bare coordinate click) cannot be classified from the outside — the
 * click guard is a heuristic boundary, not a sandbox. The model-facing hard limits state
 * the rule; this layer enforces what is observable.
 */
export function urlVerdict(url: string): LabelVerdict {
  const u = String(url ?? '');
  if (!u.trim()) return { blocked: false };
  let target = u;
  try {
    const parsed = new URL(u);
    target = `${parsed.pathname}${parsed.search}`;
  } catch {
    /* relative or malformed: judge the raw string */
  }
  if (DESTRUCTIVE_URL.test(target))
    return { blocked: true, kind: 'deletion', reason: `This action (${u.trim().slice(0, 80)}) deletes something, and deleting is disabled on this laptop.` };
  return { blocked: false };
}

// ------------------------------------------------------------------------ process classification

export type ProcessVerdict = { blocked: boolean; kind?: 'os-resource'; reason?: string };

/**
 * THE protected-process list (F-05): the single source of truth for which processes may
 * never be stopped — OS internals, security software and JARVIS itself. processVerdict,
 * isCriticalProcess and the shell kill-verb layer all consult THIS list; no module keeps
 * a second one.
 */
export const PROTECTED_PROCESS_NAMES: string[] = [
  // Windows kernel and session internals
  'system', 'registry', 'memory compression', 'idle', 'smss', 'csrss', 'wininit', 'winlogon',
  'services', 'lsm', 'svchost', 'lsass', 'dwm', 'fontdrvhost', 'sihost', 'taskhostw', 'runtimebroker',
  // Windows service hosts
  'spoolsv', 'sched',
  // Security software
  'windefend', 'msmpeng', 'securityhealthservice', 'securityhealthsystray',
  // The user's shell — killing it destroys the working session
  'explorer',
  // JARVIS itself, however it is named on disk
  'jarvis', 'jarvis-electron', 'electron',
];

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CRITICAL_PROCESS = new RegExp(`^(?:${PROTECTED_PROCESS_NAMES.map(escapeRe).join('|')})$`, 'i');

/** Shell commands that STOP a process — taskkill, Stop-Process, POSIX kill and friends. */
const KILL_VERB = /\b(?:taskkill|tskill|pkill|kill|killall|stop-process|pskill)\b/i;

/**
 * F-05: a kill-shaped shell command must not reach a protected process by ANY spelling of
 * its name — /IM flags, -Name parameters, comments included. If the command is kill-shaped
 * and mentions a protected name anywhere, it fails closed, from the same list stop_process
 * uses. Ordinary commands without a kill verb are untouched.
 */
export function killVerbVerdict(command: string): ProcessVerdict {
  const c = String(command ?? '');
  if (!KILL_VERB.test(c)) return { blocked: false };
  for (const name of PROTECTED_PROCESS_NAMES) {
    const re = new RegExp(`(?:^|[^a-z0-9_])${escapeRe(name)}(?:\\.exe)?(?:$|[^a-z0-9_])`, 'i');
    if (re.test(c))
      return {
        blocked: true,
        kind: 'os-resource',
        reason: `"${name}" is an operating-system or security-critical process; stopping it through the shell is disabled.`,
      };
  }
  return { blocked: false };
}

/** THE one protected-process classifier (F-04/F-05): every stop/kill route resolves its
 *  target to a name and consults exactly this verdict — no module keeps a second list. */
export const isCriticalProcess = (name: string): boolean =>
  CRITICAL_PROCESS.test(String(name ?? '').trim().replace(/\.exe$/i, ''));

/** Classify stopping a process by name or pid-carrying name. */
export function processVerdict(name: string): ProcessVerdict {
  const n = String(name ?? '').trim().replace(/\.exe$/i, '');
  if (!n) return { blocked: false };
  if (CRITICAL_PROCESS.test(n))
    return { blocked: true, kind: 'os-resource', reason: `"${n}" is an operating-system or security-critical process (or JARVIS itself); stopping it is disabled.` };
  return { blocked: false };
}

// ------------------------------------------------------------------------------- the two limits

/** The authoritative statement of the two hard restrictions, for prompts and the manifest. */
export const HARD_LIMITS: string[] = [
  'Deletion is disabled everywhere: files, folders, project data, browser or site data, messages, records and accounts can never be deleted through any tool, agent or background job. Consequential actions (send, publish, purchase, submit, sign out, account settings) run automatically.',
  'Operating-system resources are read-only: Windows directories, Program Files, ProgramData, drivers, boot configuration, services, protected registry areas, other accounts, security software and power state (shutdown/restart) cannot be modified. Ordinary project files, development configuration, application settings and user documents stay fully editable.',
];

export const POLICY_STATEMENT =
  'Operating policy (single mode, no approval dialogs): every supported action runs automatically; the ONLY hard blocks are deletion and modification of operating-system resources. Do not retry a BLOCKED action another way; say it is disabled.';
