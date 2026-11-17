# JARVIS — ROUND 20 SECURITY REPORT

**Scope.** The two hard restrictions — (A) no deletion of user data or resources, (B) no modification of OS-related files or resources — audited across every execution path: shell, PowerShell, Python, file tools, browser, desktop, agents, scheduler/background, recovery, and verification. The operating policy itself is unchanged: exactly two restrictions, no permission modes, no ask/read-only/autonomous modes, no approval dialogs, no risk-based confirmations, no new restrictions.

## 1. The policy, unchanged and centrally enforced

- `HARD_LIMITS` / `POLICY_STATEMENT` (`src/main/policy.ts`) are byte-identical to Round 19: consequential actions (send, publish, purchase, submit, install) run automatically; deletion and OS modification are hard blocks that cannot be overridden.
- The single gate (`permission.authorize`, called from exactly one place — the `runToolDetailed` choke point) is unchanged: `risk.block` → blocked; action class `delete` → denied for EVERY agent (`rule-denied` for children); everything else runs autonomously. `Effect` is still `'allow' | 'deny'` only — the type system forbids an ask effect; `currentAutonomy()` still returns the single `'autonomous'`.
- Web content, documents, agent reports and tool results remain untrusted data: pages are wrapped in UNTRUSTED banners, sub-agents are instructed and structured to treat fetched text as data, and nothing a page or a model output says can change a policy verdict (classifiers are code; there is no prompt-level policy surface).

## 2. Gaps found in the Round 19 audit and closed in Round 20

### 2.1 Symlink/junction bypass outside the file tools (HIGH — closed)
- **Previous:** `guard.classifyPathRisk` resolved symlinks for the file tools, but `shellVerdict` layer 3, `pythonVerdict`, `nodeVerdict` and the generic interpreter classifier matched path *literals* only. A workspace symlink into `C:\Windows` / `/etc` made `echo x > C:\ws\link\win.ini` an undetected OS write.
- **Now:** `realpathProtected()` (policy.ts) resolves the deepest existing anchor of every candidate path (16-hop cap, workspace-relative for relative targets) and is joined to the literal check in all four classifiers. A symlinked target into OS territory is blocked exactly like a direct write.
- **Tests:** `round20Policy.test.ts` — real `/etc` symlink: shell redirect, python `open()`, node `writeFileSync` (quoted + template-literal) all blocked with `kind: 'os-resource'`.

### 2.2 Interpreter-payload extraction seams (MEDIUM — closed)
- **Previous:** payload extraction required a command-boundary prefix (`^ & | ; (`) and whitespace after the flag. `cmd\npython -c "os.remove(…)"` (continuation line) and `python -c"os.remove(…)"` (attached quote) were invisible; node protected-literal scanning ignored template literals.
- **Now:** newlines count as boundaries; post-flag whitespace is optional; template literals join the literal scan for node and generic payloads.
- **Tests:** both shapes blocked end-to-end through `shellVerdict`; template-literal node payload blocked; benign payloads still allowed.

### 2.3 Finite deletion-name tripwire (MEDIUM — closed)
- **Previous:** only `delete|destroy|erase|wipe|purge|shred` names classified as delete; a future `unlink_file`/`truncate_log`/`empty_trash`/`uninstall_app` tool would have entered the registry as read.
- **Now:** the tripwire adds `unlink`, `truncate`, `uninstall`, `format` prefixes and `unlink|truncate|uninstall|empty_trash|empty_bin|erase` infixes — denied for main (`blocked`) and children (`rule-denied`) at the gate, independent of `assessRisk`.
- **Tests:** six destructive-shaped tool names denied for both agent classes.

### 2.4 Unclassified browser interactions (MEDIUM — narrowed)
- `browser_hover` now policy-classifies the target label before moving (hover can open menus leading to destructive items). Bare coordinate clicks (`click_at`, `browser_click_at`) remain **unclassifiable by name/URL** — this is the documented heuristic boundary; the mitigation is the unchanged label/URL classification on everything ref-based, the post-action re-observation, and the verifier's evidence checks. No new approval mechanism was introduced for them (that would violate the locked policy).

## 3. Route-by-route guarantee check (both restrictions)

| Route | Restriction A (deletion) | Restriction B (OS modification) |
|---|---|---|
| Shell (`run_command`) | DELETION_CMD layer catches rm/del/Remove-Item/format/diskpart/git clean --hard/reg delete/wevtutil cl/shutil.rmtree/… (npm/pip package-manager exemption preserved) | OS_CONFIG_CMD layer (bcdedit, reg add hk*, sc config, Set-Service, net user, pnputil, icacls, Set-MpPreference, shutdown, -EncodedCommand, iex pipelines) + write-verb × protected-path — **now with realpath closure** |
| PowerShell | same layers (one classifier for both shells) | same |
| Python (`run_python`) | PY_DENY_PATTERNS: os.remove/unlink/rmdir, shutil.rmtree, send2trash, .unlink( | protected-path literal × write-capable — **now with realpath closure**; eval/exec/importlib/ctypes fail closed |
| Node one-liners | NODE_DELETION (rmSync/unlink/fs.rm/rimraf) | protected literal (incl. backticks) × write APIs; eval/new Function fail closed; process.kill fail closed — **realpath closure added** |
| Perl/Ruby/PHP/Lua | GENERIC_DELETION fail-closed | ANY call touching a protected literal fails closed — **realpath closure added** |
| File tools | `apply_patch *** Delete File:` blocked at risk + gate; no delete/remove tools exist in the registry; deletion tooth denies the `delete` action class for every agent | symlink-aware classifyPathRisk (unchanged, still active) |
| Browser | destructive label + URL classifiers on click/click_text/hover; browser_eval storage/cookie wiping blocked | n/a (web content is not an OS resource; scheme gate on navigation) |
| Desktop | destructive click-label classifier on click_control/click_text | `press_keys` {DEL}/{F4} block retained; `close_app` refuses honestly |
| Agents (delegation) | deletion tooth returns `rule-denied` for children — **verified for the extended verb list** | children receive no delegation/control tools (SUBAGENT_DENIED enforced in schema layer); every child call re-enters the same choke point |
| Scheduler / background | scheduled turns dispatch through the same `runTool` choke point; no separate executor exists | same |
| Recovery (resume/reconcile) | recovery never re-runs a side effect: unknown outcomes are reconciled by inspection, non-idempotent tools never auto-repeat (idempotency classification fail-closed) | recovery writes only ledger records |
| Verification (`runCmd`) | policy.shellVerdict gates every verify command BEFORE spawning (tested: `rm -rf /etc` → BLOCKED, no process) | same classifier, same closure |

## 4. Prompt-injection containment

- Page text and fetched documents are injected with UNTRUSTED banners and shape-capped; sub-agent prompts state that returned text is data, not instructions; the capability manifest and schemas are generated from the registry, never from model output.
- A model cannot weaken policy: the classifiers are pure code; `authorize` has no approval callback; task statuses and verdicts are set only by engine code; the reviewer can only lower verification results.
- Delegation depth is structurally bounded at 1 (children receive no delegation schemas; `spawn_agent` also in NO_NEST; dynamic agents capped at 8 with TTL).

## 5. Credential and data hygiene

- No new secret storage was introduced; `settings.ts`/safeStorage behavior is unchanged. (Known pre-existing limitation, unchanged: the embeddings provider `apiKey` is stored plaintext in `brain/embeddings.json` — flagged in Round 19, still present, unchanged by Round 20 to avoid breaking user configs; recommended follow-up: safeStorage encryption.)
- Receipt/ledger records clip args and results (300/400 chars) and never store file contents.

## 6. What Round 20 did NOT change (deliberately)

- The two restrictions' wording, the autonomous single mode, the absence of any approval UI, and the package-manager deletion exemption (`npm unprompted` remains allowed as it deletes package-manager-internal caches, per the Round 17 policy decision).
- The documented heuristic boundary for bare coordinate clicks (mitigated as above, not "fixed" by adding confirmation prompts).

## 7. Verdict

Both hard restrictions are enforced at every execution path that can act, with the three Round 20 audit gaps closed and pinned by regression tests. No bypass through interpreter indirection, shell one-liners, symlinks, agent delegation, scheduled work, retries, or external prompt injection is known to remain; the residual documented limits (coordinate clicks, destructive POSTs behind neutral labels+URLs) are unchanged, explicit, and mitigated by observation-and-verification rather than by new approval modes.
