/**
 * Pure helpers for the Gemini Live client. Keeping these out of the React
 * component makes the stability rules testable without a microphone.
 */

/**
 * Merge streamed transcript chunks without duplicating the same text when the
 * provider sends both model-turn text and output transcription for one turn.
 */
export function mergeTranscript(existing: string, incoming: string): string {
  const next = incoming ?? "";
  if (!next) return existing;
  if (!existing) return next;
  if (existing.endsWith(next)) return existing;
  if (next.startsWith(existing)) return next;
  if (next.includes(existing) && next.length > existing.length) return next;
  return `${existing}${next}`;
}

export type BargeInInput = {
  /** Current microphone RMS level, normalised to 0..1. */
  level: number;
  /** Consecutive frames above the speech threshold. */
  frames: number;
  /** Milliseconds since agent audio actually began. */
  speakingMs: number;
  state: string;
  muted: boolean;
};

/**
 * A deliberate barge-in, not a click, echo burst or a short pause. The first
 * 600 ms of agent speech is protected from microphone echo; at least twelve
 * consecutive 20 ms frames (~240 ms) above 0.09 are required after that.
 */
export function isIntentionalBargeIn(input: BargeInInput): boolean {
  return (
    input.state === "speaking" &&
    !input.muted &&
    input.speakingMs >= 600 &&
    input.frames >= 12 &&
    input.level > 0.09
  );
}

/**
 * Bounded exponential backoff with jitter. The first retry is about 0.8s, the
 * cap is 6s, and the random factor stays between 0.8 and 1.2 so concurrent
 * clients do not reconnect in lockstep. `random` is injectable for tests.
 */
export function reconnectDelay(attempt: number, random = Math.random()): number {
  const safeAttempt = Math.max(1, Math.min(8, Math.floor(attempt)));
  const base = Math.min(6000, 800 * 2 ** (safeAttempt - 1));
  const sample = Math.max(0, Math.min(1, Number.isFinite(random) ? random : 0.5));
  const jitter = 0.8 + sample * 0.4;
  return Math.max(500, Math.min(7200, Math.round(base * jitter)));
}

/** A reconnect budget is restored only after this much stable session time. */
export function isStableConnection(connectedMs: number): boolean {
  return Number.isFinite(connectedMs) && connectedMs >= 10_000;
}
