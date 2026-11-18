import { app } from 'electron';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Local AI is an explicit install-time capability. Packaged builds get it only when
 * the user checks the Local AI component in the NSIS installer; development builds
 * use the normal devDependency. No model weights are bundled — they are cached under
 * the user's JINI data directory when a local feature is first used.
 */
export function localAiPackageRoot(): string | null {
  if (app.isPackaged) {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (!resourcesPath) return null;
    const packagedPackage = path.join(resourcesPath, 'local-ai', 'node_modules', '@huggingface', 'transformers', 'package.json');
    return existsSync(packagedPackage) ? path.join(resourcesPath, 'local-ai', 'package.json') : null;
  }

  const developmentPackage = path.join(process.cwd(), 'node_modules', '@huggingface', 'transformers', 'package.json');
  return existsSync(developmentPackage) ? path.join(process.cwd(), 'package.json') : null;
}

export const isLocalAiEnabled = (): boolean => localAiPackageRoot() !== null;
