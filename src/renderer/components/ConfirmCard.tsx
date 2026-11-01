import { answerConfirm, useConfirm } from '../lib/confirm';

/** Approve / deny prompt shown before JARVIS does something destructive. */
export default function ConfirmCard() {
  const req = useConfirm();
  if (!req) return null;
  return (
    <div role="alertdialog" aria-label="Approval needed" className="fixed inset-x-3 bottom-3 z-50 rounded-lg border border-accent bg-[#000000f2] p-3 shadow-lg">
      <div className="text-[11px] font-semibold tracking-widest text-accent">APPROVAL NEEDED</div>
      <div className="mt-1 text-sm text-hot">{req.title}</div>
      {req.detail && <div className="mt-1 max-h-20 overflow-auto break-words font-mono text-[11px] text-steel">{req.detail}</div>}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => answerConfirm(true, req.id)}
          className="flex-1 rounded border border-accent py-1 text-xs font-semibold tracking-widest text-accent hover:bg-white/10"
        >
          ALLOW
        </button>
        <button
          type="button"
          onClick={() => answerConfirm(false, req.id)}
          className="flex-1 rounded border border-red-400/70 py-1 text-xs font-semibold tracking-widest text-red-300 hover:bg-white/10"
        >
          DENY
        </button>
      </div>
      <div className="mt-1 text-[10px] text-steel/70">Or say yes or no. Denied automatically after 45 seconds.</div>
    </div>
  );
}
