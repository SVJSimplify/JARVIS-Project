import os from 'os';
import path from 'path';
import { mkdirSync } from 'fs';

// Pure-logic modules read FILES_ROOT at import time: point it at a temp dir so
// tests never touch the real Jarvis-Files workspace.
const root = path.join(os.tmpdir(), `jarvis-test-${process.pid}`);
mkdirSync(root, { recursive: true });
process.env.JARVIS_FILES_ROOT = root;
