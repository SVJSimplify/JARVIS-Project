import { promises as fs } from 'fs';
import * as path from 'path';
import { labelFor, hrefFor } from './browser';
import { FILES_ROOT } from './workspace';
import {
  browserJsVerdict,
  classifyRealPath,
  genericScriptVerdict,
  labelVerdict,
  nodeVerdict,
  osProtectedPath,
  processVerdict,
  pythonVerdict,
  regFileVerdict,
  shellVerdict,
  urlVerdict,
} from './policy';
import { isJarvisPid, resolveProcessName } from './procInfo';

/**
 * RISK ASSESSMENT — the policy classifier front-end feeding the authorization gate.
 *
 * SINGLE POLICY, NO PROMPTS: assessRisk returns a Risk ONLY for the two hard restrictions
 * (deletion, OS-resource modification) — every such Risk carries block:true and is denied
 * unconditionally by permission.authorize. Everything else returns null and runs without
 * asking. The old approval-card risks (overwrite, move, upload, run-python…) are gone:
 * there is no confirmation UI to route them to and the policy allows them automatically.
 */

export interface Risk {
  title: string;
  detail: string;
  /** Never allowed, not even with approval (deleting, OS resources). assessRisk only ever sets it true; a Risk without block carries no policy effect. */
  block?: boolean;
}

const s = (v: unknown) => String(v ?? '').trim();
const clip = (t: string, n = 160) => (t.length > n ? `${t.slice(0, n)}…` : t);

/**
 * Round 21 (CHANGE 1): the two-restriction policy is ABSOLUTE — script opacity is NOT a
 * third restriction. When a tool launch opens or executes a script file, the file's
 * CONTENT is read and classified with the same classifiers that judge inline payloads
 * (shell for .bat/.cmd/.ps1, python for .py, node for .js, registry verdict for .reg,
 * generic destruction markers for .vbs/.wsf/.hta). A script whose targets can be resolved
 * is enforced at this boundary; an unreadable file is a technical failure, not a policy
 * block. Binary formats (.exe/.msi/…) launch like any app — installs are ordinary work.
 */
const SCRIPT_CLASSIFIERS: Record<string, (content: string) => { blocked: boolean; kind?: string; reason?: string }> = {
  '.bat': shellVerdict,
  '.cmd': shellVerdict,
  '.ps1': shellVerdict,
  '.py': pythonVerdict,
  '.js': nodeVerdict,
  '.mjs': nodeVerdict,
  '.cjs': nodeVerdict,
  '.reg': regFileVerdict,
  '.vbs': genericScriptVerdict,
  '.vbe': genericScriptVerdict,
  '.wsf': genericScriptVerdict,
  '.hta': genericScriptVerdict,
};

/**
 * Read (best-effort) and classify the CONTENT of a script file about to be executed.
 * Returns a hard Risk only for the two policy restrictions; anything else (unreadable,
 * unknown extension, clean content) returns null and the launch proceeds.
 */
const scriptContentRisk = async (target: string): Promise<Risk | null> => {
  const raw = s(target);
  if (!raw) return null;
  const ext = (raw.match(/\.[a-z0-9]+$/i) ?? [''])[0].toLowerCase();
  const classify = SCRIPT_CLASSIFIERS[ext];
  if (!classify) return null;
  let expanded = raw.replace(/^"(.*)"$/, '$1');
  if (expanded === '~' || expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', expanded.slice(1));
  }
  const full = path.isAbsolute(expanded) || /^[a-z]:[\\/]/i.test(expanded) ? expanded : path.resolve(FILES_ROOT, expanded);
  let content: string;
  try {
    content = await fs.readFile(full, 'utf8');
  } catch {
    return null; // unreadable → the execution itself will report the technical failure
  }
  const v = classify(content);
  if (!v.blocked) return null;
  return {
    block: true,
    title: v.kind === 'deletion' ? 'The script deletes something, and deleting is disabled on this laptop.' : 'The script modifies an operating-system location, which is read-only for JARVIS.',
    detail: clip(v.reason ?? ext, 200),
  };
};

const pathsOf = (args: Record<string, unknown>): string[] =>
  ['path', 'from', 'to', 'target', 'file', 'dir'].map((k) => args[k]).filter((v): v is string => typeof v === 'string' && v.trim().length > 0);

/** Keys that name a copy SOURCE. A copy source is READ, not written — and reading from an
 *  OS-protected location is allowed by policy (backup semantics), so copy_file's `from`
 *  must not be failed by the write classifier. move_file's `from` is NOT a source in that
 *  sense: moving removes the content from its protected location (F-02). */
const COPY_SOURCE_KEYS = new Set(['from']);

/**
 * The OS-resource block shared by every file-moving tool: one classifier, one message.
 *
 * Adversarial hardening: besides the literal path, the path is resolved through the
 * filesystem (realpath) — including its deepest existing ancestor, so a symlinked PARENT
 * folder is caught too. A harmless-looking workspace path that points at an OS-protected
 * location through symbolic links is blocked exactly like a direct write there.
 */
const osPathRisk = async (args: Record<string, unknown>, sourceKeys: Set<string> = new Set()): Promise<Risk | null> => {
  const entries = pathsOf(args).map((value) => {
    const key = (['path', 'from', 'to', 'target', 'file', 'dir'] as const).find((k) => args[k] === value);
    return { key, value };
  });
  return classifyPathRisk(entries, sourceKeys);
};

/** Extract the file paths named by a patch's header lines — apply_patch carries its
 *  targets INSIDE the patch text (args.patch), so the gate must read them from there.
 *  "Move to:" targets are write destinations exactly like Add/Update paths (F-04): a
 *  patch that renames a workspace note INTO /etc must be judged by the same classifier. */
const patchPaths = (patch: string): string[] =>
  [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)]
    .map((m) => (m[1] ?? m[2] ?? '').trim())
    .filter(Boolean);

/** The path-classification core: literal, workspace-resolved and REAL-path checks.
 *  Round 21 (CHANGE 2): resolution is a tri-state — an UNRESOLVED target (symlink cycle,
 *  unresolvable chain, filesystem error) can never be confirmed to be outside OS-protected
 *  locations, so the operation fails closed instead of silently passing as before. */
const classifyPathRisk = async (
  entries: Array<{ key?: string; value: string }>,
  sourceKeys: Set<string> = new Set()
): Promise<Risk | null> => {
  for (const entry of entries) {
    // Copy-source exception (F-02): a protected COPY source stays allowed; every other
    // protected target (write destination, edit path, make_dir target…) stays blocked.
    if (entry.key && sourceKeys.has(entry.key)) continue;
    const p = entry.value;
    if (osProtectedPath(p)) return { block: true, title: 'Operating-system locations are read-only.', detail: clip(p, 200) };
    // The literal form may be relative (the pure classifier resolves those against cwd):
    // resolve against the workspace FIRST and classify the absolute result.
    const full = path.resolve(FILES_ROOT, p);
    if (osProtectedPath(full)) return { block: true, title: 'Operating-system locations are read-only.', detail: clip(`${p} → ${full}`, 200) };
    // Symlink hardening (Round 21, CHANGE 2): the explicit PROTECTED / NOT_PROTECTED /
    // UNRESOLVED resolution model. Unresolved → fail closed with a specific reason.
    const real = classifyRealPath(full);
    if (real === 'protected')
      return { block: true, title: 'Operating-system locations are read-only.', detail: clip(`${p} resolves through the filesystem into an OS-protected location.`, 200) };
    if (real === 'unresolved')
      return {
        block: true,
        title: 'The target path could not be resolved on the filesystem.',
        detail: `${clip(p, 120)} cannot be confirmed to be outside OS-protected locations (unresolvable path, symbolic-link cycle or filesystem error), so the operation fails closed.`,
      };
  }
  return null;
};

/** A click on a control whose label, attributes or URL destroys data is hard-blocked by policy. */
const destructiveClickRisk = (label: string): Risk | null => {
  const v = labelVerdict(label);
  return v.blocked ? { block: true, title: 'Deleting is disabled on this laptop.', detail: v.reason ?? label } : null;
};

/** A browser navigation/click whose target URL encodes a destructive operation (e.g. /account/delete). */
const destructiveUrlRisk = (url: string): Risk | null => {
  const v = urlVerdict(url);
  return v.blocked ? { block: true, title: 'Deleting is disabled on this laptop.', detail: v.reason ?? url } : null;
};

/** Returns a hard block for the two policy restrictions, or null when the action runs automatically. */
export async function assessRisk(name: string, args: Record<string, unknown>): Promise<Risk | null> {
  switch (name) {
    case 'run_command': {
      const v = shellVerdict(s(args.command));
      if (v.blocked) return { block: true, title: v.reason ?? 'Blocked by policy.', detail: clip(s(args.command), 200) };
      return null;
    }
    case 'write_file': {
      const osRisk = await osPathRisk(args);
      if (osRisk) return osRisk;
      // Script-file creation outside the workspace is ordinary work: allowed automatically.
      return null;
    }
    case 'edit_file':
    case 'multi_edit':
    case 'apply_patch':
    case 'copy_file':
    case 'move_file':
    case 'make_dir':
    case 'open_anything': {
      if (name === 'apply_patch') {
        const ops = [...s(args.patch).matchAll(/^\*\*\* (Update|Add|Delete) File: (.+)$/gm)];
        if (ops.some((m) => m[1] === 'Delete')) return { block: true, title: 'Deleting is disabled on this laptop.', detail: '' };
        // The patch's own header lines name the real targets — classify them like any
        // write path (F-04: apply_patch used to be judged only by the weaker runtime list).
        const osRisk = await classifyPathRisk(patchPaths(s(args.patch)).map((value) => ({ value })));
        if (osRisk) return osRisk;
      }
      // F-02: only copy_file may read FROM protected territory; a move source is a
      // removal from its protected location and is judged like a write.
      const sourceKeys = name === 'copy_file' ? COPY_SOURCE_KEYS : new Set<string>();
      const osRisk = await osPathRisk(args, sourceKeys);
      if (osRisk) return osRisk;
      // Round 21 (CHANGE 1): scripts are NOT blocked for being scripts. A launch/execute
      // route classifies the script's CONTENT at this boundary; only the two hard
      // restrictions can block it. (open_anything target / open_file path)
      const launched = s(args.target ?? '');
      const scriptRisk = await scriptContentRisk(launched);
      if (scriptRisk) return scriptRisk;
      return null;
    }
    case 'open_file': {
      // Opening is a READ of the target — reading from OS-protected locations stays
      // allowed (the same backup semantics as a copy source). But the default app may
      // EXECUTE what it opens, so a script file's content is classified here: the same
      // boundary as open_anything, and still only the two hard restrictions.
      const scriptRisk = await scriptContentRisk(s(args.path));
      if (scriptRisk) return scriptRisk;
      return null;
    }
    case 'diagnostics': {
      // The composed tsc command carries a model-supplied tsconfig path: judge that path
      // like any write tool would (it selects what the compiler reads and where).
      if (typeof args.project === 'string' && args.project.trim()) {
        const osRisk = await osPathRisk({ path: args.project });
        if (osRisk) return osRisk;
      }
      return null;
    }
    case 'stop_process': {
      const nameArg = s(args.name);
      const pid = Math.round(Number(args.pid));
      if (!nameArg && Number.isFinite(pid) && pid > 0) {
        // F-05: a pid is not an identity. Resolve what actually runs there and apply the
        // SAME name-shaped policy; JARVIS itself is protected however it is addressed;
        // an unverifiable pid fails closed instead of being killed on trust.
        if (isJarvisPid(pid))
          return { block: true, title: 'JARVIS itself is protected; stopping it is disabled.', detail: `pid ${pid}` };
        const resolved = await resolveProcessName(pid);
        if (!resolved)
          return {
            block: true,
            title: 'The process identity could not be verified.',
            detail: `pid ${pid}: refusing to stop a process whose name cannot be resolved. Use list_processes first.`,
          };
        const v = processVerdict(resolved);
        if (v.blocked) return { block: true, title: v.reason ?? 'Blocked by policy.', detail: `pid ${pid} → ${resolved}` };
        return null;
      }
      const v = processVerdict(nameArg || s(args.pid));
      if (v.blocked) return { block: true, title: v.reason ?? 'Blocked by policy.', detail: '' };
      return null;
    }
    case 'click_control':
      return destructiveClickRisk(s(args.control));
    case 'click_text':
      return destructiveClickRisk(s(args.text));
    case 'browser_click': {
      // Classify the visible label TOGETHER with the element's href/attributes: a control
      // that reads "Continue" but points at /account/delete is a destructive click.
      const ref = args.ref;
      const combined = [labelFor(ref), hrefFor(ref)].filter(Boolean).join(' ');
      const byLabel = destructiveClickRisk(combined);
      if (byLabel) return byLabel;
      return destructiveUrlRisk(hrefFor(ref));
    }
    case 'browser_click_text':
      return destructiveClickRisk(s(args.text));
    case 'run_python': {
      const v = pythonVerdict(s(args.code));
      if (v.blocked) return { block: true, title: v.reason ?? 'Blocked by policy.', detail: clip(s(args.code), 200) };
      // Round 21 (CHANGE 1): os.startfile('…') executes a FILE — if it names a script,
      // the same content boundary applies as for open_anything/open_file.
      for (const m of s(args.code).matchAll(/os\.startfile\s*\(\s*(["'])(.*?)\1/g)) {
        const started = await scriptContentRisk(m[2]);
        if (started) return started;
      }
      return null;
    }
    case 'browser_eval': {
      const v = browserJsVerdict(s(args.js));
      if (v.blocked) return { block: true, title: v.reason ?? 'Blocked by policy.', detail: clip(s(args.js), 200) };
      return null;
    }
    case 'press_keys':
      // Round 21 (CHANGE 1): keyboard input is ORDINARY. The old blanket block on {DEL} /
      // Alt+F4 was a third restriction the policy does not have (deleting one character or
      // closing a window is not deletion of user data, and the same shortcuts are typed by
      // a human every minute). The two hard restrictions still apply where an affected
      // resource is actually identifiable — that is what the click/label classifiers do.
      return null;
    default:
      return null;
  }
}
