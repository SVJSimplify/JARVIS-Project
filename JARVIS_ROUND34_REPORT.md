# JARVIS ROUND 34 — RELEASE REPORT

## TRUSTED EXECUTION, COMPLETE PAYLOAD BINDING & SANDBOX VERIFICATION

**Baseline:** the actual Round 33 ZIP (`upload/JARVIS_ROUND33.zip`, SHA-256 verified against `JARVIS_ROUND33_SHA256.txt` before extraction — `sha256sum -c` exit 0). Round 34 is a **cumulative hardening round**: nothing was reset to an earlier round, no Round 31/32/33 capability was removed, and every fix was implemented by correcting the existing modules in place. The Phase 0 audit was performed against the SOURCE CODE (authoritative over the Round 33 report), and all ten mandated issues (plus one extra critical finding, K) were confirmed exactly where the mandate located them — none was already handled.

**Verification status of this release:** main-process typecheck **exit 0** (`tsc -p tsconfig.node.json --noEmit`), renderer/preload typecheck **exit 0** (`tsc -p tsconfig.app.json --noEmit`), targeted ESLint over all 10 changed/new files **0 errors / 0 warnings**, production builds **all exit 0** (renderer bundle 465.77 kB / gzip 157.49 kB; main compiles to `dist/main/*` including `shellIsolation.js`, `ipcTrust.js`; preload exit 0), `electron-builder --linux AppImage` **exit 0** (`release/JARVIS-1.0.0.AppImage`, 461,437,074 bytes, packaged from the final code). The **targeted functional check** (`scripts/round34FocusedCheck.ts`, the permitted small check) passes **136/136 assertions**; the Round 33 focused check passes **93/93** (updated where Round 34 deliberately changed the verified-bounded contract — see §3.1) and the Round 32 focused check passes **46/46 unchanged** as the regression baseline. Per the strict validation rules the **full Vitest suite was NOT run**; no new `tests/` files were created (the focused check lives in `scripts/`). §8 states exactly what was and was not verified.

**Environment note (important for Phase 2 honesty):** bubblewrap was NOT preinstalled in this build sandbox, but unprivileged user namespaces ARE enabled (`kernel.unprivileged_userns_clone=1`, `user.max_user_namespaces=462`), so a user-space **bwrap 0.9.0** binary was extracted from the Ubuntu archive (no root required) and used to verify the sandbox construction END-TO-END — for the first time in this project's history, the OS-sandbox pathway is verified by actual execution, not argv construction. All probe evidence in §5 comes from real runs.

---

## 1. EXECUTIVE SUMMARY

Round 34 closes the gaps a direct source audit found in the Round 33 implementation — the allowlisted-shell hole, the bubblewrap mount and probe weaknesses, the truncated browser payload fingerprint, the name-collision submitter bug, the exact-default-submitter gap, the `form.submit()` bypass, and the any-`file://`-URL IPC trust hole — without building a second anything:

- **Project-bound shell (Phase 1):** the verified-bounded pathway no longer treats "the executable's name is a dev tool" as safety. Commands are now classified in two tiers: **strictly safe** (pure inspection/filesystem tools and hook-free git subcommands whose complete behavior is statically establishable) and **sandbox-required** (node, python, npm, npx, interpreters, build tooling, workspace-local scripts — anything that executes code). Under the verified-bounded pathway the second tier REFUSES with an honest explanation; it executes ONLY inside the kernel-enforced OS sandbox. Single plain commands are executed through an explicit executable+argument array (never re-parsed by a shell). The command scanner handles or REFUSES every mandated syntax form — heredocs, subshells, process substitution, PowerShell call operators and script blocks, escaped separators, quoted paths, fd duplication, redirections, env indirection, command substitution, UNC and drive-letter paths.
- **Bubblewrap done right (Phase 2):** the mount construction guarantees the workspace destination parent chain INSIDE the namespace (explicit per-level tmpfs, no host user data exposed), binds the workspace at its canonical REAL path (symlinked roots handled deliberately), and keeps the Round 33 isolation properties (writable workspace, read-only toolchains, isolated tmp, die-with-parent, no other projects, no privilege). The capability probe now exercises the REAL construction — all eight mandated checks (namespace, toolchain, workspace source resolution, mount creation, write access, outside-workspace isolation, working-directory behavior, child inheritance) in one invocation against a temporary probe workspace — and a failed probe produces `verified-bounded`, never `os-sandbox`. A sandbox launch that fails at runtime is an explicit SANDBOX EXECUTION FAILURE: never retried outside the sandbox, never downgraded to unrestricted execution, visible in the Operations Center.
- **Browser payload binding (Phase 3):** form inspection is now browser-native and COMPLETE — `new FormData(form, submitter)` produces exactly what the browser would submit (disabled/fieldset-disabled/unchecked/multi-select/repeated-name/empty-value/file-metadata/`form`-attribute semantics, the actual submitter's contribution exactly once, image-submit coordinates). The 24-control and 200-character truncations are GONE; the only limits left are explicit refusal boundaries (5000 entries / 2 MB — hit ⇒ `limitExceeded` ⇒ consequential submission REFUSED, never partially fingerprinted). The fingerprint is an unambiguous JSON-pair canonicalization (no `name=value` delimiter collisions; field order and repeated names preserved) HMAC'd with the process-ephemeral secret, covering destination, method, complete payload with password values as keyed digests, file metadata, and the EXACT submitter identity — two submit buttons with identical labels/values are never the same target. The live re-verification before execution now covers the whole operation, and a changed default submitter invalidates the approval.
- **Submission pathway (Phase 4):** the `form.submit()` fallback is removed from EVERY JARVIS-controlled route (the native browser's programmatic submit and the in-app panel browser's submit helper). When `requestSubmit` is unavailable or throws, the submission is REFUSED and reported — never executed through a weaker mechanism that would bypass constraint validation and the submission events the approval was bound to. Post-submit browser state (URL/title) is captured as evidence; a successful API call is not proof of submission.
- **IPC trust (Phase 5):** packaged IPC validation now pins the EXACT bundled renderer resource (the same path `loadFile` uses, built with `pathToFileURL`, compared decoded and case-folded on Windows; query/fragment ignored for the SAME resource; any other `file://` path refuses). Development mode stays pinned to the configured dev server (no other localhost ports). The same validation now also protects `approval-list`. One trust implementation, every sensitive channel, refusals counted.
- **Operations Center (Phase 6):** the Gate tab shows the REAL mount-probe result (per step), the real project-bound refusal and sandbox-failure counters, the complete payload-binding/submitter/inspection-limit/submission-mechanism counters, submission-mechanism counters, pending/consumed approvals, and the IPC-trust mode with the exact trusted resource and refused-attempt counter. Every value comes from actual execution state.

All ten architecture invariants hold: one coordinator, one task lifecycle, one permission architecture, one tool pathway, one persistence model, one scheduler, one recovery architecture, one memory architecture, one approval authority, one context-assembly pathway.

---

## 2. ROUND 33 BASELINE AUDIT (Phase 0 — actual code, not the report)

The ZIP was extracted (329 files in the tree, matching the Round 33 manifest; tracked count 327) and every named module was read in full before any change. The confirmed issues, with the exact implementation locations and findings (full working record preserved at `docs/round34-phase0-audit.md`):

| # | Issue | Exact location in the Round 33 source | Audit finding |
|---|---|---|---|
| 1 | Allowlisted interpreters execute arbitrary code | `shellIsolation.ts:66-80` (`TOOLCHAIN`), `:328-341` (verifier) | **Confirmed.** `node -e`, `python -c`, `npm run`, `npm exec`, `npx <pkg>`, interpreters and hook-capable git subcommands passed the verifier with arbitrary arguments. |
| 2 | Tokenizer does not parse every redirection form | `shellIsolation.ts:211-249`, `:252-276`, `:319-327` | **Confirmed.** No backslash-escape handling; `& 'C:\run.ps1'` misparsed as a separator; unterminated quotes silently accepted; parens/braces/heredocs/`<>`/`>&` unhandled; only 4 redirection forms recognized. |
| 3 | Bubblewrap mount layout can fail for nested workspaces | `shellIsolation.ts:161-172` (`sandboxWrapperArgs`) | **Confirmed.** `--tmpfs /home` then `--bind` at the original absolute path; destination parents not guaranteed (relies on version-dependent bwrap dest creation); workspaces under non-mounted roots had NO mountpoint. |
| 4 | Capability probe does not validate the actual layout | `shellIsolation.ts:134-141` | **Confirmed.** Probe ran `bwrap --ro-bind / / --dev /dev --proc /proc /bin/true` — a ROOT-bind layout materially different from the runtime construction, with none of the eight mandated checks. |
| 5 | Payload inspection limited to 24 controls / 200 chars | `nativeBrowser.ts:1207` (`.slice(0,200)`), `:1229` (`.slice(0,24)`), `:1235` (`.slice(0,120)`), `:1518`, `:1718` | **Confirmed.** Silent truncation fed the security fingerprint. |
| 6 | Successful-control semantics incomplete | `nativeBrowser.ts:1203-1210` | **Confirmed.** `form.elements` filtered only by `!c.disabled` — unchecked checkboxes included with their attribute values, multi-select unresolved, disabled fieldsets unhandled, file metadata unbound, ALL enabled submit buttons included instead of the actual submitter, image coordinates absent, `form`-attribute association unhandled. |
| 7 | Submitter contribution omitted on name collision | `nativeBrowser.ts:1502-1507` (`effectivePayloadFields`), `:1307` (`payloadSummaryOf`) | **Confirmed.** `!fields.some((f) => f.name === s.name)` dropped the submitter's own contribution whenever any control shared its name. |
| 8 | Exact default submitter identity not bound | `nativeBrowser.ts:1233-1241`, `:1407-1408`; `approval.ts:247-263` | **Confirmed.** The submitter was captured without tag/id/position/duplicate signature; the intent carried only `submitterName` + `submitterOverrides`; identical-looking buttons were indistinguishable for the implicit/Enter route. |
| 9 | `form.submit()` fallback bypasses validation/events | `nativeBrowser.ts:1847`; same pattern `browser.ts:313` | **Confirmed.** `catch { f.submit(); return 'ok-fallback'; }` and `f.requestSubmit ? f.requestSubmit() : f.submit()` (the latter additionally swallowed by `.catch(() => undefined)`). |
| 10 | Packaged IPC accepts any `file://` URL | `ipcTrust.ts:42-48`, `:50-58`; ungated channel `index.ts:513` | **Confirmed.** `originMatches` checked only `u.protocol === 'file:'`; `approval-list` had NO sender validation. |
| **K** | **EXTRA (critical, found during audit): the OS-sandbox argv never contained the bwrap executable** | `shellIsolation.ts:162` returned `['--die-with-parent', …]`; `devTools.ts:70-73` treated `argvPrefix[0]` as the EXECUTABLE | **Confirmed.** Every OS-sandbox execution would have spawned `--die-with-parent` and failed with `exit ENOENT`. Never caught because bwrap was unavailable in the Round 33 sandbox (declared honestly in the R33 report §8). Fixed: `sandboxWrapperArgs` now returns the full argv starting with `bwrap`. |

**GATE 0 satisfied** — findings recorded (this section and `docs/round34-phase0-audit.md`) before implementation began.

**Round 31/32/33 functionality verified present before starting** and preserved: native CDP browser pipeline, exact-DOM-identity approvals, fail-closed grant/consume audit, per-request serialization, shared approval gate, native main-process confirmation, secure credentials (safeStorage, outside the workspace), official deploy-hook endpoint validation, durable workflow journal + playbooks, task↔workspace binding at the resolvers, two-sided `resolveRead` containment + read/write TOCTOU revalidation, centralized redaction, corrupt-audit/journal quarantine with recovery markers, native-dialog watchdog, project-scoped memory, impact analysis, context budgeting, standing-instruction priority, Operations Center — all confirmed in source and regression-checked (§7).

---

## 3. PHASE-BY-PHASE IMPLEMENTATION

### Phase 1 — Project-Bound Shell Execution That Is Actually Safe (COMPLETE)

- **§1.1 Two-tier contract (`shellIsolation.ts` rewritten in place).** The old `TOOLCHAIN` allowlist is replaced by a FIXED classification:
  - `SAFE_ANYWHERE` (contract A — strictly safe): pure inspection (`ls cat head tail wc diff sort uniq pwd echo printf rg grep file stat du df tree which whoami hostname date sleep`, `tsc` as a deterministic compiler) and filesystem operations (`mkdir rmdir touch cp mv rm`), plus the PowerShell read-only/filesystem cmdlets and aliases — every member never executes code, runs hooks, or loads executable configuration; arguments and redirection targets are still path-verified inside the workspace.
  - `SAFE_GIT_SUBCOMMANDS`: the hook-free git subcommands (`status log diff show branch tag remote rev-parse blame describe shortlog ls-files check-ignore config init add clean stash ls-remote help version`). `git commit/push/merge/rebase/checkout/...` (hooks, credential helpers) is sandbox-required.
  - `SANDBOX_REQUIRED_TOOLS` + fail-closed default (contract C): node/npm/npx/pnpm/yarn/tsx/ts-node/vite/esbuild/python/pip/make/cmake/cargo/rustc/go/java/gradle/mvn/dotnet/gcc/clang, shell interpreters (`sh bash zsh dash ksh fish powershell pwsh cmd`), PowerShell execution surfaces — and EVERY unknown executable — refuses under verified-bounded with an explanation of what could not be verified and what the legitimate alternatives are (install bubblewrap, or run as non-project work). Workspace-local scripts/executables (contract B) refuse under verified-bounded for the same reason and execute under the sandbox tier.
  - `find`'s `-exec/-execdir/-ok/-okdir/-fprintf/-fprint/-fprint0` primaries and the `iex/invoke-expression/start-process/…` launcher family refuse in BOTH modes (a sandbox has no business launching them for project work); privilege elevation (`sudo/doas/runas/gsudo`) refuses in BOTH modes.
  - The env/command-substitution indirection refusal is RESTORED as a first-class gate under verified-bounded (the audit found the rewrite initially skipped it — a token like `$HOME/x` is expanded by the SHELL at runtime, so `git status $HOME/evil.js` would have slipped through; it now refuses before classification).
- **§1.2 Scanner redesign (handle-or-refuse).** `splitSegments` + `tokenizeSegment` now: resolve quotes (unterminated ⇒ refuse); treat backslash escapes conservatively (the backslash is KEPT — `..\/out` stays path-like, `\;` is not a separator, Windows-style paths stay visible on POSIX); recognize `> >> 2> 2>> < &> >&` with targets and fd-duplication `2>&1/1>&2/>&2`; REFUSE heredocs/herestrings (`<<`/`<<<`), `<>`, subshell parens, process substitution (`<(`, `>(`, parens inside redirection operands), brace syntax (PowerShell script blocks / brace expansion), redirection with no target, and the PowerShell call operator is HANDLED (`& 'C:\x.ps1'` makes the next token the executable — classified like any script) instead of misparsed as a separator; `;`, newline, `|`, `||`, `|&`, `&&` and background `&` remain segment separators (each segment independently verified; `curl … | sh` refuses because the second segment is an interpreter). Unsupported syntax is ALWAYS a refusal — the safest outcome for what cannot be parsed.
- **§1.2 Explicit argv (preferred over shell strings).** For a single plain segment (no redirection/pipes/call operator), the scanner has already produced the exact executable + argument array, and `devTools.runShell` executes THAT via `execFile` — no shell parser involved at runtime. PowerShell cmdlets never claim direct argv (they need the PowerShell host); anything with redirection/pipes runs through the (verified) shell string inside the same boundary.
- **§1.3 Genuine OS-sandbox capability contract.** Code-executing toolchains and workspace-local scripts are permitted ONLY when `capability.mode === 'os-sandbox'` — i.e., only after the Phase 2 probe passed. The verifier takes the measured mode as its default and accepts an explicit mode (used by the focused check to pin both tiers). Under the sandbox tier the KERNEL is the filesystem boundary, so shell syntax and env indirection are permitted inside the namespace; elevation and launchers still refuse. Verified-bounded executions are described exactly as what they are (`boundedPathwayNote`), never as "sandboxed". Non-project shell behavior is unchanged, byte for byte (regression-verified: Round 33 check §12 and Round 32 check §5).

**GATE 1 satisfied:** no project-bound command gains unrestricted filesystem access merely because its executable name appeared on an allowlist — under verified-bounded the safe set contains nothing that executes code, and under the sandbox tier the kernel, not a name list, bounds the filesystem.

### Phase 2 — Bubblewrap Mount Construction and the REAL Probe (COMPLETE)

- **§2.1 Correct workspace mount ordering (`sandboxWrapperArgs` rewritten).** The construction is now:
  1. `bwrap --die-with-parent --unshare-ipc --proc /proc --dev /dev` (fixes audit finding K: the executable is FIRST);
  2. `--tmpfs /tmp --tmpfs /home --tmpfs /run` (isolated temp; host user data under /home NOT mounted);
  3. selective `--ro-bind` for the toolchain dirs that exist (`/usr /bin /sbin /lib /lib32 /lib64 /etc /opt /nix`);
  4. **explicit per-level destination construction:** every proper ancestor of the workspace's canonical REAL path that is not already covered by the mounts above gets its own EMPTY `--tmpfs` (shallow→deep) — so the workspace destination parent chain EXISTS inside the namespace on every bubblewrap version, for workspaces nested under a tmpfs-replaced directory (`/home/user/...`) and for workspaces outside the mounted system roots (`/srv/...`, `/data/...`), WITHOUT exposing the host directories that live there;
  5. `--bind <real> <real> --chdir <cwdReal>` — the workspace at its canonical real path (deliberate symlink handling: `sandboxWrapperArgs` realpaths its argument itself, so a symlinked workspace root is never bound through the link and the link's parent tree is never exposed), and the cwd resolved to its real path by `devTools.projectBoundShell` before the call.
  Preserved properties: workspace writable; toolchains read-only; temp isolated; `--die-with-parent`; no other projects mounted; no privilege flags. Empirically verified (§5): deep bind under tmpfs-replaced `/tmp`, isolation of host `/tmp` and host HOME, write access, symlinked roots, child inheritance.
- **§2.2 The REAL capability probe.** `probeShellIsolation` now: finds bwrap via fixed candidates and PATH (`bwrap --version`); creates a temporary probe workspace OUTSIDE the user's project data (`mkdtemp` under the OS temp dir, deliberately DEEP: `probe-home/probe-user/probe-ws` — nested under the tmpfs-replaced `/tmp`, exactly the layout that broke the Round 33 construction); builds the wrapper args with the SAME `sandboxWrapperArgs` the runtime uses; and runs ONE invocation that verifies all eight mandated checks with distinct exit codes — namespace creation, toolchain availability, workspace source resolution (host-side), workspace mount creation, workspace write access, outside-workspace isolation (the sibling host marker AND the host home must be invisible), working-directory behavior (`pwd -P` equals the probe workspace), child-process inheritance (`/bin/sh -c` inside). Probe resources are cleaned up (`rm -rf`, `finally`). The per-step result is stored in the capability (`probe.passed`, `probe.steps`) and surfaced in the Operations Center. **A failed probe produces `verified-bounded`, never `os-sandbox`, with the failed step named in the warning.**
- **§2.3 Runtime fallback removed.** `runShell` classifies sandbox-launch failures (spawn-level errors — e.g. ENOENT when bwrap vanished between probe and run — and bwrap's own diagnostics, which always carry the `bwrap:` stderr prefix) and REJECTS with an explicit `SANDBOX EXECUTION FAILURE` stating that the command was NOT executed, its outcome is UNKNOWN, and there is no fallback to unrestricted execution. A command that merely exits nonzero INSIDE the sandbox is a normal command failure and is reported with its exit code as before. The started-receipt and execution-outcome semantics are unchanged (the receipt is written by `runTool` before the tool runs; the refusal lands as the recorded failure). The failure is counted (`noteSandboxFailure`) and shown in the Operations Center.

**GATE 2 satisfied:** JARVIS reports OS-sandbox capability only after the actual mount layout and isolation behavior were validated by execution — on this machine, with real bwrap runs (§5); on machines where the probe cannot pass, the honest warning says exactly what is and is not guaranteed.

### Phase 3 — Complete Browser Payload Binding (COMPLETE)

The existing native browser architecture (CDP sessions, background operation, target identity, shared approval gate, native confirmation, keyed digests) is preserved; nothing replaced, no second engine.

- **§3.1 No silent truncation.** `FORM_INSPECT_JS` (now exported for the focused check) collects the COMPLETE successful-control payload — no `.slice(0, 24)`, no `.slice(0, 200)`, no submitter-value limit. Explicit limits exist ONLY as a refusal boundary (5000 entries or 2 MB serialized): hitting one sets `limitExceeded`/`inspectionComplete: false`, and EVERY consequential route (click planned, type planned, live re-check, post-approval re-check) refuses with an `INSPECTION LIMIT` error and bumps the real `inspectionLimitRefusals` counter — the payload is never partially fingerprinted and claimed complete. Display summaries (`payloadSummaryOf`) remain bounded and are now explicitly display-only ("(+N more, complete payload bound by the fingerprint)").
- **§3.2 Successful-control semantics, browser-native.** The payload is collected with `new FormData(form, submitter)` (the browser's own definition of what a submission sends), with a `FormData(form)` fallback that manually appends the actual submitter's contribution when the two-argument constructor is unavailable. Verified in jsdom (§7): disabled-fieldset controls omitted; unchecked checkboxes omitted, checked included; select-multiple contributes only selected options; repeated names preserved as repeated entries; empty values preserved; textareas exact (newlines); file inputs contribute METADATA (`fileName (size bytes, type)` — never contents) and an empty selection contributes nothing; controls associated through the `form` attribute (including outside the DOM subtree) included; the ACTUAL submitter's name/value included exactly once (the other submit buttons omitted); image submitters bind `name.x`/`name.y` with the coordinates the synthesized `element.click()` actually produces. Password values are returned to the MAIN process for keyed-digest binding (kind `password`) and never stored, logged, echoed in summaries, or written to any durable surface.
- **§3.3 Every submitter bound independently.** The submitter is captured with its exact stable DOM identity: tag, id, name, type, value, `formaction`, `formmethod`, `formnovalidate`, `formtarget`, structural position, duplicate-signature count — serialized by `submitterIdentityOf` into both the approval intent (`submitterValue/Type/FormNovalidate/FormTarget/Identity`) and the payload fingerprint. Two submit buttons with identical labels or values produce DIFFERENT identities (verified). For implicit Enter submission the default submit control is identified (`DEFAULT_SUBMITTER_JS`) and its identity is RE-DERIVED from the live page immediately before execution — a changed default submitter changes the fingerprint and refuses with a distinct `submitterMismatch` counter bump.
- **§3.4 Unambiguous canonicalization.** `payloadFingerprintOf(fields, destination, method, submitterIdentity)` canonicalizes as a JSON structure — `{d, m, s, f: [[name, value], …]}` — instead of `\u0000`-joined `name=value` strings. JSON escapes control characters, so the pairing is collision-free (the old scheme made `x`/`y=z` and `x=y`/`z` identical; now they differ — verified), field order and repeated names survive exactly, and the exact submitter identity participates. The digest stays HMAC-SHA256 under the process-ephemeral secret; password entries are replaced by `keyedValueDigest(name, value)` inside `effectivePayloadFields` (raw values never enter any canonical form); file metadata participates through its deterministic description. Raw payloads are never stored in the approval audit (audit entries carry masked summaries only — unchanged).
- **§3.5 The entire live payload verified.** Before any JARVIS-controlled submission executes: the owning form is re-inspected with the SAME submitter derivation, the complete live payload recomputed, live sensitive values re-digested (for a password the FULL live value is read back and digested — never echoed), the exact target identity re-derived, and the whole thing compared against the approved plan; a partial match does not pass, and inspection failure refuses. Changing destination, method, submitter, or any payload value after approval invalidates the approval (fingerprint fields all participate).

**GATE 3 satisfied:** every JARVIS-controlled consequential submission is approved for the complete effective payload and the exact submitter.

### Phase 4 — No Unapproved Submission Pathways (COMPLETE)

- `nativeBrowser.ts` type route: the submit snippet is now `requestSubmit`-ONLY — `typeof f.requestSubmit !== 'function'` returns `mechanism-unavailable` and a caught `requestSubmit` exception returns `mechanism-refused: …`; both refuse the submission with an explicit `SUBMISSION REFUSED` error naming the approved mechanism and stating that NO alternative was invoked (the raw `form.submit()` would skip constraint validation and fire no submit events — a DIFFERENT operation than the one approved). `noform`/`busy` (double-invocation guard) refuse as well; every mechanism failure bumps the real `submissionMechanismFailures` counter. `f.submit()` and `ok-fallback` no longer exist in the file (source-verified).
- `browser.ts` (in-app panel browser): `submitForm()` uses `requestSubmit()` only, returns the refusal as a surfaced note at both call sites (`browser_type`, `browser_fill_form`) — the error is no longer swallowed by `.catch(() => undefined)`.
- The click route submits through the browser's own activation behavior (`element.click()` on the approved control) — the normal submission pathway, unchanged.
- After the mechanism succeeds, the ACTUAL resulting browser state is verified: load event wait + post-submit URL/title captured into the result note ("submission is not success" semantics preserved and strengthened).
- If an exceptional mechanism were ever necessary, it would have to be a separately classified and authorized operation — none exists; there is no automatic downgrade anywhere.

**GATE 4 satisfied:** a failure in the approved submission pathway never triggers an unapproved alternative.

### Phase 5 — Exact Packaged IPC Resource Validation (COMPLETE)

`ipcTrust.ts` remains THE single trust authority (rewritten in place; no second implementation):

- **§5.1 Packaged:** `trustedPackagedRenderer(rendererEntryPath)` builds the expected resource with `url.pathToFileURL` (handles URL encoding and Windows drive-letter normalization) from the SAME path `createWindow()`'s `loadFile` uses (`index.ts` derives both from one `RENDERER_ENTRY_PATH` constant, so trust and actual resource can never drift). `urlIsTrustedRenderer` requires protocol `file:`, an empty (or `localhost`) host, and DECODED-pathname equality — case-folded on win32, backslashes folded — i.e. the EXACT bundled entry. Query and fragment are ignored (the SAME resource; navigation state lives there) — any other local file (`/etc/passwd`, a sibling HTML file, another asar layout), any http(s) URL, and any foreign-host file URL REFUSE. Navigation after load is covered because the frame's and webContents' CURRENT URLs are validated on every event; child frames, missing senderFrames, unreadable URLs, destroyed senders and unexpected windows keep the Round 33 fail-closed refusals.
- **§5.2 Development:** `trustedDevelopmentOrigin()` pins the configured dev server (`http://localhost:5173`) by exact protocol+host — another localhost port or a foreign origin refuses (verified).
- **§5.3 Applied consistently:** the SAME `assertTrustedApprovalSender` gate now protects `approval-list` (added), `approval-respond`, `approval-dismiss`, `credentials-info/set/test/revoke`. One implementation, zero duplicates. Refusals are counted at the real site (`noteIpcTrustRefusal`) with the channel name, exposed through `ipcTrustHealth()`.

**GATE 5 satisfied:** only the exact trusted JARVIS renderer resource may invoke sensitive IPC operations.

### Phase 6 — Operations Center Accuracy (COMPLETE)

The existing Gate tab design is preserved and extended, every value from real state (`opsCenter.opsOverview`):

- **Shell execution:** the measured capability (mode, mechanism, probed) PLUS `probePassed`, the per-step probe results (each step with ok/detail), and the real `refusedCommands` / `sandboxFailures` counters (incremented at the actual gate/launcher sites in `devTools`). The why of each refusal is the tool error itself (model-visible and recorded in the receipts); "failed before execution / unknown outcome" is exactly what the `SANDBOX EXECUTION FAILURE` message and receipt semantics state.
- **Browser approval:** full inspection state (inspection-limit refusals), payload-completeness statement, submitter-identity verification (`submitterMismatch` refusals), payload-mismatch refusals (`targetOrPayloadMismatch`), submission-mechanism failures, and pending vs consumed vs executed approvals (`pendingApprovals`, `nativeOpen`, `consumedApprovals` — the new `approvalConsumedCount()` projection — and `approvedSubmissions`).
- **IPC trust:** a new section with the validation mode (packaged/development), the EXACT expected renderer resource, and the refused-attempt counter with the last refusal detail.
- No invented percentages, no fake sandbox status, no decorative counters — every number is incremented at an enforcement/refusal/redaction site or read from live records.

### Phase 7 — Architecture Preserved (COMPLETE)

No second coordinator, scheduler, memory database, approval service, browser engine, or shell execution pathway was created. `shellIsolation.ts` (still the ONE project-bound shell module, downstream of the policy classifier), `ipcTrust.ts` (still THE sender-trust check), `approval.ts` (still the one approval authority — only its fingerprint canonicalization and intent shape were extended) — and `browser.ts`'s one-line-mechanism fix are all corrections inside the existing architecture. All ten invariants hold. The removed-file count is zero.

---

## 4. ADDED, MODIFIED, AND REMOVED FILES

Produced by the project's own `scripts/releaseManifest.mjs` (SHA-256 per file) against the actual `upload/JARVIS_ROUND33.zip`:

```
ADDED (2):     docs/round34-phase0-audit.md, scripts/round34FocusedCheck.ts
MODIFIED (10): scripts/round33FocusedCheck.ts, src/main/approval.ts, src/main/browser.ts,
               src/main/devTools.ts, src/main/index.ts, src/main/ipcTrust.ts,
               src/main/nativeBrowser.ts, src/main/opsCenter.ts, src/main/shellIsolation.ts,
               src/renderer/components/OperationsPanel.tsx
REMOVED (0):   —
Tracked:       331 files (161 src + 97 tests + docs/scripts); the release ZIP additionally
               carries the round reports, per the Round 33 packaging convention.
```

---

## 5. SHELL-ISOLATION BEHAVIOR BY PLATFORM AND ACTUAL PROBE RESULTS

**Behavior by platform:**

| Platform | Level | What executes | What refuses |
|---|---|---|---|
| **Linux (bubblewrap installed, user namespaces enabled, probe PASSED)** | `os-sandbox` — kernel mount namespace | Everything the kernel bounds to the workspace: toolchains, scripts, shell syntax, env indirection — the workspace is the only writable mount; other user data is not mounted; `/tmp` is an isolated tmpfs; the process dies with its parent; no privileges. | Privilege elevation; the launcher family (`iex`, `start-process`, …). |
| **Linux (probe failed — e.g. namespaces disabled)** | `verified-bounded` | Only strictly-safe inspection/filesystem commands and hook-free git subcommands with verified in-project targets. | Every code-executing tool, every unverifiable construct, every outside path — with the failed probe step named in the Operations Center warning. |
| **Windows** | `verified-bounded` | The same strict set (PowerShell host, cmdlet allowlist, literal-backslash scanning). | Everything else — honestly warned in the Operations Center (no portable OS sandbox is reachable from Node without native modules). |
| **macOS** | `verified-bounded` | The same strict set (sh host on POSIX rules). | Everything else (sandbox-exec deprecated; stated, not faked). |
| **Non-project work (any platform)** | unchanged | Byte-for-byte Round 33 behavior. | — |

**ACTUAL probe results in THIS build environment** (bwrap 0.9.0, unprivileged user namespaces enabled; probe workspace = deep `probe-home/probe-user/probe-ws` under the OS temp dir, cleaned up):

```
mode: "os-sandbox"
mechanism: "bubblewrap mount namespace (REAL mount-layout probe passed: workspace bind,
            write access, isolation, cwd, child inheritance)"
probe.passed: true — all 8 steps ok:
  1 namespace-creation            ok
  2 toolchain-availability        ok
  3 workspace-source-resolution   ok
  4 workspace-mount-creation      ok
  5 workspace-write-access        ok
  6 outside-workspace-isolation   ok   (host /tmp marker AND host home invisible)
  7 working-directory-behavior    ok   (pwd -P == probe workspace)
  8 child-process-inheritance     ok   (/bin/sh -c child sees the namespace)
```

Additional END-TO-END execution checks run in this environment (focused check [5]): a real command executed through `sandboxWrapperArgs` confirmed — workspace writable (`touch` inside), workspace content readable, the host marker file outside the workspace INVISIBLE, the host home directory INVISIBLE, `pwd -P` correct, and a `/bin/sh -c` child inheriting the namespace. Direct construction experiments also confirmed the per-level tmpfs construction and the real-path binding of a symlinked workspace root. On machines WITHOUT bubblewrap the probe honestly reports `verified-bounded` (this is the exact behavior the focused check asserts when the binary is absent).

**Shell-isolation residuals (stated, not hidden):** (a) under the sandbox tier, network egress is not unshared (unchanged Round 33 residual — it remains the permission layer's concern); (b) under verified-bounded, `tsc` is trusted as a deterministic compiler — a hostile `tsconfig.json` inside the project can shape compiler output but cannot execute code; (c) the sandbox mounts only the toolchain dirs that exist on the target machine (probed per directory); exotic prefixes outside the mounted set fail visibly inside the sandbox; (d) the verifier's safe-set classification is intentionally conservative — commands like `git fetch` or `npm ls` refuse under verified-bounded even though they are likely harmless, because their semantics are not statically establishable under the fixed contract.

---

## 6. BROWSER PAYLOAD-BINDING, SUBMISSION AND IPC BEHAVIOR

**Payload binding:** planned and live fingerprints now cover destination + method + submitter identity + the COMPLETE browser-native successful-control payload (order and repetition exact), with password values bound as process-ephemeral keyed digests and file uploads bound by metadata. Display summaries mask (hidden `[hidden value withheld]`, password `[masked]`, card digits masked, e-mails elided, file metadata shown) and never leak sensitive values (verified). Approval cards and the native dialog keep the masked summary; audit entries never carry raw payloads.

**Submission:** every JARVIS-controlled route — submit-button click (native activation), typed submission (requestSubmit with the inspected default submitter), implicit/Enter route (same submitter derivation re-derived live) — runs the same pipeline: inspect → plan → approve (card + native dialog) → consume single-use → type (if applicable) → re-inspect the COMPLETE live payload → compare the full fingerprint → submit exactly once through `requestSubmit` ONLY → capture post-submit URL/title. Mechanism unavailability/failure refuses; nothing downgrades.

**IPC trust:** packaged mode validates the exact `dist/renderer/index.html` inside the app bundle (decoded, case-folded where applicable; same-resource query/fragment tolerated; any other local path refuses); development mode validates the exact configured dev origin. All seven sensitive channels (approval list/respond/dismiss + credentials info/set/test/revoke) enforce it; refusals are counted and displayed.

---

## 7. VALIDATION COMMANDS AND ACTUAL EXIT CODES

| Check | Command | Result |
|---|---|---|
| Baseline integrity | `sha256sum -c JARVIS_ROUND33_SHA256.txt` (in `upload/`) | exit 0 — both artifacts match |
| Main-process typecheck | `npx tsc -p tsconfig.node.json --noEmit` | **exit 0** (run after all phases) |
| Renderer/preload/app typecheck | `npx tsc -p tsconfig.app.json --noEmit` | **exit 0** |
| Syntax validation | covered by both tsc configs (TS1xxx diagnostics) + all production builds compiling the same sources | pass |
| Targeted ESLint (10 changed/new files) | `npx eslint <files>` | **0 errors / 0 warnings** (three findings fixed during the round, including the restored env-indirection gate) |
| Renderer build | `npm run build:renderer` | exit 0 — bundle 465.77 kB (gzip 157.49 kB) |
| Main build | `npm run build:main` | exit 0 (`dist/main/shellIsolation.js`, `ipcTrust.js` confirmed present) |
| Preload build | `npm run build:preload` | exit 0 |
| Packaging | `npx electron-builder --linux AppImage` | exit 0 — `release/JARVIS-1.0.0.AppImage` (461,437,074 bytes) from the final code |
| Targeted functional check (permitted) | `npx tsx scripts/round34FocusedCheck.ts` | **136 passed / 0 failed** — [1] two-tier contract refusals + tier-1 allowances + path verification (26 assertions); [2] scanner: redirections/fd-dup/pipes/escaped separators/quoted paths + refusals (heredoc, herestring, subshell, process substitution, braces, `$(…)`, `${…}`, `$VAR`, `%VAR%`, `$env:`, backticks, unterminated quote, PS call operator, launcher, pipe-to-interpreter) + direct-argv construction (22); [3] sandbox-tier permissions + elevation/launcher refusals (8); [4] mount construction incl. finding K fix, per-level parents, real-path binding (11); [5] REAL probe + end-to-end sandbox execution (7); [6] complete payload inspection in jsdom: no truncation, full successful-control semantics, image coordinates, limit refusal (19); [7] canonicalization collisions/order/repetition/submitter identity + masking (10); [8] no `form.submit()` fallback in EITHER browser module + mechanism-refusal surfacing (7); [9] exact packaged resource + dev pinning + fail-closed frames + refusal counting (18); [10] real counters (4) |
| Round 33 regression check | `npx tsx scripts/round33FocusedCheck.ts` | **93 passed / 0 failed** (was 92; block [3] now pins the STRICT verified-bounded layer explicitly — the five toolchain "allowed" assertions from Round 33 became the mandated refusals, and one `npm run` case joined them — and block [8] targets the new exact-resource API while keeping every fail-closed assertion; all other blocks unchanged) |
| Round 32 regression check | `npx tsx scripts/round32FocusedCheck.ts` | **46 passed / 0 failed** (unchanged baseline) |
| Release manifest | `node scripts/releaseManifest.mjs upload/JARVIS_ROUND33.zip .` | **ADDED 2, MODIFIED 10, REMOVED 0** — 331 tracked files |

---

## 8. EXPLICITLY UNTESTED FUNCTIONALITY

- The **full Vitest suite (1,309 tests across 97 files) was NOT run** — exactly as instructed; no existing test was updated and no new `tests/` files were created. Behavior notes for that suite, declared not run: (1) `verifyBoundedCommand` refusals are now two-tier — tests pinning Round 33's "npm run is allowed" behavior will fail (the change is mandated); (2) `payloadFingerprintOf` values changed (unambiguous canonicalization) — tests pinning literal digest hex will fail (in-memory approvals die with the process, so no durable data depends on the old digests); (3) the approval intent's `form` block carries five new optional fields (old-shape intents still construct and validate); (4) `FormInspection.payload` entries carry optional `kind` (old-shape objects still work in the classifier and summary); (5) `senderIsTrustedAppFrame`'s `expected` is now a `TrustedRendererSpec` (tests passing origin strings would need the new constructors); (6) `sandboxWrapperArgs` returns the bwrap executable first (any test pinning the argv to start with `--die-with-parent` will fail — that pinned behavior was the finding-K bug); (7) `opsOverview` gained `boundaries.shellIsolation.probePassed/probeSteps/refusedCommands/sandboxFailures`, extended `browserSecurity` counters, and the `ipcTrust` section.
- **No live browser session, live LLM planning round, live GitHub/Vercel call, or Electron runtime smoke test was performed** — none is possible in this Linux build sandbox; live-model and live-service paths are exercised only by typecheck/build here.
- **Windows desktop execution** (PowerShell OCR/UIA layer) and **Windows NSIS packaging** remain unverifiable here; no Round 34 change touches the desktop judgment layer. The bounded-shell verifier's Windows-specific behaviors (PowerShell cmdlet classification, literal-backslash scanning, drive-letter/UNC refusals) are exercised through the platform-agnostic verifier logic with win32-specific branches reviewed, not executed on Windows.
- **Live browser form-inspection v3 was verified in jsdom, not against a live Chromium page.** The page-side inspection JS is the SAME string the runtime evaluates; jsdom's FormData/File implementations follow the HTML spec, but a real-Chromium differential pass was not possible here. The Round 33 behavioral guarantees around it (approval timing, single-use consumption, live comparison) are regression-verified through the R33/R32 focused checks.
- **Windows file-URL IPC validation is logic-reviewed, not run on Windows:** `pathToFileURL` drive-letter handling and the win32 case-folding comparison are exercised on POSIX with POSIX paths; the win32 folds are covered by construction and code review only.
- The **native confirmation dialog** itself was not exercised in a running Electron shell (unchanged from Round 33); its grant semantics remain verified through the injected-presenter contract.
- **bubblewrap end-to-end WAS exercised in this environment** (unlike Round 33) — but only with the user-space bwrap 0.9.0 binary on a Linux kernel with unprivileged namespaces; a distribution-packaged setuid bwrap or a userns-disabled machine follows the fail-closed probe path (verified by construction, not by a live disabled-namespace run — the failed-probe branch's per-step reporting is covered by the code path that maps the probe's distinct exit codes).

---

## 9. KNOWN LIMITATIONS AND PLATFORM-SPECIFIC NOTES

1. **The verified-bounded pathway is intentionally restrictive.** `npm install`, `npm run`, `npx anything`, `node script.js`, `python -c`, shell interpreters and every unknown executable REFUSE when no OS sandbox is active — that is the mandate (genuine guarantees over convenience), and the refusal message says exactly why and what the alternatives are (install bubblewrap; run the work as non-project work). The Operations Center counter makes the refusal volume visible.
2. **The verification engine (`verifyExec.ts`) retains its Round 33 scope.** Its autonomous verification commands (`npx tsc`, `npm test`, …) run under the existing policy classification + receipt lifecycle and are NOT gated by the project-bound shell verifier — gating them would have broken the Round 31-33 autonomous workflows (the verified-PR playbook requires verification) and was outside the audited module set. This is the largest honest residual of the round: within a project-bound task, the verifier's own commands are policy-checked but not tier-classified.
3. **The strict real-path refusal can affect unusual filesystems** (unchanged Round 33 residual): a workspace on a filesystem where `realpath` fails with EACCES/EPERM on intermediate components refuses the operation (fail-closed by design).
4. **Post-typing payload re-checks can refuse on legitimately dynamic forms** (unchanged): a page script mutating values between approval and submission (timestamps, rotating tokens) causes a refusal and a fresh approval — the fail-safe direction.
5. **Quarantined audit/journal files accumulate until the operator archives them** (unchanged).
6. **Redaction remains pattern-based** (unchanged): new secret shapes have exactly ONE place to add (`redact.ts`).
7. **`tsc` trust:** a project's `tsconfig.json` can direct compiler output paths; tsc cannot execute arbitrary code, and explicit path arguments remain verified, but emitted output locations come from the project's own config — consistent with the workspace being the task's own domain.
8. **The explicit per-level tmpfs construction adds one tmpfs per uncovered workspace ancestor** — harmless (empty mounts) and version-independent; on bubblewrap versions that also auto-create destination parents, the explicit mounts are redundant but keep the guarantee.
9. **`sandboxWrapperArgs` mounts the probe/runtime workspace at its REAL path** — a task whose working directory is reached through a symlinked root gets its cwd re-resolved to the real path before the sandbox invocation (deliberate, documented); the displayed workspace path remains the brief's path.
10. Everything Round 33 stated as a limitation that Round 34 did not touch remains: workspace bindings are in-memory per process (re-bound from the durable brief at resume); project-scope matching is word-boundary over the registry; deploy-hook validation pins the official endpoint shape; page-initiated network requests from untrusted page JavaScript are not universally interceptable (the Operations Center states this).

---

## 10. DEFERRED FUNCTIONALITY

Unchanged from Round 33: per-tab CDP download overrides; OCR/UIA on macOS/Linux; a model-refinement pass for deterministic classifiers; persistent import-graph caching; an approval-decision UI beyond the card + native dialog; credential rotation reminders; OAuth-style integration flows; Vercel env/project mutation; GitHub API branch/commit writes (authorized local git via `run_command` under the sandbox tier). Nothing new was deferred by Round 34; every mandated item was implemented or its impossibility stated.

---

## 11. ACCURATE RELEASE MANIFEST AGAINST THE ACTUAL ROUND 33 ZIP

Produced by the project's own `scripts/releaseManifest.mjs` (SHA-256 per file) against `upload/JARVIS_ROUND33.zip`:

```
ADDED (2):     docs/round34-phase0-audit.md, scripts/round34FocusedCheck.ts
MODIFIED (10): scripts/round33FocusedCheck.ts, src/main/approval.ts, src/main/browser.ts,
               src/main/devTools.ts, src/main/index.ts, src/main/ipcTrust.ts,
               src/main/nativeBrowser.ts, src/main/opsCenter.ts, src/main/shellIsolation.ts,
               src/renderer/components/OperationsPanel.tsx
REMOVED (0):   —
Tracked:       331 files (161 src + 97 tests + docs/scripts); the release ZIP includes the
               round reports per the established packaging convention.
```

SHA-256 of the delivered artifacts (authoritative values in `JARVIS_ROUND34_SHA256.txt`, shipped alongside the ZIP):

```
JARVIS_ROUND34.zip        <see download/JARVIS_ROUND34_SHA256.txt for the authoritative value>
JARVIS-1.0.0.AppImage     461,437,074 bytes (packaged from the final code)
```

The ZIP contains no `node_modules`, no `dist`, no `release` output, no caches, no test artifacts, and no `.git` directory.

## 12. FINAL RELEASE VERDICT

Round 34 makes the verified-bounded contract real: an executable's name is no longer a permission — under the bounded pathway only statically-establishable inspection/filesystem commands run, everything that executes code runs inside a kernel mount namespace whose actual layout was validated by EXECUTION (all eight probe steps, real bwrap runs, isolation demonstrated against host data), or it refuses with an honest explanation. A failed sandbox launch is a loud refusal with unknown-outcome semantics — never a silent downgrade. A browser submission is now approved and re-verified for the COMPLETE effective payload in browser-native successful-control semantics, bound to the exact submitter element, fingerprinted without delimiter collisions or sensitive-value exposure, submitted exactly once through the browser's normal mechanism, and reported with post-submit evidence — with no `form.submit()` pathway left anywhere in the codebase. An IPC message is trusted only from the exact bundled renderer resource — any other local file refuses, in one implementation across all sensitive channels. And the Operations Center shows the probe steps, the refusal counters and the trust mode as they truly are. Typecheck, lint, builds, packaging and all three focused checks (136 + 93 + 46 assertions) pass; the manifest reconciles by hash against the actual Round 33 ZIP; the limitations — including the verification-engine residual — are stated rather than papered over.
