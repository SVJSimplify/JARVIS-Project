import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { JiniDeviceView, JiniLinkStatus } from '../../../types/electron';

const ago = (t: number): string => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

/**
 * Settings → Devices: turn the phone link on, pair a phone by QR (short-lived, single use),
 * and see / revoke paired devices. All state is read from the main process; the offer string
 * is rendered locally into a QR image and never leaves this window.
 */
export default function DevicesSection() {
  const [status, setStatus] = useState<JiniLinkStatus | null>(null);
  const [devices, setDevices] = useState<JiniDeviceView[]>([]);
  const [qr, setQr] = useState('');
  const [offer, setOffer] = useState('');
  const [exp, setExp] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await window.electronAPI.devices.status();
      setStatus(r.status);
      setDevices(r.devices);
      if (!r.status.pairing) {
        setQr('');
        setOffer('');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const toggle = async (on: boolean) => {
    setError('');
    setBusy(true);
    try {
      setStatus(await window.electronAPI.devices.enable(on));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const pair = async () => {
    setError('');
    try {
      const r = await window.electronAPI.devices.pairStart();
      setOffer(r.offer);
      setExp(r.exp);
      setQr(await QRCode.toDataURL(r.offer, { errorCorrectionLevel: 'L', margin: 3, width: 360, color: { dark: '#000000ff', light: '#ffffffff' } }));
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const cancel = async () => {
    await window.electronAPI.devices.pairCancel();
    setQr('');
    setOffer('');
    void refresh();
  };

  const active = devices.filter((d) => !d.revokedAt);
  const revoked = devices.filter((d) => d.revokedAt);
  const left = Math.max(0, Math.round((exp - now) / 1000));
  const showingQr = Boolean(qr && status?.pairing && left > 0);

  return (
    <div>
      <h2 className="rail-title">Devices</h2>
      <p className="mb-5 mt-1 text-sm text-steel">
        Pair the JINI mobile app to send tasks, chat, browse memory and approve actions from your phone. The phone connects over your local network; every
        message is end-to-end encrypted with a key only this desktop and that phone hold.
      </p>

      <label className="mb-5 flex items-center gap-3 text-sm text-hot">
        <input type="checkbox" className="jini-check" checked={Boolean(status?.enabled)} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
        Allow phone connections
      </label>

      {status?.enabled && (
        <p className="mb-5 font-mono text-xs text-steel">
          {status.listening ? `Listening on ${(status.hosts.length ? status.hosts : ['this computer']).join(', ')} : ${status.port} · ${status.remote ? 'Remote access on (any network)' : 'Remote access connecting…'}` : 'Not listening'}
        </p>
      )}
      {(error || status?.lastError) && <p className="mb-5 text-sm text-danger">{error || status?.lastError}</p>}

      {status?.listening && !showingQr && (
        <button type="button" onClick={() => void pair()} className="mb-6 border border-accent px-4 py-2 font-display text-xs font-bold text-accent hover:bg-accent/10">
          Pair a phone
        </button>
      )}

      {showingQr && (
        <div className="mb-6 flex flex-col items-start gap-3">
          <img src={qr} alt="JINI pairing QR code" width={320} height={320} className="rounded bg-white" />
          <p className="text-sm text-hot">Open JINI on your phone → Pair → scan this code. It expires in {left}s and works once.</p>
          <details className="w-full text-xs text-steel">
            <summary className="cursor-pointer">Can’t scan? Copy the pairing code instead</summary>
            <textarea readOnly value={offer} className="mt-2 h-20 w-full resize-none bg-black/30 p-2 font-mono text-[12px] text-hot" onFocus={(e) => e.currentTarget.select()} />
          </details>
          <button type="button" onClick={() => void cancel()} className="text-sm text-steel hover:text-hot">
            Cancel pairing
          </button>
        </div>
      )}

      <h3 className="mb-2 font-display text-[12px] font-bold text-steel">Paired devices</h3>
      {active.length === 0 && <p className="mb-4 text-sm text-steel">No phones paired yet.</p>}
      <ul className="mb-6 space-y-3">
        {active.map((d) => (
          <li key={d.id} className="flex items-center justify-between border-b border-line pb-2">
            <div>
              <p className="text-sm text-hot">
                <span className={`mr-2 inline-block h-2 w-2 rounded-full ${d.online ? 'bg-accent' : 'bg-steel/50'}`} />
                {d.name} <span className="text-steel">· {d.platform}</span>
              </p>
              <p className="text-xs text-steel">
                Paired {new Date(d.createdAt).toLocaleDateString()} · last seen {ago(d.lastSeen)}
                {d.rotatedAt ? ` · key rotated ${ago(d.rotatedAt)}` : ''}
              </p>
            </div>
            <button type="button" onClick={() => void window.electronAPI.devices.revoke(d.id).then(refresh)} className="text-sm text-danger hover:text-danger">
              Revoke
            </button>
          </li>
        ))}
      </ul>

      {revoked.length > 0 && (
        <>
          <h3 className="mb-2 font-display text-[12px] font-bold text-steel">Revoked</h3>
          <ul className="space-y-2">
            {revoked.map((d) => (
              <li key={d.id} className="flex items-center justify-between text-xs text-steel">
                <span>
                  {d.name} — {d.revokeReason}
                </span>
                <button type="button" onClick={() => void window.electronAPI.devices.forget(d.id).then(refresh)} className="hover:text-hot">
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
