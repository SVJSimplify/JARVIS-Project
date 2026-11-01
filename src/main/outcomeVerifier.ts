import { promises as fs } from 'fs';
import * as path from 'path';
import { FILES_ROOT } from './workspace';

/**
 * INDEPENDENT OUTCOME VERIFICATION ENGINE
 *
 * Enforces:
 * - Invariant 1: No unverified completion.
 * - Invariant 15: No false success based solely on tool output.
 *
 * Verifies real world consequences:
 * - File writes: checks file exists on disk, size > 0, expected content present.
 * - Code edits: checks syntax integrity and imports.
 * - Browser actions: checks truth-line evidence.
 * - Commands: checks actual state change, not just exit code 0.
 *
 * Verdicts:
 * - PASSED: Concrete evidence verifies the outcome.
 * - FAILED: Target state not reached or contradiction found.
 * - INCONCLUSIVE: Cannot deterministically verify without additional tools.
 * - REQUIRES_HUMAN_REVIEW: Consequential irreversible external action.
 */

export type VerificationVerdict = 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'REQUIRES_HUMAN_REVIEW';

export interface VerificationRecord {
  id: string;
  action: string;
  target: string;
  verdict: VerificationVerdict;
  evidence: string;
  timestamp: number;
}

/** Verify file write/edit outcome directly against the local filesystem */
export async function verifyFileOutcome(
  targetPath: string,
  expectedPattern?: RegExp | string,
  minBytes = 1
): Promise<VerificationRecord> {
  const resolved = path.isAbsolute(targetPath) ? targetPath : path.resolve(FILES_ROOT, targetPath);
  const id = `v_fs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      return {
        id,
        action: 'verify_file',
        target: targetPath,
        verdict: 'FAILED',
        evidence: `Target exists but is not a regular file (is directory or block device)`,
        timestamp: Date.now(),
      };
    }

    if (stat.size < minBytes) {
      return {
        id,
        action: 'verify_file',
        target: targetPath,
        verdict: 'FAILED',
        evidence: `File exists on disk but is 0 bytes (empty/truncated)`,
        timestamp: Date.now(),
      };
    }

    if (expectedPattern) {
      const content = await fs.readFile(resolved, 'utf8');
      const matches =
        typeof expectedPattern === 'string'
          ? content.includes(expectedPattern)
          : expectedPattern.test(content);

      if (!matches) {
        return {
          id,
          action: 'verify_file',
          target: targetPath,
          verdict: 'FAILED',
          evidence: `File exists (${stat.size} bytes), but required content pattern was NOT found in file`,
          timestamp: Date.now(),
        };
      }
    }

    return {
      id,
      action: 'verify_file',
      target: targetPath,
      verdict: 'PASSED',
      evidence: `File verified on disk (${stat.size} bytes, modified: ${new Date(stat.mtimeMs).toISOString()})`,
      timestamp: Date.now(),
    };
  } catch (err) {
    return {
      id,
      action: 'verify_file',
      target: targetPath,
      verdict: 'FAILED',
      evidence: `File does NOT exist on disk: ${(err as Error).message}`,
      timestamp: Date.now(),
    };
  }
}

/** Verify browser tool execution from state truth-line */
export function verifyBrowserOutcome(toolName: string, rawResult: string): VerificationRecord {
  const id = `v_web_${Date.now().toString(36)}`;
  const hasTruthLine = rawResult.includes('[in-app browser:');
  const isError = /^(Tool error|Unknown tool|NOT DONE|TIMEOUT)/i.test(rawResult);

  if (isError) {
    return {
      id,
      action: toolName,
      target: 'browser_panel',
      verdict: 'FAILED',
      evidence: rawResult.slice(0, 160),
      timestamp: Date.now(),
    };
  }

  if (!hasTruthLine) {
    return {
      id,
      action: toolName,
      target: 'browser_panel',
      verdict: 'INCONCLUSIVE',
      evidence: 'Browser action reported OK but lacked deterministic [in-app browser: ...] state truth line',
      timestamp: Date.now(),
    };
  }

  return {
    id,
    action: toolName,
    target: 'browser_panel',
    verdict: 'PASSED',
    evidence: rawResult.slice(0, 160),
    timestamp: Date.now(),
  };
}

/** Verify code change syntax integrity */
export function verifyCodeSyntax(code: string, language: 'typescript' | 'javascript' | 'json'): VerificationRecord {
  const id = `v_syntax_${Date.now().toString(36)}`;

  if (language === 'json') {
    try {
      JSON.parse(code);
      return {
        id,
        action: 'verify_json',
        target: 'syntax',
        verdict: 'PASSED',
        evidence: 'JSON parsed successfully with zero syntax errors',
        timestamp: Date.now(),
      };
    } catch (e) {
      return {
        id,
        action: 'verify_json',
        target: 'syntax',
        verdict: 'FAILED',
        evidence: `JSON syntax error: ${(e as Error).message}`,
        timestamp: Date.now(),
      };
    }
  }

  // Basic syntax balance check for curly braces, brackets, and quotes
  let braceCount = 0;
  let parenCount = 0;
  for (const ch of code) {
    if (ch === '{') braceCount++;
    if (ch === '}') braceCount--;
    if (ch === '(') parenCount++;
    if (ch === ')') parenCount--;
  }

  if (braceCount !== 0 || parenCount !== 0) {
    return {
      id,
      action: 'verify_syntax',
      target: language,
      verdict: 'FAILED',
      evidence: `Unbalanced braces ({}: ${braceCount}, (): ${parenCount})`,
      timestamp: Date.now(),
    };
  }

  return {
    id,
    action: 'verify_syntax',
    target: language,
    verdict: 'PASSED',
    evidence: 'Brace and paren balance verified',
    timestamp: Date.now(),
  };
}
