import { beforeEach, describe, expect, it } from 'vitest';
import { currentSchemas, endTurn, loadGroups, noteUsed, routeTurn, setAllSchemas, unloadedGroups } from '../src/main/toolRouter';
import type { ToolSchema } from '../src/main/llm';

const schema = (name: string): ToolSchema => ({
  type: 'function',
  function: { name, description: '', parameters: { type: 'object', properties: {} } },
});

const ALL = [
  // core
  'web_search', 'calculate',
  // browser group
  'browser_open', 'browser_click', 'browser_type',
  // desktop group
  'launch_app', 'volume_control',
  // files group (not core, not always-on)
  'grep', 'multi_edit', 'apply_patch',
  // productivity group
  'set_timer', 'briefing',
].map(schema);

describe('toolRouter', () => {
  beforeEach(() => {
    setAllSchemas(ALL);
    routeTurn('hello there'); // neutral text: browser+desktop always on
  });

  it('always includes core, ungrouped and always-on groups', () => {
    const names = currentSchemas().map((s) => s.function.name);
    expect(names).toContain('web_search');
    expect(names).toContain('browser_open');
    expect(names).toContain('launch_app');
  });

  it('keeps the files group out until the text or usage calls for it', () => {
    routeTurn('what is the weather');
    expect(currentSchemas().map((s) => s.function.name)).not.toContain('grep');
    expect(unloadedGroups()).toContain('files');
  });

  it('loads a group when the request matches its keywords', () => {
    routeTurn('fix the bug in my project source code');
    expect(currentSchemas().map((s) => s.function.name)).toContain('grep');
  });

  it('pulls in the group when one of its tools is used mid-turn', () => {
    routeTurn('random smalltalk');
    expect(noteUsed('grep')).toBeUndefined();
    expect(currentSchemas().map((s) => s.function.name)).toContain('multi_edit');
  });

  it('load_tools loads named groups and rejects unknown ones', () => {
    routeTurn('hello');
    const out = loadGroups(['productivity']);
    expect(out).toContain('set_timer');
    expect(currentSchemas().map((s) => s.function.name)).toContain('briefing');
    expect(loadGroups(['nope'])).toMatch(/Unknown group/);
  });

  it('endTurn keeps the group sticky for the next two turns', () => {
    routeTurn('fix the bug in the code');
    endTurn();
    routeTurn('thanks, now something unrelated entirely');
    expect(currentSchemas().map((s) => s.function.name)).toContain('grep');
    endTurn();
    endTurn();
    routeTurn('totally different topic now');
    expect(currentSchemas().map((s) => s.function.name)).not.toContain('grep');
  });
});
