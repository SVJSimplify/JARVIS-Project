/**
 * The renderer's view of the interaction-mode wire protocol. The shapes live in
 * src/main/protocol.ts (single source for both ends); this re-export exists because
 * the renderer code should import from a stable local path.
 */
export type { ActivityEvent, ActivityKind, InteractionMode, ModeInfo, NotifyPayload } from '../../src/main/protocol';
