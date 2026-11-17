import { useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { InteractionMode } from '../lib/protocol';

interface Props {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  busy?: boolean;
  compact?: boolean;
  /** Left side of the toolbar (the microphone). */
  leading?: ReactNode;
  /** Live (captions + voice while working) vs Quiet (one notification when done). */
  mode?: InteractionMode;
  onModeChange?: (m: InteractionMode) => void;
}

/**
 * The composer: one elevated card — the message on top, a toolbar beneath (mic and voice
 * status, Live/Quiet, send). Enter sends, Shift+Enter adds a line. While JINI works,
 * sending interrupts it with the new request.
 */
export default function TextCommand({ onSubmit, disabled, busy, compact, leading, mode, onModeChange }: Props) {
  const [value, setValue] = useState('');

  const send = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSubmit(text);
    setValue('');
  };
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    send();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const sendButton = (
    <button
      type="submit"
      disabled={disabled || !value.trim()}
      aria-label={busy ? 'Interrupt and send' : 'Send'}
      title={busy ? 'Interrupt and send' : 'Send (Enter)'}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ink text-paper transition-[background-color,transform] hover:bg-black active:scale-95 disabled:bg-surface-2 disabled:text-faint"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m5 12 7-7 7 7" />
        <path d="M12 19V5" />
      </svg>
    </button>
  );

  if (compact) {
    return (
      <form onSubmit={handleSubmit} className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl border border-hairline bg-surface py-1.5 pl-2 pr-1.5">
        {leading}
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled}
          placeholder={busy ? 'Type to interrupt…' : 'Message JINI…'}
          aria-label="Message JINI"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent py-1 text-[13.5px] text-text outline-none placeholder:text-faint"
        />
        {sendButton}
      </form>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="w-full rounded-[22px] border border-hairline bg-surface shadow-[0_1px_2px_rgba(60,42,20,0.05),0_10px_30px_rgba(60,42,20,0.07)] transition-[border-color,box-shadow] focus-within:border-sand focus-within:shadow-[0_1px_2px_rgba(60,42,20,0.06),0_14px_36px_rgba(60,42,20,0.1)]"
    >
      <textarea
        rows={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKey}
        disabled={disabled}
        placeholder={busy ? 'Type to interrupt JINI with something new…' : 'Ask JINI anything, or describe a task…'}
        aria-label="Message JINI"
        autoComplete="off"
        spellCheck={false}
        className="block max-h-48 min-h-[56px] w-full resize-none bg-transparent px-5 pb-1 pt-4 text-[15px] leading-6 text-text outline-none placeholder:text-faint [field-sizing:content]"
      />
      <div className="flex items-center gap-2 px-3 pb-3 pt-1">
        {leading}
        <div className="ml-auto flex items-center gap-2">
          {mode && onModeChange && (
            <div className="flex rounded-full bg-surface-2 p-0.5 text-[12px] font-medium" role="radiogroup" aria-label="While JINI works">
              {(['interactive', 'background'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  onClick={() => onModeChange(m)}
                  title={m === 'interactive' ? 'Live — captions and voice while JINI works (Ctrl+Alt+B)' : 'Quiet — JINI works silently and notifies you when done (Ctrl+Alt+B)'}
                  className={`rounded-full px-3 py-1 transition-colors ${mode === m ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(60,42,20,0.08)]' : 'text-muted hover:text-ink'}`}
                >
                  {m === 'interactive' ? 'Live' : 'Quiet'}
                </button>
              ))}
            </div>
          )}
          {sendButton}
        </div>
      </div>
    </form>
  );
}
