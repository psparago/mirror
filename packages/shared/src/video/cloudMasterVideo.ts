import type { EventMetadata } from '../types';

/**
 * Cloud master: the MP4 on S3 is the permanent master. `video_start_ms` / `video_end_ms` are
 * **milliseconds from the start of that file** and define the playback window only (no re-cut upload).
 */
export type CloudMasterTrimWindow = {
  active: boolean;
  /** Trim start in seconds (inclusive). */
  startSec: number;
  /** Trim end in seconds (exclusive boundary for pause / VIDEO_FINISHED). */
  endSec: number;
};

/**
 * Parses a numeric milliseconds value from JSON / Firestore (number or numeric string).
 * Rejects NaN, Infinity, and non-numeric types so older or partial documents never break playback.
 */
export function parseVideoMsField(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return undefined;
    return raw;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export type ValidVideoTrimMs = { startMs: number; endMs: number };

/**
 * Valid trim only when both ends are present, finite, non-negative start, and end > start
 * (after integer rounding). Missing or one-sided legacy metadata yields null.
 */
export function getValidVideoTrimFromFields(start: unknown, end: unknown): ValidVideoTrimMs | null {
  const s = parseVideoMsField(start);
  const e = parseVideoMsField(end);
  if (s === undefined || e === undefined || s < 0 || e <= s) return null;
  const startMs = Math.round(s);
  const endMs = Math.round(e);
  if (endMs <= startMs) return null;
  return { startMs, endMs };
}

export function getValidVideoTrimMs(meta: EventMetadata | null | undefined): ValidVideoTrimMs | null {
  return getValidVideoTrimFromFields(meta?.video_start_ms, meta?.video_end_ms);
}

/** Poster frame position in ms; undefined when absent or invalid (older reflections often omit this). */
export function coerceThumbnailTimeMs(raw: unknown): number | undefined {
  const t = parseVideoMsField(raw);
  if (t === undefined || t < 0) return undefined;
  const rounded = Math.round(t);
  return rounded >= 0 ? rounded : undefined;
}

/** Returns `{ active: true }` only when both ends form a valid playback window. */
export function getCloudMasterTrimWindow(meta: EventMetadata | null | undefined): CloudMasterTrimWindow {
  const pair = getValidVideoTrimMs(meta);
  if (!pair) {
    return { active: false, startSec: 0, endSec: 0 };
  }
  return { active: true, startSec: pair.startMs / 1000, endSec: pair.endMs / 1000 };
}

/**
 * Seek an expo-video `VideoPlayer` to a time in seconds.
 * expo-video does not expose `seekTo`; assigning `currentTime` performs the seek.
 */
export function seekVideoToSeconds(
  player: { currentTime: number } | null | undefined,
  seconds: number
): void {
  if (!player || typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return;
  }
  player.currentTime = Math.max(0, seconds);
}
