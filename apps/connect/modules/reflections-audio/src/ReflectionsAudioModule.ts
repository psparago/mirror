import { NativeModule, requireNativeModule } from 'expo';

import type { AudioOutputRoute, ReflectionsAudioModuleEvents } from './ReflectionsAudio.types';

export type AudioSessionInfo = {
  category: string;
  mode: string;
  isPlayAndRecord?: boolean;
  isVoiceChatMode?: boolean;
  isOtherAudioPlaying?: boolean;
  voiceChatGuardActive: boolean;
  nativeParentPlaybackActive: boolean;
  nativeParentPlaying?: boolean;
  nativeParentVolume?: number;
  nativeParentRate?: number;
  nativeParentTimeSec?: number;
  nativeModuleLoaded: boolean;
  outputs?: string[];
  inputs?: string[];
  hasHeadphones?: boolean;
};

export declare class ReflectionsAudioModule extends NativeModule<ReflectionsAudioModuleEvents> {
  /**
   * iOS: switches the shared `AVAudioSession` to `PlayAndRecord` + `VoiceChat` mode, which routes
   * capture through the hardware Voice-Processing I/O unit (acoustic echo cancellation). This is
   * what lets a Companion record a selfie reaction while the parent Reflection plays out loud
   * without the playback bleeding into the recording.
   *
   * Android: intentionally a no-op. We deliberately do NOT enable platform AEC on Android (it would
   * require patching expo-camera's audio source); echo is handled by the JS volume policy instead.
   */
  setVoiceChatModeAsync(): Promise<void>;

  /**
   * iOS: enables VoiceChat and keeps re-applying it while expo-camera may clobber the session.
   * Android: no-op.
   */
  beginVoiceChatGuardAsync(): Promise<void>;

  /** iOS: re-applies VoiceChat when the guard is active. Android: no-op. */
  reassertVoiceChatModeAsync(): Promise<void>;

  /** iOS: tears down the guard and native parent playback. Android: no-op. */
  endVoiceChatGuardAsync(): Promise<void>;

  /**
   * iOS: plays parent Reflection audio through the VoiceChat session during selfie recording so
   * hardware AEC receives a reference signal. expo-av bypasses this path and causes mic bleed.
   * Android: no-op (expo-av handles parent audio).
   */
  startParentRecordingPlaybackAsync(
    url: string,
    startMs: number,
    volume: number,
  ): Promise<void>;

  /** Stops native parent playback started by `startParentRecordingPlaybackAsync`. */
  stopParentRecordingPlaybackAsync(): Promise<void>;

  /**
   * iOS: restores a playback-optimised `AVAudioSession` (`Playback` + `MoviePlayback`) after a
   * recording session so subsequent video playback is full fidelity. Android: no-op.
   */
  setPlaybackModeAsync(): Promise<void>;

  /** Returns the device's current audio output route (synchronous). */
  getAudioRoute(): AudioOutputRoute;

  /** Returns the current AVAudioSession category/mode for dev diagnostics. */
  getAudioSessionInfo(): AudioSessionInfo;
}

/**
 * The native module is only present in a development/production build that was compiled with this
 * local module. We resolve it defensively so that Metro web bundling, Expo Go, or an out-of-date
 * dev client degrade gracefully (every method becomes a safe no-op) instead of crashing at import.
 */
let nativeModule: ReflectionsAudioModule | null = null;
try {
  nativeModule = requireNativeModule<ReflectionsAudioModule>('ReflectionsAudio');
} catch {
  nativeModule = null;
}

export default nativeModule;
