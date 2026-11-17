# JARVIS — ROUND 20 AUTONOMY REPORT

**Question this report answers:** can JARVIS actually run autonomously — plan, delegate, execute on the real machine, observe what happened, recover from failure, verify with evidence, persist through crashes, and tell the truth about all of it — and what can still only be proven on real hardware?

## 1. The loop as it now stands

`Understand → Plan → Delegate → Execute → Observe → Evaluate → Recover → Verify → Persist → Communicate`

| Stage | Mechanism (all code-enforced, none model-honored) | Round 20 change |
|---|---|---|
| Understand | `buildTaskSpec` → kind/capabilities/deliverables/acceptance; informational requests never start tasks | — |
| Plan | structured JSON plan → `validatePlanGraph` (missing/self/forward refs dropped and REPORTED; cycles detected) → `normalizePlan` DAG | validation report unchanged; replan correctness rebuilt (C4) |
| Delegate | coordinator-owned: children get explicit objectives + bounded context; results reconciled against the disk; contradictory findings flagged | SUBAGENT_DENIED enforced; depth-2 unreachable; hard child deadline (C6) |
| Execute | one choke point (`runToolDetailed`): planGuard → schema check → risk → authorize → strict started receipt → tool.run → durable outcome; bounded parallel waves (2) | strict outcome persistence + escalation (C1); step/task deadlines (C4) |
| Observe | browser: snapshot after every action incl. coordinate clicks/drags, typing read-back, truth line; desktop: foreground + dialog probe after every acting step | observe-after completed for coordinate/key tools; typing verification; dialog detection (C8/C9) |
| Evaluate | per-step `StepVerification` (intended/action/claimed/observed/method/evidence/status) + `verifyAcceptance` against the ledger and the disk; reviewer can only lower | new per-step evidence records; single-run verification (C5/C4) |
| Recover | started-without-twin ⇒ outcome UNKNOWN ⇒ reconcile by inspection; non-idempotent tools never auto-repeat; interrupted steps → retryable with `outcomeUnknown`; resume flushes pending receipts | replan preserves recovery state; unknown-marker durable on ledger failure (C1/C4) |
| Verify | mechanical criteria (disk stat, format signatures, command exit codes, ledger URLs) + independent reviewer; `COMPLETED` requires a passing verification | identical results, half the cost; honest skip accounting feeds it (C4) |
| Persist | atomic fsynced JSON stores with `.bak` recovery; fsynced JSONL evidence ledger; boot reconciliation; task leases with heartbeat + watchdog | backup/quarantine; bounded pending-receipt recovery (C3/C1) |
| Communicate | task status text with the outcome vocabulary (`attempted/executed/completed/failed/unresolved · verified`), activity feed, structured envelopes with `receiptPending` | envelope carries ledger honesty (C1) |

## 2. What is now genuinely autonomous (validated in this environment)

1. **Full task loop on the real filesystem.** `startTask` → plan → parallel waves → real tool calls through the production choke point (policy gate, receipts, write locks) → verification against the produced files → honest COMPLETED/FAILED. (round19Loop, round20Loop Tests D/J.)
2. **Recovery from interruption.** Kill the driver at any point: boot reconciliation marks the task INTERRUPTED, mid-flight steps become retryable with unknown outcome, started-without-twin receipts are reconciled by inspection, completed steps are preserved, and the side effect is never blindly repeated. (round20Loop Test F, round19Receipts.)
3. **Failure isolation in parallel work.** A failed branch blocks only its dependents (now honestly `skipped`); unrelated branches complete; one bounded replan can rebuild the remaining work without losing history or repeating completed side effects. (round18Planner, round20Planner.)
4. **Multi-agent collaboration with honesty.** Children return reports; the coordinator re-checks claimed deliverables on disk, settles contradictory findings against the real state, downgrades DONE claims when a delegated subtask failed, and times out wedged children. (round18Delegation, round20Loop Test A/E.)
5. **Evidence-based verification.** A successful tool invocation is never automatically a verified result: files are stat'd and reopened, formats structurally validated, commands executed, sources counted from the ledger, and every step now carries the intended/observed/method/evidence account. (round20Planner, verifier suites.)
6. **Concurrency discipline.** Independent writes to different files run in parallel; same-file writers serialize through the lane discipline; cancellation and failures release every lock; healthy long operations are never stolen. (round20WriteCoord, round20Loop Test H.)
7. **Policy-true autonomy.** Everything not hard-blocked runs without asking; both hard restrictions hold on every route including the newly closed symlink and interpreter shapes. (round20Policy + 171 pinned policy tests.)

## 3. What autonomy is claimed but NOT proven here (environment-bound)

| Capability | Proven by | Missing proof |
|---|---|---|
| Live browser research/navigation against real sites | mocked-Electron suites (48 tests) + headless shape caps | a live run against real pages needs display + network + model keys (Test B) |
| Real Windows desktop workflows (apps, dialogs, menus) | tool contracts, PowerShell structure, platform gates | **nothing executed on Windows** — Test C pending; the dialog probe and launch verification are designed to be observable on first real run |
| Live-model end-to-end (Tests A/J with a real LLM) | engine E2E with injected runners | provider credentials |
| Real-world durability beyond the filesystem model | fsync/atomic-rename per POSIX semantics; Windows documented as rename-atomic | no power-cut simulation hardware |

None of these were claimed as passed. See the Test Report §9 for the exact pending list and the acceptance commands to run where the environment exists.

## 4. Anti-loop and anti-runaway bounds (complete list)

- Replans: `REPLAN_BUDGET = 1` + identical-plan refusal (budget not burned).
- Verify fix rounds: `TASK_FIX_ROUNDS = 1`.
- Step retries: ≤3 per step (`retryMax` clamp), step reports failing → failed.
- Step wall clock: `STEP_DEADLINE_MS = 10 min` per attempt (runner signal, wrap-up → honest FAILED).
- Task wall clock: 60 min total (heartbeat cannot renew it).
- Sub-agent rounds: 10–30 by role + `MAX_FAILS = 4` + hard 2× time backstop.
- Dynamic agents: ≤8 distinct per 24 h, TTL-pruned, tools stripped of delegation.
- Delegation depth: 1 (coordinator-mediated proposals only).
- Parallel steps: 2; parallel batch calls: 10 (read-only concurrent, writes serialized); chain: 8.
- Write locks: acquire timeout 30 s (structured conflict), stale steal only for dead scopes after 5 min.
- Pending receipt recovery: 200-entry FIFO cap, 40 flush attempts, then a loud warning.
- Browser actions: serialized queue, 90 s per-action timeout; headless: 20 s load / 30 s overall.
- Model calls: 180 s first-byte timeout (llm.ts, unchanged).

## 5. Truth-telling guarantees (the "no fake autonomy" contract)

- A passing tool call is not a verified result (per-step evidence + mechanical acceptance).
- A passing mocked test is not claimed as real-world autonomy — §3 lists exactly what is not proven here.
- A lost receipt is not a silent success: `receiptPending` on the envelope, `RECEIPT PENDING` in the text, `outcome_unknown` durable on disk, reconciliation required.
- A cancelled or interrupted task is never converted to a terminal "done": user cancel → CANCELLED; watchdog/lease loss → INTERRUPTED (resumable).
- Memory states its retrieval mechanism (semantic+lexical vs LEXICAL vs corpus-unavailable) and never pads unrelated entries.
- The completion audit (completion.ts, unchanged) still rewrites success claims that contradict the ledger.

## 6. Verdict

The existing engine now closes its own loop reliably: every action is accounted for in a durable ledger, every meaningful step carries observation evidence, failures propagate honestly, recovery inspects instead of assuming, and the bounds make infinite autonomous loops structurally impossible. What remains unproven is exactly what this sandbox cannot host — live web pages, real Windows desktops, and live model providers — and it is listed as such rather than claimed.
