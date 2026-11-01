# JARVIS HARDENING PROGRESS

Mission: make every EXISTING capability reliable, intelligent, consistent, efficient,
secure and polished. No new features, no scope expansion. Update this file after every phase.

---

## BASELINE AUDIT (2026-10-31)

Environment audited: `Current-Project.zip` (96 files, 84 source files).
Verification used: `tsc -p tsconfig.node.json`, `tsc -p tsconfig.app.json`, `vite build`,
`tsc` preload build, `eslint src/renderer`. Nothing was trusted from filenames or comments;
every module listed below was read line by line.

### Capability inventory and health

| Capability | Files | Health after audit |
| --- | --- | --- |
| Electron main entry, window, IPC | `src/main/index.ts` | Works. Gaps: `open-external` IPC accepts any URL/protocol; no process-level error handlers; `ai-delta` sends to a destroyed sender can throw |
| LLM transport | `llm.ts` | Works (retries on 429/5xx, network). Gap: **no request timeout** — a hung connection stalls a turn forever |
| Agent loop / orchestration | `provider.ts` | Works: turn chaining, interruption, history trimming by turns, `<think>` filtering, parallel read-only calls, failure-driven lessons. Streaming tool-call assembly handles index-less gateways |
| Tool routing | `toolRouter.ts`, `tools.ts`, `toolArgs.ts` | Works: group routing with sticky turns, tolerant JSON repair, Levenshtein tool-name rescue (read-only only), arg coercion, centralised risk/permission/logging. Failure prefixes (`Tool error|Unknown tool|BLOCKED|NOT APPROVED|NOT DONE`) are consistent across producer and consumer |
| Sub-agents | `subagent.ts`, `orchestrate.ts` | Works: budgets, dedupe of identical calls, compaction, forced final reports, plan-mode guard reaches nested calls. Gap: **cancel does not reach sub-agents** (they keep burning API calls for minutes after Stop) |
| In-app browser | `browser.ts`, `panel.ts`, `panelTabs.ts`, `panelScene.ts` | Works well: one-action queue with 90 s timeouts, snapshot resilience (context-destroyed retry), stale-ref re-finding by label, dialog interception, download log, YouTube ad skip, cinematic door animation with generation guard against stale animations |
| Desktop automation | `appControl.ts`, `systemTools.ts`, `laptopTools.ts`, `stage.ts`, `psHost.ts` | Works: UIA control tree, OCR (Windows.Media.Ocr) with coordinates, persistent PowerShell host (one-time prelude compile), env-var argument passing (no injection), protected-process list, deletion blocked |
| Files | `workspace.ts`, `fsTools.ts`, `patch.ts`, `tools.ts` | Works: symlink-aware escape checks, protected-folder list, glob/grep caps, exact-match edits, patch all-or-nothing |
| Web/research | `webTools.ts`, `tinyfish.ts`, `knowledge.ts` | Works: SSRF protection (private-IP block incl. redirects), engine race, caches, TinyFish rate limiter, untrusted-content wrappers. `code_search` param `tokensNum` verified correct against Exa MCP docs |
| Memory | `memory.ts`, `session.ts` | Works: categories, contact upsert, dedupe, forget-safety (max 3), recurring tasks. Minor: silent write failures |
| Learning | `learn.ts`, `agi.ts` | Works: correction detection, transient-error filter, injection-safe lessons (`BAD` regex), playbooks, goals, background jobs, `run_python` with deny-list |
| Voice in | `stt.ts`, `whisper.ts`, `whisper.worker.ts`, `listener.ts`, `voiceprint.ts`, `useVoiceAgent.ts` | Works: native whisper.cpp server with WASM fallback, Groq cloud with rate-limit backoff, energy VAD with barge-in gate, MFCC voiceprint lock |
| Voice out | `tts.ts`, `speech.ts`, `useSubtitles.ts` | Works: Edge neural voices with retry-on-stale-socket, system-voice fallback, sentence queue with page-synced captions, progress-line suppression |
| HUD/visuals | `hud.ts`, `reactor.ts`, `HologramCore.tsx`, `VisualCard.tsx`, `holoKit.ts`, `Subtitles.tsx` | Works: mini/full tween with focusable handling, canvas reactor with reduced-motion support, sandboxed visual iframe with CSP |
| Telemetry/awareness | `telemetry.ts`, `awareness.ts`, `useTelemetry.ts` | Works: sampling only while HUD visible, alert hold-down (no flicker), PowerShell foreground watcher with sensitive-window masking, in-memory only |
| Settings/security | `settings.ts`, `guard.ts`, `preload/index.ts` | Works: safeStorage encryption with plaintext fallback flag, risk assessment with approval queue, contextIsolation on, no nodeIntegration |
| Build/packaging | `package.json`, tsconfigs, vite | Builds pass. **Defects found (see below)** |

### Defects found (prioritised)

| # | Severity | Defect | Status |
| --- | --- | --- | --- |
| D1 | Critical | `tsconfig.app.json` references non-existent type package `electron-types` → renderer typecheck fails out of the box | **FIXED** |
| D2 | Critical | ESLint has no TypeScript parser → `npm run lint` reports 33 parse errors; lint has never worked on this repo | **FIXED** |
| D3 | High | Dead code: `hooks/useVoice.ts`, `hooks/useSpeechRecognition.ts`, `components/VoiceOutput.tsx` are imported nowhere (legacy of a replaced implementation) | **FIXED (removed)** |
| D4 | High | Dead dependencies never imported anywhere: `playwright`, `playwright-core`, `@modelcontextprotocol/sdk` (large install, no use — the browser panel is Electron-native) | **FIXED (removed)** |
| D5 | High | `llm.send()` has no timeout: a hung provider connection stalls a turn (and its queued successors) indefinitely | **FIXED** |
| D6 | High | Cancelling a turn does not abort sub-agent LLM calls: research keeps running minutes after Stop | **FIXED** |
| D7 | Medium | `open-external` IPC handler opens any URL/protocol without validation | **FIXED** |
| D8 | Medium | No `unhandledRejection`/`uncaughtException` handlers; `ai-delta`/`ai-progress` events are sent to a possibly destroyed sender | **FIXED** |
| D9 | Low | `memory.save()` swallows write failures silently | **FIXED (warned)** |
| D10 | Low | Settings "Save" has no error feedback (silent failure if the write fails) | **FIXED** |
| D11 | Medium | No tests at all; no `typecheck` script; lint covers renderer only | **FIXED (vitest, 69 unit tests, scripts, lint covers all of src)** |
| D15 | High | `parsePatch` could not read a patch whose `*** Move to:` line sits before the hunks (the documented format) — every such patch failed with "Unexpected line" | **FIXED** |
| D16 | Medium | Tool-group stickiness re-armed itself: `endTurn` saved inherited groups, so every group ever loaded stayed loaded forever and `load_tools` offloading never decayed (prompt bloat) | **FIXED** |
| D17 | Medium | `parseArgs` repairs did not compose: a code-fenced payload that also had a trailing comma was rejected | **FIXED** |
| D18 | Medium | `decide` enforced ambiguity asking only under 85 confidence, contradicting DECISION_RULES rule 4 (materially different readings are the user's call regardless of confidence) | **FIXED** |
| D19 | Low | Wake-word detection missed the documented "jar vis" mis-transcription (space inside the name) | **FIXED** |
| D12 | Info | `panel.wireDownloads` overwrites same-named files in Downloads — standard browser behaviour, left as is | Accepted |
| D13 | Info | `AUTONOMOUS = true` in `tools.ts` bypasses approval prompts by design (guard rules and BLOCKED list still enforced). Left untouched: deliberate operator setting | Accepted |
| D14 | Info | Read-tool output mangling `[m` sequences in some consoles is a display artifact, not data corruption (verified on disk with hex dump) | Verified non-issue |

---

## PHASE LOG

### Phase 1 — Audit (done)
See above. Baseline results:
- `tsc` main: **pass** · `tsc` renderer: **fail (D1)** → pass after fix
- `vite build` renderer: **pass** · `tsc` main+preload emit: **pass**
- `eslint`: **33 parse errors (D2)** · tests: **none exist (D11)**

### Phase 2 — Stabilise (done)
- D1: corrected `tsconfig.app.json` types entry.
- D2: `typescript-eslint` wired into the flat config; lint now parses TS and covers `src/main`, `src/preload`, `src/renderer`. All reported issues fixed.
- D3/D4: dead files and dead dependencies removed (`playwright` alone was pulling multi-hundred-MB browser downloads on install).
- D5: `send()` now fails fast with a clear error if the provider never responds (first-byte timeout), while keeping streaming bodies unbounded and caller cancellation intact.
- D6: turn cancellation now propagates to sub-agents (checked between rounds and inside their LLM calls) — Stop is near-instant.
- D7: `open-external` restricted to http/https.
- D8: process-level error handlers log instead of dying silently; IPC stream sends guard destroyed senders.
- D9/D10: honest failure reporting for memory writes and settings saves.

### Phase 3 — Verification (done)
- `npm run typecheck` (main + renderer): pass
- `npm run lint`: pass, 0 errors
- `npm test`: **69 unit tests in 7 files, all pass**
- `npm run build` (renderer + main + preload emit): pass
- Runtime smoke test: the built app was booted on a virtual display. The window opened, the holographic HUD rendered exactly as designed (reactor core, transcript rail, alerts panel, enrolment prompt, text input), the expected container-only degradations were shown honestly ("Microphone unavailable", Whisper falls back to WASM off-Windows), and the process stayed healthy with no renderer or IPC errors. Screenshot captured and reviewed.
- Bugs the new tests caught in existing code (all fixed): D15, D16, D17, D18, D19 above.

### Remaining issues / known limitations
- `run_python` requires Python installed on the host; reports a clean error when absent.
- Native Whisper STT is Windows x64 only (by design); WASM fallback covers other platforms.
- Voice lock is a deterrent (MFCC distance), not strong biometrics — documented in code.
- Delete operations remain disabled by policy (`guard.ts`), independent of approvals.

### Next priorities
- None outstanding from the perfection mandate. Further work should be driven by real
  usage failures and recorded in `brain/lessons.json` automatically.

## ROUND 2 — ADVERSARIAL RE-AUDIT AND FIXES (2026-10-31)

Mandate: be critical of the previous pass's own conclusions. Four independent line-by-line
audits (intelligence core, execution layer, memory/security, renderer) found 30+ real
weaknesses the first pass missed. All findings below were verified in code before fixing.
Baseline re-verified first: typecheck, lint, 69 tests, all three builds — all green.

### Fixed (main process — intelligence core)

| ID | Defect | Fix |
| --- | --- | --- |
| R1 | Stop during a tool run did not stop the NEXT model call: the "cancelled" turn launched a fresh completion, could still answer aloud, and blocked the queued next turn | `send()` pre-checks `signal.aborted` on every attempt; `runTurn` checks at the top of every round |
| R2 | Plan mode leaked across turns after an interrupt or error: every later write tool returned "Blocked: plan mode is read-only" | `resetPlanMode()` exported and called at each turn start |
| R3 | Research planner/synthesis LLM calls ignored cancellation (kept burning API calls after Stop) | `currentTurnSignal()` now passed to both `completeOnce` calls |
| R4 | First-byte timeout was retried as if transient: a silently hanging provider stalled a turn for ~9 minutes (3 × 180 s) | Timer aborts are no longer retried; they fail immediately with a message that says what happened |
| R5 | No aggregate context budget inside a turn: 60 rounds × N × 12 000 chars re-sent every round could blow the provider window and destroy minutes of work | `TURN_CHAR_BUDGET` (90 k chars) collapses the oldest tool rounds of the current turn, keeping the 2 newest verbatim and every call/reply pair consistent |
| R6 | The staged-visual yes/no short-circuit swallowed real requests that merely *started* with a yes-word ("Sure, but first check my email", "Show me the weather instead") | The utterance must now be a yes/no plus at most a courtesy tail; anything longer reaches the model |
| R7 | `open_url` was fuzzy-guessable (`SAFE_RETRY`), so a hallucinated near-miss tool name could pop a page into the user's external browser | Removed from `SAFE_RETRY`; guessed matches may only run read-only tools |
| R8 | `completeOnce` never stripped `<think>` blocks: reasoning leaked into sub-agent reports and parsed plans | `cleanThink` moved to `llm.ts` (shared) and applied; it also strips a block truncated mid-reasoning, which previously leaked into the spoken reply |

### Fixed (main process — execution layer)

| ID | Defect | Fix |
| --- | --- | --- |
| R9 | `grep` ran an LLM-supplied regex synchronously in the main process: a pathological pattern froze the whole app with no way to interrupt | Matching now runs in a throwaway worker thread with a 15 s hard kill; clear error tells the model to simplify the pattern |
| R10 | `stop_process({pid})` bypassed `PROTECTED_PROCS` entirely — a PID happily killed `explorer` | PID is resolved to its process name first; the same protection applies |
| R11 | `fetch_url`/`search_and_read` buffered the whole response in memory (a 2 GB text resource = OOM) | Bodies are read with a 2 MB byte cap, then the stream is cancelled |
| R12 | `renderText`'s `executeJavaScript` had no timeout: a page with a blocked main thread hung `fetch_url` forever | Bounded by the same 7 s race as the load; rejection falls back to the clean "could not be rendered" error |
| R13 | `launch_app` swallowed every PowerShell failure as "No installed app matching …"; worse, its `exit 3` killed the shared PowerShell host every time an app was missing | Script writes a NOT_FOUND marker instead of exiting (host survives); host-level failures now propagate honestly |
| R14 | `close_app` discarded `CloseMainWindow()`'s bool: a window that refused the close was reported as "Closed …" | Result is checked; refusals are reported as such |
| R15 | A door `loadURL` rejection during the panel's opening animation left the in-app browser dead (`state: 'opening'` forever) until app restart | `runOpen` is wrapped: failure logs and tears down so the next open starts fresh |
| R16 | `psHost` had no stdin error handler: a dead child lost the command silently and hung until the full timeout | Writability is checked before writing; write errors and EPIPE reject immediately; timer cleanup is idempotent |
| R17 | A malformed SSE line in `code_search` threw a raw SyntaxError instead of falling through | Per-line try/catch |
| R18 | `apply_patch` across several files had no rollback: file 2 of 3 failing left file 1 patched | Originals are snapshotted and restored on failure (all-or-nothing now actually is) |
| R19 | `*** Add File:` silently dropped any body line missing the `+` prefix — the file was written incomplete while the tool reported success | Non-empty non-`+` lines are a loud format error |
| R20 | `place_window` shrank the HUD to mini *before* spawning PowerShell; a failed placement left it mini | Previous mode is restored when placement fails |

### Fixed (main process — memory, learning, security)

| ID | Defect | Fix |
| --- | --- | --- |
| R21 | All six JSON stores wrote non-atomically and silently reset to empty when a torn file failed to parse — a crash could permanently wipe long-term memory, lessons, settings and API keys | New shared `store.ts`: `atomicWrite` (tmp + rename, the pattern `stt.ts` already used) and `loadJson` (parse failures warn, missing files stay silent); wired into memory, settings, session, learn, user-model, agi |
| R22 | `run_python`'s deny list was bypassed by `__import__('os').system('rm -rf ~')`, `exec`, `eval`, `importlib` | Token-level deny for `__import__`, `importlib`, `eval(`, `exec(`, `compile(` |
| R23 | `forget()` reassigned the module-level array while a concurrent save serialised the old one — a just-saved memory could silently vanish | Deletion now splices in place |
| R24 | `forget()` matched by substring over the rendered label: "forget the meeting" deleted unrelated items | Exact text/name matches win; substring stays as fallback |
| R25 | Memory dedupe was exact-match only: reworded preferences piled up as contradictions injected into every prompt | Jaccard word similarity (≥ 0.7) upserts, matching the approach `learn.ts` already used |
| R26 | `setSettings` was an unserialised read-modify-write: overlapping saves (Save button vs the awareness checkbox) dropped each other's fields | Writes are chained through a promise queue |
| R27 | TTS `collect()` had no timeout: one stalled Edge-TTS socket permanently silenced speech and deafened the interrupt gate | 30 s timeout; the existing rebuild-once path recovers the engine |
| R28 | A failed Whisper `init()` left the spawned server orphaned; the next attempt spawned a duplicate holding its port and hundreds of MB | The spawned process is killed when start-up fails |
| R29 | Preload exposed unfiltered `on`/`off` channels to *any* main-process channel, and `off` wrapped a new arrow so listeners could never be removed | `on` is whitelisted to the four push channels the renderer actually uses and returns a real unsubscribe; `off` removed |
| R30 | `tts-synthesize`/`stt-transcribe` accepted unvalidated renderer input: a plain array became an empty recording with no error; huge payloads allocated huge WAV buffers | Type and size checks on both handlers |
| R31 | Background job results and `goals.json` grew without bound | Jobs older than 1 h are pruned on start; goals capped at 100 |
| R32 | `learn`/`userModel` persists ended in `.catch(() => undefined)`: lessons could silently never be written again | Warned, like memory already was |
| R33 | A stored key that failed decryption returned `''` silently while the UI still claimed the key was set | Decrypt failures warn with the likely cause |
| R34 | A hand-edited/schema-drifted `session.json` threw inside turn setup and failed EVERY later turn | Entries are shape-checked on load; malformed ones are dropped |

### Fixed (renderer)

| ID | Defect | Fix |
| --- | --- | --- |
| R35 | The Settings panel reset itself every 2 s while open (effect keyed on a recreated `onClose`), wiping keys the user was typing and re-fetching models twice a minute | Effect keys on `open` only; `onClose` read through a ref |
| R36 | Any one-time mic/model failure permanently bricked the mic toggle (merged error never cleared) | Model and mic errors are separate; toggling the mic clears the mic error so the listener retries |
| R37 | Status panel reported the voice engine "Unavailable" forever (checked for a `SpeechRecognition` API the app never uses) | Row now reflects the real whisper engine state (`Ready` / `Loading…`), threaded from `useVoiceAgent` |
| R38 | Dead queue-and-replay machinery in `useVoiceAgent` (`pendingRef` never written) misled maintainers | Removed; busy-time behaviour (only wake-word interrupts) is unchanged and documented |
| R39 | Dead `speaking` state polled every 150 ms and re-rendered App for a value nobody consumed | Removed |
| R40 | Visual close force-restored mini-HUD even after the user had explicitly expanded | Mini is restored only when the HUD was not touched since the visual arrived |
| R41 | Four `ipcRenderer.on` subscriptions with no cleanup (the bridge made cleanup impossible) | All effects now unsubscribe via the returned function |
| R42 | Esc to close a modal also cancelled JARVIS's speech and running turn | Modals register through a shared `modalState` module; App's Esc handler skips when one is open |
| R43 | Settings Preview/Remove buttons swallowed failures with no feedback | Reuse the `save()` error pattern |
| R44 | Dead files and CSS: `hooks/useMicLevel.ts`, `components/AgentsOverlay.css`, `styles/index.css`, `.dock-dot*` rules | Deleted |

### Tests

- 14 new tests in `tests/llmThink.test.ts`, `tests/visualAnswer.test.ts`, `tests/hardening.test.ts`
  (think-block stripping incl. truncated blocks; yes/no short-circuit acceptance and non-swallowing;
  plan-mode reset; Add File validation; atomic store write/read/damaged-file fallback).
- Full suite: **83 tests in 10 files, all pass.**

### Verification (this round)

- `npm run typecheck` (main + renderer): pass
- `npm run lint`: pass, 0 errors
- `npm test`: 83/83 pass
- `vite build` + main + preload emit: pass
- Runtime smoke test (virtual display, production build): window boots, telemetry and awareness
  start, no main-process exceptions, no renderer or IPC errors; the only logged errors are
  container artifacts (dbus/ALSA) and the honest "Native Whisper supports Windows x64 only"
  platform report. Exited cleanly when killed after 30 s.

### Deliberately left alone

- Everything the first pass accepted (Downloads same-name overwrite, `AUTONOMOUS = true`, the
  `[m` display artifact) and every subsystem the audits found clean (guard, toolLog, hud,
  telemetry, awareness, decision, toolRouter, toolArgs, browser.ts, panelTabs, panelScene,
  tinyfish, devTools, extraTools, workspace, vision, all clean renderer libs).

### Next priorities
- None outstanding from the perfection mandate. Further work should be driven by real
  usage failures and recorded in `brain/lessons.json` automatically.

---

## ROUND 3 — INDEPENDENT RE-VERIFICATION (2026-10-31)

Mandate: trust nothing, re-prove everything. All claims from Rounds 1–2 were re-checked
against the actual code (grep-verified: TURN_CHAR_BUDGET, atomicWrite store, resetPlanMode,
worker-thread grep, PROTECTED_PROCS PID resolution, open_url SAFE_RETRY exclusion) and the
full gauntlet was re-run from a clean `npm ci`.

### Fixed

| ID | Defect | Fix |
| --- | --- | --- |
| R45 | `sendToHud` guarded `isDestroyed()` but not the disposed-render-frame race: a renderer reload, crash or teardown between the check and the send made the telemetry sampler (2 s tick) spam uncaught `Render frame was disposed` stack traces from Electron internals | Send wrapped in try/catch; dropping a push to a disposed frame is always correct. Same defect class as D8, missed on this path |

### Verification (this round, from clean install)

- `npm ci`: clean (playwright/MCP dead deps confirmed gone)
- `npm run typecheck` (main + renderer): pass
- `npm run lint`: pass, 0 errors
- `npm test`: **83/83 pass, 10 files**
- Builds (vite renderer + tsc main + tsc preload): pass
- Runtime smoke test (virtual display, production renderer via `NODE_ENV=production`):
  boots, HUD renders, the ONLY error in the whole run is the honest expected platform
  report ("Native Whisper supports Windows x64 only" — host here is Linux; on the
  Windows 10 target the native engine loads), and `Render frame was disposed` errors
  count = **0** (counted unfiltered, not hidden by grep).
- Note for future smoke tests: without `NODE_ENV=production` the unpackaged app loads the
  dev URL `localhost:5173` by design; that is correct behaviour, not a bug.

### Next priorities
- None outstanding from the perfection mandate. Further work should be driven by real
  usage failures and recorded in `brain/lessons.json` automatically.

---

## ROUND 4 — REAL-WORLD FAILURE FIXES (2026-10-31, from the user's Windows 10 test run)

The user ran the test pack on real hardware. Every report below was traced to root cause
in code before fixing. Theme of the round: **enforcement in code, not prompts**, and
**verification before success is reported**.

| ID | User report | Root cause found | Fix |
| --- | --- | --- | --- |
| N1 | "Browser says task done though nothing executed" (panel closed manually) | Open-type tools returned a snapshot taken while the door animation still ran; a failed/aborted open tears the panel down AFTER the tool already succeeded | New `whenOpen()` gate: browser_open/search/play await the panel being fully open, else return `NOT DONE: … nothing was shown to the user` |
| N2 | "Tab state lies" | Redirects and SPA route changes never fired page-title-updated, so the bar/list showed stale URLs; destroyed views were listed | `did-navigate`/`did-navigate-in-page` refresh the bar; listTabs filters destroyed views and says plainly when the panel is closed |
| N3 | "Headless results felt like the browser did it" | search_and_read/fetch_url gave no signal that nothing is on screen | Both outputs now state "(Fetched headlessly: nothing is shown in the in-app browser.)" |
| N4 | "** spoken as asterisk asterisk" | Markdown reached the TTS pipeline verbatim | `speakable()` sanitizer at the single speech choke point (audio, system-voice fallback and captions all consistent): bold/italic/headings/bullets/pipes/fences/emoji stripped, links → text, URLs → domain, snake_case preserved |
| N5 | "Confused between my browser and the in-app browser" | `open_url` opened the EXTERNAL browser even when the model left `external` undefined | Code-enforced routing: external browser ONLY with `external=true`; otherwise the in-app browser runs it (visible, safe default) |
| N6 | "Kept Notepad on the left side" | place_window had exactly ONE layout (the left stage); "right half" was impossible by construction | Tool gained side=left/right/top/bottom/full computed from the primary work area; default stage preserved |
| N7 | "EPERM on D:, file tools weak" | Workspace root is D:\Jarvis-Files; a drive that denies writes made EVERY relative file op throw raw EPERM from mkdir inside resolveSafe/resolveWrite | Workspace bootstrap: write-probe preferred root, fall back to %USERPROFILE%\Jarvis-Files with a one-time notice surfaced in tool output; `fsExplain()` translates EPERM/EACCES/EBUSY/ENOENT/EROFS into recovery-grade messages (read, list_files) |
| N8 | "Creating/editing/patching very weak" | Exact byte matching: Windows CRLF files vs the model's LF text made nearly every edit "not found"; binary files read as garbage | applyEdit is CRLF-tolerant (normalises for matching, preserves the file's EOL); read detects binary and says so |
| N9 | Research had no real sources, stale facts | Sources depended on the model's goodwill; the quick path had no date anchor | Sources section is now BUILT programmatically from URLs that actually flowed through the research tools; "no pages fetched → all claims unverified" otherwise; both paths date-anchored ("Today is …") |
| N10 | "Goes off topic" | Compaction of long tool rounds replaced history with a generic omission note — exactly where attention drifted | The compaction note now RE-STATES the user's task ("The user's current task is still: …") — code-level re-anchoring every time |
| N11 | "Can't access device registry / Bluetooth devices" | No device enumeration existed in get_system_info | topic=devices lists connected device classes and paired/connected Bluetooth devices via Get-PnpDevice (honestly documented: cannot discover never-paired devices) |
| N12 | "Cannot scroll in Settings" | Form had no height cap/scroll | max-h-[86vh] overflow-y-auto |

### Verification (this round)

- `npm run typecheck`: pass · `npm run lint`: pass, 0 errors
- `npm test`: **95/95 pass, 11 files** (12 new tests: speakable, CRLF applyEdit, fsExplain)
- Builds (vite + tsc main + preload): pass
- Runtime smoke test (production renderer): boots clean; only the expected platform report.

### Known limits documented in this round

- Bluetooth discovery of NEW (never-paired) devices is not possible via PnP; the tool
  says so instead of pretending.
- The workspace still prefers D:\Jarvis-Files when it IS writable (user's setting).

### Next priorities
- None outstanding from the perfection mandate. Further work should be driven by real
  usage failures and recorded in `brain/lessons.json` automatically.

---

## ROUND 5 — BULLETPROOF EVERY TOOL, EVERY SCENARIO (2026-10-31)

The user's follow-up after re-testing: **"I want the tools to be bulletproof to all
scenarios, even rare ones — enforced via code, not prompts."** Every fix below is
deterministic code, and every tool now verifies reality before its result is reported.

### Architecture changes (no fix-sprawl: same modules, stronger cores)

| ID | Area | What was wrong (rare and common scenarios) | What is now enforced in code |
| --- | --- | --- | --- |
| B1 | `panel.ts` + `browser.ts` | The fake-success class: a panel closed by the user mid-action still produced a snapshot from the doomed webContents; hidden panels executed invisibly; crashed tabs haunted the registry | **VERIFY-THEN-REPORT envelope on every browser tool**: pre-check (openers may open; others refuse honestly when closed/closing), hidden panels are brought back on screen before acting, and the panel state is re-checked AFTER the action — a panel closed mid-flight turns the whole step into `NOT DONE: … did not complete visibly`. Every result ends with a ground-truth line `[in-app browser: state · N tabs · active: title]` |
| B2 | `panel.ts` | Tab indexes were renumbered by listTabs (filtered) but switch/close used raw indexes → the list could point at the wrong tab | Destroyed tabs are pruned the moment they die (`destroyed` handler); list indexes and switch/close indexes are the same numbers by construction; crash recovery reloads up to twice then prunes; teardown detaches the registry before closing to prevent mid-iteration splices |
| B3 | `panel.ts` | A malformed `__jtab__` console message threw inside the handler and could kill the tab bar for the session | JSON.parse guarded |
| B4 | `tts.ts` + `renderer/lib/speakable.ts` + `speech.ts` | Markdown reached voices through paths the subtitle stripper did not cover; a stale renderer could still speak `**` | **Triple enforcement**: the renderer `enqueue` choke point strips every job (neural + system voice + captions from one text), `main/tts.ts synthesize()` strips again at the only point all neural audio passes, and the subtitle path keeps its per-sentence strip. Empty speakable text ends the job instead of hanging the queue |
| B5 | `tools.ts` (launch_app) | "Open notepad on the right" was impossible: launch_app had no side parameter and auto-placed on the left stage every time | launch_app gained `side: stage/left/right/top/bottom/full`, passed to placeApp; guide and examples updated |
| B6 | `stage.ts` | Placement was reported as success whenever the PowerShell call exited 0, even if the window never moved | The script re-reads the window rect after the move and exits 4 when the top-left is off by more than 80 px; the tool reports `Placed on the RIGHT half of the screen` / `not found` / `could not be placed` — never a fake placement |
| B7 | `fsTools.ts` (read) | PowerShell-era UTF-16 files decoded to null-byte soup and were misreported as binary; no metadata; bare directory lists | BOM + heuristic UTF-16 decoding, binary check that understands UTF-16, meta header (size, modified), empty-file message, directory listing with sizes and counts, explicit `use offset N to continue` |
| B8 | `fsTools.ts` (applyEdit) | Exact-match-only editing failed on trailing whitespace and shifted indentation | Three-tier matching: exact → trailing-whitespace-tolerant → indentation-tolerant; ambiguity at any tier refuses with line numbers instead of guessing; EOL style preserved; clearer not-found message |
| B9 | `tools.ts` + `store.ts` (write_file/edit_file/multi_edit) | A crash mid-write could truncate a file; no append mode; edit of a missing file threw a raw ENOENT | All writes are atomic (temp+rename, O_APPEND for appends); write_file gained `append true`; edit_file explains missing/folder paths via fsExplain |
| B10 | `laptopTools.ts` | "Cannot access D:" produced a dead end; Device Manager could not be opened by name; stop_process reported "asked to stop" without checking | New `list_drives`: every drive with type, size, free space and a REAL read/write probe per drive; `fsExplain(EPERM)` now names BitLocker / permissions / Controlled Folder Access and points at list_drives; open_anything opens `devmgmt.msc`, `diskmgmt.msc`, `services.msc`, `regedit` and friends via PATH; stop_process re-checks the process list and reports "verified gone" or "STILL RUNNING — use force" |
| B11 | `systemTools.ts` | No way to see devices that are in pairing mode (the Bluetooth window's list) | New `bluetooth_scan`: real Windows Bluetooth discovery (BluetoothFindFirstRadio/FirstDevice/NextDevice P/Invoke, ~12 s inquiry), lists `IN PAIRING MODE — ready to pair` vs paired/connected/remembered; open_app now surfaces a missing binary as an error instead of swallowing it |
| B12 | `provider.ts` | Off-topic drift deep into long tool chains could not be stopped by a prompt | **Code-enforced topic anchor**: every 8 tool rounds the current request is stamped onto the next tool result (`[ANCHOR — the user's current request is still: …]`) |
| B13 | `orchestrate.ts` (research) | Stale or invented dates and vague citations survived the synthesis step | DATE DISCIPLINE baked into every research prompt (sub-agents and synthesizer): every date/number must come from a page fetched in THIS run, unconfirmable facts become UNVERIFIED; the answer opens with "Research run on <today>"; the Sources footer labels itself as actually-fetched pages; empty synthesis falls back to raw agent reports |
| B14 | `toolRouter.ts` | list_drives / bluetooth_scan / get_system_info / list_processes were group-gated | Added to CORE: diagnostics the user explicitly asked for are always loadable |
| B15 | `SettingsPanel.tsx` | The centered-overlay pattern could still clip/lock the form on short windows | The overlay itself is the scroll container (overflow-y-auto + overscroll-contain, form centered with m-auto) — content can never become unreachable |
| B16 | `extraTools.ts` | A megabyte "expression" would stall the main thread in Function-compile | calculate is capped at 500 characters |

### Verification (this round)

- `npm run typecheck`: pass (main + renderer) · `npm run lint`: pass, 0 errors
- `npm test`: **104/104 pass, 12 files** (9 new: whitespace-tolerant applyEdit incl. ambiguity refusal and CRLF preservation, EPERM guidance, main-vs-renderer speakable parity)
- Builds: renderer (vite), main (tsc), preload (tsc) — pass
- Runtime smoke test (Xvfb, NODE_ENV=production): boots clean; **0** "Render frame was disposed"; no app-code errors in an unfiltered log scan

### Honest limits (unchanged)

- JARVIS cannot elevate itself: a drive that Windows denies is reported with the real cause
  and the per-drive readability map, not bypassed.
- Pairing itself stays a user click (ms-settings:bluetooth is opened for them); scanning is
  fully automated.

---

## ROUND 6 — INTERACTIVE & BACKGROUND MODES (2026-11-01)

The user's mandate: everything JARVIS does must be shown live in a new **Interactive
Mode**, and a **Background Mode** must let him work silently and notify at the end —
with the tools equally bulletproof in both modes. Standing rule applied here: safety
is above silence (approval prompts surface in both modes, always).

### Architecture (one new engine; wire types shared by both ends)

| ID | File | What it does |
| --- | --- | --- |
| M1 | `src/main/modes.ts` (new) | The interaction-mode state machine: mode state + persistence (`mode.json` in userData, corrupted file falls back to the default), the activity event bus (ring buffer capped at 200, stamped ids, correlation ids so a tool's busy line is replaced by its result), the speech gate, and the per-turn digest that turns a finished turn into ONE honest end-of-task notification (steps, failures, real reply / "interrupted after N steps" / the actual error). Pure logic, electron-free, fully unit-tested; index.ts injects the HUD sink and the native notifier. |
| M2 | `src/main/protocol.ts` (new) | Wire types (`ActivityEvent`, `NotifyPayload`, `ModeInfo`, `InteractionMode`) used by BOTH main and renderer — one shape, the two ends cannot drift. |
| M3 | `tools.ts` (runTool) | The single choke point every tool call passes through now emits the start (busy + argument preview) and the outcome (ok/fail + result preview + duration) as feed events; transient retries are visible too. Works for batch, chain, sub-agents and parallel tasks because they all go through runTool. |
| M4 | `provider.ts` | `beginTurn` at turn start; progress notes become feed events; `endTurn` at all three exits (reply, interrupted, failed) so a background turn is always concluded honestly. |
| M5 | `guard.ts` | Approval cards appear in the activity feed in both modes and still pop the HUD in background mode (safety above silence). |
| M6 | `visual.ts` | `show_visual` records "Visual ready: <title>" in the feed; the staged-then-confirm flow is unchanged. |
| M7 | `extraTools.ts` | Proactive speech (say_aloud, timers) is held in background mode, and the hold is recorded in the feed — even the silence is honest. Native timer notifications still fire. |
| M8 | `index.ts` | Wiring: `initModes` with HUD sink + native OS notification (click focuses the HUD), global shortcut Ctrl+Alt+B, validated IPC `mode-get` / `mode-set`. |
| M9 | `preload` + `types/electron.d.ts` | `modes.get/set` API; push whitelist extended by exactly three channels: `jarvis-activity`, `jarvis-notify`, `mode-changed`. |
| M10 | renderer (new hooks + components) | `useMode` / `useActivity` hooks; `ActivityFeed` panel (newest first, status glyphs, durations, argument/result previews); right rail becomes tabbed (Transcript / Activity); header mode toggle (eye = interactive, moon = background); Status readout gains a Feed row; App gates captions and TTS in background and speaks the end-of-task verdict once. |

### Background semantics (what "silent" means, exactly)

- No spoken replies, no progress speech, no proactive speech; transcript still updates.
- No live feed pushes; events buffer so the feed is complete the moment the user looks.
- In-app browser: an action against a hidden-but-alive panel runs silently and the result
  is marked `[background mode: this ran against the hidden panel — nothing was shown on
  screen]` (the interactive reshow-to-screen rule would have popped a full-screen panel
  over the user's work). A panel the user CLOSED still refuses with NOT DONE — the
  verify-after ground-truth check is untouched, and browser_open still shows the page it
  was asked to open (that page IS the requested result).
- ONE notification when the turn ends, built from the turn's real outcome: native OS
  notification (click → HUD focused) + a HUD caption + one spoken line.
- Approval prompts still surface and are spoken (safety above silence).
- Mid-turn mode switches are honored: a turn that ran ANY part under background rules
  still gets its end notification; a fully interactive turn never notifies (the user
  watched it happen).

### Pre-existing test-isolation bug fixed on the way

- `workspace.ts` forced the user-profile workspace on POSIX even when `JARVIS_FILES_ROOT`
  was set for tests, so the memory tests silently read and wrote the developer's HOME:
  the first run in a clean environment passed, every later run failed on stale data.
  An explicit `JARVIS_FILES_ROOT` is now honoured first on every platform. (Also fixed a
  `[memory]` log typo.)

### DevTools Autofill console noise (user report, resolved)

- Root cause: Electron's bundled DevTools requests the CDP Autofill domain, which
  Electron does not implement (`'Autofill.enable' wasn't found`). Empirically verified:
  in Electron 32 these lines are logged natively and never reach any webContents
  `console-message` event, so no app-side filter is possible. Fix: DevTools no longer
  force-opens in dev — open with Ctrl+Shift+I when needed, or `JARVIS_DEVTOOLS=1` to
  restore auto-open; production builds never open it. Result: a clean dev console with
  zero Autofill lines while DevTools is closed.

### Verification (this round)

- `npm run typecheck` (main + renderer): pass · `npm run lint`: pass, 0 errors
- `npm test`: **125/125 pass, 13 files** (21 new: mode state + persistence incl. corrupted
  file, interactive vs silent event routing, mid-turn switch notification, honest
  interrupted/failed notifications, speech gate, ring-buffer cap, string clipping,
  throwing sink/notifier isolation, concurrent setMode; the suite was run twice in a row
  to prove test isolation after the workspace fix)
- Builds (vite renderer + tsc main + tsc preload): pass
- Runtime smoke (Xvfb, `NODE_ENV=production`): boots clean, 0 Autofill lines, no IPC
  handler errors; only expected container noise (dbus/ALSA) and the honest Whisper
  platform report.
- Runtime drive verification (Playwright `_electron`, the real built app): header toggle
  Interactive → Background → Interactive updates the label, aria-label and Status Feed
  row live; Activity tab shows the honest empty state; the mode persists to disk and a
  fresh boot starts in the persisted mode; renderer console errors: none.

### Known limits

- Without OS notification support (`Notification.isSupported()` is false), the native
  notification is skipped; the HUD caption and the spoken verdict still fire.
- The feed is a live console, not an archive: the ring buffer keeps the last 200 events
  and hands the renderer the last 100.
- Quick answers that bypass the turn loop (the "ready to see it?" yes/no path) never
  notify — nothing was done in the background worth reporting.

## ROUND 7 — PROVIDER FAILURE DISCIPLINE: DEAD-MODEL FAIL-FAST (2026-11-01, from the user's Windows run)

The user's `ai-chat` handler threw `Provider returned 503` with Google's message buried
inside: *"This model models/gemini-2.5-flash-lite is no longer available to new users."*
Diagnosis first: not a JARVIS bug. Google limited all Gemini 2.5 models to accounts that
had used them before (official changelog, 2026-09-18) and the user's relay wrapped the
upstream 404 in its own 503. The failure path itself was already honest — the turn was
recorded with its error, the failure stayed in context, the background digest delivered
a "could not finish" notification, and the renderer received the rejection. Two real
defects surfaced anyway, both fixed.

### Fixes

| ID | File | What changed |
| --- | --- | --- |
| P1 | `src/main/llm.ts` | **Dead-model fail-fast.** New exported pure classifier `providerRejection(status, body)`: when the response body carries model-level rejection wording ("no longer available", "not available to new users", "model not found", "does not exist", …), `send()` throws once with an actionable message — status, the provider's own words, and "Pick another model in Settings." — instead of burning two retries (~2.4 s plus upstream load) on a permanent condition. Transient bodies (overload, rate limit) keep the existing retry ladder untouched. The classifier is deliberately status-agnostic: relays disagree on which HTTP code carries an upstream 404. |
| P2 | `src/main/llm.ts` | **Honest network errors.** The "Cannot reach" message now includes the underlying cause text instead of swallowing it — a misconfigured BASE_URL and a refused socket no longer look identical. |

### Verification (this round)

- New `tests/llmSend.test.ts` (6 tests): the pure classifier against the exact relay body
  from the user's log, a plain un-wrapped 404, and negative cases that must stay retryable;
  plus `send()` over a REAL local HTTP server (no fetch mocks — vite-node evaluates src
  modules against a different global than the test file, so socket-level proof is the
  honest one): dead model → exactly 1 request and the actionable error; genuine 503 →
  3 requests then the raw status; 200 → pass-through.
- Full gauntlet: `typecheck` pass · `lint` pass, 0 errors · `npm test`: **131/131, 14
  files** (was 125/125, 13 files) · three builds pass · production smoke under Xvfb: clean
  boot, 0 disposed-frame lines, 0 Autofill lines, no handler errors.
- Caught during the round, fixed before it shipped: the first patch shadowed `send()`'s
  `body` parameter with a `const body` (TDZ) — the new test file failed on it immediately,
  which is exactly what the every-change-must-test rule is for.

### Known limits

- The classifier matches wording, so a relay that rewrites Google's message beyond
  recognition falls back to the retry ladder — bounded, never wrong, just slower.
- No automatic model fallback: switching models is a user decision in Settings, never a
  silent one JARVIS makes for him.

## ROUND 8 — THE GATE GETS TEETH + MODEL FALLBACK CHAIN (2026-11-01, from the first live E2E run)

The disguised Background-Mode E2E prompt (kit in `download/JARVIS_BG_E2E_TEST_KIT.md`, full
audit in `download/JARVIS_BG_E2E_TEST_VERDICT.md`) was finally run for real. The disguise held,
the firm-budget trap was respected, the cost-per-update-year math was exactly right — and the
run still FAILED the pre-registered criteria, because the self-graded `quality_gate` saw nothing
while the report shipped with: a confidently wrong year ("Date: 1 November 2025" written on
1 November 2026 — internally self-consistent, since its wrong date was a Saturday matching its
own "this Saturday" advice), zero source URLs, zero UNVERIFIED marks on volatile prices, a 2025
market snapshot presented as "actually sold right now", and one spec stated twice with two
different numbers (iQOO 13: 206 g summary card vs 213 g table). In parallel, the Gemini 2.5
deprecation from Round 7 still dead-ended every turn with no way to keep working. Five fixes,
each with tests.

### Fixes

| ID | File | What changed |
| --- | --- | --- |
| F1 | `src/main/quality.ts`, `src/main/clock.ts`, `src/main/provider.ts` | **Date anchor.** Every turn's context now leads with a `TODAY:` line computed in code (`dateContext(todayParts())` — weekday, day month year, ISO, timezone), so the model never guesses the date. A new `clock.ts` cross-checks the OS clock once per process against the API host's own HTTP `Date` header (fail-open, 4 s timeout, cached); drift beyond 24 h injects a `[CLOCK WARNING]` into the prompt instead of being trusted blindly. |
| F2 | `src/main/quality.ts`, `src/main/provider.ts` | **Citation gate (code-enforced).** `researchViolations()` checks the final reply PLUS every `write_file` body: report-class output needs ≥2 distinct source URLs, and fresh/volatile claims with neither sources nor UNVERIFIED markers are rejected. Runs in code, so it cannot be skipped the way the self-graded checklist was. |
| F3 | `src/main/quality.ts` | **Spec consistency diff.** Line-local attribution (bold spans first, digest-card line-leads second; a spec belongs to the nearest model name to its left) catches the same product carrying two numbers for the same spec — the real 206 g vs 213 g case — without cross-model false positives (4G/5G excluded by a weight sanity floor, `<label>:` spans rejected as names). |
| F4 | `src/main/provider.ts`, `src/main/toolGuide.ts` | **Freshness enforcement.** "right now / currently / in stock / latest" in the request sets `freshTurn`: the turn must contain a successful web search/fetch action and the output must carry an "as of <today>" stamp; any `Date:`/`as of:`/`updated:` line that parses to a date other than today is a violation. WORKFLOW now documents the gate so the model gets it right the first time. |
| F5 | `src/main/llm.ts`, `src/main/settings.ts`, `src/main/provider.ts`, preload, `types/electron.d.ts`, `SettingsPanel.tsx` | **Model fallback chain.** `send()` now throws a typed `ModelGoneError` (message unchanged — the Round 7 wording is tested); `withModelFallback(chain, job, onFallback)` re-runs the work on the next model of a user-configured chain (Settings → "Fallback models", stored or `JARVIS_FALLBACK_MODELS` env), while transient failures still fail honestly on the first model. Not a silent substitution: each hop emits a "Model unavailable — retrying with X" feed event, and with no chain configured the Round 7 fail-fast behavior is untouched. |

### Gate delivery semantics (deliberate)

A violating answer is bounced back ONCE with a corrective message naming each violation
(sources, date, stamp, marks, specs). If the retry still fails, the answer ships FLAGGED
(`[QUALITY GATE — delivered unverified: …]`), the activity feed records the failure, and the
session ledger gains a `quality_gate FAILED (…)` action — which `verify_bg_test.js` C1 already
detects via its ` FAILED$` convention. A passing project turn records
`quality_gate PASS (code-enforced)`. Never silently passed, never silently blocked.

### Verification (this round)

- New `tests/round8.test.ts` (19 tests): the REAL failing report (condensed from the live run)
  is caught on all five axes while consistent specs stay quiet; a sourced/dated/stamped report
  passes clean; historical dates ("launched 17 January 2024") are not flagged; failed web
  lookups count as missing; a written report is gated even when the spoken reply is "Done.";
  `parseDated` across the four real date shapes; clock drift parsing/warning/fail-open probe;
  write_file-only report extraction (a clipboard content is not a report); fallback-chain
  settings precedence (stored > env > none, trimmed).
- `tests/llmSend.test.ts` grew 4 socket-level tests: retired primary → turn survives on the
  fallback (2 hits); all models gone → honest error after exactly one attempt per model (2
  hits, no retry storm); transient 500 → NOT swallowed, first model only (3 hits); chain
  dedupe/trim/order.
- Full gauntlet: `typecheck` pass · `lint` pass, 0 errors · `npm test`: **154/154, 15 files**
  (was 131/131, 14 files) · three builds pass (tsc main, tsc preload, vite renderer).

### Known limits

- The spec diff covers weight and battery (the two numbers a summary card actually repeats);
  prices are ranges too often to diff safely and are left to the sources/UNVERIFIED rules.
- The gate is deterministic, not smart: a sourced report with subtly wrong numbers still
  passes if the model never states a conflicting value twice. `verify_claim` and the checklist
  remain the second layer.
- Freshness detection is wording-based ("right now", "currently", …); a request that implies
  currency without such words gets the date-anchor checks but not the web-lookup requirement.
- The fallback chain only reacts to PERMANENT model rejections; a gateway that is fully down
  still fails the turn (correctly — retrying into a dead gateway helps nobody).

## ROUND 9 — TOWARD THE REAL JARVIS: PROVENANCE, ARITHMETIC, FOLLOW-THROUGH (2026-11-01)

The user's verdict after the Round 8 fixes: "way better, but nowhere near the actual JARVIS —
keep a very very high benchmark." Round 9 closes the three gaps that still separated the system
from the movie's butler, each one a real engineering fix with a test, not a prompt tweak.

### Fixes

| ID | File | What changed |
| --- | --- | --- |
| G1 | `src/main/quality.ts`, `src/main/provider.ts` | **Provenance gate (the fabricated-number detector).** Every accountable figure in a report or long reply — currency amounts (incl. ₹45k / ₹1.5 lakh forms) and unit-attached specs (mAh, Wh, g, kg, GB, TB, inches) — must be traceable to this turn: seen in a tool result, in the user's own request, produced by calculate/run_python (their outputs join the evidence pool), derived as ×/÷ of two seen values within 1%, or sitting on a line explicitly marked UNVERIFIED. 0.5% tolerance absorbs rounding (6,428.57 seen → "₹6,429" passes) while a fabricated ₹43,000 next to a seen ₹46,999 is 7.4% off and caught. Provider accumulates every successful tool result (≤40 × 4 KB) as the evidence pool. This is the deterministic version of the D2 failure: the 2025 market snapshot could not ship at all now. |
| G2 | `src/main/quality.ts` | **Arithmetic audit.** The gate recomputes the maths in code: stated divisions ("45,000 / 7 = 6,428.57") and per-year figures ("₹6,428 per year" / "~₹9,750 / year") are verified against the totals on the same line; any currency total that divides to the stated figure within 0.5% passes (rows legitimately carry price, EMI and per-year side by side). The live run's "~₹6,428 / year" next to a "₹43,000 – ₹47,000" range — exact division of neither endpoint — is now a violation even with perfect sources. UNVERIFIED lines are exempt from both new checks: honesty is never punished. |
| G3 | `src/main/scheduler.ts` (new), `src/main/modes.ts`, `src/main/tools.ts`, `src/main/toolRouter.ts`, `src/main/index.ts` | **Scheduled autonomous follow-ups — the follow-through capability.** `schedule_task(task, in_minutes or at)` schedules a REAL turn: at the due time the scheduler wakes, runs the task through the full agent loop (tools, ledger, quality gate) with a self-scheduled marker so it works autonomously and ends with one verdict line, records the outcome in the session ledger, and sends exactly one notification. Tasks persist in `Jarvis-Files/scheduled.json`, survive restarts, run once if they came due while the app was closed; `list_scheduled` / `cancel_scheduled` manage them; bounds 1 min – 30 days, max 20 pending, crash-safe status recovery (a 'running' wedge resets to pending). In background mode the turn's own end-of-task notification is the one — the scheduler stays silent to avoid double toasts. Module is electron-free like modes.ts; index.ts injects the runner (`chat`) and notifier. |
| G4 | `src/main/memory.ts` | **Memory revisions instead of contradictions.** A changed value ("the budget is now ₹80,000") updates the existing entry in place and answers "Updated (was: …)" when the category matches, both texts carry currency figures that differ, and the wording minus the amounts is ≥85% identical. A different topic with a different amount (phone budget vs laptop budget) still gets its own entry — the guard is on wording, not just numbers. |
| G5 | `src/main/toolGuide.ts` | WORKFLOW's CODE GATE paragraph now states the provenance and arithmetic checks and the fix ("quote exact source figures, run calculate for every derived number, mark anything unconfirmed UNVERIFIED"); OPERATING PRINCIPLES gains rule 10: never promise "I will check later" without scheduling it; the MEMORY AND DAY guide documents schedule_task and when NOT to use it (reminders stay set_timer, routines stay add_recurring_task). |

### Verification (this round)

- New `tests/round9.test.ts` (20 tests): the fabricated-₹43,000 price caught while the sourced
  report passes; derived 6,428.57 = 45,000 ÷ 7 accepted and 59,000 rejected; UNVERIFIED lines
  exempt; ₹45k/₹1.5 lakh normalisation; correct division accepted and wrong one recomputed;
  the REAL failing-report per-year pattern caught; EMI rows pass; the full scheduler lifecycle
  (schedule → not-yet-due no-op → run at due time with the self-scheduled marker → done with
  reply in `scheduled.json`), ISO/plain-time parsing, past/garbage rejection, cancel, honest
  FAILED notification on a dead runner, background-mode silence; memory revision updates in
  place with "was", phone-vs-laptop budgets stay separate, identical re-save stays deduped.
- Full gauntlet: `typecheck` pass · `lint` pass, 0 errors · `npm test`: **174/174, 16 files**
  (was 154/154, 15 files) · three builds pass (tsc main, tsc preload, vite renderer).
- Compiled-output spot check: the gate, run against a reconstruction of the live failing
  table (range + per-year figure), rejects it with "per-year figure unexplained".

### Known limits

- Provenance tolerance is 0.5%: a fabricated figure within half a percent of a seen one slips
  through (deliberate — false accusations teach the model to route around the gate).
- The arithmetic audit reads line-locals only; a per-year figure stated on a different line
  from its total is "unexplained" (the corrective round teaches the format) — a report that
  puts the division in prose far from the price may need the UNVERIFIED-free retry.
- Scheduled tasks run only while JARVIS is open (they persist and run at the next start if
  the app was closed); there is no OS-level wake — by design, this is an assistant, not a
  background service.
- Memory revision detection requires currency in both texts; non-numeric revisions
  ("I now prefer Android") still follow the existing similarity dedupe.

## ROUND 10 — ADVANCED COGNITIVE ARCHITECTURE & ENFORCEABLE AUTONOMY (2026-11-01)

Mandate: Advance JARVIS into a general-purpose autonomous cognitive system where intelligence is
enforced in application code, not merely requested by prompts.

### Subsystems Implemented

| Subsystem | File | Core Engineering Responsibility |
| --- | --- | --- |
| Goal Understanding Engine | `src/main/goalEngine.ts` | Intent normalization, constraint extraction, ambiguity detection, verifiable success criteria, authoritative goal contracts, and semantic drift prevention (Invariant 5). |
| Persistent DAG Planning | `src/main/persistentPlanner.ts` | Directed Acyclic Graph (DAG) task decomposition, topological batching, reachability & cycle validation, node preconditions & expected outcomes, persistent checkpoints, and dynamic replanning that preserves verified completed work. |
| Strategy Selector | `src/main/strategySelector.ts` | Deterministic complexity scoring, risk routing, and resource budgeting across direct response, quick lookup, browser automation, deep research, and hierarchical planning. Trivial queries bypass heavy planning overhead. |
| Metacognitive Engine | `src/main/metacognition.ts` | Measurable self-monitoring in code: tool loop detection (identical or oscillatory calls), consecutive failure tracking, evidence contradiction diffing, and resource budget guardrails with concrete self-corrective directives. |
| Outcome Verification | `src/main/outcomeVerifier.ts` | Independent post-action outcome inspection: disk verification of created/edited files (size, existence, content matching), browser truth-line checks, and syntax balancing. |
| Hybrid Cognitive Memory | `src/main/advancedMemory.ts` | 6-tier cognitive architecture (episodic, semantic, procedural, failure, preference, strategic) with hybrid lexical + semantic retrieval, automatic contradiction resolution (superseding conflicting entries), and validated learning promotion. |
| Environmental Intelligence | `src/main/envIntelligence.ts` | Host system capability discovery (OS, CPUs, RAM, workspace), runtime availability (Node, Python, Git), and stale cache invalidation (<60s TTL). |
| Long-Horizon Execution | `src/main/longHorizon.ts` | Point-in-time state checkpoints, crash-resilient restart recovery (active jobs cleanly recovered to interrupted), and idempotency key registry to prevent duplicate non-idempotent operations (Invariant 11). |
| Specialized Model Router | `src/main/modelRouter.ts` | Cognitive role assignment (reasoning, planning, coding, research, verification, classification), capability profiles, and transparent preservation of user-configured fallback chains. |
| Central Dispatch Wiring | `src/main/tools.ts`, `src/main/toolRouter.ts`, `src/main/provider.ts` | Centralized `runTool` choke point registered with `goal_status`, `env_status`, and `verify_file_change`. Connected `completion.ts` (`beginTask`, `recordStep`, `auditReply`, `endTask`) directly into live `runTurn` loop. |

### Verification (Round 10)

- New `tests/cognitiveArchitecture.test.ts` (30 tests): Explicit tests for all 30 mandatory test scenarios defined in the Autonomous Engineering Directive (malformed model output, invalid arguments, tool timeouts, partial side effects, provider outages, persistence failures, crash recovery, idempotency, concurrent plan versions, dynamic replanning preserving completed work, cancellation, verification failures, injection defenses, memory poisoning prevention, resource limits, loop detection, environmental refresh, policy authorization, conflicting memory supersession, sub-agent recovery, DAG cycle rejection, checkpoints, fallback routing, and goal drift rejection).
- Full gauntlet:
  - `npm run typecheck`: **PASS (zero errors in node and app configs)**
  - `npm run lint`: **PASS (zero errors across src/)**
  - `npm test`: **260/260 tests passed across 19 files** (all 18 previous test suites + new cognitive test suite)
  - `npm run build:dev`: **PASS (main + preload compilation clean)**
  - `npm run build:renderer`: **PASS (Vite production bundle clean)**

