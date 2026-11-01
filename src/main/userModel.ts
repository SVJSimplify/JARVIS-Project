import { promises as fs } from 'fs';
import * as path from 'path';
import { recurringTasks } from './memory';
import { latestTelemetry } from './telemetry';
import type { Tool } from './toolTypes';
import { FILES_ROOT } from './workspace';
import { atomicWrite } from './store';

/**
 * A running model of the user, built only from observation (no extra model calls, so it costs no speed):
 *  1. HABIT MODEL      what they do, at which hours and weekdays, and what tends to follow what.
 *  2. CONTEXT          time, how long since they last spoke, what is running, background jobs, alerts.
 *  3. ANTICIPATION     routines due now, recurring tasks due, the likely next step after the last action.
 *  4. READING YOU      terse or chatty, in a hurry, frustrated, repeating themselves, wants shorter or fuller answers.
 * Only app names, site hosts, topic labels and counters are stored. No message text, no full URLs, no page content.
 */

const FILE = path.join(FILES_ROOT, 'brain', 'user-model.json');
const MAX_HABITS = 150;
const MIN = 60_000;
const HOUR = 3_600_000;
const WEEK = 7 * 86_400_000;
const SEQ_WINDOW = 25 * MIN;
const MOOD_WINDOW = 20 * MIN;
const SESSION_GAP = 10 * MIN;

interface Habit {
  label: string;
  n: number;
  last: number;
  hours: number[];
  dows: number[];
}
interface Style {
  turns: number;
  words: number;
  commands: number;
  questions: number;
  corrections: number;
  frustrated: number;
  hurried: number;
  polite: number;
  hinglish: number;
  verbosity: number;
  hours: number[];
}
interface Mood {
  t: number;
  f: number;
  h: number;
}
interface Model {
  habits: Record<string, Habit>;
  seq: Record<string, Record<string, number>>;
  style: Style;
  mood: Mood[];
  lastKey: string;
  lastKeyAt: number;
  lastSeen: number;
  decayedAt: number;
}

const blank = (): Model => ({
  habits: {},
  seq: {},
  style: { turns: 0, words: 0, commands: 0, questions: 0, corrections: 0, frustrated: 0, hurried: 0, polite: 0, hinglish: 0, verbosity: 0, hours: Array(24).fill(0) },
  mood: [],
  lastKey: '',
  lastKeyAt: 0,
  lastSeen: 0,
  decayedAt: 0,
});

let model: Model | null = null;
let writing: Promise<unknown> = Promise.resolve();

async function load(): Promise<Model> {
  if (model) return model;
  const fresh = blank();
  try {
    const p = JSON.parse(await fs.readFile(FILE, 'utf8')) as Partial<Model>;
    model = {
      ...fresh,
      ...p,
      habits: p.habits ?? {},
      seq: p.seq ?? {},
      mood: Array.isArray(p.mood) ? p.mood : [],
      style: { ...fresh.style, ...(p.style ?? {}) },
    };
  } catch {
    model = fresh;
  }
  decay(model);
  return model;
}

function persist(): void {
  const data = JSON.stringify(model ?? blank());
  writing = writing
    .then(async () => {
      await fs.mkdir(path.dirname(FILE), { recursive: true });
      await atomicWrite(FILE, data);
    })
    .catch((e) => console.warn('[userModel] failed to persist the user model:', e)); // silent loss would go unnoticed
}

/** Habits fade by 10% a week, so a routine the user dropped stops being predicted. */
function decay(m: Model): void {
  const now = Date.now();
  if (!m.decayedAt) {
    m.decayedAt = now;
    return;
  }
  const weeks = Math.floor((now - m.decayedAt) / WEEK);
  if (weeks < 1) return;
  const f = Math.pow(0.9, Math.min(weeks, 12));
  for (const [k, h] of Object.entries(m.habits)) {
    h.n *= f;
    h.hours = h.hours.map((x) => x * f);
    h.dows = h.dows.map((x) => x * f);
    if (h.n < 0.5) delete m.habits[k];
  }
  for (const a of Object.keys(m.seq)) {
    for (const b of Object.keys(m.seq[a])) {
      m.seq[a][b] *= f;
      if (m.seq[a][b] < 0.5 || !m.habits[b]) delete m.seq[a][b];
    }
    if (!m.habits[a] || !Object.keys(m.seq[a]).length) delete m.seq[a];
  }
  m.decayedAt += weeks * WEEK;
}

const words = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
const jaccard = (a: Set<string>, b: Set<string>): number => {
  let n = 0;
  a.forEach((w) => b.has(w) && n++);
  return a.size + b.size ? n / (a.size + b.size - n) : 0;
};
const fmtHour = (h: number): string => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
const daypart = (h: number): string => (h < 5 ? 'late night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night');
const fmtDur = (ms: number): string => {
  const mins = Math.round(ms / MIN);
  if (mins < 60) return `${mins} minutes`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  return `${Math.floor(h / 24)} days`;
};

/* ------------------------------------------------------------------ 4. READING YOU */

const FRUSTRATION =
  /\b(again|i (already )?(said|told|asked|meant)|still (not|doesn'?t|isn'?t|no|nothing)|(not|isn'?t|doesn'?t|don'?t|won'?t|never) work\w*|useless|stupid|terrible|annoying|ridiculous|come on|seriously|for (god'?s|goodness|heaven'?s) sake|wtf|damn|why (is|are|did|do|does|won'?t|can'?t|isn'?t|didn'?t) (it|you|this|that|jarvis)|so slow|too slow|waste of|not what i)\b/i;
const CORRECTION = /^\s*(no\b|nope|wrong|that'?s (not|wrong)|not (that|what)|incorrect|don'?t (do|use|open|click)|stop (doing|that)|you (should|shouldn'?t|didn'?t|forgot|keep|were wrong)|that was not)/i;
const HURRY = /\b(quick(ly)?|asap|hurry|right now|immediately|urgent|real quick|in a hurry|running late|late for)\b/i;
const QUESTION = /\?\s*$|^\s*(what|why|how|when|where|who|which|can|could|is|are|do|does|did|should|would)\b/i;
const COMMAND = /^\s*(open|play|close|set|send|call|find|show|search|launch|start|stop|put|turn|make|create|write|read|run|go|take|add|remind|check|tell|get|give|switch|pause|resume|mute|lock)\b/i;
const POLITE = /\b(please|thanks|thank you|cheers|appreciate)\b/i;
const SHORTER = /\b(shorter|too long|too much|be brief|keep it short|stop (talking|explaining)|just (say|tell)|less (talk|detail)|skip the|not so long)\b/i;
const MORE = /\b(more detail|explain (more|further|that|why)|elaborate|go deeper|tell me more|in detail)\b/i;
const HINGLISH =
  /\b(kya|kyun|kaise|karo|nahi|nhi|bhai|yaar|abhi|jaldi|batao|bata|dikhao|kholo|chalao|accha|theek|thik|mujhe|mera|meri|aap|tum|yeh|woh|hai|hain|mein|toh|bhi|dedo|dena|chahiye|lagao|laga|raha|rahi)\b/gi;

let turnGap = Infinity;
let sessionTurns = 0;
let prevText = '';
let prevAt = 0;

/** Call at the start of every turn, before the prompt is built. Learns from how the user just spoke. */
export async function observeUser(text: string): Promise<void> {
  const m = await load();
  const now = Date.now();
  turnGap = m.lastSeen ? now - m.lastSeen : Infinity;
  sessionTurns = turnGap > SESSION_GAP ? 1 : sessionTurns + 1;

  const t = text.replace(/\s+/g, ' ').trim();
  const wc = t ? t.split(' ').length : 0;
  const repeated = wc >= 3 && !!prevText && now - prevAt < 3 * MIN && jaccard(new Set(words(t)), new Set(words(prevText))) >= 0.6;
  const correction = CORRECTION.test(t);
  const caps = (t.match(/\b[A-Z]{3,}\b/g) ?? []).length >= 2;
  const hinglish = (t.match(HINGLISH) ?? []).length;

  let f = 0;
  if (FRUSTRATION.test(t)) f += 0.5;
  if (repeated) f += 0.4;
  if (correction) f += 0.3;
  if (caps) f += 0.25;
  if (/!{2,}|\?!|!\?/.test(t)) f += 0.2;
  const h = HURRY.test(t) ? 0.6 : wc > 0 && wc <= 3 && /\bnow\b/i.test(t) ? 0.4 : 0;

  const s = m.style;
  s.turns++;
  s.words = s.turns === 1 ? wc : s.words * 0.92 + wc * 0.08;
  if (COMMAND.test(t)) s.commands++;
  if (QUESTION.test(t)) s.questions++;
  if (correction) s.corrections++;
  if (f >= 0.5) s.frustrated++;
  if (h >= 0.5) s.hurried++;
  if (POLITE.test(t)) s.polite++;
  if (hinglish >= 2 || (hinglish >= 1 && wc <= 3)) s.hinglish++;
  s.hours[new Date().getHours()]++;
  if (SHORTER.test(t)) s.verbosity = Math.max(-3, s.verbosity - 1);
  else if (MORE.test(t)) s.verbosity = Math.min(3, s.verbosity + 1);

  m.mood.push({ t: now, f: Math.min(1, f), h });
  m.mood = m.mood.slice(-8);
  m.lastSeen = now;
  prevText = t;
  prevAt = now;
  persist();
}

function state(m: Model): { f: number; h: number } {
  const now = Date.now();
  let f = 0;
  let h = 0;
  let w = 1;
  for (const x of m.mood.filter((e) => now - e.t < MOOD_WINDOW).reverse()) {
    f = Math.max(f, x.f * w);
    h = Math.max(h, x.h * w);
    w *= 0.6;
  }
  return { f, h };
}

function describeStyle(m: Model): string[] {
  const s = m.style;
  const out: string[] = [];
  if (s.turns < 6) return [`only ${s.turns} request${s.turns === 1 ? '' : 's'} observed so far, so treat style notes as weak guesses`];
  out.push(
    s.words <= 5 ? 'terse, speaks in short commands' : s.words <= 14 ? 'brief and direct' : s.words <= 30 ? 'conversational' : 'detailed, thinks out loud'
  );
  if (s.commands / s.turns > 0.6) out.push('mostly gives direct commands: act, do not discuss');
  else if (s.questions / s.turns > 0.5) out.push('asks a lot of questions: answer them directly first');
  if (s.verbosity <= -1) out.push('has asked for shorter answers: keep replies to one short sentence');
  else if (s.verbosity >= 1) out.push('has asked for fuller explanations: give a little more detail');
  if (s.turns >= 8 && s.corrections / s.turns > 0.15) out.push('corrects me fairly often: confirm ambiguous requests and verify before reporting success');
  if (s.polite / s.turns > 0.3) out.push('courteous: match it with warmth');
  if (s.hinglish / s.turns > 0.2) out.push('mixes Hindi words in: understand them, reply in English unless they address you in Hindi');
  if (s.turns >= 15) {
    const top = s.hours
      .map((n, hr) => ({ n, hr }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 3)
      .filter((x) => x.n > 0)
      .map((x) => fmtHour(x.hr));
    if (top.length) out.push(`most active around ${top.join(', ')}`);
  }
  return out;
}

function describeState(m: Model): string {
  const { f, h } = state(m);
  const late = new Date().getHours();
  const parts: string[] = [];
  if (f >= 0.6) {
    parts.push(
      'FRUSTRATED right now (repeating, correcting or complaining). Drop the wit and any apology speech: at most a four-word acknowledgement, then fix it. If they repeated a request, the last attempt did not work, so use a different approach, and say plainly what changed.'
    );
  } else if (f >= 0.3) {
    parts.push('slightly irritated: be extra direct, skip flourishes, get it right first time.');
  }
  if (h >= 0.5) parts.push('in a hurry: do the minimum, answer in one short sentence, offer nothing extra.');
  if (!parts.length) parts.push('calm: normal butler tone.');
  if (late < 5 && m.style.turns >= 15 && m.style.hours[late] / m.style.turns < 0.03) parts.push('unusually late for them: stay brief and do not suggest long tasks.');
  return parts.join(' ');
}

/* ------------------------------------------------------------------ 1. HABIT MODEL */

const lc = (v: unknown, n = 40): string => String(v ?? '').toLowerCase().trim().slice(0, n);
function host(url: unknown): string {
  const u = String(url ?? '').trim();
  if (!u) return '';
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

type KeyPair = [string, string];

function keysFor(name: string, a: Record<string, unknown>): KeyPair[] {
  switch (name) {
    case 'launch_app':
    case 'open_app': {
      const n = lc(a.name);
      return n ? [[`app:${n}`, `opening ${n}`]] : [];
    }
    case 'open_url':
    case 'open_in_my_browser':
    case 'browser_open': {
      const h = host(a.url);
      return h ? [[`site:${h}`, `opening ${h}`]] : [];
    }
    case 'browser_play': {
      const out: KeyPair[] = [['play:any', 'playing videos or music']];
      const q = lc(a.query, 60).split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
      if (q) out.push([`play:${q}`, `playing "${q}"`]);
      else if (host(a.url)) out.push([`site:${host(a.url)}`, `opening ${host(a.url)}`]);
      return out;
    }
    case 'edit_file':
    case 'multi_edit':
    case 'apply_patch':
    case 'run_command':
    case 'diagnostics':
      return [['work:coding', 'coding or terminal work']];
    case 'briefing':
      return [['routine:briefing', 'asking for a briefing']];
    case 'get_weather':
      return [['topic:weather', 'checking the weather']];
    default:
      return [];
  }
}

const TOPICS: Array<[string, string, RegExp]> = [
  ['topic:weather', 'checking the weather', /\b(weather|forecast|temperature|rain)\b/i],
  ['topic:news', 'asking about the news', /\b(news|headlines)\b/i],
  ['topic:markets', 'checking markets or prices', /\b(stocks?|share price|nifty|sensex|crypto|bitcoin)\b/i],
  ['topic:sports', 'checking sports scores', /\b(cricket|ipl|football|match score|live score)\b/i],
  ['topic:traffic', 'checking traffic or routes', /\b(traffic|commute|directions?)\b/i],
  ['topic:email', 'checking email', /\b(e-?mails?|inbox|gmail)\b/i],
  ['topic:reminders', 'setting reminders or timers', /\b(timers?|alarm|remind\w*)\b/i],
];

function bump(m: Model, key: string, label: string, now: Date): void {
  const h = (m.habits[key] ??= { label, n: 0, last: 0, hours: Array(24).fill(0), dows: Array(7).fill(0) });
  h.n++;
  h.hours[now.getHours()]++;
  h.dows[now.getDay()]++;
  h.last = now.getTime();
  h.label = label;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    const v = JSON.parse(String(raw ?? '{}')) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** batch and chain wrap the user's real actions; sub-agent tools (task, research) are deliberately NOT expanded. */
function flatten(name: string, raw: string): Array<{ name: string; args: Record<string, unknown> }> {
  const args = parseArgs(raw);
  const inner = name === 'batch' ? args.calls : name === 'chain' ? args.steps : null;
  if (!Array.isArray(inner)) return [{ name, args }];
  return inner
    .filter((c): c is { tool: string; args?: unknown } => !!c && typeof (c as { tool?: unknown }).tool === 'string')
    .map((c) => ({ name: c.tool, args: parseArgs(c.args) }));
}

/** Call after every finished turn with the tool calls that succeeded. */
export async function observeTurn(user: string, used: Array<{ name: string; args: string }>): Promise<void> {
  const m = await load();
  const now = new Date();
  const keys = new Map<string, string>();
  for (const u of used) for (const c of flatten(u.name, u.args)) for (const [k, l] of keysFor(c.name, c.args)) keys.set(k, l);
  for (const [k, l, re] of TOPICS) if (re.test(user)) keys.set(k, l);
  if (!keys.size) return;

  let prev = m.lastKey && now.getTime() - m.lastKeyAt < SEQ_WINDOW ? m.lastKey : '';
  for (const [k, l] of keys) {
    bump(m, k, l, now);
    if (prev && prev !== k) {
      const row = (m.seq[prev] ??= {});
      row[k] = (row[k] ?? 0) + 1;
    }
    prev = k;
  }
  m.lastKey = prev;
  m.lastKeyAt = now.getTime();

  const ks = Object.keys(m.habits);
  if (ks.length > MAX_HABITS) {
    ks.sort((a, b) => m.habits[a].n - m.habits[b].n || m.habits[a].last - m.habits[b].last)
      .slice(0, ks.length - MAX_HABITS)
      .forEach((k) => delete m.habits[k]);
    for (const a of Object.keys(m.seq)) {
      for (const b of Object.keys(m.seq[a])) if (!m.habits[b]) delete m.seq[a][b];
      if (!m.habits[a]) delete m.seq[a];
    }
  }
  persist();
}

const hourWindow = (h: Habit, hr: number): number => (h.hours[(hr + 23) % 24] + h.hours[hr] + h.hours[(hr + 1) % 24]) / Math.max(h.n, 0.0001);
const weekdayShare = (h: Habit): number => (h.dows[1] + h.dows[2] + h.dows[3] + h.dows[4] + h.dows[5]) / Math.max(h.n, 0.0001);

/* ------------------------------------------------------------------ 3. ANTICIPATION */

interface Pred {
  text: string;
  score: number;
}

function habitsNow(m: Model, now: Date): Pred[] {
  const hr = now.getHours();
  const weekend = now.getDay() === 0 || now.getDay() === 6;
  const out: Pred[] = [];
  for (const h of Object.values(m.habits)) {
    if (h.n < 3 || now.getTime() - h.last < 3 * HOUR) continue;
    const w = hourWindow(h, hr);
    if (w < 0.6) continue;
    const wd = weekdayShare(h);
    if (h.n >= 5 && ((weekend && wd >= 0.9) || (!weekend && wd <= 0.1))) continue;
    out.push({ text: `${h.label} (${Math.round(h.n)}x, ${w >= 0.75 && h.n >= 6 ? 'strong' : 'moderate'} pattern)`, score: w * Math.log2(h.n + 1) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}

function nextAfter(m: Model): string {
  if (!m.lastKey || Date.now() - m.lastKeyAt > SEQ_WINDOW) return '';
  const row = m.seq[m.lastKey];
  if (!row) return '';
  const total = Object.values(row).reduce((a, b) => a + b, 0);
  const top: [string, number] = Object.entries(row).sort((x, y) => y[1] - x[1])[0] ?? ['', 0];
  const [b, c] = top;
  if (!b || c < 3 || c / total < 0.5 || !m.habits[b] || !m.habits[m.lastKey]) return '';
  return `after ${m.habits[m.lastKey].label} they usually go on to ${m.habits[b].label} (${Math.round(c)} of ${Math.round(total)} times)`;
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Is a plain-words schedule ("every Friday 5 PM", "daily at 9", "weekday mornings") due around now? */
function dueNow(schedule: string, now: Date): boolean {
  const s = schedule.toLowerCase();
  const dow = now.getDay();
  const monthly = /\bmonth/.test(s);
  const named = monthly ? [] : DAYS.map((d, i) => (new RegExp(`\\b${d}\\w*`).test(s) ? i : -1)).filter((i) => i >= 0);
  let dayOk = false;
  if (/weekdays?/.test(s)) dayOk = dow >= 1 && dow <= 5;
  else if (/weekends?/.test(s)) dayOk = dow === 0 || dow === 6;
  else if (named.length) dayOk = named.includes(dow);
  else if (monthly) {
    const d = s.match(/\b(\d{1,2})(st|nd|rd|th)\b/);
    dayOk = !!d && Number(d[1]) === now.getDate();
  } else if (/daily|every ?day|each day|nightly|every (morning|afternoon|evening|night)/.test(s)) dayOk = true;
  if (!dayOk) return false;

  const mins = now.getHours() * 60 + now.getMinutes();
  const clock = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) ?? s.match(/\bat (\d{1,2})(?::(\d{2}))?\b/);
  if (clock) {
    let hh = Number(clock[1]);
    const ap = clock[3];
    if (ap === 'pm' && hh < 12) hh += 12;
    if (ap === 'am' && hh === 12) hh = 0;
    const t = hh * 60 + Number(clock[2] ?? 0);
    return mins >= t - 90 && mins <= t + 120;
  }
  const part = /morning/.test(s) ? 'morning' : /afternoon/.test(s) ? 'afternoon' : /evening/.test(s) ? 'evening' : /night/.test(s) ? 'night' : '';
  if (part) return daypart(now.getHours()) === part || (part === 'night' && daypart(now.getHours()) === 'late night');
  return true;
}

async function anticipations(m: Model, now: Date): Promise<string[]> {
  const out: string[] = [];
  try {
    const due = (await recurringTasks()).filter((t) => dueNow(t.schedule, now)).slice(0, 3);
    for (const t of due) out.push(`due now: ${t.text} [${t.schedule}]`);
  } catch {
    /* memory unavailable: skip */
  }
  const seq = nextAfter(m);
  if (seq) out.push(seq);
  for (const p of habitsNow(m, now)) out.push(`around this time they usually do: ${p.text}`);
  return out;
}

/* ------------------------------------------------------------------ 2. CONTEXT AWARENESS */

const NOTABLE: Array<[RegExp, string]> = [
  [/chrome|msedge|firefox|brave|opera/i, 'a web browser'],
  [/^code|vscode|cursor|idea|pycharm/i, 'a code editor'],
  [/whatsapp/i, 'WhatsApp'],
  [/telegram/i, 'Telegram'],
  [/discord/i, 'Discord'],
  [/slack/i, 'Slack'],
  [/teams/i, 'Teams'],
  [/zoom/i, 'Zoom'],
  [/spotify/i, 'Spotify'],
  [/vlc/i, 'VLC'],
  [/winword/i, 'Word'],
  [/excel/i, 'Excel'],
  [/powerpnt/i, 'PowerPoint'],
  [/notion/i, 'Notion'],
  [/obs/i, 'OBS'],
];

function situation(m: Model, now: Date): string {
  const day = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const weekend = now.getDay() === 0 || now.getDay() === 6;
  const bits = [`${day}, ${time}, ${daypart(now.getHours())}, ${weekend ? 'weekend' : 'weekday'}`];

  if (m.style.turns <= 1) bits.push('first conversation on record');
  else if (turnGap > 3 * HOUR) bits.push(`first request after a ${fmtDur(turnGap)} break`);
  else if (sessionTurns > 1) bits.push(`request ${sessionTurns} of an ongoing conversation`);

  const last = m.lastKey && m.habits[m.lastKey] && Date.now() - m.lastKeyAt < SEQ_WINDOW ? m.habits[m.lastKey].label : '';
  if (last) bits.push(`last thing they did: ${last}`);

  try {
    const t = latestTelemetry();
    if (t) {
      const running = [...new Set(t.procs.flatMap((p) => NOTABLE.filter(([re]) => re.test(p.name)).map(([, n]) => n)))];
      if (running.length) bits.push(`running: ${running.slice(0, 6).join(', ')}`);
      if (t.jobs?.length) bits.push(`background jobs: ${t.jobs.slice(0, 3).join('; ')}`);
      const alert = t.alerts?.find((a) => a.level === 'crit') ?? t.alerts?.[0];
      if (alert) bits.push(`system alert: ${alert.text}`);
    }
  } catch {
    /* telemetry not ready */
  }
  return bits.join('. ');
}

/* ------------------------------------------------------------------ prompt block */

/** Injected into every turn. Cheap: no model calls, only counters already in memory. */
export async function buildUserContext(): Promise<string> {
  const m = await load();
  const now = new Date();
  const style = describeStyle(m);
  const ant = await anticipations(m, now);
  const lines = [
    'USER MODEL (learned by watching, not told; background only: never recite or mention it, never act on it without a request):',
    `Situation: ${situation(m, now)}.`,
    `Reading them: ${style.join('; ')}.`,
    `Right now they seem: ${describeState(m)}`,
  ];
  if (ant.length) {
    lines.push(
      `Anticipated: ${ant.join(' | ')}.`,
      'Use anticipation like this: finish what was asked first, then offer at most ONE anticipated item as a short closing clause (for example "Shall I open Gmail as well, sir?"), only if it fits the request or this is the first request after a break, and never when they seem hurried or frustrated. Due recurring tasks are worth mentioning once. Never perform an anticipated action unasked; if they decline, drop it and do not offer it again that session.'
    );
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ tools */

const peak = (h: Habit): number => {
  let best = 0;
  for (let i = 0; i < 24; i++) if (h.hours[i] + h.hours[(i + 1) % 24] > h.hours[best] + h.hours[(best + 1) % 24]) best = i;
  return h.hours[best] >= h.hours[(best + 1) % 24] ? best : (best + 1) % 24;
};

export const userModelTools: Record<string, Tool> = {
  habit_report: {
    description:
      'Say what you have learned about the user by observation: their routines (what, how often, usual hour, weekdays or weekends) and how they communicate. Use when asked about their habits, patterns, routine, or "what do you know about how I work".',
    parameters: { type: 'object', properties: {} },
    run: async () => {
      const m = await load();
      const top = Object.values(m.habits)
        .filter((h) => h.n >= 2)
        .sort((a, b) => b.n - a.n)
        .slice(0, 12)
        .map((h) => {
          const wd = weekdayShare(h);
          const days = h.n >= 4 ? (wd >= 0.85 ? ', weekdays' : wd <= 0.15 ? ', weekends' : '') : '';
          return `${h.label}: ${Math.round(h.n)} times, usually around ${fmtHour(peak(h))}${days}`;
        });
      const style = describeStyle(m);
      return [top.length ? `Routines:\n${top.join('\n')}` : 'No repeated routines yet; I am still watching.', `How you work with me: ${style.join('; ')}.`].join('\n');
    },
  },
  habit_forget: {
    description: 'Forget a learned habit or routine the user does not want tracked or suggested. Matches the habit text, for example "youtube" or "gmail".',
    parameters: { type: 'object', properties: { text: { type: 'string', description: 'Part of the habit to forget.' } }, required: ['text'] },
    run: async (args) => {
      const needle = lc(args.text, 60);
      if (!needle) throw new Error('Say which habit to forget.');
      const m = await load();
      const gone = Object.keys(m.habits).filter((k) => k.toLowerCase().includes(needle) || m.habits[k].label.toLowerCase().includes(needle));
      if (!gone.length) throw new Error('No learned habit matches that.');
      gone.forEach((k) => {
        delete m.habits[k];
        delete m.seq[k];
      });
      for (const a of Object.keys(m.seq)) for (const k of gone) delete m.seq[a][k];
      if (gone.includes(m.lastKey)) m.lastKey = '';
      persist();
      return `Forgot ${gone.length} learned habit${gone.length === 1 ? '' : 's'}.`;
    },
  },
  anticipate: {
    description: 'What the user is likely to need right now: recurring tasks due, routines for this hour, the usual next step after their last action. Use when asked "what should I do now", "anything I am forgetting", or at the start of a first request after a break.',
    parameters: { type: 'object', properties: {} },
    run: async () => {
      const m = await load();
      const ant = await anticipations(m, new Date());
      return ant.length ? ant.join('\n') : 'Nothing stands out right now.';
    },
  },
};
