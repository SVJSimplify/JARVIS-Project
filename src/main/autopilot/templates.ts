/**
 * PROJECT TEMPLATES (Round 22, §3.8) — deterministic starting points for common project
 * shapes. A template seeds the understanding and the plan v1; the user's description
 * (when provided) is still run through understanding first and the template supplies
 * the structural skeleton. Templates are DATA — they create no files, touch no paths,
 * and go through the same validation/repair as every other plan.
 */

import type { ProjectTemplate } from './types';

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'software-build',
    name: 'Software build',
    description: 'Build or extend a small piece of software with tests and a README.',
    category: 'software',
    complexity: 'standard',
    seed: {
      requirements: ['working implementation', 'the code runs from a clean checkout'],
      successCriteria: ['the implementation passes its verification command', 'usage is documented'],
      deliverables: ['the implementation', 'a README with run instructions'],
      assumptions: ['the target runtime is available on this machine'],
    },
    milestones: [
      {
        id: 'M-1',
        title: 'Setup and scaffold',
        detail: 'Verify the environment and lay out the structure.',
        tasks: [
          {
            title: 'Inspect the environment and existing files',
            detail: 'Check the workspace for existing project files and the toolchain (node/python etc.). Report what exists before creating anything.',
            kind: 'explore',
            acceptance: [{ kind: 'evidence-present', detail: 'the environment facts were verified with real tools' }],
          },
        ],
      },
      {
        id: 'M-2',
        title: 'Implement',
        detail: 'The core implementation work.',
        tasks: [
          {
            title: 'Implement the core',
            detail: 'Write the implementation per the requirements. Keep every file inside the Jarvis-Files workspace.',
            kind: 'general',
            dependsOn: ['PT-1'],
            acceptance: [{ kind: 'evidence-present', detail: 'implementation files were written and verified' }],
          },
          {
            title: 'Test and fix',
            detail: 'Run the available verification (tests/typecheck/build) and fix what fails. Record the command and its exit.',
            kind: 'general',
            dependsOn: ['PT-2'],
            acceptance: [{ kind: 'command-passes', detail: 'the verification command passes where one exists' }],
          },
        ],
      },
      {
        id: 'M-3',
        title: 'Document and close',
        detail: 'README and final verification.',
        tasks: [
          {
            title: 'Write the README and verify the whole',
            detail: 'Write a README with run instructions; then re-verify the deliverables on disk and report evidence.',
            kind: 'verifier',
            dependsOn: ['PT-3'],
            deliverables: [{ name: 'README', path: 'projects/software/README.md', format: 'md' }],
            acceptance: [{ kind: 'file-exists', detail: 'the README exists on disk' }],
          },
        ],
      },
    ],
  },
  {
    id: 'research-report',
    name: 'Research report',
    description: 'Research a topic with live sources and produce a cited report.',
    category: 'research',
    complexity: 'standard',
    seed: {
      requirements: ['at least 3 distinct live sources', 'claims are attributed to sources'],
      successCriteria: ['the report exists, cites its sources and answers the research question'],
      deliverables: ['a cited research report (markdown)'],
    },
    milestones: [
      {
        id: 'M-1',
        title: 'Gather',
        detail: 'Collect and verify sources.',
        tasks: [
          {
            title: 'Research the topic with live sources',
            detail: 'Use web search/fetch tools; collect at least 3 distinct sources; extract the key facts with their URLs.',
            kind: 'research',
            acceptance: [{ kind: 'sources-present', detail: 'at least 3 distinct sources were actually fetched', min: 3 }],
          },
        ],
      },
      {
        id: 'M-2',
        title: 'Write and verify',
        detail: 'Produce the report and verify it.',
        tasks: [
          {
            title: 'Write the cited report',
            detail: 'Write the report to the planned path with a sources section listing every URL used.',
            kind: 'document',
            dependsOn: ['PT-1'],
            deliverables: [{ name: 'Research report', path: 'projects/research/report.md', format: 'md' }],
            acceptance: [{ kind: 'file-format', detail: 'the report is valid markdown text' }],
          },
          {
            title: 'Verify the report against the criteria',
            detail: 'Re-open the report, check the sources section and the success criteria, report evidence.',
            kind: 'verifier',
            dependsOn: ['PT-2'],
            acceptance: [{ kind: 'evidence-present', detail: 'the report was re-checked on disk' }],
          },
        ],
      },
    ],
  },
  {
    id: 'content-production',
    name: 'Content production',
    description: 'Produce a document/deliverable from a brief (article, deck, docs set).',
    category: 'content',
    complexity: 'light',
    seed: {
      successCriteria: ['the deliverable exists and follows the brief'],
      deliverables: ['the requested content file'],
    },
    milestones: [
      {
        id: 'M-1',
        title: 'Draft',
        detail: 'Produce the content.',
        tasks: [
          {
            title: 'Draft the content',
            detail: 'Write the content per the brief to the planned path.',
            kind: 'document',
            deliverables: [{ name: 'Content deliverable', path: 'projects/content/deliverable.md', format: 'md' }],
            acceptance: [{ kind: 'file-nonempty', detail: 'the content file exists and is non-empty' }],
          },
        ],
      },
      {
        id: 'M-2',
        title: 'Review',
        detail: 'Check against the brief.',
        tasks: [
          {
            title: 'Review against the brief and finalize',
            detail: 'Re-read the brief, fix gaps, verify the file reopens cleanly.',
            kind: 'verifier',
            dependsOn: ['PT-1'],
            acceptance: [{ kind: 'file-format', detail: 'the deliverable reopens and validates as its format' }],
          },
        ],
      },
    ],
  },
  {
    id: 'data-analysis',
    name: 'Data analysis',
    description: 'Analyse a dataset and produce a findings summary.',
    category: 'data',
    complexity: 'standard',
    seed: {
      requirements: ['numbers are computed from the actual data, never asserted'],
      successCriteria: ['the findings cite the concrete numbers behind each claim'],
      deliverables: ['a findings summary with the computed numbers'],
    },
    milestones: [
      {
        id: 'M-1',
        title: 'Inspect the data',
        detail: 'Understand shape and quality.',
        tasks: [
          {
            title: 'Inspect the dataset',
            detail: 'Locate the data, inspect its shape/fields/quality with read-only tools first. Report what actually exists.',
            kind: 'data',
            acceptance: [{ kind: 'evidence-present', detail: 'the dataset was inspected with real reads' }],
          },
        ],
      },
      {
        id: 'M-2',
        title: 'Analyse and report',
        detail: 'Compute and summarize.',
        tasks: [
          {
            title: 'Compute the analysis',
            detail: 'Compute the required metrics/figures from the data; keep the computation reproducible.',
            kind: 'data',
            dependsOn: ['PT-1'],
            acceptance: [{ kind: 'evidence-present', detail: 'the numbers were computed from the real data' }],
          },
          {
            title: 'Write the findings and verify',
            detail: 'Write the findings summary with the concrete numbers; verify the file on disk.',
            kind: 'verifier',
            dependsOn: ['PT-2'],
            deliverables: [{ name: 'Findings summary', path: 'projects/data/findings.md', format: 'md' }],
            acceptance: [{ kind: 'file-format', detail: 'the findings file is valid markdown' }],
          },
        ],
      },
    ],
  },
];

export const templateById = (id: string): ProjectTemplate | undefined => PROJECT_TEMPLATES.find((t) => t.id === String(id ?? '').trim());

/** A one-line menu for tools/UI. */
export const templateList = (): string =>
  PROJECT_TEMPLATES.map((t) => `${t.id} — ${t.name}: ${t.description}`).join('\n');
