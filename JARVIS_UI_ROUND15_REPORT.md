# JARVIS — UI ROUND 15: TOP-RIGHT CONTROLS + CONVERSATIONS TAB

Date: 2026-11-05 · Base: `jarvis-round14-verified.zip` · Release: `jarvis-ui-history-round15.zip`

Targeted changes only: the top-right header fix and the Conversations history tab. No redesign, no framework, no engine changes.

---

## 1. The top-right layout fix — root cause and change

**Root cause (investigated, not guessed):**

1. The window uses `titleBarStyle: 'hidden'` + `titleBarOverlay` (native Windows
   min/max/close buttons drawn over the top-right 40px strip — `src/main/index.ts:40`).
2. The header reserved a FIXED `pr-40` (160px) for that strip — but the native overlay's
   width scales with Windows display scaling (≈138px at 100%, ≈173px at 125%, ≈207px at
   150%). At higher DPI the custom controls slid UNDER the OS buttons; at normal DPI the
   icons were 17–20px with zero padding — far too small to click comfortably — and the
   mode pill, version and alert text could compress the icon buttons at narrow widths.

**The fix (underlying constraints, not offsets):**

- `src/renderer/index.css` — `.hud-header` now reserves
  `calc(100vw - env(titlebar-area-width, …) + 8px)`: the exact native-overlay width at ANY
  display scale, measured by Chromium itself, with the old 10rem value as fallback.
- `src/renderer/components/JarvisWindow.tsx` — the three control buttons (mode, mini,
  settings) moved into one `ml-auto flex shrink-0 items-center gap-1` cluster; every
  button is a fixed `h-8 w-8` (32px) grid target with hover / active / focus-visible
  states; the mode pill gets `h-8 px-2` + the same states. The left side becomes
  compressible instead: brand `shrink-0`, alert `truncate` inside a `min-w-0` group,
  version hidden below 1150px window width. Header height unchanged (h-10) — no chat
  space lost, visual style untouched (same colors, icons, typography).
- A fourth button was added to the cluster: **Conversations** (history icon).

## 2. The Conversations tab — how it works

- **Entry point**: the header history button (present in both full and mini modes) opens a
  reading panel styled exactly like the existing Provider settings overlay (`fixed inset-0`
  + `holo`/`rail` classes, backdrop click, ✕, and Esc all close it; it registers with
  `modalState` so Esc closes the PANEL instead of cancelling a running turn).
- **List view**: conversations grouped by the app's own 10-minute session semantics
  (`groupConversations`, gap < 10min = same conversation); newest first; each row shows
  You-line, J.A.R.V.I.S preview, tool actions, interrupted/failed marker, message count and
  time span. Clicking opens the full conversation.
- **Detail view**: every turn in full — user text verbatim, JARVIS's complete response with
  fenced code blocks rendered as styled `<pre>` blocks and everything else in `pre-wrap`
  (line breaks, lists, headings indentation preserved). No truncation anywhere. Back button
  returns to the list; the chat behind is never touched.
- **Automatic updates**: `App.tsx` bumps `historyTick` after every finished turn; an open
  panel refetches, so new conversations appear live.

## 3. Persistence — source of truth and the one limitation found

**Finding:** the only existing store, `brain/session.json` (`src/main/session.ts`), is a
COMPACT prompt-context log — it clips the request to 200 chars, the reply to **240 chars**
and keeps 60 turns. Complete message content was never retained, so a history built on it
would be fake.

**Smallest compatible fix:** a parallel full-fidelity log written at the exact same
pipeline points — no second engine, no disconnected recorder:

- `src/main/history.ts` (new): `appendConversationTurn()` stores the COMPLETE user text,
  COMPLETE reply, actions and errors to `brain/conversations.json` (atomic writes, capped
  at 400 turns / 4MB, oldest trimmed first, duplicate-turn guarded, corrupt-file tolerant).
- `src/main/provider.ts`: three one-line hooks at the existing `recordTurn` sites — normal
  completion, interrupted, and failed turns (with their error) all land in history.
- **Previously stored conversations**: legacy session.json entries are surfaced honestly
  and marked `legacy` / "compact record — full text was never stored" where the clip
  marker (…) is present. Nothing is invented; entries that both stores already hold are
  deduplicated (±2s + user-text match — real dual writes land milliseconds apart).
- **Durability**: `conversations.json` lives in the workspace next to session.json;
  closing and reopening JARVIS keeps the full history.
- Wire surface: `ipcMain.handle('history-list')` → preload `history.list()` → typed via
  `types/electron.d.ts`; the `HistoryTurn` shape lives in the shared `src/main/protocol.ts`
  (single source for both ends, like every other wire type).

## 4. Exact files changed

**Created:** `src/main/history.ts` · `src/renderer/lib/conversations.ts` ·
`src/renderer/components/ConversationsPanel.tsx` · `tests/historyStore.test.ts` ·
`tests/conversationsUi.test.ts`

**Modified:** `src/main/provider.ts` (3 record hooks + import) · `src/main/session.ts`
(`getSessionTurnsForHistory` export) · `src/main/index.ts` (`history-list` handle) ·
`src/main/protocol.ts` (`HistoryTurn` type) · `src/preload/index.ts` (`history.list`) ·
`types/electron.d.ts` (history surface) · `src/renderer/App.tsx` (`historyTick`) ·
`src/renderer/components/JarvisWindow.tsx` (header rework + panel mount) ·
`src/renderer/index.css` (overlay-exact header padding) · `src/renderer/lib/protocol.ts`
(type re-export)

## 5. Checks executed and results (all run here)

| Check | Result |
| --- | --- |
| `npm run typecheck` (both tsconfigs, real exit code) | PASS (0) |
| `npm run lint` | PASS (0) |
| `npx vitest run` (full suite) | **547/547 PASS, 36 files** (526 previous + 21 new) |
| `npm run build:dev` (main + preload) | PASS (0) |
| `npm run build:renderer` (production vite) | PASS — panel included in bundle |
| Regression: hardening/authorization/capability suites | all green inside the 547 (policy 78, adversarial 21, permission 19, enforcement 16, coordinator 15, capabilityManifest 13, round14 10, staleCleanup 5, …) |

**New focused tests (21):**

- `tests/historyStore.test.ts` (7): complete 4800+ char reply stored verbatim (the 240-char
  clip regression); interrupted turns kept with their error; duplicate turn rejected;
  400-turn cap with newest-survives trimming; corrupt store tolerated; legacy entries
  surfaced + marked + deduplicated; merged list chronological.
- `tests/conversationsUi.test.ts` (14): 10-minute conversation grouping (boundary, order,
  defensive sort, empty); fence splitting (plain, language tag, unclosed fence, multiple
  blocks); previews; timestamps; and four source guards locking the header fix (env-based
  overlay reserve present, old `pr-40`/`pr-36` gone, 32px `shrink-0` cluster, panel
  registers as modal) and the full persistence wiring (provider → main → preload → types).

## 6. Verification checklist mapping (assignment §4)

1–2 (clickable, no overlap at window sizes): enforced structurally — 32px fixed targets,
`shrink-0` cluster, alert truncation, version hiding, and the overlay-exact reserve; locked
by source-guard tests. Physical click testing needs a display (see limitations).
3–9 (tab opens, stored + new conversations, full content, code blocks readable, chat
preserved, restart-safe): covered by the store/UI tests above and the durable
`conversations.json` design; IPC and modal wiring locked by tests.
10 (chat, tools, streaming untouched): the full 547-test suite passed with zero
modifications to the engine, provider architecture, tool routing or voice pipeline.

## 7. Limitations

1. Headless workspace: the Electron window cannot be launched here, so physical
   click-testing (checklist 1–2) is verified by construction + tests, not by eye. The env()
   reserve is exactly right on Windows; on Linux (no native overlay) the 10rem fallback
   applies, matching the previous spacing.
2. Replies are rendered fence-aware (code blocks + pre-wrap text), not full Markdown — no
   new rendering dependency was introduced under the scope rules; lists/headings stay
   readable as plain text.
3. If Settings and Conversations are somehow both open, one Esc closes both (harmless;
   same single-listener pattern the Settings panel already had).
4. Conversations from BEFORE this build exist only as compact records where session.json
   had clipped them (marked honestly in the UI); full-fidelity capture starts with this
   release. Nothing was invented to fill the gap.
