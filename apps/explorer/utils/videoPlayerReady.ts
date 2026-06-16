import { seekVideoToSeconds } from '@projectmirror/shared';

type VideoPlayerLike = {
  status?: string;
  playing?: boolean;
  currentTime?: number;
  play: () => void;
  pause?: () => void;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until expo-video reports readyToPlay (or deadline). */
export async function waitForVideoPlayerReady(
  player: VideoPlayerLike | null | undefined,
  deadlineMs = 8000,
): Promise<boolean> {
  if (!player) return false;
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      if (player.status === 'readyToPlay') return true;
    } catch {
      return false;
    }
    await sleep(60);
  }
  return false;
}

export interface PlayVideoWhenReadyOptions {
  seekSec?: number;
  beforePlay?: () => void;
  maxAttempts?: number;
}

/** Seek (optional), then play with short retries while the machine expects playback. */
export async function playVideoPlayerWhenReady(
  player: VideoPlayerLike | null | undefined,
  opts: PlayVideoWhenReadyOptions = {},
): Promise<boolean> {
  if (!player) return false;
  const ready = await waitForVideoPlayerReady(player);
  if (!ready) return false;

  const maxAttempts = opts.maxAttempts ?? 4;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      if (typeof opts.seekSec === 'number') {
        seekVideoToSeconds(
          player as unknown as Parameters<typeof seekVideoToSeconds>[0],
          opts.seekSec,
        );
      }
      opts.beforePlay?.();
      if (!player.playing) {
        player.play();
      }
      await sleep(attempt === 0 ? 0 : 120 * attempt);
      if (player.playing) return true;
      if (player.status !== 'readyToPlay') {
        await waitForVideoPlayerReady(player, 2000);
      }
    } catch {
      /* retry */
    }
  }
  return !!player.playing;
}
