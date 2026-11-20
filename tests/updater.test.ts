import { describe, expect, it } from 'vitest';
import { compareDesktopVersions } from '../src/main/updateVersion';

describe('desktop update version comparison', () => {
  it('compares numeric version components rather than strings', () => {
    expect(compareDesktopVersions('1.0.12', '1.0.9')).toBe(1);
    expect(compareDesktopVersions('1.1.0', '1.0.99')).toBe(1);
    expect(compareDesktopVersions('1.0.8', '1.0.9')).toBe(-1);
    expect(compareDesktopVersions('1.0.9', '1.0.9')).toBe(0);
  });

  it('rejects versions outside the release manifest format', () => {
    expect(() => compareDesktopVersions('latest', '1.0.9')).toThrow();
    expect(() => compareDesktopVersions('1.0.9-beta', '1.0.8')).toThrow();
  });
});
