# JINI upstream architecture integration inventory

Updated: 2026-11-20

This inventory tracks reusable agent capabilities, not upstream source-file counts. OpenCode and
Cline are complete applications. JINI integrates the capabilities that fit its Electron/TypeScript
host as native modules and deliberately excludes product-specific runtimes that would create a
second application inside JINI.

| Capability | JINI owner | Status |
|---|---|---|
| Cline-shaped AgentTool contract | agentEngine/toolRegistry.ts, toolTypes.ts | Integrated; namespaced tools receive explicit context, schemas and policy |
| OpenCode-style registry lifecycle | agentEngine/toolRegistry.ts | Integrated; register, update, disable, remove, namespace isolation and defensive schema snapshots |
| Tool availability controls | AgentSessionsPanel.tsx, mobile/Agents.tsx, IPC and deviceOps.ts | Integrated; plugin tools can be enabled/disabled on desktop and mobile; built-ins cannot be toggled there |
| Central execution and authorization | tools.ts, permission.ts, toolRecord.ts | JINI remains authoritative; validation, plan guard, risk, authorization, durable receipts, cancellation and audit are mandatory |
| Typed lifecycle event bus | runtimeEvents.ts, agentEngine/runtime.ts | Integrated; persistent session events and desktop subscriptions |
| Mobile agent lifecycle stream | devices/desktopLink.ts, devices/link.ts, mobile/linkClient.ts | Integrated; encrypted transport carries redacted lifecycle metadata, never model deltas, prompts or tool arguments |
| Agent session lifecycle | agentEngine/runtime.ts | Integrated; run, continue, abort, subscribe, snapshot, restore, fork and replay |
| Plugin registration and disposal | pluginRuntime.ts | Integrated; capability-gated and namespaced; disposal unregisters contributed tools |
| Agent contracts, allowlists and budgets | agentRegistry.ts, subagent.ts | Existing authoritative implementation |
| Bounded concurrent agent execution | subagent.ts | Existing authoritative implementation |
| Durable tasks, retries, verification and replanning | coordinator.ts, taskStore.ts, verifier.ts | Existing authoritative implementation |
| Context prioritization and deduplication | contextBudget.ts | Existing |
| Deterministic tool-history compaction | contextCompaction.ts, subagent.ts | Integrated |
| Git working-tree checkpoints | gitCheckpoints.ts, tools.ts | Integrated; automatic before eligible workspace writes, plus list/create/restore tools; tracked files only |
| Persistent recent-turn continuity | session.ts, history.ts | Existing |
| Browser and desktop execution | nativeBrowser.ts, browser.ts and tool services | Existing |
| Provider API adapters | llm.ts | Partial; OpenAI-compatible API path and model fallback exist; provider-specific Cline/OpenCode client suites are not ported |
| OpenCode LSP service graph | — | Not yet integrated |

## Adaptation and exclusions

- OpenCode's Effect-based service graph is not copied; JINI uses native promises, cancellation
  scopes and Electron main-process services.
- OpenCode UI/server/cloud modules and Cline's VS Code extension host, webview, VS Code storage,
  telemetry and extension-only services are not JINI runtime modules.
- Provider-specific upstream client packages are not vendored. JINI currently uses its
  OpenAI-compatible provider contract; adding native provider adapters is a separate remaining
  integration area.
- Cline checkpointing is adapted to private Git refs. Clean worktrees checkpoint HEAD; dirty
  tracked changes are snapshotted. Untracked files are intentionally excluded. Restores preserve
  the current tracked state as another listed checkpoint.
- Plugin tools cannot bypass JINI's dispatcher or permission model. Schema snapshots are cloned
  at registration and when exposed to the model.
- Mobile lifecycle events intentionally omit streamed model content, tool arguments and raw
  errors. They travel over the authenticated encrypted device link.
- Existing JINI permission, agent, task, session and browser systems are reused, not duplicated.

"Integrated" means implemented natively or covered by an existing JINI equivalent. It does not
mean every source file or product-specific feature from either upstream project was copied.
