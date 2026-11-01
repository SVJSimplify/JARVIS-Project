import type { Tool } from './toolTypes';
import { loadAllGoals } from './goalEngine';
import { getEnvironmentSnapshot } from './envIntelligence';
import { verifyFileOutcome } from './outcomeVerifier';

export const cognitiveTools: Record<string, Tool> = {
  goal_status: {
    description: 'Inspect active authoritative goals, extracted constraints, and verifiable success criteria.',
    parameters: { type: 'object', properties: {} },
    run: async () => {
      const goals = await loadAllGoals();
      const active = goals.filter((g) => g.status === 'active' || g.status === 'in_progress');
      if (!active.length) return 'No active authoritative goals.';
      return active
        .map(
          (g) =>
            `Goal [${g.id}] (${g.priority}): ${g.objective}\n` +
            `Constraints: ${g.constraints.map((c) => c.description).join('; ') || 'none'}\n` +
            `Criteria: ${g.successCriteria.join('; ')}`
        )
        .join('\n\n');
    },
  },
  env_status: {
    description: 'Inspect verified environmental state: OS, memory, workspace root, and installed runtimes (node, python, git).',
    parameters: { type: 'object', properties: { refresh: { type: 'boolean' } } },
    run: async (args) => {
      const snap = await getEnvironmentSnapshot(args.refresh === true);
      return (
        `Environment: ${snap.platform}-${snap.arch} | ${snap.cpus} CPUs | ${snap.freeMemoryMb}MB / ${snap.totalMemoryMb}MB RAM free\n` +
        `Workspace: ${snap.workspacePath}\n` +
        `Runtimes: Node=${snap.runtimes.node}, Python=${snap.runtimes.python}, Git=${snap.runtimes.git}`
      );
    },
  },
  verify_file_change: {
    description: 'Independently inspect and verify a file on disk: ensures it exists, is not empty, and optionally matches an expected pattern.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace or absolute.' },
        expected_pattern: { type: 'string', description: 'Optional text pattern that must be found in the file.' },
      },
      required: ['path'],
    },
    run: async (args) => {
      const record = await verifyFileOutcome(
        String(args.path ?? ''),
        args.expected_pattern ? String(args.expected_pattern) : undefined
      );
      return `[VERIFICATION ${record.verdict}]: ${record.evidence}`;
    },
  },
};
