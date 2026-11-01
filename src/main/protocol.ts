/**
 * The wire protocol between the main process and the HUD renderer for interaction
 * modes and the activity feed. Pure types, no imports, no electron — both sides
 * (main/modes.ts and types/electron.d.ts) take their shapes from here so the two
 * ends can never drift apart.
 */

export type InteractionMode = 'interactive' | 'background';

export type ActivityKind = 'tool' | 'progress' | 'speech' | 'visual' | 'confirm' | 'mode';

export interface ActivityEvent {
  id: number;
  t: number;
  /** Correlation id: a tool's start and its result share one; the feed replaces in place. */
  cid?: string;
  kind: ActivityKind;
  label: string;
  detail?: string;
  status?: 'busy' | 'ok' | 'fail' | 'held';
  ms?: number;
}

export interface NotifyPayload {
  title: string;
  body: string;
  /** One short line the renderer may speak aloud as the end-of-task notification. */
  speakLine: string;
  ok: boolean;
  interrupted: boolean;
  task: string;
  reply: string;
  steps: number;
  failures: number;
  held: number;
}

export interface ModeInfo {
  mode: InteractionMode;
  events: ActivityEvent[];
}
