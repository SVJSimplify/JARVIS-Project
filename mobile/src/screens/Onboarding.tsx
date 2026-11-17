import { useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner';
import { pairWithOffer } from '../lib/linkClient';
import { Icon } from '../components/ui';
import ProviderForm from './ProviderForm';

/** First launch: pair with desktop JINI (recommended) or set up a provider to use the phone alone. */
export default function Onboarding({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'intro' | 'pair' | 'provider'>('intro');

  return (
    <div className="safe-top safe-bottom flex h-full flex-col overflow-y-auto bg-bg px-6">
      {mode === 'intro' ? (
        <>
          <div className="mt-[22vh]">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-[26px] font-semibold text-on-accent">j</div>
            <h1 className="mt-8 text-[34px] font-semibold leading-[40px] tracking-[-0.025em] text-text">
              Your desktop,
              <br />
              in your pocket.
            </h1>
            <p className="mt-4 max-w-[320px] text-body text-muted">Send work to JINI on your computer, follow it live, approve what matters and keep your memory with you.</p>
          </div>
          <div className="mb-8 mt-auto flex flex-col gap-2 pt-10">
            <button className="btn-primary" onClick={() => setMode('pair')}>
              Pair with desktop JINI
            </button>
            <button className="btn-secondary" onClick={() => setMode('provider')}>
              Use without a desktop
            </button>
          </div>
        </>
      ) : (
        <div className="pb-8 pt-4">
          <button className="btn-text -ml-1 py-2 text-[15px]" onClick={() => setMode('intro')}>
            ‹ Back
          </button>
          <h1 className="mt-4 text-title text-text">{mode === 'pair' ? 'Pair your desktop' : 'Connect a provider'}</h1>
          <div className="mt-6">{mode === 'pair' ? <PairPanel onPaired={onDone} /> : <ProviderForm onSaved={onDone} />}</div>
        </div>
      )}
    </div>
  );
}

export function PairPanel({ onPaired }: { onPaired?: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState(Capacitor.getPlatform() === 'ios' ? 'iPhone' : 'Android phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const pair = async (offer: string) => {
    setError('');
    setBusy(true);
    try {
      await pairWithOffer(offer, name.trim() || 'Phone', Capacitor.getPlatform());
      onPaired?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const scan = async () => {
    setError('');
    try {
      const r = await CapacitorBarcodeScanner.scanBarcode({ hint: CapacitorBarcodeScannerTypeHint.QR_CODE, scanInstructions: 'Point at the QR code in desktop JINI → Settings → Devices' });
      if (r.ScanResult) await pair(r.ScanResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Scanning was cancelled.');
    }
  };

  return (
    <div className="flex flex-col">
      <ol className="space-y-3 text-body text-muted">
        {['On your computer, open JINI → Settings → Devices.', 'Turn on Allow phone connections, then tap Pair a phone.', 'Keep this phone on the same Wi-Fi and scan the code.'].map((s, i) => (
          <li key={s} className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface text-[12px] font-semibold text-text">{i + 1}</span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
      <label className="mt-6 block">
        <span className="mb-1.5 block text-[13px] font-medium text-muted">This phone’s name</span>
        <input className="field" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
      </label>
      <button className="btn-primary mt-5 gap-2" disabled={busy} onClick={() => void scan()}>
        <Icon name="scan" className="h-5 w-5" />
        {busy ? 'Pairing…' : 'Scan QR code'}
      </button>
      <details className="mt-4">
        <summary className="cursor-pointer py-2 text-[14px] font-medium text-muted">Or paste the pairing code</summary>
        <textarea className="field mt-2 h-24 resize-none font-mono text-[12px]" value={code} placeholder="jini://pair?d=…" aria-label="Pairing code" onChange={(e) => setCode(e.target.value)} />
        <button className="btn-secondary mt-2 w-full" disabled={busy || !code.trim()} onClick={() => void pair(code)}>
          Pair with code
        </button>
      </details>
      {error && (
        <p role="alert" className="mt-3 text-meta text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
