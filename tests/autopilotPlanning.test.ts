import { describe, expect, it } from 'vitest';
import {
  buildPlan,
  fallbackPlan,
  parseModelPlan,
  repairPlan,
  validateProjectPlan,
  planningPrompt,
} from '../src/main/autopilot/planner';
import { extractUnderstanding, mergeUnderstanding, understandingPrompt } from '../src/main/autopilot/understanding';
import { PROJECT_TEMPLATES, templateById, templateList } from '../src/main/autopilot/templates';
import type { ProjectUnderstanding } from '../src/main/autopilot/types';

const DESCRIPTION = [
  'Build a tiny weather dashboard web app for my home server.',
  'It must show the current conditions and a 3-day forecast.',
  'It must cache responses offline; do not use any paid API.',
  'Assuming the server already has node installed.',
  'Out of scope: user accounts and mobile styling.',
  'Success means the dashboard loads offline after the first fetch.',
].join('\n');

describe('Round22 §3.1 — project understanding (deterministic floor)', () => {
  it('extracts objective, requirements, constraints, assumptions, out-of-scope and deliverables', () => {
    const u = extractUnderstanding(DESCRIPTION);
    expect(u.title.toLowerCase()).toContain('weather dashboard');
    expect(u.objective.length).toBeGreaterThan(10);
    expect(u.requirements.some((r) => /forecast|conditions|offline/i.test(r))).toBe(true);
    expect(u.constraints.some((c) => /paid api|no paid/i.test(c))).toBe(true);
    expect(u.assumptions.some((a) => /node installed|already has node/i.test(a))).toBe(true);
    expect(u.outOfScope.some((o) => /user accounts|mobile/i.test(o))).toBe(true);
    expect(u.successCriteria.some((s) => /offline/i.test(s))).toBe(true);
    expect(u.deliverables.length).toBeGreaterThan(0);
    expect(u.category).toBe('software');
  });

  it('records honest provenance: defaults stay labelled as defaults', () => {
    const u = extractUnderstanding('Organize my downloads folder by file type.');
    expect(u.sources.title).toBe('default');
    expect(u.sources.objective).toBe('default');
    // Deterministic success floor, never invented certainty
    expect(u.sources.successCriteria).toBe('default');
    expect(u.successCriteria[0]).toMatch(/verified against reality/);
  });

  it('keeps assumptions as assumptions — never promotes them to requirements', () => {
    const text = 'Create a report about X. Assuming the data already exists.';
    const u = extractUnderstanding(text);
    expect(u.assumptions.some((a) => /data already exists/i.test(a))).toBe(true);
    expect(u.requirements.every((r) => !/assuming/i.test(r))).toBe(true);
  });

  it('degrades gracefully on an empty description (never throws)', () => {
    const u = extractUnderstanding('');
    expect(u.title).toBeTruthy();
    expect(u.requirements.length).toBeGreaterThan(0);
  });

  it('classifies category and complexity by lexicon', () => {
    expect(extractUnderstanding('Research the competitors in the EV market with a survey').category).toBe('research');
    expect(extractUnderstanding('A simple one-page checklist app, just a single file').complexity).toBe('light');
    expect(extractUnderstanding('A large multi-phase platform with an enterprise architecture').complexity).toBe('complex');
  });
});

describe('Round22 §3.1 — model refinement is shape-checked and never trusted blindly', () => {
  const floor = extractUnderstanding(DESCRIPTION);

  it('merges valid model fields and relabels provenance', () => {
    const merged = mergeUnderstanding(floor, {
      title: 'Weather Dashboard',
      objective: 'A home-server dashboard for current and forecast conditions.',
      category: 'software',
      complexity: 'standard',
      requirements: ['show current conditions', '3-day forecast', 'offline cache'],
      assumptions: ['node is installed on the server'],
      successCriteria: ['dashboard loads offline after first fetch'],
    });
    expect(merged.title).toBe('Weather Dashboard');
    expect(merged.sources.title).toBe('model');
    expect(merged.sources.requirements).toBe('model');
    expect(merged.assumptions.some((a) => /node is installed/i.test(a))).toBe(true);
    expect(merged.requirements.every((r) => !/assuming/i.test(r))).toBe(true);
  });

  it('rejects invalid category/complexity values (deterministic default stands)', () => {
    const merged = mergeUnderstanding(floor, { category: 'quantum' as never, complexity: 'unbounded' as never });
    expect(merged.category).toBe(floor.category);
    expect(merged.complexity).toBe(floor.complexity);
    expect(merged.sources.category).toBe('default');
  });

  it('a failing/null model result keeps the deterministic floor untouched', () => {
    const merged = mergeUnderstanding(floor, null);
    expect(merged).toEqual(floor);
    const merged2 = mergeUnderstanding(floor, { requirements: [] });
    expect(merged2.requirements).toEqual(floor.requirements);
  });

  it('the understanding prompt forbids inventing certainty', () => {
    const p = understandingPrompt('x');
    expect(p).toMatch(/Never invent certainty/);
    expect(p).toMatch(/assumptions/i);
  });
});

describe('Round22 §3.2 — hierarchical plan building', () => {
  it('builds milestones, tasks, dependencies and deliverable expectations', () => {
    const built = buildPlan({
      milestones: [
        { id: 'M-1', title: 'Gather', detail: 'collect', acceptance: [{ kind: 'sources-present', detail: '3 sources fetched', min: 3 }] },
        { id: 'M-2', title: 'Write', detail: 'write the report' },
      ],
      tasks: [
        { id: 'PT-1', title: 'Research', detail: 'd', kind: 'research', milestone: 'M-1', dependsOn: [], acceptance: [{ kind: 'sources-present', detail: '3 distinct sources fetched', min: 3 }] },
        { id: 'PT-2', title: 'Write report', detail: 'd', kind: 'document', milestone: 'M-2', dependsOn: ['PT-1'], deliverables: [{ name: 'Report', path: 'projects/research/report.md', format: 'md' }], acceptance: [{ kind: 'file-format', detail: 'report is valid markdown' }] },
      ],
    });
    expect(built.milestones).toHaveLength(2);
    expect(built.tasks).toHaveLength(2);
    expect(built.tasks[0].dependsOn).toEqual([]);
    expect(built.tasks[1].dependsOn).toEqual(['PT-1']);
    expect(built.deliverables).toHaveLength(1);
    expect(built.deliverables[0].producingTaskId).toBe('PT-2');
    const m1 = built.milestones.find((m) => m.id === 'M-1')!;
    expect(m1.taskIds).toEqual(['PT-1']);
    const m2 = built.milestones.find((m) => m.id === 'M-2')!;
    expect(m2.deliverableIds).toEqual([built.deliverables[0].id]);
    // Milestone acceptance survives on the milestone (attached to the last task by the engine).
    expect(m1.acceptance).toHaveLength(1);
  });

  it('deduplicates ids and disambiguates duplicate titles', () => {
    const built = buildPlan({
      milestones: [{ title: 'M' }],
      tasks: [
        { id: 'PT-1', title: 'Do work', acceptance: [{ kind: 'evidence-present', detail: 'did the work' }] },
        { id: 'PT-1', title: 'Do work', acceptance: [{ kind: 'evidence-present', detail: 'did the other work' }] },
      ],
    });
    const ids = built.tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
    const titles = built.tasks.map((t) => t.title);
    expect(new Set(titles.map((t) => t.toLowerCase())).size).toBe(2);
  });

  it('creates a fallback milestone+task when the raw plan is empty (never an unexecutable plan)', () => {
    const built = buildPlan({ milestones: [], tasks: [] });
    expect(built.milestones.length).toBeGreaterThan(0);
    expect(built.tasks.length).toBeGreaterThan(0);
  });
});

describe('Round22 §3.2 — plan validation detects every mandated defect', () => {
  const soundPlan = buildPlan({
    milestones: [{ id: 'M-1', title: 'A' }],
    tasks: [{ id: 'PT-1', title: 'T1', milestone: 'M-1', acceptance: [{ kind: 'evidence-present', detail: 'evidence exists for t1' }] }],
  });

  it('a sound plan has no issues', () => {
    expect(validateProjectPlan(soundPlan.milestones, soundPlan.tasks, soundPlan.deliverables).issues).toEqual([]);
  });

  it('detects dependency cycles (declared loop)', () => {
    const built = buildPlan({
      milestones: [{ title: 'M' }],
      tasks: [
        { id: 'PT-1', title: 'A', dependsOn: ['PT-2'], acceptance: [{ kind: 'evidence-present', detail: 'a evidence present' }] },
        { id: 'PT-2', title: 'B', dependsOn: ['PT-1'], acceptance: [{ kind: 'evidence-present', detail: 'b evidence present' }] },
      ],
    });
    const v = validateProjectPlan(built.milestones, built.tasks, built.deliverables);
    expect(v.issues.some((i) => i.kind === 'cycle')).toBe(true);
    expect(v.issues.find((i) => i.kind === 'cycle')!.message).toMatch(/circular dependency/);
  });

  it('detects missing dependencies', () => {
    const v = validateProjectPlan(
      [{ id: 'M-1', title: 'M', detail: '', taskIds: ['PT-1'], acceptance: [], deliverableIds: [] }],
      [{ id: 'PT-1', title: 'T', detail: '', kind: 'general', dependsOn: ['PT-9'], acceptance: [{ kind: 'evidence-present', detail: 'evidence for t' }], deliverableIds: [], milestoneId: 'M-1', retryMax: 1, state: 'pending', attempts: [] }],
      []
    );
    expect(v.issues.some((i) => i.kind === 'missing-dep' && i.message.includes('PT-9'))).toBe(true);
  });

  it('detects duplicate ids, duplicate titles and invalid milestone references', () => {
    const task = (id: string, title: string, milestone: string) => ({
      id,
      title,
      detail: '',
      kind: 'general' as const,
      dependsOn: [],
      acceptance: [{ kind: 'evidence-present' as const, detail: `evidence for ${id}` }],
      deliverableIds: [],
      milestoneId: milestone,
      retryMax: 1,
      state: 'pending' as const,
      attempts: [],
    });
    const milestones = [{ id: 'M-1', title: 'M', detail: '', taskIds: ['PT-1'], acceptance: [], deliverableIds: [] }];
    const v = validateProjectPlan(milestones, [task('PT-1', 'Same', 'M-1'), task('PT-1', 'Same', 'M-2')], []);
    expect(v.issues.some((i) => i.kind === 'duplicate-id')).toBe(true);
    expect(v.issues.some((i) => i.kind === 'duplicate-title')).toBe(true);
    expect(v.issues.some((i) => i.kind === 'invalid-milestone' && i.message.includes('M-2'))).toBe(true);
  });

  it('detects tasks without meaningful completion criteria and orphaned deliverables', () => {
    const milestones = [{ id: 'M-1', title: 'M', detail: '', taskIds: ['PT-1', 'PT-2'], acceptance: [], deliverableIds: ['D-1'] }];
    const base = { detail: '', kind: 'general' as const, dependsOn: [], deliverableIds: [] as string[], retryMax: 1, state: 'pending' as const, attempts: [] as never[] };
    const tasks = [
      { id: 'PT-1', title: 'No criteria', milestoneId: 'M-1', acceptance: [], ...base },
      { id: 'PT-2', title: 'Fine', milestoneId: 'M-1', acceptance: [{ kind: 'evidence-present' as const, detail: 'evidence for pt2' }], ...base },
    ];
    const v = validateProjectPlan(milestones, tasks, [{ id: 'D-1', name: 'Orphan', path: 'x.md', producingTaskId: 'PT-99', format: 'md', required: true, milestoneId: 'M-1' }]);
    expect(v.issues.some((i) => i.kind === 'no-criteria' && i.message.includes('No criteria'))).toBe(true);
    expect(v.issues.some((i) => i.kind === 'orphaned-deliverable' && i.message.includes('PT-99'))).toBe(true);
  });

  it('an empty plan is structural and NOT repairable', () => {
    const v = validateProjectPlan([], [], []);
    expect(v.issues.some((i) => i.kind === 'invalid-structure')).toBe(true);
    expect(v.repairable).toBe(false);
  });
});

describe('Round22 §3.2 — safe repair records every change (never silent)', () => {
  it('drops missing edges, breaks cycles, re-points milestones, detaches orphans, adds evidence criteria — and reports all of it', () => {
    const milestones = [
      { id: 'M-1', title: 'M1', detail: '', taskIds: ['PT-1', 'PT-2', 'PT-3'], acceptance: [], deliverableIds: ['D-1'] },
      { id: 'M-2', title: 'M2', detail: '', taskIds: [], acceptance: [], deliverableIds: [] },
    ];
    const task = (id: string, deps: string[], acceptance: unknown[] = []) => ({
      id,
      title: `Task ${id}`,
      detail: '',
      kind: 'general',
      dependsOn: deps,
      acceptance: acceptance as never,
      deliverableIds: [],
      milestoneId: 'M-9', // invalid on purpose
      retryMax: 1,
      state: 'pending' as const,
      attempts: [],
    });
    const tasks = [task('PT-1', ['PT-99']), task('PT-2', ['PT-3']), task('PT-3', ['PT-2'])]; // missing dep + 2-cycle
    const deliverables = [
      { id: 'D-1', name: 'Orphan', path: 'o.md', producingTaskId: 'PT-77', format: 'md', required: true, milestoneId: 'M-1' },
      { id: 'D-2', name: 'Kept', path: 'k.md', producingTaskId: 'PT-2', format: 'md', required: true, milestoneId: 'M-1' },
    ];
    const r = repairPlan(milestones, tasks, deliverables);
    // Every repair is REPORTED
    expect(r.repairs.some((x) => x.includes('PT-99'))).toBe(true);
    expect(r.repairs.some((x) => /circular dependency/i.test(x))).toBe(true);
    expect(r.repairs.some((x) => x.includes('M-9'))).toBe(true);
    expect(r.repairs.some((x) => x.includes('Orphan'))).toBe(true);
    expect(r.repairs.some((x) => /evidence-present/i.test(x))).toBe(true);
    // The graph is now valid and executable
    const v = validateProjectPlan(r.milestones, r.tasks, r.deliverables);
    expect(v.issues).toEqual([]);
    expect(r.tasks.every((t) => t.acceptance.length > 0 || t.deliverableIds.length > 0)).toBe(true);
    // The orphaned deliverable is out of the ACTIVE plan (history keeps the original)
    expect(r.deliverables.find((d) => d.id === 'D-1')).toBeUndefined();
    expect(r.deliverables.find((d) => d.id === 'D-2')).toBeDefined();
    // Empty milestone got a task
    expect(r.milestones.find((m) => m.id === 'M-2')!.taskIds.length).toBeGreaterThan(0);
  });
});

describe('Round22 §3.2 — deterministic fallback plan and model-plan parsing', () => {
  it('fallbackPlan produces an executable plan from the understanding', () => {
    const u = extractUnderstanding(DESCRIPTION);
    const raw = fallbackPlan(u);
    const built = buildPlan(raw);
    const v = validateProjectPlan(built.milestones, built.tasks, built.deliverables);
    expect(v.issues).toEqual([]);
    const last = built.tasks[built.tasks.length - 1];
    expect(last.kind).toBe('verifier');
    expect(built.deliverables.length).toBeGreaterThan(0);
  });

  it('parseModelPlan returns null for garbage and extracts valid JSON', () => {
    expect(parseModelPlan('no json here')).toBeNull();
    expect(parseModelPlan('{"tasks": []}')).toBeNull();
    const raw = parseModelPlan('prefix {"milestones":[{"title":"M"}],"tasks":[{"title":"T","milestone":"M","acceptance":[{"kind":"evidence-present","detail":"evidence"}]}]} suffix');
    expect(raw?.tasks).toHaveLength(1);
  });

  it('the planning prompt demands criteria and forbids cycles', () => {
    const u = extractUnderstanding(DESCRIPTION);
    const p = planningPrompt(u);
    expect(p).toMatch(/no dependency cycles/);
    expect(p).toMatch(/acceptance criterion/);
    expect(p).toMatch(/verifier/);
  });
});

describe('Round22 §3.8 — project templates', () => {
  it('ships four built-in templates with valid plans', () => {
    expect(PROJECT_TEMPLATES.length).toBeGreaterThanOrEqual(4);
    for (const t of PROJECT_TEMPLATES) {
      const built = buildPlan({ milestones: t.milestones.map((m) => ({ id: m.id, title: m.title, detail: m.detail, acceptance: m.acceptance })), tasks: t.milestones.flatMap((m) => m.tasks.map((tk) => ({ ...tk, milestone: m.id ?? m.title }))) });
      const v = validateProjectPlan(built.milestones, built.tasks, built.deliverables);
      expect(v.issues).toEqual([]);
    }
  });

  it('template lookup and listing work', () => {
    expect(templateById('research-report')?.name).toBe('Research report');
    expect(templateById('nope')).toBeUndefined();
    expect(templateList()).toMatch(/software-build/);
  });
});
