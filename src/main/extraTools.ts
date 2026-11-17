import { app, BrowserWindow, Notification, shell } from 'electron';
import { atomicAppend, atomicWrite, withStoreLock } from './store';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { Tool } from './toolTypes';
import { FILES_ROOT } from './workspace';
import { holdSpeech } from './modes';

const MAX_TIMERS = 20;
const MAX_APPS = 50;
const APPS_FILE = () => path.join(app.getPath('userData'), 'custom-apps.json');
// Background mode holds proactive speech; the hold is recorded in the activity feed, so
// even the silence is honest. Native timer notifications still fire (they are the point).
const sayAloud = (text: string) => {
  if (holdSpeech(text)) return;
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('jarvis-say', text));
};

const loadApps = async (): Promise<Record<string, string>> => {
  try {
    return JSON.parse(await fs.readFile(APPS_FILE(), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
};

/** Path of a user-registered app matching `name`, if any. */
export async function findCustomApp(name: string): Promise<string | undefined> {
  const n = name.trim().toLowerCase();
  const apps = await loadApps();
  const key = Object.keys(apps).find((k) => k === n) ?? Object.keys(apps).find((k) => k.includes(n) || n.includes(k));
  return key ? apps[key] : undefined;
}

const MAX_MS = 24 * 3600 * 1000;
const timers = new Map<number, { label: string; due: number; handle: ReturnType<typeof setTimeout> }>();
let nextId = 1;

const fmt = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const parts = [[Math.floor(s / 3600), 'hour'], [Math.floor((s % 3600) / 60), 'minute'], [s % 60, 'second']] as const;
  return parts.filter(([n]) => n).map(([n, u]) => `${n} ${u}${n === 1 ? '' : 's'}`).join(' ') || '0 seconds';
};

const SAFE_MATH = /^[0-9+\-*/%().\s^]+$/;

export const extraTools: Record<string, Tool> = {
  calculate: {
    parallelSafe: true,
    description: 'Evaluate an arithmetic expression exactly. Supports + - * / % ^ and parentheses. Use for any maths instead of mental arithmetic.',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'e.g. (12.5 * 8) / 3' } },
      required: ['expression'],
    },
    run: (args) => {
      const expr = String(args.expression ?? '').replace(/\^/g, '**');
      // A megabyte "expression" would stall the main thread in Function-compile: bound it.
      if (expr.length > 500) throw new Error('Expression is too long (500 characters max).');
      if (!SAFE_MATH.test(expr.replace(/\*\*/g, '*'))) throw new Error('Only numbers and arithmetic operators are allowed.');
      const out = Function(`"use strict"; return (${expr});`)() as unknown;
      if (typeof out !== 'number' || !Number.isFinite(out)) throw new Error('Result is not a finite number.');
      return String(Math.round(out * 1e10) / 1e10);
    },
  },
  set_timer: {
    description: 'Set a timer or reminder. Shows a desktop notification when it fires. Max 24 hours.',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'Duration in seconds.' },
        label: { type: 'string', description: 'What the reminder is for.' },
      },
      required: ['seconds'],
    },
    run: (args) => {
      const ms = Number(args.seconds) * 1000;
      if (!Number.isFinite(ms) || ms < 1000 || ms > MAX_MS) throw new Error('Duration must be between 1 second and 24 hours.');
      if (timers.size >= MAX_TIMERS) throw new Error('Too many active timers.');
      const id = nextId++;
      const label = String(args.label || 'Timer').slice(0, 120);
      const handle = setTimeout(() => {
        timers.delete(id);
        new Notification({ title: 'JINI', body: `${label}: time is up.` }).show();
        shell.beep();
        sayAloud(`Sir, your ${label.toLowerCase()} timer has elapsed.`);
      }, ms);
      timers.set(id, { label, due: Date.now() + ms, handle });
      return `Timer ${id} set: "${label}" in ${fmt(ms)}.`;
    },
  },
  list_timers: {
    parallelSafe: true,
    description: 'List active timers and reminders with time remaining.',
    parameters: { type: 'object', properties: {} },
    run: () =>
      timers.size
        ? [...timers].map(([id, t]) => `${id}: ${t.label}, ${fmt(t.due - Date.now())} left`).join('\n')
        : 'No active timers.',
  },
  cancel_timer: {
    description: 'Cancel a timer by id (see list_timers), or all timers if id is omitted.',
    parameters: { type: 'object', properties: { id: { type: 'number' } } },
    run: (args) => {
      const ids = args.id === undefined ? [...timers.keys()] : [Number(args.id)];
      let n = 0;
      for (const id of ids) {
        const t = timers.get(id);
        if (!t) continue;
        clearTimeout(t.handle);
        timers.delete(id);
        n++;
      }
      return n ? `Cancelled ${n} timer(s).` : 'No matching timer.';
    },
  },
  add_note: {
    description: 'Append a timestamped note to notes.txt in the Jarvis-Files workspace.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    run: async (args) => {
      const text = String(args.text ?? '').trim().slice(0, 2000);
      if (!text) throw new Error('Note is empty.');
      // Round 18 §12 (W4): appends ride the atomic O_APPEND path — a crash can cost the
      // tail of one line, never the file.
      await fs.mkdir(FILES_ROOT, { recursive: true });
      await atomicAppend(path.join(FILES_ROOT, 'notes.txt'), `[${new Date().toLocaleString()}] ${text}\n`);
      return 'Noted.';
    },
  },
  read_notes: {
    parallelSafe: true,
    description: 'Read the most recent notes from notes.txt.',
    parameters: { type: 'object', properties: { last: { type: 'number', description: 'How many recent notes. Default 10.' } } },
    run: async (args) => {
      const n = Math.min(50, Math.max(1, Number(args.last) || 10));
      try {
        const lines = (await fs.readFile(path.join(FILES_ROOT, 'notes.txt'), 'utf8')).trim().split('\n');
        return lines.slice(-n).join('\n');
      } catch {
        return 'No notes yet.';
      }
    },
  },
  briefing: {
    description: 'Gather a daily briefing: date and time, active timers and recent notes. After calling it, also call get_weather and optionally web_search for headlines, then summarise in a few spoken sentences.',
    parameters: { type: 'object', properties: {} },
    run: async () => {
      let notes = 'none';
      try {
        notes = (await fs.readFile(path.join(FILES_ROOT, 'notes.txt'), 'utf8')).trim().split('\n').slice(-5).join('\n') || 'none';
      } catch {
        /* no notes yet */
      }
      const active = timers.size ? [...timers.values()].map((t) => `${t.label} (${fmt(t.due - Date.now())})`).join(', ') : 'none';
      return `Now: ${new Date().toString()}\nActive timers: ${active}\nRecent notes:\n${notes}`;
    },
  },
  add_app: {
    description: 'Register a custom app shortcut so launch_app can open it by name. Path must be an existing .exe or .lnk file.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, path: { type: 'string', description: 'Full path to the .exe or .lnk.' } },
      required: ['name', 'path'],
    },
    run: async (args) => {
      const name = String(args.name ?? '').trim().toLowerCase();
      const target = String(args.path ?? '').trim().replace(/^"|"$/g, '');
      if (!name || !/\.(exe|lnk)$/i.test(target)) throw new Error('Need a name and a path ending in .exe or .lnk.');
      await fs.access(target).catch(() => {
        throw new Error('That file does not exist.');
      });
      // Round 18 §12 (W4): the read-modify-write is serialized (two overlapping
      // registrations used to lose one of the apps).
      await withStoreLock(APPS_FILE(), async () => {
        const apps = await loadApps();
        if (Object.keys(apps).length >= MAX_APPS && !(name in apps)) throw new Error('Custom app list is full.');
        apps[name] = target;
        await atomicWrite(APPS_FILE(), JSON.stringify(apps, null, 2));
      });
      return `Registered ${name}.`;
    },
  },
  remove_app: {
    description: 'Remove a custom app shortcut by name.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    run: async (args) => {
      const name = String(args.name ?? '').trim().toLowerCase();
      await withStoreLock(APPS_FILE(), async () => {
        const apps = await loadApps();
        if (!(name in apps)) throw new Error('No such custom app.');
        delete apps[name];
        await atomicWrite(APPS_FILE(), JSON.stringify(apps, null, 2));
      });
      return `Removed ${name}.`;
    },
  },
  list_custom_apps: {
    parallelSafe: true,
    description: 'List registered custom app shortcuts.',
    parameters: { type: 'object', properties: {} },
    run: async () => Object.keys(await loadApps()).join(', ') || 'None registered.',
  },
};
