import { useCallback, useEffect, useState } from 'react';
import { popModal, pushModal } from '../lib/modalState';
import ProjectGraph from './ProjectGraph';

/**
 * PROJECTS WORKSPACE (Round 22, §3.8) — the Projects panel in the JARVIS renderer.
 *
 * Every control here invokes a REAL backend operation through window.electronAPI.projects.*
 * (list/get/create/execute/pause/resume/cancel/replan/updateRequirements) and every state
 * shown comes from the durable project store — there are no decorative controls and no
 * fake progress. Design language follows the established panels (Esc/✕/backdrop close,
 * hud classes, mono labels, accent-on-line styling).
 */

// ---------------------------------------------------------------- view shapes (mirror views.ts)

export interface ProjectSummary {
  id: string;
  title: string;
  status: string;
  category: string;
  complexity: string;
  planVersion: number;
  createdAt: number;
  updatedAt: number;
  tasksTotal: number;
  tasksCompleted: number;
  tasksBlocked: number;
  tasksFailed: number;
  milestones: Array<{ id: string; title: string; done: number; total: number; state: 'completed' | 'in_progress' | 'blocked' | 'pending' }>;
  deliverables: number;
  deliverablesVerified: number;
  blockReason?: string;
  workspace?: string;
  nextAction: string;
}

export interface ProjectDetail {
  summary: ProjectSummary;
  objective: string;
  summaryText: string;
  requirements: string[];
  constraints: string[];
  assumptions: string[];
  outOfScope: string[];
  successCriteria: string[];
  request: string;
  understandingSources: Record<string, string>;
  tasks: Array<{
    id: string;
    title: string;
    state: string;
    kind: string;
    milestoneId: string;
    dependsOn: string[];
    durableTaskId?: string;
    acceptanceCount: number;
    deliverableIds: string[];
    attempts: number;
    lastFailure?: { at: number; class: string; evidence: string };
    expectedOutput?: string;
  }>;
  deliverables: Array<{ id: string; name: string; path: string; format: string; required: boolean; producingTaskId: string; milestoneId: string; statusLine: string }>;
  decisions: Array<{ id: string; at: number; text: string; source: string; supersededBy?: string; supersedes?: string[] }>;
  events: Array<{ id: string; at: number; kind: string; message: string; refs?: Record<string, string> }>;
  planHistory: Array<{ version: number; at: number; note: string; repairs: string[] }>;
  replans: number;
  briefing: string;
}

interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  category: string;
  complexity: string;
}

const PAGE_SIZE = 8;

const chip = (status: string): string => {
  const base = 'rounded-sm px-2 py-0.5 font-mono text-[12px]   ';
  if (status === 'completed') return base + 'bg-[rgba(79,127,85,0.12)] text-[#4F7F55]';
  if (status === 'active') return base + 'bg-[rgba(176,90,51,0.10)] text-accent';
  if (status === 'blocked' || status === 'failed') return base + 'bg-[rgba(180,71,58,0.12)] text-hot';
  if (status === 'paused') return base + 'bg-[rgba(168,110,26,0.12)] text-[#A86E1A]';
  if (status === 'cancelled') return base + 'bg-[rgba(230,222,207,0.18)] text-steel';
  return base + 'bg-[rgba(230,222,207,0.18)] text-steel';
};
const actionBtn =
  'no-drag rounded-sm border border-line px-3 py-1.5 font-display text-[12px] font-bold text-steel transition-colors hover:border-accent hover:text-accent disabled:opacity-40 disabled:hover:border-line disabled:hover:text-steel';

const stamp = (t: number): string => {
  const d = new Date(t);
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
};

const TASK_STATE_COLORS: Record<string, string> = {
  completed: 'text-[#4F7F55]',
  running: 'text-accent',
  pending: 'text-steel',
  failed: 'text-hot',
  blocked: 'text-hot',
  interrupted: 'text-[#A86E1A]',
  skipped: 'text-steel/60',
};

/** ROUND 31 (§5.2): milestone state chips — honest state words, never percentages. */
const MILESTONE_STATE: Record<string, { label: string; cls: string }> = {
  completed: { label: 'completed', cls: 'text-[#4F7F55] border-[rgba(79,127,85,0.35)]' },
  in_progress: { label: 'in progress', cls: 'text-accent border-[rgba(176,90,51,0.35)]' },
  blocked: { label: 'blocked', cls: 'text-hot border-[rgba(180,71,58,0.4)]' },
  pending: { label: 'pending', cls: 'text-steel border-line' },
};

/** Progress bar used for milestone/project progress. */
function Bar({ done, total, hot }: { done: number; total: number; hot?: boolean }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[rgba(176,90,51,0.08)]">
        <div className={`h-full rounded-full ${hot ? 'bg-hot' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="shrink-0 font-mono text-[12px] text-steel">
        {done}/{total}
      </span>
    </div>
  );
}

export default function ProjectsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [list, setList] = useState<{ total: number; offset: number; projects: ProjectSummary[]; counts: Record<string, number> } | null>(null);
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [reqAdd, setReqAdd] = useState('');
  const [reqRemove, setReqRemove] = useState('');
  const [tab, setTab] = useState<'overview' | 'tasks' | 'graph' | 'deliverables' | 'decisions' | 'activity'>('overview');

  const api = () => (window.electronAPI as unknown as { projects?: NonNullable<unknown> }).projects as {
    list: (o?: { offset?: number; limit?: number; query?: string }) => Promise<{ total: number; offset: number; projects: ProjectSummary[]; counts: Record<string, number> }>;
    get: (id: string) => Promise<ProjectDetail | null>;
    templates: () => Promise<{ templates: TemplateInfo[] }>;
    create: (d: string, t?: string) => Promise<{ id: string }>;
    execute: (id: string) => Promise<string>;
    pause: (id: string) => Promise<string>;
    resume: (id: string) => Promise<string>;
    cancel: (id: string) => Promise<string>;
    replan: (id: string, note?: string) => Promise<string>;
    updateRequirements: (id: string, patch: { add?: string[]; remove?: string[]; note?: string }) => Promise<string>;
  } | undefined;

  const refreshList = useCallback(
    async (atOffset = offset) => {
      const a = api();
      if (!a) return;
      try {
        const r = await a.list({ offset: atOffset, limit: PAGE_SIZE, query });
        setList(r);
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
      }
    },
    [offset, query]
  );

  const refreshDetail = useCallback(async (id: string) => {
    const a = api();
    if (!a) return;
    try {
      const d = await a.get(id);
      setDetail(d);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    pushModal('projects');
    void refreshList(0);
    void (async () => {
      const a = api();
      if (!a) return;
      try {
        const t = await a.templates();
        setTemplates(t.templates ?? []);
      } catch {
        /* the template picker is optional; the create form still works */
      }
    })();
    return () => popModal('projects');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => {
      void refreshList();
      if (selected) void refreshDetail(selected);
    }, 4000);
    return () => clearInterval(t);
  }, [open, refreshList, refreshDetail, selected]);

  const run = useCallback(
    async (id: string, op: (a: NonNullable<ReturnType<typeof api>>) => Promise<string>) => {
      const a = api();
      if (!a) return;
      setBusyId(id);
      setNotice('');
      try {
        const msg = await op(a);
        setNotice(msg);
        await refreshList();
        if (selected === id) await refreshDetail(id);
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [refreshList, refreshDetail, selected]
  );

  const createProject = useCallback(async () => {
    const a = api();
    if (!a || !description.trim()) return;
    setCreating(true);
    setNotice('');
    try {
      const p = (await a.create(description.trim(), templateId || undefined)) as { id: string };
      setDescription('');
      setNotice(`Project ${p.id} created from the description.`);
      await refreshList(0);
      setSelected(p.id);
      await refreshDetail(p.id);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [description, templateId, refreshList, refreshDetail]);

  if (!open) return null;

  const counts = list?.counts ?? {};

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-[#FBF8F2]" role="dialog" aria-label="Projects workspace">
      <div className="hud-header flex h-[52px] shrink-0 items-center gap-4 border-b border-black/[0.05] px-6">
        <button type="button" className="no-drag inline-flex items-center gap-2 rounded-lg px-2 py-1 text-[13.5px] font-medium text-muted transition-colors hover:bg-black/[0.05] hover:text-text" onClick={onClose}>
          ← Back
        </button>
        <h2 className="text-[14px] font-semibold text-text">Projects</h2>
        <span className="font-mono text-[12px] text-steel">
          {counts.all ?? 0} project{(counts.all ?? 0) === 1 ? '' : 's'} · durable records
        </span>
      </div>

      <div className="flex min-h-0 flex-1 gap-6 px-6 pb-6">
        {/* LEFT: create + list (paginated, non-destructive) */}
        <aside className="flex w-[380px] shrink-0 flex-col gap-4 overflow-hidden">
          <div className="rounded-sm border border-line p-3">
            <div className="mb-2 font-mono text-[12px] text-accent/80">New project</div>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the whole project in natural language — goal, requirements, constraints, what success looks like…"
              rows={4}
              className="w-full resize-none rounded-sm border border-line bg-transparent p-2 text-[13px] text-hot/90 outline-none placeholder:text-steel/50 focus:border-accent"
            />
            <div className="mt-2 flex items-center gap-2">
              <select
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                className="min-w-0 flex-1 rounded-sm border border-line bg-transparent px-2 py-1.5 font-mono text-[12px] text-steel outline-none focus:border-accent"
                aria-label="Project template"
              >
                <option value="">No template</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id} className="bg-[#0a1220]">
                    {t.name} ({t.complexity})
                  </option>
                ))}
              </select>
              <button type="button" className={actionBtn} disabled={creating || !description.trim()} onClick={() => void createProject()}>
                {creating ? '…' : 'Create'}
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOffset(0);
                void refreshList(0);
              }}
              placeholder="Search projects…"
              className="min-w-0 flex-1 rounded-sm border border-line bg-transparent px-2 py-1.5 text-[12px] text-hot/90 outline-none placeholder:text-steel/50 focus:border-accent"
            />
          </div>

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {(list?.projects ?? []).map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  setSelected(p.id);
                  void refreshDetail(p.id);
                }}
                className={`block w-full rounded-sm border p-2.5 text-left transition-colors ${selected === p.id ? 'border-accent/60' : 'border-line hover:border-accent/40'}`}
              >
                <div className="flex items-center gap-2">
                  <span className={`shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[12px]   ${chip(p.status)}`}>{p.status}</span>
                  <span className="truncate text-[13px] text-hot/90">{p.title}</span>
                </div>
                <div className="mt-1 flex items-center gap-2 font-mono text-[12px] text-steel">
                  <span>
                    {p.tasksCompleted}/{p.tasksTotal} tasks
                  </span>
                  <span>· v{p.planVersion}</span>
                  <span>· {stamp(p.updatedAt)}</span>
                </div>
                {p.tasksBlocked > 0 && <div className="mt-1 font-mono text-[12px] text-hot">{p.tasksBlocked} blocked task(s) — policy</div>}
                {p.nextAction && (
                  <div className="mt-1 truncate font-mono text-[12px] text-accent/70" title={p.nextAction}>
                    → {p.nextAction}
                  </div>
                )}
              </button>
            ))}
            {list && list.total === 0 && <p className="px-1 py-6 text-center font-mono text-[12px] text-steel">No projects match. Every project ever created stays listed here — nothing is pruned.</p>}
            {list && list.total > PAGE_SIZE && (
              <div className="flex items-center justify-between pt-1">
                <button type="button" className={actionBtn} disabled={offset === 0} onClick={() => { const o = Math.max(0, offset - PAGE_SIZE); setOffset(o); void refreshList(o); }}>
                  ← Prev
                </button>
                <span className="font-mono text-[12px] text-steel">
                  {offset + 1}–{Math.min(offset + PAGE_SIZE, list.total)} of {list.total}
                </span>
                <button type="button" className={actionBtn} disabled={offset + PAGE_SIZE >= list.total} onClick={() => { const o = offset + PAGE_SIZE; setOffset(o); void refreshList(o); }}>
                  Next →
                </button>
              </div>
            )}
          </div>
        </aside>

        {/* RIGHT: detail */}
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-sm border border-line">
          {!detail ? (
            <div className="flex flex-1 items-center justify-center font-mono text-[12px] text-steel">Select a project — or create one. All records persist across restarts.</div>
          ) : (
            <>
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-3">
                <span className={`rounded-sm px-2 py-0.5 font-mono text-[12px]   ${chip(detail.summary.status)}`}>{detail.summary.status}</span>
                <h3 className="text-[16px] text-hot">{detail.summary.title}</h3>
                <span className="font-mono text-[12px] text-steel">
                  {detail.summary.id} · plan v{detail.summary.planVersion} · {detail.summary.category}/{detail.summary.complexity}
                </span>
                <div className="ml-auto flex flex-wrap gap-1.5">
                  {['draft', 'paused', 'blocked'].includes(detail.summary.status) && (
                    <button type="button" className={actionBtn} disabled={busyId === detail.summary.id} onClick={() => void run(detail.summary.id, (a) => a.execute(detail.summary.id))}>
                      {detail.summary.status === 'draft' ? 'Execute' : 'Resume'}
                    </button>
                  )}
                  {detail.summary.status === 'active' && (
                    <button type="button" className={actionBtn} disabled={busyId === detail.summary.id} onClick={() => void run(detail.summary.id, (a) => a.pause(detail.summary.id))}>
                      Pause
                    </button>
                  )}
                  {['active', 'paused'].includes(detail.summary.status) && (
                    <button type="button" className={actionBtn} disabled={busyId === detail.summary.id} onClick={() => void run(detail.summary.id, (a) => a.cancel(detail.summary.id))}>
                      Cancel
                    </button>
                  )}
                  {!['completed', 'failed', 'cancelled'].includes(detail.summary.status) && (
                    <button type="button" className={actionBtn} disabled={busyId === detail.summary.id} onClick={() => void run(detail.summary.id, (a) => a.replan(detail.summary.id, 'replan from the Projects panel'))}>
                      Replan
                    </button>
                  )}
                </div>
              </div>

              {(detail.summary.blockReason || notice) && (
                <div className={`shrink-0 border-b px-4 py-2 font-mono text-[12px] ${detail.summary.blockReason ? 'border-hot/30 text-hot' : 'border-accent/30 text-accent/90'}`}>
                  {detail.summary.blockReason ? `BLOCKED/FAILED — ${detail.summary.blockReason} (explicit resume/replan required; the restriction is never retried automatically)` : notice}
                </div>
              )}

              <div className="flex shrink-0 gap-4 border-b border-line px-4 pt-2">
                {(['overview', 'tasks', 'graph', 'deliverables', 'decisions', 'activity'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTab(t)}
                    className={`pb-2 font-display text-[12px] font-bold transition-colors ${tab === t ? 'border-b border-accent text-accent' : 'text-steel hover:text-accent/80'}`}
                  >
                    {t}
                  </button>
                ))}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                {tab === 'overview' && (
                  <div className="space-y-4">
                    <p className="text-[13.5px] leading-relaxed text-hot/85">{detail.objective}</p>
                    {detail.summary.workspace && (
                      <p className="font-mono text-[12px] text-steel" title={detail.summary.workspace}>
                        workspace: {detail.summary.workspace}
                      </p>
                    )}
                    {detail.summary.nextAction && (
                      <div className="rounded-sm border border-[rgba(176,90,51,0.25)] bg-[rgba(176,90,51,0.05)] px-3 py-2 font-mono text-[12px] text-accent/90">
                        NEXT RECOMMENDED ACTION — {detail.summary.nextAction}
                      </div>
                    )}
                    {detail.summaryText && <p className="text-[12.5px] leading-relaxed text-steel">{detail.summaryText}</p>}
                    <div>
                      <div className="mb-1 font-mono text-[12px] text-accent/80">Project progress</div>
                      <Bar done={detail.summary.tasksCompleted} total={detail.summary.tasksTotal} />
                    </div>
                    <div className="grid gap-2 md:grid-cols-2">
                      {detail.summary.milestones.map((m) => {
                        const st = MILESTONE_STATE[m.state] ?? MILESTONE_STATE.pending;
                        return (
                          <div key={m.id} className="rounded-sm border border-line p-2.5">
                            <div className="mb-1.5 flex items-baseline justify-between gap-2">
                              <span className="truncate text-[12.5px] text-hot/90">{m.title}</span>
                              <span className={`shrink-0 rounded-sm border px-1.5 font-mono text-[12px]  ${st.cls}`}>{st.label}</span>
                            </div>
                            <Bar done={m.done} total={m.total} hot={m.state === 'blocked'} />
                          </div>
                        );
                      })}
                    </div>
                    {detail.briefing && (
                      <details className="rounded-sm border border-line p-2.5">
                        <summary className="cursor-pointer font-mono text-[12px] text-accent/70">Continuity briefing (returning to this project)</summary>
                        <pre className="mt-2 whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-hot/80">{detail.briefing}</pre>
                      </details>
                    )}
                    <div className="grid gap-3 md:grid-cols-2">
                      {([
                        ['Requirements', detail.requirements],
                        ['Constraints', detail.constraints],
                        ['Assumptions (kept as assumptions)', detail.assumptions],
                        ['Out of scope', detail.outOfScope],
                        ['Success criteria', detail.successCriteria],
                      ] as const).map(([label, items]) => (
                        <div key={label} className="rounded-sm border border-line p-2.5">
                          <div className="mb-1 font-mono text-[12px] text-accent/70">{label}</div>
                          {items.length ? (
                            <ul className="list-disc space-y-1 pl-4">
                              {items.map((r, i) => (
                                <li key={i} className="text-[12px] leading-snug text-hot/80">
                                  {r}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="text-[12px] italic text-steel/60">none recorded</p>
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="rounded-sm border border-line p-2.5">
                      <div className="mb-1 font-mono text-[12px] text-accent/70">Update requirements (replans the remaining work)</div>
                      <div className="flex flex-wrap items-center gap-2">
                        <input value={reqAdd} onChange={(e) => setReqAdd(e.target.value)} placeholder="new requirement…" className="min-w-0 flex-1 rounded-sm border border-line bg-transparent px-2 py-1 text-[12px] text-hot/90 outline-none focus:border-accent" />
                        <input value={reqRemove} onChange={(e) => setReqRemove(e.target.value)} placeholder="remove (contains…)…" className="min-w-0 flex-1 rounded-sm border border-line bg-transparent px-2 py-1 text-[12px] text-hot/90 outline-none focus:border-accent" />
                        <button
                          type="button"
                          className={actionBtn}
                          disabled={busyId === detail.summary.id || (!reqAdd.trim() && !reqRemove.trim())}
                          onClick={() => {
                            const add = reqAdd.trim() ? [reqAdd.trim()] : [];
                            const remove = reqRemove.trim() ? [reqRemove.trim()] : [];
                            setReqAdd('');
                            setReqRemove('');
                            void run(detail.summary.id, (a) => a.updateRequirements(detail.summary.id, { add, remove, note: 'from the Projects panel' }));
                          }}
                        >
                          Apply
                        </button>
                      </div>
                    </div>
                    {detail.planHistory.length > 1 && (
                      <div className="rounded-sm border border-line p-2.5">
                        <div className="mb-1 font-mono text-[12px] text-accent/70">Plan history (versions archived, never deleted)</div>
                        <ul className="space-y-1">
                          {detail.planHistory.map((v) => (
                            <li key={v.version} className="font-mono text-[12px] text-steel">
                              v{v.version} · {stamp(v.at)} · {v.note}
                              {v.repairs.length ? ` · repairs: ${v.repairs.slice(0, 2).join('; ')}` : ''}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {tab === 'tasks' && (
                  <div className="space-y-2">
                    {detail.tasks.map((t) => (
                      <div key={t.id} className="rounded-sm border border-line p-2.5">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span className={`font-mono text-[12px]  ${TASK_STATE_COLORS[t.state] ?? 'text-steel'}`}>{t.state}</span>
                          <span className="text-[13px] text-hot/90">{t.title}</span>
                          <span className="font-mono text-[12px] text-steel">
                            {t.id} · {t.kind}
                            {t.durableTaskId ? ` · durable ${t.durableTaskId}` : ''}
                          </span>
                        </div>
                        <div className="mt-1 font-mono text-[12px] text-steel/80">
                          {t.acceptanceCount} acceptance check(s) · {t.attempts} attempt(s)
                          {t.dependsOn.length ? ` · depends on ${t.dependsOn.join(', ')}` : ' · no dependencies'}
                          {t.deliverableIds.length ? ` · produces ${t.deliverableIds.join(', ')}` : ''}
                        </div>
                        {t.lastFailure && <div className="mt-1 font-mono text-[12px] text-hot/90">{`last failure (${t.lastFailure.class}): ${t.lastFailure.evidence}`}</div>}
                      </div>
                    ))}
                  </div>
                )}

                {tab === 'graph' && (
                  <div className="space-y-3">
                    <p className="font-mono text-[12px] text-steel">Dependency graph — arrows point from a task to the work that must finish first</p>
                    <ProjectGraph tasks={detail.tasks} milestones={detail.summary.milestones} />
                  </div>
                )}

                {tab === 'deliverables' && (
                  <div className="space-y-2">
                    {detail.deliverables.length === 0 && <p className="py-6 text-center font-mono text-[12px] text-steel">No deliverable expectations in this plan.</p>}
                    {detail.deliverables.map((d) => (
                      <div key={d.id} className="rounded-sm border border-line p-2.5">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-[13px] text-hot/90">{d.name}</span>
                          <span className="font-mono text-[12px] text-steel">{d.required ? 'required' : 'optional'} · {d.format}</span>
                        </div>
                        <div className="mt-0.5 font-mono text-[12px] text-accent/80">{d.path}</div>
                        <div className="mt-1 font-mono text-[12px] text-steel">{d.statusLine} · produced by {d.producingTaskId}</div>
                      </div>
                    ))}
                  </div>
                )}

                {tab === 'decisions' && (
                  <div className="space-y-2">
                    {detail.decisions.length === 0 && <p className="py-6 text-center font-mono text-[12px] text-steel">No decisions recorded yet.</p>}
                    {detail.decisions.map((d) => (
                      <div key={d.id} className={`rounded-sm border p-2.5 ${d.supersededBy ? 'border-line/40 opacity-60' : 'border-line'}`}>
                        <div className="flex items-baseline gap-2">
                          <span className="font-mono text-[12px] text-steel">{stamp(d.at)} · {d.source}</span>
                          {d.supersededBy && <span className="font-mono text-[12px] text-steel/60">superseded by {d.supersededBy}</span>}
                          {d.supersedes?.length ? <span className="font-mono text-[12px] text-[#A86E1A]">supersedes {d.supersedes.join(', ')}</span> : null}
                        </div>
                        <p className="mt-0.5 text-[12.5px] leading-snug text-hot/85">{d.text}</p>
                      </div>
                    ))}
                  </div>
                )}

                {tab === 'activity' && (
                  <div className="space-y-1.5">
                    {detail.events.length === 0 && <p className="py-6 text-center font-mono text-[12px] text-steel">No events yet — execute the project to generate real activity.</p>}
                    {detail.events.map((e) => (
                      <div key={e.id} className="flex items-baseline gap-2 border-b border-line/20 py-1.5 last:border-b-0">
                        <span className="shrink-0 font-mono text-[12px] text-steel/70">{stamp(e.at)}</span>
                        <span className={`shrink-0 font-mono text-[12px]   ${e.kind === 'task-blocked' || e.kind === 'task-failed' ? 'text-hot' : e.kind === 'task-completed' || e.kind === 'milestone-completed' || e.kind === 'completed' || e.kind === 'deliverable-verified' ? 'text-[#4F7F55]' : 'text-accent/70'}`}>{e.kind}</span>
                        <span className="min-w-0 flex-1 text-[12px] leading-snug text-hot/80">{e.message}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      <button type="button" aria-label="Close projects" onClick={onClose} style={{ right: 'calc(100vw - env(titlebar-area-width, 100vw) + 12px)' }} className="no-drag absolute top-[10px] grid h-8 w-8 place-items-center rounded-lg text-steel transition-colors hover:bg-black/[0.06] hover:text-text">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M5 5l14 14M19 5L5 19" />
        </svg>
      </button>
    </div>
  );
}

