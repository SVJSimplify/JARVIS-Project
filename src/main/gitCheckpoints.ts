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
  // A clean worktree still needs a baseline checkpoint before its first edit.
  const dirtySnapshot = (await git(root, ['stash', 'create', 'JINI checkpoint'])).stdout.trim();
  const commit = dirtySnapshot || (await git(root, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) return null;
  const id = randomUUID();
  await git(root, ['update-ref', PREFIX + id, commit]);
  return { id, commit, createdAt: Date.now(), label: label.replace(/[\r\n\0]/g, ' ').slice(0, 120) };
}
export async function restoreGitCheckpoint(cwd: string, id: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid checkpoint id.');
  const root = await rootOf(cwd), ref = PREFIX + id;
  const commit = (await git(root, ['rev-parse', '--verify', ref])).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new Error('Checkpoint reference is invalid.');
  // A restore is an explicit rollback, not a merge. Applying a stash onto a dirty
  // worktree fails (or can conflict) and does not restore the checkpoint the user chose.
  // Preserve the current tracked state under a private recovery ref before replacing it.
  const current = (await git(root, ['stash', 'create', 'JINI pre-restore safety snapshot'])).stdout.trim();
  if (current) await git(root, ['update-ref', `refs/jini/checkpoint-backups/${randomUUID()}`, current]);
  // The checkpoint commit's tree is the exact tracked worktree snapshot created earlier.
  // read-tree updates both index and worktree atomically; untracked files are untouched.
  await git(root, ['read-tree', '--reset', '-u', commit]);
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
