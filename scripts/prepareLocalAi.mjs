import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const version = lock.packages?.['node_modules/@huggingface/transformers']?.version;
if (!version) {
  throw new Error('Could not resolve the locked @huggingface/transformers version from package-lock.json.');
}

const target = path.join(root, 'build', 'local-ai');
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
writeFileSync(path.join(target, 'package.json'), JSON.stringify({
  name: 'jini-local-ai-runtime',
  version: '1.0.0',
  private: true,
  description: 'Optional JINI local embeddings runtime',
}, null, 2) + '\n');

const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(command, [
  'install',
  '--prefix', target,
  '--omit=dev',
  '--no-package-lock',
  '--no-audit',
  '--no-fund',
  '--save',
  `@huggingface/transformers@${version}`,
], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`Preparing the optional local AI runtime failed (npm exit code ${result.status ?? 'unknown'}).`);
}
console.log(`Prepared optional JINI local AI runtime: @huggingface/transformers@${version}`);
