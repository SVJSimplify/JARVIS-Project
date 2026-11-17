import { useEffect, useRef, useState } from 'react';
import { getState, setState, uid, useAppState, type ChatMessage } from '../lib/store';
import { enqueue } from '../lib/linkClient';
import { askProvider, providerReady } from '../lib/provider';
import { Empty, Icon } from '../components/ui';
import TaskActivity from '../components/TaskActivity';

/**
 * Where a message runs is decided per message, not by one fixed rule:
 *  - Chat + provider configured → answered on the phone, regardless of desktop state;
 *  - Chat without a provider → desktop if online;
 *  - Task → desktop if online, else queued and sent on reconnect.
 */
const STOP_RE = /^\s*(?:hey\s+)?(?:jini|genie)?[\s,]*(?:stop|cancel|abort|halt|enough|never ?mind|stop (?:it|that|everything|all)|cancel (?:it|that|everything|the task))[\s.!]*$/i;

export function route(kind: ChatMessage['kind'], text = ''): 'desktop' | 'phone' | 'queue' | 'none' {
  const s = getState();
  const paired = Boolean(s.link && !s.link.revoked);
  const online = paired && s.connection === 'online';
  const isStopText = STOP_RE.test(text);
  if (online && isStopText) return 'desktop'; // "stop" always reaches the desktop
  if (kind === 'chat' && providerReady()) return 'phone';
  if (online) return 'desktop';
  if (paired && kind === 'task') return 'queue';
  return 'none';
}

export default function ChatScreen() {
  const { messages, paired } = useAppState((s) => ({ messages: s.messages, paired: Boolean(s.link && !s.link.revoked) }));
  const [text, setText] = useState('');
  const [kind, setKind] = useState<ChatMessage['kind']>('chat');
  const end = useRef<HTMLDivElement>(null);

  // Block body on purpose: modern WebViews return a Promise from scrollIntoView, and an
  // effect must return nothing or a cleanup function.
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    const r = route(kind, t);
    if (r === 'none') {
      setState({ toast: 'Pair a desktop or add a provider in Settings first.' });
      return;
    }
    setText('');
    const id = uid('m');
    const msg: ChatMessage = { id, role: 'user', text: t, at: Date.now(), kind, state: r === 'phone' ? 'done' : 'queued', via: r === 'phone' ? 'phone' : 'desktop' };
    setState((s) => ({ messages: [...s.messages, msg] }));
    if (r === 'phone') {
      const replyId = `r_${id}`;
      setState((s) => ({ messages: [...s.messages, { id: replyId, role: 'jini', text: '', at: Date.now(), kind, state: 'running', via: 'phone', replyTo: id }] }));
      try {
        const reply = await askProvider(t, getState().messages.filter((m) => m.id !== id && m.id !== replyId));
        setState((s) => ({ messages: s.messages.map((m) => (m.id === replyId ? { ...m, text: reply, state: 'done', at: Date.now() } : m)) }));
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        setState((s) => ({ messages: s.messages.map((m) => (m.id === replyId ? { ...m, text: err, state: 'failed' } : m)) }));
      }
      return;
    }
    enqueue(kind === 'task' && !STOP_RE.test(t) ? 'task.send' : 'chat', { text: t, threadId: id });
  };

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1 space-y-5 pb-4 pt-3">
        {messages.length === 0 && (
          <Empty
            title="What can I do for you?"
            hint={paired ? 'Ask a question, or switch to Run on desktop to have your computer do the work.' : 'Answers come from your own AI provider until you pair a desktop.'}
          />
        )}
        {messages.map((m) => {
          // A desktop task is shown as one live activity row; its reply renders inside it.
          if (m.role === 'jini' && m.kind === 'task' && m.replyTo) return null;
          if (m.role === 'user' && m.kind === 'task' && m.via === 'desktop') {
            return (
              <div key={m.id} className="space-y-2">
                <Message m={{ ...m, state: m.state === 'queued' || m.state === 'sending' ? 'done' : m.state }} />
                <TaskActivity msg={m} reply={messages.find((r) => r.replyTo === m.id)} />
              </div>
            );
          }
          return <Message key={m.id} m={m} />;
        })}
        <div ref={end} />
      </div>
      <div className="sticky bottom-0 -mx-4 bg-bg px-4 pb-3 pt-2">
        {paired && (
          <div className="mb-2.5 inline-flex rounded-xl bg-surface-2 p-1 text-[13px] font-medium" role="tablist" aria-label="Send as">
            {(['chat', 'task'] as const).map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={kind === k}
                onClick={() => setKind(k)}
                className={`rounded-lg px-3.5 py-1.5 transition-colors ${kind === k ? 'bg-surface text-text shadow-[0_1px_2px_rgba(60,42,20,0.08)]' : 'text-muted'}`}
              >
                {k === 'chat' ? 'Chat' : 'Run on desktop'}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={kind === 'task' ? 'Describe a task for your desktop…' : 'Message JINI…'}
            aria-label={kind === 'task' ? 'Task for your desktop' : 'Message'}
            className="field max-h-36 min-h-[48px] flex-1 resize-none rounded-2xl"
          />
          <button
            onClick={() => void send()}
            disabled={!text.trim()}
            aria-label="Send"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-ink text-paper transition-colors active:bg-black disabled:bg-surface-2 disabled:text-faint"
          >
            <Icon name="send" className="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function Message({ m }: { m: ChatMessage }) {
  const mine = m.role === 'user';
  const meta =
    m.state === 'queued'
      ? 'Waiting for desktop'
      : m.state === 'sending'
        ? 'Sending…'
        : m.state === 'failed'
          ? 'Failed'
          : !mine && m.via === 'phone' && m.state === 'done'
            ? 'Answered on phone · desktop offline'
            : '';

  if (mine) {
    return (
      <div className="flex flex-col items-end">
        {m.kind === 'task' && <p className="mb-1 text-meta font-medium text-muted">Desktop task</p>}
        <div className="max-w-[82%] rounded-2xl rounded-br-md bg-[#EFE7DA] px-4 py-2.5 text-body text-text">
          <p className="whitespace-pre-wrap">{m.text}</p>
        </div>
        {meta && <p className={`mt-1 text-meta ${m.state === 'failed' ? 'text-danger' : 'text-faint'}`}>{meta}</p>}
      </div>
    );
  }

  return (
    <div className="anim-enter max-w-[92%]">
      {m.state === 'running' && !m.text ? (
        <p className="typing-dots py-2 text-muted" role="status" aria-label={m.via === 'phone' ? 'Thinking' : 'Your desktop is working'}>
          <span />
          <span />
          <span />
        </p>
      ) : (
        <p className={`whitespace-pre-wrap text-body ${m.state === 'failed' ? 'text-danger' : 'text-text'}`}>{m.text}</p>
      )}
      {meta && <p className="mt-1 text-meta text-faint">{meta}</p>}
    </div>
  );
}
