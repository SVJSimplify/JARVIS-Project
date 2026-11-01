import { useState, type FormEvent } from 'react';

interface Props {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  busy?: boolean;
  compact?: boolean;
}

export default function TextCommand({ onSubmit, disabled, busy, compact }: Props) {
  const [value, setValue] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const text = value.trim();
    if (!text || disabled) return;
    onSubmit(text);
    setValue('');
  };

  return (
    <form onSubmit={handleSubmit} className={`flex items-center gap-3 border-b border-line focus-within:border-accent ${compact ? 'w-[calc(100%-2.5rem)]' : 'w-[min(30rem,80vw)]'}`}>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={disabled}
        placeholder={busy ? 'Type to interrupt…' : 'Or type a request…'}
        aria-label="Type a request"
        autoComplete="off"
        spellCheck={false}
        className={`min-w-0 flex-1 bg-transparent text-hot outline-none placeholder:text-steel/70 ${compact ? 'py-1 text-[14px]' : 'py-2 text-[17px]'}`}
      />
      <button
        type="submit"
        disabled={disabled || !value.trim()}
        className={`${compact ? 'text-xs' : 'text-sm'} font-semibold tracking-widest text-accent transition-opacity hover:text-hot disabled:opacity-30`}
      >
        {busy ? 'INTERRUPT' : 'SEND'}
      </button>
    </form>
  );
}
