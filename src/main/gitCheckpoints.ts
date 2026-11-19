/** Git checkpoints inspired by Cline, adapted to Jini's shared process runner.
 * Creation uses git stash create + a private ref and never resets the worktree.
 * Restore is explicit. git stash create snapshots tracked changes only; untracked files
 * are intentionally excluded, so this is not a complete filesystem backup.
 */
import { randomUUID } from 'crypto';
import { runProcessChecked } from './processRunner';
const PREFIX = 'refs/jini/checkpoints/';
const git = (cwd: string, args: string[]) => runProcessChecked('git', args, { cwd, timeoutMs: 30000, maxBufferBytes: 2 * 1024 * 1024 });
const rootOf = async (cwd: string): Promise<string> => (await git(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim();
export interface GitCheckpoint { id: string; commit: string; createdAt: number; label: string; }
export async function createGitCheckpoint(cwd: string, label = 'Before agent changes'): Promise<GitCheckpoint | null> {
  const root = await rootOf(cwd);
  const commit = (await git(root, ['stash', 'create', 'JINI checkpoint'])).stdout.trim();
  if (!commit) return null;
  const id = randomUUID();
  await git(root, ['update-ref', PREFIX + id, commit]);
  return { id, commit, createdAt: Date.now(), label: label.replace(/[\r\n\0]/g, ' ').slice(0, 120) };
}
export async function restoreGitCheckpoint(cwd: string, id: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid checkpoint id.');
  const root = await rootOf(cwd), ref = PREFIX + id;
  const commit = (await git(root, ['rev-parse', '--verify', ref])).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new Error('Checkpoint reference is invalid.');
  await git(root, ['stash', 'apply', '--index', commit]);
}
export async function deleteGitCheckpoint(cwd: string, id: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid checkpoint id.');
  const root = await rootOf(cwd);
  await git(root, ['update-ref', '-d', PREFIX + id]);
}
export async function listGitCheckpoints(cwd: string): Promise<string[]> {
  const root = await rootOf(cwd);
  const out = await git(root, ['for-each-ref', '--format=%(refname:strip=3) %(objectname)', PREFIX]);
  return out.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}
