import ReflectionsAudio from '@/modules/reflections-audio';
import type { AudioSessionInfo } from '@/modules/reflections-audio';
import { Platform } from 'react-native';

import { configureConnectReactionRecordingAudioSessionAsync } from './audioSession';

const RECORDING_AUDIO_REASSERT_DELAYS_MS = [0, 100, 250, 500];
const LOG_PREFIX = '[reaction-audio]';

export type ParentRecordingPlaybackPath = 'native-voicechat' | 'expo-av' | 'silent';

export type NativeRecordingAudioCapabilities = {
  platform: string;
  nativeModuleLoaded: boolean;
  /** From native getAudioSessionInfo when available; 2 = AEC guard + native parent playback. */
  nativeModuleVersion: number | null;
  nativeSelfiePathAvailable: boolean;
  /** Native APIs present on the loaded module (helps spot stale dev clients). */
  availableApis: string[];
  missingApis: string[];
};

export type ReactionAudioTraceContext = Record<string, unknown> & {
  originalAudioMuted?: boolean;
  parentVolume?: number;
  hasHeadphones?: boolean;
  syncStartMs?: number;
  syncEndMs?: number;
  parentPlaybackPath?: ParentRecordingPlaybackPath;
  reassertDelayMs?: number;
  voiceChatAec?: boolean;
  recordingDurationMs?: number;
};

export type ReactionAudioDiagnosticVerdict = {
  ok: boolean;
  issues: string[];
  hints: string[];
};

const NATIVE_API_CHECKS: Array<{ key: keyof NonNullable<typeof ReflectionsAudio>; label: string }> = [
  { key: 'setVoiceChatModeAsync', label: 'setVoiceChatModeAsync' },
  { key: 'beginVoiceChatGuardAsync', label: 'beginVoiceChatGuardAsync' },
  { key: 'reassertVoiceChatModeAsync', label: 'reassertVoiceChatModeAsync' },
  { key: 'endVoiceChatGuardAsync', label: 'endVoiceChatGuardAsync' },
  { key: 'startParentRecordingPlaybackAsync', label: 'startParentRecordingPlaybackAsync' },
  { key: 'stopParentRecordingPlaybackAsync', label: 'stopParentRecordingPlaybackAsync' },
  { key: 'getAudioSessionInfo', label: 'getAudioSessionInfo' },
  { key: 'getAudioRoute', label: 'getAudioRoute' },
];

/** True when iOS native VoiceChat parent playback is available in this dev client build. */
export function isNativeSelfieRecordingAudioAvailable(): boolean {
  return (
    Platform.OS === 'ios' &&
    !!ReflectionsAudio?.beginVoiceChatGuardAsync &&
    !!ReflectionsAudio?.startParentRecordingPlaybackAsync
  );
}

export function getNativeRecordingAudioCapabilities(): NativeRecordingAudioCapabilities {
  const availableApis: string[] = [];
  const missingApis: string[] = [];

  for (const { key, label } of NATIVE_API_CHECKS) {
    const present = !!ReflectionsAudio?.[key];
    if (present) {
      availableApis.push(label);
    } else {
      missingApis.push(label);
    }
  }

  return {
    platform: Platform.OS,
    nativeModuleLoaded: !!ReflectionsAudio,
    nativeModuleVersion: readSessionInfo()?.nativeModuleVersion ?? null,
    nativeSelfiePathAvailable: isNativeSelfieRecordingAudioAvailable(),
    availableApis,
    missingApis,
  };
}

function readSessionInfo(): AudioSessionInfo | null {
  if (!ReflectionsAudio?.getAudioSessionInfo) return null;
  try {
    return ReflectionsAudio.getAudioSessionInfo();
  } catch {
    return null;
  }
}

function readAudioRoute() {
  if (!ReflectionsAudio?.getAudioRoute) return null;
  try {
    return ReflectionsAudio.getAudioRoute();
  } catch {
    return null;
  }
}

export function evaluateReactionAudioDiagnostics(
  context: ReactionAudioTraceContext,
  session: AudioSessionInfo | null,
  caps: NativeRecordingAudioCapabilities,
): ReactionAudioDiagnosticVerdict {
  const issues: string[] = [];
  const hints: string[] = [];

  if (Platform.OS === 'ios') {
    if (!caps.nativeModuleLoaded) {
      issues.push('ReflectionsAudio native module not loaded — install a Connect (Dev) build.');
    } else if (caps.nativeModuleVersion != null && caps.nativeModuleVersion < 2) {
      issues.push(
        `Native ReflectionsAudio v${caps.nativeModuleVersion} on device; v2 required for AEC guard + native parent playback. JS logging can be newer than native (Metro vs EAS). Rebuild from commit 48e8353 or later.`,
      );
    } else if (!caps.nativeSelfiePathAvailable) {
      issues.push(
        `Native module missing APIs: ${caps.missingApis.join(', ') || 'unknown'}. JS bundle may be ahead of the EAS-installed binary.`,
      );
    }

    if (context.parentPlaybackPath === 'expo-av' && context.originalAudioMuted === false) {
      issues.push(
        'Parent audio is on expo-av during recording — hardware AEC reference path is bypassed.',
      );
    }

    if (session) {
      if (!session.isVoiceChatMode) {
        issues.push(
          `AVAudioSession mode is "${session.mode}" (expected AVAudioSessionModeVoiceChat). AEC likely inactive.`,
        );
      }
      if (!session.isPlayAndRecord) {
        issues.push(
          `AVAudioSession category is "${session.category}" (expected PlayAndRecord).`,
        );
      }
      if (
        context.originalAudioMuted === false &&
        (context.parentVolume ?? 0) > 0 &&
        !session.nativeParentPlaybackActive
      ) {
        issues.push('Original audio On but native parent AVPlayer is not active.');
      }
      if (context.originalAudioMuted === false && session.nativeParentPlaybackActive && !session.nativeParentPlaying) {
        issues.push('Native parent AVPlayer exists but rate is 0 (not playing).');
      }
    } else if (caps.nativeModuleLoaded) {
      issues.push('Could not read getAudioSessionInfo() from native module.');
    }
  }

  if (Platform.OS === 'android') {
    hints.push('Android uses volume policy only — platform AEC is intentionally disabled.');
  }

  if (issues.length === 0 && caps.nativeSelfiePathAvailable && context.originalAudioMuted === false) {
    hints.push(
      'Session looks correct. If preview still echoes, bleed may be in the captured file — listen for double parent audio.',
    );
  }

  return { ok: issues.length === 0, issues, hints };
}

/** Structured dev trace — filter Metro logs with `[reaction-audio]`. */
export function traceReactionAudio(phase: string, context: ReactionAudioTraceContext = {}): void {
  if (!__DEV__) return;

  const caps = getNativeRecordingAudioCapabilities();
  const session = readSessionInfo();
  const route = readAudioRoute();
  const verdict = evaluateReactionAudioDiagnostics(context, session, caps);

  console.log(`${LOG_PREFIX} ${phase}`, {
    ts: new Date().toISOString(),
    ...context,
    route,
    session,
    caps,
    verdict,
  });

  if (verdict.issues.length > 0) {
    console.warn(`${LOG_PREFIX} ${phase} — issues:`, verdict.issues);
  }
}

/** Log capabilities once when the reaction sheet opens (spots stale dev clients immediately). */
export function traceReactionAudioCapabilities(phase = 'sheet-open'): void {
  traceReactionAudio(phase, { voiceChatAec: true });
}

export async function logReactionAudioSessionInfo(label: string): Promise<void> {
  traceReactionAudio(label);
}

export async function beginSelfieReactionRecordingAudioGuardAsync(): Promise<void> {
  traceReactionAudio('begin-guard:start', { voiceChatAec: true });

  if (!isNativeSelfieRecordingAudioAvailable()) {
    await configureConnectReactionRecordingAudioSessionAsync({ voiceChatAec: true });
    traceReactionAudio('begin-guard:fallback-expo-session-only', { voiceChatAec: true });
    return;
  }

  await configureConnectReactionRecordingAudioSessionAsync({ voiceChatAec: true });
  await ReflectionsAudio!.beginVoiceChatGuardAsync!();
  traceReactionAudio('begin-guard:complete', { voiceChatAec: true });
}

export async function reassertSelfieReactionRecordingAudioAsync(reassertDelayMs?: number): Promise<void> {
  traceReactionAudio('reassert-voicechat:start', { reassertDelayMs, voiceChatAec: true });

  if (!isNativeSelfieRecordingAudioAvailable()) {
    await configureConnectReactionRecordingAudioSessionAsync({ voiceChatAec: true });
    traceReactionAudio('reassert-voicechat:fallback-expo-session-only', { reassertDelayMs });
    return;
  }

  await ReflectionsAudio!.reassertVoiceChatModeAsync!();
  traceReactionAudio('reassert-voicechat:complete', { reassertDelayMs, voiceChatAec: true });
}

export async function endSelfieReactionRecordingAudioGuardAsync(context: ReactionAudioTraceContext = {}): Promise<void> {
  traceReactionAudio('end-guard:start', context);
  if (!ReflectionsAudio) {
    traceReactionAudio('end-guard:no-native-module', context);
    return;
  }
  await ReflectionsAudio.stopParentRecordingPlaybackAsync?.().catch(() => {});
  await ReflectionsAudio.endVoiceChatGuardAsync?.().catch(() => {});
  traceReactionAudio('end-guard:complete', context);
}

export async function startNativeParentRecordingPlaybackAsync(
  url: string,
  startMs: number,
  volume: number,
  context: ReactionAudioTraceContext = {},
): Promise<void> {
  if (!isNativeSelfieRecordingAudioAvailable() || volume <= 0) {
    await ReflectionsAudio?.stopParentRecordingPlaybackAsync?.().catch(() => {});
    traceReactionAudio('native-parent-playback:stopped', {
      ...context,
      parentPlaybackPath: 'silent',
      parentVolume: volume,
      syncStartMs: startMs,
    });
    return;
  }

  traceReactionAudio('native-parent-playback:start', {
    ...context,
    parentPlaybackPath: 'native-voicechat',
    parentVolume: volume,
    syncStartMs: startMs,
    parentUrlHost: safeUrlHost(url),
  });

  await ReflectionsAudio!.startParentRecordingPlaybackAsync!(url, startMs, volume);
  traceReactionAudio('native-parent-playback:complete', {
    ...context,
    parentPlaybackPath: 'native-voicechat',
    parentVolume: volume,
    syncStartMs: startMs,
  });
}

export async function stopNativeParentRecordingPlaybackAsync(
  context: ReactionAudioTraceContext = {},
): Promise<void> {
  traceReactionAudio('native-parent-playback:stop', context);
  await ReflectionsAudio?.stopParentRecordingPlaybackAsync?.().catch(() => {});
}

/**
 * Re-applies VoiceChat and native parent playback shortly after expo-camera starts capture.
 * Returns a cancel function to clear pending timers when recording ends early.
 */
export function scheduleSelfieRecordingAudioReasserts(
  onReassert: (delayMs: number) => Promise<void>,
): () => void {
  traceReactionAudio('schedule-reasserts', {
    delaysMs: RECORDING_AUDIO_REASSERT_DELAYS_MS,
  });

  const timers = RECORDING_AUDIO_REASSERT_DELAYS_MS.map((delay) =>
    setTimeout(() => {
      void onReassert(delay);
    }, delay),
  );

  return () => {
    for (const timer of timers) {
      clearTimeout(timer);
    }
    traceReactionAudio('cancel-reasserts');
  };
}

function safeUrlHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
