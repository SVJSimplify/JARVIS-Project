/**
 * PROJECT AUTOPILOT TOOLS (Round 22) — the model-facing surface.
 *
 * Every tool calls a REAL engine operation (create/execute/pause/resume/cancel/replan/
 * status/deliverables/decisions). There are no decorative controls: each tool mutates or
 * reads the durable project store or dispatches through the ONE coordinator. Wiring uses
 * the same CoordinatorDeps bundle as the coordinator tools (one runner, one schema picker).
 */

import type { Tool } from '../toolTypes';
import type { CoordinatorDeps } from '../coordinator';
import { templateList } from './templates';
import { listProjects } from './store';
import { deliverableStatusLine } from './deliverables';
import { projectWorkflowContinuity } from './views';
import {
  cancelProject,
  createProjectFromDescription,
  executeProject,
  pauseProject,
  projectBriefing,
  projectStatusText,
  replanProject,
  resumeProject,
  setAutopilotDeps,
  updateRequirements,
  type AutopilotDeps,
} from './engine';

const clip = (s: string, n: number): string => String(s ?? '').slice(0, n);

const getProjectFor = async (id: string) => {
  const { getProject } = await import('./store.js');
  return getProject(String(id ?? '').trim());
};

/** Register the autopilot tools + wire the engine to the app's coordinator bundle. */
export const autopilotTools = (deps: CoordinatorDeps): Record<string, Tool> => {
  const engineDeps: AutopilotDeps = { coordinator: deps };
  setAutopilotDeps(engineDeps);
  return {
    project_create: {
      description:
        'Create a PROJECT from a natural-language description: JARVIS derives the understanding (objective, requirements, constraints, assumptions, success criteria, deliverables), plans milestones and tasks as a dependency graph, and validates the plan. The project starts in draft — start it with project_execute.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'The full project description: goal, requirements, constraints, what success looks like.' },
          template: { type: 'string', description: `Optional template id. Available:\n${templateList()}` },
        },
        required: ['description'],
      },
      run: async (args) => {
        const p = await createProjectFromDescription(String(args.description ?? ''), { templateId: typeof args.template === 'string' ? args.template : undefined });
        return `Project ${p.id} created (draft): ${p.title}. Plan v${p.planVersion}: ${p.milestones.length} milestone(s), ${p.tasks.length} task(s), ${p.deliverables.length} deliverable expectation(s). ${p.events.find((e) => e.kind === 'planned')?.message ?? ''} Start with project_execute ${p.id}.`;
      },
    },
    project_execute: {
      description: 'Start (or continue) executing a project: its tasks run as REAL durable JARVIS tasks through the coordinator — planned, executed by scoped agents, verified against acceptance criteria.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: async (args) => {
        const p = await getProjectFor(String(args.id));
        if (!p) return `NOT DONE: no project ${String(args.id)}.`;
        return executeProject(p.id);
      },
    },
    project_status: {
      description: 'Ground-truth status of one project (or the project overview list): every milestone and task with its state, the durable task ids, deliverables, decisions and the honest block reason.',
      parameters: { type: 'object', properties: { id: { type: 'string' } } },
      run: async (args) => {
        const id = String(args.id ?? '').trim();
        if (id) {
          const p = await getProjectFor(id);
          return p ? projectStatusText(p) : `NOT DONE: no project ${id}.`;
        }
        const all = await listProjects();
        if (!all.length) return 'No projects exist yet. Create one with project_create.';
        return ['PROJECTS (newest first):', ...all.slice(0, 20).map((p) => `- ${p.id} [${p.status}] ${p.title} (plan v${p.planVersion}, ${p.tasks.filter((t) => t.state === 'completed').length}/${p.tasks.length} tasks verified)`)].join('\n');
      },
    },
    project_pause: {
      description: 'Pause a project: no new tasks dispatch; running tasks settle honestly.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: (args) => pauseProject(String(args.id ?? '')),
    },
    project_resume: {
      description: 'Resume a paused or blocked project (EXPLICIT action): interrupted durable tasks resume from their persisted plans — completed work is never redone.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: (args) => resumeProject(String(args.id ?? '')),
    },
    project_cancel: {
      description: 'Cancel a project: running tasks stop at the next step boundary; every record, event and deliverable is preserved (never deleted).',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: (args) => cancelProject(String(args.id ?? '')),
    },
    project_deliverables: {
      description: 'Verify and list a project deliverables against the disk: existence, readability, format validation, SHA-256 integrity and the producing task verdict — honest states, never assumed.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: async (args) => {
        const p = await getProjectFor(String(args.id));
        if (!p) return `NOT DONE: no project ${String(args.id)}.`;
        if (!p.deliverables.length) return `Project ${p.id} has no deliverable expectations.`;
        await import('./deliverables.js').then((m) => m.verifyProjectDeliverables(p));
        return ['DELIVERABLES (freshly verified against disk):', ...p.deliverables.map((d) => `- ${d.name} → ${d.path} [${d.required ? 'required' : 'optional'}] — ${deliverableStatusLine(p, d)}`)].join('\n');
      },
    },
    project_update_requirements: {
      description: 'Update a project requirements (add/remove) with decision records and contradiction marking, then replan the remaining work into a new plan version (completed work preserved).',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          add: { type: 'array', items: { type: 'string' } },
          remove: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
        required: ['id'],
      },
      run: async (args) => {
        const p = await getProjectFor(String(args.id));
        if (!p) return `NOT DONE: no project ${String(args.id)}.`;
        return updateRequirements(p.id, { add: Array.isArray(args.add) ? (args.add as unknown[]).map(String) : [], remove: Array.isArray(args.remove) ? (args.remove as unknown[]).map(String) : [], note: typeof args.note === 'string' ? args.note : undefined });
      },
    },
    project_replan: {
      description: 'Replan the REMAINING work of a project into a new plan version (user action): completed tasks are preserved verbatim, the old version is archived durably, validation + safe repair run and every repair is reported.',
      parameters: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } }, required: ['id'] },
      run: async (args) => {
        const p = await getProjectFor(String(args.id));
        if (!p) return `NOT DONE: no project ${String(args.id)}.`;
        const r = await replanProject(p.id, clip(String(args.note ?? 'user replan'), 160), { userTriggered: true });
        return r.ok ? `Replanned to plan v${r.version}: completed work preserved, remaining work re-planned and validated.` : `NOT DONE: ${r.reason}`;
      },
    },
    project_templates: {
      description: 'List the built-in project templates.',
      parameters: { type: 'object', properties: {} },
      run: () => templateList() || 'No templates.',
    },
    project_briefing: {
      description:
        'Continuity briefing for a project (Round 31): what it is, where it stands (verified facts only), the current milestone, completed and remaining work, what needs attention, key decisions, recent activity and the recommended next action. Use when returning to a project or before continuing its work.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: async (args) => {
        const p = await getProjectFor(String(args.id));
        if (!p) return `NOT DONE: no project ${String(args.id)}.`;
        const workflow = await projectWorkflowContinuity(p);
        return projectBriefing(p, workflow);
      },
    },
  };
};
