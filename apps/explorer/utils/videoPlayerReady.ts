import { seekVideoToSeconds } from '@projectmirror/shared';

type VideoPlayerLike = {
  status?: string;
  playing?: boolean;
  currentTime?: number;
  duration?: number;
  play: () => void;
  pause?: () => void;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read an expo-video player property without throwing when the native object is gone. */
export function safeVideoPlayerGet<T>(
  player: unknown,
  read: (p: VideoPlayerLike) => T,
  fallback: T,
): T {
  if (!player) return fallback;
  try {
    return read(player as VideoPlayerLike);
  } catch {
    return fallback;
  }
}

export function safeVideoPlayerPlaying(player: unknown): boolean {
  return safeVideoPlayerGet(player, (p) => !!p.playing, false);
}

export function safeVideoPlayerStatus(player: unknown): string | undefined {
  return safeVideoPlayerGet(player, (p) => p.status, undefined);
}

export function safeVideoPlayerCurrentTime(player: unknown): number {
  return safeVideoPlayerGet(
    player,
    (p) => (typeof p.currentTime === 'number' && Number.isFinite(p.currentTime) ? p.currentTime : 0),
    0,
  );
}

export function safeVideoPlayerDuration(player: unknown): number {
  return safeVideoPlayerGet(
    player,
    (p) => (typeof p.duration === 'number' && Number.isFinite(p.duration) ? p.duration : 0),
    0,
  );
}

/** Poll until expo-video reports readyToPlay (or deadline). */
export async function waitForVideoPlayerReady(
  player: VideoPlayerLike | null | undefined,
  deadlineMs = 8000,
): Promise<boolean> {
  if (!player) return false;
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (safeVideoPlayerStatus(player) === 'readyToPlay') return true;
    await sleep(60);
  }
  return false;
}

export interface PlayVideoWhenReadyOptions {
  seekSec?: number;
  beforePlay?: () => void;
  maxAttempts?: number;
  /** When false, abort retries (e.g. user navigated away from the stage). */
  shouldContinue?: () => boolean;
}

/** Seek (optional), then play with short retries while the machine expects playback. */
export async function playVideoPlayerWhenReady(
  player: VideoPlayerLike | null | undefined,
  opts: PlayVideoWhenReadyOptions = {},
): Promise<boolean> {
  if (!player) return false;
  if (opts.shouldContinue && !opts.shouldContinue()) return false;

  const ready = await waitForVideoPlayerReady(player);
  if (!ready) return false;

  const maxAttempts = opts.maxAttempts ?? 4;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (opts.shouldContinue && !opts.shouldContinue()) return false;
    try {
      if (typeof opts.seekSec === 'number') {
        seekVideoToSeconds(
          player as unknown as Parameters<typeof seekVideoToSeconds>[0],
          opts.seekSec,
        );
      }
      opts.beforePlay?.();
      if (!safeVideoPlayerPlaying(player)) {
        player.play();
      }
      await sleep(attempt === 0 ? 0 : 120 * attempt);
      if (opts.shouldContinue && !opts.shouldContinue()) return false;
      if (safeVideoPlayerPlaying(player)) return true;
      if (safeVideoPlayerStatus(player) !== 'readyToPlay') {
        await waitForVideoPlayerReady(player, 2000);
      }
    } catch {
      /* retry */
    }
  }
  return safeVideoPlayerPlaying(player);
}
