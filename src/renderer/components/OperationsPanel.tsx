import { useCallback, useEffect, useState } from 'react';
import { popModal, pushModal } from '../lib/modalState';
import type { OpsOverview, OpsTaskDetail, OpsTaskView, OpsRoutineView, OpsTimelineEvent, RecoveryStatus } from '../../../src/main/opsCenter';

/**
 * BACKGROUND OPERATIONS CONTROL CENTER (Round 27, §1.3) — the integrated operations view.
 *
 * Every number shown is projected from REAL durable backend state (ops.overview →
 * opsCenter.ts: task store, scheduler + recurring-run records, invocation ledger,
 * episodic outbox, integration registry). Every control invokes the SAME authorized
 * backend pathway the agent uses (task_pause / task_resume / task_cancel and
 * cancel_recurring through the ONE gate) — there are no decorative controls, and
 * progress is never invented: it is the step counters of the durable task records.
 */

const backBtn =
  'no-drag mb-4 inline-flex items-center gap-2 font-display text-[12px] font-bold text-steel transition-colors hover:text-accent outline-none';
const actionBtn =
  'no-drag rounded-sm border border-line px-3 py-1 font-display text-[12px] font-bold text-steel transition-colors hover:border-accent hover:text-accent disabled:opacity-40 disabled:hover:border-line disabled:hover:text-steel';
const dangerBtn =
  'no-drag rounded-sm border border-line px-3 py-1 font-display text-[12px] font-bold text-steel transition-colors hover:border-hot hover:text-hot disabled:opacity-40 disabled:hover:border-line';

const stamp = (t: number | undefined): string => {
  if (!t) return '—';
  const d = new Date(t);
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
};

const statusTone = (status: string): string => {
  if (['RUNNING', 'VERIFYING', 'RETRYING', 'running', 'completed'].includes(status)) return 'text-accent';
  if (['FAILED', 'failed', 'ERROR', 'EXPIRED'].includes(status)) return 'text-hot';
  if (['PAUSED', 'INTERRUPTED', 'RECOVERING', 'paused', 'interrupted'].includes(status)) return 'text-[#A86E1A]';
  if (['COMPLETED', 'AVAILABLE', 'TESTED', 'AUTHENTICATED'].includes(status)) return 'text-[#4F7F55]';
  return 'text-steel';
};

function Bar({ done, total, failed = 0 }: { done: number; total: number; failed?: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 w-full overflow-hidden rounded-full bg-[rgba(176,90,51,0.08)]">
        <div className={`h-full rounded-full ${failed > 0 ? 'bg-hot' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="shrink-0 font-mono text-[12px] text-steel">
        {done}/{total}
        {failed > 0 && <span className="text-hot"> ✗{failed}</span>}
      </span>
    </div>
  );
}

/**
 * ROUND 32 (§6): one integration credential row — save/replace, test, revoke. Only
 * PRESENCE metadata is ever displayed: a stored secret never crosses IPC, so there is
 * nothing to show and nothing to leak. The save field is a password input and is cleared
 * after use.
 */
function CredentialRow({ c }: { c: OpsOverview['credentials'][number] }) {
  const [secret, setSecret] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const api = window.electronAPI.credentials;
  const run = async (fn: () => Promise<{ ok: boolean; reason: string }>): Promise<void> => {
    setBusy(true);
    try {
      const r = await fn();
      setMsg(`${r.ok ? 'OK' : 'FAILED'}: ${r.reason}`);
      setTimeout(() => setMsg(''), 8000);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1">
      <p className="truncate font-mono text-[12px]" title={c.lastTestDetail}>
        <span className={c.stored ? (c.lastTestOk === false ? 'text-hot' : 'text-[#4F7F55]') : c.envAvailable ? 'text-[#A86E1A]' : 'text-steel/70'}>
          {c.stored ? (c.encrypted ? 'stored+encrypted' : 'stored (legacy plaintext)') : c.envAvailable ? 'env only' : 'not configured'}
        </span>{' '}
        · {c.service}
        {c.lastTestedAt ? ` · last test ${c.lastTestOk === true ? 'PASSED' : c.lastTestOk === false ? 'REJECTED' : 'inconclusive'} (${stamp(c.lastTestedAt)})` : ''}
        {!c.encryptionAvailable && <span className="text-[#A86E1A]"> · platform encryption unavailable — saves are refused (env path supported)</span>}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={`${c.service} token (save or replace)`}
          className="w-52 rounded-sm border border-line bg-transparent px-2 py-1 font-mono text-[12px] text-[#1F1B16] outline-none focus:border-accent"
          autoComplete="off"
        />
        <button type="button" className={actionBtn} disabled={busy || !secret.trim() || !c.encryptionAvailable} onClick={() => void run(() => api.set(c.service, secret)).then(() => setSecret(''))}>
          save
        </button>
        <button type="button" className={actionBtn} disabled={busy} onClick={() => void run(() => api.test(c.service))}>
          test
        </button>
        <button type="button" className={dangerBtn} disabled={busy || !c.stored} onClick={() => void run(() => api.revoke(c.service))}>
          revoke
        </button>
      </div>
      {msg && <p className="font-mono text-[12px] text-accent">{msg}</p>}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="rounded-sm border border-line/60 px-3 py-2">
      <div className={`font-mono text-[15px] tabular-nums ${tone ?? 'text-hot'}`}>{value}</div>
      <div className="font-display text-[12px] text-steel">{label}</div>
    </div>
  );
}

/** One durable task row with REAL controls (each button = one authorized backend action). */
function TaskRow({ t, onAction, onOpen }: { t: OpsTaskView; onAction: (id: string, a: 'pause' | 'resume' | 'cancel' | 'retry') => void; onOpen: (id: string) => void }) {
  return (
    <div className="space-y-1.5 rounded-sm border border-line/60 px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 font-mono text-[12px] text-steel">{t.id}</span>
        <span className={`shrink-0 font-mono text-[12px]  ${statusTone(t.status)}`}>{t.status}</span>
        {t.verdict && <span className="shrink-0 font-mono text-[12px] text-steel/70">verdict: {t.verdict}</span>}
        <span className="ml-auto shrink-0 font-mono text-[12px] text-steel/70">{stamp(t.updatedAt)}</span>
      </div>
      <p className="truncate text-[12px] leading-snug text-hot/90" title={t.request}>
        {t.objective}
      </p>
      {t.stepsTotal > 0 && <Bar done={t.stepsDone} total={t.stepsTotal} failed={t.stepsFailed} />}
      {t.delivery && (
        <p className="truncate font-mono text-[12px]" title={`delivery gate: ${t.delivery.gate} — progress comes from the persisted acceptance criteria, never an optimistic estimate`}>
          <span className={GATE_TONE[t.delivery.gate] ?? 'text-steel'}>gate {t.delivery.gate}</span>
          {' · criteria '}
          <span className={t.delivery.criteriaSatisfied === t.delivery.criteriaTotal ? 'text-[#4F7F55]' : 'text-[#A86E1A]'}>{t.delivery.criteriaSatisfied}/{t.delivery.criteriaTotal}</span>
          {t.delivery.deliverablesTotal > 0 && (
            <>
              {' · deliverables '}
              <span className={t.delivery.deliverablesVerified === t.delivery.deliverablesTotal ? 'text-[#4F7F55]' : 'text-[#A86E1A]'}>{t.delivery.deliverablesVerified}/{t.delivery.deliverablesTotal}</span>
            </>
          )}
        </p>
      )}
      {t.currentStep && <p className="truncate font-mono text-[12px] text-accent/80" title={t.currentStep}>▶ {t.currentStep}</p>}
      {t.note && <p className="truncate font-mono text-[12px] text-steel/80" title={t.note}>{t.note}</p>}
      <div className="flex items-center gap-2 pt-0.5">
        <button type="button" className={actionBtn} disabled={!t.canPause} onClick={() => onAction(t.id, 'pause')}>
          Pause
        </button>
        <button type="button" className={actionBtn} disabled={!t.canResume} onClick={() => onAction(t.id, 'resume')}>
          Resume
        </button>
        <button type="button" className={dangerBtn} disabled={!t.canCancel} onClick={() => onAction(t.id, 'cancel')}>
          Cancel
        </button>
        <button type="button" className={actionBtn} disabled={!t.canRetry} onClick={() => onAction(t.id, 'retry')} title="Start a NEW task from the same request — the failed record stays as history">
          Retry
        </button>
        <button type="button" className={actionBtn} onClick={() => onOpen(t.id)}>
          Details
        </button>
      </div>
    </div>
  );
}

function TaskGroup({ title, tasks, onAction, onOpen }: { title: string; tasks: OpsTaskView[]; onAction: (id: string, a: 'pause' | 'resume' | 'cancel' | 'retry') => void; onOpen: (id: string) => void }) {
  if (!tasks.length) return null;
  return (
    <div className="space-y-1.5">
      <h3 className="font-display text-[12px] font-bold text-steel">
        {title} <span className="text-steel/60">({tasks.length})</span>
      </h3>
      {tasks.map((t) => (
        <TaskRow key={t.id} t={t} onAction={onAction} onOpen={onOpen} />
      ))}
    </div>
  );
}

function RoutineRow({ r, onAction }: { r: OpsRoutineView; onAction: (id: string, a: 'enable' | 'disable' | 'cancel') => void }) {
  return (
    <div className="space-y-1.5 rounded-sm border border-line/60 px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className={`shrink-0 font-mono text-[12px]  ${r.enabled ? 'text-accent' : 'text-steel'}`}>{r.enabled ? 'ENABLED' : 'DISABLED'}</span>
        <span className="shrink-0 font-mono text-[12px] text-steel">{r.every}</span>
        {r.lastError ? <span className="truncate font-mono text-[12px] text-hot" title={r.lastError}>last run FAILED</span> : r.lastResult ? <span className="truncate font-mono text-[12px] text-steel/80">ran {r.runCount}×</span> : <span className="font-mono text-[12px] text-steel/60">never ran yet</span>}
      </div>
      <p className="truncate text-[12px] leading-snug text-hot/90" title={r.task}>
        {r.task}
      </p>
      <p className="font-mono text-[12px] text-steel">next occurrence: {stamp(r.nextDue)}</p>
      {r.recentRuns.length > 0 && (
        <ol className="space-y-0.5">
          {r.recentRuns.map((run) => (
            <li key={run.id} className="truncate font-mono text-[12px]" title={`${run.recoveryNote ?? ''} ${run.error ?? run.reply ?? ''}`}>
              <span className={statusTone(run.status)}>{run.status}</span>
              {run.recovered ? <span className="text-[#A86E1A]"> (recovered)</span> : ''} · occurrence {stamp(run.occurrence)} · attempt {run.attempts}
              {run.error ? <span className="text-hot"> · {run.error}</span> : ''}
            </li>
          ))}
        </ol>
      )}
      <div className="flex items-center gap-2 pt-0.5">
        {r.enabled ? (
          <button type="button" className={actionBtn} onClick={() => onAction(r.id, 'disable')}>
            Disable
          </button>
        ) : (
          <button type="button" className={actionBtn} onClick={() => onAction(r.id, 'enable')}>
            Enable
          </button>
        )}
        <button type="button" className={dangerBtn} onClick={() => onAction(r.id, 'cancel')}>
          Remove
        </button>
      </div>
    </div>
  );
}

const VERIFICATION_GLYPH: Record<string, { g: string; cls: string }> = {
  verified: { g: '✓', cls: 'text-[#4F7F55]' },
  partial: { g: '◐', cls: 'text-[#A86E1A]' },
  unverified: { g: '○', cls: 'text-steel' },
  unknown: { g: '?', cls: 'text-steel' },
  unresolved: { g: '?', cls: 'text-[#A86E1A]' },
  failed: { g: '✗', cls: 'text-hot' },
};

/**
 * ROUND 35 (Phase 6): delivery-state glyphs. Incomplete and unverified work is visually
 * distinct from completed work: satisfied = solid check, failed = cross, pending/unverified
 * = hollow dot, in_progress/blocked = amber half-state. Every value comes from the main
 * process's PERSISTED delivery record — the renderer never computes optimistic progress.
 */
const DELIVERY_GLYPH: Record<string, { g: string; cls: string }> = {
  satisfied: { g: '✓', cls: 'text-[#4F7F55]' },
  verified: { g: '✓', cls: 'text-[#4F7F55]' },
  failed: { g: '✗', cls: 'text-hot' },
  unverified: { g: '○', cls: 'text-[#A86E1A]' },
  produced: { g: '◐', cls: 'text-[#A86E1A]' },
  blocked: { g: '◑', cls: 'text-[#A86E1A]' },
  in_progress: { g: '◐', cls: 'text-accent' },
  pending: { g: '○', cls: 'text-steel' },
  planned: { g: '○', cls: 'text-steel' },
  not_applicable: { g: '–', cls: 'text-steel/60' },
  skipped: { g: '–', cls: 'text-steel/60' },
};

const GATE_TONE: Record<string, string> = {
  complete: 'text-[#4F7F55]',
  partial: 'text-[#A86E1A]',
  blocked: 'text-[#A86E1A]',
  failed: 'text-hot',
  untracked: 'text-steel/60',
};

/**
 * ROUND 35 (Phase 6) — the compact DELIVERY section of a task's expanded detail: outcome,
 * acceptance criteria, deliverables, evidence, change summary and recovery state, in the
 * panel's existing visual language. Nothing here is decorative: absent blocks simply do
 * not render, and unverified/incomplete rows stay visually open.
 */
function DeliverySection({ d }: { d: NonNullable<OpsTaskDetail['delivery']> }) {
  const g = (s: string) => DELIVERY_GLYPH[s] ?? { g: '·', cls: 'text-steel' };
  return (
    <div className="space-y-2 border-l-2 border-accent/30 pl-2">
      <h4 className="font-display text-[12px] font-bold text-steel">
        Delivery · gate{' '}
        <span className={GATE_TONE[d.gate.state] ?? 'text-steel'}>{d.gate.state.toUpperCase()}</span>
        {d.gate.unsatisfied.length > 0 && <span className="ml-1 font-mono text-[12px] normal-case text-steel/70" title={d.gate.unsatisfied.join(' · ')}>({d.gate.unsatisfied.length} open)</span>}
      </h4>
      {d.criteria.length > 0 && (
        <div className="space-y-0.5">
          {d.criteria.map((c, i) => (
            <p key={`c-${i}`} className="font-mono text-[12px]" title={c.lastCheck ?? c.detail}>
              <span className={g(c.status).cls}>{g(c.status).g}</span>{' '}
              <span className={`${g(c.status).cls} `}>{c.status}</span>
              <span className={c.mandatory ? 'text-hot/80' : 'text-steel/70'}>{c.mandatory ? ' *' : ''}</span>
              <span className="text-steel"> · {c.detail}</span>
            </p>
          ))}
          <p className="font-mono text-[12px] text-steel/60">* mandatory — the task cannot complete while any of these is open</p>
        </div>
      )}
      {d.deliverables.length > 0 && (
        <div className="space-y-0.5">
          <p className="font-display text-[12px] text-steel/80">Deliverables</p>
          {d.deliverables.map((x) => (
            <p key={x.id} className="truncate font-mono text-[12px]" title={`${x.verification ?? ''} ${x.failure ?? ''}`}>
              <span className={g(x.status).cls}>{g(x.status).g}</span>{' '}
              <span className={`${g(x.status).cls} `}>{x.status}</span>
              <span className="text-steel"> · {x.description}</span>
              {x.path ? <span className="text-steel/60"> · {x.path}</span> : ''}
            </p>
          ))}
        </div>
      )}
      <p className="font-mono text-[12px] text-steel" title={d.evidence.recent.map((e) => `${e.what}: ${e.detail}`).join('\n')}>
        evidence: <span className={d.evidence.failed ? 'text-hot' : 'text-steel'}>{d.evidence.total} record(s)</span>
        {' · '}{d.evidence.ok} ok{d.evidence.stale ? <span className="text-[#A86E1A]"> · {d.evidence.stale} stale</span> : ''}
        {d.evidence.failed ? <span className="text-hot"> · {d.evidence.failed} failed check(s)</span> : ''}
      </p>
      {d.changes && (
        <p className="font-mono text-[12px] text-steel" title={[...d.changes.filesCreated, ...d.changes.filesModified, ...d.changes.filesDeleted].join(', ')}>
          changes: <span className="text-[#4F7F55]">+{d.changes.filesCreated.length}</span>{' '}
          <span className="text-accent">~{d.changes.filesModified.length}</span>{' '}
          <span className="text-hot">-{d.changes.filesDeleted.length}</span>
          {d.changes.commands.length ? ` · ${d.changes.commands.length} check command(s)` : ''}
          {d.changes.externalOps.length ? ` · ${d.changes.externalOps.length} external op(s)` : ''}
          {d.changes.userTouchedSuspects.length ? <span className="text-[#A86E1A]"> · {d.changes.userTouchedSuspects.length} file(s) changed after the task's last write (user/external)</span> : ''}
        </p>
      )}
      {d.review && (
        <p className="font-mono text-[12px]" title={`criteria: ${d.review.criteriaState} · failures: ${d.review.verificationFailures} · deps: ${d.review.unresolvedDeps}`}>
          <span className={d.review.readyToHandOver ? 'text-[#4F7F55]' : 'text-[#A86E1A]'}>{d.review.readyToHandOver ? 'ready to hand over' : 'NOT ready to hand over'}</span>
          <span className="text-steel"> · {d.review.criteriaState}</span>
        </p>
      )}
      {(d.recovery.canResume || d.recovery.reconciliationRequired || d.recovery.approvalRequired) && (
        <p className="font-mono text-[12px] text-[#A86E1A]">
          recovery: {d.recovery.canResume ? 'resumable' : 'not resumable'}
          {d.recovery.reconciliationRequired ? ' · reconciliation required (unknown outcomes or stale evidence)' : ''}
          {d.recovery.approvalRequired ? ' · waiting for your input' : ''}
        </p>
      )}
    </div>
  );
}

function Timeline({ events }: { events: OpsTimelineEvent[] }) {
  if (!events.length) return <p className="font-mono text-[12px] text-steel">No events recorded.</p>;
  return (
    <ol className="space-y-1">
      {events.map((e, i) => (
        <li key={`${e.at}-${i}`} className="flex items-baseline gap-2 font-mono text-[12px]">
          <span className="shrink-0 text-steel/60">{stamp(e.at)}</span>
          <span className={e.kind === 'verdict' || e.kind === 'verification' ? statusTone(e.label.includes('FAILED') ? 'failed' : 'completed') : 'text-steel'}>{e.label}</span>
          {e.detail && <span className="truncate text-steel/60" title={e.detail}>{e.detail}</span>}
        </li>
      ))}
    </ol>
  );
}

/** Expanded task details: steps with evidence, verification verdicts, execution timeline. */
function TaskDetail({ detail }: { detail: OpsTaskDetail }) {
  return (
    <div className="space-y-3 rounded-sm border border-accent/30 bg-[rgba(251,248,242,0.55)] px-3 py-3">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[12px] text-accent">{detail.id}</span>
        <span className={`font-mono text-[12px]  ${statusTone(detail.status)}`}>{detail.status}</span>
        {detail.verdict && <span className="font-mono text-[12px] text-steel">verdict: {detail.verdict}</span>}
        <span className="ml-auto font-mono text-[12px] text-steel/70">
          retries {detail.retries} · replans {detail.replans} · plan v{detail.planVersion}
        </span>
      </div>
      <p className="text-[12px] leading-snug text-hot/90">{detail.request}</p>
      {detail.delegation && (
        <p className="font-mono text-[12px] text-steel">
          strategy: {detail.delegation.strategy}
          {detail.delegation.kind ? ` (${detail.delegation.kind})` : ''} — {detail.delegation.reasons.join('; ')}
        </p>
      )}
      <div className="space-y-1.5">
        <h4 className="font-display text-[12px] font-bold text-steel">Steps & evidence</h4>
        {detail.steps.length === 0 && <p className="font-mono text-[12px] text-steel">No steps recorded.</p>}
        {detail.steps.map((s) => {
          const vg = s.verification ? VERIFICATION_GLYPH[s.verification.status] ?? { g: '·', cls: 'text-steel' } : null;
          return (
            <div key={s.id} className="space-y-0.5 border-l border-line pl-2">
              <div className="flex items-baseline gap-2">
                <span className={`font-mono text-[12px] ${s.status === 'running' ? 'animate-pulse text-accent' : s.status === 'done' ? 'text-[#4F7F55]' : s.status === 'failed' ? 'text-hot' : 'text-steel'}`}>{s.status === 'done' ? '✓' : s.status === 'failed' ? '✗' : s.status === 'running' ? '●' : '○'}</span>
                <span className="truncate text-[12px] text-hot/80" title={s.title}>{s.title}</span>
                <span className="ml-auto shrink-0 font-mono text-[12px] text-steel/60">{s.kind} · {s.attempts}×</span>
              </div>
              {s.result && <p className="truncate font-mono text-[12px] text-steel/80" title={s.result}>{s.result}</p>}
              {s.outcomeUnknown && <p className="font-mono text-[12px] text-[#A86E1A]">outcome unknown (interrupted mid-flight — reconciled)</p>}
              {vg && s.verification && (
                <p className="font-mono text-[12px]" title={`${s.verification.method}: ${s.verification.observed} — evidence: ${s.verification.evidence}`}>
                  <span className={vg.cls}>{vg.g} {s.verification.status.toUpperCase()}</span>
                  <span className="text-steel/70"> · {s.verification.method} · {s.verification.observed}</span>
                </p>
              )}
            </div>
          );
        })}
      </div>
      {detail.delivery && <DeliverySection d={detail.delivery} />}
      <div className="space-y-1">
        <h4 className="font-display text-[12px] font-bold text-steel">Timeline</h4>
        <Timeline events={detail.timeline} />
      </div>
      {detail.invocations.length > 0 && (
        <div className="space-y-1">
          <h4 className="font-display text-[12px] font-bold text-steel">Tool executions (this session's ledger)</h4>
          {detail.invocations.slice(-12).map((r) => (
            <p key={r.id} className="truncate font-mono text-[12px]" title={r.detail}>
              <span className={r.state === 'completed' ? 'text-[#4F7F55]' : r.state === 'failed' || r.state === 'blocked' ? 'text-hot' : 'text-steel'}>{r.state}</span> · {r.tool}
              {r.ms !== undefined ? ` · ${r.ms}ms` : ''}
              {r.detail ? ` · ${r.detail}` : ''}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

type Tab = 'operations' | 'routines' | 'history' | 'approvals';

export default function OperationsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = useState<OpsOverview | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('operations');
  const [openDetail, setOpenDetail] = useState<string | null>(null);
  const [detail, setDetail] = useState<OpsTaskDetail | null>(null);
  const [flash, setFlash] = useState('');
  const [recovery, setRecovery] = useState<RecoveryStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      const ov = (await window.electronAPI.ops.overview()) as OpsOverview;
      setData(ov);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    try {
      const rv = (await window.electronAPI.ops.recoveryStatus()) as RecoveryStatus;
      setRecovery(rv);
    } catch {
      setRecovery(null); // recovery view is additive; its failure must not break the overview
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    pushModal();
    void refresh();
    // Event-driven refresh: the existing progress push channel + a slow interval fallback.
    const off = window.electronAPI.on('jarvis-progress', () => void refresh());
    const iv = setInterval(() => void refresh(), 10_000);
    return () => {
      off();
      clearInterval(iv);
      popModal();
    };
  }, [open, refresh]);

  useEffect(() => {
    if (!openDetail) {
      setDetail(null);
      return;
    }
    void window.electronAPI.ops
      .task(openDetail)
      .then((d) => setDetail(d as OpsTaskDetail | null))
      .catch(() => setDetail(null));
  }, [openDetail, data]);

  const act = useCallback(
    async (id: string, a: 'pause' | 'resume' | 'cancel' | 'retry') => {
      try {
        const msg = await window.electronAPI.ops.taskAction(id, a);
        setFlash(msg.slice(0, 220));
      } catch (e) {
        setFlash(`NOT DONE: ${e instanceof Error ? e.message : String(e)}`.slice(0, 220));
      }
      void refresh();
    },
    [refresh]
  );

  const routineAct = useCallback(
    async (id: string, a: 'enable' | 'disable' | 'cancel') => {
      try {
        const msg = await window.electronAPI.ops.routineAction(id, a);
        setFlash(msg.slice(0, 220));
      } catch (e) {
        setFlash(`NOT DONE: ${e instanceof Error ? e.message : String(e)}`.slice(0, 220));
      }
      void refresh();
    },
    [refresh]
  );

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(''), 6000);
    return () => clearTimeout(t);
  }, [flash]);

  if (!open) return null;
  const tabBtn = (t: Tab, label: string) => (
    <button type="button" onClick={() => setTab(t)} className={`no-drag font-display text-[12px] font-bold transition-colors ${tab === t ? 'text-accent' : 'text-steel hover:text-steel/80'}`}>
      {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(52,38,24,0.22)]" onClick={onClose}>
      <div className="holo-panel no-drag relative z-10 flex max-h-[86vh] w-full max-w-[760px] flex-col overflow-hidden rounded-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-accent/20 px-5 pb-2 pt-3">
          <div className="flex items-baseline gap-4">
            <h2 className="font-display text-[12px] font-bold text-accent/90">Operations</h2>
            <nav className="flex items-center gap-3">
              {tabBtn('operations', 'Active')}
              {tabBtn('routines', 'Routines')}
              {tabBtn('history', 'History')}
              {tabBtn('approvals', 'Gate')}
            </nav>
          </div>
          <button type="button" onClick={onClose} aria-label="Close operations center" className="no-drag grid h-7 w-7 place-items-center text-steel transition-colors hover:text-accent">
            ✕
          </button>
        </div>

        {flash && <p className="border-b border-line/40 px-5 py-1.5 font-mono text-[12px] text-accent/90">{flash}</p>}
        {error && <p className="border-b border-line/40 px-5 py-1.5 font-mono text-[12px] text-hot">backend error: {error}</p>}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!data ? (
            <p className="py-8 text-center font-mono text-[12px] text-steel">Loading operations state…</p>
          ) : tab === 'operations' ? (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                <Stat label="running" value={data.tasks.running.length} tone="text-accent" />
                <Stat label="queued" value={data.tasks.queued.length} />
                <Stat label="paused" value={data.tasks.paused.length} tone="text-[#A86E1A]" />
                <Stat label="interrupted" value={data.tasks.interrupted.length} tone="text-[#A86E1A]" />
                <Stat label="routines" value={`${data.routines.enabled}/${data.routines.total}`} />
                <Stat label="tool calls" value={data.resources.toolCalls} />
              </div>

              {/* R28 §5.3: browser-session health — the REAL native session state */}
              <div className="space-y-1 rounded-sm border border-line/60 px-3 py-2">
                <h3 className="font-display text-[12px] font-bold text-steel">Native browser</h3>
                <p className="font-mono text-[12px] text-steel">
                  {data.browser.connected
                    ? <span className="text-[#4F7F55]">CONNECTED</span>
                    : <span className="text-steel">DISCONNECTED</span>}
                  {data.browser.mode ? ` · mode ${data.browser.mode}` : ''}
                  {data.browser.browserName ? ` · ${data.browser.browserName}` : ''}
                  {data.browser.sessionId ? ` · ${data.browser.sessionId}` : ''}
                  {data.browser.lastDisconnect ? <span className="text-hot"> · last disconnect: {data.browser.lastDisconnect}</span> : ''}
                </p>
              </div>

              {/* R29 §5.3: real system resources — live OS/process readings, nothing simulated */}
              {data.system && (
                <p className="font-mono text-[12px] text-steel/80">
                  SYSTEM · {data.system.platform} · {data.system.cpuCount} cpus · mem {Math.max(0, data.system.memoryTotalMb - data.system.memoryFreeMb)}/{data.system.memoryTotalMb} MB used
                  {data.system.loadAvg ? ` · load ${data.system.loadAvg.join(' ')}` : ''} · engine rss {data.system.processRssMb} MB · up {data.system.uptimeHours} h
                </p>
              )}

              {/* R28 §5.3/§5.4: recovery engine — plans, history, budget, and the user switch */}
              {recovery && (
                <div className="space-y-1.5 rounded-sm border border-line/60 px-3 py-2">
                  <div className="flex items-baseline gap-3">
                    <h3 className="font-display text-[12px] font-bold text-steel">Recovery</h3>
                    <label className="ml-auto flex items-center gap-1 font-mono text-[12px] text-steel" title="When on, the supervisor runs the ELIGIBLE bounded recoveries itself (memory re-drain, managed-browser reconnect, occurrence recovery) within the hourly budget. Everything is recorded below.">
                      <input
                        type="checkbox"
                        className="jini-check"
                        checked={recovery.settings.autoRecovery}
                        onChange={(e) => void window.electronAPI.ops.recoverySettings({ autoRecovery: e.target.checked }).then(() => refresh())}
                      />
                      automatic recovery
                    </label>
                  </div>
                  <p className="font-mono text-[12px] text-steel">budget: {recovery.budget.used}/{recovery.budget.max} automatic actions this hour</p>
                  {recovery.openIssues.length === 0 && <p className="font-mono text-[12px] text-steel/70">No open issues — nothing to recover.</p>}
                  {recovery.openIssues.map((i, n) => (
                    <div key={`${i.about}-${n}`} className="space-y-0.5 rounded-sm border border-line/40 px-2 py-1.5">
                      <p className="truncate font-mono text-[12px]" title={i.detail}>
                        <span className={i.severity === 'crit' ? 'text-hot' : 'text-[#A86E1A]'}>{i.severity === 'crit' ? 'CRITICAL' : 'warning'}</span> · {i.kind} · {i.about}
                      </p>
                      <p className="truncate font-mono text-[12px] text-steel" title={i.detail}>{i.detail}</p>
                      <div className="flex items-baseline gap-2">
                        <p className={`min-w-0 flex-1 truncate font-mono text-[12px] ${i.plan.eligible ? 'text-accent' : 'text-steel/70'}`} title={i.plan.reason}>
                          {i.plan.eligible ? `recoverable: ${i.plan.action}` : 'needs you'} — {i.plan.reason}
                        </p>
                        {i.plan.eligible && (
                          <button type="button" className={actionBtn} onClick={() => void window.electronAPI.ops.recoveryRun(i.about).then((m) => { setFlash(m); return refresh(); })}>
                            recover
                          </button>
                        )}
                      </div>
                      {i.plan.userAction && <p className="font-mono text-[12px] text-steel/80">what you can do: {i.plan.userAction}</p>}
                    </div>
                  ))}
                  {recovery.history.length > 0 && (
                    <p className="font-mono text-[12px] text-steel/70" title={recovery.history.map((h) => `${new Date(h.at).toLocaleTimeString()} · ${h.action} → ${h.outcome}: ${h.detail}`).join('\n')}>
                      recent: {recovery.history.slice(0, 3).map((h) => `${h.action} → ${h.outcome}`).join(' | ')}
                    </p>
                  )}
                </div>
              )}

              {data.health.issues.length > 0 && (
                <div className="space-y-1 rounded-sm border border-[rgba(168,110,26,0.4)] px-3 py-2">
                  <h3 className="font-display text-[12px] font-bold text-[#A86E1A]">Operational health ({data.health.issues.length})</h3>
                  {data.health.issues.map((i, n) => (
                    <p key={`${i.kind}-${i.about}-${n}`} className="truncate font-mono text-[12px]" title={i.detail}>
                      <span className={i.severity === 'crit' ? 'text-hot' : 'text-[#A86E1A]'}>{i.severity === 'crit' ? 'CRITICAL' : 'warning'}</span> · {i.kind} · {i.about} — {i.detail}
                    </p>
                  ))}
                </div>
              )}

              {data.tasks.running.length + data.tasks.queued.length + data.tasks.waiting.length + data.tasks.paused.length + data.tasks.interrupted.length === 0 && (
                <p className="py-2 text-[12px] text-steel">No active background operations. Start durable work with a request, or schedule a routine.</p>
              )}
              <TaskGroup title="Running" tasks={data.tasks.running} onAction={act} onOpen={setOpenDetail} />
              <TaskGroup title="Queued" tasks={data.tasks.queued} onAction={act} onOpen={setOpenDetail} />
              <TaskGroup title="Waiting for input" tasks={data.tasks.waiting} onAction={act} onOpen={setOpenDetail} />
              <TaskGroup title="Paused" tasks={data.tasks.paused} onAction={act} onOpen={setOpenDetail} />
              <TaskGroup title="Interrupted / recovering" tasks={data.tasks.interrupted} onAction={act} onOpen={setOpenDetail} />

              {data.agents.views.length > 0 && (
                <div className="space-y-1">
                  <h3 className="font-display text-[12px] font-bold text-steel">Agents ({data.agents.active} active)</h3>
                  {data.agents.views.map((a) => (
                    <p key={a.id} className="truncate font-mono text-[12px] text-steel" title={a.note}>
                      <span className={a.status === 'running' ? 'animate-pulse text-accent' : 'text-steel/70'}>{a.status}</span> · {a.agent} · {a.note}
                    </p>
                  ))}
                </div>
              )}

              <div className="space-y-1 rounded-sm border border-line/60 px-3 py-2">
                <h3 className="font-display text-[12px] font-bold text-steel">Memory outbox</h3>
                <p className="font-mono text-[12px] text-steel">
                  pending episodes {data.memory.pendingEpisodes} · recorded {data.memory.recordedEpisodes} · failed {data.memory.failedEpisodes}
                  {data.memory.failures.length > 0 && <span className="text-hot"> — latest: {data.memory.failures[data.memory.failures.length - 1]?.lastError}</span>}
                </p>
              </div>
            </div>
          ) : tab === 'routines' ? (
            <div className="space-y-3">
              {data.routines.items.length === 0 && <p className="text-[12px] text-steel">No recurring routines configured. Ask JINI to schedule one ("run the project health check every morning").</p>}
              {data.routines.items.map((r) => (
                <RoutineRow key={r.id} r={r} onAction={routineAct} />
              ))}
            </div>
          ) : tab === 'history' ? (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                <Stat label="completed" value={data.executions.completed} tone="text-[#4F7F55]" />
                <Stat label="failed" value={data.executions.failed} tone="text-hot" />
                <Stat label="interrupted" value={data.executions.interrupted} tone="text-[#A86E1A]" />
                <Stat label="cancelled" value={data.executions.cancelled} />
                <Stat label="recovered" value={data.executions.recovered} tone="text-[#A86E1A]" />
              </div>
              <div className="space-y-1">
                <h3 className="font-display text-[12px] font-bold text-steel">Recurring occurrences (durable records)</h3>
                {data.routines.items.every((r) => r.recentRuns.length === 0) && <p className="font-mono text-[12px] text-steel">No occurrences recorded yet.</p>}
                {data.routines.items.map((r) =>
                  r.recentRuns.map((run) => (
                    <p key={run.id} className="truncate font-mono text-[12px]" title={`${run.recoveryNote ?? ''} ${run.error ?? run.reply ?? ''}`}>
                      <span className={statusTone(run.status)}>{run.status}</span>
                      {run.recovered ? <span className="text-[#A86E1A]"> (recovered)</span> : ''} · {r.task.slice(0, 48)} · occurrence {stamp(run.occurrence)}
                      {run.error ? <span className="text-hot"> · {run.error}</span> : ''}
                    </p>
                  ))
                )}
              </div>
              <div className="space-y-1">
                <h3 className="font-display text-[12px] font-bold text-steel">Scheduled follow-ups</h3>
                {data.scheduled.recentDone.length === 0 && <p className="font-mono text-[12px] text-steel">None recorded.</p>}
                {data.scheduled.recentDone.map((s) => (
                  <p key={s.id} className="truncate font-mono text-[12px]">
                    <span className={statusTone(s.status)}>{s.status}</span> · {s.task} · due {stamp(s.due)}
                    {s.error ? <span className="text-hot"> · {s.error}</span> : ''}
                  </p>
                ))}
              </div>
              <div className="space-y-1">
                <h3 className="font-display text-[12px] font-bold text-steel">Recent tasks</h3>
                {data.tasks.recent.map((t) => (
                  <button key={t.id} type="button" onClick={() => setOpenDetail(t.id)} className="block w-full truncate text-left font-mono text-[12px] text-steel hover:text-accent" title={`${t.objective} — ${t.note}`}>
                    <span className={statusTone(t.status)}>{t.status}</span> · {t.id} · {t.objective}
                    {t.verdict ? ` · ${t.verdict}` : ''}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-[12px] leading-snug text-steel">
                The permission gate runs autonomously: every operation is allowed or refused immediately under the existing policy. The ONLY interactive approvals are
                consequential actions (browser submissions, GitHub writes, deployments): they wait for YOUR approval in the native system confirmation dialog — the card in the
                JINI window is informational. Everything below is real recorded state.
              </p>
              {(data.approvals.pendingInteractive ?? 0) > 0 && (
                <p className="rounded-sm border border-[#A86E1A]/50 px-3 py-2 font-mono text-[12px] text-[#A86E1A]">
                  {data.approvals.pendingInteractive} approval request(s) WAITING{data.approvals.nativeOpen ? ` · ${data.approvals.nativeOpen} system confirmation dialog(s) open` : ''} — approve or deny via the system dialog.
                </p>
              )}
              {data.approvals.auditFailures > 0 && (
                <p className="rounded-sm border border-hot/60 px-3 py-2 font-mono text-[12px] text-hot" title={data.approvals.auditLastError}>
                  APPROVAL AUDIT: {data.approvals.auditFailures} failed write(s) — approvals are fail-closed while the audit trail is broken{data.approvals.auditLastError ? ` (last error: ${data.approvals.auditLastError})` : ''}.
                </p>
              )}
              {data.approvals.recent.length > 0 && (
                <div className="space-y-1">
                  {data.approvals.recent.map((e) => (
                    <p key={`${e.id}-${e.at}`} className="truncate font-mono text-[12px]" title={e.detail}>
                      <span className={e.event === 'approved' || e.event === 'consumed' ? 'text-[#4F7F55]' : e.event === 'denied' || e.event === 'dismissed' ? 'text-hot' : 'text-steel'}>{e.event.toUpperCase()}</span> · {e.tool} · {e.action} · {e.origin} · “{e.targetLabel}”
                      {e.detail ? <span className="text-steel/70"> — {e.detail}</span> : ''}
                    </p>
                  ))}
                </div>
              )}
              {data.integrations.filter((i) => !i.available).length === 0 && data.approvals.recent.length === 0 && <p className="font-mono text-[12px] text-steel">No pending approvals and no failed validations recorded.</p>}
              <div className="space-y-1 rounded-sm border border-line/60 px-3 py-2">
                <h3 className="font-display text-[12px] font-bold text-steel">Execution boundaries (Round 33 — real enforcement state)</h3>
                <p className="font-mono text-[12px] text-steel" title={data.boundaries.filesRootCanonical ? `canonical: ${data.boundaries.filesRootCanonical}` : 'canonical path not resolvable'}>
                  workspace: {data.boundaries.filesRoot}
                  {data.boundaries.filesRootCanonical ? ` (canonical: ${data.boundaries.filesRootCanonical})` : ' (canonical path not resolvable)'}
                </p>
                <p className="font-mono text-[12px] text-steel">
                  filesystem boundary: <span className={data.boundaries.filesystemEnforcement === 'active' ? 'text-[#4F7F55]' : 'text-steel/70'}>{data.boundaries.filesystemEnforcement === 'active' ? 'ACTIVE' : 'standby (no project-bound task running)'}</span>
                  {' · '}project-bound tasks: {data.boundaries.boundTasks.length}
                </p>
                {data.boundaries.boundTasks.map((b) => (
                  <p key={b.taskId} className="truncate font-mono text-[12px] text-steel/80" title={`workspace: ${b.root} (canonical: ${b.real})`}>
                    · task {b.taskId} bound to {b.root}
                  </p>
                ))}
                <p className="font-mono text-[12px] text-steel" title={data.boundaries.shellIsolation.mechanism}>
                  shell isolation [{data.boundaries.shellIsolation.platform}]: <span className={data.boundaries.shellIsolation.mode === 'os-sandbox' ? 'text-[#4F7F55]' : 'text-[#A86E1A]'}>{data.boundaries.shellIsolation.mode}</span> — {data.boundaries.shellIsolation.mechanism}
                </p>
                {data.boundaries.shellIsolation.probed && (
                  <p className="font-mono text-[12px] text-steel" title="The mount probe validated the REAL sandbox layout: namespace, toolchain, workspace mount, write access, isolation, cwd, child inheritance">
                    mount probe: {data.boundaries.shellIsolation.probePassed === true ? <span className="text-[#4F7F55]">PASSED (all steps)</span> : data.boundaries.shellIsolation.probePassed === false ? <span className="text-hot">FAILED — os-sandbox NOT claimed</span> : <span className="text-steel/70">no probe result</span>}
                  </p>
                )}
                {data.boundaries.shellIsolation.probeSteps && data.boundaries.shellIsolation.probeSteps.length > 0 && (
                  <p className="font-mono text-[12px] text-steel/70" title={data.boundaries.shellIsolation.probeSteps.map((s) => `${s.step}: ${s.ok ? 'ok' : `FAILED${s.detail ? ` — ${s.detail}` : ''}`}`).join(' | ')}>
                    probe steps: {data.boundaries.shellIsolation.probeSteps.map((s) => `${s.ok ? '·' : '×'}${s.step}`).join(' ')}
                  </p>
                )}
                <p className="font-mono text-[12px] text-steel/70" title="Real counters from the project-bound shell gate and the sandbox launcher">
                  project-bound shell: {data.boundaries.shellIsolation.refusedCommands} refused command(s) · {data.boundaries.shellIsolation.sandboxFailures} sandbox launch failure(s) (never retried unrestricted)
                </p>
                {data.boundaries.shellIsolation.warning && (
                  <p className="font-mono text-[12px] text-hot" title={data.boundaries.shellIsolation.warning}>
                    WARNING: {data.boundaries.shellIsolation.warning}
                  </p>
                )}
              </div>
              <div className="space-y-1 rounded-sm border border-line/60 px-3 py-2">
                <h3 className="font-display text-[12px] font-bold text-steel">Browser security (Round 33 — approvals &amp; refusals)</h3>
                <p className="font-mono text-[12px] text-steel">
                  session: {data.browserSecurity.connected ? <span className="text-[#4F7F55]">CONNECTED</span> : <span className="text-steel/70">disconnected</span>}
                  {data.browserSecurity.mode ? ` · mode ${data.browserSecurity.mode}` : ''}
                  {data.browserSecurity.sessionId ? ` · ${data.browserSecurity.sessionId}` : ''}
                  {' · pending approvals: '}{data.browserSecurity.pendingApprovals}
                  {data.browserSecurity.nativeOpen ? ` · ${data.browserSecurity.nativeOpen} system dialog(s) open` : ''}
                </p>
                <p className="font-mono text-[12px] text-steel" title="Every consequential submission is planned, approved BEFORE any value enters the page, re-verified against the approved fingerprint (complete payload + exact submitter), submitted once, and verified afterwards">
                  submission security: planned → approved (system dialog) → re-verified (complete payload + exact submitter) → submitted once (requestSubmit only) → verified; mismatches refuse
                </p>
                <p className="font-mono text-[12px] text-steel">
                  refusals: target/payload changed {data.browserSecurity.refusals.targetOrPayloadMismatch} · submitter changed {data.browserSecurity.refusals.submitterMismatch} · stale target {data.browserSecurity.refusals.staleTarget} · ambiguous/hidden {data.browserSecurity.refusals.ambiguousOrHiddenTarget} · missing approval {data.browserSecurity.refusals.approvalRefusals} · inspection limit {data.browserSecurity.refusals.inspectionLimitRefusals} · submission-mechanism failures {data.browserSecurity.refusals.submissionMechanismFailures}
                </p>
                <p className="font-mono text-[12px] text-steel/70" title="Real approval lifecycle counters from the one approval authority">
                  approvals: {data.browserSecurity.pendingApprovals} pending · {data.browserSecurity.nativeOpen} native dialog(s) open · {data.browserSecurity.consumedApprovals} consumed (single-use) · {data.browserSecurity.approvedSubmissions} approved submission(s) executed
                </p>
                <p className="font-mono text-[12px] text-steel/70">
                  payload binding: complete browser-native successful controls (no silent truncation) · submitter bound by exact DOM identity · passwords/hidden values as keyed digests · inspection limits REFUSE, never truncate
                </p>
                <p className="font-mono text-[12px] text-steel/70">
                  honest limit: JINI cannot intercept every arbitrary network request a page's own JavaScript initiates — it protects every JINI-controlled submission route.
                </p>
              </div>
              <div className="space-y-1 rounded-sm border border-line/60 px-3 py-2">
                <h3 className="font-display text-[12px] font-bold text-steel">IPC trust (Round 34 — exact trusted renderer resource)</h3>
                <p className="font-mono text-[12px] text-steel" title="Only a main frame of this app's own window, loaded from this EXACT resource, may invoke sensitive IPC channels (approvals, credentials)">
                  validation mode: {data.ipcTrust.mode === 'packaged' ? 'PACKAGED (exact bundled renderer entry)' : data.ipcTrust.mode === 'development' ? 'DEVELOPMENT (configured dev-server origin)' : 'UNCONFIGURED'}
                </p>
                <p className="truncate font-mono text-[12px] text-steel/70" title={data.ipcTrust.expectedRenderer}>
                  trusted renderer: {data.ipcTrust.expectedRenderer || '(not recorded)'}
                </p>
                <p className="font-mono text-[12px] text-steel" title="Real counter — incremented at the actual refusal site in the main process">
                  refused untrusted IPC attempts: {data.ipcTrust.refusedAttempts}
                  {data.ipcTrust.lastRefusal ? ` · last: ${data.ipcTrust.lastRefusal.detail}` : ''}
                </p>
              </div>
              <div className="space-y-1 rounded-sm border border-line/60 px-3 py-2">
                <h3 className="font-display text-[12px] font-bold text-steel">Integration credentials (presence only — values never stored in the workspace)</h3>
                <p className="font-mono text-[12px] text-steel/70" title="How many secret values (credential-shaped arguments, secret-shaped substrings) the receipt layer has actually redacted from durable records — a real counter, not a metric">
                  secret redactions applied to durable records: {data.redaction.applied}
                </p>
                {data.credentials.map((c) => (
                  <CredentialRow key={c.service} c={c} />
                ))}
              </div>
              <div className="space-y-1 rounded-sm border border-line/60 px-3 py-2">
                <h3 className="font-display text-[12px] font-bold text-steel">Workflows (durable journal)</h3>
                {data.workflows.journalError && <p className="font-mono text-[12px] text-hot">journal write failure: {data.workflows.journalError}</p>}
                {data.workflows.unknownOutcomes > 0 && (
                  <p className="font-mono text-[12px] text-[#A86E1A]">{data.workflows.unknownOutcomes} UNKNOWN external outcome(s) — reconcile against the real system before any retry.</p>
                )}
                {data.workflows.recent.length === 0 && <p className="font-mono text-[12px] text-steel">No workflow events recorded yet.</p>}
                {data.workflows.recent.map((e, n) => (
                  <p key={`${e.at}-${n}`} className="truncate font-mono text-[12px]" title={e.detail}>
                    <span className={e.outcome === 'executed-verified' ? 'text-[#4F7F55]' : e.outcome === 'unknown' ? 'text-[#A86E1A]' : e.outcome === 'failed' ? 'text-hot' : 'text-steel'}>{e.kind}</span> · {e.stage}
                    {e.outcome ? ` · ${e.outcome}` : ''} · {e.detail}
                  </p>
                ))}
              </div>
              <div className="space-y-1 rounded-sm border border-line/60 px-3 py-2">
                <h3 className="font-display text-[12px] font-bold text-steel">Integrations</h3>
                {data.integrations.map((i) => (
                  <p key={i.id} className="truncate font-mono text-[12px]" title={i.reason}>
                    <span className={statusTone(i.phase)}>{i.phase}</span> · {i.name}
                    {i.available ? '' : <span className="text-steel/70"> — {i.reason}</span>}
                  </p>
                ))}
              </div>
            </div>
          )}

          {openDetail && detail && (
            <div className="mt-4">
              <button type="button" className={backBtn} onClick={() => setOpenDetail(null)}>
                ← Back to operations
              </button>
              <TaskDetail detail={detail} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
