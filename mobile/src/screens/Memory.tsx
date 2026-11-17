import { useEffect, useMemo, useState } from 'react';
import { useAppState, type MemoryView } from '../lib/store';
import { enqueue, refreshMemories, rpc } from '../lib/linkClient';
import { Empty, Icon, ScreenHeader, ago } from '../components/ui';

const CATS = ['all', 'preference', 'fact', 'instruction', 'decision', 'habit', 'contact', 'procedure'] as const;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The SAME memory as desktop JINI (synced cache when offline). Browse, search, add, correct, delete. */
export default function MemoryScreen() {
  const { memories, paired, online } = useAppState((s) => ({ memories: s.memories, paired: Boolean(s.link && !s.link.revoked), online: s.connection === 'online' }));
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<(typeof CATS)[number]>('all');
  const [deep, setDeep] = useState('');
  const [editing, setEditing] = useState<MemoryView | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (online) void refreshMemories();
  }, [online]);

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return memories.filter((m) => (cat === 'all' || m.category === cat) && (!n || m.label.toLowerCase().includes(n)));
  }, [memories, q, cat]);

  if (!paired) return <Empty title="Memory lives on your desktop" hint="Pair your desktop to browse and correct what JINI knows about you." />;

  const semantic = async () => {
    try {
      setDeep(await rpc<string>('memory.search', { query: q }));
    } catch (e) {
      setDeep(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="pb-8">
      <ScreenHeader
        title="Memory"
        action={
          <button className="btn-text flex items-center gap-1 pb-1 text-[14px]" onClick={() => setAdding(true)}>
            <Icon name="plus" className="h-4 w-4" /> Add
          </button>
        }
      />
      <div className="relative mt-2">
        <Icon name="search" className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-faint" />
        <input className="field pl-10" placeholder="Search memory" aria-label="Search memory" value={q} onChange={(e) => (setQ(e.target.value), setDeep(''))} />
      </div>
      {q.trim() && online && (
        <button className="btn-text mt-3 px-1 text-[14px]" onClick={() => void semantic()}>
          Search by meaning on your desktop
        </button>
      )}
      {deep && <p className="mt-3 whitespace-pre-wrap rounded-2xl bg-surface p-4 text-meta text-muted">{deep}</p>}

      <div className="-mx-4 mt-4 flex gap-1.5 overflow-x-auto px-4 pb-1" role="tablist" aria-label="Category">
        {CATS.map((c) => (
          <button
            key={c}
            role="tab"
            aria-selected={cat === c}
            onClick={() => setCat(c)}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors ${cat === c ? 'bg-surface-2 text-text' : 'text-faint'}`}
          >
            {cap(c)}
          </button>
        ))}
      </div>
      {!online && <p className="mt-3 px-1 text-meta text-faint">Offline — showing the copy on this phone. Changes are queued.</p>}

      {shown.length === 0 ? (
        <Empty title="Nothing here" hint={memories.length ? 'Try another search or category.' : 'JINI has not saved anything yet.'} />
      ) : (
        <ul className="group-list mt-4">
          {shown.map((m) => (
            <li key={m.id} className="group-row">
              <p className="text-body text-text">{m.label}</p>
              <div className="mt-1.5 flex items-center justify-between">
                <span className="text-meta text-faint">
                  {cap(m.category)}
                  {m.scope ? ` · ${m.scope}` : ''} · {ago(m.updated)}
                </span>
                <span className="flex gap-5 text-[14px] font-medium">
                  <button className="text-accent active:opacity-70" onClick={() => setEditing(m)}>
                    Correct
                  </button>
                  <button
                    className="text-muted active:opacity-70"
                    onClick={() => {
                      if (confirm('Delete this memory? JINI will no longer use it.')) enqueue('memory.forget', { id: m.id });
                    }}
                  >
                    Delete
                  </button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {(editing || adding) && (
        <MemorySheet
          initial={editing?.label ?? ''}
          title={editing ? 'Correct memory' : 'New memory'}
          onCancel={() => (setEditing(null), setAdding(false))}
          onSave={(text, category) => {
            if (editing) enqueue('memory.correct', { id: editing.id, fact: text });
            else enqueue('memory.add', { fact: text, category });
            setEditing(null);
            setAdding(false);
          }}
        />
      )}
    </div>
  );
}

function MemorySheet({ initial, title, onSave, onCancel }: { initial: string; title: string; onSave: (t: string, c: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  const [cat, setCat] = useState('fact');
  return (
    <div className="fixed inset-0 z-40 flex items-end bg-[rgba(52,38,24,0.25)]" onClick={onCancel}>
      <div role="dialog" aria-modal="true" aria-label={title} className="safe-bottom w-full rounded-t-[24px] bg-surface px-5 pt-3" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-hairline" />
        <p className="text-[17px] font-semibold text-text">{title}</p>
        <textarea className="field mt-4 h-28 resize-none bg-bg" value={text} onChange={(e) => setText(e.target.value)} autoFocus aria-label="Memory text" />
        {!initial && (
          <select className="field mt-3 bg-bg" value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category">
            {['fact', 'preference', 'instruction', 'decision', 'habit', 'procedure'].map((c) => (
              <option key={c} value={c}>
                {cap(c)}
              </option>
            ))}
          </select>
        )}
        <div className="mt-4 flex gap-2 pb-3">
          <button className="btn-secondary flex-1 bg-bg" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn-primary flex-1" disabled={!text.trim()} onClick={() => onSave(text.trim(), cat)}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
