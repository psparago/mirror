import {
  defaultReactionOriginalAudioEnabled,
  formatTypedReactionSpeechText,
  resolveReactionRecordingVolume,
  type SelfieRecordingAudioSnapshot,
} from '@/utils/reactionPlayback';
import { uploadReaction, generateTypedReactionAudio } from '@/utils/reactionUpload';
import { ensureFileUri } from '@/utils/mediaProcessor';
import { loadVoicePreferences } from '@/utils/ttsVoices';
import { useAudioRoute } from '@/utils/audioRoute';
import {
  configureConnectPlaybackAudioSessionAsync,
  configureConnectReactionRecordingAudioSessionAsync,
  configureConnectVoiceReactionRecordingAsync,
  releaseConnectCaptureAudioAsync,
} from '@/utils/audioSession';
import { diagnosticsAppLog, type DiagnosticLogLevel } from '@/utils/diagnosticsLog';
import { FontAwesome } from '@expo/vector-icons';
import {
  useAuth,
  useExplorer,
  VideoTrimSlider,
  useCompanionAvatars,
  API_ENDPOINTS,
  getAvatarColor,
  getAvatarInitial,
  type ReactionType,
} from '@projectmirror/shared';
import { Audio, ResizeMode, Video, type AVPlaybackStatus } from 'expo-av';
import { Camera, CameraView, useCameraPermissions } from 'expo-camera';
import { useVideoPlayer, VideoView, type VideoSource } from 'expo-video';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  useAudioRecorder,
} from 'expo-audio';
import { Image } from 'expo-image';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const PREVIEW_END_EPSILON_MS = 80;
const MIN_TRIM_GAP_MS = 500;
const TYPED_MESSAGE_MAX_LENGTH = 120;
const ANDROID_CAMERA_REMOUNT_MS = 400;
const RECORDING_PARENT_REASSERT_DELAYS_MS = [250, 600];

type ReactionComposeMode = ReactionType;

function isSeekInterrupted(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Seeking interrupted');
}

async function runVideoCommand(
  command: () => Promise<unknown> | undefined,
  logLabel: string,
): Promise<void> {
  try {
    await command();
  } catch (error) {
    if (!isSeekInterrupted(error)) {
      console.warn(`[ReactionSheet] ${logLabel}:`, error);
    }
  }
}

const RECORDING_START_TIMEOUT_MS = 8000;

function logReactionDebug(
  step: string,
  detail?: Record<string, unknown>,
  level: DiagnosticLogLevel = 'log',
): void {
  const safeDetail: Record<string, string | number | boolean | null | undefined> = {};
  if (detail) {
    for (const [key, value] of Object.entries(detail)) {
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        value == null
      ) {
        safeDetail[key] = value;
      }
    }
  }
  diagnosticsAppLog('ReactionSheet', step, safeDetail, level);
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function ensureMicPermissionAsync(): Promise<boolean> {
  try {
    const existing = await Audio.getPermissionsAsync();
    if (existing.granted) return true;
    if (!existing.canAskAgain) return false;
  } catch (error) {
    console.warn('[ReactionSheet] expo-av mic permission read failed:', error);
  }

  if (Platform.OS === 'android') {
    try {
      const fromExpoAv = await Audio.requestPermissionsAsync();
      return fromExpoAv.granted;
    } catch (error) {
      console.warn('[ReactionSheet] expo-av mic permission failed:', error);
      return false;
    }
  }

  try {
    const fromExpoAudio = await requestRecordingPermissionsAsync();
    if (fromExpoAudio.granted) return true;
  } catch (error) {
    console.warn('[ReactionSheet] expo-audio mic permission failed:', error);
  }
  try {
    const fromExpoAv = await Audio.requestPermissionsAsync();
    return fromExpoAv.granted;
  } catch (error) {
    console.warn('[ReactionSheet] expo-av mic permission failed:', error);
    return false;
  }
}

async function prepareExpoAvRecordingSessionAsync(): Promise<void> {
  if (Platform.OS === 'android') {
    try {
      await setIsAudioActiveAsync(false);
    } catch {
      /* ignore */
    }
  }
  try {
    await setIsAudioActiveAsync(true);
  } catch (error) {
    console.warn('[ReactionSheet] setIsAudioActiveAsync failed:', error);
  }
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
    staysActiveInBackground: false,
    shouldDuckAndroid: true,
    playThroughEarpieceAndroid: false,
  });
}

type ExpoAudioVoiceRecorder = Pick<
  ReturnType<typeof useAudioRecorder>,
  'isRecording' | 'stop' | 'prepareToRecordAsync' | 'record' | 'getStatus'
>;

async function startExpoAudioVoiceRecordingAsync(
  recorder: ExpoAudioVoiceRecorder,
  options?: { skipSessionConfigure?: boolean },
): Promise<void> {
  if (!options?.skipSessionConfigure) {
    await configureConnectVoiceReactionRecordingAsync();
  }
  try {
    if (recorder.isRecording) {
      await recorder.stop();
    }
  } catch {
    /* ignore stale stop */
  }
  await setAudioModeAsync({
    allowsRecording: true,
    playsInSilentMode: true,
  });
  await recorder.prepareToRecordAsync();
  recorder.record();
  if (recorder.isRecording) return;
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (recorder.isRecording) return;
  }
  const status = recorder.getStatus();
  throw new Error(
    `Voice recorder did not start (canRecord=${status.canRecord}, isRecording=${status.isRecording}, mediaReset=${status.mediaServicesDidReset})`,
  );
}

async function startAndroidExpoAvVoiceRecordingAsync(options: {
  isVideoParent: boolean;
  trimStartMs: number;
  startParentPlayback?: (startMs: number) => Promise<void>;
}): Promise<Audio.Recording> {
  logReactionDebug('voice:release-capture');
  await releaseConnectCaptureAudioAsync();
  await new Promise((resolve) => setTimeout(resolve, 250));

  logReactionDebug('voice:prepare-session');
  await prepareExpoAvRecordingSessionAsync();

  if (options.isVideoParent && options.startParentPlayback) {
    logReactionDebug('voice:parent-playback', { trimStartMs: options.trimStartMs });
    await options.startParentPlayback(options.trimStartMs);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const recording = new Audio.Recording();
  logReactionDebug('voice:prepare-recording');
  await recording.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
  logReactionDebug('voice:start-recording');
  await recording.startAsync();
  const status = await recording.getStatusAsync();
  logReactionDebug('voice:recording-status', {
    isRecording: status.isRecording,
    canRecord: status.canRecord,
    durationMillis: status.durationMillis,
  });
  if (!status.isRecording) {
    throw new Error(
      `Android voice did not start (isRecording=${status.isRecording}, canRecord=${status.canRecord})`,
    );
  }
  return recording;
}

export type ReactionParentMedia =
  | { mediaType: 'video'; videoUrl: string }
  | { mediaType: 'image'; imageUrl: string };

export interface ReactionSheetProps {
  visible: boolean;
  onClose: () => void;
  parentReflectionId: string;
  parentMedia: ReactionParentMedia | null;
  onUploadSuccess?: (parentReflectionId: string, relationshipId: string) => void;
}

export function ReactionSheet({
  visible,
  onClose,
  parentReflectionId,
  parentMedia,
  onUploadSuccess,
}: ReactionSheetProps) {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { currentExplorerId, activeRelationship } = useExplorer();
  const { companions } = useCompanionAvatars(currentExplorerId);
  const [resolvedCompanionAvatarUrl, setResolvedCompanionAvatarUrl] = useState<string | null>(null);
  const companionAvatar = useMemo(() => {
    const fromList =
      companions.find((c) => c.userId === user?.uid) ??
      companions.find((c) => c.relationshipId === activeRelationship?.id);
    if (fromList) {
      return { ...fromList, avatarUrl: fromList.avatarUrl ?? resolvedCompanionAvatarUrl };
    }
    if (activeRelationship && user?.uid) {
      return {
        relationshipId: activeRelationship.id,
        userId: user.uid,
        companionName: activeRelationship.companionName || 'Companion',
        role: activeRelationship.role ?? null,
        isCaregiver: activeRelationship.role === 'caregiver',
        avatarUrl: resolvedCompanionAvatarUrl,
        avatarS3Key: activeRelationship.companionAvatarS3Key ?? null,
        color: getAvatarColor(user.uid),
        initial: getAvatarInitial(activeRelationship.companionName || 'Companion'),
      };
    }
    return null;
  }, [activeRelationship, companions, resolvedCompanionAvatarUrl, user?.uid]);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micReady, setMicReady] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [isCameraRestoring, setIsCameraRestoring] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isSelfieSaving, setIsSelfieSaving] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [positionMillis, setPositionMillis] = useState(0);
  const [durationMillis, setDurationMillis] = useState(0);
  const [recordedUri, setRecordedUri] = useState<string | null>(null);
  const [syncStartTimeMillis, setSyncStartTimeMillis] = useState<number | null>(null);
  const [syncEndTimeMillis, setSyncEndTimeMillis] = useState<number | null>(null);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [trimStartMs, setTrimStartMs] = useState(0);
  const [trimEndMs, setTrimEndMs] = useState(0);
  const [cameraInstanceKey, setCameraInstanceKey] = useState(0);
  const [isParentReflectionMuted, setIsParentReflectionMuted] = useState(false);
  const [reactionMode, setReactionMode] = useState<ReactionComposeMode>('selfie');
  const [typedMessage, setTypedMessage] = useState('');
  const [voiceRecordedUri, setVoiceRecordedUri] = useState<string | null>(null);
  const [isVoiceRecording, setIsVoiceRecording] = useState(false);
  const [isStartingVoiceRecording, setIsStartingVoiceRecording] = useState(false);
  const [isVoiceProcessing, setIsVoiceProcessing] = useState(false);
  const [nativeCameraGranted, setNativeCameraGranted] = useState<boolean | null>(null);
  // Tracks whether the app is foregrounded. Used to release the Android camera while backgrounded
  // (keeping `active` true across background leaves CameraX unable to re-bind a preview on resume).
  const [isAppForeground, setIsAppForeground] = useState(true);
  const [companionPreviewOpen, setCompanionPreviewOpen] = useState(false);
  const [companionPreviewPlaying, setCompanionPreviewPlaying] = useState(false);
  const [showCompanionPreviewReplay, setShowCompanionPreviewReplay] = useState(false);
  const [recordedAudioSnapshot, setRecordedAudioSnapshot] =
    useState<SelfieRecordingAudioSnapshot | null>(null);
  const [isInfoOpen, setIsInfoOpen] = useState(false);

  const voiceRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const voiceExpoAvRecordingRef = useRef<Audio.Recording | null>(null);
  const isStartingVoiceRecordingRef = useRef(false);
  const androidCameraRemountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const companionPreviewStopPendingRef = useRef(false);
  // Selfie preview interruption recovery. On iOS old-arch, expo-camera's deferred AVCaptureSession
  // teardown calls AVAudioSession.setActive(false) ~0.6-1s after we open the preview, which
  // interrupts (pauses) the expo-video player mid-clip. We can't out-time that teardown from JS, so
  // we recover from it: if the player pauses unexpectedly while we expect it to be playing, we
  // restart it once or twice. This is the documented iOS interruption-recovery pattern, not a poll.
  const selfiePreviewExpectPlayingRef = useRef(false);
  const selfiePreviewResumeAttemptsRef = useRef(0);
  const selfiePreviewLastResumePosRef = useRef(0);
  const selfiePreviewResumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live audio output route. Headphones/Bluetooth → the parent Reflection can play out loud during
  // recording (no echo path); otherwise we fall back to the platform echo policy.
  const audioRoute = useAudioRoute(visible);
  const hasHeadphones = audioRoute.hasHeadphones;

  const isVideoParent = parentMedia?.mediaType === 'video';
  const isImageParent = parentMedia?.mediaType === 'image';
  const parentVideoUrl = parentMedia?.mediaType === 'video' ? parentMedia.videoUrl : '';
  const parentImageUrl = parentMedia?.mediaType === 'image' ? parentMedia.imageUrl : '';
  const suppressAndroidParentVideoSurface =
    Platform.OS === 'android' &&
    isVideoParent &&
    !companionPreviewOpen &&
    (reactionMode === 'typed' || reactionMode === 'voice');
  const hasValidParentMedia =
    (isVideoParent && !!parentVideoUrl) || (isImageParent && !!parentImageUrl);
  const parentPosterUri = isVideoParent ? parentVideoUrl : parentImageUrl;

  const videoRef = useRef<Video>(null);
  const companionParentRef = useRef<Video>(null);
  const cameraRef = useRef<CameraView>(null);

  // Companion selfie preview is played via expo-video (the stable SDK 52 player). Unlike the
  // deprecated expo-av Video, it owns its own AVAudioSession activation, so it starts reliably
  // after camera capture without the manual session-healing the old player required. The source
  // is null unless we're previewing a recorded selfie; useVideoPlayer swaps the source when it
  // changes (e.g. after a retake).
  const companionSelfieSource = useMemo<VideoSource>(
    () => (reactionMode === 'selfie' && recordedUri ? { uri: ensureFileUri(recordedUri) } : null),
    [reactionMode, recordedUri],
  );
  const companionSelfiePlayer = useVideoPlayer(companionSelfieSource, (player) => {
    player.loop = false;
    player.muted = false;
    player.volume = 1.0;
    player.timeUpdateEventInterval = 0;
    // Default to mixing — this is what Android needs and was working with. On iOS this is overridden
    // per-parent at play time (see startCompanionPreview): exclusive ('auto') for image parents so
    // the selfie plays at full volume, mixing for video parents so it coexists with the parent.
    player.audioMixingMode = 'mixWithOthers';
  });
  const recordingPromiseRef = useRef<Promise<{ uri: string } | undefined> | null>(null);
  const recordingStartedAtRef = useRef(0);
  const cameraRecordingStartedRef = useRef(false);
  const parentVideoWidthRef = useRef(0);
  const seekOriginMsRef = useRef(0);
  const durationMillisRef = useRef(0);
  const trimStartMsRef = useRef(0);
  const trimEndMsRef = useRef(0);
  const positionMillisRef = useRef(0);
  const canScrubRef = useRef(true);
  const isScrubbingRef = useRef(false);
  const isVideoDragActiveRef = useRef(false);
  const previewStopPendingRef = useRef(false);
  const seekChainRef = useRef(Promise.resolve());
  const pendingSeekTargetRef = useRef<number | null>(null);
  const isParentReflectionMutedRef = useRef(false);
  const isPreviewPlayingRef = useRef(false);
  const parentPreviewToggleBusyRef = useRef(false);
  const lastPanSeekAtRef = useRef(0);
  const lastParentVolumeApplyRef = useRef(0);
  const lastCompanionParentVolumeApplyRef = useRef(0);
  const hasHeadphonesRef = useRef(false);
  // True once the Companion manually toggles "Original audio", so we stop applying the smart default.
  const userToggledMuteRef = useRef(false);
  const isRecordingRef = useRef(false);
  const recordingSessionIdRef = useRef(0);
  const recordingAudioReassertCancelRef = useRef<(() => void) | null>(null);
  const voicePreviewPlayerRef = useRef<Audio.Sound | null>(null);
  const typedPreviewAudioUriRef = useRef<string | null>(null);
  const typedPreviewMessageRef = useRef<string | null>(null);
  const [isTypedKeyboardVisible, setIsTypedKeyboardVisible] = useState(false);
  const [typedMessageReady, setTypedMessageReady] = useState(false);
  const [typedPreviewLoading, setTypedPreviewLoading] = useState(false);
  const stopSelfieRecordingRef = useRef<(() => void) | null>(null);

  const getReactionParentVolume = useCallback(
    () =>
      resolveReactionRecordingVolume({
        muted: isParentReflectionMutedRef.current,
        hasHeadphones: hasHeadphonesRef.current,
      }),
    [],
  );

  /** Parent Reflection volume while trim/companion preview is actively playing (not recording). */
  const getParentPreviewPlaybackVolume = useCallback(
    () =>
      resolveReactionRecordingVolume({
        muted: false,
        hasHeadphones: hasHeadphonesRef.current,
      }),
    [],
  );

  /** Keep expo-av mute flag and volume in sync — setStatusAsync(volume) alone clears isMuted. */
  const syncParentVideoAudioAsync = useCallback(
    async (
      target: Video | null | undefined,
      options?: { previewPlayback?: boolean },
    ) => {
      if (!target) return;
      const status = await target.getStatusAsync().catch(() => null);
      if (!status?.isLoaded) return;
      const previewPlayback = options?.previewPlayback === true;
      const muted = previewPlayback ? false : isParentReflectionMutedRef.current;
      const volume = previewPlayback ? getParentPreviewPlaybackVolume() : getReactionParentVolume();
      await runVideoCommand(async () => {
        await target.setIsMutedAsync(muted);
        await target.setVolumeAsync(volume);
      }, 'failed to sync parent audio');
    },
    [getParentPreviewPlaybackVolume, getReactionParentVolume],
  );

  const applyParentReflectionVolume = useCallback(async () => {
    const previewPlayback = isPreviewPlayingRef.current && !isRecordingRef.current;
    await syncParentVideoAudioAsync(videoRef.current, { previewPlayback });
  }, [syncParentVideoAudioAsync]);

  const startParentRecordingPlayback = useCallback(
    async (startMs: number) => {
      if (!isVideoParent) return;
      const muted = isParentReflectionMutedRef.current;
      const volume = getReactionParentVolume();
      await syncParentVideoAudioAsync(videoRef.current);
      await runVideoCommand(
        () =>
          videoRef.current?.setStatusAsync({
            positionMillis: startMs,
            shouldPlay: true,
            isMuted: muted,
            volume,
          }),
        'reaction playback failed',
      );
    },
    [getReactionParentVolume, isVideoParent, syncParentVideoAudioAsync],
  );

  const getParentPreviewStartMs = useCallback(() => {
    if (reactionMode === 'selfie') {
      return syncStartTimeMillis ?? trimStartMsRef.current ?? 0;
    }
    return trimStartMsRef.current;
  }, [reactionMode, syncStartTimeMillis]);

  const unloadPreviewAudio = useCallback(async () => {
    const sound = voicePreviewPlayerRef.current;
    voicePreviewPlayerRef.current = null;
    if (!sound) return;
    try {
      await sound.stopAsync();
    } catch {
      /* ignore */
    }
    try {
      await sound.unloadAsync();
    } catch {
      /* ignore */
    }
  }, []);

  const playCompanionPreviewClip = useCallback(
    async (uri: string, onFinished: () => void) => {
      await unloadPreviewAudio();
      await configureConnectPlaybackAudioSessionAsync({ retries: 2 });
      const { sound } = await Audio.Sound.createAsync(
        { uri: ensureFileUri(uri) },
        { shouldPlay: true, volume: 1.0 },
      );
      voicePreviewPlayerRef.current = sound;
      sound.setOnPlaybackStatusUpdate((status) => {
        if (!status.isLoaded || !status.didJustFinish) return;
        if (voicePreviewPlayerRef.current === sound) {
          voicePreviewPlayerRef.current = null;
        }
        void sound.unloadAsync().catch(() => {});
        onFinished();
      });
    },
    [unloadPreviewAudio],
  );

  const restoreReactionRecordingAudioSession = useCallback(async () => {
    try {
      await configureConnectReactionRecordingAudioSessionAsync();
    } catch (error) {
      console.warn('[ReactionSheet] failed to restore recording audio session:', error);
    }
  }, []);

  const finishCompanionPreview = useCallback(async () => {
    if (companionPreviewStopPendingRef.current) return;
    logReactionDebug('selfie-preview:finish', {});
    selfiePreviewExpectPlayingRef.current = false;
    companionPreviewStopPendingRef.current = true;
    setCompanionPreviewPlaying(false);
    try {
      companionSelfiePlayer.pause();
    } catch {
      /* player may be released */
    }
    await unloadPreviewAudio();
    await runVideoCommand(() => companionParentRef.current?.pauseAsync(), 'companion preview pause failed');
    const parentPreviewStartMs = getParentPreviewStartMs();
    if (isVideoParent && parentPreviewStartMs != null) {
      await runVideoCommand(
        () =>
          companionParentRef.current?.setStatusAsync({
            positionMillis: parentPreviewStartMs,
            shouldPlay: false,
            isMuted: true,
            volume: 0,
          }),
        'companion preview reset failed',
      );
    }
    companionPreviewStopPendingRef.current = false;
    setShowCompanionPreviewReplay(true);
  }, [
    companionSelfiePlayer,
    getParentPreviewStartMs,
    getParentPreviewPlaybackVolume,
    isVideoParent,
    unloadPreviewAudio,
  ]);

  // Selfie preview finishes when expo-video reports it played to the end. The stop-pending guard
  // inside finishCompanionPreview de-dupes with the parent-driven finish for video parents.
  useEffect(() => {
    const subscription = companionSelfiePlayer.addListener('playToEnd', () => {
      void finishCompanionPreview();
    });
    return () => subscription.remove();
  }, [companionSelfiePlayer, finishCompanionPreview]);

  // Diagnostic instrumentation for the selfie preview player. expo-video emits these only on
  // transitions, so they are low-noise. statusChange surfaces readyToPlay/error; playingChange
  // confirms whether the AVPlayer actually started (vs. hanging on a frozen first frame).
  useEffect(() => {
    const statusSub = companionSelfiePlayer.addListener('statusChange', (payload) => {
      logReactionDebug('selfie-preview:player-status', {
        status: payload.status,
        oldStatus: payload.oldStatus,
        error: payload.error?.message,
      });
    });
    const playingSub = companionSelfiePlayer.addListener('playingChange', (payload) => {
      let currentTime: number | undefined;
      let duration: number | undefined;
      try {
        currentTime = companionSelfiePlayer.currentTime;
        duration = companionSelfiePlayer.duration;
      } catch {
        /* player may be released */
      }
      logReactionDebug('selfie-preview:player-playing', {
        isPlaying: payload.isPlaying,
        currentTime,
        duration,
      });

      // Recover from the expo-camera teardown interruption (iOS only — this targets the iOS
      // AVCaptureSession deferred teardown; Android's media stack does not have this failure mode
      // and must not be restarted out from under itself). If the player paused while we still
      // expect it to be playing, the clip is not finishing (no stop pending), and we are not near
      // the end, the OS interrupted us — restart from the top. The interruption is a one-time event
      // per preview, so a single restart almost always lands cleanly; we cap attempts to avoid any
      // chance of a restart loop.
      if (Platform.OS !== 'ios') return;
      if (payload.isPlaying) return;
      if (!selfiePreviewExpectPlayingRef.current) return;
      if (companionPreviewStopPendingRef.current) return;
      const dur = typeof duration === 'number' ? duration : 0;
      const pos = typeof currentTime === 'number' ? currentTime : 0;
      const reachedEnd = dur > 0 && pos >= dur - 0.35;
      if (reachedEnd) return;

      // If playback advanced meaningfully since the last interruption, we're making forward progress
      // (a long clip can take several interruptions while the audio session settles), so reset the
      // stall counter. We only give up when stuck at roughly the same spot repeatedly.
      if (pos > selfiePreviewLastResumePosRef.current + 0.4) {
        selfiePreviewResumeAttemptsRef.current = 0;
      }
      selfiePreviewLastResumePosRef.current = pos;

      if (selfiePreviewResumeAttemptsRef.current >= 3) {
        logReactionDebug('selfie-preview:resume-giveup', { pos, dur });
        return;
      }
      selfiePreviewResumeAttemptsRef.current += 1;
      logReactionDebug('selfie-preview:resume', {
        attempt: selfiePreviewResumeAttemptsRef.current,
        pos,
        dur,
      });
      if (selfiePreviewResumeTimerRef.current) {
        clearTimeout(selfiePreviewResumeTimerRef.current);
      }
      selfiePreviewResumeTimerRef.current = setTimeout(() => {
        selfiePreviewResumeTimerRef.current = null;
        if (!selfiePreviewExpectPlayingRef.current || companionPreviewStopPendingRef.current) return;
        try {
          // Resume from where it paused (do NOT seek to 0) so each recovery advances the clip
          // instead of replaying the first second over and over.
          companionSelfiePlayer.play();
        } catch {
          /* player may be released */
        }
      }, 140);
    });
    return () => {
      statusSub.remove();
      playingSub.remove();
    };
  }, [companionSelfiePlayer]);

  const startCompanionPreview = useCallback(async () => {
    const isSelfiePreview = reactionMode === 'selfie' && !!recordedUri;
    const isVoicePreview = reactionMode === 'voice' && !!voiceRecordedUri;
    const isTypedPreview = reactionMode === 'typed' && !!typedMessage.trim();
    if (!isSelfiePreview && !isVoicePreview && !isTypedPreview) return;

    logReactionDebug('selfie-preview:enter', {
      isSelfiePreview,
      isVoicePreview,
      isTypedPreview,
    });

    setCompanionPreviewPlaying(true);
    setShowCompanionPreviewReplay(false);
    companionPreviewStopPendingRef.current = false;

    const parentPreviewPlaybackVolume = getParentPreviewPlaybackVolume();
    const parentPreviewStartMs = getParentPreviewStartMs();

    try {
      await configureConnectPlaybackAudioSessionAsync({ retries: 2 });
    } catch (error) {
      console.warn('[ReactionSheet] preview audio session failed:', error);
    }

    if (isVideoParent && parentPreviewStartMs != null) {
      await runVideoCommand(
        () =>
          companionParentRef.current?.setStatusAsync({
            positionMillis: parentPreviewStartMs,
            shouldPlay: true,
            isMuted: false,
            volume: parentPreviewPlaybackVolume,
          }),
        'failed to start companion preview',
      );
    }

    if (isSelfiePreview) {
      if (Platform.OS === 'ios') {
        // iOS (old architecture): expo-camera's AVCaptureSession keeps holding the global audio
        // session after the CameraView unmounts, and its deferred teardown calls
        // AVAudioSession.setActive(false) ~0.6-1s later, which interrupts whatever is playing.
        // releaseConnectCaptureAudioAsync waits out OSStatus 561017449 to bring up a clean playback
        // session here; it reduces, but does not eliminate, that deferred interruption — the
        // playingChange recovery (selfiePreviewExpectPlayingRef) restarts the clip if it still hits.
        await releaseConnectCaptureAudioAsync();

        if (isVideoParent) {
          // Video parent: the parent video is also playing, so the selfie must coexist with it.
          try {
            companionSelfiePlayer.audioMixingMode = 'mixWithOthers';
          } catch (error) {
            console.warn('[ReactionSheet] selfie preview player unavailable:', error);
            selfiePreviewExpectPlayingRef.current = false;
            setCompanionPreviewPlaying(false);
            setShowCompanionPreviewReplay(true);
            return;
          }
        } else {
          // Image parent: nothing else needs audio, so give expo-video an exclusive, full-volume
          // session instead of mixing/ducking. Release our own expo-audio playback session (just
          // re-activated by releaseConnectCaptureAudioAsync) first.
          try {
            await setIsAudioActiveAsync(false);
          } catch {
            /* best effort: if our session was not active, expo-video still owns playback */
          }
          // Brief settle so the deactivation lands before expo-video activates its own session.
          await new Promise((resolve) => setTimeout(resolve, 120));
          try {
            companionSelfiePlayer.audioMixingMode = 'auto';
          } catch (error) {
            console.warn('[ReactionSheet] selfie preview player unavailable:', error);
            selfiePreviewExpectPlayingRef.current = false;
            setCompanionPreviewPlaying(false);
            setShowCompanionPreviewReplay(true);
            return;
          }
        }
      }
      // Arm interruption recovery before starting: the playingChange listener will resume the clip
      // if expo-camera's deferred teardown interrupts playback in the next ~1s.
      selfiePreviewResumeAttemptsRef.current = 0;
      selfiePreviewLastResumePosRef.current = 0;
      selfiePreviewExpectPlayingRef.current = true;
      try {
        companionSelfiePlayer.currentTime = 0;
        companionSelfiePlayer.play();
        logReactionDebug('selfie-preview:start', { isVideoParent });
      } catch (error) {
        console.warn('[ReactionSheet] selfie preview playback failed:', error);
        selfiePreviewExpectPlayingRef.current = false;
        setCompanionPreviewPlaying(false);
        setShowCompanionPreviewReplay(true);
        if (isVideoParent) {
          await runVideoCommand(
            () => companionParentRef.current?.pauseAsync(),
            'companion preview pause failed',
          );
        }
        return;
      }
    }

    if (isVoicePreview && voiceRecordedUri) {
      try {
        await playCompanionPreviewClip(voiceRecordedUri, () => {
          void finishCompanionPreview();
        });
      } catch (error) {
        console.warn('[ReactionSheet] voice preview playback failed:', error);
        setCompanionPreviewPlaying(false);
      }
    }

    if (isTypedPreview) {
      if (!currentExplorerId) {
        setCompanionPreviewPlaying(false);
        Alert.alert('Explorer Not Ready', 'Please wait for the Explorer profile to load before previewing.');
        return;
      }
      setTypedPreviewLoading(true);
      try {
        const trimmed = typedMessage.trim();
        const companionName = companionAvatar?.companionName || 'Companion';
        const spokenPreviewKey = formatTypedReactionSpeechText(companionName, trimmed);
        let audioUri = typedPreviewAudioUriRef.current;
        if (typedPreviewMessageRef.current !== spokenPreviewKey || !audioUri) {
          const { captionVoice } = await loadVoicePreferences();
          audioUri = await generateTypedReactionAudio(
            trimmed,
            currentExplorerId,
            captionVoice,
            companionName,
          );
          typedPreviewAudioUriRef.current = audioUri;
          typedPreviewMessageRef.current = spokenPreviewKey;
        }
        await playCompanionPreviewClip(audioUri, () => {
          void finishCompanionPreview();
        });
      } catch (error) {
        console.warn('[ReactionSheet] typed preview TTS failed:', error);
        setCompanionPreviewPlaying(false);
        Alert.alert(
          'Preview Unavailable',
          'Could not generate AI voice for your message. Please try again.',
        );
      } finally {
        setTypedPreviewLoading(false);
      }
    }
  }, [
    companionAvatar?.companionName,
    companionSelfiePlayer,
    currentExplorerId,
    finishCompanionPreview,
    getParentPreviewPlaybackVolume,
    getParentPreviewStartMs,
    isVideoParent,
    playCompanionPreviewClip,
    reactionMode,
    recordedUri,
    typedMessage,
    voiceRecordedUri,
  ]);

  const replayCompanionPreview = useCallback(() => {
    setShowCompanionPreviewReplay(false);
    void startCompanionPreview();
  }, [startCompanionPreview]);

  const openHowItWorks = useCallback(() => setIsInfoOpen(true), []);
  const closeHowItWorks = useCallback(() => setIsInfoOpen(false), []);

  const openCompanionPreview = useCallback(() => {
    setCompanionPreviewOpen(true);
  }, []);

  const closeCompanionPreview = useCallback(() => {
    selfiePreviewExpectPlayingRef.current = false;
    setCompanionPreviewOpen(false);
    setCompanionPreviewPlaying(false);
    setShowCompanionPreviewReplay(false);
    companionPreviewStopPendingRef.current = false;
    setTypedPreviewLoading(false);
    try {
      companionSelfiePlayer.pause();
    } catch {
      /* player may be released */
    }
    void companionParentRef.current?.pauseAsync().catch(() => {});
    void (async () => {
      await unloadPreviewAudio();
      await restoreReactionRecordingAudioSession();
    })();
  }, [companionSelfiePlayer, restoreReactionRecordingAudioSession, unloadPreviewAudio]);

  const handleAbandonReaction = useCallback(() => {
    if (isUploading) return;
    selfiePreviewExpectPlayingRef.current = false;
    setCompanionPreviewOpen(false);
    setCompanionPreviewPlaying(false);
    setShowCompanionPreviewReplay(false);
    setTypedPreviewLoading(false);
    companionPreviewStopPendingRef.current = false;
    typedPreviewAudioUriRef.current = null;
    typedPreviewMessageRef.current = null;
    void unloadPreviewAudio();
    try {
      companionSelfiePlayer.pause();
    } catch {
      /* player may be released */
    }
    void companionParentRef.current?.pauseAsync().catch(() => {});
    void videoRef.current?.pauseAsync().catch(() => {});
    onClose();
  }, [companionSelfiePlayer, isUploading, onClose, unloadPreviewAudio]);

  useEffect(() => {
    if (!companionPreviewOpen) return;
    if (reactionMode === 'selfie' && recordedUri) {
      void startCompanionPreview();
      return;
    }
    if (reactionMode === 'voice' && voiceRecordedUri) {
      void startCompanionPreview();
      return;
    }
    if (reactionMode === 'typed' && typedMessage.trim()) {
      void startCompanionPreview();
    }
  }, [companionPreviewOpen, reactionMode, recordedUri, typedMessage, voiceRecordedUri, startCompanionPreview]);

  const handleCompanionParentStatusUpdate = useCallback(
    (status: AVPlaybackStatus) => {
      if (!status.isLoaded || !companionPreviewOpen || !companionPreviewPlaying || !isVideoParent) {
        return;
      }
      const now = Date.now();
      const parentPreviewPlaybackVolume = getParentPreviewPlaybackVolume();
      if (now - lastCompanionParentVolumeApplyRef.current >= 200) {
        lastCompanionParentVolumeApplyRef.current = now;
        void companionParentRef.current
          ?.setIsMutedAsync(false)
          .then(() => companionParentRef.current?.setVolumeAsync(parentPreviewPlaybackVolume))
          .catch(() => {});
      }
      if (!status.isPlaying) return;
      const parentPreviewStartMs = getParentPreviewStartMs();
      if (parentPreviewStartMs == null) return;
      const previewEndMs =
        reactionMode === 'selfie' && syncEndTimeMillis != null
          ? syncEndTimeMillis
          : parentPreviewStartMs + (status.durationMillis ?? durationMillisRef.current);
      if (
        reactionMode === 'selfie' &&
        previewEndMs > parentPreviewStartMs &&
        status.positionMillis >= previewEndMs - PREVIEW_END_EPSILON_MS
      ) {
        void finishCompanionPreview();
      }
    },
    [
      companionPreviewOpen,
      companionPreviewPlaying,
      finishCompanionPreview,
      getParentPreviewPlaybackVolume,
      getParentPreviewStartMs,
      isVideoParent,
      reactionMode,
      syncEndTimeMillis,
    ],
  );

  const SEEK_TOLERANCE = useMemo(
    () => ({ toleranceMillisBefore: 0, toleranceMillisAfter: 0 }),
    [],
  );

  useEffect(() => {
    durationMillisRef.current = durationMillis;
  }, [durationMillis]);

  useEffect(() => {
    positionMillisRef.current = positionMillis;
  }, [positionMillis]);

  useEffect(() => {
    trimStartMsRef.current = trimStartMs;
  }, [trimStartMs]);

  useEffect(() => {
    trimEndMsRef.current = trimEndMs;
  }, [trimEndMs]);

  useEffect(() => {
    isParentReflectionMutedRef.current = isParentReflectionMuted;
  }, [isParentReflectionMuted]);

  useEffect(() => {
    hasHeadphonesRef.current = hasHeadphones;
  }, [hasHeadphones]);

  // Default Original audio: on with headphones, off on speaker.
  useEffect(() => {
    if (!visible || userToggledMuteRef.current) return;
    const enabled = defaultReactionOriginalAudioEnabled({ hasHeadphones });
    setIsParentReflectionMuted(!enabled);
    isParentReflectionMutedRef.current = !enabled;
  }, [visible, hasHeadphones]);

  useEffect(() => {
    typedPreviewAudioUriRef.current = null;
    typedPreviewMessageRef.current = null;
    setTypedMessageReady(false);
  }, [typedMessage]);

  const commitTypedMessage = useCallback(() => {
    if (!typedMessage.trim()) return;
    setTypedMessageReady(true);
    Keyboard.dismiss();
  }, [typedMessage]);

  useEffect(() => {
    if (!visible || reactionMode !== 'typed') {
      setIsTypedKeyboardVisible(false);
      return;
    }
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, () => setIsTypedKeyboardVisible(true));
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setIsTypedKeyboardVisible(false);
      // Android fires spurious keyboard events when KeyboardAvoidingView resizes;
      // typedMessageReady is explicit so layout cannot oscillate.
      if (Platform.OS === 'android' && typedMessage.trim()) {
        setTypedMessageReady(true);
      }
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [reactionMode, typedMessage, visible]);

  useEffect(() => {
    if (!visible || !currentExplorerId || !user?.uid) {
      setResolvedCompanionAvatarUrl(null);
      return;
    }
    const match = companions.find((c) => c.userId === user.uid);
    if (match?.avatarUrl) {
      setResolvedCompanionAvatarUrl(match.avatarUrl);
      return;
    }
    const s3Key = activeRelationship?.companionAvatarS3Key;
    if (!s3Key) {
      setResolvedCompanionAvatarUrl(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `${API_ENDPOINTS.GET_S3_URL}?explorer_id=${currentExplorerId}&event_id=${user.uid}&filename=avatar.jpg&path=avatars&method=GET`,
        );
        if (!res.ok || cancelled) return;
        const { url } = await res.json();
        if (!cancelled) setResolvedCompanionAvatarUrl(url ?? null);
      } catch {
        if (!cancelled) setResolvedCompanionAvatarUrl(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeRelationship?.companionAvatarS3Key, companions, currentExplorerId, user?.uid, visible]);

  useEffect(() => {
    isPreviewPlayingRef.current = isPreviewPlaying;
  }, [isPreviewPlaying]);

  useEffect(() => {
    if (durationMillis <= MIN_TRIM_GAP_MS) return;
    setTrimEndMs((prev) => {
      const next = prev <= MIN_TRIM_GAP_MS ? durationMillis : Math.min(prev, durationMillis);
      trimEndMsRef.current = next;
      return next;
    });
  }, [durationMillis]);

  useEffect(() => {
    canScrubRef.current =
      reactionMode === 'selfie' && isVideoParent && !isRecording && recordedUri == null;
  }, [isRecording, isVideoParent, reactionMode, recordedUri]);

  useEffect(() => {
    if (!visible) return;
    void (async () => {
      const micGranted = await ensureMicPermissionAsync();
      setMicReady(micGranted);
      try {
        if (Platform.OS === 'ios') {
          await configureConnectReactionRecordingAudioSessionAsync();
        }
      } catch (error) {
        console.warn('[ReactionSheet] initial audio session failed:', error);
      }
      let current = await Camera.getCameraPermissionsAsync();
      if (!current.granted && current.canAskAgain) {
        current = await Camera.requestCameraPermissionsAsync();
      }
      void requestCameraPermission();
      setNativeCameraGranted(current.granted);
    })();
  }, [visible, requestCameraPermission]);

  useEffect(() => {
    if (!visible || !isVideoParent || reactionMode !== 'selfie') return;
    void configureConnectReactionRecordingAudioSessionAsync().catch((error) => {
      console.warn('[ReactionSheet] video selfie audio pre-warm failed:', error);
    });
  }, [visible, isVideoParent, reactionMode]);

  const bumpCameraInstance = useCallback(() => {
    setCameraReady(false);
    setCameraInstanceKey((key) => key + 1);
  }, []);

  const scheduleAndroidCameraRemount = useCallback(() => {
    if (Platform.OS !== 'android') return;
    if (androidCameraRemountTimerRef.current) {
      clearTimeout(androidCameraRemountTimerRef.current);
    }
    logReactionDebug('camera:schedule-remount');
    setIsCameraRestoring(true);
    androidCameraRemountTimerRef.current = setTimeout(() => {
      androidCameraRemountTimerRef.current = null;
      logReactionDebug('camera:remount');
      bumpCameraInstance();
    }, ANDROID_CAMERA_REMOUNT_MS);
  }, [bumpCameraInstance]);

  const ensureCameraPermission = useCallback(async () => {
    let current = await Camera.getCameraPermissionsAsync();
    if (!current.granted && current.canAskAgain) {
      current = await Camera.requestCameraPermissionsAsync();
    }
    void requestCameraPermission();
    setNativeCameraGranted(current.granted);
    return current.granted;
  }, [requestCameraPermission]);

  const handleGrantCameraAccess = useCallback(async () => {
    const current = await Camera.getCameraPermissionsAsync();
    if (current.granted) {
      setNativeCameraGranted(true);
      void requestCameraPermission();
      scheduleAndroidCameraRemount();
      return;
    }

    if (current.canAskAgain) {
      const requested = await Camera.requestCameraPermissionsAsync();
      void requestCameraPermission();
      setNativeCameraGranted(requested.granted);
      if (requested.granted) {
        scheduleAndroidCameraRemount();
        return;
      }
    }

    Alert.alert(
      'Camera Access Needed',
      'To record a selfie reaction, allow camera access in Settings.',
      [
        { text: 'Open Settings', onPress: () => void Linking.openSettings() },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }, [requestCameraPermission, scheduleAndroidCameraRemount]);

  useEffect(() => {
    if (!visible || reactionMode !== 'selfie') return;
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        // Re-acquire the camera: flipping `active` back to true (via isAppForeground) re-binds the
        // CameraX preview cleanly. Show the warmup overlay until onCameraReady clears it.
        setIsAppForeground(true);
        void ensureCameraPermission();
        if (Platform.OS === 'android') {
          setIsCameraRestoring(true);
        }
        return;
      }
      // Backgrounded/inactive: drop `active` so CameraX releases the camera cleanly. Keeping it
      // active across background is what left the Android preview black (and un-remountable) on
      // resume.
      setIsAppForeground(false);
      if (isRecordingRef.current) {
        stopSelfieRecordingRef.current?.();
      }
    });
    return () => subscription.remove();
  }, [visible, reactionMode, ensureCameraPermission]);

  const handleModalShow = useCallback(() => {
    if (reactionMode !== 'selfie') return;
    if (Platform.OS === 'android') {
      // Remounting on every modal show often leaves a zero-size SurfaceView (black box).
      return;
    }
    bumpCameraInstance();
  }, [bumpCameraInstance, reactionMode]);

  useEffect(() => {
    if (!visible || reactionMode !== 'selfie' || Platform.OS !== 'android') return;
    if (!isCameraRestoring) return;

    const cameraGranted =
      cameraPermission?.granted === true || nativeCameraGranted === true;
    const selfieCameraActive =
      visible &&
      reactionMode === 'selfie' &&
      !isUploading &&
      !companionPreviewOpen &&
      !recordedUri &&
      !isSelfieSaving &&
      isAppForeground;

    logReactionDebug('camera:restoring-start', {
      cameraInstanceKey,
      isCameraGranted: cameraGranted,
    });

    const timer = setTimeout(() => {
      logReactionDebug(
        'camera:ready-timeout',
        {
          cameraInstanceKey,
          isCameraGranted: cameraGranted,
          isSelfieCameraActive: selfieCameraActive,
          isAppForeground,
        },
        'warn',
      );
    }, 5000);

    return () => clearTimeout(timer);
  }, [
    cameraInstanceKey,
    cameraPermission?.granted,
    companionPreviewOpen,
    isAppForeground,
    isCameraRestoring,
    isSelfieSaving,
    isUploading,
    nativeCameraGranted,
    reactionMode,
    recordedUri,
    visible,
  ]);

  useEffect(() => {
    if (!visible || reactionMode !== 'selfie' || recordedUri != null) return;
    if (!(cameraPermission?.granted || nativeCameraGranted)) return;

    if (Platform.OS === 'android') {
      const readyTimer = setTimeout(() => {
        setCameraReady((ready) => ready || true);
      }, 400);
      const fallbackTimer = setTimeout(() => {
        setCameraReady(true);
        setIsCameraRestoring(false);
      }, 2000);
      return () => {
        clearTimeout(readyTimer);
        clearTimeout(fallbackTimer);
      };
    }

    setCameraReady(false);
    const readyTimer = setTimeout(() => {
      setCameraReady(true);
    }, 500);
    // Safety: onCameraReady can fail to fire on iOS if the AVAudioSession was still held by
    // the capture session, which would otherwise leave the "Starting camera…" overlay stuck.
    const restoreClearTimer = setTimeout(() => {
      setIsCameraRestoring(false);
    }, 2200);

    return () => {
      clearTimeout(readyTimer);
      clearTimeout(restoreClearTimer);
    };
  }, [
    visible,
    reactionMode,
    recordedUri,
    cameraInstanceKey,
    cameraPermission?.granted,
    nativeCameraGranted,
  ]);

  useEffect(() => {
    if (visible) return;
    setIsRecording(false);
    setPositionMillis(0);
    setDurationMillis(0);
    setRecordedUri(null);
    setIsSelfieSaving(false);
    cameraRecordingStartedRef.current = false;
    setRecordedAudioSnapshot(null);
    setSyncStartTimeMillis(null);
    setSyncEndTimeMillis(null);
    setIsPreviewPlaying(false);
    setCompanionPreviewOpen(false);
    setCompanionPreviewPlaying(false);
    setShowCompanionPreviewReplay(false);
    companionPreviewStopPendingRef.current = false;
    selfiePreviewExpectPlayingRef.current = false;
    if (selfiePreviewResumeTimerRef.current) {
      clearTimeout(selfiePreviewResumeTimerRef.current);
      selfiePreviewResumeTimerRef.current = null;
    }
    setTrimStartMs(0);
    setTrimEndMs(0);
    trimStartMsRef.current = 0;
    trimEndMsRef.current = 0;
    setIsParentReflectionMuted(false);
    isParentReflectionMutedRef.current = false;
    userToggledMuteRef.current = false;
    setReactionMode('selfie');
    setTypedMessage('');
    setTypedMessageReady(false);
    setVoiceRecordedUri(null);
    setIsVoiceRecording(false);
    setIsStartingVoiceRecording(false);
    setIsVoiceProcessing(false);
    setCameraInstanceKey(0);
    setNativeCameraGranted(null);
    if (androidCameraRemountTimerRef.current) {
      clearTimeout(androidCameraRemountTimerRef.current);
      androidCameraRemountTimerRef.current = null;
    }
    isVideoDragActiveRef.current = false;
    previewStopPendingRef.current = false;
    pendingSeekTargetRef.current = null;
    seekChainRef.current = Promise.resolve();
    setCameraReady(false);
    setIsCameraRestoring(false);
    setIsUploading(false);
    recordingPromiseRef.current = null;
    recordingAudioReassertCancelRef.current?.();
    recordingAudioReassertCancelRef.current = null;
    isRecordingRef.current = false;
    isStartingVoiceRecordingRef.current = false;
    void (async () => {
      try {
        if (voiceExpoAvRecordingRef.current) {
          await voiceExpoAvRecordingRef.current.stopAndUnloadAsync();
        }
      } catch {
        /* ignore */
      }
      voiceExpoAvRecordingRef.current = null;
      await unloadPreviewAudio();
    })();
    typedPreviewAudioUriRef.current = null;
    typedPreviewMessageRef.current = null;
    void videoRef.current?.pauseAsync().catch(() => {});
    void videoRef.current?.setVolumeAsync(1).catch(() => {});
    cameraRef.current?.stopRecording();
  }, [visible]);

  useEffect(() => {
    if (!isVideoParent || isRecording || recordedUri != null) return;
    if (isPreviewPlayingRef.current) return;
    void applyParentReflectionVolume();
  }, [
    applyParentReflectionVolume,
    hasHeadphones,
    isParentReflectionMuted,
    isPreviewPlaying,
    isRecording,
    isVideoParent,
    recordedUri,
  ]);

  const clampTrimStart = useCallback((startMs: number) => {
    const end = trimEndMsRef.current || durationMillisRef.current;
    if (end <= MIN_TRIM_GAP_MS) return 0;
    return Math.max(0, Math.min(startMs, end - MIN_TRIM_GAP_MS));
  }, []);

  const setReactionStartMs = useCallback(
    (startMs: number) => {
      const clamped = clampTrimStart(startMs);
      setTrimStartMs(clamped);
      trimStartMsRef.current = clamped;
      positionMillisRef.current = clamped;
      setPositionMillis(clamped);
      return clamped;
    },
    [clampTrimStart],
  );

  const queueVideoSeek = useCallback(
    (targetMs: number, options?: { updateUi?: boolean }) => {
      if (!isVideoParent || isRecording) return seekChainRef.current;

      const end = trimEndMsRef.current || durationMillisRef.current;
      const target = Math.max(0, Math.min(targetMs, end));

      if (options?.updateUi !== false) {
        positionMillisRef.current = target;
        setPositionMillis(target);
      }

      pendingSeekTargetRef.current = target;

      seekChainRef.current = seekChainRef.current
        .then(async () => {
          while (pendingSeekTargetRef.current != null) {
            const nextTarget = pendingSeekTargetRef.current;
            pendingSeekTargetRef.current = null;
            await runVideoCommand(
              () => videoRef.current?.setPositionAsync(nextTarget, SEEK_TOLERANCE),
              'seek failed',
            );
          }
        })
        .catch(() => {});

      return seekChainRef.current;
    },
    [SEEK_TOLERANCE, isRecording, isVideoParent],
  );

  const commitVideoPosition = useCallback(
    async (
      targetMs: number,
      options?: { shouldPlay?: boolean; volume?: number },
    ) => {
      const end = trimEndMsRef.current || durationMillisRef.current;
      const target = Math.max(0, Math.min(targetMs, end));
      positionMillisRef.current = target;
      setPositionMillis(target);

      if (options?.shouldPlay != null) {
        const muted = isParentReflectionMutedRef.current;
        const volume = options.volume ?? getReactionParentVolume();
        await runVideoCommand(
          () =>
            videoRef.current?.setStatusAsync({
              positionMillis: target,
              shouldPlay: options.shouldPlay,
              isMuted: muted,
              volume,
            }),
          'commit seek failed',
        );
        return;
      }

      void queueVideoSeek(target, { updateUi: false });
    },
    [getReactionParentVolume, queueVideoSeek],
  );

  const stopPreviewAtTrimEnd = useCallback(async () => {
    if (!isVideoParent || previewStopPendingRef.current || !isPreviewPlayingRef.current) return;
    previewStopPendingRef.current = true;
    setIsPreviewPlaying(false);
    isPreviewPlayingRef.current = false;
    const start = trimStartMsRef.current;
    positionMillisRef.current = start;
    setPositionMillis(start);
    try {
      await runVideoCommand(() => videoRef.current?.pauseAsync(), 'preview pause failed');
      await runVideoCommand(
        () =>
          videoRef.current?.setStatusAsync({
            positionMillis: start,
            shouldPlay: false,
            isMuted: isParentReflectionMutedRef.current,
            volume: getReactionParentVolume(),
          }),
        'preview stop failed',
      );
    } finally {
      previewStopPendingRef.current = false;
    }
  }, [getReactionParentVolume, isVideoParent]);

  const handlePlaybackStatusUpdate = useCallback(
    (status: AVPlaybackStatus) => {
      if (!status.isLoaded) return;

      const duration = status.durationMillis ?? 0;
      if (duration > 0) {
        setDurationMillis(duration);
        durationMillisRef.current = duration;
      }

      if (recordedUri && isVideoParent) {
        return;
      }

      const recordingActive = isRecordingRef.current && isVideoParent;
      const previewActive =
        isPreviewPlayingRef.current &&
        isVideoParent &&
        !recordingActive &&
        !recordedUri;

      // Idle/recording volume only — preview audio is set imperatively in toggleParentPlayback.
      if (isVideoParent && !recordingActive && !previewActive) {
        const now = Date.now();
        if (now - lastParentVolumeApplyRef.current >= 200) {
          lastParentVolumeApplyRef.current = now;
          void applyParentReflectionVolume();
        }
      }

      if (recordingActive) {
        if (!isScrubbingRef.current) {
          positionMillisRef.current = status.positionMillis;
          setPositionMillis(status.positionMillis);
        }
        return;
      }

      if (!isVideoParent) return;

      // Track playhead during intentional preview even while Android buffers (isPlaying may lag).
      if (previewActive && !isScrubbingRef.current) {
        positionMillisRef.current = status.positionMillis;
        setPositionMillis(status.positionMillis);
      }

      if (previewActive && status.isPlaying && !isScrubbingRef.current) {
        const end = trimEndMsRef.current || duration;
        if (
          end > trimStartMsRef.current &&
          status.positionMillis >= end - PREVIEW_END_EPSILON_MS &&
          status.positionMillis > trimStartMsRef.current + PREVIEW_END_EPSILON_MS
        ) {
          void stopPreviewAtTrimEnd();
        }
      }

      // Do not infer "paused" from transient !isPlaying while previewActive — that race was
      // clearing preview state before playback started and freezing the scrubber on Android.
    },
    [
      applyParentReflectionVolume,
      isVideoParent,
      stopPreviewAtTrimEnd,
      recordedUri,
    ],
  );

  const pauseParentPreview = useCallback(async () => {
    if (!isVideoParent) return;
    setIsPreviewPlaying(false);
    isPreviewPlayingRef.current = false;
    await runVideoCommand(() => videoRef.current?.pauseAsync(), 'pause preview failed');
  }, [isVideoParent]);

  const startParentTrimPreview = useCallback(async () => {
    if (!isVideoParent || isRecordingRef.current || recordedUri) return false;

    const status = await videoRef.current?.getStatusAsync().catch(() => null);
    if (!status?.isLoaded) return false;

    try {
      await configureConnectPlaybackAudioSessionAsync({ retries: 2 });
    } catch (error) {
      console.warn('[ReactionSheet] trim preview audio session failed:', error);
    }

    const start = trimStartMsRef.current;
    positionMillisRef.current = start;
    setPositionMillis(start);
    const previewVolume = getParentPreviewPlaybackVolume();

    isPreviewPlayingRef.current = true;
    setIsPreviewPlaying(true);

    try {
      await videoRef.current?.setStatusAsync({
        positionMillis: start,
        shouldPlay: false,
        isMuted: false,
        volume: previewVolume,
      });
      await videoRef.current?.playAsync();
    } catch (error) {
      if (!isSeekInterrupted(error)) {
        console.warn('[ReactionSheet] start trim preview failed:', error);
      }
      isPreviewPlayingRef.current = false;
      setIsPreviewPlaying(false);
      return false;
    }

    return true;
  }, [getParentPreviewPlaybackVolume, isVideoParent, recordedUri]);

  const toggleParentPlayback = useCallback(async () => {
    if (!isVideoParent || isRecording || recordedUri) return;
    if (parentPreviewToggleBusyRef.current) return;
    parentPreviewToggleBusyRef.current = true;

    try {
      if (isPreviewPlayingRef.current) {
        await pauseParentPreview();
        const start = trimStartMsRef.current;
        await commitVideoPosition(start, {
          shouldPlay: false,
          volume: getReactionParentVolume(),
        });
        return;
      }

      await startParentTrimPreview();
    } finally {
      parentPreviewToggleBusyRef.current = false;
    }
  }, [
    commitVideoPosition,
    getReactionParentVolume,
    isRecording,
    isVideoParent,
    pauseParentPreview,
    recordedUri,
    startParentTrimPreview,
  ]);

  // expo-av progress callbacks can stall while the player buffers; poll during preview so the
  // trim scrubber tracks like ReflectionComposer's expo-video timeUpdate listener.
  useEffect(() => {
    if (!isPreviewPlaying || !isVideoParent || isRecording || recordedUri) return;

    let cancelled = false;
    const pollPlayhead = async () => {
      if (cancelled || isScrubbingRef.current || !isPreviewPlayingRef.current) return;
      const status = await videoRef.current?.getStatusAsync().catch(() => null);
      if (!status?.isLoaded || cancelled || isScrubbingRef.current) return;
      positionMillisRef.current = status.positionMillis;
      setPositionMillis(status.positionMillis);

      const duration = status.durationMillis ?? durationMillisRef.current;
      const end = trimEndMsRef.current || duration;
      if (
        status.isPlaying &&
        end > trimStartMsRef.current &&
        status.positionMillis >= end - PREVIEW_END_EPSILON_MS &&
        status.positionMillis > trimStartMsRef.current + PREVIEW_END_EPSILON_MS
      ) {
        void stopPreviewAtTrimEnd();
      }
    };

    void pollPlayhead();
    const interval = setInterval(() => {
      void pollPlayhead();
    }, 250);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isPreviewPlaying, isRecording, isVideoParent, recordedUri, stopPreviewAtTrimEnd]);

  const toggleParentReflectionMute = useCallback(() => {
    userToggledMuteRef.current = true;
    setIsParentReflectionMuted((prev) => {
      const next = !prev;
      isParentReflectionMutedRef.current = next;
      return next;
    });
  }, []);

  const handleTrimChange = useCallback(
    (start: number, end: number) => {
      setTrimStartMs(start);
      setTrimEndMs(end);
      trimStartMsRef.current = start;
      trimEndMsRef.current = end;
      if (!isPreviewPlaying) {
        positionMillisRef.current = start;
        setPositionMillis(start);
      }
    },
    [isPreviewPlaying],
  );

  const handleSeek = useCallback(
    (nextPositionMillis: number) => {
      positionMillisRef.current = nextPositionMillis;
      setPositionMillis(nextPositionMillis);
      const now = Date.now();
      if (now - lastPanSeekAtRef.current >= 120) {
        lastPanSeekAtRef.current = now;
        void queueVideoSeek(nextPositionMillis, { updateUi: false });
      }
    },
    [queueVideoSeek],
  );

  const handleScrubStart = useCallback(() => {
    isScrubbingRef.current = true;
    void pauseParentPreview();
  }, [pauseParentPreview]);

  const handleScrubEnd = useCallback(() => {
    void (async () => {
      await commitVideoPosition(trimStartMsRef.current, {
        shouldPlay: false,
        volume: getReactionParentVolume(),
      });
      isScrubbingRef.current = false;
    })().catch(() => {});
  }, [commitVideoPosition, getReactionParentVolume]);

  const beginVideoDragScrub = useCallback(() => {
    if (isVideoDragActiveRef.current) return;
    isVideoDragActiveRef.current = true;
    isScrubbingRef.current = true;
    seekOriginMsRef.current = trimStartMsRef.current;
    void pauseParentPreview();
  }, [pauseParentPreview]);

  const handleSeekDragStart = useCallback(() => {
    beginVideoDragScrub();
  }, [beginVideoDragScrub]);

  const handleSeekDrag = useCallback(
    (translationX: number) => {
      if (!canScrubRef.current) return;
      beginVideoDragScrub();

      const width = parentVideoWidthRef.current;
      const duration = durationMillisRef.current;
      if (width <= 0 || duration <= 0) return;

      const deltaMs = (translationX / width) * duration;
      const start = setReactionStartMs(seekOriginMsRef.current + deltaMs);
      const now = Date.now();
      if (now - lastPanSeekAtRef.current >= 120) {
        lastPanSeekAtRef.current = now;
        void queueVideoSeek(start, { updateUi: false });
      }
    },
    [beginVideoDragScrub, queueVideoSeek, setReactionStartMs],
  );

  const handleSeekDragEnd = useCallback(() => {
    void (async () => {
      const start = trimStartMsRef.current;
      await commitVideoPosition(start, {
        shouldPlay: false,
        volume: getReactionParentVolume(),
      });
      isVideoDragActiveRef.current = false;
      isScrubbingRef.current = false;
    })().catch(() => {});
  }, [commitVideoPosition, getReactionParentVolume]);

  const showScrubUi =
    reactionMode === 'selfie' && isVideoParent && recordedUri == null;

  const videoPanGesture = useMemo(() => {
    return Gesture.Pan()
      .activeOffsetX([-8, 8])
      .failOffsetY([-12, 12])
      .onBegin(() => {
        runOnJS(handleSeekDragStart)();
      })
      .onUpdate((event) => {
        runOnJS(handleSeekDrag)(event.translationX);
      })
      .onFinalize(() => {
        runOnJS(handleSeekDragEnd)();
      });
  }, [handleSeekDrag, handleSeekDragEnd, handleSeekDragStart]);

  const beginCameraRecording = useCallback((sessionId: number) => {
    const attachPromise = (recordingPromise: Promise<{ uri: string } | undefined>) => {
      recordingPromiseRef.current = recordingPromise;
      void recordingPromise
        .then((result) => {
          if (recordingPromiseRef.current !== recordingPromise) return;
          recordingPromiseRef.current = null;
          setIsSelfieSaving(false);
          if (result?.uri) {
            setRecordedUri(result.uri);
            setRecordedAudioSnapshot({
              originalAudioMuted: isParentReflectionMutedRef.current,
              hasHeadphones: hasHeadphonesRef.current,
            });
          } else {
            Alert.alert(
              'Recording Too Short',
              'Hold the button a little longer so we can capture your reaction.',
            );
          }
        })
        .catch((error) => {
          if (recordingPromiseRef.current !== recordingPromise) return;
          recordingPromiseRef.current = null;
          cameraRecordingStartedRef.current = false;
          isRecordingRef.current = false;
          setIsRecording(false);
          setIsSelfieSaving(false);
          console.warn('[ReactionSheet] recordAsync failed:', error);
          Alert.alert(
            'Recording Failed',
            'Could not save your selfie reaction. Please try again.',
          );
        });
    };

    type TryStartResult = 'started' | 'retry' | 'cancelled';
    const tryStart = (): TryStartResult => {
      if (recordingSessionIdRef.current !== sessionId || !isRecordingRef.current) {
        return 'cancelled';
      }
      const recordingPromise = cameraRef.current?.recordAsync({ maxDuration: 120 });
      if (!recordingPromise) return 'retry';
      attachPromise(recordingPromise);
      cameraRecordingStartedRef.current = true;
      return 'started';
    };

    const first = tryStart();
    if (first === 'started' || first === 'cancelled') return;

    if (Platform.OS !== 'android') {
      console.warn('[ReactionSheet] recordAsync returned no promise — camera ref missing?');
      isRecordingRef.current = false;
      setIsRecording(false);
      return;
    }

    void (async () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 150 + attempt * 100));
        const result = tryStart();
        if (result === 'started' || result === 'cancelled') return;
      }
      if (recordingSessionIdRef.current !== sessionId || !isRecordingRef.current) return;
      isRecordingRef.current = false;
      setIsRecording(false);
      console.warn('[ReactionSheet] recordAsync never started — camera ref missing?');
      cameraRecordingStartedRef.current = false;
      setIsSelfieSaving(false);
      Alert.alert(
        'Camera Not Ready',
        'Wait for the camera preview to appear, then hold the button again.',
      );
    })();
  }, []);

  const scheduleRecordingParentReasserts = useCallback(
    (sessionId: number, syncStart: number) => {
      const reassertParentPlayback = async () => {
        if (recordingSessionIdRef.current !== sessionId || !isRecordingRef.current) return;
        try {
          await startParentRecordingPlayback(syncStart);
        } catch (error) {
          console.warn('[ReactionSheet] parent playback reassert failed:', error);
        }
      };

      recordingAudioReassertCancelRef.current?.();
      const timers = RECORDING_PARENT_REASSERT_DELAYS_MS.map((delay) =>
        setTimeout(() => {
          void reassertParentPlayback();
        }, delay),
      );
      recordingAudioReassertCancelRef.current = () => {
        for (const timer of timers) {
          clearTimeout(timer);
        }
      };
    },
    [startParentRecordingPlayback],
  );

  const stopSelfieRecording = useCallback(() => {
    if (!isRecordingRef.current) return;

    const sessionId = recordingSessionIdRef.current;
    recordingSessionIdRef.current += 1;
    isRecordingRef.current = false;
    recordingAudioReassertCancelRef.current?.();
    recordingAudioReassertCancelRef.current = null;
    setIsRecording(false);
    setIsSelfieSaving(cameraRecordingStartedRef.current);

    void (async () => {
      const minHoldMs = Platform.OS === 'android' && isVideoParent ? 450 : 0;
      const elapsed = Date.now() - recordingStartedAtRef.current;
      if (minHoldMs > 0 && elapsed < minHoldMs) {
        await new Promise((resolve) => setTimeout(resolve, minHoldMs - elapsed));
      }
      if (recordingSessionIdRef.current !== sessionId + 1) {
        setIsSelfieSaving(false);
        return;
      }
      cameraRef.current?.stopRecording();
    })();

    void (async () => {
      if (isVideoParent) {
        const status = await videoRef.current?.getStatusAsync();
        if (status?.isLoaded) {
          setSyncEndTimeMillis(status.positionMillis);
        }
        await videoRef.current?.pauseAsync().catch(() => {});
        try {
          await new Promise((resolve) => setTimeout(resolve, 200));
          await configureConnectPlaybackAudioSessionAsync({ retries: 3 });
          const postRestoreStatus = await videoRef.current?.getStatusAsync().catch(() => null);
          if (postRestoreStatus?.isLoaded) {
            await syncParentVideoAudioAsync(videoRef.current);
          }
        } catch (error) {
          console.warn('[ReactionSheet] failed to restore playback audio session:', error);
        }
      } else {
        setSyncEndTimeMillis(0);
        if (Platform.OS === 'android') {
          // Camera capture leaves Android's audio session routed for recording, which makes
          // the selfie play back very quietly in preview. Fully release the capture session
          // and reconfigure for playback so the recording plays at normal volume.
          void releaseConnectCaptureAudioAsync().catch(() => {});
        } else {
          // Restore audio session to playback mode in the background so it is already in the
          // correct state when the user opens companion preview.
          void configureConnectPlaybackAudioSessionAsync({ retries: 2 }).catch(() => {});
        }
      }
    })();
  }, [isVideoParent, syncParentVideoAudioAsync]);

  useEffect(() => {
    stopSelfieRecordingRef.current = stopSelfieRecording;
  }, [stopSelfieRecording]);

  const handlePressIn = useCallback(() => {
    if (recordedUri) return;

    const cameraGranted = cameraPermission?.granted || nativeCameraGranted;
    if (!cameraGranted) {
      void ensureCameraPermission();
      return;
    }
    if (Platform.OS !== 'android' && !cameraReady) {
      return;
    }

    const syncStart = isVideoParent ? trimStartMsRef.current : 0;
    const sessionId = recordingSessionIdRef.current + 1;
    recordingSessionIdRef.current = sessionId;
    recordingPromiseRef.current = null;
    recordingStartedAtRef.current = Date.now();
    cameraRecordingStartedRef.current = false;
    setSyncStartTimeMillis(syncStart);
    setIsRecording(true);
    isRecordingRef.current = true;
    setIsPreviewPlaying(false);
    isPreviewPlayingRef.current = false;
    void pauseParentPreview();

    if (!isVideoParent) {
      beginCameraRecording(sessionId);
    }

    void (async () => {
      if (isVideoParent) {
        try {
          await configureConnectReactionRecordingAudioSessionAsync();
          if (recordingSessionIdRef.current !== sessionId || !isRecordingRef.current) return;
          await startParentRecordingPlayback(syncStart);
        } catch (error) {
          console.warn('[ReactionSheet] parent playback during selfie failed:', error);
        }
      }

      const micGranted = micReady || (await ensureMicPermissionAsync());
      setMicReady(micGranted);
      if (!micGranted) {
        if (recordingSessionIdRef.current === sessionId && isRecordingRef.current) {
          isRecordingRef.current = false;
          setIsRecording(false);
          recordingSessionIdRef.current += 1;
          await videoRef.current?.pauseAsync().catch(() => {});
          Alert.alert(
            'Microphone Access Needed',
            'Allow microphone access to record a selfie reaction.',
          );
        }
        return;
      }

      if (!isVideoParent) return;

      if (Platform.OS === 'android') {
        await new Promise((resolve) => setTimeout(resolve, 120));
        if (recordingSessionIdRef.current !== sessionId || !isRecordingRef.current) return;
      }

      if (recordingSessionIdRef.current !== sessionId || !isRecordingRef.current) return;
      beginCameraRecording(sessionId);

      try {
        if (recordingSessionIdRef.current !== sessionId || !isRecordingRef.current) return;
        scheduleRecordingParentReasserts(sessionId, syncStart);
      } catch (error) {
        console.warn('[ReactionSheet] parent playback reassert schedule failed:', error);
      }
    })();
  }, [
    beginCameraRecording,
    cameraPermission?.granted,
    cameraReady,
    ensureCameraPermission,
    isVideoParent,
    micReady,
    nativeCameraGranted,
    recordedUri,
    scheduleRecordingParentReasserts,
    startParentRecordingPlayback,
    pauseParentPreview,
  ]);

  const handlePressOut = useCallback(() => {
    stopSelfieRecording();
  }, [stopSelfieRecording]);

  const resetVoiceRecording = useCallback(() => {
    setVoiceRecordedUri(null);
    setRecordedAudioSnapshot(null);
    setIsVoiceRecording(false);
    setIsStartingVoiceRecording(false);
    setIsVoiceProcessing(false);
    isStartingVoiceRecordingRef.current = false;
    void (async () => {
      try {
        if (voiceExpoAvRecordingRef.current) {
          await voiceExpoAvRecordingRef.current.stopAndUnloadAsync();
        }
      } catch {
        /* ignore */
      }
      voiceExpoAvRecordingRef.current = null;
      try {
        if (voiceRecorder.isRecording) {
          await voiceRecorder.stop();
        }
      } catch {
        /* ignore */
      }
      await unloadPreviewAudio();
    })();
  }, [unloadPreviewAudio, voiceRecorder]);

  const handleReactionModeChange = useCallback(
    (nextMode: ReactionComposeMode) => {
      if (nextMode === reactionMode || isUploading) return;

      if (nextMode !== 'selfie' && androidCameraRemountTimerRef.current) {
        clearTimeout(androidCameraRemountTimerRef.current);
        androidCameraRemountTimerRef.current = null;
      }

      setReactionMode(nextMode);
      setRecordedUri(null);
      setSyncStartTimeMillis(null);
      setSyncEndTimeMillis(null);
      setIsPreviewPlaying(false);
      setIsRecording(false);
      resetVoiceRecording();
      setTypedMessage('');
      setTypedMessageReady(false);
      if (nextMode === 'selfie') {
        logReactionDebug('mode:selfie', { from: reactionMode });
        void ensureCameraPermission();
        if (Platform.OS === 'android') {
          void configureConnectPlaybackAudioSessionAsync({ retries: 1 }).catch((error) => {
            console.warn('[ReactionSheet] selfie mode playback session failed:', error);
          });
        } else {
          bumpCameraInstance();
        }
      }
      if (nextMode === 'voice') {
        void (async () => {
          logReactionDebug('mode:voice', { from: reactionMode });
          const micGranted = await ensureMicPermissionAsync();
          setMicReady(micGranted);
          if (!micGranted) {
            Alert.alert(
              'Microphone Access Needed',
              'Allow microphone access to record a voice reaction.',
            );
            return;
          }
        })();
      }
      if (nextMode === 'selfie' && Platform.OS === 'ios') {
        void configureConnectReactionRecordingAudioSessionAsync().catch((error) => {
          console.warn('[ReactionSheet] selfie mode audio session failed:', error);
        });
      }
      void videoRef.current?.pauseAsync().catch(() => {});
    },
    [
      bumpCameraInstance,
      ensureCameraPermission,
      isUploading,
      reactionMode,
      resetVoiceRecording,
      scheduleAndroidCameraRemount,
    ],
  );

  const handleStartVoiceRecording = useCallback(async () => {
    if (isVoiceRecording || isStartingVoiceRecording || isStartingVoiceRecordingRef.current) {
      return;
    }
    if (Platform.OS !== 'android' && voiceRecorder.isRecording) {
      return;
    }
    isStartingVoiceRecordingRef.current = true;
    setIsStartingVoiceRecording(true);
    logReactionDebug('voice:start-tap', { micReady, isVideoParent, isImageParent });
    try {
      let micGranted = micReady;
      if (!micGranted) {
        micGranted = await ensureMicPermissionAsync();
      }
      setMicReady(micGranted);
      if (!micGranted) {
        Alert.alert(
          'Microphone Access Needed',
          'Allow microphone access to record a voice reaction.',
        );
        return;
      }

      void unloadPreviewAudio();

      if (Platform.OS === 'android') {
        const recording = await startAndroidExpoAvVoiceRecordingAsync({
          isVideoParent,
          trimStartMs: trimStartMsRef.current,
          startParentPlayback:
            isVideoParent && !suppressAndroidParentVideoSurface
              ? startParentRecordingPlayback
              : undefined,
        });
        voiceExpoAvRecordingRef.current = recording;
        setIsVoiceRecording(true);
        return;
      }

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
      if (isVideoParent) {
        await configureConnectReactionRecordingAudioSessionAsync();
        const startMs = trimStartMsRef.current;
        await startParentRecordingPlayback(startMs);
        await startExpoAudioVoiceRecordingAsync(voiceRecorder, { skipSessionConfigure: true });
      } else {
        await startExpoAudioVoiceRecordingAsync(voiceRecorder);
      }
      setIsVoiceRecording(true);
    } catch (error) {
      console.warn('[ReactionSheet] voice record start failed:', error);
      logReactionDebug('voice:start-failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      voiceExpoAvRecordingRef.current = null;
      setIsVoiceRecording(false);
      Alert.alert(
        'Recording Failed',
        error instanceof Error ? error.message : 'Could not start voice recording.',
      );
    } finally {
      isStartingVoiceRecordingRef.current = false;
      setIsStartingVoiceRecording(false);
    }
  }, [
    isStartingVoiceRecording,
    isVideoParent,
    isVoiceRecording,
    micReady,
    startParentRecordingPlayback,
    suppressAndroidParentVideoSurface,
    unloadPreviewAudio,
    voiceRecorder,
  ]);
  const handleStopVoiceRecording = useCallback(async () => {
    if (!isVoiceRecording || isVoiceProcessing) return;
    setIsVoiceProcessing(true);
    logReactionDebug('voice:stop-start');
    try {
      if (isVideoParent) {
        await runVideoCommand(() => videoRef.current?.pauseAsync(), 'voice reaction pause failed');
      }

      let recordingUri: string | null = null;
      if (Platform.OS === 'android' && voiceExpoAvRecordingRef.current) {
        const recording = voiceExpoAvRecordingRef.current;
        voiceExpoAvRecordingRef.current = null;
        await recording.stopAndUnloadAsync();
        recordingUri = recording.getURI();
      } else {
        await voiceRecorder.stop();
        recordingUri = voiceRecorder.uri ?? voiceRecorder.getStatus().url ?? null;
      }

      setIsVoiceRecording(false);
      if (recordingUri) {
        setVoiceRecordedUri(recordingUri);
        setRecordedAudioSnapshot({
          originalAudioMuted: isParentReflectionMutedRef.current,
          hasHeadphones: hasHeadphonesRef.current,
        });
        void configureConnectPlaybackAudioSessionAsync({ retries: 2 }).catch((error) => {
          console.warn('[ReactionSheet] voice playback session reset failed:', error);
        });
      }
    } catch (error) {
      console.warn('[ReactionSheet] voice record stop failed:', error);
      setIsVoiceRecording(false);
      voiceExpoAvRecordingRef.current = null;
    } finally {
      setIsVoiceProcessing(false);
      logReactionDebug('voice:stop-done');
    }
  }, [isVideoParent, isVoiceProcessing, isVoiceRecording, voiceRecorder]);

  const handleRetake = useCallback(() => {
    selfiePreviewExpectPlayingRef.current = false;
    if (reactionMode === 'selfie') {
      if (Platform.OS === 'android') {
        // The persistent camera was unmounted while the companion preview stage was shown.
        // Show the warmup overlay instead of a black box. We deliberately do NOT bump the
        // camera key — it re-mounts naturally when splitPane returns; an extra key-bump
        // would cause a second remount and worsen the black-screen window.
        if (companionPreviewOpen) setIsCameraRestoring(true);
      } else {
        // iOS camera is non-persistent. After a record→retake cycle the AVCaptureSession can
        // come back dark/frozen, so force a fresh CameraView instance and re-assert the
        // recording audio session to restart the preview cleanly.
        setIsCameraRestoring(true);
        bumpCameraInstance();
        void configureConnectReactionRecordingAudioSessionAsync().catch(() => {});
      }
    }
    if (reactionMode === 'voice') {
      setCompanionPreviewOpen(false);
      setCompanionPreviewPlaying(false);
      setShowCompanionPreviewReplay(false);
      setIsVoiceProcessing(true);
      void (async () => {
        try {
          setVoiceRecordedUri(null);
          setRecordedAudioSnapshot(null);
          setIsVoiceRecording(false);
          isStartingVoiceRecordingRef.current = false;
          setIsStartingVoiceRecording(false);
          try {
            if (voiceExpoAvRecordingRef.current) {
              await voiceExpoAvRecordingRef.current.stopAndUnloadAsync();
            }
          } catch {
            /* ignore */
          }
          voiceExpoAvRecordingRef.current = null;
          try {
            if (voiceRecorder.isRecording) {
              await voiceRecorder.stop();
            }
          } catch {
            /* ignore */
          }
          await unloadPreviewAudio();
          await configureConnectPlaybackAudioSessionAsync({ retries: 1 });
        } catch (error) {
          console.warn('[ReactionSheet] voice retake cleanup failed:', error);
        } finally {
          setIsVoiceProcessing(false);
        }
      })();
      return;
    }
    if (reactionMode === 'typed') {
      setCompanionPreviewOpen(false);
      setCompanionPreviewPlaying(false);
      setShowCompanionPreviewReplay(false);
      setTypedPreviewLoading(false);
      companionPreviewStopPendingRef.current = false;
      typedPreviewAudioUriRef.current = null;
      typedPreviewMessageRef.current = null;
      unloadPreviewAudio();
      setTypedMessage('');
      setTypedMessageReady(false);
      void restoreReactionRecordingAudioSession();
      return;
    }
    const restartAt = syncStartTimeMillis;
    recordingPromiseRef.current = null;
    cameraRecordingStartedRef.current = false;
    setIsSelfieSaving(false);
    setRecordedUri(null);
    setRecordedAudioSnapshot(null);
    setSyncStartTimeMillis(null);
    setSyncEndTimeMillis(null);
    setIsPreviewPlaying(false);
    setCompanionPreviewOpen(false);
    setCompanionPreviewPlaying(false);
    setShowCompanionPreviewReplay(false);
    companionPreviewStopPendingRef.current = false;

    logReactionDebug('retake:selfie-sync', { isVideoParent });

    if (isVideoParent && restartAt != null) {
      void commitVideoPosition(restartAt, {
        shouldPlay: false,
        volume: getReactionParentVolume(),
      });
    }
    void videoRef.current?.pauseAsync().catch(() => {});
  }, [
    bumpCameraInstance,
    commitVideoPosition,
    companionPreviewOpen,
    getReactionParentVolume,
    isVideoParent,
    reactionMode,
    unloadPreviewAudio,
    voiceRecorder,
    syncStartTimeMillis,
  ]);

  const handleSend = useCallback(() => {
    if (isUploading) return;
    if (!currentExplorerId) {
      Alert.alert('Explorer Not Ready', 'Please wait for the Explorer profile to load before sending.');
      return;
    }
    if (!user?.uid) {
      Alert.alert('Sign In Required', 'Please sign in to send a reaction.');
      return;
    }
    if (!activeRelationship?.id) {
      Alert.alert('Unable to Send', 'Your Companion link to this Explorer is missing.');
      return;
    }

    if (reactionMode === 'selfie') {
      if (!recordedUri || syncStartTimeMillis == null) {
        Alert.alert('Unable to Send', 'Reaction sync timing is missing. Please retake your reaction.');
        return;
      }
    } else if (reactionMode === 'typed') {
      if (!typedMessage.trim()) {
        Alert.alert('Add a Message', 'Type a short reaction before sending.');
        return;
      }
    } else if (!voiceRecordedUri) {
      Alert.alert('Record a Message', 'Record a voice reaction before sending.');
      return;
    }

    void (async () => {
      setIsUploading(true);
      try {
        await uploadReaction({
          reactionType: reactionMode,
          explorerId: currentExplorerId,
          parentReflectionId,
          syncStartTimeMillis:
            reactionMode === 'selfie'
              ? (syncStartTimeMillis ?? 0)
              : isVideoParent && (reactionMode === 'voice' || reactionMode === 'typed')
                ? trimStartMs
                : 0,
          senderName: activeRelationship.companionName || 'Companion',
          senderId: user.uid,
          activeRelationshipId: activeRelationship.id,
          recordedVideoUri: reactionMode === 'selfie' ? recordedUri ?? undefined : undefined,
          messageText: reactionMode === 'typed' ? typedMessage.trim() : undefined,
          recordedAudioUri: reactionMode === 'voice' ? voiceRecordedUri ?? undefined : undefined,
          parentPosterUri,
        });
        onUploadSuccess?.(parentReflectionId, activeRelationship.id);
        onClose();
      } catch (error) {
        console.error('[ReactionSheet] upload failed:', error);
        Alert.alert(
          'Send Failed',
          error instanceof Error ? error.message : 'Failed to send reaction',
        );
      } finally {
        setIsUploading(false);
      }
    })();
  }, [
    activeRelationship,
    currentExplorerId,
    isUploading,
    isVideoParent,
    onClose,
    onUploadSuccess,
    parentPosterUri,
    parentReflectionId,
    reactionMode,
    recordedUri,
    syncStartTimeMillis,
    trimStartMs,
    typedMessage,
    user?.uid,
    voiceRecordedUri,
  ]);

  const isSelfiePreviewMode = reactionMode === 'selfie' && recordedUri != null;
  const isSelfieTakeComplete = isSelfiePreviewMode && !companionPreviewOpen;
  const isAndroidVideoSelfie =
    Platform.OS === 'android' && reactionMode === 'selfie' && isVideoParent && !companionPreviewOpen;
  const isVoicePreviewMode = reactionMode === 'voice' && voiceRecordedUri != null;
  const isVoiceTakeComplete = isVoicePreviewMode && !companionPreviewOpen;
  const isTypedPreviewMode =
    reactionMode === 'typed' && typedMessage.trim().length > 0 && typedMessageReady;
  const isTypedTakeComplete = isTypedPreviewMode && !companionPreviewOpen;
  const isPreviewMode = isSelfiePreviewMode || isVoicePreviewMode || isTypedPreviewMode;
  const isInteractionBusy =
    isUploading ||
    isSelfieSaving ||
    isVoiceProcessing ||
    isStartingVoiceRecording ||
    isRecording;
  const showCompanionPreviewStage =
    companionPreviewOpen &&
    ((reactionMode === 'selfie' && !!recordedUri) ||
      (reactionMode === 'voice' && !!voiceRecordedUri) ||
      (reactionMode === 'typed' && !!typedMessage.trim()));
  const isSelfieCameraActive =
    visible &&
    reactionMode === 'selfie' &&
    !isUploading &&
    !companionPreviewOpen &&
    !recordedUri &&
    !isSelfieSaving &&
    // On Android, release the camera while backgrounded so it can re-bind cleanly on resume.
    (Platform.OS !== 'android' || isAppForeground);
  const isCameraGranted =
    cameraPermission?.granted === true || nativeCameraGranted === true;
  const isCameraDenied =
    nativeCameraGranted === false && cameraPermission?.granted !== true;
  const canRecordSelfie =
    reactionMode === 'selfie' &&
    !recordedUri &&
    isCameraGranted &&
    (Platform.OS === 'android' || (micReady && cameraReady));
  const scrubDurationMs = Math.max(durationMillis, 1);
  const scrubEndMs = trimEndMs > 0 ? trimEndMs : scrubDurationMs;
  const parentRecordingVolume = resolveReactionRecordingVolume({
    muted: isParentReflectionMuted,
    hasHeadphones,
  });
  const parentTrimPreviewVolume = resolveReactionRecordingVolume({
    muted: false,
    hasHeadphones,
  });
  const parentVideoMuted = isPreviewPlaying && !isRecording ? false : isParentReflectionMuted;
  const parentVideoVolume =
    isPreviewPlaying && !isRecording ? parentTrimPreviewVolume : parentRecordingVolume;
  const companionPreviewParentMuted = !companionPreviewPlaying;
  const companionPreviewParentVolumeActive = companionPreviewPlaying
    ? parentTrimPreviewVolume
    : 0;
  // A gentle, non-imposing one-liner that only appears when the parent has audio worth hearing.
  const showAudioHint =
    isVideoParent &&
    !companionPreviewOpen &&
    !isPreviewMode &&
    (reactionMode === 'selfie' || reactionMode === 'voice');
  const audioHintText =
    reactionMode === 'voice'
      ? 'Turn on Original audio to hear the Reflection while you record — use headphones to avoid echo.'
      : 'Original audio is Off by default (no echo). Turn it on to hear the Reflection while you record — use headphones to avoid echo.';
  const voiceModeHint = isVideoParent
    ? isVoiceRecording
      ? 'The Reflection plays with you. Tap Stop when you’re done.'
      : 'Your message sets how long the Reflection plays.'
    : isVoiceRecording
      ? 'Tap Stop when you’re done.'
      : 'Your voice, not AI — good for quieter places.';
  const renderOriginalAudioToggle = () => (
    <Pressable
      style={styles.originalAudioToggle}
      onPress={toggleParentReflectionMute}
      accessibilityRole="switch"
      accessibilityState={{ checked: !isParentReflectionMuted }}
      accessibilityLabel={
        isParentReflectionMuted
          ? 'Original audio off. Double tap to turn on.'
          : 'Original audio on. Double tap to turn off.'
      }
    >
      <View style={styles.originalAudioToggleLeading}>
        <FontAwesome
          name={isParentReflectionMuted ? 'volume-off' : 'volume-up'}
          size={18}
          color={isParentReflectionMuted ? '#ef4444' : '#7dd3a8'}
        />
        <Text style={styles.originalAudioToggleLabel}>Original audio</Text>
      </View>
      <View
        style={[
          styles.originalAudioTogglePill,
          isParentReflectionMuted
            ? styles.originalAudioTogglePillOff
            : styles.originalAudioTogglePillOn,
        ]}
      >
        <Text
          style={[
            styles.originalAudioToggleState,
            isParentReflectionMuted
              ? styles.originalAudioToggleStateOff
              : styles.originalAudioToggleStateOn,
          ]}
        >
          {isParentReflectionMuted ? 'Off' : 'On'}
        </Text>
      </View>
    </Pressable>
  );

  const renderCompanionAvatarPip = () => (
    <View style={[styles.companionSelfiePip, styles.reactionPipVideo, styles.companionAvatarPip]}>
      {companionAvatar?.avatarUrl ? (
        <Image
          source={{ uri: companionAvatar.avatarUrl }}
          style={styles.companionAvatarImage}
          contentFit="cover"
        />
      ) : (
        <View
          style={[
            styles.companionAvatarFallback,
            { backgroundColor: companionAvatar?.color ?? '#4FC3F7' },
          ]}
        >
          <Text style={styles.companionAvatarInitial}>{companionAvatar?.initial ?? '?'}</Text>
        </View>
      )}
    </View>
  );

  return (
    <Modal
      visible={visible && hasValidParentMedia}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={handleAbandonReaction}
      onShow={handleModalShow}
    >
      <GestureHandlerRootView style={styles.container}>
        <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
          {companionPreviewOpen ? (
            <>
              <Pressable
                style={styles.backButton}
                onPress={closeCompanionPreview}
                disabled={isUploading}
                accessibilityRole="button"
                accessibilityLabel="Back to reaction"
              >
                <FontAwesome name="chevron-left" size={16} color="#fff" />
              </Pressable>
              <Text style={[styles.headerTitle, styles.headerTitleCentered]}>Preview</Text>
              <Pressable
                style={styles.closeButton}
                onPress={handleAbandonReaction}
                disabled={isUploading}
                accessibilityRole="button"
                accessibilityLabel="Close reaction recorder"
              >
                <FontAwesome name="times" size={18} color="#fff" />
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.headerTitle}>Live Sync Reaction</Text>
              <Pressable
                style={styles.closeButton}
                onPress={handleAbandonReaction}
                disabled={isUploading}
                accessibilityRole="button"
                accessibilityLabel="Close reaction recorder"
              >
                <FontAwesome name="times" size={18} color="#fff" />
              </Pressable>
            </>
          )}
        </View>

        <KeyboardAvoidingView
          style={styles.sheetBodyKeyboardAvoid}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
          enabled={Platform.OS === 'ios' && reactionMode === 'typed' && !companionPreviewOpen}
        >
        {showCompanionPreviewStage ? (
          <View style={styles.companionPreviewStage}>
            <View style={styles.companionPreviewFrame}>
              {isVideoParent ? (
                <Video
                  ref={companionParentRef}
                  source={{ uri: parentVideoUrl }}
                  style={styles.companionPreviewMainVideo}
                  resizeMode={ResizeMode.CONTAIN}
                  shouldPlay={false}
                  isLooping={false}
                  isMuted={companionPreviewParentMuted}
                  volume={companionPreviewParentVolumeActive}
                  progressUpdateIntervalMillis={100}
                  onPlaybackStatusUpdate={handleCompanionParentStatusUpdate}
                />
              ) : (
                <Image
                  source={{ uri: parentImageUrl }}
                  style={styles.companionPreviewMainVideo}
                  contentFit="contain"
                />
              )}
              {reactionMode === 'selfie' && recordedUri ? (
                <VideoView
                  player={companionSelfiePlayer}
                  style={[styles.companionSelfiePip, styles.reactionPipVideo]}
                  contentFit="cover"
                  nativeControls={false}
                  allowsFullscreen={false}
                  pointerEvents="none"
                />
              ) : (
                renderCompanionAvatarPip()
              )}
              {reactionMode === 'typed' && typedMessage.trim() ? (
                <View style={styles.companionPreviewCaptionBar}>
                  <Text style={styles.companionPreviewCaptionText} numberOfLines={4}>
                    {formatTypedReactionSpeechText(
                      companionAvatar?.companionName || 'Companion',
                      typedMessage.trim(),
                    )}
                  </Text>
                </View>
              ) : null}
              {typedPreviewLoading ? (
                <View style={[styles.replayOverlay, styles.companionPreviewReplayOverlay]}>
                  <ActivityIndicator color="#fff" size="large" />
                  <Text style={styles.typedPreviewLoadingText}>Generating AI voice…</Text>
                </View>
              ) : null}
            </View>
            <Text style={styles.companionPreviewHint}>
              {reactionMode === 'voice'
                ? isVideoParent
                  ? 'Your voice and the Reflection play together and stop when your message ends.'
                  : 'This is how your reaction will look. Your voice plays while the Reflection runs softly in the background.'
                : reactionMode === 'typed'
                  ? 'This is how your reaction will look. Your message is read in your AI voice while the Reflection plays softly in the background.'
                  : reactionMode === 'selfie' && (isVideoParent || isImageParent)
                    ? 'This is how your Companions will see your reaction. The Reflection fills the screen; your selfie plays in the corner.'
                    : 'This is how your Companions will see your reaction on this photo.'}
            </Text>
          </View>
        ) : (
        <View
          style={[
            styles.splitPane,
            reactionMode === 'typed' && styles.splitPaneTyped,
            reactionMode === 'selfie' &&
              Platform.OS === 'android' &&
              isImageParent &&
              styles.splitPaneAndroidSelfie,
          ]}
        >
          <View
            style={[
              styles.parentVideoPane,
              reactionMode === 'typed' && styles.parentVideoPaneTyped,
              reactionMode === 'voice' && isVideoParent && styles.parentVideoPaneVoice,
              reactionMode === 'selfie' &&
                Platform.OS === 'android' &&
                isImageParent &&
                styles.parentVideoPaneAndroidSelfie,
              reactionMode === 'selfie' &&
                Platform.OS === 'android' &&
                isVideoParent &&
                styles.parentVideoPaneAndroidSelfieVideo,
            ]}
          >
            <View
              style={[
                styles.mediaCard,
                isAndroidVideoSelfie && styles.mediaCardAndroidVideoSelfie,
              ]}
            >
              {isVideoParent && suppressAndroidParentVideoSurface ? (
                <View style={[styles.parentVideoSurface, styles.parentVideoSurfacePlaceholder]}>
                  <FontAwesome name="film" size={22} color="rgba(255,255,255,0.5)" />
                  <Text style={styles.parentVideoPlaceholderText}>
                    Reflection video ready
                  </Text>
                </View>
              ) : isVideoParent ? (
                <>
                  <GestureDetector
                    gesture={
                      showScrubUi && !isRecording ? videoPanGesture : Gesture.Pan().enabled(false)
                    }
                  >
                    <View
                      style={[
                        styles.parentVideoSurface,
                        isAndroidVideoSelfie && styles.parentVideoSurfaceAndroidVideoSelfie,
                      ]}
                      onLayout={(event) => {
                        parentVideoWidthRef.current = event.nativeEvent.layout.width;
                      }}
                    >
                      <Video
                        ref={videoRef}
                        source={{ uri: parentVideoUrl }}
                        style={styles.parentVideo}
                        resizeMode={ResizeMode.CONTAIN}
                        shouldPlay={false}
                        isLooping={false}
                        isMuted={parentVideoMuted}
                        volume={parentVideoVolume}
                        progressUpdateIntervalMillis={100}
                        onPlaybackStatusUpdate={handlePlaybackStatusUpdate}
                      />
                      {showScrubUi && !isRecording ? (
                        <View style={styles.dragHintOverlay} pointerEvents="none">
                          <Text style={styles.dragHintText}>Drag to set start</Text>
                        </View>
                      ) : null}
                      {isRecording && isVideoParent ? (
                        <View style={styles.recordingSyncOverlay} pointerEvents="none">
                          <View style={styles.recordingSyncBadge}>
                            <FontAwesome name="circle" size={10} color="#ff6b6b" />
                            <Text style={styles.recordingSyncText}>Recording with Reflection</Text>
                          </View>
                        </View>
                      ) : null}
                    </View>
                  </GestureDetector>

                  {showScrubUi && durationMillis > MIN_TRIM_GAP_MS ? (
                    <>
                      <View
                        style={[
                          styles.trimSliderWrap,
                          isAndroidVideoSelfie && styles.trimSliderWrapAndroidVideoSelfie,
                        ]}
                      >
                        <VideoTrimSlider
                          durationMs={scrubDurationMs}
                          startMs={trimStartMs}
                          endMs={scrubEndMs}
                          currentTimeMs={positionMillis}
                          onChange={handleTrimChange}
                          onSeek={handleSeek}
                          onScrubStart={handleScrubStart}
                          onScrubEnd={handleScrubEnd}
                        />
                      </View>
                      <View style={styles.playbackControlsRow}>
                        <Pressable
                          style={[styles.playbackControl, styles.playbackControlFlex]}
                          onPress={toggleParentPlayback}
                          disabled={isRecording}
                          accessibilityRole="button"
                          accessibilityLabel={
                            isPreviewPlaying
                              ? 'Pause parent Reflection preview'
                              : 'Play parent Reflection preview'
                          }
                        >
                          <FontAwesome
                            name={isPreviewPlaying ? 'pause' : 'play'}
                            size={14}
                            color="#fff"
                          />
                          <Text style={styles.playbackControlText}>
                            {isPreviewPlaying ? 'Pause preview' : 'Play preview'}
                          </Text>
                        </Pressable>
                      </View>
                    </>
                  ) : isSelfieTakeComplete ? (
                    <Text style={styles.selfiePreviewHint}>
                      Tap Preview below to see how Companions will view your reaction.
                    </Text>
                  ) : null}
                </>
              ) : (
                <View style={styles.parentImageSurface}>
                  <Image
                    source={{ uri: parentImageUrl }}
                    style={styles.parentImage}
                    contentFit="contain"
                  />
                </View>
              )}
            </View>
          </View>

          <View
            style={[
              styles.cameraPane,
              reactionMode === 'selfie' &&
                Platform.OS === 'android' &&
                isImageParent &&
                styles.cameraPaneAndroidSelfie,
              isAndroidVideoSelfie && styles.cameraPaneAndroidSelfieVideo,
            ]}
          >
            <View style={styles.mediaCard}>
              <View
                style={[
                  styles.modeForeground,
                  reactionMode === 'selfie' &&
                    !isSelfieSaving &&
                    !isSelfieTakeComplete &&
                    styles.modeForegroundTransparent,
                ]}
                pointerEvents={
                  reactionMode === 'selfie' &&
                  !isSelfieSaving &&
                  !isSelfieTakeComplete
                    ? 'box-none'
                    : 'auto'
                }
              >
              {reactionMode === 'typed' && isTypedTakeComplete ? (
                <View style={styles.takeCompletePane}>
                  <FontAwesome name="check-circle" size={42} color="#7dd3a8" />
                  <Text style={styles.takeCompleteTitle}>Message ready</Text>
                  <Text style={styles.takeCompleteHint}>
                    Tap Preview below to see how Companions will view your reaction.
                  </Text>
                </View>
              ) : reactionMode === 'typed' ? (
                <View style={styles.typedComposePane}>
                  <Text style={styles.altModeTitle}>Type your reaction</Text>
                  <TextInput
                    style={styles.typedInputExpanded}
                    placeholder="Say something warm and short…"
                    placeholderTextColor="rgba(255,255,255,0.4)"
                    value={typedMessage}
                    onChangeText={setTypedMessage}
                    maxLength={TYPED_MESSAGE_MAX_LENGTH}
                    multiline
                    textAlignVertical="top"
                    editable={!isUploading}
                    returnKeyType="done"
                    blurOnSubmit
                    onSubmitEditing={commitTypedMessage}
                    scrollEnabled
                  />
                  <View style={styles.typedComposeMeta}>
                    <Text style={styles.typedCounter}>
                      {typedMessage.length}/{TYPED_MESSAGE_MAX_LENGTH}
                    </Text>
                    {typedMessage.trim() ? (
                      <Pressable
                        style={styles.keyboardDismissButton}
                        onPress={commitTypedMessage}
                        accessibilityRole="button"
                        accessibilityLabel="Done typing"
                      >
                        <Text style={styles.keyboardDismissButtonText}>
                          {isTypedKeyboardVisible ? 'Done typing' : 'Message ready'}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              ) : reactionMode === 'voice' && isVoiceProcessing ? (
                <View style={styles.takeCompletePane}>
                  <ActivityIndicator color="#fff" size="large" />
                  <Text style={styles.takeCompleteTitle}>Saving voice message…</Text>
                  <Text style={styles.takeCompleteHint}>Processing your recording.</Text>
                </View>
              ) : reactionMode === 'voice' && isVoiceTakeComplete ? (
                <View style={styles.takeCompletePane}>
                  <FontAwesome name="check-circle" size={42} color="#7dd3a8" />
                  <Text style={styles.takeCompleteTitle}>Voice message ready</Text>
                  <Text style={styles.takeCompleteHint}>
                    Tap Preview below to see how Companions will view your reaction.
                  </Text>
                </View>
              ) : reactionMode === 'voice' ? (
                <ScrollView
                  style={styles.altModePaneScroll}
                  contentContainerStyle={styles.altModePaneContent}
                  showsVerticalScrollIndicator={false}
                  bounces={false}
                  keyboardShouldPersistTaps="handled"
                >
                  <FontAwesome name="microphone" size={28} color="#fff" />
                  <Text style={styles.altModeTitle}>
                    {isVoiceRecording ? 'Recording…' : 'Record a voice message'}
                  </Text>
                  <Text style={styles.altModeHint}>{voiceModeHint}</Text>
                  <Pressable
                    style={[
                      styles.voiceRecordButton,
                      isVoiceRecording && styles.voiceRecordButtonActive,
                    ]}
                    onPress={() => {
                      if (isVoiceRecording) {
                        void handleStopVoiceRecording();
                      } else {
                        void handleStartVoiceRecording();
                      }
                    }}
                    disabled={isUploading || isStartingVoiceRecording || isVoiceProcessing}
                  >
                    <FontAwesome name={isVoiceRecording ? 'stop' : 'microphone'} size={16} color="#fff" />
                    <Text style={styles.voiceRecordButtonText}>
                      {isStartingVoiceRecording
                        ? 'Starting…'
                        : isVoiceRecording
                          ? 'Stop recording'
                          : 'Start recording'}
                    </Text>
                  </Pressable>
                </ScrollView>
              ) : reactionMode === 'selfie' && isSelfieSaving ? (
                <View style={styles.takeCompletePane}>
                  <ActivityIndicator color="#fff" size="large" />
                  <Text style={styles.takeCompleteTitle}>Saving reaction…</Text>
                  <Text style={styles.takeCompleteHint}>Hang tight while we finish your recording.</Text>
                </View>
              ) : reactionMode === 'selfie' && isSelfieTakeComplete ? (
                <View style={styles.takeCompletePane}>
                  <FontAwesome name="check-circle" size={42} color="#7dd3a8" />
                  <Text style={styles.takeCompleteTitle}>Reaction recorded</Text>
                  <Text style={styles.takeCompleteHint}>
                    Preview how Companions will see it, or retake if you want another try.
                  </Text>
                </View>
              ) : reactionMode === 'selfie' && isCameraGranted ? (
                <View
                  style={[
                    styles.cameraStageHost,
                    Platform.OS === 'ios' && styles.cameraStageHostIos,
                    Platform.OS === 'android' &&
                      isImageParent &&
                      styles.cameraStageHostAndroidImageSelfie,
                    isAndroidVideoSelfie && styles.cameraStageHostAndroidVideoSelfie,
                  ]}
                  collapsable={false}
                >
                  <CameraView
                    key={cameraInstanceKey}
                    ref={cameraRef}
                    style={styles.cameraPreview}
                    facing="front"
                    mode="video"
                    mirror={Platform.OS === 'ios'}
                    videoQuality="720p"
                    active={isSelfieCameraActive}
                    onCameraReady={() => {
                      logReactionDebug('camera:ready', { cameraInstanceKey, reactionMode });
                      setCameraReady(true);
                      // iOS briefly shows the back camera on a fresh mount before facing="front"
                      // applies; hold the opaque overlay a beat so the user never sees the flash.
                      if (Platform.OS === 'ios') {
                        setTimeout(() => setIsCameraRestoring(false), 350);
                      } else {
                        setIsCameraRestoring(false);
                      }
                    }}
                    onMountError={(event) => {
                      logReactionDebug('camera:mount-error', {
                        message: event.message,
                        cameraInstanceKey,
                      });
                      console.warn('[ReactionSheet] camera mount error:', event.message);
                      setCameraReady(false);
                      setIsCameraRestoring(false);
                    }}
                  />
                  {isCameraRestoring ? (
                    <View style={styles.cameraRestoringOverlay} pointerEvents="none">
                      <ActivityIndicator color="#fff" size="large" />
                      <Text style={styles.takeCompleteHint}>Starting camera…</Text>
                    </View>
                  ) : null}
                </View>
              ) : reactionMode === 'selfie' && isCameraDenied ? (
                <View style={styles.permissionFallback}>
                  <Text style={styles.permissionText}>
                    Camera access is required to record a selfie reaction.
                  </Text>
                  <Pressable
                    style={styles.permissionButton}
                    onPress={() => void handleGrantCameraAccess()}
                  >
                    <Text style={styles.permissionButtonText}>
                      {cameraPermission?.canAskAgain === false
                        ? 'Open Settings'
                        : 'Grant Camera Access'}
                    </Text>
                  </Pressable>
                </View>
              ) : (
                <View style={styles.permissionFallback}>
                  <ActivityIndicator color="#fff" />
                  <Text style={styles.permissionText}>Checking camera access…</Text>
                </View>
              )}
              </View>
            </View>
          </View>
        </View>
        )}

        <View style={[styles.interactionFooter, { paddingBottom: insets.bottom }]}>
          {showAudioHint ? (
            <View style={styles.audioHintBlock}>
              {renderOriginalAudioToggle()}
              <Text style={styles.audioHintText}>{audioHintText}</Text>
            </View>
          ) : null}

          {isInteractionBusy && !companionPreviewOpen ? (
            <View style={styles.processingBanner}>
              <ActivityIndicator color="#fff" size="small" />
              <Text style={styles.processingBannerText}>
                {isSelfieSaving
                  ? 'Saving selfie…'
                  : isVoiceProcessing
                    ? 'Processing voice…'
                    : isStartingVoiceRecording
                      ? 'Starting voice…'
                      : isRecording
                        ? 'Recording…'
                        : 'Working…'}
              </Text>
            </View>
          ) : null}

          {!companionPreviewOpen ? (
          <View style={styles.modePicker}>
            {(
              [
                { mode: 'selfie' as const, label: 'Selfie', icon: 'video-camera' as const },
                { mode: 'typed' as const, label: 'Type', icon: 'keyboard-o' as const },
                { mode: 'voice' as const, label: 'Voice', icon: 'microphone' as const },
              ] as const
            ).map(({ mode, label, icon }) => {
              const isActive = reactionMode === mode;
              return (
                <Pressable
                  key={mode}
                  style={[styles.modeButton, isActive && styles.modeButtonActive]}
                  onPress={() => handleReactionModeChange(mode)}
                  disabled={isInteractionBusy || isPreviewMode || isVoiceRecording}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isActive }}
                  accessibilityLabel={`${label} reaction`}
                >
                  <FontAwesome
                    name={icon}
                    size={13}
                    color={isActive ? '#fff' : 'rgba(255,255,255,0.65)'}
                  />
                  <Text style={[styles.modeButtonText, isActive && styles.modeButtonTextActive]}>
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          ) : null}

          {companionPreviewOpen ? (
            <View style={styles.previewActions}>
              {isUploading ? (
                <ActivityIndicator color="#fff" style={styles.uploadingSpinner} />
              ) : null}
              <Pressable
                style={[styles.retakeButton, isUploading && styles.previewButtonDisabled]}
                onPress={handleRetake}
                disabled={isUploading || isInteractionBusy}
                accessibilityRole="button"
                accessibilityLabel="Retake reaction"
              >
                <FontAwesome name="refresh" size={15} color="#fff" />
                <Text style={styles.retakeButtonText}>Retake</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.previewPlayButton,
                  (isUploading || companionPreviewPlaying) && styles.previewButtonDisabled,
                ]}
                onPress={showCompanionPreviewReplay ? replayCompanionPreview : () => void startCompanionPreview()}
                disabled={isUploading || companionPreviewPlaying}
                accessibilityRole="button"
                accessibilityLabel={showCompanionPreviewReplay ? 'Replay reaction preview' : 'Preview reaction'}
              >
                <FontAwesome name={showCompanionPreviewReplay ? 'repeat' : 'play'} size={15} color="#fff" />
                <Text style={styles.previewPlayButtonText}>
                  {showCompanionPreviewReplay ? 'Replay' : 'Preview'}
                </Text>
              </Pressable>
              <Pressable
                style={[styles.sendButton, isUploading && styles.previewButtonDisabled]}
                onPress={handleSend}
                disabled={isUploading}
                accessibilityRole="button"
                accessibilityLabel="Send reaction"
              >
                <FontAwesome name="paper-plane" size={15} color="#fff" />
                <Text style={styles.sendButtonText}>Send</Text>
              </Pressable>
            </View>
          ) : isSelfieTakeComplete ? (
            <View style={styles.previewActions}>
              <Pressable
                style={[styles.retakeButton, isInteractionBusy && styles.previewButtonDisabled]}
                onPress={handleRetake}
                disabled={isInteractionBusy}
                accessibilityRole="button"
                accessibilityLabel="Retake reaction"
              >
                <FontAwesome name="refresh" size={15} color="#fff" />
                <Text style={styles.retakeButtonText}>Retake</Text>
              </Pressable>
              <Pressable
                style={[styles.previewPlayButton, styles.previewPlayButtonFlex]}
                onPress={openCompanionPreview}
                accessibilityRole="button"
                accessibilityLabel="Preview reaction"
              >
                <FontAwesome name="play" size={15} color="#fff" />
                <Text style={styles.previewPlayButtonText}>Preview</Text>
              </Pressable>
            </View>
          ) : isVoiceTakeComplete ? (
            <View style={styles.previewActions}>
              <Pressable
                style={[styles.retakeButton, isInteractionBusy && styles.previewButtonDisabled]}
                onPress={handleRetake}
                disabled={isInteractionBusy}
                accessibilityRole="button"
                accessibilityLabel="Retake reaction"
              >
                <FontAwesome name="refresh" size={15} color="#fff" />
                <Text style={styles.retakeButtonText}>Retake</Text>
              </Pressable>
              <Pressable
                style={[styles.previewPlayButton, styles.previewPlayButtonFlex]}
                onPress={openCompanionPreview}
                accessibilityRole="button"
                accessibilityLabel="Preview reaction"
              >
                <FontAwesome name="play" size={15} color="#fff" />
                <Text style={styles.previewPlayButtonText}>Preview</Text>
              </Pressable>
            </View>
          ) : isTypedTakeComplete ? (
            <View style={styles.previewActions}>
              <Pressable
                style={[styles.retakeButton, isInteractionBusy && styles.previewButtonDisabled]}
                onPress={handleRetake}
                disabled={isInteractionBusy}
                accessibilityRole="button"
                accessibilityLabel="Retake reaction"
              >
                <FontAwesome name="refresh" size={15} color="#fff" />
                <Text style={styles.retakeButtonText}>Retake</Text>
              </Pressable>
              <Pressable
                style={[styles.previewPlayButton, styles.previewPlayButtonFlex]}
                onPress={openCompanionPreview}
                accessibilityRole="button"
                accessibilityLabel="Preview reaction"
              >
                <FontAwesome name="play" size={15} color="#fff" />
                <Text style={styles.previewPlayButtonText}>Preview</Text>
              </Pressable>
            </View>
          ) : reactionMode === 'typed' ? null : reactionMode === 'voice' ? null : (
            <Pressable
              onPressIn={handlePressIn}
              onPressOut={handlePressOut}
              disabled={!canRecordSelfie || isSelfieSaving}
              android_disableSound
              style={({ pressed }) => [
                styles.recordButton,
                isRecording && styles.recordButtonActive,
                (pressed || isRecording) && styles.recordButtonPressed,
                (!canRecordSelfie || isSelfieSaving) && styles.recordButtonDisabled,
              ]}
              accessibilityRole="button"
              accessibilityLabel={
                isSelfieSaving ? 'Saving reaction' : isRecording ? 'Recording reaction' : 'Hold to react'
              }
              accessibilityHint={
                isImageParent
                  ? 'Press and hold to record your reaction to this photo'
                  : 'Press and hold to record your reaction while the Reflection plays'
              }
            >
              <FontAwesome name="circle" size={14} color="#fff" />
              <Text style={styles.recordButtonText}>
                {isSelfieSaving
                  ? 'Saving…'
                  : isRecording
                    ? 'Recording…'
                    : 'Hold to React'}
              </Text>
            </Pressable>
          )}

          {!companionPreviewOpen ? (
            <TouchableOpacity
              style={styles.infoBtn}
              onPress={openHowItWorks}
              accessibilityRole="button"
              accessibilityLabel="How this works"
            >
              <FontAwesome name="info-circle" size={15} color="#4a90d9" />
              <Text style={styles.infoBtnText}>How this works</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        </KeyboardAvoidingView>

        <Modal
          visible={isInfoOpen}
          animationType="slide"
          transparent
          onRequestClose={closeHowItWorks}
          statusBarTranslucent
        >
          <View style={styles.infoModalRoot}>
            <Pressable style={styles.infoModalBackdrop} onPress={closeHowItWorks} />
            <View style={[styles.infoModalCard, { paddingBottom: Math.max(insets.bottom, 16) + 16 }]}>
              <View style={styles.infoModalHeader}>
                <View style={styles.sheetHandle} />
                <TouchableOpacity
                  onPress={closeHowItWorks}
                  style={styles.infoModalCloseBtn}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  accessibilityRole="button"
                  accessibilityLabel="Close how this works"
                >
                  <FontAwesome name="close" size={18} color="#fff" />
                </TouchableOpacity>
              </View>
              <ScrollView
                style={styles.infoModalScrollHost}
                contentContainerStyle={styles.infoSheetScroll}
                showsVerticalScrollIndicator
              >
                <Text style={styles.infoTitle}>Reacting to a Reflection</Text>
                <Text style={styles.infoSubtitle}>
                  A reaction lets you respond in the moment — point something out, share a memory, or
                  just smile back. Pick whichever feels easiest; there’s no wrong way.
                </Text>

                <View style={styles.infoRow}>
                  <View style={styles.infoIconWrap}>
                    <FontAwesome name="video-camera" size={14} color="#4FC3F7" />
                  </View>
                  <View style={styles.infoTextWrap}>
                    <Text style={styles.infoLabel}>Selfie</Text>
                    <Text style={styles.infoDesc}>
                      Hold the button to record yourself reacting. On videos, drag to choose where the
                      Reflection starts. When you’re done, tap Preview, then Send.
                    </Text>
                  </View>
                </View>

                <View style={styles.infoRow}>
                  <View style={styles.infoIconWrap}>
                    <FontAwesome name="microphone" size={14} color="#4ade80" />
                  </View>
                  <View style={styles.infoTextWrap}>
                    <Text style={styles.infoLabel}>Voice</Text>
                    <Text style={styles.infoDesc}>
                      Record a short voice message — great for narrating or for quieter places where
                      you’d rather not be on camera. On video Reflections, the clip plays for as long
                      as you talk, not the whole video. Tap Preview, then Send.
                    </Text>
                  </View>
                </View>

                <View style={styles.infoRow}>
                  <View style={styles.infoIconWrap}>
                    <FontAwesome name="keyboard-o" size={14} color="#f39c12" />
                  </View>
                  <View style={styles.infoTextWrap}>
                    <Text style={styles.infoLabel}>Type</Text>
                    <Text style={styles.infoDesc}>
                      Write a short note. We’ll deliver it in your AI voice (the one you picked in
                      Settings). Tap Preview to hear it, then Send.
                    </Text>
                  </View>
                </View>

                <View style={styles.infoDivider} />

                <Text style={styles.infoProTipHeader}>What Preview shows</Text>
                <Text style={styles.infoProTip}>
                  Preview matches what the Explorer will see — the Reflection fills the screen, with
                  your reaction in the corner.
                </Text>
                <Text style={styles.infoProTip}>
                  <Text style={styles.infoProTipStrong}>Selfie:</Text> your selfie video plays in the
                  corner. On video Reflections, the Reflection plays softly on the main screen. On
                  photos, the picture stays on the main screen.
                </Text>
                <Text style={styles.infoProTip}>
                  <Text style={styles.infoProTipStrong}>Voice &amp; Type:</Text> your profile photo
                  appears in the corner while your message plays — your recorded voice for Voice, or
                  your AI voice for Type. Typed messages begin with your name (for example,
                  “Grandad says,”) so the Explorer knows who is speaking. On video Reflections,
                  playback stops when your message ends.
                </Text>
                <Text style={styles.infoProTip}>
                  Use the ✕ to close and discard, or Retake if you want another try. The back arrow in
                  Preview returns you to edit without losing your draft.
                </Text>

                <View style={styles.infoDivider} />

                <Text style={styles.infoProTipHeader}>About sound &amp; echo</Text>
                <Text style={styles.infoProTip}>
                  For Selfie and Voice, the Reflection can keep playing while you record so you can
                  react in sync. The picture is always there to follow along.
                </Text>
                <Text style={styles.infoProTip}>
                  <Text style={styles.infoProTipStrong}>Headphones are the sweet spot:</Text> plug them
                  in, turn on Original audio, and you’ll hear the Reflection clearly with no echo in
                  your recording.
                </Text>
                <Text style={styles.infoProTip}>
                  On speaker, leave Original audio off while you record — the video still plays for
                  sync without bleeding into your reaction.
                </Text>
              </ScrollView>
            </View>
          </View>
        </Modal>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  headerTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  headerTitleCentered: {
    flex: 1,
    textAlign: 'center',
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  closeButtonSpacer: {
    width: 36,
    height: 36,
  },
  closeButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  splitPane: {
    flex: 1,
    minHeight: 0,
    paddingHorizontal: 12,
    gap: 10,
  },
  mediaCard: {
    flex: 1,
    minHeight: 0,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#101820',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    position: 'relative',
  },
  modeForeground: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 2,
    backgroundColor: '#101820',
  },
  modeForegroundTransparent: {
    backgroundColor: 'transparent',
  },
  cameraStageHostAndroidImageSelfie: {
    // Centered portrait 3:4 box so the front camera shows natural selfie framing instead of a
    // zoomed-in near-square crop. The aspect ratio is anchored to a DEFINITE height (the camera
    // pane below has a fixed height, and this host fills it), so width derives deterministically
    // (height * 3/4) and never collapses to zero on a background/foreground re-layout.
    alignSelf: 'center',
    height: '100%',
    aspectRatio: 3 / 4,
    backgroundColor: '#000',
    borderRadius: 14,
    overflow: 'hidden',
    zIndex: 1,
  },
  parentVideoPane: {
    flex: 1.4,
    minHeight: 0,
  },
  parentVideoPaneTyped: {
    flex: 0.55,
    maxHeight: 180,
  },
  parentVideoPaneVoice: {
    flex: 1.25,
  },
  splitPaneTyped: {
    gap: 8,
  },
  splitPaneAndroidSelfie: {
    flex: 1,
  },
  parentVideoPaneAndroidSelfie: {
    flex: 2.4,
    minHeight: 0,
  },
  parentVideoPaneAndroidSelfieVideo: {
    flex: 2.4,
    minHeight: 0,
  },
  mediaCardAndroidVideoSelfie: {
    flexDirection: 'column',
  },
  parentVideoSurfaceAndroidVideoSelfie: {
    flex: 1,
    minHeight: 120,
    flexShrink: 1,
  },
  trimSliderWrapAndroidVideoSelfie: {
    minHeight: 40,
    flexShrink: 0,
  },
  recordingSyncOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 10,
  },
  recordingSyncBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  recordingSyncText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  parentVideoSurface: {
    flex: 1,
    minHeight: 0,
    backgroundColor: '#101820',
    overflow: 'hidden',
  },
  parentVideoSurfacePlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  parentVideoPlaceholderText: {
    color: 'rgba(255,255,255,0.62)',
    fontSize: 13,
    fontWeight: '600',
  },
  parentImageSurface: {
    flex: 1,
    minHeight: 0,
    backgroundColor: '#101820',
  },
  parentVideo: {
    flex: 1,
    backgroundColor: '#101820',
  },
  parentImage: {
    flex: 1,
    width: '100%',
    height: '100%',
    backgroundColor: '#101820',
  },
  dragHintOverlay: {
    position: 'absolute',
    top: 12,
    alignSelf: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.48)',
  },
  dragHintText: {
    color: 'rgba(255,255,255,0.82)',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  trimSliderWrap: {
    flexShrink: 0,
    paddingTop: 4,
    paddingBottom: 4,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  playbackControlsRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  playbackControl: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.12)',
  },
  playbackControlFlex: {
    flex: 1,
  },
  playbackControlText: {
    color: 'rgba(255,255,255,0.88)',
    fontSize: 13,
    fontWeight: '600',
  },
  selfiePreviewHint: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 12,
    textAlign: 'center',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  cameraPane: {
    flex: 1,
    minHeight: 0,
  },
  cameraPaneAndroidSelfie: {
    // Fixed height (not flex): a flex value here competes with the parent image pane and re-resolves
    // to a shorter height after the app returns from background, making the camera "shrink to half".
    // A definite height keeps the camera box stable across re-layout and anchors the host's 3:4 ratio.
    flex: 0,
    flexGrow: 0,
    flexShrink: 0,
    height: 240,
  },
  cameraPaneAndroidSelfieVideo: {
    // Fixed height (selfie mode only): keeps the camera box stable across a background/foreground
    // re-layout and hands the remaining vertical space to the parent video (which is flex), so the
    // video no longer gets squeezed by a camera pane that fights it for flex space. Kept modest so
    // the reflection video (the thing being reacted to) stays clearly the larger of the two panes.
    flex: 0,
    flexGrow: 0,
    flexShrink: 0,
    height: 120,
  },
  cameraStageHost: {
    flex: 1,
    // No minHeight here: the camera pane owns the vertical size. A taller CameraView host can make
    // Android's native surface overflow its React Native card on some Samsung devices.
    minHeight: 0,
    width: '100%',
    backgroundColor: '#000',
    overflow: 'hidden',
    position: 'relative',
  },
  cameraStageHostIos: {
    flex: 0,
    alignSelf: 'center',
    height: '100%',
    aspectRatio: 3 / 4,
    borderRadius: 14,
  },
  cameraStageHostAndroidVideoSelfie: {
    // Centered portrait 3:4 box (was a 4:3 landscape box that squished the face). Anchored to the
    // camera pane's fixed height so the width derives deterministically (height * 3/4) and the box
    // can't collapse on a background/foreground re-layout. Mirrors the iOS and image-parent boxes.
    alignSelf: 'center',
    height: '100%',
    aspectRatio: 3 / 4,
    backgroundColor: '#000',
    borderRadius: 14,
    overflow: 'hidden',
    zIndex: 1,
  },
  cameraPreview: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  selfiePreviewVideo: {
    ...StyleSheet.absoluteFillObject,
  },
  permissionFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 16,
  },
  permissionText: {
    color: '#fff',
    fontSize: 15,
    textAlign: 'center',
  },
  permissionSpinner: {
    marginTop: 8,
  },
  permissionButton: {
    backgroundColor: '#2e78b7',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 24,
  },
  permissionButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  interactionFooter: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 10,
    gap: 10,
    backgroundColor: '#000',
  },
  modePicker: {
    flexDirection: 'row',
    alignSelf: 'stretch',
    gap: 8,
  },
  modeButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  modeButtonActive: {
    backgroundColor: 'rgba(46, 120, 183, 0.55)',
    borderColor: 'rgba(255,255,255,0.28)',
  },
  modeButtonText: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: 13,
    fontWeight: '600',
  },
  modeButtonTextActive: {
    color: '#fff',
  },
  altModePane: {
    flex: 1,
    minHeight: 0,
    padding: 20,
    justifyContent: 'center',
    gap: 12,
    backgroundColor: '#101820',
  },
  altModePaneScroll: {
    flex: 1,
    minHeight: 0,
    backgroundColor: '#101820',
  },
  altModePaneContent: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    gap: 10,
  },
  altModeTitle: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
  },
  altModeHint: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: 4,
    maxWidth: '100%',
  },
  typedComposePane: {
    flex: 1,
    minHeight: 0,
    padding: 16,
    gap: 10,
  },
  typedInputExpanded: {
    flex: 1,
    minHeight: 0,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(0,0,0,0.35)',
    color: '#fff',
    fontSize: 16,
    lineHeight: 22,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  typedComposeMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  typedCounter: {
    alignSelf: 'flex-end',
    color: 'rgba(255,255,255,0.45)',
    fontSize: 12,
  },
  voiceRecordButton: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: 'rgba(46, 120, 183, 0.92)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  voiceRecordButtonActive: {
    backgroundColor: 'rgba(176, 32, 32, 0.95)',
    borderColor: 'rgba(255, 120, 120, 0.65)',
  },
  voiceRecordButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  sendButtonStandalone: {
    alignSelf: 'stretch',
    flex: undefined,
    width: '100%',
    marginBottom: 8,
  },
  recordButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minWidth: 148,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(46, 120, 183, 0.92)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  recordButtonActive: {
    backgroundColor: 'rgba(176, 32, 32, 0.95)',
    borderColor: 'rgba(255, 120, 120, 0.65)',
    transform: [{ scale: 1.03 }],
  },
  recordButtonPressed: {
    transform: [{ scale: 1.03 }],
  },
  recordButtonDisabled: {
    opacity: 0.45,
  },
  recordButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  previewActions: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    width: '100%',
  },
  previewPlayButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  previewPlayButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  previewPlayButtonFlex: {
    flex: 1,
  },
  companionPreviewStage: {
    flex: 1,
    minHeight: 0,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  companionPreviewFrame: {
    flex: 1,
    minHeight: 0,
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: '#1a3a44',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  companionPreviewReplayOverlay: {
    zIndex: 10,
  },
  companionPreviewMainVideo: {
    width: '100%',
    height: '100%',
    backgroundColor: '#101820',
  },
  reactionPipVideo: {
    position: 'absolute',
    top: 14,
    right: 14,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.4)',
    backgroundColor: '#000',
    zIndex: 5,
  },
  companionSelfiePip: {
    width: 112,
    height: 150,
    borderRadius: 14,
  },
  companionAvatarPip: {
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  companionAvatarImage: {
    width: '100%',
    height: '100%',
  },
  companionAvatarFallback: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  companionAvatarInitial: {
    color: '#fff',
    fontSize: 36,
    fontWeight: '700',
  },
  sheetBodyKeyboardAvoid: {
    flex: 1,
    minHeight: 0,
  },
  keyboardDismissButton: {
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  keyboardDismissButtonText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 14,
    fontWeight: '600',
  },
  companionPreviewHint: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 12,
    textAlign: 'center',
    paddingHorizontal: 12,
    paddingTop: 10,
  },
  companionPreviewCaptionBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: 'rgba(0,0,0,0.62)',
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
  },
  companionPreviewCaptionText: {
    color: '#fff',
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
  typedPreviewLoadingText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 14,
    fontWeight: '600',
    marginTop: 10,
  },
  takeCompletePane: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 20,
  },
  takeCompleteOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(16, 24, 32, 0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    gap: 10,
    zIndex: 2,
  },
  cameraRestoringOverlay: {
    ...StyleSheet.absoluteFillObject,
    // Opaque (matches the media card) so the brief back-camera flash on a fresh iOS mount
    // is fully hidden until the front camera is ready.
    backgroundColor: '#101820',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    zIndex: 3,
  },
  processingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 8,
    marginBottom: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  processingBannerText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 13,
    fontWeight: '600',
  },
  takeCompleteTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  takeCompleteHint: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
  uploadingSpinner: {
    marginRight: 4,
  },
  previewButtonDisabled: {
    opacity: 0.45,
  },
  retakeButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  retakeButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  sendButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: '#2e78b7',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  sendButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
  },
  replayOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 5,
  },
  audioHintBlock: {
    paddingHorizontal: 16,
    paddingBottom: 10,
    gap: 8,
  },
  originalAudioToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  originalAudioToggleLeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexShrink: 1,
  },
  originalAudioToggleLabel: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  originalAudioTogglePill: {
    minWidth: 44,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
  },
  originalAudioTogglePillOn: {
    backgroundColor: 'rgba(125,211,168,0.22)',
  },
  originalAudioTogglePillOff: {
    backgroundColor: 'rgba(239,68,68,0.22)',
  },
  originalAudioToggleState: {
    fontSize: 13,
    fontWeight: '700',
  },
  originalAudioToggleStateOn: {
    color: '#7dd3a8',
  },
  originalAudioToggleStateOff: {
    color: '#ef4444',
  },
  audioHintText: {
    flexShrink: 1,
    color: 'rgba(243, 156, 18, 0.72)',
    fontSize: 12,
    lineHeight: 16,
    textAlign: 'center',
  },
  infoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 6,
    marginTop: 3,
  },
  infoBtnText: {
    color: '#4a90d9',
    fontSize: 14,
    fontWeight: '500',
  },
  infoModalRoot: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  infoModalBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  infoModalCard: {
    backgroundColor: '#1a1a1a',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '85%',
    overflow: 'hidden',
  },
  infoModalHeader: {
    paddingTop: 4,
    paddingBottom: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  sheetHandle: {
    backgroundColor: '#666',
    width: 40,
    height: 5,
    borderRadius: 3,
    alignSelf: 'center',
    marginTop: 8,
    marginBottom: 4,
  },
  infoModalCloseBtn: {
    position: 'absolute',
    top: 6,
    right: 12,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoModalScrollHost: {
    flexGrow: 0,
  },
  infoSheetScroll: {
    paddingHorizontal: 24,
    paddingTop: 18,
    paddingBottom: 24,
  },
  infoTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 6,
  },
  infoSubtitle: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 18,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 16,
  },
  infoIconWrap: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  infoTextWrap: {
    flex: 1,
  },
  infoLabel: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 2,
  },
  infoDesc: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 13,
    lineHeight: 19,
  },
  infoDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.12)',
    marginVertical: 16,
  },
  infoProTipHeader: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 10,
  },
  infoProTip: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 10,
  },
  infoProTipStrong: {
    color: 'rgba(255,255,255,0.7)',
    fontWeight: '600',
  },
});
