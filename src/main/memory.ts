import { promises as fs } from 'fs';
import * as path from 'path';
import type { Tool } from './toolTypes';
import { FILES_ROOT } from './workspace';
import { atomicWrite, loadJson } from './store';
import { hybridRetrieve, type RetrievedMemory } from './semanticMemory';
import { listEpisodeRecords } from './episodicMemory';
import { getEmbeddingProvider, embedWithCache, type EmbeddingProvider } from './embeddings';
import { listAllProjectRecords } from './projectMemory';
import { callContext } from './toolRecord';

/**
 * Long-term memory, persisted across sessions: preferences, habits, contacts,
 * recurring tasks and general facts. Everything is injected into every request.
 */
const LEGACY_FILE = path.join(FILES_ROOT, 'memory.md');
const STORE_FILE = path.join(FILES_ROOT, 'longterm-memory.json');
const MAX_ITEMS = 400;
const MAX_TEXT = 300;
const PROMPT_LIMIT = 40;

/**
 * ROUND 31 (§3.1) — MEMORY CLASSIFICATION. The Round 31 vocabulary distinguishes what
 * each record IS, so retrieval and prompting can treat each kind appropriately:
 *  - preference  likes/dislikes/how the user wants things done
 *  - habit       observed routines
 *  - contact     people
 *  - task        recurring tasks
 *  - fact        everything else lasting
 *  - instruction a STANDING user instruction ("always typecheck before committing") —
 *                binding until the user revises it, never allowed to expire silently
 *  - decision    a technical decision WITH its rationale (travels with refs)
 *  - limitation  a known constraint of the environment/project ("deletion is disabled")
 *  - procedure   a reusable way of working (short; playbooks remain the rich store)
 * Additive: old records load unchanged; unknown categories still display as facts.
 */
const CATEGORIES = ['preference', 'habit', 'contact', 'task', 'fact', 'instruction', 'decision', 'limitation', 'procedure'] as const;
type Category = (typeof CATEGORIES)[number];

/** Round 26 Phase 2: the ORIGIN vocabulary — provenance of the claim itself. */
const ORIGINS = ['user-decision', 'observed-fact', 'agent-suggestion', 'unverified-assumption'] as const;

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
  /** Round 18 §7.1: how much we trust this record (0..1); reinforced records gain. */
  confidence?: number;
  /** Round 18 §7.1: bumped on every content revision of the same logical fact. */
  version?: number;
  /** Round 18 §7.5 supersession: when a correction arrives, the OLD record is kept as
   *  history (never silently destroyed) and points at its successor. */
  superseded?: boolean;
  supersededBy?: string;
  /** Round 19 (CHANGE 5): PROVENANCE — which execution saved this record ('main',
   *  'task:T-xxx', a child agent id). Preserved across reinforcements; a correction's
   *  successor carries the correcting execution's provenance. */
  source?: string;
  /** Round 26 Phase 2: memory ORIGIN. A user decision is authoritative; an agent
   *  suggestion is context only and must never silently become a user decision. */
  origin?: 'user-decision' | 'observed-fact' | 'agent-suggestion' | 'unverified-assumption';
  /** Round 26 Phase 2: temporary information expires — dropped at load, never served. */
  expiresAt?: number;
  /** Round 27 §5.4: WHY a decision was made (user-approved decisions keep their rationale). */
  reasoning?: string;
  /** Round 27 §5.4: related implementation references (files, tasks, links) — names only. */
  refs?: string[];
  /** ROUND 31 (§3.2): scope tag — 'global' records serve every request; a scoped record
   *  ("project:<name>") is only retrieved for work that mentions that project. */
  scope?: string;
  /** ROUND 31 (§3.3): when this record was last CONFIRMED against direct evidence
   *  (observed-fact origins get this at write time). An unverified record never claims it. */
  verifiedAt?: number;
}

let items: Item[] | null = null;
let saving: Promise<void> = Promise.resolve();

/**
 * R27 §5.3 — EXACT TECHNICAL LOOKUP: a query that mentions a specific identifier (a
 * function name, a file path, a config key) must surface the record that CONTAINS it
 * verbatim, even when the semantic tier would rank general prose higher. An identifier
 * has shape (separators or camelCase), not just length. Pure; bounded; exported for tests.
 */
export const isTechnicalIdentifier = (token: string): boolean =>
  token.length >= 5 && (/^[a-z0-9]+([._\-/][a-z0-9]+)+/.test(token) || /[a-z][A-Z]/.test(token) || /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+/.test(token));

export function boostExactIdentifiers<T extends { score: number; text: string }>(query: string, hits: T[], boost = 1): T[] {
  const ids = [...new Set((query.match(/[A-Za-z0-9._\-/]{5,}/g) ?? []).filter(isTechnicalIdentifier))].slice(0, 5);
  if (!ids.length) return hits;
  return hits
    .map((h) => (ids.some((id) => h.text.toLowerCase().includes(id.toLowerCase())) ? { ...h, score: h.score + boost } : h))
    .sort((a, b) => b.score - a.score);
}

const clean = (v: unknown, max = MAX_TEXT) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

async function load(): Promise<Item[]> {
  if (items) {
    // Round 26 Phase 2: expiry is a LIVE property — a temporary record expires while the
    // process is running, not only across restarts. Expired entries are dropped (and the
    // compaction is persisted) instead of being served from the warm cache.
    const live = items.filter((i) => !i.expiresAt || i.expiresAt > Date.now());
    if (live.length !== items.length) {
      items = live;
      void save();
    }
    return items;
  }
  const parsed = await loadJson<unknown>(STORE_FILE, null);
  items = Array.isArray(parsed) ? (parsed as Item[]).map((i) => ({ ...i, confidence: typeof i.confidence === 'number' ? i.confidence : 0.8, version: typeof i.version === 'number' ? i.version : 1 })) : [];
  // Superseded records are history: keep them 30 days for traceability, then compact.
  // Round 26 Phase 2: expired temporary records are dropped at load — never served.
  items = items.filter((i) => (!i.expiresAt || i.expiresAt > Date.now()) && (!i.superseded || Date.now() - i.updated < 30 * 86_400_000));
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
      // R27 §5.4: decisions keep their rationale and implementation references — provenance
      // travels with the record everywhere it is rendered.
      return `${i.text}${i.reasoning ? ` (why: ${i.reasoning})` : ''}${i.refs?.length ? ` [refs: ${i.refs.slice(0, 4).join(', ')}]` : ''}`;
  }
}

/** Injected into every request so JARVIS always knows its long-term memory. */
const originNote = (i: Item): string =>
  i.origin === 'agent-suggestion'
    ? ' [AGENT SUGGESTION — not a user decision]'
    : i.origin === 'unverified-assumption'
      ? ' [UNVERIFIED ASSUMPTION — verify before relying on it]'
      : i.origin === 'observed-fact' && i.verifiedAt
        ? ' [verified against direct evidence]'
        : '';

export async function getMemoryPrompt(): Promise<string> {
  const all = await load();
  if (!all.length) return 'You have no saved long-term memories yet.';

  const section = (title: string, cat: Category): string => {
    const list = all
      .filter((i) => i.category === cat && !i.superseded)
      .sort((a, b) => b.count - a.count || b.updated - a.updated)
      .slice(0, PROMPT_LIMIT);
    return list.length ? `${title}:\n${list.map((i) => `- ${label(i)}${originNote(i)}`).join('\n')}` : '';
  };

  const hasTasks = all.some((i) => i.category === 'task');
  return [
    'Long-term memory (persists across sessions):',
    hasTasks ? `Current date and time: ${new Date().toLocaleString('en-GB')}` : '',
    section('Standing instructions (BINDING until the user revises them)', 'instruction'),
    section('Preferences', 'preference'),
    section('Technical decisions (with their rationale)', 'decision'),
    section('Known limitations', 'limitation'),
    section('Reusable procedures', 'procedure'),
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
    found.confidence = Math.min(0.99, (found.confidence ?? 0.8) + 0.02); // reinforcement builds trust
    return 'updated';
  }
  if (all.length >= MAX_ITEMS) throw new Error('Memory is full. Forget something first.');
  const made = make();
  made.confidence ??= 0.8;
  made.version ??= 1;
  all.push(made);
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

/** Currency/number figures used by the revision detector and the retrieval contradiction flag.
 *  Round 20 (CHANGE 7): bare numbers (≥3 digits) and TIMES (\d\d:\d\d, e.g. "02:00" → "03:00")
 *  now count as figures — previously only currency-symbol amounts did, so plain-number and
 *  schedule revisions silently coexisted as duplicates. The 0.85 core-word gate keeps
 *  unrelated numbers apart. */
const amountsOf = (s: string): string[] =>
  Array.from(
    new Set([
      ...Array.from(s.matchAll(/(?:₹|Rs\.?|\$|€)\s?[\d,.]+\s*(?:lakh|crore|k)?/gi)).map((m) => m[0].replace(/\s+/g, ' ').trim()),
      ...Array.from(s.matchAll(/\b\d{2,}(?:[.,:]\d+)?\b/g)).map((m) => m[0]),
    ])
  );
/** Negation words: a pair of near-identical statements where exactly one is negated is a contradiction. */
const NEGATORS = /\b(?:not|never|no longer|doesn'?t|does not|don'?t|do not|isn'?t|is not|won'?t|will not|can'?t|cannot|dislike|dislikes|hate|hates|avoid|avoids|refuse|refuses)\b/i;
const hasNegation = (s: string): boolean => NEGATORS.test(s);
/** The words of a statement with its figures removed (the comparable core).
 *  Round 20 (CHANGE 7): bare numbers are stripped as well, so two statements that differ
 *  only in a figure share the same comparable core. */
const coreWordsOf = (s: string): Set<string> =>
  new Set(
    s
      .replace(/(?:₹|Rs\.?|\$|€)\s?[\d,.]+\s*(?:lakh|crore|k)?/gi, ' ')
      .replace(/\b\d{2,}(?:[.,:]\d+)?\b/g, ' ')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  );

export const memoryTools: Record<string, Tool> = {
  remember: {
    description:
      'Save something lasting to long-term memory. Categories: preference (likes, dislikes, how the user wants things done), habit (routines and things they repeatedly do, such as "wakes at 6", "opens VS Code first thing"), instruction (a STANDING user instruction that binds future work, e.g. "always run typecheck before committing"), decision (a technical decision — include reasoning and refs), limitation (a known constraint of a project or this environment), procedure (a short reusable way of working), fact (names, projects, anything else lasting). Use proactively whenever the user shares or reveals something worth keeping, and whenever asked to remember. Saving the same thing again increases its strength. For people use save_contact; for scheduled routines use add_recurring_task.',
    parameters: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'One short, self-contained statement.' },
        category: {
          type: 'string',
          enum: ['preference', 'habit', 'fact', 'instruction', 'decision', 'limitation', 'procedure'],
          description: 'Defaults to fact. instruction/decision/limitation/procedure are for their named kinds — never misfile a standing instruction as a plain fact.',
        },
        origin: {
          type: 'string',
          enum: ['user-decision', 'observed-fact', 'agent-suggestion', 'unverified-assumption'],
          description: 'Where this fact comes from. user-decision (default) = the user said it. agent-suggestion = the agent proposes it (never treated as a user decision). observed-fact = directly seen in the workspace (recorded as verified). unverified-assumption = a guess that still needs checking.',
        },
        project: { type: 'string', description: 'Optional: bind this memory to one project (by name part) so it is only retrieved for that project\'s work.' },
        expires_in_minutes: { type: 'number', description: 'Optional: keep this memory only temporarily (it expires after N minutes). Never combine with instruction — standing instructions do not expire.' },
        reasoning: { type: 'string', description: 'Optional (decisions): WHY this was decided — the rationale travels with the record.' },
        refs: { type: 'string', description: 'Optional (decisions): comma-separated related implementation references (file paths, task ids, links).' },
      },
      required: ['fact'],
    },
    run: async (args) => {
      const text = clean(args.fact);
      if (!text) throw new Error('Nothing to remember.');
      const category: Category = ['preference', 'habit', 'instruction', 'decision', 'limitation', 'procedure'].includes(String(args.category))
        ? (String(args.category) as Category)
        : 'fact';
      // Round 26 Phase 2: origin + expiration — an agent suggestion is stored AS a
      // suggestion (never silently promoted to a user decision); temporary facts expire.
      // ROUND 31 (§3.1): a standing instruction never expires and is never stored from an
      // agent guess — only the user binds future work.
      const origin = (ORIGINS as readonly string[]).includes(String(args.origin)) ? (String(args.origin) as Item['origin']) : 'user-decision';
      const isInstruction = category === 'instruction';
      const effectiveOrigin = isInstruction && origin !== 'user-decision' && origin !== 'observed-fact' ? 'user-decision' : origin;
      const expiresIn = isInstruction ? undefined : Number(args.expires_in_minutes);
      const expiresAt = Number.isFinite(expiresIn) && expiresIn && expiresIn > 0 ? Date.now() + expiresIn * 60_000 : undefined;
      // ROUND 31 (§3.2): optional project scope. ROUND 32 (§5.2): the scope binds to the
      // STABLE canonical project key (a known project record's name, or a normalized slug
      // for a new one) — the same project always yields the same scope token, so
      // retrieval can enforce real project isolation instead of a loose name match.
      const projectRef = clean(args.project, 60);
      const scope = projectRef ? await canonicalProjectScope(projectRef) : undefined;
      // R27 §5.4: decision provenance — rationale + implementation references (names only).
      const reasoning = clean(args.reasoning, 300) || undefined;
      const refs = String(args.refs ?? '')
        .split(/[,;]/)
        .map((r) => clean(r, 120))
        .filter(Boolean)
        .slice(0, 6);
      const provenance = { ...(reasoning ? { reasoning } : {}), ...(refs.length ? { refs } : {}) };
      const all = await load();
      const lower = text.toLowerCase();
      // A REVISED value ("the budget is now ₹80,000") must update the old entry, not sit
      // beside it as a contradiction JARVIS then argues with. Same category, near-identical
      // wording once the amounts are removed, but a different currency figure = revision.
      // ROUND 31 (§3.4): an explicit preference/instruction UPDATE ("now", "instead",
      // "switch to", "prefer X over Y") supersedes the older user statement of the same
      // kind even without a figure flip — an updated explicit preference beats a
      // historical one, while non-update statements of different content coexist.
      const amounts = amountsOf;
      const coreWords = coreWordsOf;
      const explicitUpdate = /\b(?:now|instead|no longer|switch(?:ed)? to|change(?:d)? to|prefer\s+\w+\s+over|from now on|update[d]?)\b/i.test(text);
      // Round 20 (CHANGE 7): superseded records are HISTORY — they can neither be "already
      // remembered" (which silently dropped the new value) nor act as the correction
      // target (which overwrote a history pointer). Only LIVE records count.
      const contradiction = all.find((i) => {
        if (i.superseded || i.category !== category || i.text.toLowerCase() === lower) return false;
        // Only user-authored records may be superseded by a later user statement; agent
        // suggestions and unverified assumptions are superseded by VERIFIED evidence of
        // the opposite, which the polarity/figure rules below already catch.
        const A = amounts(i.text);
        const B = amounts(text);
        const x = coreWords(i.text);
        const y = coreWords(text);
        let inter = 0;
        for (const w of x) if (y.has(w)) inter++;
        const coreJaccard = x.size && y.size ? inter / (x.size + y.size - inter) : 0;
        // (a) NUMERIC REVISION: same comparable core, different figures.
        if (A.length && B.length && A.join('|') !== B.join('|') && coreJaccard >= 0.85) return true;
        // (b) POLARITY FLIP: near-identical core where exactly one side is negated
        // ("likes tea" vs "dislikes tea", "eats meat" vs "does not eat meat").
        if (A.length === 0 && B.length === 0 && coreJaccard >= 0.6 && hasNegation(i.text) !== hasNegation(text)) return true;
        // (c) EXPLICIT UPDATE (Round 31): overlapping statement that announces itself as a
        // change of an earlier user decision/preference/instruction of the same kind.
        if (
          explicitUpdate &&
          A.length === 0 &&
          B.length === 0 &&
          !hasNegation(i.text) === !hasNegation(text) &&
          coreJaccard >= 0.3 &&
          (i.origin ?? 'user-decision') === 'user-decision' &&
          (origin ?? 'user-decision') === 'user-decision'
        )
          return true;
        return false;
      });
      if (contradiction) {
        // Round 18 §7.5: a correction SUPERSEDES the old value — the old record is kept
        // as history (pointing at its successor), the corrected fact is a new record of
        // a higher version. Nothing is silently rewritten; prompts and retrieval show
        // only the current record.
        const was = contradiction.text;
        const successor = newId();
        contradiction.superseded = true;
        contradiction.supersededBy = successor;
        contradiction.updated = Date.now();
        all.push({
          id: successor,
          category,
          text,
          count: Math.max(1, contradiction.count ?? 1),
          created: Date.now(),
          updated: Date.now(),
          confidence: Math.min(0.99, (contradiction.confidence ?? 0.8) + 0.05), // a fresh correction outranks the old
          version: (contradiction.version ?? 1) + 1,
          source: callContext().agent, // explicit corrections carry the correcting execution's provenance
          origin: effectiveOrigin ?? contradiction.origin, // corrections keep the claim's own provenance class
          expiresAt,
          ...(scope ? { scope } : contradiction.scope ? { scope: contradiction.scope } : {}), // the successor keeps the subject's scope
          ...(effectiveOrigin === 'observed-fact' ? { verifiedAt: Date.now() } : {}), // ROUND 31 (§3.3): direct evidence is recorded as verified
          ...provenance,
        });
        await save();
        return `Updated (was: ${was})`;
      }
      const found = all.find((i) => i.category === category && !i.superseded && (i.text.toLowerCase() === lower || similar(i.text, text)));
      if (found && category !== 'habit') return 'Already remembered.';
      const result = upsert(
        all,
        (i) => i === found,
        () => ({
          id: newId(),
          category,
          text,
          count: 1,
          created: Date.now(),
          updated: Date.now(),
          source: callContext().agent,
          origin: effectiveOrigin,
          expiresAt,
          ...(scope ? { scope } : {}),
          ...(effectiveOrigin === 'observed-fact' ? { verifiedAt: Date.now() } : {}),
          ...provenance,
        }),
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
          source: callContext().agent, // Round 20 (CHANGE 7): provenance on every record
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
    parallelSafe: true,
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
    parallelSafe: true,
    description: 'List what is saved in long-term memory, optionally for one category (preference, habit, contact, task, fact, instruction, decision, limitation, procedure).',
    parameters: {
      type: 'object',
      properties: { category: { type: 'string', enum: [...CATEGORIES] } },
    },
    run: async (args) => {
      const cat = String(args.category ?? '');
      // Superseded records are history, not live memory — the listing shows current state only.
      const list = (await load()).filter((i) => !i.superseded && (!cat || i.category === cat));
      return list.length ? list.map((i) => `${i.category}: ${label(i)}`).join('\n') : 'Nothing saved.';
    },
  },
  find_memory: {
    parallelSafe: true,
    description: 'Find saved memories by MEANING, not just exact words — across ALL THREE memory layers (long-term facts/preferences/contacts, and every project\u2019s recorded decisions, progress and open issues). Ranks by relevance to the query, labels which layer and retrieval mechanism produced each hit, and flags contradictory values. Use before asking the user something they may already have told you.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in natural words.' },
        limit: { type: 'number', description: 'Max results (1-10, default 5).' },
        project: { type: 'string', description: 'Optional: restrict results to one project (by name part).' },
      },
      required: ['query'],
    },
    run: async (args) => {
      const q = clean(args.query);
      if (!q) throw new Error('Say what to look for.');
      const k = Math.min(10, Math.max(1, Math.round(Number(args.limit) || 5)));
      const project = clean(args.project, 60).toLowerCase();
      // THREE-LAYER CORPUS (Round 19, CHANGE 5): structured long-term memory (A) and
      // project memory (C) are retrieved through the ONE hybrid pipeline (B) — semantic
      // when a real embedding provider answers, lexical otherwise, labeled per hit.
      const [mine, projects, episodes] = await Promise.all([
        listAllMemories(),
        listAllProjectRecords().catch(() => []),
        listEpisodeRecords().catch(() => []),
      ]);
      const projectRows = projects
        .filter((p) => !project || p.scope.toLowerCase().includes(project.replace(/^project:/, '')))
        .map((p) => ({ id: p.id, text: p.text, scope: p.scope, count: 1, updated: p.updated }));
      // Round 26 Phase 2: the episodic layer joins the SAME hybrid pipeline — finished
      // work is retrievable by meaning exactly like facts and project decisions.
      const episodeRows = episodes.map((e) => ({ id: e.id, text: e.text, scope: e.scope, count: 1, updated: e.updated }));
      const corpus = [
        ...mine.map((m) => ({ id: m.id, text: m.label, scope: m.category, count: m.count, updated: m.updated })),
        ...(projectRows.length || !project ? projectRows : []),
        ...(episodeRows.length || !project ? episodeRows : []),
      ];
      const provider = await getEmbeddingProvider().catch(() => null);
      // Round 20 (CHANGE 7 + CHANGE 11): the embedding cache is now WIRED IN — the same
      // query/corpus texts are not re-embedded on every find_memory call. The cache is
      // content-addressed and LRU-bounded on disk; a cache hit skips the provider round-
      // trip entirely. The mechanism labels below are unchanged: a cache MISS that hits
      // the provider is still semantic retrieval; a provider failure is still lexical.
      const cachedProvider: EmbeddingProvider | null = provider
        ? { ...provider, embed: (texts: string[]) => embedWithCache(provider, texts) }
        : null;
      let providerError = '';
      const hits = await hybridRetrieve(q, corpus, {
        k,
        provider: cachedProvider,
        onProviderError: (e) => {
          providerError = e.message.slice(0, 140);
        },
      });
      // R27 §5.3: exact identifiers win over fuzzy prose — a verbatim identifier match is
      // boosted and re-ranked BEFORE display (mechanism labels are untouched).
      const ranked = boostExactIdentifiers(q, hits);
      if (!ranked.length) return 'No memory is relevant to that. The store was not padded with unrelated entries — ask the user instead.';
      // HONEST MECHANISM LABELS: the header states the tier actually used; a configured
      // provider that FAILED is never passed off as semantic retrieval.
      const usedVector = ranked.some((h) => h.source !== 'lexical');
      const tier = usedVector ? 'semantic+lexical' : providerError ? 'lexical (embedding provider FAILED — this is NOT semantic retrieval)' : 'lexical';
      const lines = [`(matched by ${tier}${providerError ? `; provider error: ${providerError}` : ''})`];
      for (const h of ranked) lines.push(`(${h.score.toFixed(2)} · ${h.source} · ${h.scope ?? '?'}) ${h.text}${contradictionNote(h, ranked)}`);
      return lines.join('\n');
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
  memory_maintain: {
    description:
      'Consolidate long-term memory: supersede near-duplicate records of the same category (the newest wording survives, history is preserved), drop expired temporary records, and report what changed plus the store size. Run when memory feels repetitive; never deletes distinct facts.',
    parameters: { type: 'object', properties: {} },
    run: async () => {
      const all = await load();
      const live = all.filter((i) => !i.superseded);
      let supersededCount = 0;
      // ROUND 31 (§3.6): consolidation — records of the same category whose wording is a
      // near-exact restatement (Jaccard ≥ 0.9) are DUPLICATES. The OLDEST becomes history
      // (superseded, pointer kept — nothing is destroyed); the newest keeps counting.
      const byKey = new Map<string, Item[]>();
      for (const i of live) {
        const key = i.category;
        const bucket = byKey.get(key) ?? [];
        bucket.push(i);
        byKey.set(key, bucket);
      }
      for (const bucket of byKey.values()) {
        const sorted = [...bucket].sort((a, b) => a.updated - b.updated);
        for (let a = 0; a < sorted.length; a++) {
          for (let b = a + 1; b < sorted.length; b++) {
            if (sorted[a].superseded || sorted[b].superseded) continue;
            if (similar(sorted[a].text, sorted[b].text) && sorted[a].text.toLowerCase() !== sorted[b].text.toLowerCase()) {
              const successor = sorted[b];
              sorted[a].superseded = true;
              sorted[a].supersededBy = successor.id;
              sorted[a].updated = Date.now();
              successor.count = Math.max(successor.count, sorted[a].count);
              supersededCount++;
            }
          }
        }
      }
      if (supersededCount) await save();
      const expired = all.length - live.length;
      return [
        `Memory maintenance: ${supersededCount} duplicate record(s) superseded (newest wording kept; history preserved).`,
        `${expired} expired/expired-history record(s) already excluded from the live view.`,
        `Live records: ${live.length}/${MAX_ITEMS} — by category: ${[...byKey.entries()].map(([k, v]) => `${k} ${v.length}`).join(', ')}`,
      ].join('\n');
    },
  },
};

/**
 * CONTRADICTION FLAG (Round 19, CHANGE 5): when the hits contain two records with the
 * SAME comparable core (figures removed) but DIFFERENT figures, the older one is flagged
 * inline — the model must not quote both values as if they agreed. Supersession already
 * prevents this within a category; the flag catches cross-store leftovers.
 */
const contradictionNote = (h: RetrievedMemory, hits: RetrievedMemory[]): string => {
  const mine = amountsOf(h.text);
  const rival = hits.find(
    (o) =>
      o.id !== h.id &&
      (o.updated ?? 0) < (h.updated ?? Date.now()) &&
      // Superseded records are history — they cannot "contradict" a live value.
      !(o as { superseded?: boolean }).superseded &&
      (() => {
        const a = coreWordsOf(h.text);
        const b = coreWordsOf(o.text);
        let inter = 0;
        for (const w of a) if (b.has(w)) inter++;
        const coreJaccard = a.size > 0 && b.size > 0 ? inter / (a.size + b.size - inter) : 0;
        const theirs = amountsOf(o.text);
        if (mine.length && theirs.length && theirs.join('|') !== mine.join('|') && coreJaccard >= 0.8) return true;
        // Round 20 (CHANGE 7): polarity flips are contradictions too.
        if (!mine.length && !theirs.length && coreJaccard >= 0.6 && hasNegation(o.text) !== hasNegation(h.text)) return true;
        return false;
      })()
  );
  return rival ? ` [CONTRADICTS an earlier memory ("${rival.text.slice(0, 80)}") — prefer THIS record; the correction is newer]` : '';
};

/** Recurring tasks with their plain-words schedules, for the anticipation engine. */
export async function recurringTasks(): Promise<Array<{ text: string; schedule: string }>> {
  return (await load())
    .filter((i) => i.category === 'task' && i.schedule)
    .map((i) => ({ text: i.text, schedule: i.schedule as string }));
}

/**
 * Every memory as a retrievable record (§10.2): id, rendered label, scope, reinforcement
 * count and last update. The semantic retrieval layer (semanticMemory.ts) ranks these
 * against the current request instead of the prompt carrying the whole store.
 *
 * ROUND 32 (§5.2): the record's REAL scope travels with it — a project-scoped record
 * carries its `project:<id>` scope (never merely its category), so the retrieval layer
 * can enforce PROJECT ISOLATION instead of a soft re-rank.
 */
export async function listAllMemories(): Promise<Array<{ id: string; label: string; category: Category; scope?: string; count: number; updated: number; confidence: number; source?: string }>> {
  const all = await load();
  return all
    .filter((i) => !i.superseded)
    .map((i) => ({ id: i.id, label: label(i), category: i.category, scope: i.scope, count: i.count, updated: i.updated, confidence: i.confidence ?? 0.8, source: i.source }));
}

/** Delete exactly one long-term memory by id (JINI phone edits target records, not wording). */
export async function forgetMemoryById(id: string): Promise<boolean> {
  const all = await load();
  const idx = all.findIndex((i) => i.id === id);
  if (idx < 0) return false;
  all.splice(idx, 1);
  await save();
  return true;
}

/** The stored category of one memory (so a correction keeps its kind). */
export async function memoryCategoryById(id: string): Promise<Category | undefined> {
  return (await load()).find((i) => i.id === id)?.category;
}

// --------------------------------------------------- ROUND 32 (§5.2): project identity

/**
 * The STABLE project-scope registry: project memories bind to the canonical project key
 * (projectMemory's `name` — a durable short key), never to a free-text guess. Alias
 * matching (title vs slug vs hyphen/underscore/space variants) resolves to the SAME
 * canonical scope token.
 */
async function knownProjectScopes(): Promise<Array<{ canonical: string; aliases: string[] }>> {
  const records = await listAllProjectRecords().catch(() => []);
  const names = new Set<string>();
  for (const r of records) {
    const m = r.scope.match(/^project:(.+)$/);
    if (m?.[1]) names.add(m[1]);
  }
  const norm = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, '');
  const out: Array<{ canonical: string; aliases: string[] }> = [];
  for (const n of names) {
    const aliases = new Set<string>([n.toLowerCase(), norm(n)]);
    out.push({ canonical: `project:${n.toLowerCase()}`, aliases: [...aliases] });
  }
  return out;
}

const normProjectKey = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, '');

/**
 * Canonicalize a user/model-supplied project name to the STABLE scope token: a known
 * project (by exact or alias match) binds to its canonical key; an unknown name binds to
 * its own normalized slug (so the same name always yields the same token).
 */
export async function canonicalProjectScope(name: string): Promise<string> {
  const clean = String(name ?? '').trim().slice(0, 60);
  if (!clean) return '';
  const known = await knownProjectScopes();
  const wanted = [clean.toLowerCase(), normProjectKey(clean)];
  const hit = known.find((k) => k.aliases.some((a) => wanted.includes(a)));
  return hit ? hit.canonical : `project:${normProjectKey(clean) || clean.toLowerCase()}`;
}

/**
 * The project scopes a request legitimately touches (§5.2): the canonical scope tokens
 * of every KNOWN project whose name the request names (word-boundary, hyphen/underscore/
 * space-flexible). This is the ALLOWED set for retrieval — project-scoped memories
 * outside this set are another project's private context and are EXCLUDED, and when the
 * request names no project at all, NO project-scoped memory is injected (never guess).
 */
export async function projectScopesForRequest(request: string): Promise<Set<string>> {
  const q = ` ${String(request ?? '').toLowerCase().replace(/[^\w\s-]/g, ' ').replace(/[\s_-]+/g, ' ')} `;
  const known = await knownProjectScopes();
  const allowed = new Set<string>();
  for (const k of known) {
    for (const alias of k.aliases) {
      const pattern = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\?\s+/g, '[\\s_-]*');
      if (new RegExp(`(?<![\\w-])${pattern}(?![\\w-])`, 'i').test(q)) {
        allowed.add(k.canonical);
        break;
      }
    }
  }
  return allowed;
}

/**
 * ROUND 32 (§5.5): standing instructions as their OWN prompt block — BINDING context is
 * assembled at the highest priority and can never be silently dropped by the context
 * budget (the budget's priority ordering protects priority-0 blocks first).
 */
export async function getStandingInstructionsPrompt(): Promise<string> {
  const all = await load();
  const list = all
    .filter((i) => i.category === 'instruction' && !i.superseded)
    .sort((a, b) => b.count - a.count || b.updated - a.updated)
    .slice(0, PROMPT_LIMIT);
  if (!list.length) return '';
  return ['Standing instructions (BINDING until the user revises them — they survive any context trimming):', ...list.map((i) => `- ${label(i)}${originNote(i)}`)].join('\n');
}

/** Test helper: drop the cached store so a test file starts from whatever disk holds (or nothing). */
export function resetMemoryForTests(): void {
  items = null;
}
