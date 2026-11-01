import { promises as fs } from 'fs';
import * as path from 'path';
import type { Tool } from './toolTypes';
import { FILES_ROOT } from './workspace';
import { atomicWrite, loadJson } from './store';

/**
 * Long-term memory, persisted across sessions: preferences, habits, contacts,
 * recurring tasks and general facts. Everything is injected into every request.
 */
const LEGACY_FILE = path.join(FILES_ROOT, 'memory.md');
const STORE_FILE = path.join(FILES_ROOT, 'longterm-memory.json');
const MAX_ITEMS = 400;
const MAX_TEXT = 300;
const PROMPT_LIMIT = 40;

const CATEGORIES = ['preference', 'habit', 'contact', 'task', 'fact'] as const;
type Category = (typeof CATEGORIES)[number];

interface Item {
  id: string;
  category: Category;
  text: string;
  name?: string;
  phone?: string;
  email?: string;
  relation?: string;
  schedule?: string;
  count: number;
  created: number;
  updated: number;
}

let items: Item[] | null = null;
let saving: Promise<void> = Promise.resolve();

const clean = (v: unknown, max = MAX_TEXT) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

async function load(): Promise<Item[]> {
  if (items) return items;
  const parsed = await loadJson<unknown>(STORE_FILE, null);
  items = Array.isArray(parsed) ? (parsed as Item[]) : [];
  if (items.length) return items;
  try {
    const text = await fs.readFile(LEGACY_FILE, 'utf8');
    const now = Date.now();
    for (const line of text.split('\n')) {
      const fact = clean(line.replace(/^-\s*/, ''));
      if (fact) items.push({ id: newId(), category: 'fact', text: fact, count: 1, created: now, updated: now });
    }
    if (items.length) await save();
  } catch {
    /* nothing to migrate */
  }
  return items;
}

function save(): Promise<void> {
  saving = saving
    .then(async () => {
      await fs.mkdir(FILES_ROOT, { recursive: true });
      await atomicWrite(STORE_FILE, JSON.stringify(items ?? [], null, 1));
    })
    .catch((e) => console.warn('[memory] failed to persist long-term memory:', e)); // failures must be observable
  return saving;
}

function label(i: Item): string {
  switch (i.category) {
    case 'contact':
      return `${i.name ?? i.text}${i.relation ? ` (${i.relation})` : ''}${i.phone ? `, phone ${i.phone}` : ''}${
        i.email ? `, email ${i.email}` : ''
      }${i.name && i.text ? `; ${i.text}` : ''}`;
    case 'task':
      return `${i.text}${i.schedule ? ` [${i.schedule}]` : ''}`;
    case 'habit':
      return `${i.text}${i.count > 1 ? ` (seen ${i.count}x)` : ''}`;
    default:
      return i.text;
  }
}

/** Injected into every request so JARVIS always knows its long-term memory. */
export async function getMemoryPrompt(): Promise<string> {
  const all = await load();
  if (!all.length) return 'You have no saved long-term memories yet.';

  const section = (title: string, cat: Category): string => {
    const list = all
      .filter((i) => i.category === cat)
      .sort((a, b) => b.count - a.count || b.updated - a.updated)
      .slice(0, PROMPT_LIMIT);
    return list.length ? `${title}:\n${list.map((i) => `- ${label(i)}`).join('\n')}` : '';
  };

  const hasTasks = all.some((i) => i.category === 'task');
  return [
    'Long-term memory (persists across sessions):',
    hasTasks ? `Current date and time: ${new Date().toLocaleString('en-GB')}` : '',
    section('Preferences', 'preference'),
    section('Habits and routines', 'habit'),
    section('Contacts', 'contact'),
    section('Recurring tasks', 'task'),
    section('Other facts', 'fact'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function upsert(all: Item[], match: (i: Item) => boolean, make: () => Item, merge: (i: Item) => void): 'added' | 'updated' {
  const found = all.find(match);
  if (found) {
    merge(found);
    found.updated = Date.now();
    return 'updated';
  }
  if (all.length >= MAX_ITEMS) throw new Error('Memory is full. Forget something first.');
  all.push(make());
  return 'added';
}

const wordsOf = (s: string): Set<string> => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
/** Jaccard word similarity; a reworded memory ("reply briefly" vs "keep answers short") must update the old entry, not sit beside it as a contradiction. */
const similar = (a: string, b: string): boolean => {
  const A = wordsOf(a);
  const B = wordsOf(b);
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter) >= 0.7;
};

export const memoryTools: Record<string, Tool> = {
  remember: {
    description:
      'Save something lasting to long-term memory. Categories: preference (likes, dislikes, how the user wants things done), habit (routines and things they repeatedly do, such as "wakes at 6", "opens VS Code first thing"), fact (names, projects, anything else lasting). Use proactively whenever the user shares or reveals something worth keeping, and whenever asked to remember. Saving a habit again increases its strength. For people use save_contact; for scheduled routines use add_recurring_task.',
    parameters: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'One short, self-contained statement.' },
        category: { type: 'string', enum: ['preference', 'habit', 'fact'], description: 'Defaults to fact.' },
      },
      required: ['fact'],
    },
    run: async (args) => {
      const text = clean(args.fact);
      if (!text) throw new Error('Nothing to remember.');
      const category: Category = ['preference', 'habit'].includes(String(args.category)) ? (String(args.category) as Category) : 'fact';
      const all = await load();
      const lower = text.toLowerCase();
      // A REVISED value ("the budget is now ₹80,000") must update the old entry, not sit
      // beside it as a contradiction JARVIS then argues with. Same category, near-identical
      // wording once the amounts are removed, but a different currency figure = revision.
      const amounts = (s: string): string[] =>
        Array.from(s.matchAll(/(?:₹|Rs\.?|\$|€)\s?[\d,.]+\s*(?:lakh|crore|k)?/gi)).map((m) => m[0].replace(/\s+/g, ' ').trim());
      const coreWords = (s: string): Set<string> =>
        new Set(
          s
            .replace(/(?:₹|Rs\.?|\$|€)\s?[\d,.]+\s*(?:lakh|crore|k)?/gi, ' ')
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean)
        );
      const contradiction = all.find((i) => {
        if (i.category !== category || i.text.toLowerCase() === lower) return false;
        const A = amounts(i.text);
        const B = amounts(text);
        if (!A.length || !B.length || A.join('|') === B.join('|')) return false;
        const x = coreWords(i.text);
        const y = coreWords(text);
        let inter = 0;
        for (const w of x) if (y.has(w)) inter++;
        return x.size && y.size && inter / (x.size + y.size - inter) >= 0.85;
      });
      if (contradiction) {
        const was = contradiction.text;
        contradiction.text = text;
        contradiction.updated = Date.now();
        await save();
        return `Updated (was: ${was})`;
      }
      const found = all.find((i) => i.category === category && (i.text.toLowerCase() === lower || similar(i.text, text)));
      if (found && category !== 'habit') return 'Already remembered.';
      const result = upsert(
        all,
        (i) => i === found,
        () => ({ id: newId(), category, text, count: 1, created: Date.now(), updated: Date.now() }),
        (i) => void (i.count += 1)
      );
      await save();
      return result === 'added' ? `Saved as ${category}.` : `Noted again (${found!.count} times).`;
    },
  },
  save_contact: {
    description:
      'Save or update a person in long-term memory: name plus any of phone, email, relationship and notes. Existing contacts with the same name are updated, not duplicated.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        relation: { type: 'string', description: 'e.g. wife, boss, client, friend.' },
        notes: { type: 'string', description: 'Anything useful about them.' },
      },
      required: ['name'],
    },
    run: async (args) => {
      const name = clean(args.name, 80);
      if (!name) throw new Error('Whose contact is this?');
      const all = await load();
      const result = upsert(
        all,
        (i) => i.category === 'contact' && (i.name ?? '').toLowerCase() === name.toLowerCase(),
        () => ({
          id: newId(),
          category: 'contact',
          text: clean(args.notes),
          name,
          phone: clean(args.phone, 40) || undefined,
          email: clean(args.email, 120) || undefined,
          relation: clean(args.relation, 40) || undefined,
          count: 1,
          created: Date.now(),
          updated: Date.now(),
        }),
        (i) => {
          if (clean(args.phone)) i.phone = clean(args.phone, 40);
          if (clean(args.email)) i.email = clean(args.email, 120);
          if (clean(args.relation)) i.relation = clean(args.relation, 40);
          if (clean(args.notes)) i.text = clean(args.notes);
        }
      );
      await save();
      return result === 'added' ? `Contact ${name} saved.` : `Contact ${name} updated.`;
    },
  },
  find_contact: {
    description: 'Look up saved contacts by name, relationship or note text.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    run: async (args) => {
      const q = clean(args.query).toLowerCase();
      if (!q) throw new Error('Who are you looking for?');
      const hits = (await load()).filter(
        (i) => i.category === 'contact' && [i.name, i.relation, i.text].some((v) => (v ?? '').toLowerCase().includes(q))
      );
      return hits.length ? hits.map(label).join('\n') : 'No matching contact.';
    },
  },
  add_recurring_task: {
    description:
      'Save a recurring task or routine with its schedule, e.g. task "send the weekly report", schedule "every Friday 5 PM". Updates the schedule if the task already exists. Mention tasks that are due when relevant.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        schedule: { type: 'string', description: 'When it recurs, in plain words.' },
      },
      required: ['task', 'schedule'],
    },
    run: async (args) => {
      const text = clean(args.task);
      const schedule = clean(args.schedule, 80);
      if (!text || !schedule) throw new Error('I need both the task and when it recurs.');
      const all = await load();
      const result = upsert(
        all,
        (i) => i.category === 'task' && i.text.toLowerCase() === text.toLowerCase(),
        () => ({ id: newId(), category: 'task', text, schedule, count: 1, created: Date.now(), updated: Date.now() }),
        (i) => void (i.schedule = schedule)
      );
      await save();
      return result === 'added' ? 'Recurring task saved.' : 'Recurring task updated.';
    },
  },
  list_memories: {
    description: 'List what is saved in long-term memory, optionally for one category (preference, habit, contact, task, fact).',
    parameters: {
      type: 'object',
      properties: { category: { type: 'string', enum: [...CATEGORIES] } },
    },
    run: async (args) => {
      const cat = String(args.category ?? '');
      const list = (await load()).filter((i) => !cat || i.category === cat);
      return list.length ? list.map((i) => `${i.category}: ${label(i)}`).join('\n') : 'Nothing saved.';
    },
  },
  forget: {
    description: 'Delete saved long-term memories (any category, including contacts and recurring tasks) that contain the given text.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to match against saved memories.' } },
      required: ['text'],
    },
    run: async (args) => {
      const needle = clean(args.text).toLowerCase();
      if (!needle) throw new Error('Say what to forget.');
      const all = await load();
      // Exact matches win: "forget the meeting" must not take unrelated items whose text merely
      // contains a word of the request. Substring matching stays as the fallback, as before.
      const exactIdx = all.flatMap((i, idx) =>
        (i.text.toLowerCase() === needle || (i.category === 'contact' && (i.name ?? '').toLowerCase() === needle) ? [idx] : [])
      );
      const doomed = exactIdx.length
        ? exactIdx
        : all.flatMap((i, idx) => (label(i).toLowerCase().includes(needle) ? [idx] : []));
      const removed = doomed.length;
      if (!removed) throw new Error('No saved memory matches that.');
      if (removed > 3) throw new Error(`That matches ${removed} memories. Be more specific.`);
      // Splice in place: reassigning `items` used to orphan a concurrent save's array and lose memories.
      for (let idx = all.length - 1; idx >= 0; idx--) {
        if (doomed.includes(idx)) all.splice(idx, 1);
      }
      await save();
      return `Forgot ${removed} memory item(s).`;
    },
  },
};

/** Recurring tasks with their plain-words schedules, for the anticipation engine. */
export async function recurringTasks(): Promise<Array<{ text: string; schedule: string }>> {
  return (await load())
    .filter((i) => i.category === 'task' && i.schedule)
    .map((i) => ({ text: i.text, schedule: i.schedule as string }));
}

/** Test helper: drop the cached store so a test file starts from whatever disk holds (or nothing). */
export function resetMemoryForTests(): void {
  items = null;
}
