import { useEffect, useState } from 'react';

export interface ConfirmRequest {
  id: number;
  title: string;
  detail: string;
}

let queue: ConfirmRequest[] = [];
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const api = () => (window.electronAPI as unknown as { confirm: { reply: (id: number, ok: boolean) => Promise<void> } }).confirm;

export const pendingConfirm = (): ConfirmRequest | undefined => queue[0];

export function pushConfirm(r: ConfirmRequest): void {
  if (queue.some((x) => x.id === r.id)) return;
  queue = [...queue, r];
  emit();
}

export function dropConfirm(id: number): void {
  queue = queue.filter((x) => x.id !== id);
  emit();
}

/** Answer the card on screen (or a specific one). */
export function answerConfirm(ok: boolean, id?: number): void {
  const r = id === undefined ? queue[0] : queue.find((x) => x.id === id);
  if (!r) return;
  dropConfirm(r.id);
  void api().reply(r.id, ok);
}

export function useConfirm(): ConfirmRequest | undefined {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    subs.add(f);
    return () => void subs.delete(f);
  }, []);
  return queue[0];
}

const YES = /^\W*(?:yes|yeah|yep|yup|sure|go ahead|do it|proceed|approve[d]?|allow|confirm|affirmative|please do)\b/i;
const NO = /^\W*(?:no|nope|don'?t|do not|deny|denied|cancel|stop|negative|abort|never ?mind)\b/i;

/** true = approve, false = deny, null = not an answer. */
export const parseYesNo = (t: string): boolean | null => (YES.test(t) ? true : NO.test(t) ? false : null);
