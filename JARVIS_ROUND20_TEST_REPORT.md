# JARVIS — ROUND 20 TEST REPORT

**Environment:** Linux x86-64 CI sandbox (Electron 32.3.3, Node 20, TypeScript 5.9, Vitest 2.1.9). Headless: Xvfb available; no Windows, no real GPU, no audio device.
**Command:** `npx vitest run` · `npm run typecheck` · `npx eslint src` · `npm run build:renderer && npm run build:main && npm run build:preload` · `npx electron-builder --dir` · packaged startup under Xvfb.

## 1. Result summary

| Suite | Files | Tests | Result |
|---|---|---|---|
| Full suite (final) | **62** | **822** | **822 pass / 0 fail** |
| — of which new in Round 20 | 6 | 55 | all pass |
| — re-pinned contracts | 2 files | 2 assertions | updated (documented contract change, no weakening) |
| Baseline (Round 19 zip) | 56 | 767 | 767 pass (unchanged behavior preserved) |

Duration: ~75 s wall clock. No test was deleted, skipped, or weakened; 55 assertions were added.

## 2. New Round 20 suites

| File | Tests | What it pins |
|---|---|---|
| `tests/round20Receipts.test.ts` | 11 | CHANGE 1 + 3: strict outcome persistence, unknown-marker escalation, controlled flush, bounded give-up, crash-after-durable dedupe, store `.bak` recovery, quarantine, write serialization, fsynced appends |
| `tests/round20WriteCoord.test.ts` | 12 | CHANGE 2: lane-queue cancellation, register-before-check race, fairness, nesting, overlap, timeout, exception, abandoned scope, healthy-operation immunity |
| `tests/round20Planner.test.ts` | 8 | CHANGE 4 + 5: replan state preservation, identical-plan refusal, step/task deadlines, skip propagation (via re-pinned coordinator test), per-step evidence records, reviewer contract |
| `tests/round20Memory.test.ts` | 8 | CHANGE 7: superseded-record fixes, polarity flips, false-supersession guard, project dedupe/stable ids, corpus-failure surface, honest LEXICAL labeling, dims validation (live local HTTP server) |
| `tests/round20Policy.test.ts` | 9 | CHANGE 10: symlink closure (shell/python/node), continuation-line + quote-attached payloads, template literals, tripwire verbs, agent-route blocks, verification-runner refusals |
| `tests/round20Loop.test.ts` | 7 | CHANGE 12: acceptance tests A/D/E/F/G/H/J at engine level with real tool calls |

## 3. Acceptance tests A–J — status against the real application

| Test | Scope | Status | Evidence |
|---|---|---|---|
| **A — Complex research** | research pipeline, source comparison | **PASS (engine level)** | round19Loop CHANGE 4 suite + round20Loop Test A (contradiction settlement against disk); real-web fetch requires network + provider keys — see §9 |
| **B — Browser execution** | in-app browser lifecycle | **AUTOMATED PORTIONS PASS; LIVE RUN PENDING** | 48 browser/headless/visual tests pass (mocked Electron); live navigation against a real site requires a display + network (§9) |
| **C — Desktop execution** | Windows desktop lifecycle | **PENDING — WINDOWS ENVIRONMENT REQUIRED** | modules are `requireWindows()`-gated; every PowerShell probe is syntax-checked by build + reviewed; no Windows run was possible (§9) |
| **D — Coding workflow** | plan → edit → test → verify | **PASS** | round20Loop Test D: real `write_file` through the production choke point, JSON re-read from disk |
| **E — Multi-agent collaboration** | delegation, contradiction detection | **PASS** | round18Delegation (17) + round20Loop Test A/E with a failing subtask → honest PARTIAL/FAILED |
| **F — Crash recovery** | restart, reconcile, no duplicate side effects | **PASS** | round20Loop Test F + round19Receipts crash-injection suite: interrupted receipts reconciled, completed work preserved, side effect never repeated |
| **G — Memory** | paraphrase, correction, project separation | **PASS** | round20Memory (8) + round20Loop Test G + round18/19 memory suites |
| **H — Concurrency** | overlap, nesting, cancellation, cleanup | **PASS** | round20WriteCoord (12) + writeCoordRound18 (10) + round20Loop Test H |
| **I — Policy** | both hard restrictions, all routes | **PASS** | round20Policy (9) + policy/policyAdversarial/permission/enforcement/round19Policy/round17Security (171) |
| **J — Full autonomous task** | parallel branches + file work + verification | **PASS (engine level)** | round20Loop Test J: 3-step DAG, parallel-eligible branches, real file output, verifier-gated COMPLETED |

## 4. Validation type discipline

- **Unit** — pure classifiers and helpers (policy verdicts, normalizePlan, validatePlanGraph, verifier checks, store primitives, semantic retrieval): 400+ assertions across the policy/store/memory suites.
- **Integration** — modules against the real filesystem with the real persistence paths: receipt lifecycle (crash-injection at every boundary), task store boot reconciliation, write coordinator under concurrency, embedding provider over a real local HTTP server.
- **End-to-end (engine)** — the coordinator loop from `startTask` to `COMPLETED`/`FAILED` with injected model runners but REAL tool dispatch (policy gate, receipts, write locks, task store): round19Loop + round20Loop.
- **Operating-system validation** — Electron startup (validated: packaged Linux build boots under Xvfb, renderer loads, IPC live); **Windows desktop automation: NOT executed** (no Windows host). Nothing is claimed for Windows beyond build-time syntax/type validation and the platform gate.

## 5. Crash/failure injection coverage (CHANGE 1 + 3)

Crash points exercised, each with the required outcome:
1. Before the started receipt → side effect never runs, no started record.
2. After the started receipt (caller sees failure) → side effect never runs; started receipt IS durable; restart classifies UNKNOWN with idempotency class.
3. After the completion receipt (caller sees failure) → receipt on disk exactly once; envelope honest.
4. Completion persistence fails after a real side effect → `receiptPending` envelope + durable `outcome_unknown` + in-memory preservation + flush-on-heal exactly once + bounded loud give-up.
5. Total ledger outage → real outcome retained (bounded), unknown-marker also unpersistable, nothing silently dropped.
6. Process interruption during a store write → torn temp only; main intact; no debris.
7. Corrupt JSON with/without backup → quarantine + recovery, or loud fresh start.
8. Concurrent task/memory updates → serialized (op chains, withStoreLock), no lost update.
9. Restart with unfinished tasks → boot reconciliation marks INTERRUPTED, running steps → retryable with `outcomeUnknown`, receipts reconciled at resume.

## 6. Concurrency guarantees verified (CHANGE 2)

Nested acquisition ✓ · sibling Promise.all acquisition serializes in-lane ✓ · concurrent operations sharing an owner label serialize ✓ · overlapping resource sets acquire in sorted order without deadlock ✓ · multiple-resource acquisition ✓ · cancellation during acquisition (pre-aborted, mid-wait, parked-in-queue) ✓ · cancellation during execution ✓ · timeout → structured conflict ✓ · exception during execution → full release ✓ · scope cleanup (no locks/scopes leaked) ✓ · long-running healthy operations never stolen (13 stale windows) ✓ · abandoned operations stealable ✓.

## 7. Performance measurements (CHANGE 11)

| Measurement | Baseline | Final | How measured |
|---|---|---|---|
| verifyAcceptance invocations per verified task (with reviewer) | 2 (commands re-executed) | **1** | code path change + reviewer contract test |
| Embedding provider calls for a repeated `find_memory` corpus | N per call | **0 on cache hits** | cache wired (embedWithCache); test pins the honest labels around it |
| detectProject directory probes | every entry (files too) | directories only | ENOTDIR warnings eliminated in the loop tests |
| Test suite wall clock | ~50 s / 767 tests | ~75 s / 822 tests | +55 suites incl. 6 new files; same order of magnitude |
| Listener/timer leaks in writeCoord waits | 1 leaked listener per wait (R18 shape), fixed in R19; residual queue-park hang | **none** (register-before-check + full cleanup, 12 tests) | round20WriteCoord |

## 8. How to reproduce

```bash
unzip JARVIS_ROUND20.zip && cd jarvis
npm ci
npx vitest run              # 822/822 expected
npm run typecheck && npx eslint src
npm run build:renderer && npm run build:main && npm run build:preload
npx electron-builder --dir  # unpackaged build (NSIS needs Windows)
# startup: xvfb-run -a ./release/linux-unpacked/jarvis-electron --no-sandbox
# (or on Windows: npm run build && electron-builder → NSIS installer)
```

## 9. Explicitly pending (environment-blocked, not claimed)

1. **Live browser acceptance (Test B live run):** navigate a real website, interact, recover from a changed page. Requires a display + outbound network + model keys. The automated equivalents (stale-click recovery, dialog neutralization, observe-after, policy classification) are covered by the mocked-Electron suites.
2. **Windows desktop acceptance (Test C):** every app-control tool is Windows-gated; no Windows host was available. The PowerShell scripts are compiled/type-checked via the build and reviewed, and the Round 20 additions (dialog probe, launch verification) are structured so their outputs are observable on first real run. **No Windows test result is claimed.**
3. **Real-model E2E (Tests A/J with a live LLM):** engine-level equivalents run with injected runners; a live-model run requires configured provider credentials.
4. **NSIS installer packaging:** the `win` build target requires Windows tooling; `electron-builder --dir` on Linux validated the packaging pipeline itself.
