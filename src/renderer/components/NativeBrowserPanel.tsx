import { useCallback, useEffect, useState } from 'react';
import { popModal, pushModal } from '../lib/modalState';
import type { NativeBrowserStatusView } from '../../../src/main/nativeBrowser';

/**
 * NATIVE BROWSER MANAGEMENT (Round 28, Phase 2 §2.6) — the user-facing surface for
 * JARVIS's use of the REAL installed browser.
 *
 * What it shows (all of it real, projected from nativeBrowser.ts state — never invented):
 *   - the installed browsers discovered on this machine (Chrome / Edge / Chromium / custom);
 *   - the selected browser and the connection MODE (A: attach to your running session,
 *     B: JARVIS-managed dedicated profile) with an honest explanation of each;
 *   - the durable session identity and connection state, plus the last disconnect reason;
 *   - the open tabs (which ones JARVIS has attached to) and recent browser activity;
 *   - the browser visibility preference and the automatic-recovery switch (user control,
 *     never a hidden setting);
 *   - explicit Connect / Disconnect / Reconnect controls — the SAME authorized operations
 *     the agent's native_browser_* tools perform.
 *
 * It never displays cookies, tokens, passwords or sensitive session contents.
 */

const actionBtn =
  'no-drag rounded-sm border border-line px-3 py-1 font-display text-[12px] font-bold text-steel transition-colors hover:border-accent hover:text-accent disabled:opacity-40 disabled:hover:border-line disabled:hover:text-steel';
const primaryBtn =
  'no-drag rounded-sm border border-accent/60 px-3 py-1 font-display text-[12px] font-bold text-accent transition-colors hover:bg-accent hover:text-[#FBF8F2] disabled:opacity-40';
const inputCls =
  'no-drag rounded-sm border border-line bg-[rgba(251,248,242,0.6)] px-2 py-1 font-mono text-[12px] text-[#1F1B16] outline-none focus:border-accent/60';

const stamp = (t: number | undefined): string => {
  if (!t) return '—';
  const d = new Date(t);
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5 rounded-sm border border-line/60 px-3 py-2">
      <h3 className="font-display text-[12px] font-bold text-steel">{title}</h3>
      {children}
    </div>
  );
}

export default function NativeBrowserPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = useState<NativeBrowserStatusView | null>(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);
  const [attachPort, setAttachPort] = useState('');

  const refresh = useCallback(async () => {
    try {
      const v = (await window.electronAPI.nativeBrowser.status()) as NativeBrowserStatusView;
      setData(v);
      setAttachPort((p) => p || (v.config.attachPort ? String(v.config.attachPort) : ''));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    pushModal();
    void refresh();
    const iv = setInterval(() => void refresh(), 4000);
    return () => {
      clearInterval(iv);
      popModal();
    };
  }, [open, refresh]);

  const act = async (fn: () => Promise<unknown>, okMsg?: (v: unknown) => string) => {
    setBusy(true);
    setError('');
    try {
      const v = await fn();
      setFlash(okMsg ? okMsg(v) : 'Done.');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setTimeout(() => setFlash(''), 6000);
    }
  };

  // Closed panels render nothing (like every other panel). Without this guard the panel was
  // always drawn as a full-screen overlay that never loaded and blocked the whole window.
  if (!open) return null;

  const connected = data?.session?.status === 'connected';
  const mode = data?.session?.mode ?? data?.config.mode ?? 'B';

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(52,38,24,0.22)]" onClick={onClose}>
      <div className="holo-panel no-drag relative z-10 flex max-h-[86vh] w-full max-w-[720px] flex-col overflow-hidden rounded-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-accent/20 px-5 pb-2 pt-3">
          <h2 className="font-display text-[12px] font-bold text-accent/90">Native Browser</h2>
          <button type="button" onClick={onClose} aria-label="Close native browser panel" className="no-drag grid h-7 w-7 place-items-center text-steel transition-colors hover:text-accent">
            ✕
          </button>
        </div>

        <div className="space-y-3 overflow-y-auto px-5 py-4">
          {error && <p className="rounded-sm border border-hot/50 px-3 py-2 font-mono text-[12px] text-hot">{error}</p>}
          {flash && <p className="rounded-sm border border-accent/40 px-3 py-2 font-mono text-[12px] text-accent">{flash}</p>}
          {!data && <p className="py-4 text-[12px] text-steel">Loading browser state…</p>}

          {data && (
            <>
              {/* Connection state — the honest headline */}
              <Section title="Connection">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className={`font-mono text-[12px] ${connected ? 'text-[#4F7F55]' : data?.session?.status === 'connecting' ? 'text-[#A86E1A]' : 'text-steel'}`}>
                    {data.session ? data.session.status.toUpperCase() : 'DISCONNECTED'}
                  </span>
                  {data.session && (
                    <>
                      <span className="font-mono text-[12px] text-steel">session {data.session.sessionId}</span>
                      <span className="font-mono text-[12px] text-steel">{data.session.browserName}</span>
                      <span className="font-mono text-[12px] text-steel">mode {data.session.mode}</span>
                      {data.session.port ? <span className="font-mono text-[12px] text-steel">127.0.0.1:{data.session.port}</span> : null}
                      {data.session.recovered ? <span className="font-mono text-[12px] text-[#4F7F55]">recovered</span> : null}
                    </>
                  )}
                  {data.session?.disconnectReason && <span className="font-mono text-[12px] text-hot">last disconnect: {data.session.disconnectReason}</span>}
                  {data.session?.lastError && <span className="font-mono text-[12px] text-hot">last error: {data.session.lastError}</span>}
                </div>
                <p className="font-mono text-[12px] leading-relaxed text-steel/80">
                  {mode === 'A'
                    ? 'Mode A — attach: JINI works inside YOUR running browser session (its tabs, its sign-ins). It only creates background tabs unless you ask otherwise.'
                    : 'Mode B — managed: JINI uses your real installed browser with a DEDICATED JINI profile (separate from your own). Sign in once inside it; the sign-in persists.'}
                </p>
                <div className="flex flex-wrap gap-2 pt-1">
                  {!connected && (
                    <button type="button" className={primaryBtn} disabled={busy} onClick={() => act(() => window.electronAPI.nativeBrowser.connect({ mode, port: attachPort ? Number(attachPort) : undefined }), () => 'Connected to your browser.')}>
                      Connect ({mode === 'A' ? 'attach' : 'managed'})
                    </button>
                  )}
                  {connected && (
                    <button type="button" className={actionBtn} disabled={busy} onClick={() => act(() => window.electronAPI.nativeBrowser.disconnect(), () => 'Disconnected.')}>
                      Disconnect
                    </button>
                  )}
                  {!connected && data.session?.mode === 'B' && (
                    <button type="button" className={actionBtn} disabled={busy} onClick={() => act(() => window.electronAPI.nativeBrowser.reconnect(), () => 'Reconnect attempted.')}>
                      Reconnect (managed)
                    </button>
                  )}
                </div>
              </Section>

              {/* Installed browsers — real discovery */}
              <Section title="Installed browsers">
                {data.installed.length === 0 && <p className="font-mono text-[12px] text-steel">No Chromium-family browsers detected. Install Chrome or Edge, or set a custom path.</p>}
                {data.installed.map((b) => (
                  <div key={b.id} className="flex items-center gap-2">
                    <span className={`font-mono text-[12px] ${b.found ? 'text-[#4F7F55]' : 'text-steel/50'}`}>{b.found ? '✓' : '✗'}</span>
                    <span className="font-mono text-[12px] text-[#1F1B16]">{b.name}</span>
                    <span className="truncate font-mono text-[12px] text-steel/60" title={b.executable}>{b.executable}</span>
                    <button
                      type="button"
                      className={`${actionBtn} ml-auto shrink-0`}
                      disabled={busy || !b.found}
                      onClick={() => act(() => window.electronAPI.nativeBrowser.setConfig({ selectedBrowser: b.id }), () => `${b.name} selected.`)}
                    >
                      {data.config.selectedBrowser === b.id ? 'selected' : 'select'}
                    </button>
                  </div>
                ))}
              </Section>

              {/* Mode + preferences — explicit, user-controlled, never hidden */}
              <Section title="Mode & preferences">
                <div className="flex flex-wrap items-center gap-2">
                  {(['B', 'A'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`${actionBtn} ${((data.session?.mode ?? data.config.mode) === m) ? 'border-accent text-accent' : ''}`}
                      disabled={busy || connected}
                      onClick={() => act(() => window.electronAPI.nativeBrowser.setConfig({ mode: m }), () => `Default mode set to ${m}.`)}
                    >
                      Mode {m} ({m === 'A' ? 'attach to running' : 'managed profile'})
                    </button>
                  ))}
                </div>
                {mode === 'A' && (
                  <div className="flex items-center gap-2 pt-1">
                    <label htmlFor="nb-port" className="font-mono text-[12px] text-steel">debugging port</label>
                    <input id="nb-port" className={`${inputCls} w-28`} value={attachPort} placeholder="e.g. 9222" inputMode="numeric" onChange={(e) => setAttachPort(e.target.value.replace(/[^0-9]/g, ''))} />
                    <button type="button" className={actionBtn} disabled={busy || !attachPort} onClick={() => act(() => window.electronAPI.nativeBrowser.setConfig({ attachPort: Number(attachPort) }), () => 'Port saved.')}>
                      save port
                    </button>
                  </div>
                )}
                {mode === 'A' && (
                  <p className="font-mono text-[12px] leading-relaxed text-steel/80">
                    Start your browser yourself with <span className="text-steel">--remote-debugging-port=&lt;port&gt;</span> (recent Chrome also needs a separate
                    {' '}<span className="text-steel">--user-data-dir</span>). JINI never turns debugging on for you and never reads your profile files — it only connects
                    to the port you configured, on 127.0.0.1, after you press Connect.
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <label htmlFor="nb-vis" className="font-mono text-[12px] text-steel">browser window</label>
                  <select
                    id="nb-vis"
                    className={`${inputCls} w-40`}
                    value={data.config.visibility}
                    onChange={(e) => act(() => window.electronAPI.nativeBrowser.setConfig({ visibility: e.target.value as 'normal' | 'minimized' }), () => 'Visibility preference saved.')}
                  >
                    <option value="normal">visible (normal window)</option>
                    <option value="minimized">start minimized (best effort)</option>
                  </select>
                  <label className="ml-2 flex items-center gap-1 font-mono text-[12px] text-steel" title="The supervisor may relaunch the managed browser if its connection drops. Mode A is never re-attached automatically.">
                    <input
                      type="checkbox"
                      checked={data.config.autoReconnect}
                      onChange={(e) => act(() => window.electronAPI.nativeBrowser.setConfig({ autoReconnect: e.target.checked }), () => `Automatic recovery ${e.target.checked ? 'enabled' : 'disabled'}.`)}
                    />
                    auto-reconnect managed browser
                  </label>
                  <label className="ml-2 flex items-center gap-1 font-mono text-[12px] text-steel" title="When JINI quits, leave the managed browser running.">
                    <input
                      type="checkbox"
                      checked={data.config.keepOpenOnQuit}
                      onChange={(e) => act(() => window.electronAPI.nativeBrowser.setConfig({ keepOpenOnQuit: e.target.checked }), () => `Browser ${e.target.checked ? 'stays open' : 'closes'} when JINI quits.`)}
                    />
                    keep open on quit
                  </label>
                </div>
              </Section>

              {/* Downloads — honest readiness + lifecycle (Round 29 §1.2/§2.4) */}
              <Section title="Downloads">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  {connected ? (
                    data.session?.downloadsReady ? (
                      <span className="font-mono text-[12px] text-[#4F7F55]">✓ ready → {data.downloadDir}</span>
                    ) : (
                      <span className="font-mono text-[12px] text-hot" title={data.session?.downloadError}>✗ NOT READY — {data.session?.downloadError ?? 'configuration failed'}</span>
                    )
                  ) : (
                    <span className="font-mono text-[12px] text-steel">— (no session)</span>
                  )}
                </div>
                {data.downloads.length === 0 && <p className="font-mono text-[12px] text-steel/60">No downloads this session.</p>}
                {data.downloads.slice(0, 6).map((d) => (
                  <div key={d.guid || `${d.at}`} className="flex items-baseline gap-2">
                    <span className={`shrink-0 font-mono text-[12px] ${d.state === 'completed' ? 'text-[#4F7F55]' : d.state === 'in-progress' ? 'text-accent' : 'text-hot'}`}>{d.state}</span>
                    <span className="truncate font-mono text-[12px] text-[#1F1B16]">{d.fileName}</span>
                    {d.path && <span className="truncate font-mono text-[12px] text-steel/60" title={d.path}>{d.path}</span>}
                  </div>
                ))}
                {data.downloads.some((d) => d.state === 'canceled') && (
                  <p className="font-mono text-[12px] text-hot/80">A download was interrupted or canceled — it did NOT complete; re-trigger it if the file is needed.</p>
                )}
              </Section>

              {/* Tabs */}
              <Section title={`Open tabs (${data.tabs.length})`}>
                {data.tabs.length === 0 && <p className="font-mono text-[12px] text-steel">{connected ? 'No tabs open.' : 'Connect first to see tabs.'}</p>}
                {data.tabs.map((t) => (
                  <div key={t.tabId} className="flex items-baseline gap-2">
                    <span className={`shrink-0 font-mono text-[12px] ${t.attached ? 'text-accent' : 'text-steel/50'}`}>{t.attached ? '•' : '○'}</span>
                    <span className="truncate font-mono text-[12px] text-[#1F1B16]" title={t.url}>{t.title || t.url}</span>
                    {t.loading && <span className="shrink-0 font-mono text-[12px] text-[#A86E1A]">loading…</span>}
                    <span className="shrink-0 font-mono text-[12px] text-steel/60">{t.attached ? 'JINI attached' : 'idle'}</span>
                    <button type="button" className={`${actionBtn} ml-auto shrink-0`} disabled={busy} onClick={() => act(() => window.electronAPI.nativeBrowser.activateTab(t.tabId), () => 'Tab brought to front (your explicit request).')}>
                      focus
                    </button>
                  </div>
                ))}
                <p className="font-mono text-[12px] text-steel/60">• = a tab JINI has attached to. JINI opens BACKGROUND tabs — focus happens only via this button or your explicit request.</p>
              </Section>

              {/* Activity + downloads */}
              <Section title="Recent browser activity">
                {data.activity.length === 0 && <p className="font-mono text-[12px] text-steel">Nothing yet this run.</p>}
                {data.activity.slice(0, 8).map((a, i) => (
                  <p key={`${a.at}-${i}`} className={`font-mono text-[12px] ${a.action.includes('NOT') || a.action.includes('fail') || a.action.includes('disconnected') ? 'text-hot/90' : 'text-steel'}`}>
                    {stamp(a.at)} · {a.action}
                    {a.detail ? ` — ${a.detail}` : ''}
                  </p>
                ))}
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
