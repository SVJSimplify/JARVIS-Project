# JARVIS — Round 17.1 Engineering Handoff (continuation session)

Living document. Section order: current state → lineage findings → decisions → phase log → next actions.

## 1. Current verified state (all numbers measured, not assumed)

Snapshot: `JARVIS_LATEST.zip` → `/home/z/my-project/jarvis` (Electron + TypeScript, ~17.5k LOC main+preload).

| Check | At session start | Now |
|---|---|---|
| `tsc -p tsconfig.node.json` | FAIL (history.ts missing exports) | **OK** |
| `tsc -p tsconfig.app.json` | OK | **OK** |
| `npx vitest run` | 600/624 pass, 24 fail; `npm test` ran ZERO tests (broken runner config) | **648/648 pass, 44 files** (new vitest.config.ts + 3 new test files) |
| `npx eslint src` | unmeasured | **0 problems** |

## 2. Source lineage findings (verified against source, this snapshot)

Round 16 improvements PARTIALLY survived; the round16a/16b test suites pin contracts the source had drifted from. All regressions below are now REPAIRED (see phase log):

1. Two write-coordination modules: wired `writeCoord.ts` had the exact defects the Round 17 review documented (owner-string reentrancy releasing outer locks; 5-min age-based stealing of healthy locks; cancellation-blind sleeps). Orphaned `writeGate.ts` held the Round 16 FIFO-queue design.
2. `policy.ts` was an older/reduced variant: `nodeJsVerdict` w/o `process.kill`/`fs.promises.rm`/eval fail-close; no `interpreterVerdict` (perl/ruby/php/lua unclassified); payload shape `{kind,code}`; no `PROTECTED_PROCESS_NAMES`; no kill-verb shell layer; `robocopy /mov` + `ren`/`Rename-Item` inside protected dirs allowed; `apply_patch *** Move to:` targets unclassified; `procInfo.resolvePidName` vs pinned `resolveProcessName`.
3. `provider.chat()` opts-object-only signature classified bare-string scheduled turns as interactive → they aborted running turns (F-13).
4. `scheduler.tick()` ran due tasks via `Promise.all` (concurrent, not awaited) — F-13 pinned sequential + awaited.
5. Coordinator: no `setCoordinatorTimingForTests`; shared `'coordinator'` owner string (not unique per drive); resume message lacked "resumed from step N" / did not inject unresolved receipts into step briefs (no RECONCILE FIRST).
6. `taskStore.claimTask` token contract reconciled with round16b's boolean expectation (see D2).
7. `toolRecord`: no `'outcome_unknown'` status; no `unresolvedExecutionsFor` (started-only `unknownOutcomeRecords` remained for round17Reliability).
8. Conversations feature (UI R15) disconnected end-to-end: history.ts imports missing exports; provider never called `appendConversationTurn`; no `history-list` IPC; preload lacked `history`; JarvisWindow used fixed `pr-36/pr-40`; no Conversations button at all.
9. `store.atomicWrite` fixed `.tmp` collision; no same-path serialization; `projectMemory` unserialized RMW — all confirmed and fixed.
10. `webTools` DNS rebinding gap confirmed (validate one resolution, fetch re-resolves) — now closed at transport level (P7).

## 3. Decisions log (append-only)

- D1: `tests/round16b.test.ts` F-18 `claimTask(...)` assertion revised `toBe(true)` → `toBeTruthy()`. Reason: taskSpec.test + round17Reliability pin the lease-TOKEN string contract (3 assertions incl. `typeof token1 === 'string'`, wrong-token-releases-nothing); round16b's single boolean pin could not coexist with it. The semantic property ("a fresh worker CAN claim") is unchanged. renewClaim/releaseClaim validate owner always, token only when supplied.
- D2: writeCoord consolidated — ONE implementation in `writeCoord.ts` (chain-based reentrancy via AsyncLocalStorage + refcounts; NO age-stealing of live chains — only dead chains after STALE_LOCK_MS; cancellation-aware waits; structured WRITE CONFLICT naming the holder). `writeGate.ts` kept only as a documented compat facade (re-exports; zero duplicate logic).
- D3: `interpreterPayloads` returns `{interpreter, payload, kind, code}` — both historical field shapes on one record (round16a pins `interpreter/payload`, round17Security pins `kind/code`); ordered by position in the command.
- D4: F-33 (DNS rebinding) closed at the TRANSPORT level: `safeNet.pinnedRequest` runs http/https.request with a pinned custom `lookup` — the socket's peer address is one the validator just approved; redirects re-pin per hop; TLS SNI/cert stay bound to the hostname. `assertPublicUrl` retains its DNS pre-check for the Chromium render paths (headless web_browse, renderText) whose stack cannot be pinned from Node — documented residual.
- D5: Semantic memory (§10.2) = local TF-IDF cosine + stemming/stopwords + count/recency boosts + score floor ("no padding"). `relevantMemoryBlock` feeds per-turn relevant memories into the provider context; `find_memory` tool + `listAllMemories` exporter added; `find_memory` joined TESTED_PARALLEL with a runtime probe test.

## 4. Phase log

- [x] Baseline measured (§1 left column).
- [x] Lineage findings verified (§2).
- [x] **P1 Reliability**: writeCoord consolidation + store.ts (unique tmp names via pid/timestamp/random, fsync file+dir, per-path op chains, `withStoreLock` RMW) + projectMemory serialized `project_save` + fsTools.multi_edit read-modify-write INSIDE the lock. Tests: `tests/round17hardening.test.ts` (7 tests: nested-release safety, live-lock retention, cancellation-aware wait, atomicWrite 24-way concurrency, RMW 20-way no-lost-update, projectMemory concurrent decisions).
- [x] **P2 Cancellation isolation (F-13)**: chat() accepts string|object source; scheduler tick strictly sequential + awaited, due-order sorted.
- [x] **P3 Durable coordinator (F-18/19/20)**: `setCoordinatorTimingForTests`; unique owner `coordinator:<ts>-<rand>` per drive; 2-arg renew/release (token validated when supplied); resume message "resumed from step N; resumed WITHOUT replanning — done/total…"; RECONCILE FIRST injected per unresolved receipt; `outcome_unknown` status; `unresolvedExecutionsFor(taskId, stepId?)`.
- [x] **P4 Security classifiers (F-01/02/04/05)**: `nodeVerdict` (+deletion APIs, process.kill fail-close, eval/new-Function fail-close; `nodeJsVerdict` alias); `interpreterVerdict` + generic classifier (perl/ruby/php/lua: deletion markers; protected-target+call fail-close); `interpreterPayloads` across python/py/node/perl/ruby/php/lua, position-ordered; `PROTECTED_PROCESS_NAMES` (single list → CRITICAL_PROCESS regex, isCriticalProcess, processVerdict, kill-verb layer); kill-verb shell layer (taskkill/tskill/pkill/kill/killall/Stop-Process/pskill × protected names incl. comments); robocopy /mov|/move copy-exception removal; ren/Rename-Item in SHELL_WRITEISH; `procInfo.resolveProcessName` (+alias); guard classifies `*** Move to:` patch targets.
- [x] **P5 Conversations re-wiring**: `session.getSessionTurnsForHistory`; `protocol.HistoryTurn`; provider calls `appendConversationTurn` on all 3 turn-end paths (success/interrupt/fail); `index.ts` `history-list` IPC (read-only); preload `history.list`; `types/electron.d.ts` declaration; JarvisWindow header: env(titlebar-area-width) padding in index.css, control cluster `ml-auto flex shrink-0 items-center gap-1`, 32px `grid h-8 w-8 place-items-center` buttons, Conversations button (`aria-label="Conversations"`), panel mounted with refreshKey; App bumps `turnsCount` per finished turn.
- [x] **P6 Full-suite green**: 648/648, tsc×2 OK, eslint 0. Fixed en route: vitest runner config (`vitest.config.ts`, root was src/renderer so `npm test` silently ran nothing), provider/scheduler type issues, lookup callback contract (`all:true` array vs single address+family).
- [x] **P7 Forward work (partial)**: F-33 pinned transport + `tests/safeNet.test.ts` (7 tests: private/mapped-IP classifier, fail-closed lookup on mixed answers, resolver-error surfacing, real-loopback refusal-before-connect, scheme gate); semantic memory service + tests + provider integration + find_memory tool.
- [x] **Delivery snapshot 2026-11-06**: full gate re-verified on this tree after sandbox recycle + fresh `npm ci` — tsc (node) OK, tsc (app) OK, vitest 648/648 across 44 files, eslint 0 problems. Packaged as `download/JARVIS_ROUND17_1.zip` (project at zip root, matching JARVIS_LATEST.zip convention; node_modules/dist excluded). §5 next actions unchanged and still authoritative.

## 5. Exact next actions (in priority order)

1. **Planning engine (Master Prompt §4/§6)**: coordinator plans are ordered steps only — no dependency graph, no parallel-step execution, no conditional/recovery steps. `nextEligibleSteps`/`dependsOn` already exist in taskStore (steps carry `dependsOn`), but `planTask` never emits dependencies and `driveSteps` runs strictly one eligible step. Add: dependency-aware plan schema in the planner prompt (emit `dependsOn` ids), parallel execution of independent eligible steps (bounded, MAX_CONCURRENT_STEP_RUNS=2) via the existing subagent runner with per-step AbortSignals, and conditional `verify` steps. The verifier/completion infra needs no change.
2. **Hierarchical delegation (§7.3)**: `registerDynamicAgent` exists (bounded, capped 8, delegation stripped) but only orchestrate's spawn path reaches it; specialist agents cannot PROPOSE subassignments. Add a coordinator-mediated proposal hook (step runner may return `SUBTASK:` lines the coordinator validates, budgets, and runs — agents never spawn agents directly).
3. **Idempotency receipts at the choke point**: `recordStarted` exists but `runToolDetailed` (tools.ts) does not wrap every consequential execution in started→completed twins. Wrap write-class tools (classifyToolAction write/execute) so unresolvedExecutionsFor has full coverage.
4. **Browser/desktop recovery loop (§8.5/8.6)**: browser.ts has observe/act/verify primitives; add stale-element re-identification + the explicit observe→compare→recover cycle after navigation-heavy actions; desktop (laptopTools/appControl) has no dialog-recovery path.
5. ~~**Watchdog cadence**~~ VERIFIED: `index.ts` line ~126 runs `checkStalls` on a 60s interval at boot — no action needed.
6. **Round 15/16 report cross-check**: `JARVIS_UI_ROUND15_REPORT.md`, `JARVIS_ROUND16_REPORT.md`, `JARVIS_HARDENING_PROGRESS.md` were treated as historical evidence only (per handoff §7); a quick skim for claimed-but-missing items beyond the 24 test-pinned ones is still worthwhile.
7. **Context budgets (§15.1)**: compaction is char-based; model metadata table not yet present.

## 6. Environment notes

- Tests: `npx vitest run` (config: vitest.config.ts — node env, tests/**, setup: tests/setup.ts which points FILES_ROOT at a temp dir, forks pool). Electron is stubbed via tests/helpers/electronStub.ts.
- Sandbox quirk: background `&` processes do not survive between messages — run installs/builds in the foreground.
- `stale-backup/` holds old sources (mission.test.ts, visualAnswer.test.ts) — deliberately excluded from the suite; do not re-enable without lineage review.

---

# ROUND 18 — Intelligence, Autonomy & Execution Completion (Master Mandate received)

## R18.0 Finding matrix (Phase 0, revalidated against source; status → resolution)

| ID | Area | Finding | Status |
|---|---|---|---|
| W1 | writeCoord §3.1 | ALS-inherited chain id let Promise.all siblings re-enter the same lock concurrently | CONFIRMED → FIXED Phase 1 (explicit scope tokens + lane stack) |
| W2 | writeCoord §3.3 | Lock retention was frame-liveness (no renewal); dead-chain steal only | PARTIALLY FIXED → v2: verified owner-liveness via scope frames; steal needs frames===0 AND stale age |
| W3 | holdsWriteLock | Owner-string diagnostic; no callers in src | CONFIRMED → kept as documented diagnostic only; identity is scope object |
| R1 | tools.ts:458 | `void recordStarted` — side effect could outrun the started receipt | CONFIRMED → FIXED Phase 2 |
| R2 | tools.ts:450 | SIDE_EFFECT_TOOLS hand-maintained list, drifts from central classifier | CONFIRMED → FIXED Phase 2 (derived from classifyToolAction) |
| R3 | tools.ts:372 | completion record void-fired | CONFIRMED → FIXED Phase 2 |
| P1 | coordinator.ts:200 | `eligible[0]` — strictly serial, no parallel steps | CONFIRMED → Phase 3 |
| P2 | coordinator.parsePlan | no dependsOn parsing; prompt never asks for deps | CONFIRMED → Phase 3 |
| P3 | coordinator | no adaptive replan (replan resets steps), no plan versions, no per-step resource limits | CONFIRMED → Phase 3 |
| A1 | agentRegistry | no desktop/data specialists; no coordinator-mediated hierarchical delegation | CONFIRMED → Phase 4 |
| M1 | semanticMemory | TF-IDF only, honestly labeled; no embedding provider abstraction | CONFIRMED → Phase 5 |
| M2 | memory stores | contradiction supersession only in memory.ts; no version/confidence on all stores | PARTIAL → Phase 5 |
| B1 | browser | ref-ids + re-resolution + settled() verification exist; download verification is a state string only | PARTIAL → Phase 6 |
| D1 | desktop | UIA/OCR/coords primitives; no post-action verify on click/type; no dialog recovery loop | PARTIAL → Phase 6 |
| S1 | provider.ts | MAIN-LOOP tools never see the turn AbortSignal (no runWithExecutionScope in runTurn) — Stop does not reach an in-flight tool | CONFIRMED → Phase 7 |
| S2 | safeNet/webTools | abort listeners never removed; wall-clock timeout surfaces as literal 'cancelled' (indistinguishable from user cancel) | CONFIRMED → Phase 7 |
| S3 | policy strings | stale "child hard floors" comment (tools.ts:334); legacy NOT APPROVED prefix in 4 files; stale toolResult comment | CONFIRMED → Phase 7 |
| S4 | webTools/headless | renderText/browseHeadless/searchHits keep running after cancel (read-only) | PARTIAL → Phase 7 (bounded) |
| W4 | write paths | make_dir/make_document unlocked; add_note/add_app/remove_app/todo_write raw fs without atomicWrite | CONFIRMED → Phase 7 |
| W5 | tools.ts:185 | edit_file reads OUTSIDE its lock (stale-base race; multi_edit had the fix, edit_file did not) | CONFIRMED → Phase 7 |
| W6 | laptopTools.ts:295 | move_file locks only the destination | CONFIRMED → Phase 7 |

## R18 Phase log

- [x] **R18-P0 Baseline**: Candidate B revalidated (648/648, tsc×2, eslint 0); full source audit of 20 mandated files + 2 subagent audits (auth/network + write-paths/runtimes); finding matrix above; git checkpoint `8540a66`.
- [x] **R18-P1 Write coordination v2 (§3)**: REWRITE of writeCoord.ts — ownership is an explicit `WriteScope` token minted per top-level withWriteLocks and passed to the callback `fn(scope)`; re-entrancy ONLY by passing the token back (`{scope}` option). Inherited AsyncLocalStorage context confers NOTHING (kills the §3.1 Promise.all bypass). Lane stack per lock: nested scoped calls push/pop their own frame; Promise.all siblings to one path PARK and run sequentially (mutual exclusion + all complete); grant increments refs synchronously in drainLane (no grant/release race); parked siblings rejected if the ancestor exits. Leases: scope.frames = owner-liveness; live scope never stolen; dead scope recoverable after stale window; `simulateAbandonedScopeForTests` exercises the real steal path. Cancellation-aware lock waits AND lane waits. Holds: `holdsWriteLock` demoted to diagnostic. Tests: `tests/writeCoordRound18.test.ts` — all 12 mandated §3.4 scenarios (16 tests). round17hardening nesting tests upgraded to explicit-scope contract (same core property).


- [x] **R18-P2 Durable receipts (§4)**: toolRecord — `reconciled` status + SETTLED_STATUSES + `recordReconciled()` + `setRecordPersistenceProbeForTests()` durability probe; tools.ts — `finish()` awaited (outcome durable before the envelope returns), started receipt AWAITED before the side effect, SIDE_EFFECT_TOOLS hand-list REPLACED by derivation from the central classifier (`action !== 'read'`); verifyExec.runCmd joined the lifecycle (started before exec, outcome before report); coordinator settles unknown-outcome receipts with observed verdicts after a step reruns. Tests: `tests/round18Receipts.test.ts` (8: receipt-gates-side-effect, durable-before-return, started/ok twin ids, no receipt for reads, blocked-never-started, crash-window → unresolved → reconciled, stable idempotency identity across retries, 24-way concurrent durability).
- [x] **R18-P3 Dependency-aware planner (§5)**: taskStore — `normalizePlan` (DAG: absent dependsOn=sequential default, EXPLICIT []=parallel-eligible, title refs, forward edges dropped → cycles impossible, planner ids preserved/deduped), `replanSteps` (adaptive replan preserving done/skipped work by title-match, id continuity, planVersion+planHistory), `failedSteps`/`stepsBlockedByFailure`, TaskStep.expectedOutput/retryMax, TaskRecord.replans/planVersion/planHistory; coordinator — WAVE SCHEDULER (all eligible steps up to MAX_PARALLEL_STEPS=2 concurrent, failure-isolated runOneStep with per-step retryMax, wave heartbeat, RETRYING→RUNNING settle), ADAPTIVE REPLAN (deps.replanner hook or model; REPLAN_BUDGET=1; preserves completed work), planner prompt emits id/dependsOn/expectedOutput, new specialist kinds desktop/data. Tests: `tests/round18Planner.test.ts` (8: DAG rules ×3, concurrent waves + dependency enforcement, branch-isolated failure (unrelated branch completes), adaptive replan preserves+completes, replanSteps unit, expectedOutput/retryMax).
- [x] **R18-P4 Hierarchical delegation (§6)**: agentRegistry — `desktop` operator (UIA/OCR/keyboard allowlist, operator role, observe-act-verify contract) + `data` analyst (compute+verify contract); dynamic-roster name collision → refuse (dedup re-proposals); orchestrate — AgentKind/desktop+data through taskTool/parallel_tasks enums; coordinator — `parseSubtaskProposals` (SUBTASK: {json} lines, cap 2/step, malformed skipped), coordinator-MEDIATED execution (registers the specialist in the ONE registry, runs under the task signal + receipts, appends findings; agents never spawn agents), `checkStepDeliverables` (§6.4: DONE-report file claims verified on disk; all-missing → ONE evidence-based retry; flag stays in the result). Tests: `tests/round18Delegation.test.ts` (9).

- [x] **R18-P5 Genuine semantic memory (§7)**: NEW `src/main/embeddings.ts` — EmbeddingProvider abstraction; 'openai' (any OpenAI-compatible /embeddings via the pinned DNS transport), 'local' (OPTIONAL @huggingface/transformers feature-extraction; fails soft when absent — never faked), 'none' default; config in brain/embeddings.json (withStoreLock RMW); bounded LRU vector cache (brain/embeddings-cache.json, sha1 keys, 2000 entries); cosine(). semanticMemory — `hybridRetrieve` (lexical TF-IDF ∪ true vector cosine, 50/50 blend, vector-only floor, scope filter, count/recency boosts, dedup, honest source labels 'lexical'/'vector'/'hybrid'); `relevantMemoryBlock` filters superseded + labels the tier honestly; memory.ts — Item.confidence/version/superseded(+By) with back-compat defaults, contradiction → SUPERSESSION (old record kept as history pointing at its successor, version+confidence bumped), prompts/list_memories/listAllMemories/find_memory exclude superseded history, find_memory on hybridRetrieve + real provider; provider.ts passes getEmbeddingProvider() per turn. round9 revision test updated to the §7.5 supersession contract (same core property: update-not-contradict). Tests: `tests/round18Memory.test.ts` (11 — incl. the semantic-generalization proof: "database performance" reaches a memory about "SQL optimization" with ZERO shared stems, which pure lexical cannot do).

- [x] **R18-P6/7 Browser-desktop verification + cancellation + write-path audit (§8-12)**: fsTools — `sniffFileType` (magic bytes: PDF/ZIP/PNG/JPEG/GIF/GZIP/ICO/XML/text) + `verifyDownloadFile` (exists, non-empty, size+type evidence, extension-mismatch flagged); panel.ts download 'done' handler now reports `completed+verified: <file> (N KB, PDF)` instead of a bare state string. Cancellation (§11): provider runTurn wraps BOTH the parallel batch and the serial dispatch in `runWithExecutionScope({signal})` (S1 — Stop now reaches in-flight tools in the MAIN loop); tools.ts — an aborted scope converts a RESOLVED-with-error-text result into a 'cancelled' envelope (new pin: killed run_python children were reported as success); safeNet.pinnedRequest — abort listener REMOVED on every settle path, AbortSignal.timeout's TimeoutError surfaces as 'timed out' (transient/retriable) vs 'cancelled' (final) (S2). Policy strings (§10/S3): stale "child hard floors" comment corrected (delete is the ONLY child floor), NOT APPROVED removed from active failure regexes (coordinator/subagent/orchestrate/toolGuide; completion.ts keeps legacy transcript parsing), move_file "asks the user first" description corrected. Write paths (§12/W4-W6): edit_file read-modify-write INSIDE the lock, move_file locks BOTH endpoints, make_dir coordinated, add_note→atomicAppend, add_app/remove_app→withStoreLock+atomicWrite, todo_write/plan_exit→atomicWrite. Known limits (honest): renderText/browseHeadless keep rendering briefly after cancel (read-only, no side effects) — documented residual; Windows runtime validation impossible in this Linux sandbox (see report).

- [x] **R18-P8 End-to-end + delivery (§14/§19)**: `tests/round18Scenarios.test.ts` — Scenario D (multi-step task → mid-flight crash via watchdog → fresh boot → resume: completed steps + artifacts preserved, RECONCILE FIRST injected, unknown receipt settled, resumed driver completes; new signal guard in runOneStep prevents a post-crash report from settling a status) + Scenario F (injection in args and as a workspace "policy file" — both restrictions hold, no over-blocking); Scenario E covered by writeCoordRound18; A/B/C declared model/desktop-blocked with engine-level equivalents cited. Production builds: vite renderer OK, tsc main OK (electron-builder network-blocked, documented). Report: JARVIS_ROUND18_REPORT.md (finding matrix, test report, security report, autonomy report, scorecard 8.6/10). Release: download/JARVIS_ROUND18.zip.
- Final gate at close: vitest **708/708** (52 files), tsc×2 OK, eslint src 0.
- R18 next actions (if a Round 19 comes): ①Windows-runtime validation pass (PowerShell/UIA/installer) on a real Windows machine; ②wire renderText/browseHeadless abort → window.destroy(); ③optional-dependency UX for local embeddings (model download flow + settings UI toggle); ④context budgets per model metadata table (§15.1 carryover).

# ROUND 19 — TARGETED CODE IMPROVEMENTS (2026-11-06)

Mandate: 10 targeted changes against the Round 18 codebase. No redesign, no second
architecture — every change edits the existing module and its callers.

## R19 change log

- [x] **CHANGE 1 Write coordination correctness (writeCoord.ts)**: `waitOnce()` fixed —
  the Round 18 code registered an INLINE abort arrow but removed a DIFFERENT named
  function (`onAbort`), leaking one listener + closure per wait; now ONE named listener
  is registered once and removed on EVERY completion path (gate, tick, abort, rejection),
  with an explicit settled-guard (exactly one resolve/reject). The re-check tick timer is
  always cleared (tickHandle.clear() in finally). Already-aborted signals throw
  'cancelled' BEFORE registration, and the lane-park path refuses to queue onto an
  aborted scope. Unused `sleep` helper removed. Tests: `tests/round19WriteCoord.test.ts`
  (11: listener-cleanup on gate/tick/cancel paths incl. unhandled-rejection probes,
  pre-aborted lock wait, pre-aborted lane sibling, timeout residue, partial multi-path
  failure release, orphaned-queue-entry after child exception, same-owner serialization,
  ambient Promise.all siblings, sorted multi-file overlap).
- [x] **CHANGE 2 Durable, recoverable receipts (toolRecord.ts/tools.ts/coordinator.ts)**:
  `persistRecord()` extracted as THE persistence boundary; `recordStartedStrict()` — the
  choke point now REFUSES to execute a side effect whose started receipt could not be
  persisted (structured RECEIPT UNAVAILABLE error, nothing runs). Duplicate receipt
  writes are idempotent per boot (`(id,status)` suppression set). CENTRAL idempotency
  classification (`toolIdempotencyClass`: idempotent = full-content overwrites;
  non-idempotent = compounding ops; unknown tools fail closed) + `classifyUnfinished()`
  (ledger-evidence states; verdict text embeds the recovery contract) +
  `reconcileUnfinishedAtResume()` — resume now writes classified durable 'reconciled'
  records for EVERY unresolved execution (both 'started'-no-twin and 'outcome_unknown'
  shapes) and injects `RECONCILE FIRST (<class>)` briefs into the owning steps.
  Crash-injection hook `setRecordAppendFailureForTests('before'|'after')` simulates the
  interruption on either side of the boundary. Tests: `tests/round19Receipts.test.ts`
  (9) + updated resume flow keeps round16b green.
- [x] **CHANGE 3 Dependency-aware planning (taskStore.ts/coordinator.ts)**: NEW
  `validatePlanGraph()` — explicit, reportable validation (unknown refs, self-refs,
  forward refs, DECLARED CYCLES via DFS over the planner's edge set) surfaced as a plan
  event before execution instead of silent edge-dropping; normalizePlan unchanged in
  repair semantics (all Round 18 pins hold). Cancellation mid-wave now settles steps the
  wave left 'running' (reconcileInterruptedSteps on the user-cancel path → pending +
  outcomeUnknown, no 'running' step under a terminal task). Tests in
  `tests/round19Loop.test.ts` (cycle detection+repair, missing-dep report, self-ref,
  cancel-during-parallel-waves settles every step, restart+resume never re-runs done
  work).
- [x] **CHANGE 4 Coordinator-controlled delegation (coordinator.ts)**:
  `reconcileSubtaskResults()` — combined agent results are validated; contradictory
  claims about the same deliverable are resolved against the DISK with an authoritative
  coordinator verdict. A FAILED delegation downgrades a still-DONE report to PARTIAL
  (stepReportFailed matches PARTIAL) — a failed agent can never silently complete its
  step. Delegation depth made explicit (`DELEGATION_DEPTH = 1`): `parseSubtaskProposals`
  now EXCLUDES the coordinator-appended SUBTASK RESULTS block, so a subtask's quoted
  output can never inject another delegation (found and closed by the new test).
- [x] **CHANGE 5 Hybrid semantic memory (semanticMemory.ts/memory.ts/projectMemory.ts)**:
  vector DIMENSION validation in hybridRetrieve (declared dims + per-vector length +
  count) — a wrong-shaped provider is a provider FAILURE with honest lexical fallback,
  never silent min-length truncation; `onProviderError` hook — relevantMemoryBlock and
  find_memory SAY the fallback happened ("LEXICAL, not semantic"). Stemmer defect fixed
  ("uses"→"us" broke use/uses matching — s+es now strips only the s). Provenance:
  memory records carry `source` (the saving execution) and corrections carry the
  correcting execution. find_memory is now a THREE-LAYER retrieval (structured long-term
  + project records with `project:<name>` scopes + the one hybrid pipeline), with
  per-hit `source` mechanism labels, a project scope filter, and contradiction flags
  (same core, different figures → prefer-newer note). `listAllProjectRecords()` exposes
  layer C. Tests: `tests/round19Memory.test.ts` (10).
- [x] **CHANGE 6 Browser execution & recovery (browser.ts)**: loading-state detection —
  waitLoaded reports whether the page ACTUALLY settled and settled() appends an explicit
  STILL LOADING note instead of silently snapshotting a half-rendered page;
  `clickRefRecovered()` — bounded recovery for stale/detached click targets: ONE
  re-observe → re-identify by label → policy classifiers RE-RUN on the recovered
  identity (label+meta+href) → retry only when the page has NOT navigated; navigation
  since the snapshot refuses the retry honestly; a genuinely-gone element fails without
  blind repetition. Recovery note travels in the action evidence.
- [x] **CHANGE 7 Desktop execution lifecycle (appControl.ts)**: post-action OBSERVE
  evidence in the same PowerShell session — GetForegroundWindow/GetWindowText joined the
  P/Invoke type + `Fore()` helper; click_text re-runs OCR after the click and reports
  whether the clicked text is still on screen (the verify step); click_control,
  click_at, type_text, press_keys append the foreground-window evidence;
  set_control_text now READS THE VALUE BACK through UIA and throws when the field does
  not hold the requested text (a silent SetValue no-op is a failure, not a success).
  Honest limit: Windows runtime paths cannot be executed in this Linux sandbox — the
  instrumentation is code-reviewed and the lifecycle contract is pinned by the desktop
  agent's output contract, not by a live Windows run.
- [x] **CHANGE 8 Two-restriction policy audit (permission.ts + test)**: classification
  gap closed — `make_document` (writes artifact FILES), `remember`, `save_contact`,
  `add_recurring_task`, `project_save` were misclassified as READ (no receipt, wrong
  action class at the gate); now write/config respectively. Registry-wide consistency
  pinned by `tests/round19Policy.test.ts` (18 tests): every side-effect tool non-read,
  delete-name tripwire for future tools, both hard restrictions deny for main AND
  children with no approval path, everything else autonomous.
- [x] **CHANGE 9 Cancellation & long-running execution**: browser action queue wrapper
  now refuses to dispatch any queued action once the execution scope is aborted (stale
  background work cannot keep acting on pages); coordinator user-cancel settles mid-wave
  steps (see CHANGE 3); writeCoord waits abort cleanly (CHANGE 1); existing
  round18Resilience pins (in-flight kill, no next tool after cancel, timeout-vs-cancel)
  all hold. Test in `tests/round19Loop.test.ts`.
- [x] **CHANGE 10 Autonomous worker loop integration (coordinator.ts)**:
  `outcomeSummary()` — the mandated outcome vocabulary (attempted / executed /
  completed / verified / failed / unresolved) computed ONLY from persisted state
  (attempts, statuses, outcomeUnknown, verification), with the verification source
  named; part of every taskStatusText view and the completion event. A task is never
  reported completed without naming what verified it.

## R19 final gate
- tsc (node) OK · tsc (app) OK · vitest **767/767** (56 files; 708 baseline + 59 new, 0 removed) · eslint src 0 errors.
- R19 next actions: ①Windows-runtime validation of the desktop evidence instrumentation on real hardware; ②embedding-provider settings UX (model download flow); ③per-model context budgets (§15.1 carryover); ④renderText/browseHeadless abort→destroy() (read-only residual).
