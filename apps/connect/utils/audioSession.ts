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
export async function configureConnectPlaybackAudioSessionAsync(): Promise<void> {
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

  // Restore a playback-optimised AVAudioSession after any recording session (no-op on Android).
  try {
    await ReflectionsAudio?.setPlaybackModeAsync();
  } catch (error) {
    console.warn('[audioSession] setPlaybackModeAsync failed:', error);
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
 */
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

  try {
    await ReflectionsAudio?.setVoiceChatModeAsync();
  } catch (error) {
    console.warn('[audioSession] setVoiceChatModeAsync failed:', error);
  }
}
