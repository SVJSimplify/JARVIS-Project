import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Tool } from './toolTypes';

export interface SkillDescriptor {
  name: string;
  description: string;
  file: string;
  source: 'workspace' | 'project' | 'user';
}

const MAX_SKILL_BYTES = 24 * 1024;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const roots = (): Array<{ dir: string; source: SkillDescriptor['source'] }> => [
  { dir: path.join(process.cwd(), '.jini', 'skills'), source: 'project' },
  { dir: path.join(process.cwd(), '.agents', 'skills'), source: 'project' },
  { dir: path.join(process.cwd(), '.claude', 'skills'), source: 'project' },
  { dir: path.join(os.homedir(), '.config', 'jini', 'skills'), source: 'user' },
  { dir: path.join(os.homedir(), '.agents', 'skills'), source: 'user' },
  { dir: path.join(os.homedir(), '.claude', 'skills'), source: 'user' },
];

const parseFrontmatter = (raw: string, fallbackName: string): { name: string; description: string } => {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  const front = match?.[1] ?? '';
  const read = (key: string): string => {
    const line = front.split(/\r?\n/).find((row) => new RegExp('^\\s*' + key + '\\s*:').test(row));
    return line ? line.replace(/^\s*[^:]+:\s*/, '').replace(/^['"]|['"]$/g, '').trim() : '';
  };
  return { name: read('name') || fallbackName, description: read('description') || 'Reusable instructions for a focused workflow.' };
};

export async function discoverSkills(): Promise<SkillDescriptor[]> {
  const found = new Map<string, SkillDescriptor>();
  for (const root of roots()) {
    let dirs: import('node:fs').Dirent[] = [];
    try { dirs = await fs.readdir(root.dir, { withFileTypes: true }); } catch { continue; }
    for (const dir of dirs) {
      if (!dir.isDirectory() || !NAME.test(dir.name)) continue;
      const file = path.join(root.dir, dir.name, 'SKILL.md');
      try {
        const realRoot = await fs.realpath(root.dir);
        const realFile = await fs.realpath(file);
        if (!realFile.startsWith(realRoot + path.sep)) continue;
        const stat = await fs.stat(realFile);
        if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) continue;
        const raw = await fs.readFile(realFile, 'utf8');
        const meta = parseFrontmatter(raw, dir.name);
        if (!NAME.test(meta.name) || meta.name !== dir.name) continue;
        if (!found.has(meta.name)) found.set(meta.name, { ...meta, file: realFile, source: root.source });
      } catch { /* a missing, unreadable or unsafe skill is simply not discoverable */ }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Compact index only; full instructions are loaded on demand to protect the context budget. */
export async function getSkillsPrompt(): Promise<string> {
  const skills = await discoverSkills();
  if (!skills.length) return 'No local skills are installed. Skills can be added as <name>/SKILL.md under .jini/skills or ~/.config/jini/skills.';
  return 'AVAILABLE SKILLS (load only when relevant with the skill tool):\n' +
    skills.map((s) => '- ' + s.name + ' — ' + s.description + ' [' + s.source + ']').join('\n');
}

export const skillTools: Record<string, Tool> = {
  skill: {
    description: 'Load the full instructions for one installed skill. First inspect the available skills in the system context; load only a skill relevant to the current request. Skills are instructions, not permission grants: all actions still use JINI tools and their normal safety checks.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'Exact installed skill name.' } }, required: ['name'] },
    run: async (args) => {
      const name = String(args.name ?? '').trim();
      if (!NAME.test(name)) throw new Error('Invalid skill name.');
      const selected = (await discoverSkills()).find((s) => s.name === name);
      if (!selected) throw new Error('That skill is not installed or is not accessible.');
      const raw = await fs.readFile(selected.file, 'utf8');
      if (Buffer.byteLength(raw, 'utf8') > MAX_SKILL_BYTES) throw new Error('Skill instructions exceed the 24 KB safety limit.');
      const body = raw.replace(/^---\s*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
      return ('SKILL: ' + selected.name + '\n' + selected.description + '\n\n' + body).slice(0, MAX_SKILL_BYTES);
    },
  },
};
