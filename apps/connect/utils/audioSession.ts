import { Audio } from 'expo-av';
import { setAudioModeAsync as setExpoAudioModeAsync } from 'expo-audio';

/**
 * Reflections Connect uses expo-audio for recording and expo-av for playback.
 * On iOS the underlying AVAudioSession is global, so reset both facades when switching modes.
 */
export async function configureConnectPlaybackAudioSessionAsync(options?: {
  /** Retry after recording teardown when iOS AVAudioSession is briefly busy (OSStatus 561017449). */
  retries?: number;
}): Promise<void> {
  const maxAttempts = (options?.retries ?? 0) + 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }

    try {
      await Promise.all([
        setExpoAudioModeAsync({
          allowsRecording: false,
          playsInSilentMode: true,
        }),
        Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
          shouldDuckAndroid: false,
          playThroughEarpieceAndroid: false,
        }),
      ]);
      return;
    } catch (error) {
      lastError = error;
      console.warn(`[audioSession] playback session attempt ${attempt + 1}/${maxAttempts} failed:`, error);
    }
  }

  if (lastError) {
    throw lastError;
  }
}

/** Recording mode for selfie/voice reactions (expo-camera + expo-av parent sync). */
export async function configureConnectReactionRecordingAudioSessionAsync(): Promise<void> {
  await Promise.all([
    Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    }),
    setExpoAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
    }),
  ]);
}
