import { useEffect, useState } from 'react';
import { setState, toast, uid, useAppState, type ApprovalView } from '../lib/store';
import { rpc } from '../lib/linkClient';
import { Empty, ScreenHeader } from '../components/ui';

/**
 * Remote approvals. Deliberately NOT queued offline: a decision must be made against the live
 * request, never replayed later. Each answer is audited on the desktop with this phone's name.
 */
export default function ApprovalsScreen() {
  const { approvals, online } = useAppState((s) => ({ approvals: s.approvals, online: s.connection === 'online' }));
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!approvals.length) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [approvals.length]);

  const live = approvals.filter((a) => a.expiresAt > now);
  if (!live.length) return <Empty title="Nothing to approve" hint="When JINI needs your OK for a sensitive action on the desktop, it appears here." />;

  return (
    <div className="pb-8">
      <ScreenHeader title="Approve" />
      {!online && <p className="px-1 text-meta text-warn">Desktop offline — reconnect to answer. Approvals are never queued.</p>}
      <div className="mt-4 space-y-4">
        {live.map((a) => (
          <ApprovalItem key={a.id} a={a} now={now} online={online} />
        ))}
      </div>
    </div>
  );
}

function ApprovalItem({ a, now, online }: { a: ApprovalView; now: number; online: boolean }) {
  const [busy, setBusy] = useState(false);
  const left = Math.max(0, Math.round((a.expiresAt - now) / 1000));
  const answer = async (decision: 'approve' | 'deny') => {
    setBusy(true);
    try {
      const r = await rpc<{ ok: boolean; status: string; reason: string }>('approval.respond', { id: a.id, decision }, uid('appr'));
      toast(r.ok ? (decision === 'approve' ? 'Approved once' : 'Denied') : r.reason);
      setState((s) => ({ approvals: s.approvals.filter((x) => x.id !== a.id) }));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rounded-2xl bg-surface p-5" aria-label={`Approval: ${a.action}`}>
      <div className="flex items-center justify-between text-meta">
        <span className="font-medium text-warn">Needs your approval</span>
        <span className="tabular-nums text-faint">
          Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
        </span>
      </div>
      <p className="mt-3 text-[20px] font-semibold leading-7 tracking-[-0.01em] text-text">{cap(a.action)}</p>
      <p className="mt-1 break-all text-body text-muted">{a.origin}</p>
      <dl className="mt-4 divide-y divide-hairline border-y border-hairline text-[14px]">
        <Row k="Target" v={a.target || 'Unnamed'} />
        <Row k="Effect" v={a.effect} />
        <Row k="Tool" v={a.tool} />
      </dl>
      <div className="mt-5 grid grid-cols-2 gap-2">
        <button className="btn-secondary bg-surface-2 text-danger" disabled={busy || !online} onClick={() => void answer('deny')}>
          Deny
        </button>
        <button className="btn-primary" disabled={busy || !online} onClick={() => void answer('approve')}>
          Approve once
        </button>
      </div>
    </section>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const Row = ({ k, v }: { k: string; v: string }) => (
  <div className="flex justify-between gap-4 py-2.5">
    <dt className="text-faint">{k}</dt>
    <dd className="break-all text-right text-text">{v}</dd>
  </div>
);
