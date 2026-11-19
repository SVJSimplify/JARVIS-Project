import { useCallback, useEffect, useRef, useState } from 'react';
import { Empty, ScreenHeader, ago } from '../components/ui';
import { rpc } from '../lib/linkClient';
import { useAppState } from '../lib/store';

type Status = 'idle' | 'running' | 'aborting' | 'completed' | 'failed' | 'aborted' | 'interrupted';
interface Session {
  id: string;
  parentSessionId?: string;
  status: Status;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  iteration: number;
  pendingToolCalls: string[];
  lastOutput?: string;
  lastError?: string;
}
interface RuntimeEvent {
  eventId: string;
  sequence: number;
  type: string;
  sessionId: string;
  at: number;
  status: Status;
  text?: string;
  error?: string;
  round?: number;
  tool?: string;
}
interface ToolInfo {
  name: string;
  description: string;
  source: 'builtin' | 'plugin';
  pluginId?: string;
  enabled: boolean;
  parallelSafe: boolean;
  action?: string;
}
interface PluginInfo { id: string }

const statusClass = (status: string) => {
  if (status === 'running') return 'bg-[#E8F0E5] text-[#496746]';
  if (status === 'aborting' || status === 'interrupted') return 'bg-[#F6EAD9] text-[#94632C]';
  if (status === 'failed') return 'bg-[#F7E5E1] text-[#A34E3D]';
  return 'bg-oat text-muted';
};

export default function AgentsScreen() {
  const online = useAppState((state) => state.connection === 'online');
  const [view, setView] = useState<'sessions' | 'tools' | 'plugins'>('sessions');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState('');
  const [snapshot, setSnapshot] = useState<Session | null>(null);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState('');
  const [error, setError] = useState('');
  const loadingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setBusy(true);
    try {
      const [list, toolList, pluginList] = await Promise.all([
        rpc<Session[]>('agents.sessions'),
        rpc<ToolInfo[]>('agents.tools'),
        rpc<PluginInfo[]>('agents.plugins'),
      ]);
      const ordered = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
      setSessions(ordered);
      setTools(toolList);
      setPlugins(pluginList);
      const id = selected && ordered.some((item) => item.id === selected) ? selected : ordered[0]?.id ?? '';
      if (!id) {
        setSelected('');
        setSnapshot(null);
        setEvents([]);
      } else {
        setSelected(id);
        const [next, replay] = await Promise.all([
          rpc<Session>('agents.snapshot', { id }),
          rpc<RuntimeEvent[]>('agents.replay', { id, afterSequence: 0 }),
        ]);
        setSnapshot(next);
        setEvents(replay.slice(-80).reverse());
      }
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load agent runtime.');
    } finally {
      loadingRef.current = false;
      setBusy(false);
    }
  }, [selected]);

  useEffect(() => {
    if (!online) return;
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh, view, online]);

  const selectSession = async (id: string) => {
    setSelected(id);
    setBusy(true);
    setError('');
    try {
      const [next, replay] = await Promise.all([
        rpc<Session>('agents.snapshot', { id }),
        rpc<RuntimeEvent[]>('agents.replay', { id, afterSequence: 0 }),
      ]);
      setSnapshot(next);
      setEvents(replay.slice(-80).reverse());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not inspect this session.');
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!snapshot) return;
    setAction('stop');
    try {
      await rpc<boolean>('agents.abort', { id: snapshot.id });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not stop this session.');
    } finally {
      setAction('');
    }
  };

  const fork = async () => {
    if (!snapshot) return;
    setAction('fork');
    try {
      const child = await rpc<Session>('agents.fork', { id: snapshot.id });
      setSelected(child.id);
      const [list, replay] = await Promise.all([
        rpc<Session[]>('agents.sessions'),
        rpc<RuntimeEvent[]>('agents.replay', { id: child.id, afterSequence: 0 }),
      ]);
      setSessions([...list].sort((a, b) => b.updatedAt - a.updatedAt));
      setSnapshot(child);
      setEvents(replay);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not fork this session.');
    } finally {
      setAction('');
    }
  };

  return (
    <div className="pb-8">
      <ScreenHeader title="Agent runtime" action={<button className="btn-text pb-1 text-[13px]" disabled={busy || !online} onClick={() => void refresh()}>{busy ? 'Loading…' : online ? 'Refresh' : 'Offline'}</button>} />
      <p className="px-1 text-meta text-faint">Cline + OpenCode architecture · live from your desktop</p>
      <div className="mt-4 flex gap-1 rounded-xl bg-oat p-1">
        {(['sessions', 'tools', 'plugins'] as const).map((item) => (
          <button key={item} onClick={() => setView(item)} className={'flex-1 rounded-lg px-2 py-2 text-[12px] font-medium capitalize ' + (view === item ? 'bg-surface text-text shadow-sm' : 'text-faint')}>{item}</button>
        ))}
      </div>
      {!online && <p className="mt-3 rounded-xl bg-oat p-3 text-[11px] text-muted">Connect to your desktop to inspect live agent sessions, tools and plugins.</p>}
      {error && <p role="alert" className="mt-3 rounded-xl border border-[#E7C7BD] bg-[#FBF0ED] p-3 text-[12px] text-[#9A4D3D]">{error}</p>}

      {view === 'sessions' && (
        <>
          {!sessions.length ? <Empty title="No agent sessions yet" hint="Start a conversation on desktop. Its persistent runtime session will appear here." /> : (
            <div className="mt-4 space-y-2">
              {sessions.map((session) => (
                <button key={session.id} onClick={() => void selectSession(session.id)} className={'w-full rounded-xl border p-3 text-left ' + (selected === session.id ? 'border-sand bg-surface' : 'border-hairline bg-surface/70')}>
                  <div className="flex items-center justify-between gap-2"><span className="truncate font-mono text-[11px] text-text">{session.id}</span><span className={'rounded-full px-2 py-1 text-[9px] font-semibold uppercase ' + statusClass(session.status)}>{session.status}</span></div>
                  <p className="mt-1 text-meta text-faint">{session.turnCount} turns · {ago(session.updatedAt)}</p>
                </button>
              ))}
            </div>
          )}
          {snapshot && (
            <section className="mt-4 rounded-2xl border border-hairline bg-surface p-4">
              <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-wider text-faint">Selected session</p><p className="mt-1 break-all font-mono text-[11px] text-text">{snapshot.id}</p><p className="mt-1 text-meta text-faint">Created {ago(snapshot.createdAt)} · updated {ago(snapshot.updatedAt)}</p></div><div className="flex shrink-0 gap-2"><button onClick={() => void fork()} disabled={!!action} className="rounded-lg border border-hairline px-2.5 py-2 text-[11px] text-body disabled:opacity-50">{action === 'fork' ? 'Forking…' : 'Fork'}</button>{(snapshot.status === 'running' || snapshot.status === 'aborting') && <button onClick={() => void stop()} disabled={!!action} className="rounded-lg border border-[#E7C7BD] bg-[#FBF0ED] px-2.5 py-2 text-[11px] text-[#9A4D3D] disabled:opacity-50">{action === 'stop' ? 'Stopping…' : 'Stop'}</button>}</div></div>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <Metric label="Status" value={snapshot.status} />
                <Metric label="Turns" value={String(snapshot.turnCount)} />
                <Metric label="Iteration" value={String(snapshot.iteration)} />
                <Metric label="Pending tools" value={String(snapshot.pendingToolCalls.length)} />
              </div>
              {snapshot.parentSessionId && <p className="mt-3 text-meta text-faint">Forked from <span className="font-mono text-body">{snapshot.parentSessionId}</span></p>}
              {snapshot.pendingToolCalls.length > 0 && <p className="mt-3 break-words text-[11px] text-body">Running: {snapshot.pendingToolCalls.join(', ')}</p>}
              {snapshot.lastError && <p className="mt-3 rounded-lg bg-[#FBF0ED] p-3 text-[11px] text-[#9A4D3D]">{snapshot.lastError}</p>}
              {snapshot.lastOutput && <div className="mt-3"><p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-faint">Last output</p><p className="whitespace-pre-wrap break-words rounded-lg bg-oat p-3 text-[11px] leading-relaxed text-body">{snapshot.lastOutput}</p></div>}
            </section>
          )}
          {snapshot && <section className="mt-4"><div className="mb-2 flex items-center justify-between"><h3 className="text-[11px] font-semibold uppercase tracking-wide text-faint">Lifecycle events</h3><span className="font-mono text-[10px] text-faint">{events.length}</span></div>{events.length ? <ol className="space-y-0 border-l border-hairline pl-4">{events.map((event) => <li key={event.eventId} className="relative border-b border-hairline py-2.5 last:border-0"><span className="absolute -left-[21px] top-4 h-2 w-2 rounded-full bg-clay" /><p className="text-[11px] font-medium text-text">{event.type.replace(/-/g, ' ')} <span className="font-mono text-[9px] text-faint">#{event.sequence} · {ago(event.at)}</span></p>{(event.tool || event.text || event.error) && <p className="mt-1 break-words text-[10.5px] text-muted">{[event.tool, event.text, event.error].filter(Boolean).join(' · ').slice(0, 220)}</p>}</li>)}</ol> : <p className="rounded-lg border border-dashed border-hairline p-4 text-[11px] text-faint">No events recorded yet.</p>}</section>}
        </>
      )}

      {view === 'tools' && (
        <section className="mt-4">
          <div className="mb-2 flex items-center justify-between"><h3 className="text-[14px] font-semibold text-text">Registered tools</h3><span className="text-meta text-faint">{tools.filter((tool) => tool.enabled).length} enabled / {tools.length}</span></div>
          {tools.map((tool) => <article key={tool.name} className="mb-2 rounded-xl border border-hairline bg-surface p-3"><div className="flex items-center justify-between gap-2"><p className="break-all font-mono text-[11px] text-text">{tool.name}</p><span className={'text-[9px] font-semibold ' + (tool.enabled ? 'text-[#55734F]' : 'text-[#9A4D3D]')}>{tool.enabled ? 'ENABLED' : 'DISABLED'}</span></div><p className="mt-1 text-[11px] leading-relaxed text-muted">{tool.description}</p><p className="mt-2 text-[10px] text-faint">Policy: {tool.action ?? 'policy gate'} · {tool.parallelSafe ? 'parallel-safe' : 'sequential'} · {tool.pluginId ?? tool.source}</p></article>)}
          {!tools.length && <Empty title="No registered tools" hint="The desktop registry will appear here when connected." />}
        </section>
      )}

      {view === 'plugins' && (
        <section className="mt-4">
          <h3 className="mb-2 text-[14px] font-semibold text-text">Registered plugins</h3>
          {plugins.map((plugin) => {
            const contributed = tools.filter((tool) => tool.pluginId === plugin.id);
            return <article key={plugin.id} className="mb-2 rounded-xl border border-hairline bg-surface p-3"><p className="font-mono text-[12px] font-semibold text-text">{plugin.id}</p><p className="mt-1 text-meta text-muted">{contributed.length} contributed tools</p>{contributed.map((tool) => <p key={tool.name} className="mt-1 break-all font-mono text-[10px] text-faint">{tool.name}</p>)}</article>;
          })}
          {!plugins.length && <Empty title="No plugins registered" hint="Built-in tools work independently of plugins." />}
        </section>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-oat p-3"><p className="text-[9px] uppercase tracking-wide text-faint">{label}</p><p className="mt-1 break-words text-[12px] font-semibold capitalize text-text">{value}</p></div>;
}
