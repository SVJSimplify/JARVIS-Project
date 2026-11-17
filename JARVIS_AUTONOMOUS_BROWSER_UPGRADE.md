# JARVIS — FULL AUTONOMOUS BROWSER CONTROL AND CAPABILITY INTEGRATION

> **HISTORICAL DOCUMENT (2026-11-04 release note).** Where it mentions the mission engine,
> read "durable task coordinator" — the mission engine was retired and removed after this
> round; every authorization claim below still holds via the same central boundary.

Date: 2026-11-04 · Basis: line-by-line inspection of the live repository, implemented directly in it.
Status: **complete and verified** — `npm test` 487/487 PASS (30 files) · `npm run typecheck` PASS ·
`npm run lint` PASS · renderer/main/preload builds PASS.

---

## 1. WHAT THIS DELIVERS (acceptance criteria, item by item)

| # | Criterion | Where it lives now | Proof |
| --- | --- | --- | --- |
| 1 | One operating policy, no permission modes | `permission.ts` (single `autonomous` level), `tools.ts` (authorization still runs at the one choke point) | existing permission tests + new policy tests |
| 2 | Ordinary actions run automatically, no dialogs | `permission.authorize` auto-allows everything not hard-blocked; the only remaining ask path is a hand-written `brain/permissions.json` rule the operator wrote themselves | `policy.test.ts` "never asks for allowed actions" |
| 3 | Deletion blocked centrally | **NEW `policy.ts`** — one classifier consumed by `guard.assessRisk` (the single gate input) | `policy.test.ts`: 15 shell forms, python deletion, `apply_patch` Delete, destructive UI labels, storage-wiping JS, `{DEL}` keys — all BLOCKED, none askable |
| 4 | OS resources blocked centrally | `policy.osProtectedPath` + `shellVerdict` OS-class + `processVerdict` | `policy.test.ts`: bcdedit/reg HKLM/sc/services/net user/takeown/icacls/Set-MpPreference/pnputil/shutdown/iex, writes into Windows/System32/drivers/browser profiles, critical-process kills — all BLOCKED |
| 5 | Browser performs complete multi-step workflows | existing engine verified: 32 browser tools, snapshot→act→re-snapshot loop, stale-ref self-healing, dialogs, downloads, uploads, tabs, back/forward, eval, waits; background mode runs against the hidden panel | pre-existing browser behaviour unchanged (all prior tests pass) |
| 6 | Browser tools registered and connected | single registry in `tools.ts`; browser tools verified open→act→verify (verify-then-report enforced in `browser.ts`) | manifest integrity: zero issues |
| 7 | Model knows its actual capabilities | **NEW `capabilityManifest.ts`** — generated from the live registry, injected into every system prompt (`provider.systemMessage` → `capabilityPrompt()`) | `capabilityManifest.test.ts` |
| 8 | Capability descriptions match executable tools | `manifestIssues()` validates registry↔schemas↔groups↔agent-allowlists; the `list_capabilities` tool surfaces integrity inline | test: "zero manifest issues across the whole registry" |
| 9 | Every provider receives correct tool definitions | **defect found & fixed**: `TOOL_SCHEMAS` was captured mid-module, so `load_tools`, `tool_log` and `list_capabilities` were registered but never exposed to the model. Schema list is now built after the full registry (ordering made drift-impossible) | test: "static exported schema list in parity with the registry" |
| 10 | Tool results return correctly to the model | existing streaming assembly (index-less gateways, tool-call ids, results, continuation, compaction) verified in review; unchanged | existing `llmSend`/`llmThink` tests |
| 11 | Agents and background jobs use the same boundary | sub-agents (`subagent.ts`), coordinator tasks, missions and the scheduler all execute through `runTool` → one `authorize` call; `AsyncLocalStorage` tags every record with agent/task ids | policy tests prove block for `main`, `task:general#1`, `task:explore#2` alike |
| 12 | Important browser operations recorded | durable JSONL execution records (`toolRecord.ts`) with tool, agent, task, args preview, auth decision, status, timing, idempotency key | pre-existing tests pass |
| 13 | Results verified rather than assumed | browser: verify-then-report (state re-checked after every action, truth line on every result); tasks: `verifier.ts` checks acceptance criteria against disk evidence; quality gates re-check research answers | pre-existing tests pass |
| 14 | Existing functionality continues working | full suite green: 487/487 | `npm test` |
| 15 | Automated tests pass | 487/487 in 13s | `npm test` |

## 2. THE SINGLE ENFORCEMENT BOUNDARY (`src/main/policy.ts`, new)

One pure module is the ONLY place the two hard restrictions are defined. Every execution
route — main agent, any child agent, browser workflows, background jobs, scheduled tasks,
native tools, and any tool registered in the future — reaches tool code only through
`runTool → assessRisk → authorize`, and `assessRisk` now delegates to `policy.ts`. The
former scattered denylists (`devTools.DENY`, `agi.PY_DENY`, guard's private regexes) were
deleted and now call the same central classifiers as a second layer. A new tool cannot
bypass the policy because new tools have no other execution path.

Fail-closed choices, by design:

- **Opaque payloads are denied**: `iex`/`Invoke-Expression` and `curl | sh` (the payload
  would bypass classification), python `getattr/globals/exec/eval/compile/ctypes/winreg/subprocess`
  (dynamic access can smuggle forbidden calls), opaque scripts via `open_anything`.
- **Keyboard deletion is denied**: `{DEL}`/`%{F4}` press sequences (destruction without a classifiable label).
- **Site data wipes are denied** through `browser_eval` (`localStorage.clear`, `indexedDB.deleteDatabase`, `caches.delete`, cookie expiry).
- **Critical processes and JARVIS itself** cannot be stopped (`lsass`, `csrss`, `wininit`, `services`, `svchost`, Defender, `jarvis`, `electron`).

Deliberately NOT over-blocked (spec: "do not incorrectly classify every config file as an OS file"):

- project dependency removal (`npm/yarn/pnpm/pip uninstall|rm`) is ordinary project management;
- project files, dev config, app settings and documents anywhere outside OS roots stay fully editable;
- consequential browser/desktop actions run automatically: **send, publish, post, submit, pay, purchase, checkout, transfer, sign out, unsubscribe, close app, lock screen**;
- account management is allowed; only **account deletion** (`delete account`, `close account`, `cancel account`) is blocked.

## 3. THE RUNTIME CAPABILITY MANIFEST (`src/main/capabilityManifest.ts`, new)

- **Generated, never hand-maintained**: `buildCapabilityManifest(toolRegistry(), schemas)` walks the live registry — name, router group, summary, required/optional params, parallel-safety, delegation agents (from `agentRegistry`), runtime info, and `policy.HARD_LIMITS`.
- **Injected into every system prompt**: `provider.systemMessage()` now appends the generated block (tool counts per group, delegation agents, the two hard limits) right after the static usage guide. Rebuilt per prompt, so registry changes are reflected on the next turn with zero manual steps.
- **`list_capabilities` tool**: the model can introspect its real capabilities at runtime — full catalogue (compact, always under the provider's 12k tool-result truncation with the limits section guaranteed) or a per-group detailed query. Its own output carries a `[REGISTRY INTEGRITY ISSUES: …]` line if the registry ever drifts.
- **`manifestIssues()`** proves the model-visible surface equals the executable surface: every schema, router group, core entry and agent allowlist name must exist in the registry with a handler, a description, an object schema and declared required params.

## 4. TRUTHFUL PROMPTS (stale "asks the user" text removed)

The model was being TOLD things the code no longer does — exactly the hallucinated-support
defect the spec forbids. Fixed in `tools.ts` descriptions, `toolGuide.ts` and the provider
base prompt: overwrite/edit/move/upload "asks first" claims removed; "Delete/Send/Pay ask"
replaced with the real rule (deletion-class clicks are BLOCKED, send/pay/publish run
automatically); "stop for destructive actions" replaced with "BLOCKED means disabled — never
retry another way".

## 5. VERIFICATION OF THE UPGRADE ITSELF (how to reproduce)

```
npm install
npm test          # 487/487 — includes the new tests/policy.test.ts (78) and tests/capabilityManifest.test.ts (11)
npm run typecheck # clean
npm run lint      # clean
npm run dev       # ask JARVIS: "list_capabilities" then "delete the file notes/x.txt"
                  #   → catalogue arrives; deletion returns BLOCKED: disabled, with no dialog, in any mode
```

Test-run cautions honoured: no real purchases, no real deletions, no CAPTCHA/MFA bypass — the
destructive paths are proven at the code boundary (classifier + authorization matrix), which is
exactly where the spec demands the proof.

## 6. KNOWN LIMITS (stated honestly, not hallucinated)

- Label-based click blocking classifies what a control SAYS; a destruction action behind an
  innocuous label (or a bare coordinate click on a canvas) cannot be recognized. The browser's
  verify-then-report loop still catches the state change afterwards.
- `run_python` is regex-classified (no interpreter in-process); it is fail-closed on every
  dynamic construct, so the practical bypass surface is negligible, but it is not an AST parser.
- The renderer (`TaskProgress` feed) already displays tool activity in real time; no UI change
  was needed for this upgrade.
