# JARVIS — ROUND 20 REPORT
## Completion, Correctness & Production-Grade Autonomy

**Starting point:** `JARVIS_ROUND19.zip` (Electron + TypeScript, ~19.5k LOC `src/main`, 56 test files / 767 tests, all green at baseline).
**Approach:** no rewrite. Every change below was made inside the existing architecture (one coordinator, one task store, one tool choke point, one write coordinator, one policy brain), each justified by a demonstrated defect found by inspecting the actual Round 19 source.

**Final measured state (all numbers from the final run in this environment, Linux CI):**

| Gate | Baseline (Round 19) | Final (Round 20) |
|---|---|---|
| `npx vitest run` | 767 / 767 pass (56 files) | **822 / 822 pass (62 files)** — 55 new tests, 0 removed |
| `npm run typecheck` | OK | **OK** |
| `npx eslint src` | 0 problems | **0 problems** |
| `vite build` (renderer) | OK | **OK** |
| `tsc` main + preload build | OK | **OK** |
| `electron-builder --dir` | not run | **OK** (Linux-unpacked; NSIS target is Windows-only) |
| App startup (packaged, Xvfb) | not run | **validated** — main process boots, renderer loads, IPC live |
| Windows desktop validation | pending | **still pending** (no Windows environment — see Test Report §9) |

---

## CHANGE 1 — Execution receipts are truly durable

**Previous behavior.** The started receipt was strict (`recordStartedStrict`, awaited, refuses execution on failure), but the completion path used the lenient `recordExecution()`, which caught persistence errors, warned once, and resolved anyway. A tool whose completion receipt failed to persist was still reported as completed.

**Defect.** JARVIS could report an operation as completed even when its completion receipt never reached the durable ledger. The verifier and every reconciliation query rely on that ledger, so a silent append failure degraded the evidence chain invisibly.

**Root cause.** `recordExecution()` in `src/main/toolRecord.ts` swallowed the rejection (`persistRecord(rec).catch(warn)`), and `finish()` in `src/main/tools.ts` had no way to learn whether the outcome was durable.

**New behavior.**
- An explicit persistence contract: every persistence operation returns `PersistenceOutcome { durable, durableStatus?, error? }` — durability is reported, never hidden.
- Separate, clearly named lifecycle operations: `recordStartedStrict` (pre-execution, strict), `recordOutcome` (the one strict completion path), and the semantic wrappers `recordCompleted` / `recordFailedExecution` / `recordCancelledExecution` / `recordUnknownOutcome` / `recordReconciled` (also strict now).
- Escalation when the ledger fails after a side effect may have run: (1) one controlled retry of the real outcome; (2) an explicit `outcome_unknown` record — the durable REQUIRES-RECONCILIATION marker; (3) the real outcome retained in a bounded (200-entry, FIFO-evicted) in-memory pending set, retried by a controlled flush (`flushPendingOutcomes`, 15 s unref'd timer, hard stop at 40 attempts with a loud warning).
- The crash-after-durable window is handled exactly: an append that landed but whose caller saw a failure is recognized as durable (via the written-key registry) and never double-appended; the started receipt stays fail-closed (a caller that could not observe the append must assume it did not land, so the side effect does not run — the Round 19 pin is preserved).
- The dispatch choke point (`tools.ts`) tracks `startedReceiptDurable`; `finish()` reports `receiptPending` on the envelope and appends a `RECEIPT PENDING` note when the exact outcome is not what is durable — the action is never pretended to have failed, and the caller is told not to repeat it.
- Recovery paths consume the contract: `resumeTask` flushes pending outcomes before driving; `recordReconciled` settlements can no longer vanish silently.

**Modified files.** `src/main/toolRecord.ts`, `src/main/tools.ts`, `src/main/toolResult.ts` (envelope field), `src/main/verifyExec.ts`, `src/main/coordinator.ts` (flush at resume).

**Regression tests.** `tests/round20Receipts.test.ts` (9 tests): side effect ran + receipt failed → real result preserved, `receiptPending` true, durable `outcome_unknown` on disk; not-run outcomes never get unknown markers; flush lands exactly once after the ledger heals; bounded give-up after the attempt budget; crash-after-durable never double-appends; total-ledger-outage keeps the outcome pending, never dropped; strict-path idempotency. Round 19's receipt suite (13 tests) still passes unchanged.

**Actual result.** 9/9 new + 13/13 pinned tests pass; full suite 822/822.

---

## CHANGE 2 — Write-coordinator cancellation races eliminated

**Previous behavior.** Round 19's `waitOnce` registered a named abort listener removed on every path, but the *lane-queue* path (Promise.all siblings under one scope token) pushed the waiter into the queue first and registered the abort listener second. `waitOnce` checked `signal.aborted` before registering.

**Defect.** Two check-then-register windows: (a) a sibling parked in the lane queue whose scope aborted between the queue push and listener registration parked **forever** (a listener on an already-aborted signal never fires) — a permanent hang holding a lane reference; (b) a wait whose signal aborted between the aborted-check and listener registration drifted up to the tick interval instead of cancelling promptly.

**Root cause.** Register-after-check ordering on `AbortSignal`, whose `abort` event never fires for listeners added after the signal is already aborted.

**New behavior.** Both waits now **register first, check second**: one stable named listener per wait, removed by the exact same reference on every exit path (gate, abort, timeout, foreign rejection); `settled` flags make double resolution impossible; the abort path removes the cancelled waiter from the queue, so a cancelled sibling can never later be granted the lane or the lock; the tick timer is cleared in a `finally` on every path. Reentrancy, lane fairness (parked siblings still complete, in order), sorted multi-key acquisition, dead-scope stealing (only when `frames === 0`) and structured WRITE CONFLICT errors are unchanged.

**Modified files.** `src/main/writeCoord.ts`.

**Regression tests.** `tests/round20WriteCoord.test.ts` (12 tests): uncancelled parked siblings complete in order; aborted-while-parked siblings reject with `cancelled`, leave no lane entry, and later acquisitions succeed; pre-aborted signals never queue a lane waiter; an abort during the wait settles promptly (well under the acquire timeout); nested reentrancy + Promise.all siblings serialize (peak concurrency 1); concurrent same-owner operations serialize while independent files don't block; overlapping multi-resource sets never deadlock; exceptions release everything; a healthy long-running operation is never stolen (13 stale windows under it — waiters get structured conflicts); an abandoned scope is stealable; timeouts and mid-run cancellations release all locks and scopes. Round 18/19 writeCoord suites (27 tests) pass unchanged.

**Actual result.** 12/12 new + 27/27 pinned tests pass.

---

## CHANGE 3 — Persistence and recovery are crash-safe

**Previous behavior.** `atomicWrite` already used unique temp names, fsync-before-rename and per-path op chains (kept as-is). `loadJson` logged a corrupt file and returned the fallback — the previous good state was unrecoverable, and the corrupt bytes were silently discarded.

**Defect.** A corrupt memory/settings store reset to empty with no path to the last good data; receipt appends were not fsynced, so "durable" was stronger than the actual filesystem guarantee; the ledger's evidence could be lost in a power cut after the append resolved.

**Root cause.** No backup version existed to recover from; `atomicAppend` never synced the handle.

**New behavior.**
- `atomicWrite` maintains `<file>.bak` (the previous good version) with a crash-consistent copy order: every interruption point leaves a consistent (main, bak) pair.
- `loadJson` corrupt-file recovery, in order: quarantine the damaged bytes (`<file>.corrupt-<ts>`, never silently destroyed) → recover from `.bak` and restore it atomically → only with no readable backup start fresh, loudly. Idempotent: a second call after recovery just parses.
- `atomicAppend` fsyncs every append — the ledger's durability claim now matches the real guarantee. Directory fsync stays POSIX-only and documented as such (Windows relies on the atomicity of the rename; no stronger claim is made).

**Modified files.** `src/main/store.ts`.

**Regression tests.** `tests/round20Receipts.test.ts` (4 store tests): corrupt main + `.bak` present → quarantined + recovered + idempotent; corrupt with no backup → loudly fresh; 12 concurrent writers → one whole version, zero temp debris; fsynced appends survive a torn tail line. `tests/hardening.test.ts` (Round 17 store pins) passes unchanged.

**Actual result.** 4/4 new + 5/5 pinned store tests pass.

---

## CHANGE 4 — Planning and execution are consistent under real failures

**Previous behavior and defects (four distinct ones found in source).**
1. Dependent steps of a failed branch stayed `pending` forever — the `skipped` status was dead code; the task failed with an ambiguous account.
2. `replanSteps` dropped completed steps the replanner didn't re-include, and a replanned step's positional id could collide with a preserved step's id; `outcomeUnknown`, interruption history and attempt counts were laundered away for pending/failed steps — recovery state was lost across a replan.
3. No identical-plan guard: a replanner returning the same remaining steps burned the replan budget (bounded only by `REPLAN_BUDGET = 1`); no whole-task wall-clock budget: the stall watchdog measured heartbeat staleness, which the wave heartbeat renewed every 60 s, so a looping task could run indefinitely.
4. `verifyTask` ran `verifyAcceptance` twice when a reviewer was available — re-stat'ing files and **re-executing verification commands** (`npm test` twice: cost, flakiness, non-deterministic second outcomes).

**New behavior.**
1. **Skip propagation:** when no replan remains, pending steps blocked by failed dependencies are marked `skipped` with the reason recorded (`SKIPPED: a dependency failed …`); successful branches are preserved into verification, which decides the task's fate on evidence.
2. **Replanning correctness:** completed/skipped steps absent from the new plan are preserved verbatim (ids reserved before new ids are assigned — collisions impossible); pending/failed steps keep identity plus `outcomeUnknown`, `interruptions` and `attempts`; an identical-plan guard refuses a replanner that returns the same remaining titles without consuming the budget.
3. **Explicit bounds:** a whole-task budget (60 min, heartbeats cannot renew it) fails a looping task with a named note; a per-step deadline (10 min, test-shrinkable) drives the step runner's signal so a wedged step wraps up honestly and is failed with a deadline note — a step deadline is a FAILED step, never a CANCELLED task (the task signal alone governs cancellation).
4. **Single verification run:** `verifyAcceptance` runs once; the independent reviewer's verdict is folded in by `applyReviewerVerdict` (can only lower, never re-runs a check).

**Modified files.** `src/main/coordinator.ts`, `src/main/taskStore.ts` (`persistTask`, `setStepVerification`, replan preservation), `src/main/verifier.ts` (`applyReviewerVerdict`).

**Regression tests.** `tests/round20Planner.test.ts` (8 tests): replan preserves unknown-outcome/interruptions/attempts and identity; identical replan refused with budget intact; a genuinely different replan preserves completed work (never re-runs it); stuck step fails with the deadline note; task budget fails a slow task explicitly; per-step verification records; mechanical checks carry `method`/`observed`; reviewer lowers but never inflates. Two assertions in `tests/coordinator.test.ts` and `tests/round18Planner.test.ts` were **re-pinned** from `pending` to `skipped` (the old expectation encoded the exact defect the Round 20 spec orders fixed — the step still never runs; documented contract change, not a weakened assertion).

**Actual result.** 8/8 new + all coordinator/planner suites pass (42/42 across the four coordinator-related files).

---

## CHANGE 5 — Verification is evidence-based

**Previous behavior.** Task-level verification was already evidence-based (`verifyAcceptance` reads the durable ledger and stats real files); but the per-step record did not distinguish the tool's claim from independently observed state, and the check result carried no verification method.

**Defect.** `ToolExecutionRecord` had no intended/observed/method fields; a step's `done` status carried the agent's report without a recorded, structured account of what was intended, performed, claimed, observed, how it was checked, and what status follows. Nothing fabricated evidence — but nothing structured the distinction either.

**New behavior.**
- `TaskStep.verification: StepVerification` — `{ intended, action, toolResult, observed, method, evidence, status }` — persisted after every settled step, derived by engine code from the durable ledger (`recordsForTask` filtered by step) plus the on-disk deliverable re-inspection, never from the report's confidence.
- Explicit status vocabulary: `attempted | executed | completed | verified | failed | unknown | unresolved`. Unresolved receipts after a run keep a step at `unknown` (never auto-promoted to `verified`); deliverable flags travel in the evidence text.
- Every `CriterionCheck` now carries `method` (disk stat / structural format validation / command execution / durable ledger scan / ledger text search / independent review) and `observed` (what was actually seen), so each PASS can be demanded-proof-for.
- A tool invocation is never automatically a verified result: zero-criterion tasks still state plainly that "step reports stand as the evidence; the reviewer may still fail it", and `outcomeSummary` keeps distinguishing *verified* from *not verified*.

**Modified files.** `src/main/taskStore.ts`, `src/main/coordinator.ts`, `src/main/verifier.ts`.

**Regression tests.** `tests/round20Planner.test.ts` (per-step verification records for done and failed steps; method/observed present; reviewer contract) and `tests/round20Loop.test.ts` Tests D/J (verification against real files produced through the real tool choke point).

**Actual result.** Verified across the planner, loop and coordinator suites — all pass.

---

## CHANGE 6 — Coordinator-controlled delegation

**Previous behavior and defect.** `SUBAGENT_DENIED` was exported but **never enforced** — it was dead code. The `general` agent's open tool predicate did not exclude `spawn_agent`/`task`/`parallel_tasks`/`research`, so a `general` child received the `spawn_agent` schema and delegation depth 2 was reachable; `NO_NEST` omitted `spawn_agent`; `isFailure` treated `CANCELLED` results as cacheable successes.

**Root cause.** The deny set existed as documentation, not as a gate.

**New behavior.** `pickSchemas` (the one place child schemas are built) now enforces `SUBAGENT_DENIED` — children never receive delegation/control tools (`task`, `research`, `parallel_tasks`, `spawn_agent`, `background_start`, `verify_claim`, `ask_user`, plan switches, screen capture). The coordinator owns all delegation; agents may *propose* help via `SUBTASK:` proposals (coordinator-mediated, depth 1, registry-capped), never create agents. `spawn_agent` joined `NO_NEST` (defense in depth). A hard backstop (2× the agent's time budget, ≥2 min) terminates a wedged child — the cooperative wrap-up stays; the parent's cancellation signal always wins (signals are combined). Duplicate identical non-failing calls remain deduped, and `CANCELLED` results are now treated as failures.

**Modified files.** `src/main/tools.ts`, `src/main/orchestrate.ts`, `src/main/subagent.ts`.

**Regression tests.** The delegation, capability and loop suites (round18Delegation, round17Capabilities, round19Loop, round20Loop Test A/E with a failing subtaskRunner → DONE downgraded to PARTIAL → step failed) — 40+ tests pass.

**Actual result.** All pass; depth-2 delegation is unreachable by schema, nesting guard, and coordinator mediation.

---

## CHANGE 7 — Hybrid memory is reliable

**Previous behavior and defects.** (a) The on-disk embedding cache (`embedWithCache`) had **zero callers** — every `find_memory` and every chat turn re-embedded the whole corpus. (b) The openai provider pinned `dims` from the first response with no sanity check — one bogus response poisoned the memoized provider permanently. The local embedder had no timeout. (c) Superseded records could swallow a corrected fact ("Already remembered." — the new value silently dropped) and could be overwritten as correction targets; contradiction detection required currency symbols; plain-number and schedule revisions (02:00 → 03:00) never superseded. (d) `project_save` appended duplicate decision texts; record ids were positional and shifted on edits; no provenance on contacts/projects. (e) A corpus-load failure was indistinguishable from "no relevant memories".

**New behavior.** The embedding cache is wired into both retrieval call sites (memory `find_memory` and the provider turn context) — content-addressed, LRU-bounded, persisted. Dimension validation before pinning (all vectors finite, same positive length) plus a later dimension-change check (model compatibility; mismatch throws). Local embedder bounded at 30 s. Superseded records are history: they can neither dedupe-swallow a new value nor be superseded themselves. Polarity flips ("likes tea" vs "dislikes tea") and bare-number/time revisions now supersede via the 0.85 core-word gate (figures = currency amounts, ≥2-digit numbers, times). Project decisions are deduplicated case-insensitively; retrieval ids are content-addressed and stable; provenance (`source` / `lastSource`) recorded on facts, contacts and projects. A corpus-load failure surfaces as an explicit "could not be loaded" block. The lexical/semantic tier labeling is unchanged and stays honest: no provider ⇒ LEXICAL, stated in the block; a failed provider is never called semantic.

**Modified files.** `src/main/memory.ts`, `src/main/embeddings.ts`, `src/main/projectMemory.ts`, `src/main/semanticMemory.ts`, `src/main/provider.ts`.

**Regression tests.** `tests/round20Memory.test.ts` (8 tests): correction not swallowed by a superseded record; polarity flip supersedes; no false supersession of unrelated facts; project decision dedupe + stable ids; corpus-failure surface; honest LEXICAL labeling; no padding below the score floor; malformed-vector rejection, dims recovery, dimension-mismatch throw (live local HTTP server). Paraphrase/correction/isolation are additionally covered in `tests/round20Loop.test.ts` Test G.

**Actual result.** 13/13 new + all existing memory suites (35 tests) pass.

---

## CHANGE 8 — Browser autonomy lifecycle completed

**Previous behavior and defects.** Ref-based tools already ran observe→identify→act→re-observe→verify with stale-click recovery; but coordinate clicks, drags returned "Clicked. Use browser_see to check." (the loop broken for coordinate actions); typing was never read back (a no-op `insertText` reported success); `browser_hover` had no policy classification; the `browser_dialog accept` decision reset to dismiss on the next navigation; the headless browser had no dialog neutralization (a modal `alert()` could hang `web_browse` until its timeouts).

**New behavior.** `browser_click_at`, `browser_drag` return a fresh post-action snapshot (`settled()`) like every ref-based tool. `typeInto` reads the field back (the desktop `set_control_text` pattern) and returns an explicit `[VERIFIED: …]` / `[NOT VERIFIED: …]` note surfaced by `browser_type` and `browser_fill_form`. `browser_hover` policy-classifies the target's label before moving. Dialog policy persists per tab across navigations (a WeakMap keyed by WebContents + a dom-ready applier registered from browser.ts into panel.ts — no import cycle). The headless window installs the same `DIALOG_JS` override on every document, so research pages can no longer hang on modals. Deliberate non-change: `browser_open` keeps its scheme gate but is NOT put behind the private-range SSRF guard — the in-app panel is the user-visible surface where opening a localhost dev server is a legitimate, user-requested action; fetch/`web_browse` keep full SSRF protection. Stale-click recovery (re-observe, re-identify, policy re-check, one retry, URL-change refusal) is unchanged. MFA/CAPTCHA/auth controls are never bypassed — the destructive-label/URL classifiers run on every click, typed-submit target and now hover.

**Modified files.** `src/main/browser.ts`, `src/main/panel.ts`, `src/main/headless.ts`.

**Regression tests.** `tests/browserStealth.test.ts`, `tests/headlessShape.test.ts`, `tests/visualShowcase.test.ts` (48 tests) pass unchanged; the real-browser acceptance workflow is environment-bound and documented in the Test Report (§9).

**Actual result.** All automated browser tests pass; typecheck and lint clean.

---

## CHANGE 9 — Windows desktop execution lifecycle

**Previous behavior and defects.** Round 19 added post-action foreground checks and a UIA read-back for `set_control_text`; but nothing detected modal dialogs (an unnoticed `#32770` MessageBox/file-picker swallowed clicks invisibly), `scroll_at`/`drag_at` returned unconditional success with no observation, and `launch_app` reported "Launched X." with zero evidence a window ever appeared.

**New behavior.** A `Dialogs()`/`DialogLine()` probe (UIA, standard dialog class `#32770`) is appended to the after-evidence of `click_text`, `click_control`, `click_at`, `type_text`, `press_keys`, `scroll_at`, `drag_at` — the operator is told which dialogs appeared and to observe-and-respond deliberately, never click through blindly. `scroll_at`/`drag_at` report the foreground window after acting. `launch_app` polls up to 6 s for a NEW process owning a real window and reports `Launched X (verified: a window appeared)` or an honest `NOT DONE: no new window appeared within 6s`. The mandatory lifecycle `Observe → Identify → Act → Observe → Verify → Recover` is enforced in tool output contracts; recovery from a failed interaction stays a model decision driven by honest evidence — **no blind auto-retry of non-idempotent clicks** (a second click on "Send" would compound; the evidence tells the operator what actually happened instead).

**Modified files.** `src/main/appControl.ts`, `src/main/systemTools.ts`.

**Regression tests.** All suites pass; the modules are Windows-gated (`requireWindows()`), so the PowerShell paths execute only on Windows. **Windows validation remains pending** in this environment (Linux sandbox) — the reproducible acceptance procedure is in the Test Report §9; no Windows test results are claimed.

---

## CHANGE 10 — Policy audit: both restrictions across every execution path

**Previous behavior and defects.** The Round 19 policy was strong (5-layer shell classifier, interpreter classifiers, deletion tooth for all agents, no ask/confirm modes). Three gaps were found: (a) **symlink bypass outside file tools** — `shellVerdict` layer 3 and the interpreter classifiers matched path *literals* only; a workspace symlink/junction into `C:\Windows` (or `/etc`) made `echo x > C:\ws\link\win.ini` an undetected OS write; (b) **interpreter extraction seams** — payloads on a continuation line (`cmd\npython -c "…"`) and quote-attached flags (`python -c"…"`) were invisible to extraction; node protected-literal scanning ignored template literals; (c) the deletion tripwire's verb list was finite (`delete|destroy|erase|wipe|purge|shred`) — a future `unlink_file`/`truncate_log`/`empty_trash`/`uninstall_app` tool would have classified as read.

**New behavior.** (a) `realpathProtected()` resolves the deepest existing anchor of a candidate path (symlink/junction-aware, 16-hop cap, workspace-relative resolution) and is joined to the literal check in shell layer 3, `pythonVerdict`, `nodeVerdict` and the generic interpreter classifier; node template literals join the literal scan. (b) The payload scanner treats newlines as command boundaries and accepts quote-attached flags. (c) The tripwire adds `unlink`, `truncate`, `uninstall`, `format` prefixes and `unlink|truncate|uninstall|empty_trash|empty_bin|erase` infixes — for every agent (main: blocked; children: rule-denied). The two hard restrictions and their exact wording are unchanged; no permission modes, no approval dialogs, no new restrictions were introduced (the hover classification closes an *unclassified interaction*, it does not add a mode). Fail-closed behavior on ambiguous targets is preserved (opaque PowerShell payloads, dynamic eval, unresolvable pids).

**Modified files.** `src/main/policy.ts`, `src/main/permission.ts`.

**Regression tests.** `tests/round20Policy.test.ts` (9 tests): symlink closure proven for shell redirects, python `open()` and node `writeFileSync` (quoted and template-literal forms, against a real `/etc` symlink on POSIX); continuation-line and quote-attached payloads now extracted and blocked; extended tripwire verbs denied for main and child agents; deletion under an agent context blocked with the file surviving; the verification runner refuses destructive verify targets. All 171 pre-existing policy/permission/enforcement tests pass unchanged.

**Actual result.** 9/9 new + 171/171 pinned policy tests pass.

---

## CHANGE 11 — Efficiency and leak prevention

Measured or structurally verified improvements (no premature micro-optimization):
- **Embedding cache wired in** (was dead code): repeated `find_memory` calls and every turn's context assembly skip provider round-trips for already-embedded texts; LRU-bounded on disk.
- **Verification commands run once** instead of twice whenever a reviewer is available (`applyReviewerVerdict` folds the verdict into computed results).
- **detectProject** probes directories only (previously generated an ENOTDIR probe per workspace file per task verification).
- **Listener hygiene:** the two writeCoord abort-wait paths now provably remove their listener on every path (12-test suite); the recovery flush timer unrefs and stops itself when the pending set empties; `AbortSignal.timeout` timers do not keep the loop alive.
- **Process hygiene:** `runCmd` keeps its timeout kill; the subagent hard backstop bounds wedged children; per-step and per-task budgets bound orphaned work; dynamic-agent caps and batch/chain bounds unchanged.
- **Bounded memory:** pending outcome set capped at 200 with FIFO eviction; in-memory receipt mirror capped at 500 (unchanged).

No correctness trade-offs were made for speed; the full suite runs in ~75 s, the same ballpark as baseline despite 55 more tests.

---

## CHANGE 12 — The complete loop, verified

The loop `Understand → Plan → Delegate → Execute → Observe → Evaluate → Recover → Verify → Persist → Communicate` is exercised end-to-end by `tests/round20Loop.test.ts` (7 tests, real modules, injected model runners, **real tool calls through the production choke point** for file work):

- **Test A/E** — delegated findings combined; contradictions about one file settled against the disk (`agents DISAGREED … Ground truth from disk`); a failed delegated subtask downgrades a DONE claim to PARTIAL and fails the branch honestly.
- **Test D** — plan → edit (real `write_file` through `runToolDetailed`, receipts and all) → verify → re-read from disk shows the real final state; per-step verification records present.
- **Test F** — restart with an unfinished task: interrupted step reconciled (`outcome unknown`), the started-without-twin receipt settled by a RECONCILED record, completed steps preserved, **the already-executed side effect never repeated** (file content byte-identical), and the resumed run is explicitly told to RECONCILE FIRST.
- **Test G** — paraphrased retrieval, correction supersession, project-scope isolation.
- **Test H** — overlapping independent operations run concurrently (interleaving proven), nested reentrancy works, cleanup verified.
- **Test I** — the policy sweep (separate file, 9 tests).
- **Test J** — parallel independent branches + real file work + acceptance verification; completion only on evidence; verdict `completed` only from the verifier.

The coordinator remains the sole owner of task completion; the model cannot set statuses. The system communicates plans, actions, results, evidence and failures through the task store, the activity feed and structured envelopes — no private chain-of-thought is exposed anywhere.

**Modified files.** `tests/round20Loop.test.ts` (new), plus the engine changes above.

**Actual result.** 7/7 pass; full suite 822/822.

---

## Contract changes re-pinned (transparency)

Two assertions were re-pinned, both encoding the exact defect the Round 20 specification orders fixed — in both cases the step in question still never runs; only the recorded status changed from the ambiguous `pending` to the honest `skipped` with the reason:
1. `tests/coordinator.test.ts` — "a failing step stops the task honestly" now expects `skipped` + `SKIPPED: a dependency failed…` and asserts `s2` never ran.
2. `tests/round18Planner.test.ts` — branch-isolation test now expects the dependent step `skipped`.

No test was deleted, skipped, or weakened anywhere else; 55 assertions were added.

---

## Remaining limitations (honest)

See `JARVIS_ROUND20_RELEASE_REPORT.md` §4 for the full list. Headline items: real-browser and Windows-desktop acceptance runs are environment-bound and remain pending; the `custom` acceptance criterion is a ledger text-search (evidence-based but gameable by a model that plants the phrase — mitigated, not eliminated, by the independent reviewer and mechanical criteria); bare coordinate clicks remain unclassifiable by policy (documented heuristic boundary, mitigated by observe-after evidence and the verifier).
