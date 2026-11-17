import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { assessRisk } from '../src/main/guard';
import { authorize } from '../src/main/permission';
import { labelVerdict, osProtectedPath, pythonVerdict, shellVerdict, urlVerdict } from '../src/main/policy';
import { electronStub } from './helpers/electronStub';

/**
 * ADVERSARIAL POLICY PROOFS.
 *
 * The single policy has exactly two hard restrictions: deletion and modification of
 * OS-related files or resources. These tests attack the classifiers the way a model (or a
 * confused instruction inside a page) would: traversal and symlinks, alternate path
 * representations and environment variables, PowerShell aliases and encoded payloads,
 * indirect destruction through scripts and subprocesses, and browser actions whose button
 * label does not reveal the real effect.
 *
 * KNOWN LIMIT, pinned on purpose: a destructive action hidden behind a neutral label AND a
 * neutral URL AND no identifying attribute cannot be classified from the outside (e.g. a
 * bare coordinate click on a canvas). labelVerdict('') / urlVerdict('') staying unblocked
 * documents that boundary honestly — the click guard is a heuristic boundary, not a sandbox.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

const blocked = async (tool: string, args: Record<string, unknown>, agent = 'main') => {
  const risk = await assessRisk(tool, args);
  const decision = await authorize({ tool, action: 'execute', resource: '*', risk, agent });
  return { risk, decision };
};

describe('adversarial paths: traversal, symlinks, device prefixes, short names, env vars', () => {
  it('path traversal cannot walk out of protection', () => {
    for (const p of [
      'C:\\Windows\\..\\Windows\\System32\\config\\SAM',
      'C:\\Windows\\.\\System32\\drivers\\etc\\hosts',
      'C:/Windows/System32/config/SAM',
      'C:\\Program Files\\..\\Program Files\\Untrusted\\x',
      '/etc/../etc/passwd',
    ]) {
      expect(osProtectedPath(p), `traversal must stay protected: ${p}`).toBe(true);
    }
  });

  it('Windows device prefixes (\\\\?\\, \\\\.\\, \\\\?\\UNC\\) cannot alias protected roots', () => {
    for (const p of [
      '\\\\?\\C:\\Windows\\System32\\config\\SAM',
      '\\\\.\\C:\\Windows\\explorer.exe',
      '\\\\?\\UNC\\server\\c$\\Windows\\x',
      '\\\\server\\c$\\Users\\Public\\x',
    ]) {
      expect(osProtectedPath(p), `device path must stay protected: ${p}`).toBe(true);
    }
  });

  it('8.3 short names cannot alias Program Files', () => {
    for (const p of ['C:\\PROGRA~1\\App\\x.dll', 'c:\\progra~2\\app\\x', 'C:\\PROGRA~1']) {
      expect(osProtectedPath(p), `8.3 alias must stay protected: ${p}`).toBe(true);
    }
    // A PROGRA~1 under an ordinary folder is THAT folder's own 8.3 name, not Program Files.
    expect(osProtectedPath('D:\\Data\\PROGRA~1\\x')).toBe(false);
  });

  it('environment variables cannot alias protected roots', () => {
    for (const p of [
      '%SystemRoot%\\System32\\config\\SAM',
      '%WINDIR%\\explorer.exe',
      '%ProgramFiles%\\Untrusted\\writer.cmd',
      '%ProgramFiles(x86)%\\App\\x',
      '%ProgramData%\\Microsoft\\x',
      '$env:SystemRoot\\System32\\drivers\\etc\\hosts',
      '$env:ProgramFiles\\App\\x',
    ]) {
      expect(osProtectedPath(p), `env-var form must stay protected: ${p}`).toBe(true);
    }
  });

  it('file:// URLs name the same protected targets', () => {
    expect(osProtectedPath('file:///C:/Windows/System32/config/SAM')).toBe(true);
    expect(osProtectedPath('file:///etc/passwd')).toBe(true);
  });

  it('relative traversal from the workspace is resolved before classification (enforcement path)', async () => {
    // The pure classifier resolves relative paths against its cwd; the GUARD resolves them
    // against FILES_ROOT before classifying — that is the path a real write_file takes.
    // FILES_ROOT is a temp dir (/tmp/jarvis-test-<pid>): three levels up is the root, so
    // this lands in /etc — protected on the POSIX test platform exactly as ..\..\Windows
    // lands in C:\Windows on the Windows product.
    const { risk, decision } = await blocked('write_file', { path: '../../../etc/passwd', content: 'x' });
    expect(risk?.block, 'relative traversal into /etc must be blocked').toBe(true);
    expect(decision.allowed).toBe(false);
    // A Windows-style traversal into a protected root classifies directly.
    expect(osProtectedPath('C:\\Users\\x\\..\\..\\Windows\\System32\\config\\SAM')).toBe(true);
  });

  it('a symlink that resolves into protected territory is blocked on the real filesystem', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-adv-'));
    try {
      const target = '/etc/hostname'; // exists on the POSIX test platform
      if (!fs.existsSync(target)) return; // platform without /etc: nothing to prove here
      const link = path.join(dir, 'innocent.txt');
      fs.symlinkSync(target, link);
      const { risk, decision } = await blocked('write_file', { path: link, content: 'x' });
      expect(risk?.block, 'write through a symlink into /etc must be blocked').toBe(true);
      expect(decision.allowed).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a symlinked PARENT folder is caught too (the final component does not exist yet)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-adv-'));
    try {
      if (!fs.existsSync('/etc')) return;
      const link = path.join(dir, 'etc-link');
      fs.symlinkSync('/etc', link);
      const { risk } = await blocked('write_file', { path: path.join(link, 'new-file.txt'), content: 'x' });
      expect(risk?.block, 'creating a file under a symlinked /etc parent must be blocked').toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an ordinary symlink (not pointing at OS territory) is NOT over-blocked', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-adv-'));
    try {
      const realFile = path.join(dir, 'real.txt');
      fs.writeFileSync(realFile, 'hello');
      const link = path.join(dir, 'link.txt');
      fs.symlinkSync(realFile, link);
      const { risk, decision } = await blocked('write_file', { path: link, content: 'x' });
      expect(risk?.block ?? false, 'ordinary symlinked writes must stay allowed').toBe(false);
      expect(decision.allowed).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('adversarial shell: env vars, aliases, encoded payloads, indirect deletion', () => {
  it('writes into OS territory through env-var paths are blocked as os-resource', () => {
    for (const cmd of [
      'copy evil.dll "%SystemRoot%\\System32\\evil.dll"',
      'cmd /c copy evil.dll %SystemRoot%\\System32\\evil.dll',
      'powershell -c "Set-Content -Path $env:ProgramFiles\\Evil\\x.txt -Value y"',
      'echo x > "%ProgramData%\\Microsoft\\evil.sys"',
      'msiexec /i pkg.msi INSTALLDIR="C:\\Program Files\\Evil"',
      'tar -xzf bundle.tgz -C "C:\\Program Files\\App"',
      'chmod 777 /etc/passwd',
      'echo x > /etc/cron.d/evil',
      'dd if=img.bin of=/dev/sda',
      'Move-Item payload.dll C:\\Windows\\System32\\payload.dll',
    ]) {
      const v = shellVerdict(cmd);
      expect(v.blocked, `${cmd} must be blocked`).toBe(true);
      expect(v.kind, cmd).toBe('os-resource');
    }
  });

  it('copying FROM protected territory (backup reading) stays allowed', () => {
    for (const cmd of [
      'copy "C:\\Program Files\\App\\a.dll" D:\\backup\\',
      'xcopy "C:\\Program Files\\App" D:\\backup /e',
      'robocopy "C:\\Program Files\\App" D:\\backup /mir',
      'Get-Content "C:\\Windows\\win.ini"',
      'node "C:\\Program Files\\nodejs\\node.exe" server.js',
    ]) {
      expect(shellVerdict(cmd).blocked, `${cmd} is ordinary work and must stay allowed`).toBe(false);
    }
  });

  it('deletion through PowerShell aliases and flag forms is caught', () => {
    for (const cmd of [
      'ri -Path C:\\Users\\me\\a.txt -Recurse',
      'ri "C:\\Users\\me\\a.txt"',
      'ri C:\\Users\\me\\a.txt',
      'erase report.docx',
      'cmd /c "rd /s /q C:\\proj"',
      '(Get-Item C:\\Users\\me\\a.txt).Delete()',
      '$item.Delete()',
    ]) {
      const v = shellVerdict(cmd);
      expect(v.blocked, `${cmd} must be blocked`).toBe(true);
      expect(v.kind, cmd).toBe('deletion');
    }
  });

  it('encoded and opaque PowerShell payloads are fail-closed', () => {
    for (const cmd of [
      'powershell -enc SQBFAFgAIAAoAGkAZQB4ACkA',
      'powershell -EncodedCommand SQBFAFgA',
      'pwsh -ec CgB3AGgAbwBhAG0AaQBjAGkA',
      '[Convert]::FromBase64String("SQBFAFgA") | iex',
    ]) {
      const v = shellVerdict(cmd);
      expect(v.blocked, `${cmd} must be blocked`).toBe(true);
      expect(v.kind, cmd).toBe('os-resource');
    }
  });

  it('indirect deletion through node/JS one-liners is caught', () => {
    for (const cmd of [
      'node -e "require(\'fs\').unlinkSync(\'a.txt\')"',
      'node -e "fs.rmSync(\'build\', { recursive: true })"',
      'node -p "require(\'fs\').rmdirSync(\'x\')"',
      'npx rimraf dist',
      'rimraf ./node_modules',
    ]) {
      const v = shellVerdict(cmd);
      expect(v.blocked, `${cmd} must be blocked`).toBe(true);
      expect(v.kind, cmd).toBe('deletion');
    }
    // Harmless inline code must keep running: the deny words, not the interpreter, decide.
    expect(shellVerdict('node -e "console.log(process.version)"').blocked).toBe(false);
    expect(shellVerdict('npm run build').blocked).toBe(false);
    expect(shellVerdict('powershell -Command "Get-Process | Select-Object -First 5"').blocked).toBe(false);
  });

  it('indirect deletion through wrappers and subprocesses is caught', () => {
    for (const cmd of [
      'bash -c "rm -rf ~/project"',
      'sh -c "unlink file.txt"',
      'start-process powershell -argumentlist "rm x"',
      'cmd /c del report.docx',
      'wscript payload.vbs & del report.docx',
    ]) {
      const v = shellVerdict(cmd);
      expect(v.blocked, `${cmd} must be blocked`).toBe(true);
      expect(v.kind, cmd).toBe('deletion');
    }
  });

  it('indirect deletion through python is caught at the same strength', () => {
    for (const code of [
      'import subprocess\nsubprocess.run(["rm", "-rf", "x"])',
      'import subprocess\nsubprocess.call("del a.txt", shell=True)',
      'os.system("rm -rf build")',
      'from pathlib import Path\nPath("x").unlink(missing_ok=True)',
      'name = "a"\ngetattr(Path(name), "unlink")()',
      'exec("os.re" + "move(x)")',
      '__import__("shutil").rmtree("dist")',
    ]) {
      const v = pythonVerdict(code);
      expect(v.blocked, `${code} must be blocked`).toBe(true);
    }
  });

  it('the same blocks hold for child agents and unattended runs — the boundary is the code, not the caller', async () => {
    for (const agent of ['main', 'task:general#1', 'task:explore#2']) {
      const shell = await blocked('run_command', { command: 'rimraf dist' }, agent);
      expect(shell.decision.allowed, `${agent} must not rimraf`).toBe(false);
      const osWrite = await blocked('run_command', { command: 'copy evil.dll "C:\\Windows\\System32\\evil.dll"' }, agent);
      expect(osWrite.decision.allowed, `${agent} must not write into System32`).toBe(false);
      expect(osWrite.decision.auth).toBe('blocked');
    }
  });
});

describe('adversarial browser: labels that do not reveal the effect', () => {
  it('destructive endpoints are caught by URL classification even when the label is neutral', () => {
    for (const u of [
      'https://shop.example.com/account/delete',
      'https://shop.example.com/settings?do=destroy-account',
      'https://shop.example.com/api/users/42/purge',
      'https://mail.example.com/folder/unsubscribe?confirm=1&op=deactivate',
      'https://files.example.com/download?path=/etc/passwd&op=erase',
    ]) {
      expect(urlVerdict(u).blocked, `${u} must be blocked`).toBe(true);
    }
  });

  it('ordinary URLs are not over-blocked (word-boundary discipline)', () => {
    for (const u of [
      'https://shop.example.com/delivery',
      'https://shop.example.com/checkout?step=2',
      'https://nodelete.example.com/keep-all',
    ]) {
      expect(urlVerdict(u).blocked, `${u} is ordinary navigation and must stay allowed`).toBe(false);
    }
    // ACCEPTED OVER-BLOCK, documented: a URL slug that merely TALKS about deletion
    // (/delete-key-concept as a docs article) classifies as destructive, because a
    // hyphenated compound with a leading deletion verb is indistinguishable from
    // /delete-account from the outside. Fail-closed wins: navigation to such a URL is
    // blocked; the page stays reachable through fetch_url/browser_search text paths.
    expect(urlVerdict('https://docs.example.com/delete-key-concept').blocked).toBe(true);
  });

  it('a neutral label with a destructive identity attribute is caught through the combined metadata line', () => {
    // browser_click classifies labelFor(ref) + hrefFor(ref) + snapshot attrs (id=, name=, act=)
    // through the same verdict functions — the ref metadata makes "Continue" destructively
    // identifiable when the page carries its intent in the DOM.
    expect(labelVerdict('Continue').blocked).toBe(false);
    expect(labelVerdict('Continue {id=delete-user, act=remove}').blocked).toBe(true);
    expect(labelVerdict('Continue https://x.example.com/account/delete').blocked).toBe(true);
  });

  it('the honest limit: a neutral label, neutral URL and no attributes cannot be classified', () => {
    // A POST behind /api/submit with a canvas-drawn button, or a coordinate click, reveals
    // nothing to any outside classifier. These stay unblocked BY DESIGN and the limit is
    // documented in policy.urlVerdict and the hardening report — the manifest states the
    // rule to the model, and this layer enforces what is observable.
    expect(labelVerdict('Continue').blocked).toBe(false);
    expect(urlVerdict('https://shop.example.com/api/submit').blocked).toBe(false);
    expect(labelVerdict('').blocked).toBe(false);
    expect(urlVerdict('').blocked).toBe(false);
  });
});
