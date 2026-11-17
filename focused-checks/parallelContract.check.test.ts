import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, safeStorage: { isEncryptionAvailable: () => false } }));
import { TESTED_PARALLEL } from '../src/main/capabilityManifest';
import { memoryTools } from '../src/main/memory';
import { impactTools } from '../src/main/impact';

describe('focused: parallel-safe contract after fixes', () => {
  it('memory_maintain (writer) is not declared parallel-safe and is not in the reviewed set', () => {
    expect((memoryTools.memory_maintain as { parallelSafe?: boolean }).parallelSafe).toBeUndefined();
    expect(TESTED_PARALLEL.has('memory_maintain')).toBe(false);
  });

  it('analyze_impact (read-only) is declared parallel-safe and is in the reviewed set', () => {
    expect((impactTools.analyze_impact as { parallelSafe?: boolean }).parallelSafe).toBe(true);
    expect(TESTED_PARALLEL.has('analyze_impact')).toBe(true);
  });
});
