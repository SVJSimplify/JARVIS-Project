# JARVIS — ROUND 18 ENGINEERING REPORT
## Intelligence, Autonomy & Execution Completion

Implementation of the Round 18 Master Engineering Implementation Mandate on top of the Candidate B (Round 17.1) codebase. Every claim below is backed by an executed test or an explicit honest limitation. **708/708 tests pass (52 files); `tsc` both configs OK; `eslint src` 0 problems; production renderer + main builds succeed.**

---

## 1. Final architecture (what changed, what did not)

The architecture is UNCHANGED in shape — one coordinator, one authorization boundary, one tool registry, one agent registry, one durable task store, one write coordinator — and materially UPGRADED in capability:

| Subsystem | Round 17.1 state | Round 18 state |
|---|---|---|
| Write coordination | ALS chain-id reentrancy (parallel-branch bypass), age-only diagnostics | **writeCoord v2**: explicit `WriteScope` tokens, lane stack (Promise.all siblings serialize), verified owner-liveness leases, cancellation-aware lock AND lane waits |
| Idempotency receipts | started receipt `void`-fired, hand-maintained side-effect list | **Awaited lifecycle**: started durable BEFORE the side effect; outcome durable before the report; classification derived from the central `classifyToolAction`; `reconciled` settlement status |
| Planner | `eligible[0]` serial loop, no dependency parsing | **Dependency DAG**: `normalizePlan` (sequential default, explicit-`[]` parallelism, cycle-proof), **wave scheduler** (2 concurrent steps, failure-isolated), **adaptive replanning** (bounded, preserves completed work, planVersion/planHistory) |
| Multi-agent | permanent 6, dynamic agents, no hierarchy | permanent **8** (+desktop operator, +data analyst), **coordinator-mediated SUBTASK proposals** (agents propose, coordinator registers/runs/bounds), deliverable-claim verification |
| Memory | TF-IDF only (honestly labeled) | **Embedding provider abstraction** (OpenAI-compatible endpoint / optional local neural model / none), **hybrid retrieval** (lexical ∪ vector, blended, scope-filtered, honestly labeled), **supersession lifecycle** (confidence, version, history preserved) |
| Browser | ref-id targeting + settled() verification existed | **Download verification** (size + magic bytes + extension-mismatch flag) |
| Desktop | primitives only | **desktop operator specialist** with an observe-act-verify contract; OCR/UIA/keyboard allowlist |
| Cancellation | turn signal never reached main-loop tools | **Signal-bearing dispatch scope**; aborted-resolved envelope fix; safeNet listener hygiene; timeouts ≠ cancellations |
| Policy strings | stale child-floor + NOT APPROVED copy | swept and corrected; the **two hard restrictions** untouched and re-proven |

## 2. Finding-resolution matrix (mandate §2/§19-C)

Classification per §2. Full evidence: `ENGINEERING_HANDOFF.md` (R18 section), test files cited.

| # | Finding (mandate ref) | Status | Root cause | Fix | Files | Regression tests |
|---|---|---|---|---|---|---|
| W1 | Promise.all siblings re-enter the same lock via inherited ALS chain (§3.1) | CONFIRMED → **FIXED** | inherited async context cannot distinguish nesting from siblings | explicit scope tokens + lane stack | writeCoord.ts | writeCoordRound18.test.ts (16) |
| W2 | lock stealing semantics thin (no renewable lease) (§3.3) | PARTIALLY FIXED → **FIXED** | liveness = frame count; steal needs frames===0 AND stale age; abandonment testable | owner-liveness + `simulateAbandonedScopeForTests` exercising the real steal path | writeCoord.ts | writeCoordRound18 §3.4.8/.9 |
| R1 | `void recordStarted` — side effect outran its receipt (§4.1) | CONFIRMED → **FIXED** | fire-and-forget append | `await recordStarted` before `tool.run` | tools.ts | round18Receipts (receipt-gates-side-effect) |
| R2 | hand-maintained SIDE_EFFECT_TOOLS list (§4.3) | CONFIRMED → **FIXED** | drift risk vs central classifier | derived from `classifyToolAction` (`action !== 'read'`) | tools.ts | round18Receipts (classification trio) |
| R3 | completion record `void`-fired (§4.1) | CONFIRMED → **FIXED** | same | `finish()` async+awaited | tools.ts, verifyExec.ts | round18Receipts (durable-before-return) |
| R4 | unknown outcomes lingered unresolved (§4.4) | PARTIALLY FIXED → **FIXED** | no settlement primitive | `recordReconciled` + coordinator settles after a real rerun inspection | toolRecord.ts, coordinator.ts | round18Receipts, round18Scenarios D |
| P1 | `eligible[0]` serial execution (§5.2) | CONFIRMED → **FIXED** | single-step loop | wave scheduler, MAX_PARALLEL_STEPS=2, failure-isolated | coordinator.ts | round18Planner (concurrent waves) |
| P2 | planner never emitted dependencies (§5.1) | CONFIRMED → **FIXED** | prompt+parser lacked fields | DAG schema (id/dependsOn/expectedOutput), normalizePlan | coordinator.ts, taskStore.ts | round18Planner (DAG rules) |
| P3 | no adaptive replanning / plan versions (§5.5) | CONFIRMED → **FIXED** | replan reset all steps | `replanSteps` (preserves done work), REPLAN_BUDGET=1, planVersion+planHistory | taskStore.ts, coordinator.ts | round18Planner (replan trio) |
| P4 | failed step killed unrelated branches (§5.3) | CONFIRMED → **FIXED** | fail-fast loop | branch-isolated failures; only dependent branches block | coordinator.ts | round18Planner (branch isolation) |
| A1 | no desktop/data specialists (§6.1) | CONFIRMED → **FIXED** | roster gap | `desktop` (UIA/OCR/keyboard, operator role), `data` (compute+verify) | agentRegistry.ts, subagent.ts, orchestrate.ts | round18Delegation (specialists) |
| A2 | agents could not propose subtasks (§6.3) | CONFIRMED → **FIXED** | delegation depth-1 hardwired | SUBTASK proposal protocol; coordinator mediates; duplicate proposals refused | coordinator.ts, agentRegistry.ts | round18Delegation (SUBTASK trio) |
| A3 | agent result quality unchecked (§6.4) | CONFIRMED → **FIXED** | DONE text trusted | `checkStepDeliverables`: claimed files stat-checked; fabrication → evidence-based retry + permanent flag | coordinator.ts | round18Delegation (quality pair) |
| M1 | no real embeddings; TF-IDF only (§7.2) | CONFIRMED → **FIXED** | no provider layer | embeddings.ts (openai-compatible via pinned transport; optional local neural via dynamic import; 'none' default); hybridRetrieve with honest labels | embeddings.ts, semanticMemory.ts | round18Memory (11, incl. the zero-shared-stems generalization proof) |
| M2 | corrections silently overwrote history (§7.5) | PARTIALLY FIXED → **FIXED** | in-place text overwrite | supersession: old record kept as history (supersededBy), confidence/version tracked, all views show current only | memory.ts | round18Memory (lifecycle pair), round9 (updated) |
| B1 | download verification was a bare state string (§8.5) | PARTIALLY FIXED → **FIXED** | no file inspection | `verifyDownloadFile` (size + magic bytes + mismatch flag) wired into the download log | fsTools.ts, panel.ts | round18Resilience (download trio) |
| D1 | desktop tools lacked verify guidance (§9.4) | PARTIALLY FIXED → **MITIGATED** | no observe-act-verify loop | desktop operator persona + output contract mandate re-observation; post-action verify for place_window/stop_process already existed | agentRegistry.ts, subagent.ts | round18Delegation (desktop contract) |
| S1 | Stop never reached in-flight main-loop tools (§11) | CONFIRMED → **FIXED** | dispatch had no signal scope | `runWithExecutionScope({signal})` around both dispatch paths | provider.ts | round18Resilience (kill-mid-python, never-start-next) |
| S2 | killed-mid-run tools reported SUCCESS envelopes (§11) | CONFIRMED → **FIXED** (found by new tests) | resolved error-text not mapped | post-run abort check → 'cancelled' envelope | tools.ts | round18Resilience |
| S3 | abort listeners accumulated; timeouts ≡ cancellations (§11) | CONFIRMED → **FIXED** | listener never removed; literal 'cancelled' for timeout aborts | settle-path removal; TimeoutError → 'timed out' (retriable) | safeNet.ts | round18Resilience (timeout vs cancel) |
| S4 | stale policy copy (§10) | CONFIRMED → **FIXED** | drift | child-floor comment, NOT APPROVED regexes, move_file description, toolGuide text | tools.ts, subagent.ts, orchestrate.ts, coordinator.ts, toolGuide.ts, laptopTools.ts | full suite (no behavior change) |
| W4 | add_note/add_app/remove_app/todo_write/make_dir uncoordinated or non-atomic (§12) | CONFIRMED → **FIXED** | raw fs writes | atomicAppend/atomicWrite/withStoreLock + lock on make_dir | extraTools.ts, planning.ts, laptopTools.ts | suite green |
| W5 | edit_file read outside its lock (§12) | CONFIRMED → **FIXED** | partial F-21 port | whole RMW inside the lock | tools.ts | round18Resilience (edit race) |
| W6 | move_file locked only the destination (§12) | CONFIRMED → **FIXED** | single-path lock | `withWriteLocks([src, dst])` | laptopTools.ts | suite green |

NOT REPRODUCIBLE / already sound (verified, no change): holdsWriteLock had zero production callers (kept as labeled diagnostic); browser stale-element recovery existed (ref re-identification by label); taskStore lease tokens/watchdog were correct; DNS pinning transport was correct.

## 3. The two hard restrictions — status

**Unchanged, enforced, re-proven.** Restriction A (no deletion of user data/resources): the `delete` classification tooth + guard risk layers + child backstop — pinned by policy.test, enforcement.test, policyAdversarial.test, and Scenario F. Restriction B (no OS-resource modification): `osProtectedPath` + shell/interpreter/process layers — same suites. **No third restriction, no permission modes, no approval dialogs were added** — the stale copy that SUGGESTED otherwise was the defect, and it is gone (§10).

## 4. Functional test report (§19-D) — exact commands, actual results

Environment: Linux sandbox, Node v24.22.2. Commands run from the repo root.

| Command | Result |
|---|---|
| `npx tsc -p tsconfig.node.json --noEmit` | **PASS** (exit 0) |
| `npx tsc -p tsconfig.app.json --noEmit` | **PASS** (exit 0) |
| `npx vitest run` | **708/708 passed, 52 files, ~30s** |
| `npx eslint src` | **0 problems** |
| `npx vite build` (production renderer) | **PASS** (built in 4.5s) |
| `npm run build:main` | **PASS** |
| `npm run build` (electron-builder packaging) | **NOT RUN — environment-blocked**: packaging downloads platform Electron binaries from the network; the sandbox cannot fetch them. The release ZIP below is the deliverable package. |

New test files this round: `writeCoordRound18` (16), `round18Receipts` (8), `round18Planner` (8), `round18Delegation` (9), `round18Memory` (11), `round18Resilience` (6), `round18Scenarios` (2). No existing test was deleted or weakened; `round17hardening` nesting tests and `round9` revision test were **upgraded to the corrected Round 18 contracts** (explicit-scope reentrancy; supersession instead of silent overwrite) with their core properties intact.

## 5. Security report (§19-E)

- Both hard restrictions hold across every route: main agent, specialists, dynamic agents, shell, Python, interpreters, file ops, patch, browser, desktop, scheduled/background jobs, verification commands — all flow through the ONE gate (`runTool → assessRisk → classifyToolAction → authorize`), re-proven continuously by the policy suites and Scenario F (injection wrapped in arguments, injection written as a workspace "policy file" — policy unmoved).
- New hardening this round is security-POSITIVE: receipt lifecycle (a crash can no longer orphan a side effect silently), parallel-branch mutual exclusion (no concurrent writes to one path from sibling branches), write-path coverage (edit/move/mkdir/notes/apps/todo all coordinated or atomic), pinned-transport embeddings calls (SSRF-safe), download verification (no fake completed downloads), timeouts no longer masquerade as cancellations (no false retries of cancelled work).
- No new network surface beyond the user-configured embeddings endpoint, reached through the SAME pinned-DNS transport with scheme gate and 8 MB cap.

## 6. Autonomy report (§19-F)

Demonstrated by executed tests (model-free where the engine logic is the point):
- **Complex planning**: DAG plans with per-step expectedOutput and retry policy (round18Planner).
- **Parallel execution**: independent steps run concurrently (measured overlap, bound = 2) with dependency enforcement (round18Planner).
- **Agent delegation**: coordinator-mediated subtask specialists with dedup, caps and structured findings (round18Delegation).
- **Recovery**: crash → restart → resume with completed work preserved, RECONCILE FIRST briefs, receipt settlement, correct ownership (round18Scenarios D).
- **Correct concurrency**: 12 mandated locking scenarios (writeCoordRound18).
- **Evidence-based completion**: verification runs mechanical checks + bounded reviewer; deliverable claims are disk-checked; completion audits replies against the evidence ledger (verifier/completion suites + round18Delegation).
- **Browser/desktop workflows**: verification of downloads is real; the desktop observe-act-verify specialist exists. **Honest limits:** full browser workflow tests need a display/Chromium; desktop workflow tests need Windows. Both are environment-blocked here (§16 duty fulfilled by stating it).

## 7. Known limitations (honest)

1. **Windows validation not performed** (Linux sandbox): PowerShell paths, UIA/OCR, Electron startup and installer generation are NOT validated this round. Unit-level logic that is platform-independent is tested; the rest is untouched from Round 17.1.
2. **`renderText` / `browseHeadless` / `searchHits` may render briefly after cancellation** — read-only (no side effects), bounded by their own timeouts; fixing requires Electron window surgery without test coverage in this environment. Documented, not hidden.
3. **Local neural embeddings require the OPTIONAL `@huggingface/transformers` package** (~100 MB with its ONNX runtime + a ~25 MB model on first use) or a configured OpenAI-compatible embeddings endpoint. Without either, retrieval is lexical and LABELED lexical. Not installed here (no network model downloads); the provider contract is test-verified with a deterministic neural-shaped provider.
4. **Adaptive replanning is model-driven** (or test-injected). Without a model, a failed branch fails honestly rather than pretending to replan.
5. `electron-builder` packaging not executed (network-blocked).

## 8. Final scorecard (§19-H)

| Area | Score | Basis |
|---|---|---|
| Architecture | 9/10 | one of everything; zero duplicate engines; v2 write coordinator is explicit and proven |
| Reasoning | 7/10 | structured step contracts, reconciliation briefs, honest reports; still model-dependent for judgment |
| Planning | 8.5/10 | DAG plans, bounded parallelism, adaptive replan preserving work, per-step policies |
| Tool execution | 9/10 | durable receipts at the choke point, central classification, cancellation end-to-end |
| Multi-agent intelligence | 8/10 | 8 specialists, mediated hierarchy, result-quality checks, bounded dynamic roster |
| Browser autonomy | 7/10 | verified downloads, existing ref/stale/settle loop; display-dependent flows untested here |
| Desktop autonomy | 6.5/10 | operator specialist + contracts; Windows runtime validation outstanding |
| Memory | 8.5/10 | real embedding tier + honest lexical tier + supersession lifecycle + cache |
| Persistence | 9/10 | atomic everywhere, fsync, serialized RMW, plan versions, boot reconciliation |
| Security | 9.5/10 | two restrictions enforced centrally, injection re-proven, no approval surface |
| Verification | 8.5/10 | mechanical criteria, deliverable disk-checks, reviewer lower-bound, evidence ledger |
| Reliability | 8.5/10 | 708/708, branch-isolated failures, honest interruption, lease discipline |
| Maintainability | 8.5/10 | registry-driven agents, single classifier, journaled lineage (ENGINEERING_HANDOFF.md) |
| **Overall** | **8.6/10** | measured against §20: JARVIS now plans, parallelizes, delegates, verifies, recovers and remembers with evidence. The remaining distance to 10 is live-model end-to-end runs and Windows runtime validation. |
