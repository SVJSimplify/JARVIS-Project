import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { assessRisk } from '../src/main/guard';
import { authorize } from '../src/main/permission';
import { interpreterPayloads, nodeJsVerdict, osProtectedPath, shellVerdict } from '../src/main/policy';
import { setPidNameResolver } from '../src/main/procInfo';
import { resolveWrite } from '../src/main/workspace';
import { electronStub } from './helpers/electronStub';

/**
 * ROUND 17 — SECURITY FOUNDATION REGRESSION SUITE.
 *
 * Pins the Phase-1 closures: F-01 (interpreter one-liners route through the central
 * classifiers), F-02 (copy-from-protected stays allowed, move-from-protected is blocked,
 * and the tool layer agrees with the shell layer), F-04 (one authoritative protected-path
 * classifier — workspace.resolveWrite uses the policy list, closing the apply_patch gap),
 * F-05 (pid stop calls resolve identity first and fail closed).
 */
vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

const blocked = async (tool: string, args: Record<string, unknown>, agent = 'main') => {
  const risk = await assessRisk(tool, args);
  const decision = await authorize({ tool, action: 'execute', resource: '*', risk, agent });
  return { risk, decision };
};

describe('F-01: interpreter one-liners are executable payloads, not command text', () => {
  it('python -c payloads are classified by pythonVerdict through shellVerdict', () => {
    for (const cmd of [
      'python -c "import os; os.remove(\'a.txt\')"',
      'python3 -c "import shutil; shutil.rmtree(\'build\')"',
      'python -c "import subprocess; subprocess.run([\'rm\', \'-rf\', \'x\'])"',
      'python -c "open(\'/etc/passwd\',\'w\').write(\'x\')"',
      'py -c "from pathlib import Path; Path(\'x\').unlink()"',
    ]) {
      const v = shellVerdict(cmd);
      expect(v.blocked, `${cmd} must be blocked`).toBe(true);
    }
  });

  it('node -e payloads are classified by nodeJsVerdict through shellVerdict', () => {
    for (const cmd of [
      'node -e "require(\'fs\').writeFileSync(\'/etc/hosts\', \'x\')"',
      'node --eval "require(\'fs\').promises.writeFile(\'C:\\\\Windows\\\\evil.txt\', \'x\')"',
      'node -e "fs.rmSync(\'dist\', { recursive: true })"',
    ]) {
      const v = shellVerdict(cmd);
      expect(v.blocked, `${cmd} must be blocked`).toBe(true);
    }
  });

  it('ruby/perl deletion one-liners are caught by the word layer', () => {
    for (const cmd of [
      'ruby -e "File.delete(\'a.txt\')"',
      'ruby -e "require \'fileutils\'; FileUtils.rm_rf(\'build\')"',
      'perl -e "unlink \'a.txt\'"',
    ]) {
      expect(shellVerdict(cmd).blocked, `${cmd} must be blocked`).toBe(true);
    }
  });

  it('harmless interpreter payloads keep running (deny words decide, not the interpreter)', () => {
    for (const cmd of [
      'python -c "print(2 + 2)"',
      'python3 -c "import json; print(json.dumps({\'a\': 1}))"',
      'node -e "console.log(process.version)"',
      'node -p "1 + 1"',
    ]) {
      expect(shellVerdict(cmd).blocked, `${cmd} is ordinary work`).toBe(false);
    }
  });

  it('payload extraction is quote-aware and fails closed on unterminated quotes', () => {
    expect(interpreterPayloads('python -c "import os; os.remove(\'x\')"')[0]).toMatchObject({ kind: 'python' });
    expect(interpreterPayloads(`python3 -c 'print("hi")'`)[0]?.code).toBe('print("hi")');
    // unterminated quote → the whole remainder is treated as payload (fail closed)
    const unter = interpreterPayloads('node -e "require(\'fs\').write');
    expect(unter[0]?.code).toContain('require');
    // unquoted payload ends at the separator
    expect(interpreterPayloads('node -e console.log(1) && echo done')[0]?.code).toBe('console.log(1) ');
  });

  it('nodeJsVerdict pairs protected literals with write APIs (and only then blocks)', () => {
    expect(nodeJsVerdict('require("fs").writeFileSync("/etc/hosts", "x")').blocked).toBe(true);
    expect(nodeJsVerdict('console.log("/etc/hosts")').blocked).toBe(false);
    expect(nodeJsVerdict('require("fs").writeFileSync("./notes.txt", "x")').blocked).toBe(false);
  });

  it('the payloads are blocked through the FULL gate for every agent identity', async () => {
    for (const agent of ['main', 'task:general#1', 'task:researcher#2']) {
      const py = await blocked('run_command', { command: 'python -c "import os; os.remove(\'a.txt\')"' }, agent);
      expect(py.decision.allowed, `${agent} must not delete through python`).toBe(false);
      expect(py.decision.auth).toBe('blocked');
      const nd = await blocked('run_command', { command: 'node -e "require(\'fs\').writeFileSync(\'/etc/hosts\',\'x\')"' }, agent);
      expect(nd.decision.allowed, `${agent} must not write /etc/hosts through node`).toBe(false);
    }
  });
});

describe('F-02: copy vs move semantics against protected sources', () => {
  it('the shell layer: copying FROM protected stays allowed, moving FROM protected is blocked', () => {
    for (const cmd of ['copy "C:\\Program Files\\App\\a.dll" D:\\backup\\', 'robocopy "C:\\Program Files\\App" D:\\backup /mir', 'xcopy "C:\\Program Files\\App" D:\\backup /e']) {
      expect(shellVerdict(cmd).blocked, `${cmd} is a backup read`).toBe(false);
    }
    const mv = shellVerdict('move "C:\\Program Files\\App\\a.dll" D:\\backup\\');
    expect(mv.blocked, 'move out of protected territory must be blocked').toBe(true);
    expect(mv.kind).toBe('os-resource');
    expect(mv.reason).toContain('Moving content out');
    const psmv = shellVerdict('Move-Item "C:\\Windows\\win.ini" D:\\backup\\win.ini');
    expect(psmv.blocked).toBe(true);
    // tar archiving FROM protected stays fail-closed: the verb/argument layout is too
    // ambiguous to classify reliably ("copy it instead" is the honest answer).
    expect(shellVerdict('tar -cf backup.tar "C:\\Windows\\win.ini"').blocked).toBe(true);
  });

  it('the tool layer agrees: copy_file from protected passes the guard, move_file from protected is blocked', async () => {
    const cp = await blocked('copy_file', { from: 'C:\\Program Files\\App\\a.dll', to: 'D:\\backup\\a.dll' });
    expect(cp.decision.allowed, 'backup copy FROM protected must stay allowed').toBe(true);
    const mv = await blocked('move_file', { from: 'C:\\Program Files\\App\\a.dll', to: 'D:\\backup\\a.dll' });
    expect(mv.decision.allowed, 'move FROM protected must be blocked at the gate').toBe(false);
    expect(mv.decision.auth).toBe('blocked');
  });

  it('copy INTO protected is still blocked; the exception never became a write exception', async () => {
    const into = await blocked('copy_file', { from: 'D:\\evil.dll', to: 'C:\\Windows\\System32\\evil.dll' });
    expect(into.decision.allowed).toBe(false);
  });

  it('an aliases/variant source that realpaths into protected territory is still allowed to COPY (read), and move stays blocked', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-f02-'));
    try {
      if (!fs.existsSync('/etc/hostname')) return;
      const link = path.join(dir, 'host.txt');
      fs.symlinkSync('/etc/hostname', link);
      const cp = await blocked('copy_file', { from: link, to: path.join(dir, 'host-copy.txt') });
      expect(cp.decision.allowed, 'copying FROM a symlink into /etc is a read and stays allowed').toBe(true);
      const mv = await blocked('move_file', { from: link, to: path.join(dir, 'host-moved.txt') });
      expect(mv.decision.allowed, 'moving out of protected territory must be blocked').toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('F-04: one authoritative protected-path classifier everywhere', () => {
  it('workspace.resolveWrite enforces the FULL policy list (apply_patch inherits it)', async () => {
    for (const p of ['C:\\Users\\me\\ntuser.dat', '/etc/hosts', '\\\\host\\c$\\Windows\\x']) {
      await expect(resolveWrite(p), `resolveWrite must refuse ${p}`).rejects.toThrow(/protected/i);
    }
    // Ordinary folders stay writable.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-f04-'));
    try {
      await expect(resolveWrite(path.join(dir, 'new.txt'))).resolves.toBeTruthy();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the classifier set has no drifting duplicate: workspace agrees with policy on adversarial forms', async () => {
    for (const p of ['C:\\Windows\\System32\\config\\SAM', '%SystemRoot%\\explorer.exe', '/usr/bin/vim', 'C:\\PROGRA~1\\x.dll']) {
      await expect(resolveWrite(p)).rejects.toThrow();
      expect(osProtectedPath(p)).toBe(true);
    }
  });

  it('apply_patch can no longer reach weak-list-only targets (NTUSER.DAT / /etc / UNC)', async () => {
    const nt = await blocked('apply_patch', { patch: '*** Update File: C:\\Users\\me\\ntuser.dat\n@@\n-x\n+y\n' });
    expect(nt.decision.allowed, 'patching NTUSER.DAT must be blocked').toBe(false);
    const etc = await blocked('apply_patch', { patch: '*** Update File: /etc/hosts\n@@\n-x\n+y\n' });
    expect(etc.decision.allowed, 'patching /etc/hosts must be blocked').toBe(false);
  });
});

describe('F-05: pid-based stop_process resolves identity before policy', () => {
  afterEach(() => setPidNameResolver(null));

  it('a pid whose resolved name is protected is blocked with the SAME verdict as a name call', async () => {
    setPidNameResolver(async () => 'msmpeng');
    const byPid = await blocked('stop_process', { pid: 1234 });
    expect(byPid.decision.allowed, 'MsMpEng must be protected by pid too').toBe(false);
    expect(byPid.decision.auth).toBe('blocked');
    const byName = await blocked('stop_process', { name: 'msmpeng' });
    expect(byName.decision.allowed).toBe(false);
  });

  it('JARVIS itself is protected however it is addressed', async () => {
    const self = await blocked('stop_process', { pid: process.pid });
    expect(self.decision.allowed).toBe(false);
  });

  it('an unverifiable pid FAILS CLOSED (no kill on trust)', async () => {
    setPidNameResolver(async () => null);
    const unknown = await blocked('stop_process', { pid: 424242 });
    expect(unknown.decision.allowed, 'unknown pid must be refused').toBe(false);
    expect(unknown.risk?.title).toContain('identity');
    setPidNameResolver(async () => {
      throw new Error('tasklist exploded');
    });
    const errored = await blocked('stop_process', { pid: 5 });
    expect(errored.decision.allowed, 'resolver failure must fail closed').toBe(false);
  });

  it('an ordinary pid resolves and passes policy; explorer is protected by the unified list', async () => {
    setPidNameResolver(async () => 'notepad');
    const ok = await blocked('stop_process', { pid: 777 });
    expect(ok.decision.allowed, 'stopping notepad is an ordinary action').toBe(true);
    setPidNameResolver(async () => 'explorer');
    const ex = await blocked('stop_process', { pid: 888 });
    expect(ex.decision.allowed, 'explorer is protected by the ONE unified list').toBe(false);
  });
});

describe('F-01 follow-up: diagnostics is inside the boundary', () => {
  it('the guard judges the model-supplied tsconfig path', async () => {
    const bad = await blocked('diagnostics', { project: 'C:\\Windows\\System32\\tsconfig.json' });
    expect(bad.decision.allowed, 'diagnostics against a system path must be blocked').toBe(false);
    const good = await blocked('diagnostics', { project: 'tsconfig.node.json' });
    expect(good.decision.allowed).toBe(true);
  });
});
