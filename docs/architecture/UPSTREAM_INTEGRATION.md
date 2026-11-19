# Jini upstream architecture integration inventory

This inventory tracks reusable capabilities, not upstream source-file counts. OpenCode and
Cline are complete applications; their UI, provider adapters, cloud services and framework-
specific service graphs are excluded where they do not fit Jini's Electron/TypeScript runtime.

| Capability | Jini owner | Status |
|---|---|---|
| Tool registry and execution choke point | tools.ts, toolTypes.ts | Existing authoritative implementation |
| Typed lifecycle event bus | runtimeEvents.ts, progress.ts, tools.ts | Integrated |
| Plugin registration and disposal | pluginRuntime.ts | Integrated; observational hooks only |
| Agent contracts, allowlists and budgets | agentRegistry.ts, subagent.ts | Existing authoritative implementation |
| Bounded concurrent agent execution | subagent.ts | Existing authoritative implementation |
| Durable tasks, retries, verification and replanning | coordinator.ts, taskStore.ts, verifier.ts | Existing authoritative implementation |
| Permission lifecycle, approval and durable receipts | permission.ts, approval.ts, tools.ts | Existing; Jini-specific safety model retained |
| Context prioritization and deduplication | contextBudget.ts | Existing |
| Deterministic tool-history compaction | contextCompaction.ts, subagent.ts | Integrated |
| Git working-tree checkpoints | gitCheckpoints.ts | Integrated service; explicit caller required |
| Persistent recent-turn continuity | session.ts, history.ts | Existing |
| Browser and desktop execution | nativeBrowser.ts, browser.ts and tool services | Existing |

## Adaptation and exclusions

- OpenCode's Effect-based service graph is not copied; Jini uses native promises, cancellation
  scopes and Electron main-process services.
- OpenCode UI/server/provider/cloud modules and Cline's VS Code extension host, webview,
  provider clients, telemetry and VS Code storage abstractions are not Jini runtime modules.
- Cline checkpointing is adapted to private Git refs. Stash-create snapshots tracked changes
  without resetting the worktree; untracked files are excluded.
- Plugin hooks and lifecycle events are observational. They cannot grant permissions, replace
  tools, mutate tool arguments or bypass runToolDetailed.
- Existing Jini permission, agent, task, session and browser systems are reused, not duplicated.

"Integrated" means implemented natively or covered by an existing Jini equivalent. It does
not mean every source file or product-specific feature from either upstream project was copied.
