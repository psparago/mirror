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
      console.warn(`[audioSession] playback session attempt ${attempt + 1}/${maxAttempts} failed:`, error);
    }
  }

  if (lastError) {
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
 * Release mic/audio after expo-camera selfie capture on Android.
 * Camera + expo-av recording mode can block expo-audio; call before voice or camera remount.
 */
export async function releaseConnectCaptureAudioAsync(): Promise<void> {
  if (Platform.OS !== 'android') return;

  try {
    await setIsAudioActiveAsync(false);
  } catch (error) {
    console.warn('[audioSession] release capture: deactivate failed:', error);
  }

  await new Promise((resolve) => setTimeout(resolve, 150));

  try {
    await configureConnectPlaybackAudioSessionAsync({ retries: 1 });
  } catch (error) {
    console.warn('[audioSession] release capture: playback session failed:', error);
  }
}
