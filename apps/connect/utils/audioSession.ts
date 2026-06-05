import { Audio } from 'expo-av';
import {
  setAudioModeAsync as setExpoAudioModeAsync,
  setIsAudioActiveAsync,
} from 'expo-audio';
import { Platform } from 'react-native';

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
      await setIsAudioActiveAsync(true);
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
      // The first attempt routinely fails with OSStatus 561017449 ("cannot interrupt others")
      // while the camera capture session is still releasing the audio session — the retry below
      // succeeds. Only surface a warning if every attempt failed, to avoid alarming noise.
    }
  }

  if (lastError) {
    console.warn(
      `[audioSession] playback session failed after ${maxAttempts} attempt(s):`,
      lastError,
    );
    throw lastError;
  }
}

/** Recording mode for selfie/voice reactions (expo-camera + expo-av parent sync). */
export async function configureConnectReactionRecordingAudioSessionAsync(): Promise<void> {
  await setIsAudioActiveAsync(true);
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

/**
 * Voice-only reaction on a photo parent — expo-audio recorder only (iOS).
 * Avoids putting expo-av into recording mode on Android, which can block the recorder.
 */
export async function configureConnectVoiceReactionRecordingAsync(): Promise<void> {
  if (Platform.OS === 'android') {
    try {
      await setIsAudioActiveAsync(false);
    } catch {
      /* ignore */
    }
  }
  await setIsAudioActiveAsync(true);
  await setExpoAudioModeAsync({
    allowsRecording: true,
    playsInSilentMode: true,
  });
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: false,
    playsInSilentModeIOS: true,
    staysActiveInBackground: false,
    shouldDuckAndroid: true,
    playThroughEarpieceAndroid: false,
  });
}

/**
 * Release mic/audio after an expo-camera selfie capture, then reconfigure for playback.
 *
 * On both platforms the camera's capture session can keep holding the audio session after a
 * recording — on iOS this surfaces as OSStatus 561017449 ("cannot interrupt others") when we
 * try to activate playback, which blocks Video playback in the companion preview; on Android it
 * leaves playback routed for recording (very quiet). Deactivating first releases the session so
 * the subsequent playback activation succeeds.
 */
export async function releaseConnectCaptureAudioAsync(): Promise<void> {
  try {
    await setIsAudioActiveAsync(false);
  } catch (error) {
    console.warn('[audioSession] release capture: deactivate failed:', error);
  }

  await new Promise((resolve) => setTimeout(resolve, 150));

  try {
    await configureConnectPlaybackAudioSessionAsync({ retries: 2 });
  } catch (error) {
    console.warn('[audioSession] release capture: playback session failed:', error);
  }
}
