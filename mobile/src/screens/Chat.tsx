import { useEffect, useRef, useState } from "react";
import {
  getState,
  setState,
  uid,
  useAppState,
  type ChatMessage,
  type ChatThread,
} from "../lib/store";
import { enqueue, loadDesktopChat, rpc } from "../lib/linkClient";
import { askProvider, providerReady } from "../lib/provider";
import { Empty, Icon } from "../components/ui";
import TaskActivity from "../components/TaskActivity";
import VoiceMode from "../components/VoiceMode";

/**
 * Where a message runs is decided per message, not by one fixed rule:
 *  - Chat + provider configured → answered on the phone, regardless of desktop state;
 *  - Chat without a provider → desktop if online;
 *  - Task → desktop if online, else queued and sent on reconnect.
 */
const STOP_RE =
  /^\s*(?:hey\s+)?(?:jini|genie)?[\s,]*(?:stop|cancel|abort|halt|enough|never ?mind|stop (?:it|that|everything|all)|cancel (?:it|that|everything|the task))[\s.!]*$/i;

/**
 * Send one message through the right route (phone provider / desktop / queue) and return
 * the id of the reply message to watch, or null when nothing can take it. Shared by the
 * composer and voice mode, so both behave identically.
 */
export async function sendText(
  t: string,
  kind: ChatMessage["kind"],
): Promise<string | null> {
  const r = route(kind, t);
  if (r === "none") {
    setState({ toast: "Pair a desktop or add a provider in Settings first." });
    return null;
  }
  const id = uid("m");
  const st = getState();
  const chatId = st.activeChat;
  const msg: ChatMessage = {
    id,
    role: "user",
    text: t,
    at: Date.now(),
    kind,
    state: r === "phone" ? "done" : "queued",
    via: r === "phone" ? "phone" : "desktop",
    chatId,
  };
  // A phone-only chat gets its title from its first message.
  setState((s) => ({
    messages: [...s.messages, msg],
    chats: s.chats.map((c) =>
      c.id === chatId && c.origin === "phone" && c.title === "New chat"
        ? { ...c, title: t.slice(0, 48), updatedAt: Date.now() }
        : c,
    ),
  }));
  const replyId = `r_${id}`;
  if (r === "phone") {
    setState((s) => ({
      messages: [
        ...s.messages,
        {
          id: replyId,
          role: "jini",
          text: "",
          at: Date.now(),
          kind,
          state: "running",
          via: "phone",
          replyTo: id,
          chatId,
        },
      ],
    }));
    try {
      const reply = await askProvider(
        t,
        getState().messages.filter(
          (m) => m.id !== id && m.id !== replyId && (m.chatId ?? "") === chatId,
        ),
      );
      setState((s) => ({
        messages: s.messages.map((m) =>
          m.id === replyId
            ? { ...m, text: reply, state: "done", at: Date.now() }
            : m,
        ),
      }));
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      setState((s) => ({
        messages: s.messages.map((m) =>
          m.id === replyId ? { ...m, text: err, state: "failed" } : m,
        ),
      }));
    }
    return replyId;
  }
  const desktopChat = st.chats.find(
    (c) => c.id === chatId && c.origin === "desktop",
  );
  enqueue(kind === "task" && !STOP_RE.test(t) ? "task.send" : "chat", {
    text: t,
    threadId: id,
    ...(desktopChat ? { chatId } : {}),
  });
  return replyId;
}

export function route(
  kind: ChatMessage["kind"],
  text = "",
): "desktop" | "phone" | "queue" | "none" {
  const s = getState();
  const paired = Boolean(s.link && !s.link.revoked);
  const online = paired && s.connection === "online";
  const isStopText = STOP_RE.test(text);
  if (online && isStopText) return "desktop"; // "stop" always reaches the desktop
  // A paired, online desktop is the execution authority. Prefer it even when the
  // phone has a standalone provider, so requests can use desktop apps, browser sessions,
  // files and the same agent runtime.
  if (online) return "desktop";
  if (kind === "chat" && providerReady()) return "phone";
  if (paired && kind === "task") return "queue";
  return "none";
}

export default function ChatScreen() {
  const { allMessages, paired, chats, activeChat, online } = useAppState(
    (s) => ({
      allMessages: s.messages,
      paired: Boolean(s.link && !s.link.revoked),
      chats: s.chats,
      activeChat: s.activeChat,
      online: s.connection === "online",
    }),
  );
  const messages = allMessages.filter((m) => (m.chatId ?? "") === activeChat);
  const [sheet, setSheet] = useState(false);
  const [menu, setMenu] = useState(false);
  const [voice, setVoice] = useState(false);
  const [sendingFile, setSendingFile] = useState(false);
  const camRef = useRef<HTMLInputElement>(null);
  const picRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /** Photo or file → desktop (saved + shown to the model); offline, images go to the phone's provider. */
  const attach = async (f: File | undefined) => {
    for (const r of [camRef, picRef, fileRef])
      if (r.current) r.current.value = "";
    if (!f) return;
    const st = getState();
    const online = Boolean(
      st.link && !st.link.revoked && st.connection === "online",
    );
    const isImage = f.type.startsWith("image/");
    if (!online && !(isImage && providerReady())) {
      setState({
        toast: isImage
          ? "Pair your desktop or add a provider to send photos."
          : "Files go to your desktop — connect it first.",
      });
      return;
    }
    if (f.size > 12 * 1024 * 1024 && !isImage) {
      setState({ toast: "Files up to 12 MB can be sent." });
      return;
    }
    setSendingFile(true);
    try {
      const note = text.trim();
      setText("");
      const id = uid("m");
      const chatId = st.activeChat;
      const { data, mime, thumb } = isImage
        ? await shrinkImage(f)
        : {
            data: await toBase64(f),
            mime: f.type || "application/octet-stream",
            thumb: undefined,
          };
      const attachment = {
        name: f.name || (isImage ? "photo.jpg" : "file"),
        mime,
        size: Math.round((data.length * 3) / 4),
        thumb,
      };
      const msg: ChatMessage = {
        id,
        role: "user",
        text: note,
        at: Date.now(),
        kind,
        state: online ? "sending" : "done",
        via: online ? "desktop" : "phone",
        chatId,
        attachment,
      };
      setState((s) => ({ messages: [...s.messages, msg] }));
      if (online) {
        const desktopChat = st.chats.find(
          (c) => c.id === chatId && c.origin === "desktop",
        );
        await rpc("file.send", {
          name: attachment.name,
          mime,
          data,
          text: note,
          kind,
          threadId: id,
          ...(desktopChat ? { chatId } : {}),
        });
        setState((s) => ({
          messages: s.messages.map((m) =>
            m.id === id && m.state === "sending"
              ? { ...m, state: "queued" }
              : m,
          ),
        }));
      } else {
        const replyId = `r_${id}`;
        setState((s) => ({
          messages: [
            ...s.messages,
            {
              id: replyId,
              role: "jini",
              text: "",
              at: Date.now(),
              kind: "chat",
              state: "running",
              via: "phone",
              replyTo: id,
              chatId,
            },
          ],
        }));
        try {
          const reply = await askProvider(
            note || "What is in this photo?",
            getState().messages.filter(
              (m) =>
                (m.chatId ?? "") === chatId && m.id !== id && m.id !== replyId,
            ),
            [`data:${mime};base64,${data}`],
          );
          setState((s) => ({
            messages: s.messages.map((m) =>
              m.id === replyId
                ? { ...m, text: reply, state: "done", at: Date.now() }
                : m,
            ),
          }));
        } catch (e) {
          setState((s) => ({
            messages: s.messages.map((m) =>
              m.id === replyId
                ? {
                    ...m,
                    text: e instanceof Error ? e.message : String(e),
                    state: "failed",
                  }
                : m,
            ),
          }));
        }
      }
    } catch (e) {
      setState({
        toast: `Couldn't send: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setSendingFile(false);
    }
  };
  const current = chats.find((c) => c.id === activeChat);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<ChatMessage["kind"]>("chat");
  const end = useRef<HTMLDivElement>(null);

  // Block body on purpose: modern WebViews return a Promise from scrollIntoView, and an
  // effect must return nothing or a cleanup function.
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    if ((await sendText(t, kind)) === null) setText(t);
  };

  return (
    <div className="flex min-h-full flex-col">
      <div className="sticky top-0 z-10 -mx-4 flex items-center justify-between bg-bg/95 px-4 py-2 backdrop-blur-sm">
        <button
          onClick={() => setSheet(true)}
          className="flex min-w-0 items-center gap-1.5 text-[15px] font-medium text-text active:opacity-70"
          aria-label="Switch chat"
        >
          <span className="truncate">{current?.title ?? "Chat"}</span>
          <span className="text-faint" aria-hidden>
            ▾
          </span>
        </button>
        <button
          onClick={() => void newChat(paired && online)}
          className="shrink-0 rounded-lg px-2.5 py-1 text-[14px] font-medium text-muted active:bg-surface-2"
          aria-label="New chat"
        >
          New
        </button>
      </div>
      {voice && <VoiceMode kind={kind} onClose={() => setVoice(false)} />}
      {sheet && (
        <ChatSheet
          chats={chats}
          active={activeChat}
          online={paired && online}
          onClose={() => setSheet(false)}
        />
      )}
      <div className="flex-1 space-y-5 pb-4 pt-3">
        {messages.length === 0 && (
          <Empty
            title="What can I do for you?"
            hint={
              paired
                ? "Ask a question, or switch to Run on desktop to have your computer do the work."
                : "Answers come from your own AI provider until you pair a desktop."
            }
          />
        )}
        {messages.map((m) => {
          // A desktop task is shown as one live activity row; its reply renders inside it.
          if (m.role === "jini" && m.kind === "task" && m.replyTo) return null;
          if (m.role === "user" && m.kind === "task" && m.via === "desktop") {
            return (
              <div key={m.id} className="space-y-2">
                <Message
                  m={{
                    ...m,
                    state:
                      m.state === "queued" || m.state === "sending"
                        ? "done"
                        : m.state,
                  }}
                />
                <TaskActivity
                  msg={m}
                  reply={messages.find((r) => r.replyTo === m.id)}
                />
              </div>
            );
          }
          return <Message key={m.id} m={m} />;
        })}
        <div ref={end} />
      </div>
      <div className="sticky bottom-0 -mx-4 bg-bg px-4 pb-3 pt-2">
        {paired && (
          <div
            className="mb-2.5 inline-flex rounded-xl bg-surface-2 p-1 text-[13px] font-medium"
            role="tablist"
            aria-label="Send as"
          >
            {(["chat", "task"] as const).map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={kind === k}
                onClick={() => setKind(k)}
                className={`rounded-lg px-3.5 py-1.5 transition-colors ${kind === k ? "bg-surface text-text shadow-[0_1px_2px_rgba(60,42,20,0.08)]" : "text-muted"}`}
              >
                {k === "chat" ? "Chat" : "Run on desktop"}
              </button>
            ))}
          </div>
        )}
        <input
          ref={camRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => void attach(e.target.files?.[0])}
        />
        <input
          ref={picRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => void attach(e.target.files?.[0])}
        />
        <input
          ref={fileRef}
          type="file"
          hidden
          onChange={(e) => void attach(e.target.files?.[0])}
        />
        {menu && (
          <div className="mb-2 flex gap-2" role="menu" aria-label="Attach">
            {(
              [
                ["camera", "Camera", camRef],
                ["image", "Photos", picRef],
                ["file", "File", fileRef],
              ] as const
            ).map(([icon, label, ref]) => (
              <button
                key={label}
                role="menuitem"
                className="flex items-center gap-2 rounded-xl bg-surface px-3.5 py-2 text-[14px] text-text shadow-[0_1px_2px_rgba(60,42,20,0.08)] active:bg-surface-2"
                onClick={() => (setMenu(false), ref.current?.click())}
              >
                <Icon name={icon} className="h-4 w-4 text-muted" />
                {label}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <button
            onClick={() => setMenu((v) => !v)}
            aria-label="Attach a photo or file"
            aria-expanded={menu}
            disabled={sendingFile}
            className="flex h-12 w-10 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2 disabled:opacity-40"
          >
            <Icon name="plus" className="h-5 w-5" />
          </button>
          <textarea
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              kind === "task"
                ? "Describe a task for your desktop…"
                : "Message JINI…"
            }
            aria-label={kind === "task" ? "Task for your desktop" : "Message"}
            className="field max-h-36 min-h-[48px] flex-1 resize-none rounded-2xl"
          />
          {!text.trim() ? (
            <button
              onClick={() => setVoice(true)}
              aria-label="Voice mode"
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-ink text-paper transition-colors active:bg-black"
            >
              <Icon name="mic" className="h-5 w-5" />
            </button>
          ) : (
            <button
              onClick={() => void send()}
              disabled={!text.trim()}
              aria-label="Send"
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-ink text-paper transition-colors active:bg-black disabled:bg-surface-2 disabled:text-faint"
            >
              <Icon name="send" className="h-5 w-5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Message({ m }: { m: ChatMessage }) {
  const mine = m.role === "user";
  const meta =
    m.state === "queued"
      ? "Waiting for desktop"
      : m.state === "sending"
        ? "Sending…"
        : m.state === "failed"
          ? "Failed"
          : !mine && m.via === "phone" && m.state === "done"
            ? "Answered on phone"
            : "";

  if (mine) {
    return (
      <div className="flex flex-col items-end">
        {m.kind === "task" && (
          <p className="mb-1 text-meta font-medium text-muted">Desktop task</p>
        )}
        {m.attachment && <Attachment a={m.attachment} />}
        {m.text && (
          <div className="max-w-[82%] rounded-2xl rounded-br-md bg-[#EFE7DA] px-4 py-2.5 text-body text-text">
            <p className="whitespace-pre-wrap">{m.text}</p>
          </div>
        )}
        {meta && (
          <p
            className={`mt-1 text-meta ${m.state === "failed" ? "text-danger" : "text-faint"}`}
          >
            {meta}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="anim-enter max-w-[92%]">
      {m.state === "running" && !m.text ? (
        <p
          className="typing-dots py-2 text-muted"
          role="status"
          aria-label={
            m.via === "phone" ? "Thinking" : "Your desktop is working"
          }
        >
          <span />
          <span />
          <span />
        </p>
      ) : (
        <p
          className={`whitespace-pre-wrap text-body ${m.state === "failed" ? "text-danger" : "text-text"}`}
        >
          {m.text}
        </p>
      )}
      {m.image && (
        <img
          src={m.image}
          alt="Screenshot from your desktop"
          className="mt-2 w-full rounded-xl border border-hairline"
        />
      )}
      {meta && <p className="mt-1 text-meta text-faint">{meta}</p>}
    </div>
  );
}

async function newChat(online: boolean): Promise<void> {
  if (online) {
    try {
      const c = await rpc<{ id: string; title: string; updatedAt: number }>(
        "chats.create",
      );
      setState((s) => ({
        chats: [
          {
            id: c.id,
            title: c.title,
            updatedAt: c.updatedAt,
            origin: "desktop",
          },
          ...s.chats.filter((x) => x.id !== c.id),
        ],
        activeChat: c.id,
      }));
      return;
    } catch {
      /* desktop unreachable: fall back to a phone chat */
    }
  }
  const id = uid("p");
  setState((s) => ({
    chats: [
      { id, title: "New chat", updatedAt: Date.now(), origin: "phone" },
      ...s.chats,
    ],
    activeChat: id,
  }));
}

async function openChat(c: ChatThread, online: boolean): Promise<void> {
  setState({ activeChat: c.id });
  if (c.origin === "desktop" && online)
    await loadDesktopChat(c.id).catch(() => undefined);
}

async function renameChat(c: ChatThread): Promise<void> {
  const title = window.prompt("Rename chat", c.title)?.trim();
  if (!title) return;
  if (c.origin === "desktop") await rpc("chats.rename", { id: c.id, title });
  setState((s) => ({
    chats: s.chats.map((x) => (x.id === c.id ? { ...x, title } : x)),
  }));
}

async function deleteChat(c: ChatThread): Promise<void> {
  if (!window.confirm(`Delete "${c.title}"? This can't be undone.`)) return;
  if (c.origin === "desktop") await rpc("chats.delete", { id: c.id });
  setState((s) => ({
    chats: s.chats.filter((x) => x.id !== c.id),
    messages: s.messages.filter((m) => m.chatId !== c.id),
    activeChat: s.activeChat === c.id ? "" : s.activeChat,
  }));
}

function ChatSheet({
  chats,
  active,
  online,
  onClose,
}: {
  chats: ChatThread[];
  active: string;
  online: boolean;
  onClose: () => void;
}) {
  const sorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
  const act = (fn: () => Promise<void>) => () =>
    void fn().catch((e) =>
      setState({ toast: e instanceof Error ? e.message : String(e) }),
    );
  return (
    <div
      className="fixed inset-0 z-40 flex flex-col justify-end bg-black/25"
      onClick={onClose}
      role="dialog"
      aria-label="Chats"
    >
      <div
        className="max-h-[75vh] overflow-y-auto rounded-t-3xl bg-bg px-4 pb-8 pt-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-hairline" />
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[17px] font-semibold text-text">Chats</p>
          <button
            className="btn-text text-[14px]"
            onClick={act(async () => (await newChat(online), onClose()))}
          >
            New chat
          </button>
        </div>
        <ul className="group-list">
          <li className="group-row">
            <button
              className={`w-full text-left text-body ${active === "" ? "font-medium text-text" : "text-muted"}`}
              onClick={() => (setState({ activeChat: "" }), onClose())}
            >
              Quick chat
            </button>
          </li>
          {sorted.map((c) => (
            <li key={c.id} className="group-row flex items-center gap-3">
              <button
                className={`min-w-0 flex-1 truncate text-left text-body ${c.id === active ? "font-medium text-text" : "text-muted"}`}
                onClick={act(
                  async () => (await openChat(c, online), onClose()),
                )}
              >
                {c.title}
                <span className="ml-2 text-meta text-faint">
                  {c.origin === "desktop" ? "Synced" : "Phone"}
                </span>
              </button>
              <button
                className="text-meta text-muted"
                onClick={act(() => renameChat(c))}
                disabled={c.origin === "desktop" && !online}
              >
                Rename
              </button>
              <button
                className="text-meta text-danger"
                onClick={act(() => deleteChat(c))}
                disabled={c.origin === "desktop" && !online}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Attachment({ a }: { a: NonNullable<ChatMessage["attachment"]> }) {
  if (a.thumb)
    return (
      <img
        src={a.thumb}
        alt={a.name}
        className="mb-1.5 max-h-56 max-w-[70%] rounded-2xl border border-hairline object-cover"
      />
    );
  return (
    <div className="mb-1.5 flex max-w-[82%] items-center gap-2.5 rounded-2xl border border-hairline bg-surface px-3.5 py-2.5">
      <Icon name="file" className="h-5 w-5 shrink-0 text-muted" />
      <span className="min-w-0">
        <span className="block truncate text-body text-text">{a.name}</span>
        <span className="text-meta text-faint">
          {a.size < 1024 * 1024
            ? `${Math.max(1, Math.round(a.size / 1024))} KB`
            : `${(a.size / 1048576).toFixed(1)} MB`}
        </span>
      </span>
    </div>
  );
}

const toBase64 = (f: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error ?? new Error("Could not read the file."));
    r.readAsDataURL(f);
  });

/** Downscale a photo (max 1600 px, JPEG 85%) for sending, plus a small thumbnail for the thread. */
async function shrinkImage(
  f: File,
): Promise<{ data: string; mime: string; thumb: string }> {
  const bmp = await createImageBitmap(f);
  const draw = (max: number, q: number): string => {
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", q);
  };
  const full = draw(1600, 0.85);
  const thumb = draw(360, 0.7);
  bmp.close();
  return { data: full.split(",")[1] ?? "", mime: "image/jpeg", thumb };
}
