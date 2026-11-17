import { promises as fs } from 'fs';
import * as path from 'path';
import type { Tool } from './toolTypes';
import { FILES_ROOT, displayPath } from './workspace';
import { atomicWrite, loadJson, withStoreLock } from './store';
import { callContext } from './toolRecord';

/**
 * PROJECT MEMORY (Pillar 5, §11.4) — structured context about long-lived projects.
 *
 * Records what a project IS (workspace, stack, architecture notes), what was DECIDED
 * (dated decisions), where things STAND (progress, open issues) and which files matter.
 * One store, shared with the other memory systems through the tool registry — not a
 * second memory implementation.
 *
 * Deliberate limit (spec §11.4): project memory is NOT a source of truth over the actual
 * repository. Every record carries that warning; when code and notes disagree, the tools
 * tell the model to inspect the real files.
 */

const STORE_FILE = path.join(FILES_ROOT, 'brain', 'projects.json');

interface ProjectRecord {
  name: string;
  workspace: string;
  description: string;
  stack: string[];
  decisions: Array<{ at: number; text: string }>;
  keyFiles: string[];
  progress: string;
  openIssues: string[];
  updatedAt: number;
  /** Round 20 (CHANGE 7): provenance — the execution that last wrote this record. */
  lastSource?: string;
}

const MAX_PROJECTS = 24;
const MAX_ITEMS = 40;

interface Store {
  projects: ProjectRecord[];
}
const emptyStore = (): Store => ({ projects: [] });

const clip = (s: string, n: number): string => String(s ?? '').slice(0, n);

async function loadStore(): Promise<Store> {
  return loadJson<Store>(STORE_FILE, emptyStore());
}

async function saveStore(s: Store): Promise<void> {
  await fs.mkdir(path.dirname(STORE_FILE), { recursive: true });
  await atomicWrite(STORE_FILE, JSON.stringify(s, null, 2));
}

const upsert = (s: Store, rec: ProjectRecord): void => {
  const i = s.projects.findIndex((p) => p.name.toLowerCase() === rec.name.toLowerCase());
  if (i >= 0) s.projects[i] = rec;
  else s.projects.unshift(rec);
  s.projects = s.projects.slice(0, MAX_PROJECTS);
};

/**
 * EVERY project-memory record as a retrievable entry (Round 19, CHANGE 5 layer C):
 * description, decisions, progress and open issues of each project, each carrying the
 * `project:<name>` scope so retrieval can PRESERVE PROJECT BOUNDARIES (a scope filter
 * keeps one project's context out of another's query). Combined with the long-term
 * memory corpus by find_memory — one retrieval pipeline over all three layers.
 */
export async function listAllProjectRecords(): Promise<Array<{ id: string; text: string; scope: string; updated: number }>> {
  const store = await loadStore();
  const out: Array<{ id: string; text: string; scope: string; updated: number }> = [];
  const hashOf = (s: string): string => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; // stable FNV-ish digest
    return h.toString(36);
  };
  for (const p of store.projects) {
    const scope = `project:${p.name}`;
    // Round 20 (CHANGE 7): STABLE ids — content-addressed, so an edit that shifts a list
    // position no longer changes the id of every later entry (retrieval ids stay
    // traceable across saves; dedupe downstream keeps working).
    if (p.description) out.push({ id: `pm-${p.name}-desc-${hashOf(p.description)}`, text: `${p.name}: ${p.description}`, scope, updated: p.updatedAt });
    if (p.progress) out.push({ id: `pm-${p.name}-progress-${hashOf(p.progress)}`, text: `${p.name} progress: ${p.progress}`, scope, updated: p.updatedAt });
    for (const d of p.decisions) out.push({ id: `pm-${p.name}-dec-${hashOf(d.text)}`, text: `${p.name} decision (${new Date(d.at).toISOString().slice(0, 10)}): ${d.text}`, scope, updated: d.at });
    for (const iss of p.openIssues) out.push({ id: `pm-${p.name}-iss-${hashOf(iss)}`, text: `${p.name} open issue: ${iss}`, scope, updated: p.updatedAt });
  }
  return out;
};

export const projectMemoryTools: Record<string, Tool> = {
  project_save: {
    description:
      'Record or update PROJECT MEMORY for a long-lived project: workspace, stack, dated decisions, key files, current progress, open issues. Use after significant milestones or corrections. This is context, not ground truth — when notes and the actual files disagree, inspect the files.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short project key, e.g. "jarvis-core".' },
        workspace: { type: 'string', description: 'Where the project lives (folder path).' },
        description: { type: 'string', description: 'What the project is, one paragraph.' },
        stack: { type: 'array', items: { type: 'string' }, description: 'Languages, frameworks, notable dependencies.' },
        decision: { type: 'string', description: 'Optional: one NEW decision to append (dated automatically).' },
        keyFiles: { type: 'array', items: { type: 'string' }, description: 'Files that matter most.' },
        progress: { type: 'string', description: 'Where the work stands right now.' },
        openIssues: { type: 'array', items: { type: 'string' }, description: 'Unresolved work items.' },
      },
      required: ['name'],
    },
    run: async (args) => {
      const name = clip(String(args.name ?? '').trim(), 60);
      if (!name) throw new Error('name is required.');
      // Serialized read-modify-write (withStoreLock): two overlapping project_save calls
      // used to load the same base store and the second write silently dropped the
      // first's decisions. Inside the slot, every save builds on the previous one.
      return withStoreLock(STORE_FILE, async () => {
        const store = await loadStore();
        const prev = store.projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
        const decisions = [...(prev?.decisions ?? [])];
        // Round 20 (CHANGE 7): DUPLICATE DETECTION — re-saving the same decision text
        // (case-insensitive) must not append a second copy of the same fact.
        if (typeof args.decision === 'string' && args.decision.trim()) {
          const newText = clip(String(args.decision).trim(), 300);
          const dup = decisions.some((d) => d.text.toLowerCase() === newText.toLowerCase());
          if (!dup) decisions.push({ at: Date.now(), text: newText });
        }
        const rec: ProjectRecord = {
          name,
          workspace: clip(String(args.workspace ?? prev?.workspace ?? ''), 300),
          description: clip(String(args.description ?? prev?.description ?? ''), 1200),
          stack: (Array.isArray(args.stack) ? (args.stack as unknown[]).map((x) => clip(String(x), 60)) : prev?.stack ?? []).slice(0, MAX_ITEMS),
          decisions: decisions.slice(-MAX_ITEMS),
          keyFiles: (Array.isArray(args.keyFiles) ? (args.keyFiles as unknown[]).map((x) => clip(String(x), 300)) : prev?.keyFiles ?? []).slice(0, MAX_ITEMS),
          progress: clip(String(args.progress ?? prev?.progress ?? ''), 1200),
          openIssues: (Array.isArray(args.openIssues) ? (args.openIssues as unknown[]).map((x) => clip(String(x), 300)) : prev?.openIssues ?? []).slice(0, MAX_ITEMS),
          updatedAt: Date.now(),
          // Round 20 (CHANGE 7): PROVENANCE — which execution recorded this version.
          lastSource: callContext().agent,
        };
        upsert(store, rec);
        await saveStore(store);
        return `Project memory saved: ${name} (${rec.decisions.length} decision(s) on record, updated ${displayPath(STORE_FILE)}).`;
      });
    },
  },
  project_read: {
    description: 'Read PROJECT MEMORY for one project (or all projects when no name is given). Context about the project — verify against the actual files before relying on it.',
    parameters: { type: 'object', properties: { name: { type: 'string' } } },
    run: async (args) => {
      const store = await loadStore();
      if (!store.projects.length) return 'No project memory recorded yet. Use project_save after learning a project’s shape.';
      const name = String(args.name ?? '').trim();
      const recs = name ? store.projects.filter((p) => p.name.toLowerCase().includes(name.toLowerCase())) : store.projects;
      if (!recs.length) return `No project memory matches "${name}". Known: ${store.projects.map((p) => p.name).join(', ')}.`;
      return recs
        .map((p) =>
          [
            `# ${p.name} (updated ${new Date(p.updatedAt).toISOString().slice(0, 10)})`,
            p.workspace ? `Workspace: ${p.workspace}` : '',
            p.description ? `What: ${p.description}` : '',
            p.stack.length ? `Stack: ${p.stack.join(', ')}` : '',
            p.keyFiles.length ? `Key files: ${p.keyFiles.join(', ')}` : '',
            p.decisions.length ? `Decisions:\n${p.decisions.map((d) => `- ${new Date(d.at).toISOString().slice(0, 10)} — ${d.text}`).join('\n')}` : '',
            p.progress ? `Progress: ${p.progress}` : '',
            p.openIssues.length ? `Open issues:\n${p.openIssues.map((i) => `- ${i}`).join('\n')}` : '',
            '[Project memory is context, not ground truth — verify against the actual files.]',
          ]
            .filter(Boolean)
            .join('\n')
        )
        .join('\n\n');
    },
  },
};
