/**
 * Shared AudioContext singleton for voice message playback.
 * Browsers limit AudioContext instances to ~6-8; sharing one prevents
 * hitting that limit when many voice messages are in chat history.
 */
let sharedCtx: AudioContext | null = null;

export function getSharedAudioContext(): AudioContext {
  if (!sharedCtx || sharedCtx.state === "closed") {
    sharedCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  return sharedCtx;
}

/**
 * Resume the shared AudioContext if it's suspended (browsers require
 * user interaction before audio can play).
 */
export async function resumeSharedAudioContext(): Promise<void> {
  const ctx = getSharedAudioContext();
  if (ctx.state === "suspended") {
    await ctx.resume();
  }
}
