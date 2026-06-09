import { Audio } from 'expo-av';
import {
  setAudioModeAsync as setExpoAudioModeAsync,
  setIsAudioActiveAsync,
} from 'expo-audio';
import { AppState, Platform } from 'react-native';

export function isAndroidAudioFocusError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes('AudioFocusNotAcquiredException') ||
    error.message.includes('currently in the background')
  );
}

const ANDROID_AV_RETRY_DEFAULT_ATTEMPTS = 4;
const ANDROID_AV_RETRY_STABLE_MS = 600;
const ANDROID_AV_RETRY_STABLE_TIMEOUT_MS = 5000;

/**
 * Run an expo-av (or similar) playback command on Android with AppState-stable gating and
 * AudioFocusNotAcquired retries. No-op wrapper on iOS — calls command once and returns true.
 */
export async function runConnectAvCommandWithRetry(
  command: () => Promise<unknown> | undefined,
  options?: {
    maxAttempts?: number;
    stableMs?: number;
    stableTimeoutMs?: number;
    /** When true (default on Android), wait for stable foreground before the first attempt. */
    waitStableBeforeFirstAttempt?: boolean;
    onRetry?: (attempt: number, error: unknown) => void;
  },
): Promise<boolean> {
  if (Platform.OS !== 'android') {
    try {
      await command();
      return true;
    } catch {
      return false;
    }
  }

  const maxAttempts = options?.maxAttempts ?? ANDROID_AV_RETRY_DEFAULT_ATTEMPTS;
  const stableMs = options?.stableMs ?? ANDROID_AV_RETRY_STABLE_MS;
  const stableTimeoutMs = options?.stableTimeoutMs ?? ANDROID_AV_RETRY_STABLE_TIMEOUT_MS;
  const waitFirst = options?.waitStableBeforeFirstAttempt ?? true;

  if (waitFirst) {
    await waitForStableAndroidAppForeground(stableMs, stableTimeoutMs);
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await waitForStableAndroidAppForeground(stableMs, stableTimeoutMs);
      await new Promise((resolve) => setTimeout(resolve, 180 * attempt));
    }
    try {
      await command();
      return true;
    } catch (error) {
      if (isAndroidAudioFocusError(error) && attempt < maxAttempts - 1) {
        options?.onRetry?.(attempt + 1, error);
        continue;
      }
      return false;
    }
  }
  return false;
}

/**
 * Samsung/Android builds can emit rapid active↔background AppState blips while the front
 * camera is open. Audio APIs refuse focus until the app has been continuously foregrounded.
 */
export function waitForStableAndroidAppForeground(
  stableMs = 600,
  timeoutMs = 5000,
): Promise<boolean> {
  if (Platform.OS !== 'android') return Promise.resolve(true);

  return new Promise((resolve) => {
    let stableTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      subscription.remove();
      if (stableTimer) clearTimeout(stableTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve(ok);
    };

    const scheduleStableCheck = () => {
      if (stableTimer) clearTimeout(stableTimer);
      if (AppState.currentState !== 'active') return;
      stableTimer = setTimeout(() => {
        if (AppState.currentState === 'active') finish(true);
      }, stableMs);
    };

    const subscription = AppState.addEventListener('change', scheduleStableCheck);
    timeoutTimer = setTimeout(() => finish(false), timeoutMs);

    if (AppState.currentState === 'active') scheduleStableCheck();
  });
}

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
      if (Platform.OS === 'android' && isAndroidAudioFocusError(lastError)) {
        await waitForStableAndroidAppForeground(400, 3000);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Platform.OS === 'android' && isAndroidAudioFocusError(lastError) ? 300 * attempt : 200 * attempt),
      );
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
export async function configureConnectReactionRecordingAudioSessionAsync(options?: {
  /** Retry when iOS AVAudioSession is briefly busy after preview/capture teardown. */
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
      return;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    console.warn(
      `[audioSession] recording session failed after ${maxAttempts} attempt(s):`,
      lastError,
    );
    throw lastError;
  }
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
