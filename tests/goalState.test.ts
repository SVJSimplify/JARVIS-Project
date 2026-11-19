import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { getGoalContext, getGoalState, recordGoalOutcome, setGoalStateFileForTests, updateGoalFromUser } from '../src/main/goalState';

describe('persistent per-chat goal state', () => {
  let dir = '';
  afterEach(async () => {
    setGoalStateFileForTests(null);
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  it('merges terse refinements without losing the project or named entity', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'jini-goal-'));
    setGoalStateFileForTests(path.join(dir, 'goals.json'));
    await updateGoalFromUser('chat-a', 'Can you create a nice website for me?');
    await updateGoalFromUser('chat-a', 'A business website for SpaceX');
    await updateGoalFromUser('chat-a', 'Yes, unofficial like a fan site');
    const state = await getGoalState('chat-a');
    expect(state.objective?.value.toLowerCase()).toContain('website');
    expect(state.entities.some((x) => /spacex/i.test(x.value))).toBe(true);
    expect(state.decisions.some((x) => /unofficial.*fan site/i.test(x.value))).toBe(true);
    expect(await getGoalContext('chat-a')).toContain('SpaceX');
  });
  it('isolates chats and preserves goal after a provider failure', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'jini-goal-'));
    setGoalStateFileForTests(path.join(dir, 'goals.json'));
    await updateGoalFromUser('chat-a', 'Build a portfolio website');
    await recordGoalOutcome('chat-a', '', 'Provider returned 400');
    expect((await getGoalState('chat-a')).lastError).toContain('400');
    expect((await getGoalState('chat-b')).objective).toBeNull();
    expect(await getGoalContext('chat-a')).toContain('portfolio');
  });
});
