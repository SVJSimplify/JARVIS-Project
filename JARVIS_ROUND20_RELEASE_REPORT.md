# JARVIS — ROUND 20 RELEASE REPORT

## 1. Release identity

- **Artifact:** `JARVIS_ROUND20.zip` — the complete final source (Electron + TypeScript), reports included.
- **Base:** `JARVIS_ROUND19.zip`; architecture preserved (no rewrite, no competing engine, no removed features).
- **Version:** 1.0.0 (`jarvis-electron`), main entry `dist/main/index.js`.

## 2. Quality gates — final status

| # | Gate | Command | Result |
|---|---|---|---|
| 1 | Clean dependency install | `npm ci` | OK (560 packages) |
| 2 | All existing tests | `npx vitest run` | 822/822 pass, 62 files (baseline 767 intact) |
| 3 | All new tests | included above | 55 new assertions, 6 new files |
| 4 | TypeScript | `npm run typecheck` | OK (node + app projects) |
| 5 | Lint | `npx eslint src` | 0 problems |
| 6 | Production build | `vite build` + `tsc` main/preload | OK |
| 7 | Package | `npx electron-builder --dir` | OK (linux-unpacked). **NSIS target requires Windows** |
| 8 | Startup validation | packaged binary under Xvfb | Main process boots, renderer loads, IPC live (only platform-honest warnings: Whisper STT is Windows-x64-native; no ALSA device in sandbox) |
| 9 | Persistence across restart | test suites (boot reconciliation, `.bak` recovery, receipt reconciliation) | validated |
| 10 | Cancellation | writeCoord + coordinator + turn-signal suites | validated |
| 11 | Actual browser execution | mocked-Electron suites | automated parts pass; **live run pending** (display+network) |
| 12 | Windows desktop execution | — | **pending** — no Windows environment; nothing claimed |

## 3. Modified-file inventory (Round 20)

**Engine (23 files):**
`src/main/toolRecord.ts` · `tools.ts` · `toolResult.ts` · `store.ts` · `verifyExec.ts` · `coordinator.ts` · `taskStore.ts` · `verifier.ts` · `writeCoord.ts` · `orchestrate.ts` · `subagent.ts` · `memory.ts` · `embeddings.ts` · `projectMemory.ts` · `semanticMemory.ts` · `provider.ts` · `browser.ts` · `panel.ts` · `headless.ts` · `appControl.ts` · `systemTools.ts` · `policy.ts` · `permission.ts`

**Tests (8 files: 6 new, 2 re-pinned):**
new — `tests/round20Receipts.test.ts`, `round20WriteCoord.test.ts`, `round20Planner.test.ts`, `round20Memory.test.ts`, `round20Policy.test.ts`, `round20Loop.test.ts`;
re-pinned — `tests/coordinator.test.ts` (pending→skipped contract), `tests/round18Planner.test.ts` (same contract change).

No file was deleted; no test was removed or weakened (details in the Round 20 Report, "Contract changes re-pinned").

## 4. Remaining limitations (complete, honest list)

**Environment-bound (validation pending, not claimed):**
1. Live browser acceptance run against real websites (needs display + network + model keys). Automated equivalents all pass.
2. Windows desktop execution — every app-control tool is Windows-gated; no Windows host in the build environment. The PowerShell additions (dialog probe, launch verification, post-action evidence) are build-validated and reviewed but not executed.
3. Live-model end-to-end runs (Tests A/J with a real LLM); engine-level equivalents run with injected runners.
4. NSIS installer packaging (Windows tooling); Linux-unpacked packaging validated.
5. Native Whisper STT is Windows-x64-only by design (honest runtime error on other platforms; the renderer web-Whisper path remains).

**Design boundaries, documented and deliberate:**
6. Bare coordinate clicks (browser and desktop) are unclassifiable by label/URL — mitigated by post-action re-observation, evidence records and the verifier; no approval dialogs were added (policy-locked).
7. A destructive POST behind a neutral label AND neutral URL cannot be classified from the outside (documented heuristic boundary since Round 17).
8. The `custom` acceptance criterion is a ledger text search — evidence-based but plantable; mitigated by the independent reviewer and mechanical criteria.
9. Cross-process workspace tampering is out of scope for the write coordinator (in-process discipline by design, single main process).
10. The embeddings `apiKey` is stored plaintext in `brain/embeddings.json` (pre-existing since Round 19; unchanged to avoid breaking user configs; safeStorage encryption recommended as follow-up).
11. Symlink realpath closure walks to the deepest existing anchor with a 16-hop cap; an unresolvable candidate is treated as not-protected (the file-tool route keeps its own stricter resolution).
12. `atomicAppend` fsyncs per record — correct over fast; the receipt ledger is low-volume by design.

## 5. Reproducible acceptance instructions

### 5.1 Full engineering gate (any OS)
```bash
unzip JARVIS_ROUND20.zip && cd jarvis
npm ci
npx vitest run                                     # expect: 822 passed (62 files)
npm run typecheck && npx eslint src                # expect: clean
npm run build:renderer && npm run build:main && npm run build:preload
```

### 5.2 Application startup (Linux CI or desktop)
```bash
npx electron-builder --dir
xvfb-run -a ./release/linux-unpacked/jarvis-electron --no-sandbox   # headless CI
# or: ./release/linux-unpacked/jarvis-electron                      # desktop
# Expected: the HUD window appears; Settings → choose a model; the STT warning on Linux is expected and honest.
```

### 5.3 Persistence/restart check
1. Start the app, give it a multi-step task (`Create a report in Jarvis-Files/out/x.md …`), then kill the process mid-run (SIGKILL).
2. Restart: the task shows INTERRUPTED with completed steps preserved and running steps reconciled (outcome unknown).
3. `task_resume <id>`: the resumed run states `UNKNOWN outcomes` for the interrupted executions, inspects the real state first, and never repeats a completed side effect (verify: file contents/mtime unchanged for already-written outputs).

### 5.4 Cancellation check
`task_cancel <id>` mid-wave → CANCELLED (user path), running steps settled honestly, no locks leaked (subsequent writes work).

### 5.5 Browser acceptance (Test B — needs display + network)
Ask JARVIS: "Open https://example.com in your browser, click its link, then snapshot" — verify: the tool result contains a fresh post-action snapshot; force a page change between snapshot and click to see the stale-recovery path (`[recovered: …]`, policy re-checked, one retry); a dialog-bearing page shows `DIALOG(S) the page tried to show (auto-dismissed)` and `browser_dialog accept` now survives navigation.

### 5.6 Desktop acceptance (Test C — Windows only)
1. `launch_app notepad` → expect `Launched Notepad (verified: a window appeared)`.
2. `screen_text`, `click_text File`, `type_text` — every result ends with the foreground window line AND `After: no modal dialog windows detected.` (or the detected dialog).
3. Open a MessageBox (e.g. via a script) and click near it: the dialog must be reported as DIALOG window(s) detected.
4. `set_control_text` into Notepad's edit area → verified by UIA read-back.

### 5.7 Policy acceptance (Test I)
Attempt through any route (chat, batch, agent, scheduled): "delete Jarvis-Files/out/x.md via apply_patch Delete File", "run_command rm file", "python -c os.remove", "echo x > C:\Windows\temp\win.ini", "write through a workspace symlink into C:\Windows" — every one must answer `BLOCKED: …` with the file intact and the ledger recording the refusal.

### 5.8 Memory acceptance (Test G)
`remember` a fact, `find_memory` with a paraphrase (label says LEXICAL or semantic+lexical — never just "semantic" without a provider); correct a figure/time → `Updated (was: …)`; store decisions in two projects and confirm scopes never cross.

## 6. Known operational notes

- First packaged start on Linux logs a Whisper-STT native error and ALSA warnings — platform-honest behavior, not defects.
- The ledger (`Jarvis-Files/brain/toollog/*.jsonl`) is append-only; day files roll automatically; `recordsForTask` reads back 3 days.
- `docs/` from earlier rounds (HARDENING_PROGRESS, TEST_PACK, …) are historical; the five `JARVIS_ROUND20_*.md` files are the authoritative Round 20 record.

## 7. Verdict

Round 20 is complete against its mission: all twelve changes implemented in the existing codebase, every persistence and concurrency boundary crash-tested, both hard restrictions audited and pinned across every route, the loop verified end-to-end at engine level, and every claim in these reports traceable to an executed command or an explicit "pending, environment-blocked" note. The strongest honest statement: JARVIS's existing capabilities now work together reliably, its actions are accounted for, its results are verified, and it recovers correctly when things go wrong — with the live-web, live-model and Windows-desktop proofs explicitly outstanding where this environment could not host them.
