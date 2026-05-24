import {
  API_ENDPOINTS,
  DEFAULT_LIKE_FEEDBACK_VOICE,
} from '@projectmirror/shared';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';

/** Single static cache path — overwritten each like to prevent storage leaks. */
export const LIKE_FEEDBACK_CACHE_PATH = `${FileSystem.cacheDirectory}like-feedback.mp3`;

export type PlayLikeFeedbackAudioOptions = {
  voice?: string;
  /** Duck video volume and pause narration/companion audio before like TTS. Video keeps playing. */
  onBeforePlay?: () => void | Promise<void>;
  /** Restore video volume and resume paused narration after like TTS finishes (or fails). */
  onAfterPlay?: () => void | Promise<void>;
};

let activeLikeSound: Audio.Sound | null = null;
let likeAudioRequestId = 0;
let pendingLikeAfterPlay: PlayLikeFeedbackAudioOptions['onAfterPlay'];

async function runLikeAfterPlay(
  onAfterPlay?: PlayLikeFeedbackAudioOptions['onAfterPlay']
): Promise<void> {
  if (!onAfterPlay) return;
  try {
    await onAfterPlay();
  } catch (error) {
    console.warn('Like feedback resume failed:', error);
  }
}

async function clearPendingLikeAfterPlay(): Promise<void> {
  const resume = pendingLikeAfterPlay;
  pendingLikeAfterPlay = undefined;
  await runLikeAfterPlay(resume);
}

export async function stopLikeFeedbackAudio(): Promise<void> {
  likeAudioRequestId += 1;
  if (activeLikeSound) {
    try {
      await activeLikeSound.stopAsync();
      await activeLikeSound.unloadAsync();
    } catch {
      // already stopped
    }
    activeLikeSound = null;
  }
  await clearPendingLikeAfterPlay();
}

async function finishLikeFeedbackPlayback(
  requestId: number,
  onAfterPlay?: PlayLikeFeedbackAudioOptions['onAfterPlay']
): Promise<void> {
  if (requestId !== likeAudioRequestId) return;
  pendingLikeAfterPlay = undefined;
  await runLikeAfterPlay(onAfterPlay);
}

/**
 * Fetches ephemeral Google TTS (base64 MP3), writes to the static cache path,
 * plays via expo-av, and unloads on completion.
 */
export async function playLikeFeedbackAudio(
  text: string,
  options: PlayLikeFeedbackAudioOptions = {}
): Promise<void> {
  const { voice = DEFAULT_LIKE_FEEDBACK_VOICE, onBeforePlay, onAfterPlay } = options;
  await clearPendingLikeAfterPlay();

  if (activeLikeSound) {
    likeAudioRequestId += 1;
    try {
      await activeLikeSound.stopAsync();
      await activeLikeSound.unloadAsync();
    } catch {
      // already stopped
    }
    activeLikeSound = null;
  }

  const requestId = ++likeAudioRequestId;
  pendingLikeAfterPlay = onAfterPlay;

  try {
    if (onBeforePlay) {
      await onBeforePlay();
    }
    if (requestId !== likeAudioRequestId) {
      await finishLikeFeedbackPlayback(requestId, onAfterPlay);
      return;
    }

    const res = await fetch(API_ENDPOINTS.SYNTHESIZE_SPEECH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice }),
    });
    if (!res.ok || requestId !== likeAudioRequestId) {
      await finishLikeFeedbackPlayback(requestId, onAfterPlay);
      return;
    }

    const payload = (await res.json()) as { audioBase64?: string };
    const audioBase64 = typeof payload.audioBase64 === 'string' ? payload.audioBase64 : '';
    if (!audioBase64 || requestId !== likeAudioRequestId) {
      await finishLikeFeedbackPlayback(requestId, onAfterPlay);
      return;
    }

    await FileSystem.writeAsStringAsync(LIKE_FEEDBACK_CACHE_PATH, audioBase64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    if (requestId !== likeAudioRequestId) {
      await finishLikeFeedbackPlayback(requestId, onAfterPlay);
      return;
    }

    const { sound } = await Audio.Sound.createAsync(
      { uri: LIKE_FEEDBACK_CACHE_PATH },
      { shouldPlay: true, volume: 1.0, isLooping: false }
    );
    if (requestId !== likeAudioRequestId) {
      try {
        await sound.unloadAsync();
      } catch {
        // ignore
      }
      await finishLikeFeedbackPlayback(requestId, onAfterPlay);
      return;
    }

    activeLikeSound = sound;
    sound.setOnPlaybackStatusUpdate((status) => {
      if (status.isLoaded && status.didJustFinish) {
        sound.unloadAsync().catch(() => {});
        if (activeLikeSound === sound) {
          activeLikeSound = null;
        }
        void finishLikeFeedbackPlayback(requestId, onAfterPlay);
      }
    });
  } catch (error) {
    console.warn('Like feedback audio failed:', error);
    await finishLikeFeedbackPlayback(requestId, onAfterPlay);
  }
}
