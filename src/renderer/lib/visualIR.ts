/**
 * Re-export shim: the visual IR (types, repair pass, renderer) lives in src/main/visualIR.ts
 * so BOTH processes share one implementation — the main process normalises at show_visual
 * staging time, the renderer re-validates the clean shape as a no-op. One module, one
 * guarantee: no payload shape can dead-end a visual.
 */
export * from '../../main/visualIR';
