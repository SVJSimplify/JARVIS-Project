# JINI agent-engine migration

## Upstream study (2026-11-19)

- OpenCode: https://github.com/anomalyco/opencode — MIT. Studied its tool registry editor (add, update, remove, namespaces), schema snapshots, and plugin/tool lifecycle.
- Cline: https://github.com/cline/cline — Apache-2.0. Studied the SDK's AgentTool contract (name, description, inputSchema, execute(input, context)), extension capability declarations, and per-tool policies.

## Decisions

- Custom-tool contract: Cline's shape. A tool declares a JSON input schema and an execution function with an explicit context (agent, plugin, cancellation signal).
- Registry lifecycle: OpenCode's shape. Registration, lookup, update, disable, removal, namespace isolation, and immutable model-facing snapshots are centralized.
- JINI remains the host. Every contributed tool is adapted into JINI's existing dispatch choke point. It still passes schema validation, plan guards, risk classification, authorization, durable started/outcome receipts, cancellation checks, audit logging, and result envelopes.
- No duplicate runtime. This migration slice does not import a second model loop or let plugins call tool implementations around the central gate.

## Compatibility findings

The current JINI desktop host uses Electron 32 / Node 20 and TypeScript 5, with an OpenAI-compatible provider adapter. The current Cline SDK packages declare Node >=22 and use a multi-package workspace (@cline/agents, @cline/shared, @cline/llms, @cline/core). OpenCode's current core is a Bun workspace using Effect 4 and workspace aliases. Copying either complete runtime into this host without a runtime/dependency migration would create a non-buildable hybrid.

Therefore this first integration extracts the stable public tool contract and registry boundary into a JINI-native adapter. It intentionally does not claim that either complete upstream runtime has been vendored. A later agent-loop replacement must be migrated and tested as a separate, explicit runtime change.

## Current integration boundary

- Existing built-in JINI tools remain available.
- Plugins may contribute namespaced tools only when declaring the tools capability.
- Custom tools default to the conservative config action class (durable side-effect receipt); read-only tools must explicitly declare action: read.
- Parallel custom tools must explicitly declare action: read.
- A declared delete action is converted to JINI's hard deletion block.
- Plugin disposal unregisters its tools.
- Custom tools cannot shadow built-ins or bypass JINI's execution gate.
