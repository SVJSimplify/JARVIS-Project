/**
 * The operations a paired phone may call, mapped onto JINI's existing desktop capabilities.
 * Nothing here re-implements a feature: chat goes through the same provider loop (so the
 * desktop plans, delegates and records history exactly as for a typed request), memory
 * through the memory tools, tasks through the coordinator, approvals through the approval
 * service's audited paired-device path.
 *
 * Long-running work (chat, remote tasks) is accepted immediately and its result is delivered
 * as a sync event, so a phone request never has to stay open for an agent turn.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { FILES_ROOT } from '../workspace';
import { nativeImage } from 'electron';
import { chat } from '../provider';
import { peekTurnShot } from '../vision';
import { chatTurns, createChat, deleteChat, getActiveChatId, listChats, renameChat } from '../history';
import { taskViews } from '../taskStore';
import { cancelTask, pauseTask } from '../coordinator';
import { forgetMemoryById, listAllMemories, memoryCategoryById, memoryTools } from '../memory';
import { pendingApprovalViews, respondApprovalFromPairedDevice } from '../approval';
import { listConversations } from '../history';
import type { DeviceHub, OpHandler } from './deviceHub';
import { randomB64u } from './link';

const MAX_TEXT = 8000;

const text = (v: unknown, what: string): string => {
  const t = String(v ?? '').trim();
  if (!t) throw new Error(`${what} is required`);
  if (t.length > MAX_TEXT) throw new Error(`${what} is too long`);
  return t;
};

export function buildDeviceOps(hub: () => DeviceHub): Record<string, OpHandler> {
  /** Run one desktop turn for the phone; the reply arrives as a 'chat' event. */
  const runTurn = (prompt: string, meta: Record<string, unknown>, chatId?: string, images: string[] = []): { accepted: true; turnId: string } => {
    const turnId = `turn_${randomB64u(9)}`;
    hub().append('chat', { ...meta, turnId, state: 'running' });
    void chat(prompt, () => undefined, undefined, { source: 'interactive', ...(chatId ? { chatId } : {}), ...(images.length ? { images } : {}) })
      .then((reply) => {
        // The turn's last screenshot travels with the reply, downscaled for the phone.
        let image: string | undefined;
        const shot = peekTurnShot();
        if (shot) {
          try {
            const img = nativeImage.createFromDataURL(shot);
            image = `data:image/jpeg;base64,${(img.getSize().width > 900 ? img.resize({ width: 900 }) : img).toJPEG(68).toString('base64')}`;
          } catch {
            image = undefined;
          }
        }
        hub().append('chat', { ...meta, turnId, state: 'done', reply, ...(image ? { image } : {}) });
      })
      .catch((e: unknown) => hub().append('chat', { ...meta, turnId, state: 'failed', error: e instanceof Error ? e.message : String(e) }));
    return { accepted: true, turnId };
  };

  return {
    ping: () => ({ time: Date.now() }),

    chat: (args, ctx) => {
      const t = text(args.text, 'Message');
      const chatId = typeof args.chatId === 'string' && args.chatId ? args.chatId.slice(0, 80) : undefined;
      return runTurn(t, { kind: 'chat', threadId: String(args.threadId ?? ''), chatId: chatId ?? '', from: ctx.deviceName, text: t }, chatId);
    },

    'task.send': (args, ctx) => {
      const t = text(args.text, 'Task');
      const prompt =
        `The user sent this request from their phone ("${ctx.deviceName}") for you to carry out on this desktop. ` +
        'If it needs more than one step, run it as a durable background task with start_task; then reply in one sentence saying what you started.\n\n' +
        t;
      const chatId = typeof args.chatId === 'string' && args.chatId ? args.chatId.slice(0, 80) : undefined;
      return runTurn(prompt, { kind: 'task', threadId: String(args.threadId ?? ''), chatId: chatId ?? '', from: ctx.deviceName, text: t }, chatId);
    },

    'chats.list': async () => ({ active: await getActiveChatId(), chats: await listChats() }),
    'chats.turns': (args) => chatTurns(text(args.id, 'Chat id')).then((t) => t.slice(-60)),
    'chats.create': () => createChat(),
    'chats.rename': async (args) => (await renameChat(text(args.id, 'Chat id'), text(args.title, 'Title')), { ok: true }),
    'chats.delete': async (args) => (await deleteChat(text(args.id, 'Chat id')), { ok: true }),

    /** A photo or file from the phone: saved to the workspace inbox, images also go to the model. */
    'file.send': async (args, ctx) => {
      const name = [...String(args.name ?? 'file')].map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? '_' : ch)).join('').slice(0, 120) || 'file';
      const mime = String(args.mime ?? 'application/octet-stream').slice(0, 100);
      const data = Buffer.from(String(args.data ?? ''), 'base64');
      if (!data.length) throw new Error('The file was empty.');
      if (data.length > 12 * 1024 * 1024) throw new Error('Files up to 12 MB can be sent.');
      const dir = path.join(FILES_ROOT, 'inbox', 'phone');
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${name}`);
      await fs.writeFile(file, data);
      const isImage = /^image\/(jpeg|png|webp|gif)$/.test(mime);
      const note = typeof args.text === 'string' ? args.text.trim().slice(0, MAX_TEXT) : '';
      const prompt =
        `${note || (isImage ? 'Here is a photo from my phone.' : 'Here is a file from my phone.')}\n\n` +
        `[Attachment from "${ctx.deviceName}": ${name} (${mime}, ${Math.round(data.length / 1024)} KB) saved at ${file}${isImage ? ' — the image is attached to this message' : ' — read it with your file tools if needed'}.]`;
      const chatId = typeof args.chatId === 'string' && args.chatId ? args.chatId.slice(0, 80) : undefined;
      const kind = args.kind === 'task' ? 'task' : 'chat';
      return { saved: file, ...runTurn(prompt, { kind, threadId: String(args.threadId ?? ''), chatId: chatId ?? '', from: ctx.deviceName, text: note || name }, chatId, isImage ? [`data:${mime};base64,${data.toString('base64')}`] : []) };
    },

    'tasks.list': () => taskViews(),
    'task.cancel': (args) => ({ ok: cancelTask(text(args.id, 'Task id')) }),
    'task.pause': (args) => ({ ok: pauseTask(text(args.id, 'Task id')) }),

    'memory.list': () => listAllMemories(),
    'memory.search': (args) => memoryTools.find_memory.run({ query: text(args.query, 'Query'), limit: 10 }),
    'memory.add': async (args) => {
      const out = await memoryTools.remember.run({ fact: text(args.fact, 'Memory'), category: String(args.category ?? 'fact') });
      hub().append('memory', { change: 'added' });
      return out;
    },
    'memory.forget': async (args) => {
      if (!(await forgetMemoryById(text(args.id, 'Memory id')))) throw new Error('That memory no longer exists.');
      hub().append('memory', { change: 'removed' });
      return { ok: true };
    },
    /** User correction: replace one memory (by id) with corrected wording, keeping its category. */
    'memory.correct': async (args) => {
      const id = text(args.id, 'Memory id');
      const next = text(args.fact, 'Corrected memory');
      const category = (await memoryCategoryById(id)) ?? 'fact';
      if (!(await forgetMemoryById(id))) throw new Error('That memory no longer exists.');
      const out = await memoryTools.remember.run({ fact: next, category: category === 'contact' || category === 'task' ? 'fact' : category });
      hub().append('memory', { change: 'corrected' });
      return out;
    },

    'approvals.list': () => pendingApprovalViews(),
    'approval.respond': (args, ctx) => {
      const decision = args.decision === 'approve' ? 'approve' : 'deny';
      return respondApprovalFromPairedDevice(text(args.id, 'Approval id'), decision, ctx.deviceName);
    },

    'conversations.recent': async () =>
      (await listConversations())
        .slice(-40)
        .map((t) => ({ t: t.t, user: t.user.slice(0, 2000), reply: t.reply.slice(0, 4000), error: t.error })),
  };
}
