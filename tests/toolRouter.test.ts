import { beforeEach, describe, expect, it } from 'vitest';
import {
  classifyIntent,
  coreToolNames,
  currentSchemas,
  endTurn,
  groupInfo,
  loadGroups,
  noteUsed,
  routeSummary,
  routeTurn,
  setAllSchemas,
  unloadedGroups,
} from '../src/main/toolRouter';
import type { ToolSchema } from '../src/main/llm';

const schema = (name: string): ToolSchema => ({
  type: 'function',
  function: { name, description: `Tool for ${name.replace(/_/g, ' ')}`, parameters: { type: 'object', properties: {} } },
});

const ALL = [
  'get_current_time', 'calculate', 'ask_user', 'load_tools', 'list_capabilities', 'tool_log',
  'web_search', 'tinyfish_search', 'get_weather',
  'browser_open', 'browser_click', 'native_browser_tabs',
  'launch_app', 'volume_control', 'clipboard_read',
  'list_files', 'write_file', 'grep', 'apply_patch',
  'run_command', 'diagnostics', 'inspect_project',
  'remember', 'list_memories', 'find_contact',
  'set_timer', 'briefing', 'schedule_task',
  'batch', 'task', 'parallel_tasks', 'start_task',
  'github_status', 'github_create_issue', 'vercel_deploy',
  'get_system_info', 'list_processes', 'bluetooth_scan',
  'see_screen', 'screen_text', 'show_visual',
  'make_document', 'read_document', 'artifact_export',
  'specialist_capability',
].map(schema);

describe('JINI intent-aware capability router', () => {
  beforeEach(() => {
    setAllSchemas(ALL);
    routeTurn('hello there');
  });

  it('keeps the always-available core intentionally small', () => {
    expect(coreToolNames()).toEqual(['get_current_time', 'calculate', 'ask_user', 'load_tools', 'list_capabilities', 'tool_log']);
    const names = currentSchemas().map((item) => item.function.name);
    expect(names).toEqual(expect.arrayContaining(coreToolNames()));
    expect(names).not.toContain('browser_open');
    expect(names).not.toContain('launch_app');
    expect(names).not.toContain('run_command');
    expect(names).not.toContain('specialist_capability');
  });

  it('routes research without accidentally loading browser or desktop control', () => {
    routeTurn('Research the latest evidence and compare sources about battery technology.');
    const names = currentSchemas().map((item) => item.function.name);
    expect(names).toContain('web_search');
    expect(names).toContain('tinyfish_search');
    expect(names).not.toContain('browser_click');
    expect(names).not.toContain('launch_app');
    expect(routeSummary()).toContain('research');
  });

  it('distinguishes opening a desktop app from opening a website', () => {
    routeTurn('Launch the calculator app on my desktop.');
    expect(currentSchemas().map((item) => item.function.name)).toContain('launch_app');
    expect(currentSchemas().map((item) => item.function.name)).not.toContain('browser_open');

    routeTurn('Open a website and fill in its contact form.');
    expect(currentSchemas().map((item) => item.function.name)).toContain('browser_open');
    expect(currentSchemas().map((item) => item.function.name)).toContain('browser_click');
    expect(currentSchemas().map((item) => item.function.name)).not.toContain('launch_app');
  });

  it('routes personal account and inbox requests to browser capabilities', () => {
    const route = classifyIntent('Open my email inbox so I can check messages.');
    expect(route.families).toContain('browser');
    expect(route.matchedCues.browser).toContain('my email');
    routeTurn('Open my email inbox so I can check messages.');
    expect(currentSchemas().map((item) => item.function.name)).toContain('browser_open');
    expect(currentSchemas().map((item) => item.function.name)).toContain('native_browser_tabs');
  });

  it('supports multi-intent requests by loading multiple relevant families', () => {
    routeTurn('Research three clinics, compare their reviews, then create a summary document.');
    const names = currentSchemas().map((item) => item.function.name);
    expect(names).toContain('web_search');
    expect(names).toContain('make_document');
  });

  it('routes development, memory and productivity independently', () => {
    routeTurn('Debug the TypeScript project and run the test suite.');
    expect(currentSchemas().map((item) => item.function.name)).toContain('run_command');
    expect(currentSchemas().map((item) => item.function.name)).toContain('diagnostics');

    routeTurn('Remember my preference and recall it next time.');
    expect(currentSchemas().map((item) => item.function.name)).toContain('remember');
    expect(currentSchemas().map((item) => item.function.name)).not.toContain('run_command');

    routeTurn('Remind me every week to review my notes.');
    expect(currentSchemas().map((item) => item.function.name)).toContain('schedule_task');
  });

  it('keeps specialist capabilities discoverable through the advanced escape hatch', () => {
    routeTurn('hello');
    expect(unloadedGroups()).toContain('advanced');
    const out = loadGroups(['advanced']);
    expect(out).toContain('specialist_capability');
    expect(currentSchemas().map((item) => item.function.name)).toContain('specialist_capability');
  });

  it('loads only requested groups and reports unknown groups clearly', () => {
    routeTurn('hello');
    const out = loadGroups(['integrations']);
    expect(out).toContain('github_status');
    expect(currentSchemas().map((item) => item.function.name)).toContain('github_create_issue');
    expect(currentSchemas().map((item) => item.function.name)).not.toContain('browser_open');
    expect(loadGroups(['not-a-family'])).toMatch(/Unknown group/);
  });

  it('loads all families only when explicitly requested', () => {
    routeTurn('hello');
    loadGroups(['all']);
    expect(currentSchemas()).toHaveLength(ALL.length);
  });

  it('expands the active capability set when a tool is used mid-turn', () => {
    routeTurn('hello');
    noteUsed('github_status');
    expect(currentSchemas().map((item) => item.function.name)).toContain('github_create_issue');
  });

  it('retains only the last relevant family for one follow-up turn', () => {
    routeTurn('Debug my code project');
    endTurn();
    routeTurn('thanks, can you also explain that?');
    expect(currentSchemas().map((item) => item.function.name)).toContain('run_command');
    endTurn();
    routeTurn('hello again');
    expect(currentSchemas().map((item) => item.function.name)).not.toContain('run_command');
  });

  it('classifies confidence and cue evidence without making routing an authorization decision', () => {
    const route = classifyIntent('Open my browser and download the report.');
    expect(route.families).toContain('browser');
    expect(route.confidence).not.toBe('low');
    expect(route.matchedCues.browser).toContain('my browser');
  });

  it('generates manifest groups from the live registry, including every tool exactly once', () => {
    const groups = groupInfo();
    const names = groups.flatMap((group) => group.tools);
    expect(names.sort()).toEqual(ALL.map((item) => item.function.name).sort());
    expect(new Set(names).size).toBe(names.length);
  });
});
