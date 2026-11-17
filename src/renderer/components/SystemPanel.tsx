import type { ReactNode } from 'react';
import type { Battery, HudAlert, Telemetry } from '../hooks/useTelemetry';

const GB = 1073741824;
const rate = (b: number): string => (b < 1024 ? `${Math.round(b)} B/s` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB/s` : `${(b / 1048576).toFixed(1)} MB/s`);

/** Area sparkline: a quiet trend line with a soft fill, scaled to the tile. */
function Spark({ v, max }: { v: number[]; max: number }) {
  const m = Math.max(max, 1);
  if (v.length < 2) return <div className="h-7" />;
  const pts = v.map((y, i) => [(i / (v.length - 1)) * 100, 26 - Math.min(1, y / m) * 22]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return (
    <svg viewBox="0 0 100 28" preserveAspectRatio="none" className="mt-2 h-7 w-full" aria-hidden="true">
      <path d={`${line} L100,28 L0,28 Z`} fill="rgb(var(--accent) / 0.10)" />
      <path d={line} fill="none" stroke="rgb(var(--accent))" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

function Tile({ label, value, sub, children }: { label: string; value: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-hairline bg-surface px-3.5 pb-2.5 pt-3">
      <p className="text-[12px] text-faint">{label}</p>
      <p className="mt-0.5 text-[17px] font-semibold tabular-nums tracking-[-0.01em] text-ink">
        {value}
        {sub && <span className="ml-1 text-[12px] font-normal text-muted">{sub}</span>}
      </p>
      {children}
    </div>
  );
}

interface Props {
  data: Telemetry | null;
  battery: Battery | null;
  online: boolean;
  alerts: HudAlert[];
}

/** This computer at a glance: four metric tiles, the heaviest processes, and any alerts. */
export default function SystemPanel({ data, battery, online, alerts }: Props) {
  return (
    <section aria-label="System">
      <h2 className="mb-3 text-[13px] font-semibold text-ink">This computer</h2>
      {!data ? (
        <p className="text-[13px] text-faint">Reading sensors…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Tile label="CPU" value={`${data.cpu}%`}>
              <Spark v={data.cpuHist} max={100} />
            </Tile>
            <Tile label="Memory" value={(data.ram.used / GB).toFixed(1)} sub={`/ ${(data.ram.total / GB).toFixed(0)} GB`}>
              <Spark v={data.ramHist} max={100} />
            </Tile>
            <Tile label="Download" value={online ? rate(data.net.down) : 'Offline'}>
              <Spark v={data.net.downHist} max={Math.max(...data.net.downHist, 102400)} />
            </Tile>
            <Tile label="Battery" value={battery ? `${battery.pct}%` : 'Plugged in'}>
              <p className="mt-2 text-[12px] text-faint">{battery ? (battery.charging ? 'Charging' : 'On battery') : 'No battery'}</p>
            </Tile>
          </div>

          <h3 className="mb-1.5 mt-5 text-[12px] text-faint">Using the most memory</h3>
          <ul className="space-y-0.5 text-[13px]">
            {data.procs.slice(0, 5).map((p) => (
              <li key={p.name} className="flex justify-between gap-2 py-0.5">
                <span className="truncate text-muted">
                  {p.name.replace(/\.exe$/i, '')}
                  {p.n > 1 && <span className="text-faint"> ×{p.n}</span>}
                </span>
                <span className="shrink-0 tabular-nums text-faint">{p.mb} MB</span>
              </li>
            ))}
            {data.jobs.map((j) => (
              <li key={j} className="truncate py-0.5 text-accent">
                {j}
              </li>
            ))}
          </ul>
        </>
      )}
      {alerts.length > 0 && (
        <ul className="mt-4 space-y-1.5 text-[12.5px]" aria-label="Alerts">
          {alerts.map((a) => (
            <li key={a.id} className={`flex items-start gap-2 rounded-lg px-3 py-2 ${a.level === 'crit' ? 'bg-danger/10 text-danger' : 'bg-warn/10 text-warn'}`}>
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
              <span>{a.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
