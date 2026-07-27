/**
 * Pure video trim helpers for Reflections Connect Workbench.
 */

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Clamp a playback window into [0, durationMs] with a maximum span.
 * Always returns end > start when duration allows.
 */
export function clampVideoTrimWindowMs(
  start: number,
  end: number,
  durationMs: number,
  maxSpanMs: number,
): { start: number; end: number } {
  const d = Math.max(0, Math.round(durationMs));
  let s = Math.max(0, Math.min(Math.round(start), Math.max(0, d - 1)));
  let e = Math.max(s + 1, Math.min(Math.round(end), d));
  if (e - s > maxSpanMs) {
    e = s + maxSpanMs;
    if (e > d) {
      e = d;
      s = Math.max(0, e - maxSpanMs);
    }
  }
  return { start: s, end: Math.max(s + 1, e) };
}

export function isNativeMediaInterruption(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.includes('Seeking interrupted');
}
