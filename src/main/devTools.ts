import { execFile } from 'child_process';
import type { Tool } from './toolTypes';
import { FILES_ROOT } from './workspace';

const TAIL = 6000;
const DENY = /\b(format\s+[a-z]:|diskpart|shutdown|Remove-Item\s+.*-Recurse.*\s[a-z]:\\?\s*$|rd\s+\/s\s+\/q\s+[a-z]:\\?\s*$|reg\s+delete|bcdedit)\b/i;

const runShell = (command: string, cwd: string, timeout: number): Promise<string> =>
  new Promise((resolve) =>
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { cwd, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const out = `${stdout}${stderr}`.trim();
        const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0;
        resolve(`exit ${code}\n${out.length > TAIL ? '…' + out.slice(-TAIL) : out}`);
      }
    )
  );

export const devTools: Record<string, Tool> = {
  diagnostics: {
    description:
      'Type-check a TypeScript project (tsc --noEmit) and list compiler errors with file:line. Use after editing code, before declaring it done.',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project folder containing tsconfig.json. Defaults to the Jarvis-Files workspace.' },
        project: { type: 'string', description: 'Optional tsconfig path, e.g. tsconfig.node.json' },
      },
    },
    run: async (args) => {
      const project = args.project ? ` -p '${String(args.project).replace(/'/g, "''")}'` : '';
      const out = await runShell(`npx --no-install tsc --noEmit --pretty false${project}`, String(args.cwd || FILES_ROOT), 180_000);
      return out.startsWith('exit 0') ? 'No type errors.' : out;
    },
  },
  run_command: {
    description:
      'Run a PowerShell command to build, run, test or debug code and read its output (stdout+stderr tail, exit code). Use it in a loop: reproduce, inspect, fix, rerun.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string', description: 'Working folder. Defaults to the Jarvis-Files workspace.' },
        timeout_s: { type: 'number', description: 'Default 120, max 600.' },
      },
      required: ['command'],
    },
    run: (args) => {
      const command = String(args.command ?? '');
      if (DENY.test(command)) throw new Error('Command blocked as destructive.');
      const timeout = Math.min(Number(args.timeout_s) || 120, 600) * 1000;
      return runShell(command, String(args.cwd || FILES_ROOT), timeout);
    },
  },
};
