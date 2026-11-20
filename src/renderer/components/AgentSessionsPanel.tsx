import { useCallback, useEffect, useRef, useState } from 'react';
import { popModal, pushModal } from '../lib/modalState';
import type { AgentRuntimeEvent, AgentSessionSnapshot } from '../../main/agentEngine/runtime';
import type { RegisteredToolInfo } from '../../main/agentEngine/toolRegistry';

interface Props {
  open: boolean;
  onClose: () => void;
}

const statusTone: Record<string, string> = {
  running: 'bg-[#E8F0E5] text-[#496746]',
  aborting: 'bg-[#F6EAD9] text-[#94632C]',
  completed: 'bg-[#E8F0E5] text-[#496746]',
  failed: 'bg-[#F7E5E1] text-[#A34E3D]',
  aborted: 'bg-[#F1EBE0] text-[#786D5E]',
  interrupted: 'bg-[#F1EBE0] text-[#786D5E]',
  idle: 'bg-[#F1EBE0] text-[#786D5E]',
};

const stamp = (value: number): string =>
  Number.isFinite(value) && value > 0
    ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'Unknown time';

const eventTitle = (event: AgentRuntimeEvent): string => {
  const labels: Record<AgentRuntimeEvent['type'], string> = {
    'session-created': 'Session created',
    'abort-requested': 'Stop requested',
    'run-start': 'Run started',
    'model-start': 'Model started',
    'model-end': 'Model finished',
    'tool-start': 'Tool started',
    'tool-end': 'Tool finished',
    delta: 'Response streamed',
    progress: 'Progress',
    'run-end': 'Run finished',
    'session-restored': 'Session restored',
  };
  return labels[event.type] ?? event.type;
};

const shortId = (id: string): string => id.length > 26 ? id.slice(0, 12) + '…' + id.slice(-8) : id;

export default function AgentSessionsPanel({ open, onClose }: Props) {
  const [sessions, setSessions] = useState<AgentSessionSnapshot[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [snapshot, setSnapshot] = useState<AgentSessionSnapshot | null>(null);
  const [events, setEvents] = useState<AgentRuntimeEvent[]>([]);
  const [tools, setTools] = useState<RegisteredToolInfo[]>([]);
  const [plugins, setPlugins] = useState<Array<{ id: string }>>([]);
  const [view, setView] = useState<'sessions' | 'tools' | 'plugins'>('sessions');
  const [toolFilter, setToolFilter] = useState('');
  const [toolAction, setToolAction] = useState('');
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState('');
  const [error, setError] = useState('');
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const refresh = useCallback(async () => {
    try {
      const [list, toolList, pluginList] = await Promise.all([
        window.electronAPI.agent.sessions(),
        window.electronAPI.agent.tools.list(),
        window.electronAPI.agent.plugins.list(),
      ]);
      const ordered = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
      setSessions(ordered);
      setTools(toolList);
      setPlugins(pluginList);
      const id = selectedId && ordered.some((item) => item.id === selectedId) ? selectedId : ordered[0]?.id ?? '';
      if (!id) {
        setSelectedId('');
        setSnapshot(null);
        setEvents([]);
        return;
      }
      if (id !== selectedId) setSelectedId(id);
      const [nextSnapshot, replay] = await Promise.all([
        window.electronAPI.agent.snapshot(id),
        window.electronAPI.agent.replay(id, 0),
      ]);
      setSnapshot(nextSnapshot);
      setEvents(replay.slice(-100).reverse());
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load agent sessions.');
    }
  }, [selectedId]);

  useEffect(() => {
    if (!open) return;
    pushModal();
    setLoading(true);
    void refresh().finally(() => setLoading(false));
    const timer = window.setInterval(() => { void refresh(); }, 2500);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearInterval(timer);
      popModal();
      window.removeEventListener('keydown', onKey);
    };
  }, [open, refresh]);

  const selectSession = async (id: string) => {
    setSelectedId(id);
    setLoading(true);
    setError('');
    try {
      const [nextSnapshot, replay] = await Promise.all([
        window.electronAPI.agent.snapshot(id),
        window.electronAPI.agent.replay(id, 0),
      ]);
      setSnapshot(nextSnapshot);
      setEvents(replay.slice(-100).reverse());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not inspect this session.');
    } finally {
      setLoading(false);
    }
  };

  const forkSession = async () => {
    if (!snapshot) return;
    setAction('fork');
    setError('');
    try {
      const child = await window.electronAPI.agent.fork(snapshot.id);
      setSelectedId(child.id);
      const [list, replay] = await Promise.all([
        window.electronAPI.agent.sessions(),
        window.electronAPI.agent.replay(child.id, 0),
      ]);
      setSessions([...list].sort((a, b) => b.updatedAt - a.updatedAt));
      setSnapshot(child);
      setEvents(replay.slice(-100).reverse());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not fork this session.');
    } finally {
      setAction('');
    }
  };

  const togglePluginTool = async (tool: RegisteredToolInfo) => {
    if (tool.source !== 'plugin') return;
    setToolAction(tool.name);
    setError('');
    try {
      await window.electronAPI.agent.tools.setEnabled(tool.name, !tool.enabled);
      setTools(await window.electronAPI.agent.tools.list());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update the plugin tool.');
    } finally {
      setToolAction('');
    }
  };

  const abortSession = async () => {
    if (!snapshot || !['running', 'aborting'].includes(snapshot.status)) return;
    setAction('abort');
    setError('');
    try {
      await window.electronAPI.agent.abort(snapshot.id);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not stop this session.');
    } finally {
      setAction('');
    }
  };

  if (!open) return null;
  const active = snapshot;
  const running = active?.status === 'running' || active?.status === 'aborting';

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto overscroll-contain bg-[rgba(52,38,24,0.22)] p-5" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="holo-panel flex max-h-[88vh] w-[66rem] max-w-[96vw] flex-col overflow-hidden" role="dialog" aria-modal="true" aria-label="Agent runtime">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-hairline px-6 py-5">
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[.16em] text-clay">Cline + OpenCode architecture</p>
            <h2 className="holo-title">Agent runtime</h2>
            <p className="mt-1 text-[12.5px] text-muted">Persistent sessions, lifecycle events, cancellation and session forks</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close agent runtime" className="holo-close grid h-8 w-8 place-items-center">×</button>
        </header>

        <nav className="flex shrink-0 gap-1 border-b border-hairline px-5 py-2" aria-label="Agent runtime views">
          {(['sessions', 'tools', 'plugins'] as const).map((item) => (
            <button key={item} type="button" onClick={() => setView(item)} aria-current={view === item ? 'page' : undefined} className={`rounded-lg px-3 py-2 text-[11.5px] font-medium capitalize transition-colors ${view === item ? 'bg-paper text-ink' : 'text-faint hover:bg-paper/70 hover:text-body'}`}>
              {item}{item === 'tools' ? ` · ${tools.length}` : item === 'plugins' ? ` · ${plugins.length}` : ` · ${sessions.length}`}
            </button>
          ))}
        </nav>
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[260px_minmax(0,1fr)]">
          <aside className="min-h-0 overflow-y-auto border-b border-hairline bg-paper/70 p-4 md:border-b-0 md:border-r">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-[11px] font-semibold uppercase tracking-[.12em] text-faint">Sessions</h3>
              <span className="font-mono text-[11px] text-faint">{sessions.length}</span>
            </div>
            {sessions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-line px-3 py-5 text-center">
                <p className="text-[13px] font-medium text-ink">No agent sessions yet</p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-faint">Start a conversation in Assistant. Each chat is backed by a persistent runtime session.</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {sessions.map((item) => (
                  <button key={item.id} type="button" onClick={() => void selectSession(item.id)} className={`w-full rounded-xl border px-3 py-2.5 text-left transition-colors ${selectedId === item.id ? 'border-sand bg-surface shadow-sm' : 'border-transparent hover:border-line hover:bg-surface/70'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[12.5px] font-medium text-ink">{shortId(item.id)}</span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide ${statusTone[item.status] ?? statusTone.idle}`}>{item.status}</span>
                    </div>
                    <p className="mt-1 text-[10.5px] text-faint">{item.turnCount} turns · {stamp(item.updatedAt)}</p>
                  </button>
                ))}
              </div>
            )}
            <button type="button" onClick={() => void refresh()} disabled={loading} className="mt-3 w-full rounded-lg border border-line px-3 py-2 text-[11.5px] font-medium text-body hover:bg-surface disabled:opacity-50">{loading ? 'Refreshing…' : 'Refresh sessions'}</button>
          </aside>

          <main className="min-h-0 overflow-y-auto p-5 md:p-6">
            {error && <p role="alert" className="mb-4 rounded-lg border border-[#E7C7BD] bg-[#FBF0ED] px-3 py-2 text-[12px] text-[#9A4D3D]">{error}</p>}
            {view === 'sessions' ? (!active ? (
              <div className="grid min-h-[300px] place-items-center text-center">
                <div><p className="text-[14px] font-medium text-ink">{loading ? 'Loading runtime…' : 'Select a session'}</p><p className="mt-1 text-[12px] text-faint">The selected session snapshot and event history appear here.</p></div>
              </div>
            ) : (
              <div className="space-y-5">
                <section className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[10px] font-semibold uppercase tracking-[.12em] text-faint">Selected session</p>
                    <h3 className="mt-1 break-all font-mono text-[12px] text-ink">{active.id}</h3>
                    <p className="mt-1 text-[11.5px] text-faint">Created {stamp(active.createdAt)} · Updated {stamp(active.updatedAt)}</p>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => void forkSession()} disabled={!!action || !active} className="rounded-lg border border-line px-3 py-2 text-[11.5px] font-medium text-body hover:bg-paper disabled:opacity-50">{action === 'fork' ? 'Forking…' : 'Fork session'}</button>
                    {running && <button type="button" onClick={() => void abortSession()} disabled={!!action} className="rounded-lg border border-[#E7C7BD] bg-[#FBF0ED] px-3 py-2 text-[11.5px] font-semibold text-[#9A4D3D] hover:bg-[#F7E5E1] disabled:opacity-50">{action === 'abort' ? 'Stopping…' : 'Stop run'}</button>}
                  </div>
                </section>

                <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div className="rounded-xl bg-paper p-3"><p className="text-[10px] uppercase tracking-wide text-faint">Status</p><p className="mt-1 text-[13px] font-semibold capitalize text-ink">{active.status}</p></div>
                  <div className="rounded-xl bg-paper p-3"><p className="text-[10px] uppercase tracking-wide text-faint">Turns</p><p className="mt-1 text-[13px] font-semibold tabular-nums text-ink">{active.turnCount}</p></div>
                  <div className="rounded-xl bg-paper p-3"><p className="text-[10px] uppercase tracking-wide text-faint">Iteration</p><p className="mt-1 text-[13px] font-semibold tabular-nums text-ink">{active.iteration}</p></div>
                  <div className="rounded-xl bg-paper p-3"><p className="text-[10px] uppercase tracking-wide text-faint">Pending tools</p><p className="mt-1 text-[13px] font-semibold tabular-nums text-ink">{active.pendingToolCalls.length}</p></div>
                </section>

                {active.parentSessionId && <p className="text-[11.5px] text-faint">Forked from <span className="font-mono text-body">{shortId(active.parentSessionId)}</span></p>}
                {active.pendingToolCalls.length > 0 && <section><h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">Pending tool calls</h4><div className="flex flex-wrap gap-1.5">{active.pendingToolCalls.map((tool, index) => <span key={tool + index} className="rounded-md bg-paper px-2 py-1 font-mono text-[10.5px] text-body">{tool}</span>)}</div></section>}
                {active.lastError && <section><h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">Last error</h4><p className="rounded-lg bg-[#FBF0ED] p-3 text-[12px] text-[#9A4D3D]">{active.lastError}</p></section>}
                {active.lastOutput && <section><h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">Last output</h4><p className="whitespace-pre-wrap break-words rounded-lg bg-paper p-3 text-[12px] leading-relaxed text-body">{active.lastOutput}</p></section>}

                <section>
                  <div className="mb-2 flex items-center justify-between"><h4 className="text-[11px] font-semibold uppercase tracking-wide text-faint">Lifecycle event replay</h4><span className="font-mono text-[10px] text-faint">{events.length} events</span></div>
                  {events.length === 0 ? <p className="rounded-lg border border-dashed border-line p-4 text-[12px] text-faint">No lifecycle events recorded for this session yet.</p> : (
                    <ol className="space-y-0 border-l border-line pl-4">
                      {events.map((event) => (
                        <li key={event.eventId} className="relative border-b border-line/50 py-2.5 last:border-0">
                          <span className="absolute -left-[21px] top-4 h-2 w-2 rounded-full bg-clay" />
                          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1"><span className="text-[12px] font-medium text-ink">{eventTitle(event)}</span><span className="font-mono text-[10px] text-faint">#{event.sequence} · {stamp(event.at)}</span><span className="text-[10px] text-muted">{event.status}</span></div>
                          {(event.tool || event.round !== undefined) && <p className="mt-0.5 font-mono text-[10.5px] text-body">{[event.tool, event.round !== undefined ? 'round ' + event.round : ''].filter(Boolean).join(' · ')}</p>}
                          {event.text && <p className="mt-1 whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-muted">{event.text.slice(0, 280)}</p>}
                          {event.error && <p className="mt-1 text-[11.5px] text-[#9A4D3D]">{event.error}</p>}
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              </div>
            )) : view === 'tools' ? (
              <section className="space-y-4">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div><h3 className="text-[15px] font-semibold text-ink">Registered tools</h3><p className="mt-1 text-[12px] text-muted">The live registry used by JINI’s guarded tool dispatcher.</p></div>
                  <span className="font-mono text-[11px] text-faint">{tools.filter((tool) => tool.enabled).length} enabled / {tools.length} total</span>
                </div>
                <input value={toolFilter} onChange={(event) => setToolFilter(event.target.value)} placeholder="Filter tools by name, description, plugin…" aria-label="Filter registered tools" className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-[12px] text-ink outline-none focus:border-sand" />
                <div className="overflow-hidden rounded-xl border border-line">
                  <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_80px_70px] gap-3 border-b border-line bg-paper px-3 py-2 text-[9.5px] font-semibold uppercase tracking-wide text-faint">
                    <span>Tool</span><span>Description</span><span>Policy</span><span>Source</span>
                  </div>
                  <div className="max-h-[52vh] overflow-y-auto">
                    {tools.filter((tool) => `${tool.name} ${tool.description} ${tool.pluginId ?? ''}`.toLowerCase().includes(toolFilter.trim().toLowerCase())).map((tool) => (
                      <div key={tool.name} className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_80px_70px] gap-3 border-b border-line/50 px-3 py-2.5 last:border-0">
                        <div className="min-w-0"><p className="break-all font-mono text-[10.5px] text-ink">{tool.name}</p><p className={`mt-1 text-[9.5px] ${tool.enabled ? 'text-[#55734F]' : 'text-[#9A4D3D]'}`}>{tool.enabled ? 'Enabled' : 'Disabled'}</p></div>
                        <p className="line-clamp-2 text-[10.5px] leading-relaxed text-muted">{tool.description}</p>
                        <div className="space-y-1"><span className="inline-block rounded-md bg-paper px-1.5 py-0.5 text-[9.5px] text-body">{tool.action ?? 'policy gate'}</span>{tool.parallelSafe && <p className="text-[9px] text-faint">Parallel-safe</p>}</div>
                        <div><span className="text-[10px] capitalize text-muted">{tool.source}</span>{tool.pluginId && <p className="mt-1 break-all text-[9px] text-faint">{tool.pluginId}</p>}{tool.source === 'plugin' && <button type="button" disabled={toolAction === tool.name} onClick={() => void togglePluginTool(tool)} className="mt-1 rounded-md border border-line px-2 py-1 text-[9px] font-medium text-body disabled:opacity-50">{toolAction === tool.name ? 'Saving…' : tool.enabled ? 'Disable' : 'Enable'}</button>}</div>
                      </div>
                    ))}
                    {tools.filter((tool) => `${tool.name} ${tool.description} ${tool.pluginId ?? ''}`.toLowerCase().includes(toolFilter.trim().toLowerCase())).length === 0 && <p className="p-6 text-center text-[12px] text-faint">No tools match this filter.</p>}
                  </div>
                </div>
              </section>
            ) : (
              <section className="space-y-4">
                <div><h3 className="text-[15px] font-semibold text-ink">Installed plugins</h3><p className="mt-1 text-[12px] text-muted">Plugin registrations and the tools contributed to the shared runtime registry.</p></div>
                {plugins.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-line p-7 text-center"><p className="text-[13px] font-medium text-ink">No plugins registered</p><p className="mt-1 text-[11.5px] text-faint">Built-in tools remain available independently of plugins.</p></div>
                ) : (
                  <div className="space-y-2">
                    {plugins.map((plugin) => {
                      const contributed = tools.filter((tool) => tool.pluginId === plugin.id);
                      return <article key={plugin.id} className="rounded-xl border border-line bg-surface p-4"><div className="flex items-center justify-between gap-3"><h4 className="font-mono text-[12px] font-semibold text-ink">{plugin.id}</h4><span className="rounded-full bg-[#E8F0E5] px-2 py-1 text-[9.5px] font-semibold text-[#496746]">Registered</span></div><p className="mt-1 text-[11px] text-muted">{contributed.length} contributed tool{contributed.length === 1 ? '' : 's'}</p>{contributed.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{contributed.map((tool) => <span key={tool.name} className="rounded-md bg-paper px-2 py-1 font-mono text-[10px] text-body">{tool.name}</span>)}</div>}</article>;
                    })}
                  </div>
                )}
              </section>
            )}
          </main>
        </div>
      </section>
    </div>
  );
}
