# JINI agent-engine integration

## Upstream study

- OpenCode: https://github.com/anomalyco/opencode — MIT. Reused architectural ideas from its tool registry lifecycle, namespaces, session/event model and provider/tool boundaries.
- Cline: https://github.com/cline/cline — Apache-2.0. Reused the AgentTool contract, explicit execution context, capability declarations, task/session lifecycle and Git checkpoint model.

## Architectural decisions

- **JINI remains the host.** Contributed tools are adapted into JINI's existing dispatch choke point. Every call still passes schema validation, plan guards, risk classification, authorization, durable started/outcome receipts, cancellation checks, audit logging and result envelopes.
- **Cline-shaped custom-tool contract.** A tool declares a JSON input schema and an execution function with explicit agent, plugin, cancellation-signal and session context.
- **OpenCode-shaped registry lifecycle.** Registration, lookup, update, enable/disable, removal, namespace isolation and defensive model-facing schema snapshots are centralized.
- **One authoritative execution loop.** JINI's provider/tool loop remains responsible for model turns. The agent runtime owns session lifecycle and durable event replay; it does not create a second model loop.
- **JINI safety is retained.** Plugin tools cannot shadow built-ins or bypass the central gate. Declared delete actions remain subject to JINI's hard deletion block.

## Compatibility findings

The JINI desktop host uses Electron 32 / Node 20 and TypeScript 5. Its current provider path is
OpenAI-compatible. Cline's SDK packages declare Node >=22 and use a multi-package workspace
(@cline/agents, @cline/shared, @cline/llms, @cline/core). OpenCode's core is a Bun workspace using
Effect 4 and workspace aliases. Vendoring either complete runtime directly would create an
incompatible second host and duplicate JINI's existing execution, policy and persistence systems.

The implementation therefore ports the reusable contracts and capabilities into JINI-native
modules rather than importing incompatible runtime graphs.

## Integrated capabilities

- Persistent agent sessions with run, continue, abort, subscribe, snapshot, restore, fork and replay.
- Typed runtime lifecycle events with durable sequence numbers and desktop subscriptions.
- Redacted agent lifecycle events streamed to paired mobile devices over the encrypted device link.
- Namespaced plugin tools with schema isolation, capability checks, lifecycle disposal and desktop/mobile enable/disable controls.
- Central policy enforcement and durable receipts for every consequential tool call.
- Automatic tracked-worktree Git checkpoints before eligible workspace writes, plus explicit list/create/restore tools. Restoring preserves the prior tracked state as another listed checkpoint. Untracked files are not included.
- Context budgeting, compaction, multi-agent delegation, durable task orchestration and verification continue to use JINI's existing implementations.

## Remaining upstream parity work

- Native provider-specific adapters and authentication flows beyond the current OpenAI-compatible contract.
- OpenCode-style language-server integration where it materially improves JINI's coding workflows.
- Further parity work must be implemented behind JINI's existing interfaces and security gate; upstream UI, cloud services, VS Code extension host and Bun/Effect service graph are intentionally out of scope.
