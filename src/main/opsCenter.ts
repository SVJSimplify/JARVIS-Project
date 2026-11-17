import { ACTIVE_STATUSES, getTask, listTasks, validVerification, type TaskRecord } from './taskStore';
import { listRecurring, listScheduled } from './scheduler';
import { pendingEpisodeSummary, processPendingEpisodes, waitForDrainIdleForTests } from './episodicMemory';
import { invocationScopes, queryInvocations } from './invocations';
import { agentViews } from './agentTracker';
import { coordinatorCapacity } from './coordinator';
import { connectionState, listIntegrations } from './integrations';
import { runToolDetailed } from './tools';
import { atomicWrite, loadJson, withStoreLock } from './store';
import { FILES_ROOT, boundWorkspacesList } from './workspace';
import { promises as fsp } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { lastSessionRecord, reconnectNativeBrowser, isNativeConnected, nativeSessionInfo, browserSecurityCounters } from './nativeBrowser';
import { redactionHealth } from './toolRecord';
import { probeShellIsolation, shellIsolationCapability } from './shellIsolation';
import { recoverRecurringRuns, listRecurringRuns } from './scheduler';
import { recentApprovalEvents, approvalSecuritySnapshot, approvalConsumedCount } from './approval';
import { ipcTrustHealth } from './ipcTrust';
import { credentialInfo } from './credentials';
import { workflowJournalView, unknownOutcomes as journalUnknownOutcomes, journalHealth, type WorkflowJournalEntry } from './workflowJournal';
import { deliveryView, type DeliveryView } from './delivery';

/**
 * BACKGROUND OPERATIONS CONTROL CENTER (Round 27, §1.3 / §2) — the read/aggregation API
 * behind the user-facing operations interface.
 *
 * This module owns NO new state: every view is projected from the EXISTING durable stores
 * (task store, scheduler + recurring-run records, invocation ledger, episodic outbox,
 * integration registry), and every control invokes the EXISTING authorized pathway
 * (`task_pause` / `task_resume` / `task_cancel` through the ONE central dispatch, exactly
 * like the agent's own tools). There is no duplicate task state and no second engine —
 * the renderer observes and drives, never re-records.
 */

export interface OpsTaskView {
  id: string;
  objective: string;
  request: string;
  status: string;
  verdict?: string;
  note: string;
  stepsDone: number;
  stepsFailed: number;
  stepsTotal: number;
  /** Current step title (actual execution state, never an invented percentage). */
  currentStep?: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  /** True when a pause/resume-relevant action is available right now. */
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
  /** R27 §2.3: FAILED tasks can be retried (a NEW task from the same spec — the failed record stays as history). */
  canRetry: boolean;
  /** ROUND 35 (Phase 6): the persisted delivery progress — the lists never show 100% while
   *  mandatory criteria remain unsatisfied; undefined for lightweight tasks (untracked). */
  delivery?: {
    gate: 'complete' | 'partial' | 'blocked' | 'failed' | 'untracked';
    criteriaSatisfied: number;
    criteriaTotal: number;
    deliverablesVerified: number;
    deliverablesTotal: number;
  };
}

const clip = (s: string | undefined, n: number): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

const taskView = (t: TaskRecord): OpsTaskView => {
  const done = t.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const failed = t.steps.filter((s) => s.status === 'failed').length;
  const running = t.steps.find((s) => s.status === 'running');
  const driven = t.status === 'RUNNING' || t.status === 'VERIFYING' || t.status === 'RETRYING';
  return {
    id: t.id,
    objective: clip(t.spec.objective, 160),
    request: clip(t.spec.request, 400),
    status: t.status,
    verdict: t.verdict,
    note: clip(t.note, 220),
    stepsDone: done,
    stepsFailed: failed,
    stepsTotal: t.steps.length,
    currentStep: running ? clip(running.title, 120) : undefined,
    attempts: t.retries,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    endedAt: t.endedAt,
    canPause: driven,
    canResume: t.status === 'PAUSED' || t.status === 'INTERRUPTED' || t.status === 'RECOVERING',
    canCancel: ACTIVE_STATUSES.includes(t.status) || t.status === 'PAUSED' || t.status === 'INTERRUPTED',
    canRetry: t.status === 'FAILED',
    // ROUND 35 (Phase 6): computed from the PERSISTED delivery block (no I/O, no invention).
    ...(t.delivery
      ? (() => {
          const d = t.delivery!;
          const fileGate = d.deliverables.filter((x) => !!x.path);
          const gateState = (() => {
            const sat = d.criteria.filter((c) => c.status === 'satisfied' || c.status === 'not_applicable').length;
            const ver = fileGate.filter((x) => x.status === 'verified' || x.status === 'skipped').length;
            if (sat === d.criteria.length && ver === fileGate.length && d.criteria.length + fileGate.length > 0) return 'complete' as const;
            const uncertain = d.criteria.some((c) => c.status === 'blocked') || fileGate.some((x) => x.status === 'blocked') || t.steps.some((s) => s.outcomeUnknown);
            if (uncertain) return 'blocked' as const;
            if (sat + ver > 0) return 'partial' as const;
            return 'failed' as const;
          })();
          return {
            delivery: {
              gate: gateState,
              criteriaSatisfied: d.criteria.filter((c) => c.status === 'satisfied' || c.status === 'not_applicable').length,
              criteriaTotal: d.criteria.length,
              deliverablesVerified: fileGate.filter((x) => x.status === 'verified' || x.status === 'skipped').length,
              deliverablesTotal: fileGate.length,
            },
          };
        })()
      : {}),
  };
};

export interface OpsRoutineView {
  id: string;
  task: string;
  every: string;
  enabled: boolean;
  nextDue: number;
  runCount: number;
  lastRunAt?: number;
  lastResult?: string;
  lastError?: string;
  recentRuns: Array<{ id: string; occurrence: number; status: string; startedAt?: number; finishedAt?: number; attempts: number; error?: string; reply?: string; recovered?: boolean; recoveryNote?: string }>;
}

const everyText = (e: { kind: string; minutes?: number; at?: string; weekday?: number; tz?: string }): string => {
  const zone = e.kind !== 'interval' && e.tz ? ` in ${e.tz}` : '';
  if (e.kind === 'interval') return `every ${e.minutes} min`;
  if (e.kind === 'daily') return `daily at ${e.at}${zone}`;
  const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return `weekly on ${names[e.weekday ?? 0]} at ${e.at}${zone}`;
};

export interface OpsOverview {
  generatedAt: number;
  tasks: {
    running: OpsTaskView[];
    queued: OpsTaskView[];
    waiting: OpsTaskView[];
    paused: OpsTaskView[];
    interrupted: OpsTaskView[];
    recent: OpsTaskView[];
  };
  counts: { active: number; paused: number; interrupted: number; recovering: number; terminal: number };
  scheduled: { pending: number; recentDone: Array<{ id: string; task: string; due: number; status: string; ranAt?: number; error?: string }> };
  routines: { total: number; enabled: number; failing: number; items: OpsRoutineView[] };
  executions: { completed: number; failed: number; interrupted: number; recovered: number; cancelled: number };
  agents: { active: number; views: Array<{ id: string; agent: string; status: string; note: string; startedAt: number }> };
  capacity: { active: number; max: number; free: number };
  resources: { toolCalls: number; running: number; completed: number; failed: number; blocked: number; cancelled: number; distinctTools: number };
  memory: { pendingEpisodes: number; recordedEpisodes: number; failedEpisodes: number; failures: Array<{ id: string; lastError?: string; attempts: number }> };
  integrations: Array<{ id: string; name: string; phase: string; available: boolean; reason: string; staleCheck?: boolean }>;
  /** R27 §6.5: operational health — measurable issues detected by the supervision pass. */
  health: { issues: Array<{ kind: string; severity: string; about: string; detail: string }> };
  /** R28 §5.3: browser-session health — the real native-browser session state, never invented. */
  browser: { connected: boolean; mode?: string; browserName?: string; sessionId?: string; lastDisconnect?: string };
  /** R28 §5.3: recovery engine — settings, budget consumption and the recent ledger. */
  recovery: { autoRecovery: boolean; budgetUsed: number; budgetMax: number; recent: Array<{ at: number; action: string; outcome: string; issueKind: string; detail: string }> };
  /**
   * ROUND 29 (§5.3): REAL resource usage — measured from the OS and the process
   * (os.totalmem/freemem, load average where the platform provides it, the engine's own
   * memory footprint and uptime). No decorative or simulated metrics: every number is a
   * live reading taken when the overview was generated.
   */
  system: {
    platform: string;
    cpuCount: number;
    loadAvg: Array<number> | null;
    memoryTotalMb: number;
    memoryFreeMb: number;
    processRssMb: number;
    processHeapUsedMb: number;
    uptimeHours: number;
  };
  /**
   * ROUND 29 (§1.1/§5.3): the approval surface — the §1.1 user-approval requests and
   * decisions, PLUS the gate's recent refusals from the durable ledger (the R27 surface,
   * preserved: the permission gate still decides allow/deny immediately, and its refusals
   * remain visible). Replaces the Round 27–28 hard-coded `pendingInteractive: 0`.
   *
   * ROUND 32 (§6): the security state of the approval pipeline itself — the native
   * confirmation state, the durable-audit health and the refusal reasons (the WHY of
   * every decision), all from real state.
   */
  approvals: {
    pendingInteractive: number;
    nativeOpen: number;
    auditFailures: number;
    auditLastError?: string;
    recent: Array<{ at: number; id: string; event: string; tool: string; action: string; origin: string; targetLabel: string; detail?: string }>;
    recentBlocked: Array<{ id: number; tool: string; at: number; detail?: string }>;
  };
  /** ROUND 32 (§6): integration credential presence + encryption status — never a value. */
  credentials: Array<{
    service: string;
    stored: boolean;
    encrypted: boolean;
    envAvailable: boolean;
    encryptionAvailable: boolean;
    lastTestedAt?: number;
    lastTestOk?: boolean;
    lastTestDetail?: string;
    envKeys: string[];
  }>;
  /** ROUND 32 (§6): workflow visibility — the durable journal's recent entries and the
   *  unknown outcomes still requiring reconciliation. */
  workflows: {
    journalError?: string;
    unknownOutcomes: number;
    recent: Array<{ at: number; kind: string; stage: string; detail: string; outcome?: string; taskId?: string }>;
  };
  /**
   * ROUND 33 (Phase 6) — EXECUTION BOUNDARIES: the real filesystem/workspace boundary
   * state and the honest shell-isolation capability of THIS machine. Every value is
   * measured from live application state; nothing simulated.
   */
  boundaries: {
    /** The Jarvis-Files workspace (display path + canonical real path where resolvable). */
    filesRoot: string;
    filesRootCanonical?: string;
    /** Project-bound tasks active in THIS process (durable task id → workspace). */
    boundTasks: Array<{ taskId: string; root: string; real: string; boundAt: number }>;
    /** 'active' while at least one task binding enforces the boundary at the resolvers. */
    filesystemEnforcement: 'active' | 'standby';
    /** The measured shell-isolation capability (never claimed beyond the platform). */
    shellIsolation: {
      platform: string;
      mode: string;
      mechanism: string;
      probed: boolean;
      warning?: string;
      /** ROUND 34 (§2.2): whether the COMPLETE real mount-layout probe passed. */
      probePassed?: boolean;
      /** ROUND 34 (§2.2): the per-step probe results (empty when no probe ran). */
      probeSteps?: Array<{ step: string; ok: boolean; detail?: string }>;
      /** ROUND 34 (Phase 6): project-bound commands the verifier refused (real counter). */
      refusedCommands: number;
      /** ROUND 34 (Phase 6): sandbox launches that failed at runtime (never retried). */
      sandboxFailures: number;
    };
  };
  /**
   * ROUND 33 (Phase 6) — BROWSER SECURITY: the real approval/refusal state of the native
   * browser pipeline, from the enforcement counters and the live session state.
   * ROUND 34 (Phase 6): payload-binding completeness, submitter verification, submission
   * mechanism failures and consumed approvals — all from real counters/records.
   */
  browserSecurity: {
    connected: boolean;
    mode?: string;
    sessionId?: string;
    pendingApprovals: number;
    nativeOpen: number;
    consumedApprovals: number;
    refusals: {
      targetOrPayloadMismatch: number;
      submitterMismatch: number;
      staleTarget: number;
      ambiguousOrHiddenTarget: number;
      approvalRefusals: number;
      inspectionLimitRefusals: number;
      submissionMechanismFailures: number;
    };
    approvedSubmissions: number;
  };
  /** ROUND 33 (Phase 6): real redaction activity observed by the receipt layer. */
  redaction: { applied: number };
  /**
   * ROUND 34 (Phase 6) — IPC TRUST: the real packaged-vs-development validation mode, the
   * EXACT trusted renderer resource, and the count of refused untrusted IPC attempts.
   */
  ipcTrust: {
    mode: 'packaged' | 'development' | 'unconfigured';
    expectedRenderer: string;
    refusedAttempts: number;
    lastRefusal?: { at: number; detail: string };
  };
}

const RECENT_TERMINAL = 8;

/** The full operations overview — every number from a real durable record. */
export async function opsOverview(): Promise<OpsOverview> {
  const all = await listTasks();
  const byUpdate = [...all].sort((a, b) => b.updatedAt - a.updatedAt);
  const running = byUpdate.filter((t) => ['RUNNING', 'VERIFYING', 'RETRYING'].includes(t.status)).map(taskView);
  const queued = byUpdate.filter((t) => ['CREATED', 'PLANNING', 'READY'].includes(t.status)).map(taskView);
  const waiting = byUpdate.filter((t) => t.status === 'WAITING_FOR_INPUT').map(taskView);
  const paused = byUpdate.filter((t) => t.status === 'PAUSED').map(taskView);
  const interrupted = byUpdate.filter((t) => ['INTERRUPTED', 'RECOVERING'].includes(t.status)).map(taskView);
  const terminal = byUpdate.filter((t) => !ACTIVE_STATUSES.includes(t.status) && t.status !== 'PAUSED').slice(0, RECENT_TERMINAL).map(taskView);

  const routines = await listRecurring();
  const runs = await listRecurringRuns();
  const routineItems: OpsRoutineView[] = routines.map((t) => ({
    id: t.id,
    task: t.task,
    every: everyText(t.every),
    enabled: t.enabled,
    nextDue: t.nextDue,
    runCount: t.runCount,
    lastRunAt: t.lastRunAt,
    lastResult: t.lastResult,
    lastError: t.lastError,
    recentRuns: runs
      .filter((r) => r.routineId === t.id)
      .slice(0, 5)
      .map((r) => ({ id: r.id, occurrence: r.occurrence, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, attempts: r.attempts, error: r.error, reply: r.reply, recovered: r.recovered, recoveryNote: r.recoveryNote })),
  }));

  const scheduled = await listScheduled();
  const pendingScheduled = scheduled.filter((t) => t.status === 'pending');

  // execution history across ALL recurring runs + one-shot scheduled outcomes (durable records)
  const executions = {
    completed: runs.filter((r) => r.status === 'completed').length + scheduled.filter((t) => t.status === 'done').length,
    failed: runs.filter((r) => r.status === 'failed').length + scheduled.filter((t) => t.status === 'failed').length,
    interrupted: runs.filter((r) => r.recovered === true).length,
    recovered: runs.filter((r) => r.status === 'completed' && r.recovered === true).length,
    cancelled: runs.filter((r) => r.status === 'cancelled').length + scheduled.filter((t) => t.status === 'cancelled').length,
  };

  const ledger = queryInvocations({ scope: 'all', offset: 0, limit: 400 });
  // the gate's recent refusals (R27 surface, preserved) — real ledger records
  const blocked = ledger.records.filter((r) => r.state === 'blocked').slice(-6).reverse();

  const integrations = await Promise.all(
    listIntegrations().map(async (d) => {
      const st = await connectionState(d.id);
      return { id: d.id, name: d.name, phase: st.phase, available: st.available, reason: st.reason };
    })
  );

  const summaryAll = ledger.records.length ? { ...ledgerAggregates(ledger) } : { calls: 0, running: 0, completed: 0, failed: 0, blocked: 0, cancelled: 0, distinctTools: 0 };
  const scopes = invocationScopes();
  const agents = agentViews().filter((a) => a && typeof a.id === 'string');
  let capacity = { active: 0, max: 0, free: 0 };
  try {
    capacity = await coordinatorCapacity();
  } catch {
    /* capacity is informational; never fail the overview over it */
  }
  const memory = await pendingEpisodeSummary();
  const health = await detectOperationalIssues();

  return {
    generatedAt: Date.now(),
    tasks: { running, queued, waiting, paused, interrupted, recent: terminal },
    counts: {
      active: running.length + queued.length + waiting.length,
      paused: paused.length,
      interrupted: interrupted.length,
      recovering: all.filter((t) => t.status === 'RECOVERING').length,
      terminal: all.length - all.filter((t) => ACTIVE_STATUSES.includes(t.status) || t.status === 'PAUSED').length,
    },
    scheduled: {
      pending: pendingScheduled.length,
      recentDone: scheduled
        .filter((t) => t.status !== 'pending')
        .slice(-6)
        .reverse()
        .map((t) => ({ id: t.id, task: t.task, due: t.due, status: t.status, ranAt: t.ranAt, error: t.error })),
    },
    routines: {
      total: routineItems.length,
      enabled: routineItems.filter((r) => r.enabled).length,
      failing: routineItems.filter((r) => r.lastError).length,
      items: routineItems,
    },
    executions,
    agents: {
      active: agents.filter((a) => a.status === 'running' || a.status === 'waiting').length,
      views: agents.slice(0, 12).map((a) => ({ id: a.id, agent: a.agent, status: a.status, note: clip(a.note || a.why, 120), startedAt: a.startedAt })),
    },
    capacity,
    resources: {
      toolCalls: summaryAll.calls,
      running: summaryAll.running,
      completed: summaryAll.completed,
      failed: summaryAll.failed,
      blocked: summaryAll.blocked,
      cancelled: summaryAll.cancelled,
      distinctTools: scopes.reduce((n, s) => n + s.tools, 0),
    },
    approvals: {
      // ROUND 29: real pending approval requests (the §1.1 user-approval surface) + recent
      // approval decisions, alongside the gate's ledger refusals (R27 surface, preserved).
      // ROUND 32 (§6): native-confirmation state + durable-audit health (fail-closed
      // audit failures are OPERATIONAL ISSUES, never silent).
      ...(() => {
        const snap = approvalSecuritySnapshot();
        return {
          pendingInteractive: snap.pendingInteractive,
          nativeOpen: snap.nativeOpen,
          auditFailures: snap.audit.failures,
          auditLastError: snap.audit.lastError || undefined,
          recent: recentApprovalEvents(6).map((e) => ({ at: e.at, id: e.id, event: e.event, tool: e.tool, action: e.action, origin: e.origin, targetLabel: clip(e.targetLabel, 60), detail: e.detail ? clip(e.detail, 100) : undefined })),
        };
      })(),
      recentBlocked: blocked.map((r) => ({ id: r.id, tool: r.tool, at: r.startedAt, detail: clip(r.detail, 160) })),
    },
    // ROUND 32 (§6): credential presence + encryption status (presence metadata only —
    // never a stored secret) and the durable workflow journal's honest surface.
    credentials: await credentialInfo().catch(() => []),
    workflows: await (async (): Promise<OpsOverview['workflows']> => {
      const unknown = await journalUnknownOutcomes(10).catch(() => [] as WorkflowJournalEntry[]);
      const recent = await workflowJournalView(14).catch(() => [] as WorkflowJournalEntry[]);
      return {
        journalError: journalHealth().lastError || undefined,
        unknownOutcomes: unknown.length,
        recent: recent.map((e) => ({ at: e.at, kind: e.kind, stage: e.stage, detail: clip(e.detail, 140), outcome: e.outcome, taskId: e.taskId })),
      };
    })(),
    // ROUND 33 (Phase 6): REAL execution-boundary state — the workspace, the canonical
    // path, the project-bound tasks of this process, and the MEASURED shell-isolation
    // capability with its honest warning (never claimed beyond the platform).
    boundaries: await (async (): Promise<OpsOverview['boundaries']> => {
      await probeShellIsolation().catch(() => undefined);
      const cap = shellIsolationCapability();
      const bound = boundWorkspacesList();
      let canonical: string | undefined;
      try {
        canonical = await fsp.realpath(FILES_ROOT);
      } catch {
        canonical = undefined; // not resolvable — reported as absent, never faked
      }
      return {
        filesRoot: FILES_ROOT,
        filesRootCanonical: canonical,
        boundTasks: bound.map((b) => ({ taskId: b.taskId, root: b.root, real: b.real, boundAt: b.boundAt })),
        filesystemEnforcement: bound.length > 0 ? 'active' : 'standby',
        // ROUND 34 (Phase 6): the measured capability WITH the real mount-probe result
        // and the real refusal/failure counters — never a claimed sandbox.
        shellIsolation: {
          platform: cap.platform,
          mode: cap.mode,
          mechanism: cap.mechanism,
          probed: cap.probed,
          warning: cap.warning,
          probePassed: cap.probe?.passed,
          probeSteps: cap.probe?.steps.map((s) => ({ step: s.step, ok: s.ok, detail: s.detail })),
          refusedCommands: cap.refusedCommands,
          sandboxFailures: cap.sandboxFailures,
        },
      };
    })(),
    // ROUND 33 (Phase 6): the native browser's security state from the ENFORCEMENT
    // counters (real refusal events) + the live session/approval state.
    // ROUND 34 (Phase 6): payload completeness, submitter verification, mechanism
    // failures and consumed approvals — every number from an actual counter/record.
    browserSecurity: ((): OpsOverview['browserSecurity'] => {
      const c = browserSecurityCounters();
      const info = isNativeConnected() ? nativeSessionInfo() : undefined;
      const snap = approvalSecuritySnapshot();
      return {
        connected: isNativeConnected(),
        mode: info?.mode,
        sessionId: info?.sessionId,
        pendingApprovals: snap.pendingInteractive,
        nativeOpen: snap.nativeOpen,
        consumedApprovals: approvalConsumedCount(),
        refusals: {
          targetOrPayloadMismatch: c.targetOrPayloadMismatch,
          submitterMismatch: c.submitterMismatch,
          staleTarget: c.staleTarget,
          ambiguousOrHiddenTarget: c.ambiguousOrHiddenTarget,
          approvalRefusals: c.approvalRefusals,
          inspectionLimitRefusals: c.inspectionLimitRefusals,
          submissionMechanismFailures: c.submissionMechanismFailures,
        },
        approvedSubmissions: c.approvedSubmissions,
      };
    })(),
    // ROUND 33 (Phase 6): real redaction activity (how many secret values the receipt
    // layer actually removed) — never a decorative metric.
    redaction: redactionHealth(),
    // ROUND 34 (Phase 6): IPC trust — real mode, exact expected resource, real refusals.
    ipcTrust: ipcTrustHealth(),
    memory: {
      pendingEpisodes: memory.pending,
      recordedEpisodes: memory.recorded,
      failedEpisodes: memory.failed,
      failures: memory.failures,
    },
    integrations,
    health: { issues: health.map((i) => ({ kind: i.kind, severity: i.severity, about: i.about, detail: i.detail })) },
    browser: await browserHealthView(),
    recovery: await recoveryView(),
    system: {
      platform: `${os.platform()} ${os.arch()}`,
      cpuCount: os.cpus()?.length ?? 0,
      loadAvg: typeof os.loadavg === 'function' && process.platform !== 'win32' ? os.loadavg().map((n) => Math.round(n * 100) / 100) : null,
      memoryTotalMb: Math.round(os.totalmem() / (1024 * 1024)),
      memoryFreeMb: Math.round(os.freemem() / (1024 * 1024)),
      processRssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      processHeapUsedMb: Math.round(process.memoryUsage().heapUsed / (1024 * 1024)),
      uptimeHours: Math.round((process.uptime() / 3600) * 10) / 10,
    },
  };
}

/** Browser-session health projection (real session state; no cookie/credential data). */
async function browserHealthView(): Promise<OpsOverview['browser']> {
  try {
    const info = nativeSessionInfo();
    if (isNativeConnected() && info) return { connected: true, mode: info.mode, browserName: info.browserName, sessionId: info.sessionId };
    const last = await lastSessionRecord();
    return {
      connected: false,
      mode: last?.last?.mode,
      browserName: last?.last?.browserName,
      sessionId: last?.last?.sessionId,
      lastDisconnect: last?.last?.disconnectReason ?? last?.last?.lastError,
    };
  } catch {
    return { connected: false };
  }
}

/** Recovery projection for the overview (bounded recent ledger). */
async function recoveryView(): Promise<OpsOverview['recovery']> {
  try {
    const settings = await getRecoverySettings();
    const now = Date.now();
    const used = await budgetUsedLastHour(now);
    const log = await loadRecoveryLog();
    return {
      autoRecovery: settings.autoRecovery,
      budgetUsed: used,
      budgetMax: settings.maxActionsPerHour,
      recent: log.slice(-6).reverse().map((r) => ({ at: r.at, action: r.action, outcome: r.outcome, issueKind: r.issueKind, detail: clip(r.detail, 120) })),
    };
  } catch {
    return { autoRecovery: false, budgetUsed: 0, budgetMax: 0, recent: [] };
  }
}

/** The ledger query returns records plus totals; project the aggregates we display. */
const ledgerAggregates = (q: ReturnType<typeof queryInvocations>) => {
  const byState = (s: string): number => q.records.filter((r) => r.state === s).length;
  return {
    calls: q.total,
    running: byState('running'),
    completed: byState('completed'),
    failed: byState('failed'),
    blocked: byState('blocked'),
    cancelled: byState('cancelled'),
    distinctTools: new Set(q.records.map((r) => r.tool)).size,
  };
};

export interface OpsTimelineEvent {
  at: number;
  kind: 'created' | 'status' | 'step-start' | 'step-end' | 'verification' | 'verdict' | 'tool';
  label: string;
  detail?: string;
}

export interface OpsTaskDetail {
  id: string;
  objective: string;
  request: string;
  status: string;
  verdict?: string;
  note: string;
  delegation?: { strategy: string; kind?: string; reasons: string[]; workstreams: string[]; parallelizable: boolean };
  retries: number;
  replans: number;
  planVersion: number;
  planHistory: Array<{ at: number; version: number; summary: string }>;
  steps: Array<{
    id: string;
    title: string;
    kind: string;
    status: string;
    result: string;
    attempts: number;
    startedAt?: number;
    endedAt?: number;
    acceptance?: string[];
    expectedOutput?: string;
    outcomeUnknown?: boolean;
    verification?: { checkedAt: number; status: string; method: string; observed: string; evidence: string; intended: string; action: string; toolResult: string };
  }>;
  verification?: { checkedAt: number; passed: boolean; results: Array<{ criterion: string; pass: boolean; evidence: string }> };
  /** ROUND 35 (Phase 6): the task's persisted delivery state — acceptance criteria,
   *  deliverables, evidence, change summary, review and the recovery state. */
  delivery?: DeliveryView;
  timeline: OpsTimelineEvent[];
  invocations: Array<{ id: number; tool: string; state: string; startedAt: number; endedAt?: number; ms?: number; detail?: string }>;
}

/** One task's full detail: steps, evidence, timeline — all grounded in persisted records. */
export async function opsTaskDetail(id: string): Promise<OpsTaskDetail | null> {
  const t = await getTask(id);
  if (!t) return null;
  const timeline: OpsTimelineEvent[] = [];
  timeline.push({ at: t.createdAt, kind: 'created', label: 'Task created', detail: clip(t.spec.request, 200) });
  for (const h of t.history) timeline.push({ at: h.at, kind: 'status', label: `${h.from} → ${h.to}`, detail: clip(h.note, 160) });
  for (const s of t.steps) {
    if (s.startedAt) timeline.push({ at: s.startedAt, kind: 'step-start', label: `Step started: ${clip(s.title, 80)}`, detail: s.kind });
    if (s.endedAt) timeline.push({ at: s.endedAt, kind: 'step-end', label: `Step ${s.status}: ${clip(s.title, 80)}`, detail: clip(s.result, 200) });
  }
  if (t.verification) timeline.push({ at: t.verification.checkedAt, kind: 'verification', label: t.verification.passed ? 'Task verification PASSED' : 'Task verification FAILED', detail: t.verification.results.map((r) => `${r.pass ? 'PASS' : 'FAIL'} ${clip(r.criterion, 60)}`).join('; ') });
  if (t.verdict) timeline.push({ at: t.endedAt ?? t.updatedAt, kind: 'verdict', label: `Verdict: ${t.verdict}`, detail: clip(t.note, 200) });
  timeline.sort((a, b) => a.at - b.at);

  const ledger = queryInvocations({ scope: t.id, offset: 0, limit: 60 });

  return {
    id: t.id,
    objective: t.spec.objective,
    request: t.spec.request,
    status: t.status,
    verdict: t.verdict,
    note: clip(t.note, 400),
    delegation: t.delegation ? { strategy: t.delegation.strategy, kind: t.delegation.kind, reasons: t.delegation.reasons, workstreams: t.delegation.workstreams, parallelizable: t.delegation.parallelizable } : undefined,
    retries: t.retries,
    replans: t.replans,
    planVersion: t.planVersion,
    planHistory: t.planHistory,
    steps: t.steps.map((s) => {
      const v = validVerification(s); // stale records are shown as what they are: none
      return {
        id: s.id,
        title: s.title,
        kind: s.kind,
        status: s.status,
        result: clip(s.result, 600),
        attempts: s.attempts,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        acceptance: s.acceptance,
        expectedOutput: s.expectedOutput,
        outcomeUnknown: s.outcomeUnknown,
        verification: v
          ? { checkedAt: v.checkedAt, status: v.status, method: v.method, observed: clip(v.observed, 300), evidence: clip(v.evidence, 300), intended: clip(v.intended, 160), action: clip(v.action, 160), toolResult: clip(v.toolResult, 160) }
          : undefined,
      };
    }),
    verification: t.verification,
    // ROUND 35 (Phase 6): the delivery projection — every value from the persisted record.
    delivery: deliveryView(t),
    timeline: timeline.slice(-60),
    invocations: ledger.records.map((r) => ({ id: r.id, tool: r.tool, state: r.state, startedAt: r.startedAt, endedAt: r.endedAt, ms: r.ms, detail: clip(r.detail, 140) })),
  };
}

export type OpsTaskAction = 'pause' | 'resume' | 'cancel' | 'retry';

/**
 * A control-panel action runs the EXISTING authorized tool (`task_pause`/`task_resume`/
 * `task_cancel`/`task_retry`) through the ONE central dispatch — the button does exactly
 * what the agent's own tool call would do, gate and receipts included.
 */
export async function opsTaskAction(id: string, action: OpsTaskAction): Promise<string> {
  const clean = String(id ?? '').trim();
  if (!clean) throw new Error('task id is required.');
  if (action !== 'pause' && action !== 'resume' && action !== 'cancel' && action !== 'retry') throw new Error(`unsupported action "${action}"`);
  const env = await runToolDetailed(`task_${action}`, JSON.stringify({ id: clean }));
  return env.text;
}

export type OpsRoutineAction = 'enable' | 'disable' | 'cancel';

/** Routine controls use the SAME registered scheduler tools (one management surface). */
export async function opsRoutineAction(id: string, action: OpsRoutineAction): Promise<string> {
  const clean = String(id ?? '').trim();
  if (!clean) throw new Error('routine id is required.');
  if (action !== 'enable' && action !== 'disable' && action !== 'cancel') throw new Error(`unsupported action "${action}"`);
  const env = await runToolDetailed('cancel_recurring', JSON.stringify({ id: clean, mode: action }));
  return env.text;
}

// --------------------------------------------- operational health & failure detection (R27 §6.2/§6.5)

export interface OpsIssue {
  kind: 'stuck-task' | 'interrupted-work' | 'failed-routine' | 'lost-occurrence' | 'integration-down' | 'memory-outbox' | 'browser-session' | 'repeated-failure';
  severity: 'warn' | 'crit';
  /** The affected operation (task id, routine id, integration id…). */
  about: string;
  /** The MEASURABLE condition observed — never a fabricated prediction. */
  detail: string;
}

/** A RUNNING durable task whose record has not moved for this long is probably stuck. */
const STUCK_TASK_MS = 15 * 60 * 1000;

/**
 * PROACTIVE FAILURE DETECTION (R27 §6.2): measurable conditions only, from durable
 * records — a RUNNING task whose record stopped updating, interrupted work waiting for a
 * resume, routines whose last run failed, recurring occurrences left pending/recovering
 * (a crash window), integrations in EXPIRED/ERROR, and episodic episodes stuck in the
 * outbox. No predictions are invented: every issue cites the record it came from.
 */
export async function detectOperationalIssues(): Promise<OpsIssue[]> {
  const issues: OpsIssue[] = [];
  const now = Date.now();
  const tasks = await listTasks();
  for (const t of tasks) {
    if ((t.status === 'RUNNING' || t.status === 'VERIFYING') && now - t.updatedAt > STUCK_TASK_MS) {
      issues.push({
        kind: 'stuck-task',
        severity: 'warn',
        about: t.id,
        detail: `RUNNING for ${Math.round((now - t.updatedAt) / 60000)} min without a record update (step: ${clip(t.steps.find((s) => s.status === 'running')?.title, 80) || 'none'}); the stall watchdog will take over at the stale-claim threshold`,
      });
    }
    if (t.status === 'INTERRUPTED' || t.status === 'RECOVERING') {
      issues.push({ kind: 'interrupted-work', severity: 'warn', about: t.id, detail: `task is ${t.status} (${clip(t.note, 120)}) — completed steps are preserved; resume or retry from the Operations panel` });
    }
  }
  const routines = await listRecurring();
  for (const r of routines) {
    if (r.lastError) issues.push({ kind: 'failed-routine', severity: 'warn', about: r.id, detail: `routine "${clip(r.task, 80)}" — last run failed: ${clip(r.lastError, 140)}` });
  }
  const runs = await listRecurringRuns();
  const runList = runs;
  for (const r of runs) {
    if ((r.status === 'pending' || r.status === 'recovering') && now - r.occurrence > STUCK_TASK_MS) {
      issues.push({ kind: 'lost-occurrence', severity: 'warn', about: r.id, detail: `occurrence ${new Date(r.occurrence).toISOString()} of routine ${r.routineId} is still ${r.status} after ${Math.round((now - r.occurrence) / 60000)} min — run recovery or inspect the scheduler` });
    }
  }
  for (const d of listIntegrations()) {
    const st = await connectionState(d.id);
    if (st.phase === 'EXPIRED' || st.phase === 'ERROR') {
      issues.push({ kind: 'integration-down', severity: st.phase === 'EXPIRED' ? 'crit' : 'warn', about: d.id, detail: `${d.name} is ${st.phase}: ${clip(st.lastCheck?.error ?? st.reason, 140)} — run integration_check after fixing the credentials` });
    }
  }
  const memory = await pendingEpisodeSummary();
  if (memory.pending > 0) issues.push({ kind: 'memory-outbox', severity: 'warn', about: 'episodic-outbox', detail: `${memory.pending} episode(s) queued but not yet recorded — the next drain will retry (bounded)` });
  for (const f of memory.failures) {
    issues.push({ kind: 'memory-outbox', severity: 'warn', about: f.id, detail: `episode recording FAILED after ${f.attempts} attempt(s): ${clip(f.lastError, 140)} — preserved for investigation` });
  }
  // ROUND 28 (§5.1): native-browser session health — a lost MANAGED session the user has
  // not yet restored (Mode A is never flagged for auto-recovery; it needs the user's
  // running browser and is an explicit decision every time).
  try {
    const last = await lastSessionRecord();
    const ended = last?.last?.endedAt ?? 0;
    if (last?.last && last.last.mode === 'B' && last.last.status !== 'connected' && Date.now() - ended < 24 * 3600_000) {
      issues.push({
        kind: 'browser-session',
        severity: 'warn',
        about: `native-browser:${last.last.sessionId}`,
        detail: `the managed ${last.last.browserName} browser session ended${last.last.disconnectReason ? ` (${clip(last.last.disconnectReason, 90)})` : ''} — the managed browser can be relaunched (reconnect)`,
      });
    }
  } catch {
    /* session evidence is optional */
  }
  // ROUND 28 (§5.1): REPEATED failures — a routine whose last three runs all failed is a
  // pattern, not an accident; the supervisor says so instead of waiting for run #4.
  for (const r of routines) {
    const runs = runList.filter((x) => x.routineId === r.id && (x.status === 'completed' || x.status === 'failed')).slice(0, 3);
    if (runs.length === 3 && runs.every((x) => x.status === 'failed')) {
      issues.push({
        kind: 'repeated-failure',
        severity: 'warn',
        about: r.id,
        detail: `routine "${clip(r.task, 60)}" failed its last ${runs.length} runs (${runs.map((x) => clip(x.error ?? 'unknown', 40)).join(' | ')}) — stopping and investigating beats a fourth blind retry`,
      });
    }
  }
  return issues;
}

/** Notification signatures already reported this session (bounded, no repeat spam). */
const reportedIssues = new Set<string>();

/**
 * Periodic supervision pass (R27 §6.1): event-driven — called on a slow interval, it
 * detects measurable issues and notifies ONCE per distinct issue signature. Returns the
 * currently open issues for the Control Center. Never throws.
 */
export async function superviseOperations(): Promise<OpsIssue[]> {
  try {
    const issues = await detectOperationalIssues();
    for (const i of issues) {
      const sig = `${i.kind}:${i.about}:${i.detail}`;
      if (reportedIssues.has(sig)) continue;
      reportedIssues.add(sig);
      if (reportedIssues.size > 200) {
        const first = reportedIssues.values().next().value;
        if (first) reportedIssues.delete(first);
      }
      console.warn(`[ops] ${i.severity === 'crit' ? 'CRITICAL' : 'warning'}: ${i.kind} — ${i.about}: ${i.detail}`);
    }
    // ROUND 28 (§5.2): BOUNDED automatic recovery of ELIGIBLE issues — never a blind
    // retry of anything whose external outcome is unknown (the eligible strategies are
    // only ever re-observation, re-drain of a durable queue, or a relaunch through the
    // native module's own honest gate). Budgeted, recorded, and visible.
    const settings = await getRecoverySettings();
    if (settings.autoRecovery) {
      for (const i of issues) {
        const plan = await recoveryPlanFor(i);
        if (!plan.eligible) continue;
        const entry = await attemptRecovery(i, { automatic: true });
        if (entry.outcome === 'recovered') console.log(`[ops] recovered ${i.kind} (${i.about}): ${entry.detail}`);
        else if (entry.outcome !== 'not-eligible') console.warn(`[ops] recovery attempt for ${i.kind} (${i.about}): ${entry.outcome} — ${entry.detail}`);
      }
    }
    return issues;
  } catch (e) {
    console.warn('[ops] supervision pass failed:', e instanceof Error ? e.message : e);
    return [];
  }
}

// ===========================================================================
// ROUND 28 (PHASE 5) — BOUNDED RECOVERY ENGINE
//
// Round 27 could DETECT operational problems; Round 28 can handle the ELIGIBLE ones —
// under explicit, visible, user-controlled limits. Every recovery action:
//   has a reason and supporting evidence · respects a retry budget and an hourly cap ·
//   respects permissions (it only ever invokes the existing authorized pathways) ·
//   is recorded in a durable ledger · is visible in the Operations Center ·
//   and NEVER blindly repeats an operation whose external outcome is unknown.
// ============================================================================

export interface RecoverySettings {
  /** Master switch for AUTOMATIC recovery (user-invoked recovery always works). */
  autoRecovery: boolean;
  /** Maximum automatic recovery actions per hour (all kinds combined). */
  maxActionsPerHour: number;
}

const DEFAULT_RECOVERY_SETTINGS: RecoverySettings = { autoRecovery: true, maxActionsPerHour: 6 };

const recoverySettingsFile = (): string => path.join(FILES_ROOT, 'brain', 'ops-recovery.json');
const recoveryLogFile = (): string => path.join(FILES_ROOT, 'brain', 'recovery-log.json');

let recoverySettingsCache: RecoverySettings | null = null;

export async function getRecoverySettings(): Promise<RecoverySettings> {
  if (recoverySettingsCache) return { ...recoverySettingsCache };
  const raw = await loadJson<Partial<RecoverySettings>>(recoverySettingsFile(), DEFAULT_RECOVERY_SETTINGS);
  recoverySettingsCache = {
    autoRecovery: raw.autoRecovery !== false,
    maxActionsPerHour: typeof raw.maxActionsPerHour === 'number' && raw.maxActionsPerHour >= 0 ? Math.min(60, Math.floor(raw.maxActionsPerHour)) : DEFAULT_RECOVERY_SETTINGS.maxActionsPerHour,
  };
  return { ...recoverySettingsCache };
}

export async function setRecoverySettings(patch: Partial<RecoverySettings>): Promise<RecoverySettings> {
  return withStoreLock(recoverySettingsFile(), async () => {
    const cur = await getRecoverySettings();
    const next: RecoverySettings = {
      autoRecovery: typeof patch.autoRecovery === 'boolean' ? patch.autoRecovery : cur.autoRecovery,
      maxActionsPerHour: typeof patch.maxActionsPerHour === 'number' ? Math.min(60, Math.max(0, Math.floor(patch.maxActionsPerHour))) : cur.maxActionsPerHour,
    };
    await fsp.mkdir(path.dirname(recoverySettingsFile()), { recursive: true });
    await atomicWrite(recoverySettingsFile(), JSON.stringify(next, null, 1));
    recoverySettingsCache = next;
    return { ...next };
  });
}

export const dropRecoverySettingsCacheForTests = (): void => {
  recoverySettingsCache = null;
};

export interface RecoveryAction {
  at: number;
  /** The issue that triggered the action. */
  issueKind: OpsIssue['kind'];
  issueAbout: string;
  /** The recovery strategy applied. */
  action: 're-drain-memory-outbox' | 'reconnect-native-browser' | 'recover-recurring-occurrences' | 'run-integration-check' | 'recommendation-only';
  /** Why: the measurable condition that justified it. */
  reason: string;
  outcome: 'recovered' | 'attempted-failed' | 'not-eligible' | 'budget-exceeded' | 'recommended';
  detail: string;
  /** What the user should do when human intervention is required. */
  userAction?: string;
}

const MAX_RECOVERY_LOG = 120;

const loadRecoveryLog = async (): Promise<RecoveryAction[]> => {
  const raw = await loadJson<unknown>(recoveryLogFile(), []);
  return (Array.isArray(raw) ? raw : []).filter((r): r is RecoveryAction => !!r && typeof r === 'object' && typeof (r as RecoveryAction).at === 'number' && typeof (r as RecoveryAction).action === 'string');
};

const recordRecoveryAction = async (entry: RecoveryAction): Promise<void> => {
  await withStoreLock(recoveryLogFile(), async () => {
    const log = await loadRecoveryLog();
    log.push(entry);
    await fsp.mkdir(path.dirname(recoveryLogFile()), { recursive: true });
    await atomicWrite(recoveryLogFile(), JSON.stringify(log.slice(-MAX_RECOVERY_LOG), null, 1));
  });
};

/** The hourly budget: automatic recovery actions consumed in the last 60 minutes. */
const budgetUsedLastHour = async (now: number): Promise<number> => {
  const log = await loadRecoveryLog();
  return log.filter((r) => r.at > now - 3600_000 && r.outcome !== 'recommended' && r.outcome !== 'not-eligible').length;
};

/** The eligible automatic strategies per issue kind (Phase 5 §5.2). */
const RECOVERY_STRATEGIES: Partial<Record<OpsIssue['kind'], RecoveryAction['action']>> = {
  'memory-outbox': 're-drain-memory-outbox',
  'browser-session': 'reconnect-native-browser',
  'lost-occurrence': 'recover-recurring-occurrences',
  // ROUND 29 (§5.1): a failed INTEGRATION whose recorded failure was TRANSIENT (network,
  // 5xx) is recoverable by re-running its health check — a read-only re-observation with
  // no side effects. Auth/denied/connection failures need human judgment (new credentials,
  // scopes) and stay recommendation-only — enforced inside attemptRecovery from the
  // recorded failureKind, never guessed here.
  'integration-down': 'run-integration-check',
};

/** Human-intervention recommendations per issue kind — honest, actionable, specific. */
const RECOMMENDATIONS: Partial<Record<OpsIssue['kind'], string>> = {
  'stuck-task': 'the stall watchdog will take over at the stale-claim threshold; if it does not, inspect the task in the Operations panel and cancel or resume it',
  'interrupted-work': 'resume the task from the Operations panel (completed steps are preserved and unknown outcomes are reconciled first)',
  'failed-routine': 'fix the routine\u2019s failure cause (see its last error), or disable/remove the routine if it is obsolete',
  'repeated-failure': 'STOP retrying: read the recorded errors, fix the cause (credentials, network, tool), then re-enable the routine',
  'integration-down': 'update the credentials, then run integration_check — availability is earned by a recorded successful validation; a TRANSIENT (network) failure can be recovered automatically by re-running the check',
  'lost-occurrence': 'run recovery (recover-recurring-occurrences) or inspect the scheduler\u2019s recurring-run records',
  'browser-session': 'reconnect the managed browser (automatic when auto-recovery is on), or connect it manually from the Native Browser panel',
  'memory-outbox': 're-drain the outbox (automatic when auto-recovery is on); failed rows stay preserved for investigation',
};

export interface RecoveryPlan {
  eligible: boolean;
  action: RecoveryAction['action'];
  reason: string;
  userAction?: string;
}

/**
 * What WOULD be done for an issue — inspectable before anything runs (§5.4).
 * ROUND 29 (§5.1): ASYNC and state-aware for integrations — eligibility for the
 * integration-check strategy is decided from the RECORDED evidence (connectionState's
 * failureKind): only a TRANSIENT (network/5xx) failure is automatically recoverable;
 * expired credentials, permission denials and connection failures are human-judgment
 * recommendations, never auto-"fixed". Other kinds remain purely static mappings.
 */
export async function recoveryPlanFor(issue: OpsIssue): Promise<RecoveryPlan> {
  const action = RECOVERY_STRATEGIES[issue.kind];
  if (!action) {
    return { eligible: false, action: 'recommendation-only', reason: `no automatic recovery exists for ${issue.kind} — human judgment is required`, userAction: RECOMMENDATIONS[issue.kind] };
  }
  if (action === 'run-integration-check') {
    const st = await connectionState(issue.about).catch(() => null);
    if (!st?.lastCheck || st.lastCheck.ok) {
      return { eligible: false, action, reason: `the integration state has already changed (no failed check is recorded) — re-run detection before recovering`, userAction: RECOMMENDATIONS[issue.kind] };
    }
    if (st.failureKind && st.failureKind !== 'transient') {
      return {
        eligible: false,
        action,
        reason: `the recorded failure is ${st.failureKind.toUpperCase()} — re-running the check cannot create new credentials or grant scopes; human action is required`,
        userAction: RECOMMENDATIONS[issue.kind],
      };
    }
    return { eligible: true, action, reason: issue.detail, userAction: RECOMMENDATIONS[issue.kind] };
  }
  return { eligible: true, action, reason: issue.detail, userAction: RECOMMENDATIONS[issue.kind] };
}

let recovering = false;

/**
 * Attempt the bounded recovery for ONE detected issue. Eligibility is re-checked at
 * execution time (the issue may have resolved itself), the hourly budget is enforced,
 * the action goes through the EXISTING recovery pathways only (memory drain, native
 * reconnect — which itself refuses Mode A and disabled auto-recovery, scheduler
 * occurrence recovery), and the outcome lands in the durable ledger. Never throws.
 */
export async function attemptRecovery(issue: OpsIssue, opts: { automatic?: boolean } = {}): Promise<RecoveryAction> {
  const now = Date.now();
  const settings = await getRecoverySettings();
  const plan = await recoveryPlanFor(issue);
  if (!plan.eligible) {
    const entry: RecoveryAction = { at: now, issueKind: issue.kind, issueAbout: issue.about, action: 'recommendation-only', reason: issue.detail, outcome: 'recommended', detail: plan.reason, userAction: plan.userAction };
    await recordRecoveryAction(entry);
    return entry;
  }
  if (opts.automatic && !settings.autoRecovery) {
    return { at: now, issueKind: issue.kind, issueAbout: issue.about, action: plan.action, reason: issue.detail, outcome: 'not-eligible', detail: 'automatic recovery is disabled by the user — use the Operations panel to run it manually', userAction: plan.userAction };
  }
  if (recovering) {
    return { at: now, issueKind: issue.kind, issueAbout: issue.about, action: plan.action, reason: issue.detail, outcome: 'not-eligible', detail: 'another recovery action is already in flight (concurrency bound)' };
  }
  const used = await budgetUsedLastHour(now);
  if (used >= settings.maxActionsPerHour) {
    const entry: RecoveryAction = { at: now, issueKind: issue.kind, issueAbout: issue.about, action: plan.action, reason: issue.detail, outcome: 'budget-exceeded', detail: `the recovery budget is exhausted (${used}/${settings.maxActionsPerHour} actions this hour) — raised again for the next window`, userAction: plan.userAction };
    await recordRecoveryAction(entry);
    return entry;
  }
  recovering = true;
  try {
    let outcome: RecoveryAction['outcome'] = 'attempted-failed';
    let detail = '';
    if (plan.action === 're-drain-memory-outbox') {
      const before = await pendingEpisodeSummary();
      let res = await processPendingEpisodes();
      // ROUND 28 (§5.2): a SKIPPED drain (an overlapping self-drain was in flight — the
      // queue-triggered drains race supervision legitimately) is NOT a recovery failure:
      // the rows may still be pending. Quiesce briefly (bounded) and re-drain once, so the
      // ledger records the TRUE outcome instead of a false "attempted-failed".
      if (before.pending > 0 && res.recorded === 0 && res.duplicates === 0 && res.failed === 0 && res.remaining === before.pending) {
        await waitForDrainIdleForTests();
        res = await processPendingEpisodes();
      }
      outcome = res.recorded > 0 || res.duplicates > 0 ? 'recovered' : 'attempted-failed';
      detail = `memory outbox re-drain: ${res.recorded} recorded, ${res.duplicates} duplicate(s), ${res.failed} failed, ${res.remaining} still pending (was: ${before.pending} pending)`;
    } else if (plan.action === 'reconnect-native-browser') {
      const r = await reconnectNativeBrowser(`supervision: ${clip(issue.detail, 80)}`);
      outcome = r.reconnected ? 'recovered' : 'attempted-failed';
      detail = r.reason;
      if (!r.reconnected) outcome = 'not-eligible'; // reconnect refuses honestly (Mode A / disabled / no browser)
    } else if (plan.action === 'recover-recurring-occurrences') {
      const r = await recoverRecurringRuns();
      outcome = r.reArmed + r.reconciled + r.cancelled > 0 ? 'recovered' : 'not-eligible';
      detail = `recurring-run recovery: ${r.reArmed} re-armed, ${r.reconciled} reconciled, ${r.cancelled} cancelled`;
    } else if (plan.action === 'run-integration-check') {
      // ROUND 29 (§5.1): eligible ONLY for TRANSIENT failures (network/5xx) — a read-only
      // re-observation with no side effects. Auth-expired / permission-denied / connection
      // failures need NEW credentials or scopes: human judgment, so the action is refused
      // with the specific reason (never "fixed" blindly, never a blind retry).
      const state = await connectionState(issue.about).catch(() => null);
      if (state?.failureKind && state.failureKind !== 'transient') {
        outcome = 'not-eligible';
        detail = `the integration's last failure was ${state.failureKind.toUpperCase()}, not transient — automatic re-checking cannot fix it; ${plan.userAction ?? 'human action is required'}`;
      } else if (!state?.lastCheck || state.lastCheck.ok) {
        outcome = 'not-eligible';
        detail = 'the integration issue has already changed state — re-run detection before recovering';
      } else {
        const env = await runToolDetailed('integration_check', JSON.stringify({ id: issue.about }));
        const ok = env.status === 'success' && /Health check SUCCEEDED|Validated \(static\)/i.test(env.text);
        outcome = ok ? 'recovered' : 'attempted-failed';
        detail = `integration_check for ${issue.about}: ${clip(env.text.replace(/\s+/g, ' '), 180)}`;
      }
    }
    const entry: RecoveryAction = { at: now, issueKind: issue.kind, issueAbout: issue.about, action: plan.action, reason: issue.detail, outcome, detail, userAction: outcome === 'recovered' ? undefined : plan.userAction };
    await recordRecoveryAction(entry);
    return entry;
  } catch (e) {
    const entry: RecoveryAction = { at: now, issueKind: issue.kind, issueAbout: issue.about, action: plan.action, reason: issue.detail, outcome: 'attempted-failed', detail: `the recovery action itself failed: ${e instanceof Error ? e.message : String(e)}`, userAction: plan.userAction };
    await recordRecoveryAction(entry);
    return entry;
  } finally {
    recovering = false;
  }
}

export interface RecoveryStatus {
  settings: RecoverySettings;
  budget: { used: number; max: number; resetsInMs: number };
  openIssues: Array<{ kind: OpsIssue['kind']; severity: string; about: string; detail: string; plan: RecoveryPlan }>;
  history: RecoveryAction[];
}

/** The full recovery view: settings, budget, open issues WITH their plans, and history. */
export async function recoveryStatus(): Promise<RecoveryStatus> {
  const settings = await getRecoverySettings();
  const now = Date.now();
  const used = await budgetUsedLastHour(now);
  const issues = await detectOperationalIssues();
  const openIssues = await Promise.all(issues.map(async (i) => ({ kind: i.kind, severity: i.severity, about: i.about, detail: i.detail, plan: await recoveryPlanFor(i) })));
  return {
    settings,
    budget: { used, max: settings.maxActionsPerHour, resetsInMs: 3600_000 },
    openIssues,
    history: (await loadRecoveryLog()).slice(-12).reverse(),
  };
}

/**
 * User-invoked recovery of ONE issue (Operations panel / tool) — the same bounded action
 * the supervisor would run, but explicit. Not subject to the autoRecovery switch (the
 * user IS the authorization); still budgeted, still recorded.
 */
export async function runRecoveryFor(about: string): Promise<string> {
  const issues = await detectOperationalIssues();
  const issue = issues.find((i) => i.about === about);
  if (!issue) {
    const known = issues.map((i) => i.about).slice(0, 6).join(', ');
    return `NOT DONE: no open issue "${about}" right now (nothing to recover).${known ? ` Open issues: ${known}.` : ' The system reports no recoverable problems.'}`;
  }
  const entry = await attemptRecovery(issue, { automatic: false });
  const head = entry.outcome === 'recovered' ? `RECOVERED: ${entry.detail}` : entry.outcome === 'recommended' ? `NOT ELIGIBLE: ${entry.detail}` : `${entry.outcome.toUpperCase().replace('-', ' ')}: ${entry.detail}`;
  return `${head}${entry.userAction ? `\nWhat you can do: ${entry.userAction}` : ''}`;
}

// ------------------------------------------------------------------ recovery tools (R28 §5.4)

import type { Tool } from './toolTypes';

/** The user's recovery controls as first-class tools (the same engine the supervisor uses). */
export const recoveryTools: Record<string, Tool> = {
  ops_recovery_status: {
    parallelSafe: true,
    description:
      'Show the recovery engine state: user settings (automatic recovery on/off, hourly action budget), the OPEN operational issues with what WOULD be done for each (eligible automatic actions vs recommended human actions), and the recent recovery history (what was attempted, why, and the outcome).',
    parameters: { type: 'object', properties: {} },
    run: async () => {
      const s = await recoveryStatus();
      const lines = [
        `SETTINGS: automatic recovery ${s.settings.autoRecovery ? 'ON' : 'OFF'} · budget ${s.budget.used}/${s.budget.max} actions used this hour`,
        `OPEN ISSUES (${s.openIssues.length}):`,
        ...s.openIssues.map(
          (i) => `  [${i.severity}] ${i.kind} · ${i.about} — ${i.detail}\n      plan: ${i.plan.eligible ? `AUTOMATIC (${i.plan.action})` : 'RECOMMENDATION ONLY'} — ${i.plan.reason}${i.plan.userAction ? `\n      what you can do: ${i.plan.userAction}` : ''}`
        ),
      ];
      if (s.history.length) lines.push(`RECENT RECOVERY ACTIONS: ${s.history.slice(0, 6).map((h) => `${h.action} → ${h.outcome} (${h.issueKind})`).join(' | ')}`);
      return lines.join('\n');
    },
  },
  ops_recovery_run: {
    description:
      'Run the bounded recovery for ONE open issue, by its exact `about` id (see ops_recovery_status). The action goes through the existing recovery pathways only (memory outbox re-drain, managed-browser reconnect, scheduler occurrence recovery), is budgeted, and is recorded. Issues that need human judgment are refused with a specific recommendation instead of being "fixed" blindly.',
    parameters: { type: 'object', properties: { about: { type: 'string', description: 'The issue id from ops_recovery_status (e.g. episodic-outbox, native-browser:nb-xxx, a task or routine id).' } }, required: ['about'] },
    run: async (args) => runRecoveryFor(String(args.about ?? '').slice(0, 120)),
  },
};
