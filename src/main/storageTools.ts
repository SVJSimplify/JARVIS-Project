import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Tool } from './toolTypes';
import { emitActivity } from './modes';
import { executionSignal, setToolStatus } from './toolResult';

interface ScanResult {
  path: string;
  bytes: number;
  files: number;
  directories: number;
}

interface Candidate {
  path: string;
  bytes: number;
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
};

const insertTop = (items: Candidate[], candidate: Candidate, limit: number): void => {
  if (items.length >= limit && candidate.bytes <= items[items.length - 1].bytes) return;
  items.push(candidate);
  items.sort((a, b) => b.bytes - a.bytes);
  if (items.length > limit) items.length = limit;
};

const normalizeRoot = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Specify a drive or folder, for example D:\\ or C:\\Users.');
  const drive = process.platform === 'win32' && /^[a-z]:$/i.test(trimmed) ? `${trimmed}\\` : trimmed;
  return path.resolve(drive);
};

const readable = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException)?.code;
  return ['EACCES', 'EPERM', 'EBUSY', 'ENOENT', 'ENOTDIR', 'EIO'].includes(String(code));
};

/**
 * Purpose-built, read-only storage inspection. One bounded traversal returns the biggest
 * files and folders together, so the agent does not need a chain of ad-hoc PowerShell
 * commands. Symlinks/junctions are never followed and inaccessible entries are counted.
 */
export const storageTools: Record<string, Tool> = {
  analyze_storage: {
    description:
      'Analyze disk usage for a drive or folder in ONE read-only scan. Returns drive capacity/free space when supported, total scanned bytes, file/folder counts, largest files and largest directories. Prefer this over run_command, PowerShell or repeated list_files calls for questions like “what is taking up space on D:?”. Does not read file contents or change anything. Symlinks and junctions are skipped.',
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Absolute drive or folder path, e.g. D:\\ or D:.' },
        limit: { type: 'number', minimum: 5, maximum: 50, description: 'Number of largest files and directories to return (default 20).' },
        max_items: { type: 'number', minimum: 1000, maximum: 200000, description: 'Maximum directory entries inspected (default 50000).' },
        max_depth: { type: 'number', minimum: 1, maximum: 24, description: 'Maximum directory depth below root (default 16).' },
        include_hidden: { type: 'boolean', description: 'Include hidden files and folders (default true).' },
      },
      required: ['root'],
    },
    run: async (args) => {
      const root = normalizeRoot(String(args.root ?? ''));
      const limit = Math.max(5, Math.min(50, Math.trunc(Number(args.limit) || 20)));
      const maxItems = Math.max(1000, Math.min(200000, Math.trunc(Number(args.max_items) || 50000)));
      const maxDepth = Math.max(1, Math.min(24, Math.trunc(Number(args.max_depth) || 16)));
      const includeHidden = args.include_hidden !== false;
      const rootStat = await fs.stat(root).catch((error) => {
        throw new Error(`Cannot access ${root}: ${(error as Error).message}`);
      });
      if (!rootStat.isDirectory()) throw new Error(`${root} is not a folder or drive root.`);

      let capacity: number | undefined;
      let free: number | undefined;
      try {
        const stat = await fs.statfs(root);
        capacity = Number(stat.blocks) * Number(stat.bsize);
        free = Number(stat.bavail) * Number(stat.bsize);
      } catch {
        // Some filesystems/platforms do not expose statfs; traversal remains valid.
      }

      const started = Date.now();
      const signal = executionSignal();
      const timeBudgetMs = 120_000;
      let entriesSeen = 0;
      let filesSeen = 0;
      let directoriesSeen = 0;
      let skipped = 0;
      let lastProgress = started;
      let truncated = false;
      const largestFiles: Candidate[] = [];
      const largestDirectories: Candidate[] = [];

      const walk = async (directory: string, depth: number): Promise<ScanResult> => {
        if (signal?.aborted) throw new Error('Interrupted');
        if (Date.now() - started >= timeBudgetMs || entriesSeen >= maxItems) {
          truncated = true;
          return { path: directory, bytes: 0, files: 0, directories: 0 };
        }
        let names: import('node:fs').Dirent[];
        try {
          names = await fs.readdir(directory, { withFileTypes: true });
        } catch (error) {
          if (!readable(error)) throw error;
          skipped++;
          return { path: directory, bytes: 0, files: 0, directories: 0 };
        }

        let bytes = 0;
        let files = 0;
        let directories = 0;
        for (const entry of names) {
          if (signal?.aborted) throw new Error('Interrupted');
          if (Date.now() - started >= timeBudgetMs || entriesSeen >= maxItems) {
            truncated = true;
            break;
          }
          entriesSeen++;
          if (!includeHidden && entry.name.startsWith('.')) continue;
          if (entry.isSymbolicLink()) {
            skipped++;
            continue;
          }
          const full = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            directoriesSeen++;
            directories++;
            if (depth < maxDepth) {
              const child = await walk(full, depth + 1);
              bytes += child.bytes;
              files += child.files;
              directories += child.directories;
              insertTop(largestDirectories, { path: full, bytes: child.bytes }, limit);
            } else {
              truncated = true;
            }
          } else if (entry.isFile()) {
            try {
              const stat = await fs.stat(full);
              bytes += stat.size;
              files++;
              filesSeen++;
              insertTop(largestFiles, { path: full, bytes: stat.size }, limit);
            } catch (error) {
              if (!readable(error)) throw error;
              skipped++;
            }
          }
          if (entriesSeen % 1500 === 0 && Date.now() - lastProgress >= 1200) {
            lastProgress = Date.now();
            emitActivity({
              kind: 'progress',
              label: 'Storage analysis',
              detail: `${entriesSeen.toLocaleString()} entries inspected · ${formatBytes(bytes)} in current branch`,
              status: 'busy',
            });
          }
        }
        return { path: directory, bytes, files, directories };
      };

      const result = await walk(root, 0);
      const elapsed = Date.now() - started;
      const lines = [
        `STORAGE ANALYSIS: ${root}`,
        capacity !== undefined && free !== undefined
          ? `Drive: ${formatBytes(capacity)} total · ${formatBytes(free)} free · ${formatBytes(capacity - free)} used`
          : 'Drive capacity/free-space metadata unavailable; scanned folder totals follow.',
        `Scanned: ${formatBytes(result.bytes)} · ${filesSeen.toLocaleString()} files · ${directoriesSeen.toLocaleString()} directories · ${entriesSeen.toLocaleString()} entries · ${elapsed}ms`,
        `Largest files (top ${largestFiles.length}):`,
        ...largestFiles.map((file, index) => `${index + 1}. ${formatBytes(file.bytes)} — ${file.path}`),
        `Largest directories (top ${largestDirectories.length}, recursive sizes):`,
        ...largestDirectories.map((dir, index) => `${index + 1}. ${formatBytes(dir.bytes)} — ${dir.path}`),
        `Skipped inaccessible entries/symlinks: ${skipped}`,
        truncated ? 'SCAN INCOMPLETE: the item or 120-second scan budget was reached. Narrow the folder or run another focused scan.' : 'SCAN COMPLETE.',
      ];
      if (truncated) {
        setToolStatus({ status: 'error', errorKind: 'partial-scan', soft: true });
        lines.unshift('PARTIAL:');
      }
      emitActivity({
        kind: 'progress',
        label: 'Storage analysis complete',
        detail: `${filesSeen.toLocaleString()} files · ${formatBytes(result.bytes)} scanned · ${elapsed}ms${truncated ? ' · partial scan' : ''}`,
        status: truncated ? 'fail' : 'ok',
      });
      return lines.join('\\n');
    },
  },
};
