import { useState } from 'react';
import { setState, toast, useAppState } from '../lib/store';
import { rotateKey, unpair } from '../lib/linkClient';
import { Icon, ScreenHeader, ago } from '../components/ui';
import ProviderForm from './ProviderForm';
import { PairPanel } from './Onboarding';

export default function SettingsScreen() {
  const { link, connection, lastSync, outbox } = useAppState((s) => ({ link: s.link, connection: s.connection, lastSync: s.lastSync, outbox: s.outbox.length }));
  const [pairing, setPairing] = useState(false);
  const [busy, setBusy] = useState(false);
  const paired = Boolean(link && !link.revoked);

  return (
    <div className="pb-10">
      <ScreenHeader title="Settings" />

      <p className="section-label">Desktop</p>
      {paired && link ? (
        <div className="group-list">
          <div className="group-row flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-2 text-accent">
              <Icon name="monitor" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-body font-medium text-text">{link.desktopName}</p>
              <p className="text-meta text-faint">
                {connection === 'online' ? 'Connected' : 'Offline'}
                {lastSync ? ` · synced ${ago(lastSync)}` : ''}
                {outbox ? ` · ${outbox} queued` : ''}
              </p>
            </div>
          </div>
          <Row label="Paired" value={new Date(link.pairedAt).toLocaleDateString()} />
          <Row label="Address" value={`${link.host}:${link.port}`} mono />
          <Row label="Encryption" value="End-to-end" />
          <button
            className="group-row w-full text-left text-body text-accent disabled:opacity-40"
            disabled={busy || connection !== 'online'}
            onClick={async () => {
              setBusy(true);
              try {
                await rotateKey();
                toast('Link key rotated');
              } catch (e) {
                toast(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Rotating…' : 'Rotate encryption key'}
          </button>
          <button
            className="group-row w-full text-left text-body text-danger"
            onClick={() => {
              if (confirm('Unpair this phone? Also revoke it on the desktop under Settings → Devices.')) unpair();
            }}
          >
            Unpair this phone
          </button>
        </div>
      ) : pairing ? (
        <div className="rounded-2xl bg-surface p-5">
          <PairPanel onPaired={() => setPairing(false)} />
          <button className="btn-text mt-4 text-[14px]" onClick={() => setPairing(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="rounded-2xl bg-surface p-5">
          <p className="text-body text-muted">{link?.revoked ? 'This phone was revoked on the desktop. Pair again to reconnect.' : 'No desktop paired yet.'}</p>
          <button className="btn-primary mt-4 w-full" onClick={() => setPairing(true)}>
            Pair with desktop JINI
          </button>
        </div>
      )}

      <p className="section-label">AI provider</p>
      <div className="rounded-2xl bg-surface p-5">
        <p className="mb-4 text-meta text-faint">Used for chat on this phone when your desktop is offline.</p>
        <ProviderForm onSaved={() => toast('Provider saved')} />
      </div>

      <p className="section-label">This phone</p>
      <div className="group-list">
        <button
          className="group-row w-full text-left text-body text-danger"
          onClick={() => {
            if (confirm('Clear the chat history stored on this phone? Desktop history is not affected.')) setState({ messages: [] });
          }}
        >
          Clear chat history
        </button>
      </div>
      <p className="mt-3 px-1 text-meta text-faint">
        JINI keeps no background connection. It syncs when you open the app and listens for live updates only while it is on screen.
      </p>
      <p className="mt-8 text-center text-meta text-faint">JINI 0.1.0</p>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="group-row flex items-center justify-between gap-4">
      <span className="text-body text-muted">{label}</span>
      <span className={`truncate text-text ${mono ? 'font-mono text-[13px]' : 'text-body'}`}>{value}</span>
    </div>
  );
}
