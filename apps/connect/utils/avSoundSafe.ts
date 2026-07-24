import { Audio } from 'expo-av';

/**
 * Safe expo-av Sound teardown.
 * Calling stop/unload on an unloaded Sound rejects with
 * "Cannot complete operation because sound is not loaded".
 */
export async function stopAndUnloadSoundSafely(
  sound: Audio.Sound | null | undefined,
): Promise<void> {
  if (!sound) return;
  try {
    const status = await sound.getStatusAsync();
    if (!status.isLoaded) return;
    try {
      await sound.stopAsync();
    } catch {
      /* already stopped or interrupted */
    }
    try {
      await sound.unloadAsync();
    } catch {
      /* already unloaded */
    }
  } catch {
    try {
      await sound.unloadAsync();
    } catch {
      /* native object may already be gone */
    }
  }
}

/** Pause only when loaded and currently playing. Returns true if pause ran. */
export async function pauseSoundIfLoaded(
  sound: Audio.Sound | null | undefined,
): Promise<boolean> {
  if (!sound) return false;
  try {
    const status = await sound.getStatusAsync();
    if (status.isLoaded && status.isPlaying) {
      await sound.pauseAsync();
      return true;
    }
  } catch {
    /* already stopped */
  }
  return false;
}

/** Play only when loaded. Returns true if play ran. */
export async function playSoundIfLoaded(
  sound: Audio.Sound | null | undefined,
): Promise<boolean> {
  if (!sound) return false;
  try {
    const status = await sound.getStatusAsync();
    if (status.isLoaded) {
      await sound.playAsync();
      return true;
    }
  } catch {
    /* already unloaded */
  }
  return false;
}

/** Clear a sound ref then safely stop/unload the previous instance. */
export async function takeAndUnloadSoundRef(
  ref: { current: Audio.Sound | null },
): Promise<void> {
  const sound = ref.current;
  ref.current = null;
  await stopAndUnloadSoundSafely(sound);
}
