import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

/**
 * ROUND 21 CHANGE 1 — THE TWO-RESTRICTION POLICY IS ABSOLUTE AND CONSISTENT.
 *
 * The Round 20 build carried three inherited over-restrictions that this round removes,
 * and this suite pins the corrected contract:
 *   A. Opaque scripts: NO blanket block for being scripts — the CONTENT is classified at
 *      the boundary (open_anything, open_file, run_python startfile) against exactly the
 *      two hard restrictions.
 *   B. Process operations: NO blanket block for involving processes — Python subprocess /
 *      os.system and Node child_process commands are classified by their actual command
 *      text; ordinary dev commands run; destructive/OS commands block; dynamic (unresolvable)
 *      commands fail closed.
 *   C. Keyboard operations: ordinary key input and shortcuts are allowed.
 *   D. Routing: the SAME gate verdicts hold through agent delegation and scheduled turns.
 *
 * Both hard restrictions keep their full strength: user-data deletion and OS-resource
 * modification stay blocked on every route, including through symlink indirection.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import { assessRisk } from '../src/main/guard';
import { authorize } from '../src/main/permission';
import { classifyRealPath, nodeVerdict, osProtectedPath, pythonVerdict, regFileVerdict, shellVerdict } from '../src/main/policy';
import { resetCallContext, setCallContext } from '../src/main/toolRecord';
import { runToolDetailed } from '../src/main/tools';

const ROOT = process.env.JARVIS_FILES_ROOT ?? path.join(os.tmpdir(), `jarvis-test-${process.pid}`);
const gate = async (tool: string, args: Record<string, unknown>, agent = 'main') => {
  const risk = await assessRisk(tool, args);
  return { risk, decision: await authorize({ tool, action: 'execute', resource: '*', risk, agent }) };
};

// --------------------------------------------------------------------- A. opaque scripts

describe('CHANGE 1A — scripts are judged by content, not opacity', () => {
  it('an ordinary .bat, .ps1 and .py script run through open_anything', async () => {
    const dir = path.join(ROOT, 'r21-scripts');
    fs.mkdirSync(dir, { recursive: true });
    const bat = path.join(dir, 'build.bat');
    fs.writeFileSync(bat, '@echo off\nnode --version\n', 'utf8');
    const ps1 = path.join(dir, 'list.ps1');
    fs.writeFileSync(ps1, 'Get-ChildItem -Name\n', 'utf8');
    const py = path.join(dir, 'report.py');
    fs.writeFileSync(py, 'print("hello")\n', 'utf8');
    for (const t of [bat, ps1, py]) {
      const { risk, decision } = await gate('open_anything', { target: t });
      expect(risk, t).toBeNull();
      expect(decision.allowed, t).toBe(true);
    }
  });

  it('a script whose content deletes is blocked (restriction 1), through open_anything, open_file and run_python startfile', async () => {
    const dir = path.join(ROOT, 'r21-scripts');
    fs.mkdirSync(dir, { recursive: true });
    const bat = path.join(dir, 'wipe.bat');
    fs.writeFileSync(bat, '@echo off\ndel /q output.txt\n', 'utf8');
    for (const call of [
      ['open_anything', { target: bat }],
      ['open_file', { path: bat }],
    ] as const) {
      const { risk, decision } = await gate(call[0], call[1] as Record<string, unknown>);
      expect(risk?.block, `${call[0]} ${bat}`).toBe(true);
      expect(decision.allowed).toBe(false);
    }
    const py = `import os\nos.startfile(r'${bat.replace(/\\/g, '\\\\')}')\n`;
    const started = await gate('run_python', { code: py });
    expect(started.risk?.block).toBe(true);
  });

  it('a script whose content writes an OS location is blocked (restriction 2)', async () => {
    const dir = path.join(ROOT, 'r21-scripts');
    fs.mkdirSync(dir, { recursive: true });
    const ps1 = path.join(dir, 'patch.ps1');
    fs.writeFileSync(ps1, 'Set-Content -Path C:\\Windows\\evil.ini -Value "x"\n', 'utf8');
    const { risk } = await gate('open_anything', { target: ps1 });
    expect(risk?.block).toBe(true);
  });

  it('.reg files are judged by their real hive targets', () => {
    expect(regFileVerdict('[HKEY_LOCAL_MACHINE\\SOFTWARE\\X]\n"a"="b"\n').blocked).toBe(true);
    expect(regFileVerdict('[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run]\n"x"="y"\n').blocked).toBe(true);
    expect(regFileVerdict('[HKEY_CURRENT_USER\\Software\\MyApp]\n"theme"="dark"\n').blocked).toBe(false);
  });

  it('an unreadable script target is a technical failure, not a policy block', async () => {
    const ghost = path.join(ROOT, 'r21-scripts', 'does-not-exist.bat');
    const { risk } = await gate('open_anything', { target: ghost });
    expect(risk).toBeNull();
  });
});

// ------------------------------------------------------------------ B. process operations

describe('CHANGE 1B — process operations are ordinary work', () => {
  it('ordinary process creation from Python runs: dev commands, test runners, builds', () => {
    for (const code of [
      'import subprocess\nsubprocess.run(["npm", "test"])',
      'import subprocess\nsubprocess.run(["python", "-m", "pytest", "-q"])',
      'import subprocess as sp\nsp.call(["git", "status"])',
      'from subprocess import run\nrun(["node", "build.js"], check=True)',
      'import os\nos.system("npm run build")',
    ]) {
      const v = pythonVerdict(code);
      expect(v.blocked, code).toBe(false);
    }
  });

  it('ordinary process inspection and creation through the shell stays allowed', () => {
    for (const cmd of ['tasklist', 'Get-Process | Select-Object -First 5', 'start-process notepad.exe', 'wmic process list brief', 'ps aux | head']) {
      expect(shellVerdict(cmd).blocked, cmd).toBe(false);
    }
  });

  it('destructive and OS-configuring spawned commands are still caught (restriction enforcement, not blanket)', () => {
    for (const code of [
      'import subprocess\nsubprocess.run(["rm", "-rf", "x"])',
      'import subprocess\nsubprocess.call("del a.txt", shell=True)',
      'import os\nos.system("rm -rf build")',
      'import subprocess\nsubprocess.run(["reg", "add", "HKLM\\\\X"])',
      'import subprocess\nsubprocess.run(["sc", "delete", "MyService"])',
      'from subprocess import check_output\ncheck_output("git clean -fd", shell=True)',
    ]) {
      const v = pythonVerdict(code);
      expect(v.blocked, code).toBe(true);
    }
    // A nested interpreter payload inside a spawned command is classified too.
    const nested = 'import subprocess\nsubprocess.run(["python", "-c", "import os; os.remove(\'a.txt\')"])';
    expect(pythonVerdict(nested).blocked).toBe(true);
  });

  it('a spawned command that is not a static literal fails closed (unresolvable target)', () => {
    for (const code of [
      'import subprocess\nsubprocess.run(cmd)',
      'import subprocess\nsubprocess.run(f"rm {name}")',
      'import subprocess\nsubprocess.call("rm " + target)',
      'import os\nos.system(get_command())',
    ]) {
      const v = pythonVerdict(code);
      expect(v.blocked, code).toBe(true);
      expect(v.kind, code).toBe('os-resource');
    }
  });

  it('Node child_process commands are classified by their actual command text', () => {
    expect(nodeVerdict("require('child_process').exec('rm -rf dist')").blocked).toBe(true);
    expect(nodeVerdict("require('child_process').execSync('reg add HKLM\\\\X')").blocked).toBe(true);
    expect(nodeVerdict("require('child_process').spawn('npm', ['test'])").blocked).toBe(false);
    expect(nodeVerdict("require('child_process').execSync('npm run build')").blocked).toBe(false);
    // Dynamic → fail closed.
    expect(nodeVerdict("const cp = require('child_process'); cp.exec(cmd)").blocked).toBe(true);
    // No child_process in play → untouched (and eval is a separate pinned fail-closed rule).
    expect(nodeVerdict('const t = { exec: (s) => s }; t.exec("2+2")').blocked).toBe(false);
  });

  it('stopping an OS-critical process stays blocked; ordinary processes stay stoppable', async () => {
    const critical = await gate('stop_process', { name: 'csrss.exe' });
    expect(critical.risk?.block).toBe(true);
    const ordinary = await gate('stop_process', { name: 'notepad.exe' });
    expect(ordinary.risk).toBeNull();
    expect(ordinary.decision.allowed).toBe(true);
  });
});

// -------------------------------------------------------------------- C. keyboard operations

describe('CHANGE 1C — keyboard operations are ordinary', () => {
  it('ordinary keys, shortcuts, Alt+F4 and Delete are allowed through press_keys', async () => {
    for (const keys of ['^s', '%{F4}', '{DEL}', '{ESC}', '+{TAB}', 'plain text']) {
      const { risk, decision } = await gate('press_keys', { keys });
      expect(risk, keys).toBeNull();
      expect(decision.allowed, keys).toBe(true);
    }
  });
});

// ------------------------------------------------------------------------- D. routing

describe('CHANGE 1D — one gate on every route', () => {
  it('ordinary code and ordinary process creation run end-to-end through the central choke point', async () => {
    resetCallContext();
    const res = await runToolDetailed(
      'run_python',
      JSON.stringify({ code: "import subprocess\nr = subprocess.run(['echo', 'spawned-ok'], capture_output=True, text=True)\nprint('jarvis-round21-ok', r.stdout.strip())" })
    );
    expect(res.status).toBe('success');
    expect(res.text).toContain('jarvis-round21-ok');
    expect(res.text).toContain('spawned-ok');
  });

  it('deletion stays blocked end-to-end under an agent context (delegation is not a bypass)', async () => {
    resetCallContext();
    setCallContext({ agent: 'task:general#1', taskId: 'T-21' });
    const target = path.join(ROOT, 'r21-must-survive.txt');
    fs.writeFileSync(target, 'data');
    const res = await runToolDetailed('run_command', JSON.stringify({ command: `rm ${target}` }));
    expect(res.text).toMatch(/^BLOCKED:/);
    expect(fs.existsSync(target)).toBe(true);
    resetCallContext();
  });

  it('a workspace symlink into OS territory is blocked for agents too (restriction holds through indirection)', async () => {
    if (process.platform === 'win32') return; // POSIX CI covers the closure; junctions differ
    const etcLink = path.join(ROOT, 'r21-etc-link');
    try {
      fs.rmSync(etcLink, { force: true, recursive: true });
      fs.symlinkSync('/etc', etcLink, 'dir');
      expect(classifyRealPath(path.join(etcLink, 'passwd'))).toBe('protected');
      const cmd = `echo x > ${path.join(etcLink, 'round21')}`;
      expect(shellVerdict(cmd).blocked).toBe(true);
    } finally {
      fs.rmSync(etcLink, { force: true, recursive: true });
    }
  });

  it('the workspace itself is confirmed NOT protected (ordinary work stays ordinary)', () => {
    expect(osProtectedPath(path.join(ROOT, 'notes', 'todo.txt'))).toBe(false);
    expect(classifyRealPath(path.join(ROOT, 'notes', 'todo.txt'))).toBe('not-protected');
  });
});
