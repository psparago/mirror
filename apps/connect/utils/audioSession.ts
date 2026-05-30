import { Audio } from 'expo-av';
import { setAudioModeAsync as setExpoAudioModeAsync } from 'expo-audio';
import { Platform } from 'react-native';
import AudioSession from 'react-native-audio-session';

/**
 * Reflections Connect uses expo-audio for recording and expo-av/expo-video for playback.
 * On iOS the underlying AVAudioSession is global, so always reset both facades before playback.
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
}

/**
 * Enables hardware Acoustic Echo Cancellation (AEC) while recording a selfie reaction.
 *
 * On iOS, `VoiceChat` mode activates the Voice-Processing I/O unit — the same hardware chip
 * used in phone calls and FaceTime. It subtracts a reference copy of whatever the speaker is
 * playing from the mic input, so the Companion's voice is recorded cleanly even with the parent
 * Reflection playing at 15% volume through the main speaker. `DefaultToSpeaker` keeps audio
 * routed to the loudspeaker rather than the earpiece.
 *
 * On Android, expo-camera's audio source cannot be changed from JS, so we set the mode flags
 * that best approximate AEC-friendly behaviour and rely on devices that support hardware AEC
 * via the VOICE_COMMUNICATION preset automatically.
 */
export async function configureConnectReactionRecordingAudioSessionAsync(): Promise<void> {
  const expoAv = Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
    staysActiveInBackground: false,
    shouldDuckAndroid: true,
    playThroughEarpieceAndroid: false,
  });

  const expoAudio = setExpoAudioModeAsync({
    allowsRecording: true,
    playsInSilentMode: true,
  });

  // VoiceChat mode enables hardware AEC on iOS — speaker audio is cancelled from the mic
  // recording in real time, exactly like TikTok Duet or Instagram Remix.
  const nativeAec =
    Platform.OS === 'ios'
      ? AudioSession.setCategoryAndMode('PlayAndRecord', 'VoiceChat', 'DefaultToSpeaker')
      : Promise.resolve();

  await Promise.all([expoAv, expoAudio, nativeAec]);
}
