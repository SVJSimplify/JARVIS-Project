import { beforeEach, describe, expect, it } from 'vitest';
import { currentSchemas, loadGroups, routeTurn, setAllSchemas, unloadedGroups } from '../src/main/toolRouter';
import type { ToolSchema } from '../src/main/llm';

const schema = (name: string): ToolSchema => ({
  type: 'function',
  function: { name, description: '', parameters: { type: 'object', properties: {} } },
});

const ALL = [
  'get_current_time', 'calculate', 'list_capabilities',
  'analyze_storage', 'list_drives', 'list_files', 'run_command',
  'browser_open', 'native_browser_tabs', 'launch_app',
  'remember', 'set_timer', 'github_status', 'make_document',
];

describe('intent-aware toolRouter', () => {
  beforeEach(() => {
    setAllSchemas(ALL.map(schema));
  });

  it('loads only core capabilities for a neutral turn', () => {
    routeTurn('hello there');
    const names = currentSchemas().map((s) => s.function.name);
    expect(names).toContain('get_current_time');
    expect(names).toContain('calculate');
    expect(names).toContain('list_capabilities');
    expect(names).not.toContain('analyze_storage');
    expect(names).not.toContain('browser_open');
    expect(unloadedGroups()).toContain('files');
  });

  it('loads file and system capabilities for a drive-usage request, without unrelated browser tools', () => {
    routeTurn('Check which files in D: are taking the most space');
    const names = currentSchemas().map((s) => s.function.name);
    expect(names).toContain('analyze_storage');
    expect(names).toContain('list_drives');
    expect(names).toContain('list_files');
    expect(names).not.toContain('browser_open');
    expect(names).not.toContain('set_timer');
  });

  it('loads browser tools but not desktop control for an explicit browser request', () => {
    routeTurn('Open YouTube in my browser');
    const names = currentSchemas().map((s) => s.function.name);
    expect(names).toContain('browser_open');
    expect(names).toContain('native_browser_tabs');
    expect(names).not.toContain('launch_app');
    expect(names).not.toContain('run_command');
  });

  it('loads integrations, productivity and document families only when needed', () => {
    routeTurn('Check my GitHub workflow runs');
    expect(currentSchemas().map((s) => s.function.name)).toContain('github_status');
    routeTurn('Set a timer for ten minutes');
    expect(currentSchemas().map((s) => s.function.name)).toContain('set_timer');
    routeTurn('Create a PDF report');
    expect(currentSchemas().map((s) => s.function.name)).toContain('make_document');
  });

  it('can explicitly load an advanced family when a discovered capability is required', () => {
    routeTurn('hello');
    expect(loadGroups(['advanced'])).toContain('advanced');
  });
});
