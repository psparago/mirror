import {
  defaultReactionOriginalAudioEnabled,
  REACTION_PARENT_PLAYBACK_VOLUME,
  resolveReactionRecordingVolume,
} from '@/utils/reactionPlayback';
import { uploadReaction } from '@/utils/reactionUpload';
import { useAudioRoute } from '@/utils/audioRoute';
import {
  configureConnectPlaybackAudioSessionAsync,
  configureConnectReactionRecordingAudioSessionAsync,
} from '@/utils/audioSession';
import {
  beginSelfieReactionRecordingAudioGuardAsync,
  endSelfieReactionRecordingAudioGuardAsync,
  isNativeSelfieRecordingAudioAvailable,
  reassertSelfieReactionRecordingAudioAsync,
  scheduleSelfieRecordingAudioReasserts,
  startNativeParentRecordingPlaybackAsync,
  stopNativeParentRecordingPlaybackAsync,
  traceReactionAudio,
  traceReactionAudioCapabilities,
  type ReactionAudioTraceContext,
} from '@/utils/reactionRecordingAudio';
import { FontAwesome } from '@expo/vector-icons';
import { useAuth, useExplorer, VideoTrimSlider, type ReactionType } from '@projectmirror/shared';
import { Audio, ResizeMode, Video, type AVPlaybackStatus } from 'expo-av';
import { Camera, CameraView, useCameraPermissions } from 'expo-camera';
import { RecordingPresets, requestRecordingPermissionsAsync, useAudioRecorder } from 'expo-audio';
import { Image } from 'expo-image';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
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
const ANDROID_CAMERA_REMOUNT_MS = 300;

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
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micReady, setMicReady] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
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
  const [nativeCameraGranted, setNativeCameraGranted] = useState<boolean | null>(null);
  const [showTrimPreviewReplay, setShowTrimPreviewReplay] = useState(false);
  const [companionPreviewOpen, setCompanionPreviewOpen] = useState(false);
  const [companionPreviewPlaying, setCompanionPreviewPlaying] = useState(false);
  const [showCompanionPreviewReplay, setShowCompanionPreviewReplay] = useState(false);
  const [isInfoOpen, setIsInfoOpen] = useState(false);

  const voiceRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const androidCameraRemountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const companionPreviewStopPendingRef = useRef(false);

  // Live audio output route. Headphones/Bluetooth → the parent Reflection can play out loud during
  // recording (no echo path); otherwise we fall back to the platform echo policy.
  const audioRoute = useAudioRoute(visible);
  const hasHeadphones = audioRoute.hasHeadphones;

  const isVideoParent = parentMedia?.mediaType === 'video';
  const isImageParent = parentMedia?.mediaType === 'image';
  const parentVideoUrl = parentMedia?.mediaType === 'video' ? parentMedia.videoUrl : '';
  const parentImageUrl = parentMedia?.mediaType === 'image' ? parentMedia.imageUrl : '';
  const hasValidParentMedia =
    (isVideoParent && !!parentVideoUrl) || (isImageParent && !!parentImageUrl);
  const parentPosterUri = isVideoParent ? parentVideoUrl : parentImageUrl;

  const videoRef = useRef<Video>(null);
  const companionParentRef = useRef<Video>(null);
  const companionSelfieRef = useRef<Video>(null);
  const cameraRef = useRef<CameraView>(null);
  const recordingPromiseRef = useRef<Promise<{ uri: string } | undefined> | null>(null);
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
  const lastPanSeekAtRef = useRef(0);
  const lastParentVolumeApplyRef = useRef(0);
  const lastCompanionParentVolumeApplyRef = useRef(0);
  const hasHeadphonesRef = useRef(false);
  // True once the Companion manually toggles "Original audio", so we stop applying the smart default.
  const userToggledMuteRef = useRef(false);
  const isRecordingRef = useRef(false);
  const recordingAudioReassertCancelRef = useRef<(() => void) | null>(null);

  const getReactionParentVolume = useCallback(
    () =>
      resolveReactionRecordingVolume({
        muted: isParentReflectionMutedRef.current,
        hasHeadphones: hasHeadphonesRef.current,
      }),
    [],
  );

  const buildRecordingAudioTraceContext = useCallback(
    (extra: ReactionAudioTraceContext = {}): ReactionAudioTraceContext => ({
      originalAudioMuted: isParentReflectionMutedRef.current,
      parentVolume: getReactionParentVolume(),
      hasHeadphones: hasHeadphonesRef.current,
      syncStartMs: syncStartTimeMillis ?? trimStartMsRef.current,
      ...extra,
    }),
    [getReactionParentVolume, syncStartTimeMillis],
  );

  /** Keep expo-av mute flag and volume in sync — setStatusAsync(volume) alone clears isMuted. */
  const syncParentVideoAudioAsync = useCallback(
    async (target: Video | null | undefined) => {
      if (!target) return;
      const muted = isParentReflectionMutedRef.current;
      const volume = getReactionParentVolume();
      await runVideoCommand(async () => {
        await target.setIsMutedAsync(muted);
        await target.setVolumeAsync(volume);
      }, 'failed to sync parent audio');
    },
    [getReactionParentVolume],
  );

  const applyParentReflectionVolume = useCallback(async () => {
    await syncParentVideoAudioAsync(videoRef.current);
  }, [syncParentVideoAudioAsync]);

  const startParentRecordingPlayback = useCallback(
    async (startMs: number, options?: { useNativeVoiceChatAudio?: boolean }) => {
      if (!isVideoParent) return;
      const useNativeVoiceChatAudio =
        options?.useNativeVoiceChatAudio !== false && isNativeSelfieRecordingAudioAvailable();
      const muted = isParentReflectionMutedRef.current;
      const volume = getReactionParentVolume();
      const traceContext = buildRecordingAudioTraceContext({
        syncStartMs: startMs,
        parentVolume: volume,
        originalAudioMuted: muted,
      });

      if (useNativeVoiceChatAudio) {
        traceReactionAudio('recording-playback:native-path', {
          ...traceContext,
          parentPlaybackPath: muted || volume <= 0 ? 'silent' : 'native-voicechat',
        });
        await runVideoCommand(
          () =>
            videoRef.current?.setStatusAsync({
              positionMillis: startMs,
              shouldPlay: true,
              isMuted: true,
              volume: 0,
            }),
          'reaction visual sync failed',
        );
        if (!muted && volume > 0) {
          await startNativeParentRecordingPlaybackAsync(parentVideoUrl, startMs, volume, traceContext);
        } else {
          await stopNativeParentRecordingPlaybackAsync(traceContext);
        }
        return;
      }

      traceReactionAudio('recording-playback:expo-av-path', {
        ...traceContext,
        parentPlaybackPath: muted || volume <= 0 ? 'silent' : 'expo-av',
      });
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
    [
      buildRecordingAudioTraceContext,
      getReactionParentVolume,
      isVideoParent,
      parentVideoUrl,
      syncParentVideoAudioAsync,
    ],
  );

  const finishCompanionPreview = useCallback(async () => {
    if (companionPreviewStopPendingRef.current) return;
    companionPreviewStopPendingRef.current = true;
    setCompanionPreviewPlaying(false);
    await companionSelfieRef.current?.pauseAsync().catch(() => {});
    await runVideoCommand(() => companionParentRef.current?.pauseAsync(), 'companion preview pause failed');
    if (isVideoParent && syncStartTimeMillis != null) {
      await runVideoCommand(
        () =>
          companionParentRef.current?.setStatusAsync({
            positionMillis: syncStartTimeMillis,
            shouldPlay: false,
            volume: getReactionParentVolume(),
          }),
        'companion preview reset failed',
      );
    }
    companionPreviewStopPendingRef.current = false;
    setShowCompanionPreviewReplay(true);
    traceReactionAudio('companion-preview:finished', buildRecordingAudioTraceContext());
  }, [buildRecordingAudioTraceContext, getReactionParentVolume, isVideoParent, syncStartTimeMillis]);

  const startCompanionPreview = useCallback(async () => {
    if (!recordedUri) return;
    setCompanionPreviewPlaying(true);
    setShowCompanionPreviewReplay(false);
    companionPreviewStopPendingRef.current = false;

    traceReactionAudio('companion-preview:start', {
      ...buildRecordingAudioTraceContext(),
      parentPlaybackPath: 'expo-av',
      parentVolume: REACTION_PARENT_PLAYBACK_VOLUME,
      originalAudioMuted: false,
    });

    try {
      await configureConnectPlaybackAudioSessionAsync();
    } catch (error) {
      console.warn('[ReactionSheet] preview audio session failed:', error);
      traceReactionAudio('companion-preview:session-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await companionSelfieRef.current
      ?.setStatusAsync({
        positionMillis: 0,
        shouldPlay: true,
        isMuted: false,
        volume: 1.0,
      })
      .catch(() => {});

    if (isVideoParent && syncStartTimeMillis != null) {
      await runVideoCommand(
        () =>
          companionParentRef.current?.setStatusAsync({
            positionMillis: syncStartTimeMillis,
            shouldPlay: true,
            isMuted: false,
            volume: REACTION_PARENT_PLAYBACK_VOLUME,
          }),
        'failed to start companion preview',
      );
    }

    traceReactionAudio('companion-preview:playing', buildRecordingAudioTraceContext({
      parentPlaybackPath: 'expo-av',
      parentVolume: REACTION_PARENT_PLAYBACK_VOLUME,
    }));
  }, [buildRecordingAudioTraceContext, isVideoParent, recordedUri, syncStartTimeMillis]);

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
    setCompanionPreviewOpen(false);
    setCompanionPreviewPlaying(false);
    setShowCompanionPreviewReplay(false);
    companionPreviewStopPendingRef.current = false;
    void companionSelfieRef.current?.pauseAsync().catch(() => {});
    void companionParentRef.current?.pauseAsync().catch(() => {});
  }, []);

  useEffect(() => {
    if (!companionPreviewOpen || !recordedUri) return;
    void startCompanionPreview();
  }, [companionPreviewOpen, recordedUri, startCompanionPreview]);

  const handleCompanionParentStatusUpdate = useCallback(
    (status: AVPlaybackStatus) => {
      if (!status.isLoaded || !companionPreviewOpen || !companionPreviewPlaying || !isVideoParent) {
        return;
      }
      const now = Date.now();
      if (now - lastCompanionParentVolumeApplyRef.current >= 200) {
        lastCompanionParentVolumeApplyRef.current = now;
        void companionParentRef.current
          ?.setIsMutedAsync(false)
          .then(() =>
            companionParentRef.current?.setVolumeAsync(REACTION_PARENT_PLAYBACK_VOLUME),
          )
          .catch(() => {});
      }
      if (!status.isPlaying || syncStartTimeMillis == null) return;
      const previewEndMs =
        syncEndTimeMillis ??
        (syncStartTimeMillis != null ? status.durationMillis ?? durationMillisRef.current : 0);
      if (
        previewEndMs > syncStartTimeMillis &&
        status.positionMillis >= previewEndMs - PREVIEW_END_EPSILON_MS
      ) {
        void finishCompanionPreview();
      }
    },
    [
      companionPreviewOpen,
      companionPreviewPlaying,
      finishCompanionPreview,
      isVideoParent,
      syncEndTimeMillis,
      syncStartTimeMillis,
    ],
  );

  const handleCompanionSelfieStatusUpdate = useCallback(
    (status: AVPlaybackStatus) => {
      if (!status.isLoaded || !companionPreviewOpen || !companionPreviewPlaying) return;
      if (!status.didJustFinish) return;
      if (isVideoParent) {
        void finishCompanionPreview();
        return;
      }
      void finishCompanionPreview();
    },
    [companionPreviewOpen, companionPreviewPlaying, finishCompanionPreview, isVideoParent],
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

  // Default Original audio: on with headphones, off on speaker (both platforms).
  useEffect(() => {
    if (!visible || userToggledMuteRef.current) return;
    const enabled = defaultReactionOriginalAudioEnabled({ hasHeadphones });
    setIsParentReflectionMuted(!enabled);
    isParentReflectionMutedRef.current = !enabled;
  }, [visible, hasHeadphones]);

  useEffect(() => {
    isPreviewPlayingRef.current = isPreviewPlaying;
  }, [isPreviewPlaying]);

  useEffect(() => {
    if (durationMillis <= 0) return;
    setTrimEndMs((prev) => {
      const next = prev <= 0 ? durationMillis : Math.min(prev, durationMillis);
      trimEndMsRef.current = next;
      return next;
    });
  }, [durationMillis]);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    canScrubRef.current =
      reactionMode === 'selfie' && isVideoParent && !isRecording && recordedUri == null;
  }, [isRecording, isVideoParent, reactionMode, recordedUri]);

  useEffect(() => {
    if (!visible) return;
    traceReactionAudioCapabilities('reaction-sheet-open');
    void (async () => {
      const micPermission = await requestRecordingPermissionsAsync();
      setMicReady(micPermission.granted);
      await configureConnectReactionRecordingAudioSessionAsync();
      let current = await Camera.getCameraPermissionsAsync();
      if (!current.granted && current.canAskAgain) {
        current = await Camera.requestCameraPermissionsAsync();
      }
      void requestCameraPermission();
      setNativeCameraGranted(current.granted);
    })();
  }, [visible, requestCameraPermission]);

  const bumpCameraInstance = useCallback(() => {
    setCameraReady(false);
    setCameraInstanceKey((key) => key + 1);
  }, []);

  const scheduleAndroidCameraRemount = useCallback(() => {
    if (Platform.OS !== 'android') return;
    if (androidCameraRemountTimerRef.current) {
      clearTimeout(androidCameraRemountTimerRef.current);
    }
    androidCameraRemountTimerRef.current = setTimeout(() => {
      androidCameraRemountTimerRef.current = null;
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
        void ensureCameraPermission();
        scheduleAndroidCameraRemount();
      }
    });
    return () => subscription.remove();
  }, [visible, reactionMode, ensureCameraPermission, scheduleAndroidCameraRemount]);

  const handleModalShow = useCallback(() => {
    if (reactionMode !== 'selfie') return;
    if (Platform.OS === 'android') {
      scheduleAndroidCameraRemount();
    } else {
      bumpCameraInstance();
    }
  }, [bumpCameraInstance, reactionMode, scheduleAndroidCameraRemount]);

  useEffect(() => {
    if (!visible || reactionMode !== 'selfie' || recordedUri != null) return;
    if (!(cameraPermission?.granted || nativeCameraGranted)) return;

    setCameraReady(false);
    const readyTimer = setTimeout(() => {
      setCameraReady(true);
    }, 500);

    return () => clearTimeout(readyTimer);
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
    setSyncStartTimeMillis(null);
    setSyncEndTimeMillis(null);
    setIsPreviewPlaying(false);
    setCompanionPreviewOpen(false);
    setCompanionPreviewPlaying(false);
    setShowCompanionPreviewReplay(false);
    companionPreviewStopPendingRef.current = false;
    setShowTrimPreviewReplay(false);
    setTrimStartMs(0);
    setTrimEndMs(0);
    trimStartMsRef.current = 0;
    trimEndMsRef.current = 0;
    setIsParentReflectionMuted(false);
    isParentReflectionMutedRef.current = false;
    userToggledMuteRef.current = false;
    setReactionMode('selfie');
    setTypedMessage('');
    setVoiceRecordedUri(null);
    setIsVoiceRecording(false);
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
    setIsUploading(false);
    recordingPromiseRef.current = null;
    recordingAudioReassertCancelRef.current?.();
    recordingAudioReassertCancelRef.current = null;
    isRecordingRef.current = false;
    void stopNativeParentRecordingPlaybackAsync();
    void endSelfieReactionRecordingAudioGuardAsync();
    void videoRef.current?.pauseAsync().catch(() => {});
    void videoRef.current?.setVolumeAsync(1).catch(() => {});
    cameraRef.current?.stopRecording();
  }, [visible]);

  useEffect(() => {
    if (!isVideoParent || isRecording) return;
    void applyParentReflectionVolume();
  }, [applyParentReflectionVolume, hasHeadphones, isParentReflectionMuted, isRecording, isVideoParent]);

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
      setShowTrimPreviewReplay(true);
    }
  }, [getReactionParentVolume, isVideoParent]);

  const handlePlaybackStatusUpdate = useCallback(
    (status: AVPlaybackStatus) => {
      if (!status.isLoaded) return;

      if (isVideoParent) {
        const now = Date.now();
        if (now - lastParentVolumeApplyRef.current >= 200) {
          lastParentVolumeApplyRef.current = now;
          void applyParentReflectionVolume();
        }
      }

      const duration = status.durationMillis ?? 0;
      if (duration > 0) {
        setDurationMillis(duration);
        durationMillisRef.current = duration;
      }

      if (recordedUri && isVideoParent) {
        return;
      }

      if (isRecording && isVideoParent) {
        if (!isScrubbingRef.current) {
          positionMillisRef.current = status.positionMillis;
          setPositionMillis(status.positionMillis);
        }
        return;
      }

      if (!isVideoParent) return;

      if (status.isPlaying && !isScrubbingRef.current) {
        positionMillisRef.current = status.positionMillis;
        setPositionMillis(status.positionMillis);
        setIsPreviewPlaying(true);

        const end = trimEndMsRef.current || duration;
        if (
          end > trimStartMsRef.current &&
          status.positionMillis >= end - PREVIEW_END_EPSILON_MS &&
          status.positionMillis > trimStartMsRef.current + PREVIEW_END_EPSILON_MS
        ) {
          void stopPreviewAtTrimEnd();
        }
        return;
      }

      if (!isScrubbingRef.current) {
        setIsPreviewPlaying(false);
      }
    },
    [
      applyParentReflectionVolume,
      isVideoParent,
      stopPreviewAtTrimEnd,
      recordedUri,
      isRecording,
    ],
  );

  const pauseParentPreview = useCallback(async () => {
    if (!isVideoParent) return;
    setIsPreviewPlaying(false);
    isPreviewPlayingRef.current = false;
    await runVideoCommand(() => videoRef.current?.pauseAsync(), 'pause preview failed');
  }, [isVideoParent]);

  const toggleParentPlayback = useCallback(async () => {
    if (!isVideoParent || isRecording || recordedUri) return;
    const status = await videoRef.current?.getStatusAsync();
    if (!status?.isLoaded) return;

    if (status.isPlaying) {
      await pauseParentPreview();
      const start = trimStartMsRef.current;
      await commitVideoPosition(start, {
        shouldPlay: false,
        volume: getReactionParentVolume(),
      });
      return;
    }

    const start = trimStartMsRef.current;
    positionMillisRef.current = start;
    setPositionMillis(start);
    setShowTrimPreviewReplay(false);
    await runVideoCommand(
      () =>
        videoRef.current?.setStatusAsync({
          positionMillis: start,
          shouldPlay: true,
          isMuted: isParentReflectionMutedRef.current,
          volume: getReactionParentVolume(),
        }),
      'toggle playback failed',
    );
    setIsPreviewPlaying(true);
    isPreviewPlayingRef.current = true;
  }, [
    commitVideoPosition,
    getReactionParentVolume,
    isRecording,
    isVideoParent,
    pauseParentPreview,
    recordedUri,
  ]);

  const replayTrimPreview = useCallback(() => {
    void toggleParentPlayback();
  }, [toggleParentPlayback]);

  const toggleParentReflectionMute = useCallback(() => {
    userToggledMuteRef.current = true;
    setIsParentReflectionMuted((prev) => {
      const next = !prev;
      isParentReflectionMutedRef.current = next;
      traceReactionAudio('original-audio-toggled', buildRecordingAudioTraceContext({
        originalAudioMuted: next,
        parentVolume: resolveReactionRecordingVolume({
          muted: next,
          hasHeadphones: hasHeadphonesRef.current,
        }),
      }));
      return next;
    });
  }, [buildRecordingAudioTraceContext]);

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
      void queueVideoSeek(nextPositionMillis, { updateUi: false });
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
    reactionMode === 'selfie' && isVideoParent && !isRecording && recordedUri == null;

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

  const handlePressIn = useCallback(() => {
    if (
      recordedUri ||
      !cameraReady ||
      !(cameraPermission?.granted || nativeCameraGranted) ||
      !micReady
    ) {
      if (!recordedUri) {
        console.warn('[ReactionSheet] camera not ready for recording', {
          parentReflectionId,
          cameraReady,
          cameraGranted: cameraPermission?.granted ?? nativeCameraGranted,
          micReady,
        });
      }
      return;
    }

    const syncStart = isVideoParent ? trimStartMsRef.current : 0;
    setSyncStartTimeMillis(syncStart);
    setIsRecording(true);
    setIsPreviewPlaying(false);

    traceReactionAudio('record-press-in', buildRecordingAudioTraceContext({ syncStartMs: syncStart }));

    void (async () => {
      if (isVideoParent) {
        try {
          await beginSelfieReactionRecordingAudioGuardAsync();
          await startParentRecordingPlayback(syncStart);
        } catch (error) {
          console.warn('[ReactionSheet] recording audio session failed:', error);
          traceReactionAudio('record-press-in:audio-failed', {
            ...buildRecordingAudioTraceContext({ syncStartMs: syncStart }),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      traceReactionAudio('recordAsync:starting', buildRecordingAudioTraceContext({ syncStartMs: syncStart }));

      const recordingPromise = cameraRef.current?.recordAsync();
      if (recordingPromise) {
        recordingPromiseRef.current = recordingPromise;
        void recordingPromise
          .then((result) => {
            traceReactionAudio('recordAsync:complete', {
              ...buildRecordingAudioTraceContext({ syncStartMs: syncStart }),
              recordedUri: result?.uri ?? null,
            });
            if (result?.uri) {
              setRecordedUri(result.uri);
            }
          })
          .catch((error) => {
            console.warn('[ReactionSheet] recordAsync failed:', error);
            traceReactionAudio('recordAsync:failed', {
              ...buildRecordingAudioTraceContext({ syncStartMs: syncStart }),
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }

      if (isVideoParent) {
        const reassertRecordingAudio = async (reassertDelayMs: number) => {
          if (!isRecordingRef.current) return;
          const traceContext = buildRecordingAudioTraceContext({
            syncStartMs: syncStart,
            reassertDelayMs,
          });
          try {
            traceReactionAudio('record-reassert:start', traceContext);
            await reassertSelfieReactionRecordingAudioAsync(reassertDelayMs);
            if (isNativeSelfieRecordingAudioAvailable()) {
              const volume = getReactionParentVolume();
              if (!isParentReflectionMutedRef.current && volume > 0) {
                await startNativeParentRecordingPlaybackAsync(
                  parentVideoUrl,
                  syncStart,
                  volume,
                  traceContext,
                );
              } else {
                await stopNativeParentRecordingPlaybackAsync(traceContext);
              }
            } else {
              await startParentRecordingPlayback(syncStart, { useNativeVoiceChatAudio: false });
            }
            traceReactionAudio('record-reassert:complete', traceContext);
          } catch (error) {
            console.warn('[ReactionSheet] recording audio reassert failed:', error);
            traceReactionAudio('record-reassert:failed', {
              ...traceContext,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        };

        recordingAudioReassertCancelRef.current?.();
        recordingAudioReassertCancelRef.current =
          scheduleSelfieRecordingAudioReasserts(reassertRecordingAudio);
      }
    })();
  }, [
    buildRecordingAudioTraceContext,
    cameraPermission?.granted,
    cameraReady,
    getReactionParentVolume,
    isVideoParent,
    micReady,
    nativeCameraGranted,
    parentReflectionId,
    parentVideoUrl,
    recordedUri,
    startParentRecordingPlayback,
  ]);

  const handlePressOut = useCallback(() => {
    if (!isRecording) return;

    void (async () => {
      recordingAudioReassertCancelRef.current?.();
      recordingAudioReassertCancelRef.current = null;

      traceReactionAudio('record-press-out:start', buildRecordingAudioTraceContext());

      if (isVideoParent) {
        const status = await videoRef.current?.getStatusAsync();
        const syncEndMs = status?.isLoaded ? status.positionMillis : undefined;
        if (status?.isLoaded) {
          setSyncEndTimeMillis(status.positionMillis);
        }
        const stopContext = buildRecordingAudioTraceContext({
          syncEndMs,
          recordingDurationMs:
            syncEndMs != null && syncStartTimeMillis != null
              ? syncEndMs - syncStartTimeMillis
              : undefined,
        });
        await stopNativeParentRecordingPlaybackAsync(stopContext);
        await videoRef.current?.pauseAsync().catch(() => {});
        await syncParentVideoAudioAsync(videoRef.current);
        try {
          await endSelfieReactionRecordingAudioGuardAsync(stopContext);
          await configureConnectPlaybackAudioSessionAsync();
        } catch (error) {
          console.warn('[ReactionSheet] failed to restore playback audio session:', error);
          traceReactionAudio('record-press-out:restore-failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        traceReactionAudio('record-press-out:complete', stopContext);
      } else {
        setSyncEndTimeMillis(0);
        traceReactionAudio('record-press-out:complete', buildRecordingAudioTraceContext());
      }
      setIsRecording(false);
      isRecordingRef.current = false;
      cameraRef.current?.stopRecording();
    })();
  }, [
    buildRecordingAudioTraceContext,
    isRecording,
    isVideoParent,
    syncParentVideoAudioAsync,
    syncStartTimeMillis,
  ]);

  const resetVoiceRecording = useCallback(() => {
    setVoiceRecordedUri(null);
    setIsVoiceRecording(false);
  }, []);

  const handleReactionModeChange = useCallback(
    (nextMode: ReactionComposeMode) => {
      if (nextMode === reactionMode || isUploading) return;
      setReactionMode(nextMode);
      setRecordedUri(null);
      setSyncStartTimeMillis(null);
      setSyncEndTimeMillis(null);
      setIsPreviewPlaying(false);
      setIsRecording(false);
      resetVoiceRecording();
      setTypedMessage('');
      if (nextMode === 'selfie') {
        void ensureCameraPermission();
        if (Platform.OS === 'android') {
          scheduleAndroidCameraRemount();
        } else {
          bumpCameraInstance();
        }
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
    if (!micReady || isVoiceRecording) return;
    try {
      await configureConnectReactionRecordingAudioSessionAsync({ voiceChatAec: false });
      if (isVideoParent) {
        const startMs = trimStartMsRef.current;
        await startParentRecordingPlayback(startMs, { useNativeVoiceChatAudio: false });
      }
      await voiceRecorder.prepareToRecordAsync();
      voiceRecorder.record();
      setIsVoiceRecording(true);
    } catch (error) {
      console.warn('[ReactionSheet] voice record start failed:', error);
      Alert.alert('Recording Failed', 'Could not start voice recording.');
    }
  }, [
    isVideoParent,
    isVoiceRecording,
    micReady,
    startParentRecordingPlayback,
    voiceRecorder,
  ]);

  const handleStopVoiceRecording = useCallback(async () => {
    if (!isVoiceRecording) return;
    try {
      if (isVideoParent) {
        await runVideoCommand(() => videoRef.current?.pauseAsync(), 'voice reaction pause failed');
      }
      await voiceRecorder.stop();
      setIsVoiceRecording(false);
      if (voiceRecorder.uri) {
        setVoiceRecordedUri(voiceRecorder.uri);
      }
    } catch (error) {
      console.warn('[ReactionSheet] voice record stop failed:', error);
      setIsVoiceRecording(false);
    }
  }, [isVideoParent, isVoiceRecording, voiceRecorder]);

  const handleRetake = useCallback(() => {
    if (reactionMode === 'voice') {
      resetVoiceRecording();
      return;
    }
    const restartAt = syncStartTimeMillis;
    setRecordedUri(null);
    setSyncStartTimeMillis(null);
    setSyncEndTimeMillis(null);
    setIsPreviewPlaying(false);
    setCompanionPreviewOpen(false);
    setCompanionPreviewPlaying(false);
    setShowCompanionPreviewReplay(false);
    companionPreviewStopPendingRef.current = false;
    setCameraReady(false);
    bumpCameraInstance();
    scheduleAndroidCameraRemount();
    void (async () => {
      if (isVideoParent && restartAt != null) {
        await commitVideoPosition(restartAt, {
          shouldPlay: false,
          volume: getReactionParentVolume(),
        });
      }
      await videoRef.current?.pauseAsync().catch(() => {});
    })();
  }, [
    bumpCameraInstance,
    commitVideoPosition,
    getReactionParentVolume,
    isVideoParent,
    reactionMode,
    resetVoiceRecording,
    scheduleAndroidCameraRemount,
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
            reactionMode === 'selfie' ? (syncStartTimeMillis ?? 0) : 0,
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
    onClose,
    onUploadSuccess,
    parentPosterUri,
    parentReflectionId,
    reactionMode,
    recordedUri,
    syncStartTimeMillis,
    typedMessage,
    user?.uid,
    voiceRecordedUri,
  ]);

  const isSelfiePreviewMode = reactionMode === 'selfie' && recordedUri != null;
  const isSelfieTakeComplete = isSelfiePreviewMode && !companionPreviewOpen;
  const isVoicePreviewMode = reactionMode === 'voice' && voiceRecordedUri != null;
  const isPreviewMode = isSelfiePreviewMode || isVoicePreviewMode;
  const isCameraGranted =
    cameraPermission?.granted === true || nativeCameraGranted === true;
  const isCameraDenied =
    nativeCameraGranted === false && cameraPermission?.granted !== true;

  const canRecordSelfie =
    reactionMode === 'selfie' &&
    !recordedUri &&
    isCameraGranted &&
    micReady &&
    cameraReady;
  const canSendTyped = reactionMode === 'typed' && typedMessage.trim().length > 0;
  const scrubDurationMs = Math.max(durationMillis, 1);
  const scrubEndMs = trimEndMs > 0 ? trimEndMs : scrubDurationMs;
  const parentRecordingVolume = resolveReactionRecordingVolume({
    muted: isParentReflectionMuted,
    hasHeadphones,
  });
  // A gentle, non-imposing one-liner that only appears when the parent has audio worth hearing.
  const showAudioHint =
    isVideoParent &&
    !companionPreviewOpen &&
    !isPreviewMode &&
    (reactionMode === 'selfie' || reactionMode === 'voice');
  const audioHintText = hasHeadphones
    ? 'Headphones connected — turn Original audio on to hear the Reflection while you record.'
    : 'On speaker, keep Original audio off to avoid echo. Plug in headphones to listen while recording.';
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

  return (
    <Modal
      visible={visible && hasValidParentMedia}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
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
              <View style={styles.closeButtonSpacer} />
            </>
          ) : (
            <>
              <Text style={styles.headerTitle}>Live Sync Reaction</Text>
              <Pressable
                style={styles.closeButton}
                onPress={onClose}
                disabled={isUploading}
                accessibilityRole="button"
                accessibilityLabel="Close reaction recorder"
              >
                <FontAwesome name="times" size={18} color="#fff" />
              </Pressable>
            </>
          )}
        </View>

        {companionPreviewOpen && recordedUri ? (
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
                  isMuted={false}
                  volume={REACTION_PARENT_PLAYBACK_VOLUME}
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
              <Video
                ref={companionSelfieRef}
                source={{ uri: recordedUri }}
                style={[styles.companionSelfiePip, styles.reactionPipVideo]}
                resizeMode={ResizeMode.COVER}
                shouldPlay={false}
                isLooping={false}
                isMuted={false}
                volume={1.0}
                progressUpdateIntervalMillis={100}
                onPlaybackStatusUpdate={handleCompanionSelfieStatusUpdate}
              />
              {showCompanionPreviewReplay && !companionPreviewPlaying ? (
                <View style={[styles.replayOverlay, styles.companionPreviewReplayOverlay]}>
                  <Pressable
                    style={styles.replayButton}
                    onPress={replayCompanionPreview}
                    accessibilityRole="button"
                    accessibilityLabel="Replay reaction preview"
                  >
                    <FontAwesome name="repeat" size={24} color="#fff" />
                    <Text style={styles.replayText}>Replay</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
            <Text style={styles.companionPreviewHint}>
              {isVideoParent
                ? 'This is how your Companions will see your reaction. Your voice is front and center; the Reflection plays softly in the background.'
                : 'This is how your Companions will see your reaction on this photo.'}
            </Text>
          </View>
        ) : (
        <View style={styles.splitPane}>
          <View style={styles.parentVideoPane}>
            <View style={styles.mediaCard}>
              {isVideoParent ? (
                <>
                  <GestureDetector gesture={showScrubUi ? videoPanGesture : Gesture.Pan().enabled(false)}>
                    <View
                      style={styles.parentVideoSurface}
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
                        isMuted={isParentReflectionMuted}
                        volume={parentRecordingVolume}
                        progressUpdateIntervalMillis={100}
                        onPlaybackStatusUpdate={handlePlaybackStatusUpdate}
                      />
                      {showScrubUi ? (
                        <View style={styles.dragHintOverlay} pointerEvents="none">
                          <Text style={styles.dragHintText}>Drag to set start</Text>
                        </View>
                      ) : null}
                      {showTrimPreviewReplay && showScrubUi ? (
                        <View style={styles.replayOverlay}>
                          <Pressable
                            style={styles.replayButton}
                            onPress={replayTrimPreview}
                            accessibilityRole="button"
                            accessibilityLabel="Replay Reflection preview"
                          >
                            <FontAwesome name="repeat" size={24} color="#fff" />
                            <Text style={styles.replayText}>Replay</Text>
                          </Pressable>
                        </View>
                      ) : null}
                    </View>
                  </GestureDetector>

                  {showScrubUi && durationMillis > 0 ? (
                    <>
                      <View style={styles.trimSliderWrap}>
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

          <View style={styles.cameraPane}>
            <View style={styles.mediaCard}>
              {isSelfieTakeComplete ? (
                <View style={styles.takeCompletePane}>
                  <FontAwesome name="check-circle" size={42} color="#7dd3a8" />
                  <Text style={styles.takeCompleteTitle}>Reaction recorded</Text>
                  <Text style={styles.takeCompleteHint}>
                    Preview how Companions will see it, or retake if you want another try.
                  </Text>
                </View>
              ) : isVoicePreviewMode ? (
                <View style={styles.altModePane}>
                  <FontAwesome name="microphone" size={36} color="#fff" />
                  <Text style={styles.altModeTitle}>Voice message ready</Text>
                  <Text style={styles.altModeHint}>Send it or retake below.</Text>
                </View>
              ) : reactionMode === 'typed' ? (
                <View style={styles.altModePane}>
                  <Text style={styles.altModeTitle}>Type your reaction</Text>
                  <TextInput
                    style={styles.typedInput}
                    placeholder="Say something warm and short…"
                    placeholderTextColor="rgba(255,255,255,0.4)"
                    value={typedMessage}
                    onChangeText={setTypedMessage}
                    maxLength={TYPED_MESSAGE_MAX_LENGTH}
                    multiline
                    textAlignVertical="top"
                    editable={!isUploading}
                  />
                  <Text style={styles.typedCounter}>
                    {typedMessage.length}/{TYPED_MESSAGE_MAX_LENGTH}
                  </Text>
                </View>
              ) : reactionMode === 'voice' ? (
                <View style={styles.altModePane}>
                  <FontAwesome name="microphone" size={36} color="#fff" />
                  <Text style={styles.altModeTitle}>
                    {isVoiceRecording ? 'Recording…' : 'Record a voice message'}
                  </Text>
                  <Text style={styles.altModeHint}>
                    {isVoiceRecording
                      ? 'Tap stop when you are done.'
                      : 'Your voice, not AI — good for public places.'}
                  </Text>
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
                    disabled={!micReady || isUploading}
                  >
                    <FontAwesome name={isVoiceRecording ? 'stop' : 'microphone'} size={16} color="#fff" />
                    <Text style={styles.voiceRecordButtonText}>
                      {isVoiceRecording ? 'Stop recording' : 'Start recording'}
                    </Text>
                  </Pressable>
                </View>
              ) : isCameraGranted ? (
                <View style={styles.cameraStageHost}>
                  <View style={styles.cameraStage}>
                    <CameraView
                      key={cameraInstanceKey}
                      ref={cameraRef}
                      style={styles.cameraPreview}
                      facing="front"
                      mode="video"
                      mirror
                      videoQuality="720p"
                      onCameraReady={() => setCameraReady(true)}
                      onMountError={(event) => {
                        console.warn('[ReactionSheet] camera mount error:', event.message);
                        setCameraReady(false);
                      }}
                    />
                  </View>
                </View>
              ) : isCameraDenied ? (
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
        )}

        <View style={[styles.interactionFooter, { paddingBottom: insets.bottom }]}>
          {showAudioHint ? (
            <View style={styles.audioHintBlock}>
              {renderOriginalAudioToggle()}
              <Text style={styles.audioHintText}>{audioHintText}</Text>
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
                  disabled={isUploading || isPreviewMode || isVoiceRecording}
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
                disabled={isUploading}
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
                onPress={() => void startCompanionPreview()}
                disabled={isUploading || companionPreviewPlaying}
                accessibilityRole="button"
                accessibilityLabel="Preview reaction"
              >
                <FontAwesome name="play" size={15} color="#fff" />
                <Text style={styles.previewPlayButtonText}>Preview</Text>
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
                style={styles.retakeButton}
                onPress={handleRetake}
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
          ) : isVoicePreviewMode ? (
            <View style={styles.previewActions}>
              {isUploading ? (
                <ActivityIndicator color="#fff" style={styles.uploadingSpinner} />
              ) : null}
              <Pressable
                style={[styles.retakeButton, isUploading && styles.previewButtonDisabled]}
                onPress={handleRetake}
                disabled={isUploading}
                accessibilityRole="button"
                accessibilityLabel="Retake reaction"
              >
                <FontAwesome name="refresh" size={15} color="#fff" />
                <Text style={styles.retakeButtonText}>Retake</Text>
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
          ) : reactionMode === 'typed' ? (
            <Pressable
              style={[
                styles.sendButton,
                styles.sendButtonStandalone,
                (!canSendTyped || isUploading) && styles.previewButtonDisabled,
              ]}
              onPress={handleSend}
              disabled={!canSendTyped || isUploading}
              accessibilityRole="button"
              accessibilityLabel="Send typed reaction"
            >
              {isUploading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <FontAwesome name="paper-plane" size={15} color="#fff" />
                  <Text style={styles.sendButtonText}>Send</Text>
                </>
              )}
            </Pressable>
          ) : reactionMode === 'voice' ? null : (
            <Pressable
              onPressIn={handlePressIn}
              onPressOut={handlePressOut}
              disabled={!canRecordSelfie}
              style={({ pressed }) => [
                styles.recordButton,
                isRecording && styles.recordButtonActive,
                (pressed || isRecording) && styles.recordButtonPressed,
                !canRecordSelfie && styles.recordButtonDisabled,
              ]}
              accessibilityRole="button"
              accessibilityLabel={isRecording ? 'Recording reaction' : 'Hold to react'}
              accessibilityHint={
                isImageParent
                  ? 'Press and hold to record your reaction to this photo'
                  : 'Press and hold to record your reaction while the Reflection plays'
              }
            >
              <FontAwesome name="circle" size={14} color="#fff" />
              <Text style={styles.recordButtonText}>
                {isRecording ? 'Recording…' : 'Hold to React'}
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
                      Hold the button to record. The Reflection plays beside you so you can react
                      along with it — for videos, drag to choose where it starts first.
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
                      Just your voice — great for narrating or for quieter, public places where you’d
                      rather not be on camera.
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
                      Write a short note and we’ll read it aloud to the Explorer in a friendly voice.
                    </Text>
                  </View>
                </View>

                <View style={styles.infoDivider} />

                <Text style={styles.infoProTipHeader}>About sound &amp; echo</Text>
                <Text style={styles.infoProTip}>
                  While you record, the Reflection keeps playing so you can react to it. The picture is
                  always there for you to follow.
                </Text>
                <Text style={styles.infoProTip}>
                  <Text style={styles.infoProTipStrong}>Headphones are the sweet spot:</Text> plug them
                  in and you’ll hear the Reflection clearly with no echo in your recording.
                </Text>
                <Text style={styles.infoProTip}>
                  On speaker, leave Original audio off while you record — the video still plays for
                  sync. Preview shows how Companions will hear your voice with the Reflection softly
                  in the background.
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
  },
  parentVideoPane: {
    flex: 2,
    minHeight: 0,
  },
  parentVideoSurface: {
    flex: 1,
    minHeight: 0,
    backgroundColor: '#101820',
    overflow: 'hidden',
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
  cameraStageHost: {
    flex: 1,
    minHeight: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000',
  },
  cameraStage: {
    width: '100%',
    maxHeight: '100%',
    aspectRatio: 3 / 4,
    alignSelf: 'center',
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  cameraPreview: {
    ...StyleSheet.absoluteFillObject,
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
    paddingVertical: 10,
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
  },
  typedInput: {
    minHeight: 120,
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
    paddingVertical: 12,
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
    paddingVertical: 12,
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
  companionPreviewHint: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 12,
    textAlign: 'center',
    paddingHorizontal: 12,
    paddingTop: 10,
  },
  takeCompletePane: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 20,
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
    paddingVertical: 12,
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
    paddingVertical: 12,
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
  replayButton: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.4)',
  },
  replayText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
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
    paddingVertical: 8,
    marginTop: 6,
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
