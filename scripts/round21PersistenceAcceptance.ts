import { app, safeStorage } from 'electron';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import * as path from 'path';

/**
 * ROUND 21 — PERSISTENCE + CREDENTIAL RESTART ACCEPTANCE (two real OS processes).
 *
 *   phase=write  (process 1): wires the REAL Electron safeStorage cipher, stores an
 *                embeddings key + provider config, writes a memory through the REAL
 *                memory tool, then exits cleanly.
 *   phase=verify (process 2, a fresh OS process): reads the SAME stores back through the
 *                real modules — the memory must be there, the key must decrypt, and the
 *                on-disk config must hold ONLY the encrypted representation.
 *
 * Any failure exits non-zero. No mocks; the same modules the packaged app runs.
 */

const phase = process.argv.find((a) => a.startsWith('--phase='))?.split('=')[1] ?? 'write';
const dataRoot = process.env.JARVIS_FILES_ROOT ?? '/tmp/jarvis-r21-persist-data';
const reportPath = '/tmp/jarvis-r21-persist-report.json';

// The REAL cipher, exactly as index.ts wires it in production.
import { setEmbeddingsCipher, setEmbeddingsConfig, getEmbeddingsConfig, getEmbeddingsKeyStatus, migrateEmbeddingsKeyStorage } from '../src/main/embeddings';
import { memoryTools } from '../src/main/memory';

const SECRET = 'sk-r21-restart-secret-9f2c';
const results: Record<string, unknown> = { phase, at: new Date().toISOString() };

app.whenReady().then(async () => {
  let ok = false;
  try {
    setEmbeddingsCipher({
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
      decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
    });
    results.safeStorageAvailable = safeStorage.isEncryptionAvailable();
    mkdirSync(path.join(dataRoot, 'brain'), { recursive: true });
    const configFile = path.join(dataRoot, 'brain', 'embeddings.json');

    if (phase === 'write') {
      // Store the key the way the settings flow does (encrypted at rest when possible).
      const cfg = await setEmbeddingsConfig({ provider: 'openai', baseUrl: 'https://embed.example.test/v1', model: 'text-embedding-3-small', apiKey: SECRET });
      results.storedProvider = cfg.provider;
      // Migration is a no-op here (already encrypted) — proves idempotence on the real path.
      results.migration = (await migrateEmbeddingsKeyStorage()).status;
      // A memory through the REAL tool (persisted store, not mocked).
      const remember = memoryTools.remember as { run: (a: Record<string, unknown>) => Promise<string> };
      results.remember = await remember.run({ fact: 'round21 persistence probe: the quarterly report lives in reports/quarterly.xlsx' });
      ok = true;
    } else {
      // VERIFY phase (fresh process): everything must come back through the real modules.
      const cfg = await getEmbeddingsConfig();
      results.keyDecrypted = cfg.apiKey === SECRET;
      results.providerPreserved = cfg.provider === 'openai' && cfg.baseUrl === 'https://embed.example.test/v1' && cfg.model === 'text-embedding-3-small';
      results.keyStatus = await getEmbeddingsKeyStatus();
      const onDisk = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
      results.noPlaintextOnDisk = !('apiKey' in onDisk) && typeof onDisk.apiKeyEncrypted === 'string' && String(onDisk.apiKeyEncrypted).length > 0;
      const list = memoryTools.list_memories as { run: (a: Record<string, unknown>) => Promise<string> | string };
      const mem = String(await list.run({}));
      results.memoryPersisted = /quarterly\.xlsx/i.test(mem);
      ok =
        results.keyDecrypted === true &&
        results.providerPreserved === true &&
        results.keyStatus === 'encrypted' &&
        results.noPlaintextOnDisk === true &&
        results.memoryPersisted === true;
    }
  } catch (e) {
    results.error = e instanceof Error ? e.message : String(e);
    ok = false;
  }
  results.ok = ok;
  writeFileSync(reportPath, JSON.stringify({ ...results, phase }, null, 1));
  console.log(`[persist-${phase}]`, JSON.stringify(results));
  app.exit(ok ? 0 : 1);
});
