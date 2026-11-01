import type { Battery, HudAlert, Telemetry } from '../hooks/useTelemetry';

const GB = 1073741824;
const rate = (b: number): string => (b < 1024 ? `${Math.round(b)} B/s` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB/s` : `${(b / 1048576).toFixed(1)} MB/s`);

function Spark({ v, max }: { v: number[]; max: number }) {
  const m = Math.max(max, 1);
  const d = v.length < 2 ? '' : v.map((y, i) => `${i ? 'L' : 'M'}${((i / (v.length - 1)) * 200).toFixed(1)},${(28 - Math.min(1, y / m) * 28).toFixed(1)}`).join(' ');
  return (
    <svg viewBox="0 0 200 28" preserveAspectRatio="none" className="mt-1 h-6 w-full">
      <path d={d} fill="none" stroke="rgb(var(--accent))" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Row({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="flex items-baseline justify-between">
        <span className="font-display text-[11px] uppercase tracking-[0.22em] text-steel">{label}</span>
        <span className="font-mono text-[13px] tabular-nums text-hot">{value}</span>
      </div>
      {children}
    </div>
  );
}

interface Props { data: Telemetry | null; battery: Battery | null; online: boolean; alerts: HudAlert[] }

export default function SystemPanel({ data, battery, online, alerts }: Props) {
  return (
    <aside className="rail w-60">
      <h2 className="rail-title">System</h2>
      {!data ? (
        <p className="text-sm text-steel">Reading sensors…</p>
      ) : (
        <>
          <Row label="CPU" value={`${data.cpu}%`}><Spark v={data.cpuHist} max={100} /></Row>
          <Row label="Memory" value={`${(data.ram.used / GB).toFixed(1)} / ${(data.ram.total / GB).toFixed(0)} GB`}><Spark v={data.ramHist} max={100} /></Row>
          <Row label="Network" value={online ? `↓ ${rate(data.net.down)}  ↑ ${rate(data.net.up)}` : 'OFFLINE'}>
            <Spark v={data.net.downHist} max={Math.max(...data.net.downHist, 102400)} />
          </Row>
          <Row label="Battery" value={battery ? `${battery.pct}%${battery.charging ? ' charging' : ''}` : 'mains'} />
          <h3 className="mb-1 mt-4 font-display text-[11px] uppercase tracking-[0.22em] text-steel">Running</h3>
          <ul className="space-y-0.5 font-mono text-[12px] text-hot">
            {data.procs.slice(0, 5).map((p) => (
              <li key={p.name} className="flex justify-between gap-2">
                <span className="truncate">{p.name.replace(/\.exe$/i, '')}{p.n > 1 ? ` ×${p.n}` : ''}</span>
                <span className="shrink-0 text-steel">{p.mb} MB</span>
              </li>
            ))}
            {data.jobs.map((j) => (
              <li key={j} className="truncate text-accent">▸ {j}</li>
            ))}
          </ul>
        </>
      )}
      <h3 className="mb-1 mt-4 font-display text-[11px] uppercase tracking-[0.22em] text-steel">Alerts</h3>
      {alerts.length ? (
        <ul className="space-y-1 text-[12px]">
          {alerts.map((a) => (
            <li key={a.id} className={`flex gap-2 ${a.level === 'crit' ? 'animate-pulse text-hot' : 'text-accent'}`}>
              <span className="font-mono">{a.level === 'crit' ? '!!' : '!'}</span>
              <span>{a.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-steel">All systems nominal.</p>
      )}
    </aside>
  );
}
