import { describe, expect, it } from 'vitest';
import os from 'os'; import path from 'path'; import fs from 'fs'; import { execFileSync } from 'child_process';
import { createGitCheckpoint, restoreGitCheckpoint, deleteGitCheckpoint, listGitCheckpoints } from '../src/main/gitCheckpoints';
describe('git checkpoints', () => {
 it('creates a non-destructive tracked snapshot and restores it explicitly', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jini-checkpoint-'));
  const git=(...a:string[])=>execFileSync('git',a,{cwd:dir,stdio:'ignore'});
  try {
   git('init'); git('config','user.email','test@example.com'); git('config','user.name','Test');
   fs.writeFileSync(path.join(dir,'a.txt'),'base'); git('add','a.txt'); git('commit','-m','base');
   fs.writeFileSync(path.join(dir,'a.txt'),'changed'); const cp=await createGitCheckpoint(dir);
   expect(cp).not.toBeNull(); expect(fs.readFileSync(path.join(dir,'a.txt'),'utf8')).toBe('changed');
   fs.writeFileSync(path.join(dir,'a.txt'),'later'); await restoreGitCheckpoint(dir,cp!.id);
   expect(fs.readFileSync(path.join(dir,'a.txt'),'utf8')).toBe('changed');
   const checkpoints = await listGitCheckpoints(dir);
   const restoreBackupId = checkpoints.map((entry) => entry.split(' ')[0]).find((id) => id !== cp!.id);
   expect(restoreBackupId).toBeTruthy();
   await restoreGitCheckpoint(dir, restoreBackupId!);
   expect(fs.readFileSync(path.join(dir,'a.txt'),'utf8')).toBe('later');
   await deleteGitCheckpoint(dir,cp!.id);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
 });
});

describe('git checkpoints', () => {
  it('creates a restorable baseline even when the worktree is initially clean', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jini-checkpoint-clean-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    try {
      git('init');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      fs.writeFileSync(path.join(dir, 'baseline.txt'), 'baseline');
      git('add', 'baseline.txt');
      git('commit', '-m', 'baseline');
      const checkpoint = await createGitCheckpoint(dir, 'Before first edit');
      expect(checkpoint).not.toBeNull();
      fs.writeFileSync(path.join(dir, 'baseline.txt'), 'changed');
      await restoreGitCheckpoint(dir, checkpoint!.id);
      expect(fs.readFileSync(path.join(dir, 'baseline.txt'), 'utf8')).toBe('baseline');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe('git checkpoint availability', () => {
  it('returns null outside a Git repository instead of failing the agent write path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jini-no-git-'));
    try {
      await expect(createGitCheckpoint(dir)).resolves.toBeNull();
      await expect(listGitCheckpoints(dir)).resolves.toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
