# JARVIS — ROUND 16 ENGINEERING REPORT

**Scope executed:** baseline revalidation of all 35 Round 15 findings against the current tree → Round 16A (hard security guarantees: F-01, F-02, F-04, F-05) → Round 16B (execution and task reliability: F-13, F-18, F-19, F-20, F-21 + idempotency consumption) → security/execution test suites → full regression, typecheck, lint, build, packaging.

**Verification status: typecheck clean · lint clean · 579/579 tests passing (38 files) · dev build, renderer build and electron-builder packaging completed · packaged app.asar byte-verified to contain the Round 16 code.**

---

## 1. Baseline findings (F-01 … F-35 vs the current source)

Every finding was re-derived from the actual source (files read in full, execution paths traced), not from the report's claims. Status legend: CONFIRMED = still present when this round started; FIXED = resolved by Round 16; OPEN = real, still present, outside this round's assigned scope.

| ID | Sev | Title (short) | Status vs current source | Evidence (as found at baseline) |
|----|-----|----------------|--------------------------|--------------------------------|
| F-01 | High | Interpreter one-liners bypass both hard-limit classifiers | **FIXED (16A)** | `policy.ts` `shellVerdict` had three keyword layers only; `python -c "os.remove(...)"` matched none of them; `node -e "fs.writeFileSync('C:/Windows/x','y')"` had no write-ish shell verb |
| F-02 | High | Copy-source exception let MOVE extract files out of protected dirs | **FIXED (16A)** | `sourceOfCopy` regex included `move`, `move-item`, `mv`, `robocopy`, `tar` (policy.ts:278) |
| F-03 | Medium | run_python literal scanning defeated by string concatenation | OPEN (residual documented) | `pythonVerdict` reads literals from raw code only (policy.ts:326–331); the dynamic-construct deny list (eval/exec/getattr/`__import__` blocked) still bounds practical exploitability |
| F-04 | Medium | Two protected-path lists drift; apply_patch blind on POSIX | **FIXED (16A)** | `workspace.PROTECTED` (Windows-only) vs `policy.OS_PATH_PATTERNS`; guard extracted only `*** Delete File:` ops; patch write path went through the POSIX-blind list |
| F-05 | Medium | stop_process by PID slipped past the process classifier | **FIXED (16A)** | `assessRisk` fed the numeric pid string to a name-only regex; tool-level `PROTECTED_PROCS` set diverged from `CRITICAL_PROCESS` in both directions |
| F-06 | Medium | Symlink TOCTOU in path guards; DNS rebinding in fetch guard | OPEN | `osPathRisk` realpath-then-write (guard.ts:41–66); `assertPublicUrl` resolves, then `electronNet.fetch` re-resolves (webTools.ts:47–77) |
| F-07 | Medium | Failure signalled by output-text prefixes; four consumers disagree | OPEN | provider.ts:459–461, orchestrate.ts:280, coordinator.ts:156, subagent.ts:46 — four regexes, none identical |
| F-08 | Medium | Tool visibility decided by keyword regexes over request text | OPEN | `ALWAYS_ON = ['browser','desktop']`; files/productivity groups regex-gated (toolRouter.ts) |
| F-09 | Medium | Tools cannot be cancelled; Stop dead for minutes | OPEN | `runTool(requested, rawArgs)` takes no AbortSignal; execFile/fetch/browser waits unconnected |
| F-10 | Low | Fuzzy tool-name rescue can substitute a different read-only tool | OPEN | `resolveTool` edit-distance ≤ max(2, len/4) within parallelSafe/SAFE_RETRY |
| F-11 | Low | Argument coercion ignores enums/ranges | OPEN | `toolArgs.checkArgs` validates types/required only |
| F-12 | Medium | Final answer never streamed (arrives as one delta) | OPEN | turn loop calls `complete(m, () => undefined, signal)`; content handed to onDelta once at the end |
| F-13 | High | New requests assassinate the running turn; scheduled tasks kill each other | **FIXED (16B)** | `chat()` aborted before queueing (provider.ts:288); scheduler ran due tasks under `Promise.all` through `chat()`; index.ts:119 registered `chat` as the runner |
| F-14 | Low | Token usage is one global slot clobbered by parallel sub-agents | OPEN | `noteUsage`/`lastTokenUsage` single module variable (llm.ts:65–83) |
| F-15 | Low | Context-pressure thresholds hardcoded for large-window models | OPEN | TURN_CHAR_BUDGET 90k / PROMPT_TOKEN_PRESSURE 60k constants; model is free-text with no window metadata |
| F-16 | Low | A failed turn erases its own context to a one-line note | OPEN | runTurn catch truncates to turn start + `I could not finish that:` |
| F-17 | Low | Permanent-model-rejection detection matches English wording only | OPEN | `MODEL_GONE_RE` curated phrase list (llm.ts:12–29) |
| F-18 | High | Stall watchdog kills healthy long-running steps (heartbeat only at step boundaries) | **FIXED (16B)** | `renewClaim` called once per loop iteration; `STEP_TIMEOUT_MS` (10 min) equaled both the agent budget and the stale threshold; taskStore `STALE_OWNER_MS` also 10 min |
| F-19 | High | Resume is re-plan: interrupted tasks restart from scratch | **FIXED (16B)** | `drive()` unconditionally `PLANNING`→`planTask`→`setSteps`; `resumeTask` went through `drive`; idempotency keys recorded but never consumed (toolRecord.ts:180–190) |
| F-20 | Medium | Orphaned RUNNING steps block the scheduler | **FIXED (16B)** | `stepEligible` requires `pending`; boot reconciliation left the mid-flight step `running` (taskStore.ts:158–167, 332–338) |
| F-21 | Medium | No write serialization across engines sharing one workspace | **FIXED (16B)** | Write serialization existed only inside one `parallel_tasks` call (orchestrate.ts:139–156); turn loop, detached drives and background jobs had no coordination |
| F-22 | Low | TaskSpec: polite phrasing/question marks classify actions as informational | OPEN | `QUESTION_RE` tested before `wantsAction` (taskSpec.ts:64, 112–114) |
| F-23 | Medium | Verifier resolves relative paths against CWD, not the workspace | OPEN | `path.resolve(process.env.JARVIS_FILES_ROOT ?? '.', p)` at verifier.ts:65, 78, 134 — ignores `workspace.FILES_ROOT` |
| F-24 | Medium | atomicWrite fixed tmp name; unserialized saves can corrupt a store | OPEN | `tmp = file + '.tmp'` (store.ts:10); scheduler `save()` unserialized |
| F-25 | Low | No fsync before rename (power-loss window) | OPEN | store.ts:9–13 |
| F-26 | Low | apply_patch non-atomic under process death | OPEN | patch.ts snapshot-in-memory + direct writes (exception-atomic only) |
| F-27 | Low | Edit paths assume UTF-8; UTF-16 files corrupted | OPEN | edit_file/multi_edit/apply_patch read `utf8`, write `utf8` |
| F-28 | Low | Background jobs and timers are memory-only | OPEN | `jobs Map` (agi.ts:161), `timers Map` (extraTools.ts:35) |
| F-29 | Medium | Memory revision detection only understands currency amounts | OPEN | 0.85-similarity contradiction path gated on currency regex (memory.ts:174); 0.7 Jaccard dedupe (memory.ts:131) |
| F-30 | Low | Correction detection fires on any refusal-shaped opener | OPEN | `CORRECTION` regex (learn.ts:41–42) |
| F-31 | Low | Quality gate flags honest historical dates; evidence pool truncated at 4,000 chars | OPEN | `DATED_RE` check (quality.ts:114–116, 186+); provider evidence push slice(0, 4000) |
| F-32 | Medium | DNS rebinding defeats the private-address fetch guard | OPEN | validate-then-fetch with independent DNS (webTools.ts:47–77) |
| F-33 | Low | Web search = HTML scraping of DuckDuckGo/Bing, no health signal | OPEN | webTools.ts:112, 142 |
| F-34 | Low | Renderer can write arbitrary keys into a main-process electron-store | OPEN | `store-get`/`store-set` unscoped (index.ts:143–150) |
| F-35 | Low | Uncaught exceptions/rejections only console-logged | OPEN | index.ts:28–29 |

**Findings that still required changes when implementation began:** F-01, F-02, F-04, F-05 (16A); F-13, F-18, F-19, F-20, F-21 + idempotency consumption (16B). All nine were implemented. No already-fixed behaviour was re-touched.

**Dependencies between findings:** F-19 ↔ F-20 (resume without re-plan is only correct if orphaned steps become schedulable — implemented together). F-18 ↔ F-19 (a resumed task must not be immediately re-killed by the watchdog — heartbeat + decoupled threshold land together). F-05 ↔ F-01 (the kill-verb pairing extends the same central shell classifier the interpreter routing lives in). F-21 required no changes to the authorization path (locks run inside `tool.run`, after the gate).

**Existing tests that covered the relevant behaviour at baseline:** policy.test.ts (78), policyAdversarial.test.ts (21), enforcement.test.ts (16), permission.test.ts (19), coordinator.test.ts (15 — including stall detection with a simulated ancient claim and gated steps), fsPatch.test.ts (12), scheduler coverage inside modes/round suites. **Missing regression tests (now added):** interpreter payload routing, move-source blocking, POSIX patch-target blocking, PID resolution at the gate, scheduled-vs-interactive isolation, heartbeat-vs-stall margin, resume-without-re-plan, orphan reconciliation with unresolved receipts, per-path write coordination.

---

## 2. Implemented changes

### Round 16A — hard security guarantees

**F-01 — Interpreter one-liners bypass the classifiers**
- Original failure: `run_command`'s only defense was keyword scanning of the outer shell text; payloads of `python -c`, `node -e`, `perl -e`, `ruby -e`, `php -r`, `lua -e` were invisible.
- Root cause: the classifier treated executable code in another language as ordinary shell text.
- Files: `src/main/policy.ts` (new interpreter section), `src/main/devTools.ts` (unchanged — inherits via shellVerdict), `src/main/verifyExec.ts` (unchanged — inherits).
- Implementation: `INTERPRETER_CALL` extracts every invocation's payload (quoted args parsed with PowerShell `\"`/`""` escapes, nested `powershell -Command "… -c \"…\""` layers, multiline payloads, bare payloads consumed to end-of-string over-inclusively). Routing: python payloads → `pythonVerdict`; JS payloads → new `nodeVerdict` (denies eval/`new Function`/`require('vm')`, `process.kill`, unlink/rm family, and write-API + protected-path-literal pairing); unclassifiable languages → fail closed on any protected-path literal or deletion primitive. `shellVerdict` runs this as its final layer, so **every** shell route (run_command gate + second layer, verification runner) inherits it. Pinned legitimate surface preserved: `node -e "console.log(process.version)"`, `python -m pytest`, `node server.js`, `gcc -c foo.c` all stay allowed.
- Why it closes: the payload is now classified by the same central code classifiers that gate `run_python`, and languages that cannot be analysed fail closed instead of being waved through.
- Limitation (documented in code): no regex understands arbitrary dynamic code; dynamic-execution constructs are denied outright for python/JS, and concatenated path fragments in *unclassifiable* languages remain a residual — the same residual F-03 records for python, and it is documented at the classifier.

**F-02 — Protected-source move exception**
- Files: `src/main/policy.ts`.
- Implementation: the source exception is now copy-only (`copy`, `copy-item`, `cp`, `xcopy`, `tar`, and `robocopy` only when the command carries no `/MOV`/`/MOVE`). Move-family (`move`, `move-item`, `mv`, `ren`, `rename`, `rename-item`) with a protected source is blocked as os-resource; `ren`/`rename` were added to SHELL_WRITEISH (a rename is a directory write). Reason string updated: "Writing to or moving files out of an operating-system location through the shell is disabled."
- Why it closes: `move C:\Windows\f.txt D:\backup\` and `robocopy … /MOV` can no longer ride the backup-reading exception; pure copies still work.

**F-04 — Duplicated protected-path definitions**
- Files: `src/main/workspace.ts`, `src/main/guard.ts`, (`src/main/policy.ts` unchanged — it is the authority).
- Implementation: `resolveWrite` now classifies through `policy.osProtectedPath` (the POSIX-aware list) and the private `PROTECTED` array is deleted. `guard.assessRisk` for `apply_patch` extracts **every** op target — Add/Update/Delete File and Move-to — and runs them through `osPathRisk` alongside explicit path args.
- Why it closes: one list, one classifier, used by the gate (all tools), resolveWrite (all write-capable tools incl. patch), and the shell pairing. `apply_patch` Update/Add of `/etc/hosts` is now blocked at the gate AND at the tool layer, on POSIX as on Windows; `write_file` and `apply_patch` can no longer disagree.
- Compatibility note: `resolveWrite`'s error message changed to "That location is protected (operating-system files are read-only). Choose another folder." — message-only, no format contract exists.

**F-05 — PID-based process termination bypass**
- Files: new `src/main/procInfo.ts`; `src/main/guard.ts`; `src/main/laptopTools.ts`; `src/main/policy.ts`.
- Implementation: `PROTECTED_PROCESS_NAMES` is now the single exported definition (union of both former lists, incl. `explorer` and JARVIS itself); `CRITICAL_PROCESS` is derived from it. New `resolveProcessName(pid)` (tasklist on Windows, `ps -p … -o comm=` on POSIX) is THE resolver. `guard.assessRisk('stop_process')` resolves a PID to its identity from the OS process table — never from model-supplied text — and classifies it; an unresolvable PID fails closed. The tool deletes its private `PROTECTED_PROCS` set, resolves by PID through the shared resolver, and for name-based kills verifies the actual image name against tasklist before classifying through the same policy verdict. Shell route closed too: `shellVerdict` now blocks kill-verbs (`taskkill`, `Stop-Process`, `tskill`, `pskill`, `kill`) paired with a protected process name. Bonus hardening: `psutil` added to python's native-OS deny list; `node -e "process.kill(…)"` denied by `nodeVerdict`.
- Why it closes: PID and name terminations get identical protection from one list; the identity is resolved at the execution boundary; JARVIS itself is protected on every route.

### Round 16B — execution and task reliability

**F-13 — Execution ownership and cancellation isolation**
- Files: `src/main/provider.ts`, `src/main/scheduler.ts`, `src/main/index.ts`.
- Implementation: `chat()` gained an execution source (`'interactive' | 'scheduled'`). Interactive requests interrupt only the previous interactive turn (existing product behaviour, preserved) and queue behind any scheduled turn; scheduled requests never abort anything and chain behind everything; the scheduler now runs due tasks **sequentially** in due order. The global turn signal is bound when a turn **starts** (not when queued — the old code re-pointed the signal while the previous turn was still executing, detaching its sub-agents from their own cancellation scope). Every abort now carries a reason (`stopped by the user`, `replaced by a newer user request`, watchdog stall) and the interrupted turn records what actually interrupted it instead of assuming "the user". Coordinator tasks, background jobs and sub-agents keep their own cancellation scopes (controller per task; signal passed explicitly).
- Why it closes: two scheduled tasks can no longer terminate each other (sequential + chained), a scheduled follow-up can no longer kill a conversation, cancellation propagates only into a parent's own children, and interruption sources are recorded.

**F-18 — Lease/heartbeat watchdog**
- Files: `src/main/coordinator.ts`, `src/main/taskStore.ts` (unchanged semantics), `src/main/index.ts` (watchdog interval unchanged).
- Implementation: every drive claims the task with a **unique ownership token** (`coordinator:<time><rand>`) and renews it on a `setInterval` (default 30 s) for the whole drive — steps and verification alike — instead of only at step boundaries. The stall threshold is decoupled from any step budget: `checkStalls` marks a task INTERRUPTED only after 5 minutes **without a renewal** (a multiple of the heartbeat), and it aborts with a precise reason. `renewClaim`'s existing owner-equality check is what makes the token meaningful: a stale driver's timer can never renew a lease it no longer holds. The heartbeat interval is cleared in the drive's `finally` (no leaked timers). Test hook `setCoordinatorTimingForTests(hb, stall)` makes the margins deterministic in tests.
- Why it closes: a healthy step of any length keeps its lease (verified by test at 700 ms against a 300 ms threshold — the old code killed exactly this); genuinely dead drivers are still detected; ownership races resolve in favour of the live token.

**F-19 + F-20 — Resume continues persisted work; orphans reconciled**
- Files: `src/main/coordinator.ts`, `src/main/taskStore.ts`, `src/main/toolRecord.ts`, `src/main/tools.ts`.
- Implementation: `drive()` branches — if the task already has persisted steps, it **skips planning entirely**, reconciles, and drives the existing list; only a step-less task plans. Completed steps and their results are never touched; only unfinished steps are scheduled; `dependsOn` relations survive. `reconcileRunningSteps` (taskStore) resets orphaned `running` steps to `pending` **only after the caller holds a fresh claim**, preserving attempt history; the interruption reason is recorded in the task note and per-step events. Resume of a fully-done task goes straight to verification. `resumeTask`'s reply states the true continuation point ("resumed from step N" / "resumed at verification").
- Idempotency consumption: `runTool` now writes an `outcome_unknown` receipt **before** dispatching any tool (awaited, same correlation id, not mirrored into the interactive tool log); the completion record supersedes it. `unresolvedExecutionsFor(taskId, stepId)` finds receipts whose newest record is `outcome_unknown` — the crash-between-dispatch-and-recording window. On resume, any unresolved receipt for the reconciled step is injected into that step's instructions (`RECONCILE FIRST: …`) so the retry verifies real state instead of blindly repeating a possibly-completed side effect.
- Why it closes: "resume" now means resume; the durable store's core promise holds; unknown outcomes are explicit states that force reconciliation.
- Limitation (stated honestly): automatic reconciliation of arbitrary external side effects is impossible in general; for external systems without idempotency support the safest strategy — verify-then-redo-only-if-missing, driven by the injected warning — is implemented, and the residual is named in the record schema docs.

**F-21 — Workspace write coordination**
- Files: new `src/main/writeGate.ts`; `src/main/tools.ts` (write_file, edit_file), `src/main/fsTools.ts` (multi_edit), `src/main/patch.ts` (apply_patch), `src/main/laptopTools.ts` (copy_file, move_file).
- Implementation: per-**canonical-path** async mutex at the authoritative write layer. Independent files never block; the same path is strictly serialized across interactive turns, coordinator drives, sub-agents and background jobs. Editor tools do their read **inside** the lock, so an edit never applies to a stale snapshot; a racing editor therefore fails loudly ("old_text was not found") instead of silently overwriting. Multi-path acquisition (patch, move) is sorted-canonical — deadlock-free. Locks release in `finally` (errors and cancellation cannot leak them); a waiter that cannot get the lock within 60 s fails with a **structured conflict** naming the holding agent so the model can re-read and reconcile. The authorization policy is untouched — the gate orders writes the policy already allowed.
- Why it closes: concurrent writes to one file can no longer silently overwrite each other; the loser gets structured, actionable information.

---

## 3. Architecture changes (summary)

- **Execution ownership:** every turn carries a source (`interactive`/`scheduled`); every coordinator drive carries a unique ownership token; every tool call carries its agent/task/step context (pre-existing AsyncLocalStorage, now also feeding lock-holder identities and receipts).
- **Cancellation isolation:** interactive→interactive interruption only; scheduled never aborts; scheduler serializes its own work; coordinator cancellation is per-task-controller with token-verified claims; sub-agent signal binding happens at turn start.
- **Heartbeat and lease model:** 30 s renewal interval vs 5 min stall threshold (5:1 margin, independent of any step budget); ownership-token-verified renewal; watchdog = dead-driver detector, not a slow-step killer.
- **Resume and reconciliation:** persisted plan is authoritative on resume; orphaned running steps are requeued post-claim; interruption reasons and unresolved executions are surfaced in the step instructions.
- **Idempotency handling:** start receipt (`outcome_unknown`) + completion record under one correlation id; consumers query unresolved receipts before repeating side effects.
- **Workspace write coordination:** per-canonical-path FIFO mutex with sorted multi-acquisition, finally-release, structured conflict on timeout, stale-holder bounding.
- **Central authorization enforcement:** unchanged in shape — one gate (`guard.assessRisk` → `permission.authorize`) at the single choke point (`runTool`); Round 16 only widened what the classifiers can see (interpreter payloads, patch op targets, resolved process identities, kill-verb pairings) and deleted the last private lists (workspace `PROTECTED`, tool `PROTECTED_PROCS`).

---

## 4. Functional test report

All tests below were actually executed (`npx vitest run`); none is claimed without a run. Unit = classifier/pure logic; integration = real coordinator/provider/store over real files and a real local HTTP endpoint; restart/recovery = simulated crash + boot-reconciliation semantics + `task_resume`.

### Round 16A — security (`tests/round16a.test.ts`, 18 tests — all PASS)
| Test | Kind | Result | Evidence |
|---|---|---|---|
| python one-liners judged by pythonVerdict (deletion, rmtree, unlink, open-protected, subprocess) | integration (gate→authorize) | PASS | authorize returns blocked for all 5 forms |
| node one-liners: protected writes/deletion/process.kill blocked; `console.log(process.version)` stays allowed | unit+gate | PASS | shellVerdict/nodeVerdict verdicts |
| unclassifiable languages fail closed on OS targets; harmless one-liners allowed | unit | PASS | perl/ruby/php/lua cases |
| quoting/escaping/multiline/composition cannot hide the payload (6 forms incl. nested PowerShell quoting, `&&` chains) | unit | PASS | all blocked |
| payload extraction correctness (2 invocations, no false positives on `npm run build`, `python -m pytest`, `node server.js`, `gcc -c`) | unit | PASS | interpreterPayloads output |
| interpreter route closed for child agents and the verification runner (runCmd returns `BLOCKED:` before any process) | integration | PASS | gate + runCmd output |
| resource-unchanged proof: blocked interpreter deletion leaves the file byte-identical | integration (real fs fixture) | PASS | file content re-read |
| pure copies from protected stay allowed (copy/xcopy/robocopy /mir) | unit | PASS | not blocked |
| move-family from protected blocked: move/Move-Item/mv/robocopy /MOV·/MOVE/ren/Rename-Item | unit | PASS | os-resource verdicts |
| ordinary workspace move + copy through the REAL tools still work (file actually moved/copied, source gone) | integration (real fs) | PASS | tool outputs + fs state |
| apply_patch Add/Update/Move-to targets classified by the guard (incl. `/etc/hosts`, `/etc/cron.d`) | integration (gate) | PASS | blocked |
| tool layer refuses POSIX-protected patch target; resource unchanged | integration (real fs, reads /etc/hosts before/after) | PASS | throws + byte-identical |
| resolveWrite enforces the policy list incl. POSIX roots; workspace paths stay writable | integration | PASS | rejects + resolves |
| ordinary patch work inside the workspace still applies | integration (real fs) | PASS | "Patched:" + content |
| protected-process list exported once, verdict uses it (all names blocked; notepad/chrome allowed) | unit | PASS | processVerdict |
| PID resolving to a protected process blocked at the gate (windefend, jarvis itself) — identity from the OS | integration (delegated resolver mock) | PASS | blocked |
| unresolvable PID fails closed | integration | PASS | blocked |
| shell kill-verbs cannot reach protected processes by name; ordinary taskkill notepad allowed | unit | PASS | verdicts |

### Round 16B — execution reliability (`tests/round16b.test.ts`, 14 tests — all PASS)
| Test | Kind | Result | Evidence |
|---|---|---|---|
| scheduled follow-up never aborts a running interactive turn (queues behind it) | integration (real provider over real HTTP socket) | PASS | turn 1 completes with its reply; both seen |
| two scheduled follow-ups run strictly sequentially (max concurrency 1, due order preserved) | integration (scheduler tick + runner instrumentation) | PASS | statuses done/done, order A,B |
| REAL scheduler→chat path: both scheduled turns complete, neither aborts the other | end-to-end (scheduler + provider + HTTP server) | PASS | per-task verdicts recorded |
| interactive still interrupts previous interactive (product behaviour preserved) | integration | PASS | p1 = '', p2 completes |
| turn signal bound at start, not queue time; cleared after chain drains | integration | PASS | signal observations |
| healthy step beyond the OLD watchdog threshold (700 ms vs 300 ms threshold, 40 ms heartbeat) completes | integration/recovery | PASS | task COMPLETED, step done |
| genuinely abandoned worker → INTERRUPTED; dead token cannot renew; fresh worker CAN claim | recovery | PASS | checkStalls + claim outcomes |
| multi-step resume: no re-plan (planner called once), done steps NOT re-run, s3 completes, verification passes, deliverable exists | restart/recovery (real coordinator + persisted store + receipt ledger) | PASS | planner spy, call log, final state |
| unresolvedExecutionsFor returns exactly never-completed receipts; per-step filter works | unit/integration (real JSONL ledger) | PASS | id list |
| independent files write truly concurrently; same path strictly serialized | integration (real locks + timers) | PASS | observed max in-flight 2 vs 1 |
| two engines editing the same file via the REAL tool never lose an update (serialized RMW; loser fails loudly; file is one winner's content) | integration (real multi_edit, two agent contexts) | PASS | exactly 1 fulfilled / 1 rejected with "old_text was not found" |
| locks released on errors (no leak) | integration | PASS | second acquire succeeds |
| hung holder surfaces a STRUCTURED conflict (names the holder) instead of waiting forever | integration (shrunk timeout hook) | PASS | CONFLICT error text |
| full engine mix writes different files at once (main + coordinator child + background identities) | integration | PASS | all three applied independently |

### Pre-existing regression suite
`npx vitest run` → **38 files, 579/579 PASS** (547 pre-existing + 32 new). No existing test was weakened or deleted; `tests/helpers/electronStub.ts` gained an optional overrides parameter (backwards compatible — all existing callers pass no argument).

**Known test-environment limitations:** PID resolution's Windows branch (`tasklist`) and `taskkill` were exercised on POSIX via the `ps` branch and mocks; the Windows-specific commands themselves were NOT executed on Windows (stated per Part 7 — no claim is made). The packaged build produced Linux targets in this sandbox (AppImage/snap); the Windows NSIS target is configured but was not built here.

---

## 5. Regression and build report

| Check | Command | Result |
|---|---|---|
| TypeScript (node + app configs) | `npm run typecheck` | PASS (0 errors) |
| Lint | `npm run lint` | PASS (0 errors, 0 warnings) |
| Full test suite | `npx vitest run` | PASS — 38 files, 579/579 |
| Dev build (main + preload) | `npm run build:dev` | PASS |
| Renderer build | `npm run build:renderer` | PASS |
| Production build + packaging | `npm run build` | PASS (electron-builder: AppImage + snap + linux-unpacked produced) |
| Compiled-output inspection | 22 content checks over `dist/main/*.js` | PASS — every Round 16 change present |
| Packaged-output inspection | content checks inside `release/linux-unpacked/resources/app.asar` | PASS — interpreterVerdict, withPathLock, PROTECTED_PROCESS_NAMES present |

Remaining failures: none.

---

## 6. Remaining findings (unchanged unless listed above)

OPEN and untouched this round (not claimed fixed): **F-03, F-06, F-07, F-08, F-09, F-10, F-11, F-12, F-14, F-15, F-16, F-17, F-22, F-23, F-24, F-25, F-26, F-27, F-28, F-29, F-30, F-31, F-32, F-33, F-34, F-35.** Two partial-credit notes, stated without upgrading their status: F-03's practical exploitability is further bounded by the interpreter routing and the new dynamic-execution denies, but the concatenation residual remains by design; F-05's process policy is now single-list, but the kill-verb *shell* pairing is name-based only (PID-form shell commands are covered at the guard by resolution, not inside the pure classifier).

---

## 7. Deliverables

- Updated source: `src/main/policy.ts`, `guard.ts`, `workspace.ts`, `laptopTools.ts`, `provider.ts`, `scheduler.ts`, `index.ts`, `coordinator.ts`, `taskStore.ts`, `toolRecord.ts`, `tools.ts`, `fsTools.ts`, `patch.ts` + new `procInfo.ts`, `writeGate.ts`.
- New tests: `tests/round16a.test.ts` (18), `tests/round16b.test.ts` (14); updated helper `tests/helpers/electronStub.ts`.
- Migrations: none required — task-record shape unchanged (resume works from existing persisted `task-*.json` files); the tool-record JSONL gained one additive status value (`outcome_unknown`), readable by older consumers as an unknown status.
- Release ZIP: `jarvis-round16-verified.zip` (source + tests + compiled dist; no node_modules, no release/, no caches).
- Exact commands: `npm run typecheck` · `npx vitest run` · `npm run lint` · `npm run build:dev` · `npm run build:renderer` · `npm run build` · packaged-output verification via node content checks (shown above).
