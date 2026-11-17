import { useEffect, useMemo, useRef, useState } from 'react';
import { popModal, pushModal } from '../lib/modalState';
import { fullStamp, groupConversations, preview, splitFences, stamp, type ConversationGroup } from '../lib/conversations';
import type { HistoryTurn } from '../lib/protocol';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Bumped by App after every finished turn; while the panel is open this triggers a refetch,
   *  so new conversations appear without closing and reopening anything. */
  refreshKey: number;
}

const backBtn =
  'no-drag mb-4 inline-flex items-center gap-2 font-display text-[12px] font-bold text-steel transition-colors hover:text-accent outline-none';

/** Renders one reply: fenced code blocks as styled <pre>, everything else with its original
 *  line breaks, lists and indentation preserved (pre-wrap). No truncation, ever. */
function ReplyBody({ reply }: { reply: string }) {
  if (!reply) return <p className="text-sm italic text-steel/70">(no verbal reply — see the activity feed for what happened)</p>;
  const blocks = splitFences(reply);
  return (
    <div className="space-y-3">
      {blocks.map((b, i) =>
        b.code ? (
          <pre key={i} className="overflow-x-auto rounded-sm border border-line bg-[rgb(var(--accent)/0.06)] p-3 font-mono text-[12.5px] leading-relaxed text-accent/90">
            {b.lang ? <span className="mb-1 block text-[12px] text-steel">{b.lang}</span> : null}
            {b.content}
          </pre>
        ) : (
          <p key={i} className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-hot/85">
            {b.content}
          </p>
        )
      )}
    </div>
  );
}

function TurnRow({ turn, detailed }: { turn: HistoryTurn; detailed: boolean }) {
  const clipped = turn.legacy === true && (turn.user.endsWith('…') || turn.reply.endsWith('…'));
  return (
    <div className="space-y-2 border-b border-line/30 py-3 last:border-b-0">
      <div className="flex items-baseline gap-3">
        <span className="shrink-0 font-display text-[12px] font-bold text-accent">You</span>
        <span className="font-mono text-[12px] text-steel/70">{stamp(turn.t)}</span>
        {turn.error && <span className="font-mono text-[12px] text-hot">{turn.error === 'interrupted' ? '· interrupted' : '· failed'}</span>}
        {clipped && <span className="font-mono text-[12px] text-steel/60">· compact record (full text was never stored)</span>}
      </div>
      <p className={`break-words text-[13.5px] leading-relaxed text-hot ${detailed ? 'whitespace-pre-wrap' : ''}`}>{turn.user}</p>
      <div className="flex items-baseline gap-3 pt-1">
        <span className="shrink-0 font-display text-[12px] font-bold text-accent/80">J.A.R.V.I.S</span>
        {turn.actions.length > 0 && <span className="truncate font-mono text-[12px] text-steel/60" title={turn.actions.join(' · ')}>{turn.actions.join(' · ')}</span>}
      </div>
      {detailed ? (
        <ReplyBody reply={turn.reply} />
      ) : (
        <p className="line-clamp-2 break-words text-[13px] leading-snug text-steel">{preview(turn.reply, 220)}</p>
      )}
    </div>
  );
}

function GroupHeader({ g }: { g: ConversationGroup }) {
  const d = new Date(g.start);
  const label = `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} · ${stamp(g.start)}${g.end - g.start >= 60_000 ? ` – ${stamp(g.end)}` : ''}`;
  const n = g.turns.length;
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-accent/20 pb-1.5">
      <h3 className="font-mono text-[12px] text-accent/80">{label}</h3>
      <span className="shrink-0 font-mono text-[12px] text-steel/60">{n} message{n === 1 ? '' : 's'}</span>
    </div>
  );
}

/** The Conversations tab: a full reading surface over the untouched chat. Opens from the
 *  header history button; Esc, ✕ or a backdrop click returns to the live view. */
export default function ConversationsPanel({ open, onClose, refreshKey }: Props) {
  const [turns, setTurns] = useState<HistoryTurn[] | null>(null);
  const [openGroup, setOpenGroup] = useState<number | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    pushModal();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCloseRef.current();
    window.addEventListener('keydown', onKey);
    return () => {
      popModal();
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // (Re)load whenever the panel opens or a new turn finished while it stayed open.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void window.electronAPI.history
      .list()
      .then((t) => alive && setTurns(Array.isArray(t) ? t : []))
      .catch(() => alive && setTurns([]));
    return () => {
      alive = false;
    };
  }, [open, refreshKey]);

  const groups = useMemo(() => (turns ? [...groupConversations(turns)].reverse() : []), [turns]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [openGroup, open]);

  if (!open) return null;
  const active = openGroup !== null ? groups.find((g) => g.start === openGroup) : null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto overscroll-contain bg-[rgba(52,38,24,0.22)] p-6"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div ref={scrollRef} className="holo-panel max-h-[86vh] w-[46rem] max-w-[92vw] overflow-y-auto p-7">
        <div className="mb-5 flex items-baseline justify-between gap-4">
          <h2 className="holo-title">History</h2>
          <button type="button" onClick={onClose} aria-label="Close conversations" className="no-drag grid h-8 w-8 shrink-0 place-items-center rounded-sm text-steel transition-colors hover:bg-accent/10 hover:text-accent outline-none">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {turns === null ? (
          <p className="text-sm text-steel">Loading…</p>
        ) : active ? (
          <>
            <button type="button" onClick={() => setOpenGroup(null)} className={backBtn}>
              ← All conversations
            </button>
            <div className="mb-2 font-mono text-[12px] text-steel/70">{fullStamp(active.start)}</div>
            {active.turns.map((t, i) => (
              <TurnRow key={`${t.t}-${i}`} turn={t} detailed />
            ))}
          </>
        ) : groups.length === 0 ? (
          <p className="text-sm text-steel">No conversations yet. Everything you ask JINI from now on is kept here in full — close and reopen the app and it is still here.</p>
        ) : (
          <div className="space-y-5">
            {groups.map((g) => (
              <div key={g.start}>
                <GroupHeader g={g} />
                <button
                  type="button"
                  onClick={() => setOpenGroup(g.start)}
                  className="no-drag block w-full cursor-pointer rounded-sm text-left outline-none transition-colors hover:bg-accent/5 focus-visible:bg-accent/10"
                >
                  {g.turns.map((t, i) => (
                    <TurnRow key={`${t.t}-${i}`} turn={t} detailed={false} />
                  ))}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
