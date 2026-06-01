import ReflectionsAudio from '@/modules/reflections-audio';
import { Audio } from 'expo-av';
import { setAudioModeAsync as setExpoAudioModeAsync } from 'expo-audio';

/**
 * Reflections Connect uses expo-audio for recording and expo-av/expo-video for playback.
 * On iOS the underlying AVAudioSession is global, so always reset both facades before playback.
 *
 * The low-level AVAudioSession category/mode is owned by the local `reflections-audio` Expo module
 * (see modules/reflections-audio). On Android that native module is a no-op by design.
 */
export async function configureConnectPlaybackAudioSessionAsync(options?: {
  /** Retry after recording teardown when iOS AVAudioSession is briefly busy (OSStatus 561017449). */
  retries?: number;
}): Promise<void> {
  const maxAttempts = (options?.retries ?? 0) + 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
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

      await ReflectionsAudio?.setPlaybackModeAsync();
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

/**
 * Enables hardware Acoustic Echo Cancellation (AEC) while recording a selfie/voice reaction.
 *
 * On iOS the `reflections-audio` module switches AVAudioSession to `PlayAndRecord` + `VoiceChat`,
 * activating the Voice-Processing I/O unit — the same hardware path used by phone calls and
 * FaceTime. It subtracts a reference copy of whatever the speaker is playing from the mic input,
 * so the Companion's voice is recorded cleanly even with the parent Reflection playing out loud.
 *
 * On Android we intentionally do NOT enable platform AEC (the native call is a no-op); echo is
 * mitigated by the recording-volume policy in reactionPlayback.ts (mute the speaker unless
 * headphones are connected).
 *
 * The native VoiceChat call is applied LAST, after the expo-av/expo-audio facades, so their mode
 * changes cannot clobber the VoiceChat configuration.
 *
 * During iOS selfie recording, parent video plays through muted expo-av; parent audio uses the
 * native module's VoiceChat AVPlayer so hardware AEC receives a reference signal. Android uses
 * expo-av for both with Original audio off on speaker by default.
 */
export async function configureConnectReactionRecordingAudioSessionAsync(options?: {
  /** Selfie uses VoiceChat (intended AEC). Voice-only skips it so parent playback stays audible. */
  voiceChatAec?: boolean;
}): Promise<void> {
  const voiceChatAec = options?.voiceChatAec !== false;

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

  if (!voiceChatAec) {
    return;
  }

  try {
    await ReflectionsAudio?.setVoiceChatModeAsync();
  } catch (error) {
    console.warn('[audioSession] setVoiceChatModeAsync failed:', error);
  }
}
