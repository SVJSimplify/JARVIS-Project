import { describe, expect, it } from 'vitest';
import { routeIntent } from '../src/main/intentRouter';

describe('intent routing', () => {
  it('routes natural-language drive footprint requests to the storage analyser', () => {
    const route = routeIntent('Check what are the files in D: that are taking the most space');
    expect(route.primary.id).toBe('storage_analysis');
    expect(route.primary.confidence).toBe('high');
    expect(route.groups).toContain('files');
    expect(route.primary.preferredTools).toContain('analyze_storage');
  });

  it('does not confuse browser navigation with generic desktop verbs', () => {
    expect(routeIntent('Open YouTube in my browser').primary.id).toBe('browser_interaction');
  });

  it('routes named desktop applications to desktop control', () => {
    expect(routeIntent('Open Notepad').primary.id).toBe('desktop_control');
  });

  it('routes research and comparison to headless research capabilities', () => {
    expect(routeIntent('Compare the best open-source coding agents').primary.id).toBe('research');
  });
});
