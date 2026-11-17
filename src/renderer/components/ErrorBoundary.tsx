import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * THE LAST LINE OF THE NO-DEAD-END GUARANTEE.
 *
 * Before this boundary, a throw inside ANY component (a malformed push nobody guarded,
 * a division by a field that was supposed to exist) unmounted the whole React tree and
 * left the HUD permanently blank — the one dead end no repair layer could reach, because
 * the repair layer itself was gone. Now a crash is contained to a minimal recovery card:
 * "Try again" resets the crashed subtree, "Reload HUD" rebuilds the renderer from disk.
 * JARVIS keeps working in the main process either way.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[hud] renderer crash contained:', error.message, info.componentStack ?? '');
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="fixed inset-0 z-[999] flex flex-col items-center justify-center gap-4 bg-[#04070d] p-8 text-center">
        <div className="font-display text-[11px] font-bold uppercase tracking-[0.3em] text-amber-300">
          System fault contained
        </div>
        <p className="max-w-md text-sm leading-relaxed text-steel">
          A display component failed, but the crash was stopped here so nothing else was affected.
          JINI is still running in the background.
        </p>
        <p className="max-w-md break-all font-mono text-[11px] text-steel/60">{error.message}</p>
        <div className="mt-2 flex gap-3">
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="rounded border border-accent px-4 py-1.5 text-xs font-semibold uppercase tracking-widest text-accent hover:bg-white/10"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded border border-steel/40 px-4 py-1.5 text-xs font-semibold uppercase tracking-widest text-steel hover:bg-white/10"
          >
            Reload HUD
          </button>
        </div>
      </div>
    );
  }
}
