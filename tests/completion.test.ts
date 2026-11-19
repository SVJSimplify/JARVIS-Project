import { promises as fs } from 'fs';
import { runWithExecutionScope } from '../src/main/toolResult';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  auditReply,
  beginTask,
  classifyOutcome,
  completionReport,
  endTask,
  failureClass,
  familyOf,
  needsRescue,
  nextStepFor,
  qualityAudit,
  recordFailedTurn,
  recordInterrupted,
  recordStep,
  setStatsFileForTests,
  takeRescue,
  unresolvedFailures,
  verdictOf,
  type LedgerEntry,
} from '../src/main/completion';

const entry = (tool: string, raw: string, args = '{}'): LedgerEntry => ({
  tool,
  args,
  outcome: classifyOutcome(raw),
  raw,
  at: 0,
});

beforeEach(() => {
  setStatsFileForTests(path.join(os.tmpdir(), `completion-test-${Date.now()}.json`));
});

describe('session-scoped completion evidence', () => {
  it('keeps each session evidence ledger independent', async () => {
    await runWithExecutionScope({ sessionId: 'completion-session-a' }, async () => {
      beginTask('write a file');
      recordStep('write_file', '{}', 'Tool error [write_file]: network timeout');
      expect(needsRescue()).toBe(true);
    });
    await runWithExecutionScope({ sessionId: 'completion-session-b' }, async () => {
      beginTask('read a file');
      expect(needsRescue()).toBe(false);
    });
    await runWithExecutionScope({ sessionId: 'completion-session-a' }, async () => {
      expect(needsRescue()).toBe(true);
    });
  });
});

describe('outcome classification is deterministic', () => {
  it('maps every standard prefix to its outcome', () => {
    expect(classifyOutcome('Wrote 3 lines to notes.txt')).toBe('success');
    expect(classifyOutcome('Tool error [write_file]: EPERM')).toBe('failed');
    expect(classifyOutcome('Unknown tool "writte_file".')).toBe('failed');
    expect(classifyOutcome('NOT DONE: the in-app browser panel was closed while this action was running')).toBe('failed');
    expect(classifyOutcome('BLOCKED: deleting files is disabled')).toBe('blocked');
    expect(classifyOutcome('NOT APPROVED by the user, so it was NOT done: overwrite')).toBe('blocked'); // legacy prefix: today only the deletion tooth emits it — a hard block
    expect(classifyOutcome('TIMEOUT after 60s\npartial output')).toBe('failed');
    expect(classifyOutcome('')).toBe('success');
  });

  it('assigns a usable class to every failure shape', () => {
    expect(failureClass('Tool error [x]: EPERM: operation not permitted')).toBe('permission');
    expect(failureClass('Tool error [x]: ENOENT: no such file or directory')).toBe('missing');
    expect(failureClass('Tool error [x]: operation timed out')).toBe('timeout');
    expect(failureClass('Tool error [x]: fetch failed')).toBe('network');
    expect(failureClass('Tool error: No model set. Open Settings and choose one.')).toBe('config');
    expect(failureClass('Unknown tool "broser_open".')).toBe('routing');
    expect(failureClass('NOT DONE: the in-app browser panel was closed while this action was running')).toBe('browser_closed');
    expect(failureClass('Tool error [x]: code is empty.')).toBe('input');
    expect(failureClass('BLOCKED: deleting is disabled')).toBe('blocked');
    expect(failureClass('NOT APPROVED by the user')).toBe('blocked'); // legacy prefix, hard block today
    expect(failureClass('Tool error [x]: something odd happened')).toBe('other');
  });

  it('gives every failure class a concrete spoken next step', () => {
    for (const c of ['permission', 'missing', 'timeout', 'network', 'config', 'routing', 'browser_closed', 'input', 'blocked', 'other'] as const) {
      expect(nextStepFor(c).length).toBeGreaterThan(10);
    }
  });
});

describe('families and resolution', () => {
  it('groups sibling tools so a retry with a sibling resolves the failure', () => {
    expect(familyOf('write_file')).toBe(familyOf('edit_file'));
    expect(familyOf('browser_open')).toBe(familyOf('launch_app'));
    expect(familyOf('browser_media')).toBe(familyOf('media_control'));
    expect(familyOf('decide')).toBe('decide');
  });

  it('a later same-family success resolves an earlier failure; a different family does not', () => {
    const entries = [entry('write_file', 'Tool error [write_file]: disk full'), entry('read', 'alpha\nbeta'), entry('edit_file', 'Edited notes.txt')];
    expect(unresolvedFailures(entries)).toEqual([]);
    const stillBroken = [entry('write_file', 'Tool error [write_file]: disk full'), entry('read', 'alpha')];
    expect(unresolvedFailures(stillBroken)).toHaveLength(1);
  });
});

describe('verdict from the ledger only', () => {
  it('classifies clean, partial, failed, blocked and empty turns', () => {
    expect(verdictOf([])).toBe('no_action');
    expect(verdictOf([entry('read', 'hello')])).toBe('completed');
    expect(verdictOf([entry('write_file', 'Tool error: x')])).toBe('failed');
    expect(verdictOf([entry('read', 'ok'), entry('write_file', 'Tool error: x')])).toBe('partial');
    expect(verdictOf([entry('write_file', 'Tool error: x'), entry('edit_file', 'Edited notes.txt')])).toBe('completed');
    expect(verdictOf([entry('write_file', 'BLOCKED: disabled')])).toBe('blocked');
    expect(verdictOf([entry('write_file', 'NOT APPROVED by the user')])).toBe('blocked'); // legacy prefix → blocked verdict
  });
});

describe('the reply audit catches false success', () => {
  it('rewrites "Done, sir." when a step is still broken and another succeeded', () => {
    const entries = [entry('read', 'file contents here'), entry('write_file', 'Tool error [write_file]: ENOENT: no such file or directory')];
    const a = auditReply('Done, sir.', entries, 'read the log and save a summary', []);
    expect(a.verdict).toBe('partial');
    expect(a.enforcement).toContain('false_success_rewritten');
    expect(a.reply).toMatch(/Partly done/);
    expect(a.reply).toMatch(/write_file failed/);
    expect(a.reply).toMatch(/exact name or path/);
  });

  it('rewrites success with nothing behind it', () => {
    const entries = [entry('launch_app', 'Tool error [launch_app]: not installed')];
    const a = auditReply('Done, sir.', entries, 'open spotify', []);
    expect(a.verdict).toBe('failed');
    expect(a.reply).toMatch(/did not go through/);
    expect(a.reply).toMatch(/launch_app failed/);
  });

  it('replaces an unrelated reply when failures are never mentioned', () => {
    const entries = [entry('write_file', 'Tool error [write_file]: EPERM: access is denied')];
    const a = auditReply('The weather is lovely today, sir.', entries, 'save the file', []);
    expect(a.enforcement).toContain('status_stated');
    expect(a.reply).toMatch(/write_file failed — access was denied/);
    expect(a.reply).toMatch(/grant access/);
  });

  it('appends a next step to an honest failure that lacks one', () => {
    const entries = [entry('browser_open', 'NOT DONE: the in-app browser panel was closed while this action was running')];
    const a = auditReply('That did not work, sir.', entries, 'open youtube', []);
    expect(a.enforcement).toContain('next_step_added');
    expect(a.reply).toMatch(/reopen the browser panel/);
  });

  it('leaves an honest failure with its own next step untouched', () => {
    const entries = [entry('write_file', 'Tool error [write_file]: EPERM')];
    const a = auditReply('That failed, sir — access was denied. Next: grant access to the folder and tell me to retry.', entries, 'save the file', []);
    expect(a.enforcement).not.toContain('next_step_added');
    expect(a.reply).toBe('That failed, sir — access was denied. Next: grant access to the folder and tell me to retry.');
  });

  it('never touches a question', () => {
    const entries = [entry('write_file', 'Tool error [write_file]: x')];
    const a = auditReply('Which file did you mean, sir?', entries, 'save it', []);
    expect(a.reply).toBe('Which file did you mean, sir?');
  });

  it('a resolved failure with "Done, sir." passes untouched', () => {
    const entries = [entry('write_file', 'Tool error [write_file]: ENOENT'), entry('edit_file', 'Edited notes.txt: 1 replacement(s)')];
    const a = auditReply('Done, sir.', entries, 'save the note', []);
    expect(a.verdict).toBe('completed');
    expect(a.reply).toBe('Done, sir.');
    expect(a.enforcement).toEqual([]);
  });
});

describe('the reply audit catches unverifiable claims', () => {
  it('rewrites an action claim with zero supporting evidence when the request asked for it', () => {
    const a = auditReply('Notepad is opened for you, sir.', [], 'open notepad', []);
    expect(a.enforcement).toContain('unverifiable_claim_rewritten');
    expect(a.reply).toMatch(/did not actually happen/);
  });

  it('leaves small talk and non-requested verbs alone', () => {
    expect(auditReply('Gladly, sir.', [], 'thank you', []).enforcement).toEqual([]);
    expect(auditReply('I found that fascinating, sir.', [], 'thank you', []).reply).toBe('I found that fascinating, sir.');
  });

  it('leaves a claim that the ledger actually backs', () => {
    const entries = [entry('write_file', 'Wrote 5 lines to notes/todo.txt', '{"path":"notes/todo.txt","content":"x"}')];
    const a = auditReply('Saved, sir — notes/todo.txt is ready.', entries, 'save a todo note', []);
    expect(a.enforcement).toEqual([]);
    expect(a.verdict).toBe('completed');
  });
});

describe('approval and blocked turns state the truth instead of pretending', () => {
  it('a legacy NOT APPROVED step is a policy block: the reply says disabled, never "go-ahead needed"', () => {
    const a = auditReply('I would edit config.ini next, sir.', [entry('edit_file', 'NOT APPROVED by the user, so it was NOT done: editing config.ini')], 'edit my config', []);
    expect(a.verdict).toBe('blocked');
    expect(a.enforcement).toContain('blocked_step_stated');
    expect(a.reply).toMatch(/disabled for safety/);
    expect(a.reply).not.toMatch(/go-ahead is needed/);
  });

  it('names policy blocks plainly', () => {
    const a = auditReply('About that, sir.', [entry('delete_file', 'BLOCKED: deleting is disabled for safety')], 'delete the file', []);
    expect(a.reply).toMatch(/disabled for safety/);
  });
});

describe('the deterministic quality audit', () => {
  it('passes a write whose file really exists', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qaudit-'));
    const file = path.join(dir, 'real.txt');
    await fs.writeFile(file, 'hello');
    const problems = await qualityAudit([entry('write_file', `Wrote 1 lines to ${file}`, JSON.stringify({ path: file, content: 'hello' }))]);
    expect(problems).toEqual([]);
  });

  it('flags a claimed write that left no file and downgrades the verdict', async () => {
    const missing = path.join(os.tmpdir(), `no-such-file-${Date.now()}.txt`);
    const entries = [entry('write_file', `Wrote 10 lines to ${missing}`, JSON.stringify({ path: missing, content: 'ghost' }))];
    const problems = await qualityAudit(entries);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toMatch(/not on disk/);
    const a = auditReply('Done, sir — the report is saved.', entries, 'save the report', problems);
    // The lying success is invalidated: the write never happened, so the verdict is failed.
    expect(a.verdict).toBe('failed');
    expect(a.enforcement.join('\n')).toMatch(/quality: .*not on disk/);
    expect(a.reply).toMatch(/did not go through/);
  });

  it('flags a browser success without its state truth line', async () => {
    const problems = await qualityAudit([entry('browser_open', 'Opened example.com')]);
    expect(problems[0].message).toMatch(/truth line/);
    const clean = await qualityAudit([entry('browser_open', 'Opened example.com\n[in-app browser: open · 1 tab · active: example.com]')]);
    expect(clean).toEqual([]);
  });

  it('checks apply_patch targets parsed from the patch text', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qaudit-'));
    const file = path.join(dir, 'patched.ts');
    await fs.writeFile(file, 'x');
    const patch = `*** Begin Patch\n*** Update File: ${file}\n@@\n-x\n+y\n*** End Patch`;
    const ok = await qualityAudit([entry('apply_patch', 'Patched 1 file(s).', JSON.stringify({ patch }))]);
    expect(ok).toEqual([]);
    const bad = await qualityAudit([entry('apply_patch', 'Patched 1 file(s).', JSON.stringify({ patch: patch.replace(file, path.join(dir, 'gone.ts')) }))]);
    expect(bad).toHaveLength(1);
  });
});

describe('the bounded rescue pass', () => {
  it('fires once for retryable failures and never twice', async () => {
    beginTask('search for it');
    recordStep('tinyfish_search', '{"query":"x"}', 'Tool error [tinyfish_search]: fetch failed');
    expect(needsRescue()).toBe(true);
    const directive = await takeRescue();
    expect(directive).toMatch(/COMPLETION ENFORCEMENT/);
    expect(directive).toMatch(/tinyfish_search/);
    expect(needsRescue()).toBe(false);
  });

  it('never fires for approval, blocked or permission failures', () => {
    beginTask('delete it');
    recordStep('write_file', '{}', 'NOT APPROVED by the user');
    expect(needsRescue()).toBe(false);
    beginTask('again');
    recordStep('write_file', '{}', 'Tool error: EPERM: access is denied');
    expect(needsRescue()).toBe(false);
  });

  it('respects an aborted signal and a spent round budget', () => {
    beginTask('search');
    recordStep('web_search', '{}', 'Tool error [web_search]: ETIMEDOUT');
    expect(needsRescue({ aborted: true })).toBe(false);
    expect(needsRescue(undefined, 1)).toBe(false);
    expect(needsRescue(undefined, 5)).toBe(true);
  });
});

describe('endTask consumes the task and measures everything', () => {
  it('passes a clean turn through unchanged and records the verdict', async () => {
    beginTask('what time is it');
    recordStep('get_current_time', '{}', 'It is 10:00.');
    const a = await endTask('It is 10 o’clock, sir.');
    expect(a.verdict).toBe('completed');
    expect(a.reply).toBe('It is 10 o’clock, sir.');
    const consumed = await endTask('anything');
    expect(consumed.verdict).toBe('no_action');
  });

  it('records interruptions and crashes as honest outcomes', async () => {
    beginTask('long research');
    recordStep('tinyfish_search', '{}', 'results...');
    await recordInterrupted();
    beginTask('build it');
    await recordFailedTurn('provider unreachable');
    const report = await completionReport();
    expect(report).toMatch(/2 measured/);
    expect(report).toMatch(/50% stopped by you/);
    expect(report).toMatch(/50% failed/);
    expect(report).toMatch(/turn error: provider unreachable/);
  });

  it('counts enforced rewrites in the public report', async () => {
    beginTask('open spotify');
    recordStep('launch_app', '{}', 'Tool error [launch_app]: not installed');
    const a = await endTask('Done, sir.');
    expect(a.verdict).toBe('failed');
    const report = await completionReport();
    expect(report).toMatch(/1 false-success claim\(s\) caught and rewritten/);
    expect(report).toMatch(/Enforcement record/);
    expect(report).toMatch(/honest status and a next step: YES/i);
  });

  it('every verdict is measured with an honest note', async () => {
    beginTask('fix the log rotation');
    recordStep('read', '{}', 'Tool error [read]: x');
    const a = await endTask('Done, sir.');
    expect(a.verdict).toBe('failed');
    const report = await completionReport();
    expect(report).toMatch(/failed/);
    expect(report).toMatch(/Enforcement record/);
  });
});
