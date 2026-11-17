# JARVIS ARCHITECTURAL UPGRADE — PHASE 0 REPORT AND IMPLEMENTATION PLAN

> **HISTORICAL DOCUMENT (2026-11-02 planning snapshot).** Superseded by the as-built state:
> the durable task coordinator (`coordinator.ts` + `taskStore.ts`) is the ONE authoritative
> task engine; the mission engine described here was retired and removed. Do not treat the
> architecture below as current — see `JARVIS_TEST_PACK.md` §L and the source for the live design.

Date: 2026-11-02 · Basis: line-by-line inspection of the actual repository (58 main-process
files, renderer, preload, 18 test files) and the OpenCode/Cline reference bundle.
Baseline verified before any change: `typecheck` PASS · `lint` PASS · `npm test` 230/230 ·
builds PASS (renderer, main, preload). Two baseline defects found and fixed on arrival:
a date-rotted scheduler test (`round9.test.ts` hardcoded `2026-11-02T09:00` as "the future")
and a test-isolation leak (`resetSchedulerForTests` left `scheduled.json` on disk, so a
pending task from one test could wake inside a later test's tick and fire a notification —
masked until the date fix).

---

## 1. REPOSITORY ARCHITECTURE MAP

### Process topology
- **Main process** (`src/main/index.ts`, 171 lines): Electron entry. Creates the HUD window
  (contextIsolation on, no nodeIntegration), wires `initModes` (activity-feed sink = HUD push,
  notifier = OS notification), registers the scheduler runner (`chat` with a null stream),
  exposes validated IPC handlers (`ai-chat` → `provider.chat`, `confirm-reply` → `guard`,
  `settings-*`, `mode-*`, `stt/tts`, telemetry).
- **Preload** (`src/preload/index.ts`): whitelisted push channels + invoke API.
- **Renderer** (`src/renderer/`): React HUD — transcript, activity feed (tabbed right rail),
  confirm cards, mission strip, settings, voice (Whisper STT + Edge TTS), holographic visuals.

### Live execution path (a user request)
```
renderer (voice/text) → ipc 'ai-chat'
  → provider.chat(text, onDelta, onProgress)          [serialization via turnChain]
    → runTurn(text, …)
        resetPlanMode · schemasFor(text) [toolRouter group routing]
        turnContext = memory + session + learning + userModel + awareness (+ date anchor)
        loop (≤ MAX_TOOL_ROUNDS=60):
          withModelFallback(chain, complete(model, …))   [llm.send: streaming, timeouts,
                                                          dead-model fail-fast, retries]
          if no tool calls → QUALITY GATE (researchViolations) → one corrective round →
                             auditReply verdict → recordTurn → endTurn → endModeTurn
          else → runTool(name, args) per call (parallel via Promise.all when all read-only)
      runTool [tools.ts — THE single choke point]:
          resolveTool (Levenshtein rescue, read-only only) → planGuard → checkArgs/parseArgs
          → assessRisk (guard.ts) → [AUTONOMOUS=true bypasses requestConfirm]
          → tool.run → recordTool (in-memory) → noteUsed → emitActivity
    sub-agents: tools.task / parallel_tasks / research / batch / chain → runSubagent
    project-scale: tools.mission_start → mission.drive (plan → checkpoint → step sub-agents
                   → npm-script verification → auto-fix ≤2 → critique → report, all persisted)
    scheduled follow-ups: scheduler.ts → chat(SCHEDULED_PREFIX + task) later
```

### Persistence inventory (all JSON, all via `store.ts` atomicWrite/loadJson)
| Store | File | Owner |
| --- | --- | --- |
| Session ledger | `Jarvis-Files/session.json` | session.ts (60 turns) |
| Long-term memory | `longterm-memory.json` | memory.ts |
| Lessons/playbooks/goals/jobs | `brain/*.json` | learn.ts / agi.ts |
| Missions + checkpoints | `brain/missions/mission-N.json` | mission.ts |
| Scheduled tasks | `scheduled.json` | scheduler.ts |
| Todos / plans | `todos.json`, `plans/*.md` | planning.ts |
| Settings (safeStorage-encrypted keys) | `userData/settings.json` | settings.ts |
| Mode | `userData/mode.json` | modes.ts |
| Tool log | **memory only** (80 entries) | toolLog.ts |

### Existing capability → proposed-module cross-reference

| Module | Existing implementation | State |
| --- | --- | --- |
| **A TaskSpec** | `classifyIntent`/`missionIntentNote` (mission.ts), `DECISION_RULES` (decision.ts), user model | **Partial.** Binary project/normal routing; no structured spec (deliverables, constraints, acceptance criteria, risk class). |
| **B TaskStore** | mission.ts (persisted missions, steps, boot recovery), planning.ts todos, scheduler.ts | **Partial.** Durable only for project-scale missions; ordinary multi-step work leaves no durable task. No unified store. |
| **C TaskCoordinator** | mission.drive() is a code-driven executor (its own status set); provider.runTurn drives everything else with no task state | **Partial.** No explicit state machine for general work; no WAITING_FOR_APPROVAL, no ownership claims for non-mission work, no dependency scheduling. |
| **D AgentRegistry** | `AgentKind` ('explore'/'research'/'general') + ROLES prompts + `pickSchemas` + SUBAGENT_DENIED | **Partial.** Hard-coded 3 roles; no registry with model config, budgets, permission scope, output contracts. |
| **E Subagent orchestration** | subagent.ts (isolated loop, dedupe, compaction, forced wrap-up), orchestrate.ts (task/parallel_tasks/research/batch/chain, NO_NEST recursion ban, SUBAGENT_DENIED) | **Partial.** No parent-child registry, no per-child permission scopes (children share the parent's runTool), no structured result contract, parallelism only via Promise.all of read-only calls. |
| **F PermissionService** | guard.ts assessRisk (per-tool risk rules, delete block), requestConfirm (45 s timeout, queued cards, session-remembered approvals), planGuard | **Partial.** `AUTONOMOUS = true` in tools.ts bypasses requestConfirm globally by default (documented operator setting); no action-class ruleset, no unattended policy, decisions not persisted. |
| **G ToolExecutionRecord** | toolLog.ts — name, ms, ok, error — **in memory only** | **Partial.** No args, no auth decision, no task linkage, no durability, no idempotency support. |
| **H EvidenceLedger + Verifier** | completion.ts — per-turn in-memory ledger classified from result prefixes, verdict engine, reply audit, quality audit (files-on-disk check for write tools); quality.ts research/provenance/arithmetic gates | **Partial.** Ledger is per-turn and dies with the process; acceptance criteria are implicit; no durable per-task evidence; verifier checks exist only for npm scripts (missions) and report gates. |
| **I Agent runtime** | provider.ts runTurn + llm.ts + tools.runTool | **Exists.** Streaming, multi-tool rounds, retries, cancellation, budgets (60 rounds, 90 k chars), structured events already present. Improvement = integration (records, permissions, task events), not a rewrite. |
| **J Context management** | trimHistory (turn-based), compactTurn (budget collapse with task re-anchor), TURN_CHAR_BUDGET, subagent compaction | **Good.** Gap: provider token usage is discarded (`usage` field ignored), so pressure is measured in chars, not tokens. |
| **K ArtifactService** | none (read_document reads PDFs; write_file writes text) | **Missing.** |
| **L UI events** | modes.ts activity bus (ring 200) + protocol.ts + ActivityFeed + confirm cards + mission emitter | **Good.** Gaps: no task/verification/agent-spawn event kinds; approvals have no durable record. |

## 2. GAP ANALYSIS (what Phase 1–7 must add, without duplication)

1. **PermissionService** — centralise the decision (`allow|ask|deny` by action class + resource
   rules), make `AUTONOMOUS` an explicit, user-visible autonomy setting instead of a constant,
   record every decision, scope children. Keep assessRisk's per-tool risk text (it is good) as
   the input to the ruleset, not a competing path.
2. **Durable tool records** — extend toolLog.ts into a durable store (JSONL under
   `brain/toollog/`), add args/auth/timing/task linkage, keep the existing `tool_log` tool working.
3. **TaskSpec + TaskStore + Coordinator** — one new durable task system for ordinary multi-step
   work with an explicit state machine; missions remain the project-scale executor and are
   recorded in the same store by reference (no second execution engine for code work).
4. **AgentRegistry** — formalise the three existing roles plus justified additions (document,
   verifier) with budgets, tool allowlists and output contracts; orchestrate.ts reads the registry.
5. **Scoped delegation** — child agents run with an explicit permission scope; parallel general
   agents serialise on overlapping write targets.
6. **Evidence + Verifier** — acceptance criteria on tasks; durable evidence; deterministic
   verification (file/format/registry/evidence checks) gating VERIFYING → COMPLETED.
7. **ArtifactService** — DOCX/PPTX/XLSX/PDF from a structured IR via mature libraries, with
   reopen-validation before success is reported.
8. **UI events** — new activity kinds (task, agent, verify) rendered by the existing feed;
   no channel changes needed (events ride the existing `jarvis-activity` push).

## 3. DEPENDENCY MAP (new modules)

```
permission.ts ──> guard.ts (risk), modes.ts (events), settings.ts (autonomy), toolRecord.ts
toolRecord.ts ──> store.ts (atomicAppend), taskContext (current task/step ids)
taskSpec.ts    ──> (pure; no deps)
taskStore.ts   ──> store.ts, workspace.ts
coordinator.ts ──> taskStore, taskSpec, verifier, permission (scope), mission (delegation),
                   provider (turn runner), modes (events)
agentRegistry.ts ──> orchestrate tool sets
verifier.ts    ──> artifact validators, fs, toolRecord (evidence)
artifact.ts    ──> docx, pptxgenjs, exceljs, pdf-lib, jszip (5 new, pure-JS deps)
provider.ts    ──> coordinator (task begin/end), llm (usage)
```

## 4. IMPLEMENTATION SEQUENCE (already in progress)

- **Phase 1 — Safety & truthful completion**: `permission.ts`, durable `toolRecord.ts`,
  runTool rewiring, autonomy setting, records of approvals. Tests: permission matrix,
  scoping, durability, bypass removal.
- **Phase 2 — TaskSpec & persistence**: `taskSpec.ts`, `taskStore.ts` (+ boot recovery).
- **Phase 3 — Coordination**: `coordinator.ts` (state machine, ownership, deps, retries,
  cancellation, stall detection), provider integration.
- **Phase 4 — Agents & delegation**: `agentRegistry.ts`, scoped child execution,
  write-conflict serialisation, structured child results.
- **Phase 5 — Evidence & verification**: `verifier.ts` wired into coordinator + missions.
- **Phase 6 — Context**: provider token-usage capture + usage-aware pressure.
- **Phase 7 — Artifacts**: `artifact.ts` + `make_document` tool + validators.
- **Phase 8 — UI + E2E**: event kinds, feed rendering, full gauntlet, docs.

## 5. COMPATIBILITY & SECURITY RISKS

| Risk | Mitigation |
| --- | --- |
| `AUTONOMOUS=true` removal changes UX (more prompts) | Autonomy becomes a real setting (`standard` default: consequential actions ask; `autonomous`: today's behaviour, opt-in). Block-rules (deletes) apply in BOTH modes. |
| New npm deps (docx/exceljs/pptxgenjs/pdf-lib/jszip) | Pure-JS, no native builds, no electron coupling; lazily imported so startup cost is zero and tests do not need them unless testing artifacts. |
| Coordinator could become a second mission engine | Coordinator drives ordinary tasks; project-scale work is DELEGATED to missions and mirrored — one executor per domain. |
| Renderer breakage from new event kinds | Kinds are additive; ActivityFeed renders unknown kinds generically. |
| Turn-loop regressions | runTool keeps its failure-prefix contract (`Tool error|BLOCKED|NOT APPROVED|NOT DONE`) consumed by completion.ts and toolRouter tests. |
| Electron/Node | No framework or provider-layer changes; Node 24 sandbox, Electron 32 target unchanged. |

## 6. PHASE 1 CONCRETE PLAN

1. `src/main/toolRecord.ts` — durable record type + JSONL sink + query API + task-context.
2. `src/main/permission.ts` — action classes, ruleset evaluation (last-match wins, OpenCode
   pattern), default ruleset, autonomy setting, child scoping, decision recording.
3. `tools.ts` — runTool: records + permission evaluation replace the raw AUTONOMOUS check.
4. `settings.ts` — `autonomy` setting (+ IPC/preload/Settings UI later in Phase 8).
5. Tests: `tests/permission.test.ts`, `tests/toolRecord.test.ts` — matrix coverage.
