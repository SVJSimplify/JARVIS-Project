import { promises as fs } from 'fs';
import * as path from 'path';
import { labelFor } from './browser';
import { attentionHud, sendToHud } from './hud';
import { FILES_ROOT, isInsideRoot } from './workspace';
import { emitActivity } from './modes';

export interface Risk {
  title: string;
  detail: string;
  /** Never allowed, not even with approval (deleting). */
  block?: boolean;
  /** Keys remembered for the session once approved (so one file is not asked about repeatedly). */
  remember?: string[];
}

const TIMEOUT_MS = 45_000;
const approved = new Set<string>();

/** Button or menu labels that delete, send, pay or otherwise cannot be undone. */
const RISKY_LABEL =
  /\b(delete|remove|erase|discard|wipe|uninstall|empty (?:the )?(?:recycle )?bin|reset|send|post|publish|submit|pay|purchase|buy|checkout|place order|confirm (?:order|purchase|payment)|sign out|log ?out|unsubscribe|transfer|withdraw|overwrite|replace all|clear (?:all|history|data))\b/i;

/** Deleting is switched off entirely on this laptop. */
const DELETE_CMD =
  /\b(?:rm|rmdir|del|erase|remove-item|unlink|shred|remove-itemproperty|format-volume|diskpart|clear-disk)\b|\brd\s|\bri\s+[^-\s]|format\s+[a-z]:|cipher\s+\/w|git\s+clean\b|reg\s+delete\b/i;

/** Destructive but not deletion: needs approval each time. */
const DANGEROUS_CMD =
  /\b(?:shutdown|restart-computer|stop-computer|stop-process|taskkill|kill|reg\s+add|clear-content|set-content|out-file|sc\s+(?:delete|stop)|net\s+user|takeown|icacls|git\s+(?:reset\s+--hard|push\s+(?:-f|--force)|branch\s+-d|checkout\s+--|restore)|npm\s+(?:publish|unpublish)|(?:pip|winget|choco)\s+uninstall|iex|invoke-expression)\b|curl\b[^|]*\|\s*(?:sh|bash|iex)/i;

const DANGEROUS_KEYS = /\{(?:DEL|DELETE)\}|%\{F4\}/i;
const SCRIPT_EXT = /\.(exe|bat|cmd|ps1|vbs|vbe|msi|reg|scr|com|hta|wsf|dll|lnk)$/i;
const RUN_EXT = /\.(bat|cmd|ps1|vbs|vbe|msi|reg|scr|com|jar|hta|wsf)$/i;

const s = (v: unknown) => String(v ?? '').trim();
const clip = (t: string, n = 160) => (t.length > n ? `${t.slice(0, n)}…` : t);
const abs = (p: unknown) => path.resolve(FILES_ROOT, s(p));
const exists = (f: string) => fs.stat(f).then(() => true, () => false);

/** Returns what to ask (or block), or null when the action is safe to run unprompted. */
export async function assessRisk(name: string, args: Record<string, unknown>): Promise<Risk | null> {
  switch (name) {
    case 'close_app':
      return { title: `Close the window ${clip(s(args.window), 60)}?`, detail: 'Unsaved work in it may be lost.' };
    case 'lock_screen':
      return { title: 'Lock the computer?', detail: '' };
    case 'run_command': {
      const c = s(args.command);
      if (DELETE_CMD.test(c)) return { block: true, title: 'Deleting is disabled on this laptop.', detail: clip(c, 200) };
      return DANGEROUS_CMD.test(c) ? { title: 'Run a command that can change or disable things?', detail: clip(c, 300) } : null;
    }
    case 'forget':
      return { title: `Permanently forget ${clip(s(args.text), 80)}?`, detail: '' };
    case 'write_file': {
      const full = abs(args.path);
      try {
        const st = await fs.stat(full);
        if (st.isFile() && st.size > 0) return { title: `Overwrite the file ${clip(full, 90)}?`, detail: `${st.size} bytes will be replaced.` };
      } catch {
        /* new file */
      }
      return !isInsideRoot(full) && SCRIPT_EXT.test(full) ? { title: 'Create a program or script file outside Jarvis-Files?', detail: clip(full, 160) } : null;
    }
    case 'edit_file':
    case 'multi_edit': {
      const full = abs(args.path);
      if (isInsideRoot(full) || approved.has(full.toLowerCase()) || !(await exists(full))) return null;
      return { title: `Modify the existing file ${clip(full, 90)}?`, detail: 'It is outside Jarvis-Files. Approving also covers more edits to it this session.', remember: [full.toLowerCase()] };
    }
    case 'apply_patch': {
      const ops = [...s(args.patch).matchAll(/^\*\*\* (Update|Add|Delete) File: (.+)$/gm)];
      if (ops.some((m) => m[1] === 'Delete')) return { block: true, title: 'Deleting is disabled on this laptop.', detail: '' };
      const touched: string[] = [];
      for (const m of ops) {
        const full = abs(m[2].trim());
        if (isInsideRoot(full) || approved.has(full.toLowerCase())) continue;
        if ((m[1] === 'Update' && (await exists(full))) || SCRIPT_EXT.test(full)) touched.push(full);
      }
      return touched.length
        ? { title: `Change ${touched.length} file(s) outside Jarvis-Files?`, detail: clip(touched.join('\n'), 300), remember: touched.map((f) => f.toLowerCase()) }
        : null;
    }
    case 'move_file':
      return { title: `Move ${clip(s(args.from), 60)} to ${clip(s(args.to), 60)}?`, detail: '' };
    case 'stop_process':
      return { title: `Stop ${s(args.name) || `process ${s(args.pid)}`}${args.force === true ? ' by force' : ''}?`, detail: 'Unsaved work in it may be lost.' };
    case 'open_anything': {
      const t = s(args.target);
      const exe = /\.exe$/i.test(t) && !/\\(windows|program files)/i.test(t);
      return RUN_EXT.test(t) || exe ? { title: 'Run this program or script?', detail: clip(t, 200) } : null;
    }
    case 'click_control':
      return RISKY_LABEL.test(s(args.control)) ? { title: `Click ${clip(s(args.control), 60)} in ${clip(s(args.window), 40)}?`, detail: '' } : null;
    case 'click_text':
      return RISKY_LABEL.test(s(args.text)) ? { title: `Click the text ${clip(s(args.text), 60)} on screen?`, detail: '' } : null;
    case 'browser_click': {
      const l = labelFor(args.ref);
      return l && RISKY_LABEL.test(l) ? { title: `Click ${clip(l, 60)} in the browser?`, detail: '' } : null;
    }
    case 'browser_click_text':
      return RISKY_LABEL.test(s(args.text)) ? { title: `Click ${clip(s(args.text), 60)} in the browser?`, detail: '' } : null;
    case 'browser_upload':
      return { title: 'Upload a file to this web page?', detail: clip(s(args.path), 200) };
    case 'run_python':
      return { title: 'Run this Python code?', detail: clip(s(args.code), 300) };
    case 'press_keys':
      return DANGEROUS_KEYS.test(s(args.keys)) ? { title: 'Press a delete or close-window shortcut?', detail: s(args.keys) } : null;
    default:
      return null;
  }
}

let seq = 0;
const pending = new Map<number, (ok: boolean) => void>();
let chain: Promise<unknown> = Promise.resolve();

/** Shows the approval card in the HUD and resolves true only on an explicit Allow. Prompts are queued, never overlapped. */
export function requestConfirm(r: Risk): Promise<boolean> {
  const run = () =>
    new Promise<boolean>((resolve) => {
      const id = ++seq;
      // Approvals are shown in the activity feed in BOTH modes: safety is above silence.
      // In background mode they still pop the HUD — a destructive action must never be
      // waved through just because the user asked for quiet.
      const cid = `c${id}`;
      emitActivity({ kind: 'confirm', cid, label: r.title, detail: r.detail, status: 'busy' });
      const done = (ok: boolean): void => {
        if (!pending.delete(id)) return;
        clearTimeout(timer);
        if (ok) r.remember?.forEach((k) => approved.add(k));
        sendToHud('confirm-clear', id);
        emitActivity({ kind: 'confirm', cid, label: r.title, detail: ok ? 'approved' : 'denied', status: ok ? 'ok' : 'fail' });
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), TIMEOUT_MS);
      pending.set(id, done);
      attentionHud();
      if (!sendToHud('confirm-request', { id, title: r.title, detail: r.detail })) done(false);
    });
  const p = chain.then(run);
  chain = p.catch(() => undefined);
  return p;
}

export const answerConfirm = (id: number, ok: boolean): void => pending.get(id)?.(ok);
export const denyAllPending = (): void => pending.forEach((f) => f(false));
