import { useEffect, useMemo, useState } from 'react';

export interface HudAlert { id: string; level: 'warn' | 'crit'; text: string }
export interface Telemetry {
  t: number;
  cpu: number;
  cpuHist: number[];
  ram: { used: number; total: number; pct: number };
  ramHist: number[];
  net: { down: number; up: number; downHist: number[]; upHist: number[]; iface: string; ip: string };
  procs: Array<{ name: string; mb: number; n: number }>;
  jobs: string[];
  alerts: HudAlert[];
  uptime: number;
}
export interface Battery { pct: number; charging: boolean }

interface BatteryManager extends EventTarget { level: number; charging: boolean }

/** Live system telemetry from the main process, plus battery and connection state read in the renderer. */
export function useTelemetry(): { data: Telemetry | null; battery: Battery | null; online: boolean; alerts: HudAlert[] } {
  const [data, setData] = useState<Telemetry | null>(null);
  const [battery, setBattery] = useState<Battery | null>(null);
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const api = window.electronAPI?.telemetry;
    if (!api) return;
    void api.get().then((t) => t && setData(t as Telemetry)).catch(() => undefined);
    return api.onUpdate((t) => setData(t as Telemetry));
  }, []);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  useEffect(() => {
    let bm: BatteryManager | null = null;
    let dead = false;
    const read = () => bm && setBattery({ pct: Math.round(bm.level * 100), charging: bm.charging });
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManager> };
    nav.getBattery?.().then((b) => {
      if (dead) return;
      bm = b;
      read();
      ['levelchange', 'chargingchange'].forEach((e) => b.addEventListener(e, read));
    }).catch(() => undefined);
    return () => {
      dead = true;
      ['levelchange', 'chargingchange'].forEach((e) => bm?.removeEventListener(e, read));
    };
  }, []);

  const alerts = useMemo(() => {
    const a: HudAlert[] = [...(data?.alerts ?? [])];
    if (battery && !battery.charging && battery.pct <= 10) a.push({ id: 'bat', level: 'crit', text: `Battery ${battery.pct}%, plug in now` });
    else if (battery && !battery.charging && battery.pct <= 20) a.push({ id: 'bat', level: 'warn', text: `Battery ${battery.pct}%, not charging` });
    if (!online) a.push({ id: 'net', level: 'crit', text: 'No internet connection' });
    return a.sort((x, y) => Number(y.level === 'crit') - Number(x.level === 'crit'));
  }, [data, battery, online]);

  return { data, battery, online, alerts };
}
