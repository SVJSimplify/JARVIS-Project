import { describe, expect, it } from 'vitest';
import { routeIntent } from '../src/main/intentRouter';
import { inferToolGroup, setAllSchemas, routeTurn, currentSchemas, unloadedGroups, loadGroups } from '../src/main/toolRouter';
import type { ToolSchema } from '../src/main/llm';
import { agentToolScope } from '../src/main/agentToolSelection';

const schema = (name: string): ToolSchema => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object', properties: {} } },
});

describe('intent routing', () => {
  it('routes a natural-language drive footprint request to the storage capability', () => {
    const route = routeIntent('Check what are the files in D: that are taking the most space');
    expect(route.primary.id).toBe('storage_analysis');
    expect(route.primary.preferredTools).toContain('analyze_storage');
    expect(route.groups).toContain('files');
    expect(route.groups).toContain('system');
  });

  it('distinguishes a browser request from a desktop application request', () => {
    expect(routeIntent('Open YouTube in my browser').primary.id).toBe('browser_interaction');
    expect(routeIntent('Open Notepad').primary.id).toBe('desktop_control');
  });

  it('routes durable preferences to memory and substantial work to orchestration', () => {
    expect(routeIntent('Remember that I prefer a warm black and white interface').groups).toContain('memory');
    expect(routeIntent('Do a full deep dive audit and overhaul of the tools').groups).toContain('orchestration');
  });

  it('routes GitHub, system and document requests to their relevant families', () => {
    expect(routeIntent('Check my GitHub workflow runs').groups).toContain('integrations');
    expect(routeIntent('What is using my RAM?').groups).toContain('system');
    expect(routeIntent('Create a PDF report').groups).toContain('documents');
  });

  it('scopes specialist tool families to both their role and the assigned task', () => {
    const storage = agentToolScope('general', 'Check which files in D: are taking the most space');
    expect(storage.families).toContain('files');
    expect(storage.families).toContain('system');
    expect(storage.families).not.toContain('integrations');
    expect(storage.families).not.toContain('browser');

    const research = agentToolScope('research', 'Compare the latest browser automation frameworks');
    expect(research.families).toContain('research');
    expect(research.families).not.toContain('desktop');

    const desktop = agentToolScope('desktop', 'Open Notepad and type a note');
    expect(desktop.families).toContain('desktop');
    expect(desktop.families).not.toContain('integrations');
  });

  it('maps tools to a single family and puts unknown specialists in advanced', () => {
    expect(inferToolGroup('analyze_storage')).toBe('system');
    expect(inferToolGroup('run_command')).toBe('files');
    expect(inferToolGroup('github_status')).toBe('integrations');
    expect(inferToolGroup('native_browser_click')).toBe('browser');
    expect(inferToolGroup('rare_specialist_operation')).toBe('advanced');
  });

  it('activates only the families relevant to the turn and can explicitly load advanced tools', () => {
    setAllSchemas([
      schema('get_current_time'),
      schema('analyze_storage'),
      schema('list_files'),
      schema('github_status'),
      schema('native_browser_click'),
      schema('rare_specialist_operation'),
    ]);
    routeTurn('Check what files in D: are taking the most space');
    const storageNames = currentSchemas().map((s) => s.function.name);
    expect(storageNames).toContain('analyze_storage');
    expect(storageNames).toContain('list_files');
    expect(storageNames).not.toContain('github_status');
    expect(storageNames).not.toContain('rare_specialist_operation');
    expect(unloadedGroups()).toContain('advanced');
    loadGroups('advanced');
    expect(currentSchemas().map((s) => s.function.name)).toContain('rare_specialist_operation');
  });
});
