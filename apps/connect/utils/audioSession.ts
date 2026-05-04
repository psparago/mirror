import { Audio } from 'expo-av';
import { setAudioModeAsync as setExpoAudioModeAsync } from 'expo-audio';

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
