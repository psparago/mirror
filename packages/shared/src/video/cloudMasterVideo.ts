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

/** Returns `{ active: true }` only when both ends are set and `end > start` (see type fields). */
export function getCloudMasterTrimWindow(meta: EventMetadata | null | undefined): CloudMasterTrimWindow {
  const s = meta?.video_start_ms;
  const e = meta?.video_end_ms;
  if (typeof s !== 'number' || typeof e !== 'number' || e <= s || s < 0) {
    return { active: false, startSec: 0, endSec: 0 };
  }
  return { active: true, startSec: s / 1000, endSec: e / 1000 };
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
