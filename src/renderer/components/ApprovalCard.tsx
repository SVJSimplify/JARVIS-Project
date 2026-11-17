import { useEffect, useState } from 'react';
import type { ApprovalRequestView } from '../../../src/main/approval';

/**
 * USER ACTION APPROVAL CARD (Round 29 Phase 1 §1.1; ROUND 32 Phase 1 §1.1 — informational).
 *
 * This card shows the user EXACTLY what JARVIS intends to do: the site, the destination,
 * the target, the action, the consequence and — for form submissions — a masked summary
 * of the actual payload. It holds NO authority of its own: clicking Approve does NOT
 * grant permission. It only asks the MAIN PROCESS to open the native system confirmation
 * dialog, and ONLY that dialog's result can approve the action. Denying or dismissing
 * here is a real refusal; approving here starts the system confirmation.
 */

const remainder = (expiresAt: number): string => {
  const s = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};

export default function ApprovalCard() {
  const [requests, setRequests] = useState<ApprovalRequestView[]>([]);
  const [busyId, setBusyId] = useState('');
  const [note, setNote] = useState('');

  const refresh = async (): Promise<void> => {
    try {
      const list = (await window.electronAPI.approvals.list()) as ApprovalRequestView[];
      setRequests(Array.isArray(list) ? list : []);
    } catch {
      /* the card never breaks the app over a refresh failure */
    }
  };

  useEffect(() => {
    void refresh();
    const offReq = window.electronAPI.on('jarvis-approval-request', () => void refresh());
    const offRes = window.electronAPI.on('jarvis-approval-resolved', () => void refresh());
    const iv = setInterval(() => void refresh(), 2000);
    return () => {
      offReq();
      offRes();
      clearInterval(iv);
    };
  }, []);

  const respond = async (id: string, decision: 'approve' | 'deny'): Promise<void> => {
    setBusyId(id);
    try {
      await window.electronAPI.approvals.respond(id, decision);
      setNote(decision === 'approve' ? 'Opening the system confirmation dialog — approve there to allow this one action.' : 'Denied — JINI was told you refused it.');
      setTimeout(() => setNote(''), 6000);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId('');
      void refresh();
    }
  };

  const dismiss = async (id: string): Promise<void> => {
    setBusyId(id);
    try {
      await window.electronAPI.approvals.dismiss(id);
    } finally {
      setBusyId('');
      void refresh();
    }
  };

  if (!requests.length) return null;
  const first = requests[0];
  const i = first.intent;

  return (
    <div className="pointer-events-auto fixed bottom-28 left-1/2 z-50 w-[min(640px,92vw)] -translate-x-1/2" role="dialog" aria-label="JINI action approval">
      <div className="holo-panel no-drag space-y-2 rounded-md border border-[#A86E1A]/50 px-4 py-3 shadow-[0_0_24px_rgba(168,110,26,0.15)]">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-[12px] font-bold text-[#A86E1A]">Approval required</h3>
          <span className="font-mono text-[12px] text-steel">
            {first.nativeConfirming ? 'system dialog open' : `expires in ${remainder(first.requestExpiresAt)}`}
          </span>
        </div>
        <p className="font-mono text-[12px] leading-relaxed text-[#1F1B16]">
          JINI wants to <span className="text-[#A86E1A]">{i.action}</span> on <span className="text-accent">{i.origin}</span>
          {i.targetLabel ? (
            <>
              {' '}— target <span className="text-accent">“{i.targetLabel}”</span>
            </>
          ) : null}
          .
        </p>
        <p className="font-mono text-[12px] leading-relaxed text-steel">{i.effect}</p>
        {i.payloadSummary ? (
          <p className="font-mono text-[12px] leading-relaxed text-steel/90">
            <span className="text-[#A86E1A]">Submits:</span> {i.payloadSummary}
          </p>
        ) : null}
        <p className="font-mono text-[12px] text-steel/70">
          Approve here opens the SYSTEM confirmation dialog; only that dialog grants the action — once, for two minutes, bound to this exact page, tab, target and payload.
        </p>
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            className="rounded-sm border border-[#4F7F55]/70 px-4 py-1.5 font-display text-[12px] font-bold text-[#4F7F55] transition-colors hover:bg-[#4F7F55] hover:text-[#FBF8F2] disabled:opacity-40"
            disabled={busyId === first.id || first.nativeConfirming === true}
            onClick={() => void respond(first.id, 'approve')}
          >
            {first.nativeConfirming ? 'Confirm in system dialog…' : 'Approve via system dialog'}
          </button>
          <button
            type="button"
            className="rounded-sm border border-hot/60 px-4 py-1.5 font-display text-[12px] font-bold text-hot transition-colors hover:bg-hot hover:text-[#FBF8F2] disabled:opacity-40"
            disabled={busyId === first.id}
            onClick={() => void respond(first.id, 'deny')}
          >
            Deny
          </button>
          <button
            type="button"
            className="ml-auto font-mono text-[12px] text-steel transition-colors hover:text-accent disabled:opacity-40"
            disabled={busyId === first.id}
            onClick={() => void dismiss(first.id)}
          >
            dismiss
          </button>
        </div>
        {requests.length > 1 && <p className="font-mono text-[12px] text-steel/60">{requests.length - 1} more approval request(s) waiting.</p>}
        {note && <p className="font-mono text-[12px] text-accent">{note}</p>}
      </div>
    </div>
  );
}
