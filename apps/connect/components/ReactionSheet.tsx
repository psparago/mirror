import { uploadReaction } from '@/utils/reactionUpload';
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
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const REACTION_PARENT_VOLUME = 0.15;
const PREVIEW_END_EPSILON_MS = 80;
const MIN_TRIM_GAP_MS = 500;
const TYPED_MESSAGE_MAX_LENGTH = 120;

type ReactionComposeMode = ReactionType;

function isSeekInterrupted(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Seeking interrupted');
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
  const [cameraAccessGranted, setCameraAccessGranted] = useState<boolean | null>(null);
  const [cameraStageReady, setCameraStageReady] = useState(false);

  const voiceRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const prepareSelfieCameraRunRef = useRef(0);

  const isVideoParent = parentMedia?.mediaType === 'video';
  const isImageParent = parentMedia?.mediaType === 'image';
  const parentVideoUrl = parentMedia?.mediaType === 'video' ? parentMedia.videoUrl : '';
  const parentImageUrl = parentMedia?.mediaType === 'image' ? parentMedia.imageUrl : '';
  const hasValidParentMedia =
    (isVideoParent && !!parentVideoUrl) || (isImageParent && !!parentImageUrl);
  const parentPosterUri = isVideoParent ? parentVideoUrl : parentImageUrl;

  const videoRef = useRef<Video>(null);
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

  const getReactionParentVolume = useCallback(
    () => (isParentReflectionMutedRef.current ? 0 : REACTION_PARENT_VOLUME),
    [],
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
    if (durationMillis <= 0) return;
    setTrimEndMs((prev) => {
      const next = prev <= 0 ? durationMillis : Math.min(prev, durationMillis);
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
      const micPermission = await requestRecordingPermissionsAsync();
      setMicReady(micPermission.granted);
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
    })();
  }, [visible]);

  const prepareSelfieCamera = useCallback(async () => {
    const runId = ++prepareSelfieCameraRunRef.current;

    let current = await Camera.getCameraPermissionsAsync();
    if (!current.granted && current.canAskAgain) {
      current = await Camera.requestCameraPermissionsAsync();
    }
    // Keep the hook in sync without blocking on its promise (can hang after native grant).
    void requestCameraPermission();

    if (runId !== prepareSelfieCameraRunRef.current) return;

    setCameraAccessGranted(current.granted);
    if (!current.granted) {
      setCameraStageReady(false);
      setCameraReady(false);
      return;
    }

    setCameraReady(false);
    if (Platform.OS === 'android') {
      setCameraStageReady(false);
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (runId !== prepareSelfieCameraRunRef.current) return;
      setCameraStageReady(true);
      setCameraInstanceKey((key) => key + 1);
      return;
    }

    setCameraStageReady(true);
    setCameraInstanceKey((key) => key + 1);
  }, [requestCameraPermission]);

  const handleGrantCameraAccess = useCallback(async () => {
    const current = await Camera.getCameraPermissionsAsync();
    if (current.granted) {
      await prepareSelfieCamera();
      return;
    }

    if (current.canAskAgain) {
      const requested = await Camera.requestCameraPermissionsAsync();
      void requestCameraPermission();
      if (requested.granted) {
        await prepareSelfieCamera();
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
  }, [prepareSelfieCamera, requestCameraPermission]);

  useEffect(() => {
    if (!visible || !hasValidParentMedia || reactionMode !== 'selfie') return;
    void prepareSelfieCamera();
  }, [visible, hasValidParentMedia, reactionMode, prepareSelfieCamera]);

  useEffect(() => {
    if (!visible || reactionMode !== 'selfie') return;
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        void prepareSelfieCamera();
      }
    });
    return () => subscription.remove();
  }, [visible, reactionMode, prepareSelfieCamera]);

  const handleModalShow = useCallback(() => {
    if (reactionMode === 'selfie') {
      void prepareSelfieCamera();
    }
  }, [prepareSelfieCamera, reactionMode]);

  useEffect(() => {
    if (visible) return;
    setIsRecording(false);
    setPositionMillis(0);
    setDurationMillis(0);
    setRecordedUri(null);
    setSyncStartTimeMillis(null);
    setSyncEndTimeMillis(null);
    setIsPreviewPlaying(false);
    setTrimStartMs(0);
    setTrimEndMs(0);
    trimStartMsRef.current = 0;
    trimEndMsRef.current = 0;
    setIsParentReflectionMuted(false);
    isParentReflectionMutedRef.current = false;
    setReactionMode('selfie');
    setTypedMessage('');
    setVoiceRecordedUri(null);
    setIsVoiceRecording(false);
    setCameraInstanceKey(0);
    setCameraAccessGranted(null);
    setCameraStageReady(false);
    prepareSelfieCameraRunRef.current += 1;
    isVideoDragActiveRef.current = false;
    previewStopPendingRef.current = false;
    pendingSeekTargetRef.current = null;
    seekChainRef.current = Promise.resolve();
    setCameraReady(false);
    setIsUploading(false);
    recordingPromiseRef.current = null;
    void videoRef.current?.pauseAsync().catch(() => {});
    void videoRef.current?.setVolumeAsync(1).catch(() => {});
    cameraRef.current?.stopRecording();
  }, [visible]);

  useEffect(() => {
    if (!recordedUri || syncStartTimeMillis == null || !isVideoParent) return;
    void (async () => {
      try {
        await videoRef.current?.setStatusAsync({
          positionMillis: syncStartTimeMillis,
          shouldPlay: true,
          volume: getReactionParentVolume(),
        });
        positionMillisRef.current = syncStartTimeMillis;
        setPositionMillis(syncStartTimeMillis);
      } catch (error) {
        console.warn('[ReactionSheet] failed to start preview loop:', error);
      }
    })();
  }, [getReactionParentVolume, isVideoParent, recordedUri, syncStartTimeMillis]);

  useEffect(() => {
    if (!isVideoParent || isRecording) return;
    void videoRef.current
      ?.setVolumeAsync(getReactionParentVolume())
      .catch((error) => {
        console.warn('[ReactionSheet] failed to update parent volume:', error);
      });
  }, [getReactionParentVolume, isParentReflectionMuted, isRecording, isVideoParent]);

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
            try {
              await videoRef.current?.setPositionAsync(nextTarget, SEEK_TOLERANCE);
            } catch (error) {
              if (!isSeekInterrupted(error)) {
                console.warn('[ReactionSheet] seek failed:', error);
              }
            }
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
      await queueVideoSeek(targetMs, { updateUi: true });
      if (options?.shouldPlay == null) return;
      const end = trimEndMsRef.current || durationMillisRef.current;
      const target = Math.max(0, Math.min(targetMs, end));
      try {
        await videoRef.current?.setStatusAsync({
          positionMillis: target,
          shouldPlay: options.shouldPlay,
          volume: options.volume ?? getReactionParentVolume(),
        });
      } catch (error) {
        if (!isSeekInterrupted(error)) {
          console.warn('[ReactionSheet] commit seek failed:', error);
        }
      }
    },
    [getReactionParentVolume, queueVideoSeek],
  );

  const stopPreviewAtTrimEnd = useCallback(async () => {
    if (!isVideoParent || previewStopPendingRef.current) return;
    previewStopPendingRef.current = true;
    const start = trimStartMsRef.current;
    positionMillisRef.current = start;
    setPositionMillis(start);
    setIsPreviewPlaying(false);
    try {
      await videoRef.current?.setStatusAsync({
        positionMillis: start,
        shouldPlay: false,
        volume: getReactionParentVolume(),
      });
    } catch (error) {
      if (!isSeekInterrupted(error)) {
        console.warn('[ReactionSheet] preview stop failed:', error);
      }
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
        if (!isScrubbingRef.current) {
          positionMillisRef.current = status.positionMillis;
          setPositionMillis(status.positionMillis);
        }

        if (
          syncStartTimeMillis != null &&
          syncEndTimeMillis != null &&
          status.positionMillis >= syncEndTimeMillis - PREVIEW_END_EPSILON_MS
        ) {
          void videoRef.current?.setStatusAsync({
            positionMillis: syncStartTimeMillis,
            shouldPlay: true,
            volume: getReactionParentVolume(),
          });
        }
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
        if (end > trimStartMsRef.current && status.positionMillis >= end - PREVIEW_END_EPSILON_MS) {
          void stopPreviewAtTrimEnd();
        }
        return;
      }

      if (!isScrubbingRef.current) {
        setIsPreviewPlaying(false);
      }
    },
    [
      getReactionParentVolume,
      isVideoParent,
      stopPreviewAtTrimEnd,
      recordedUri,
      syncEndTimeMillis,
      syncStartTimeMillis,
      isRecording,
    ],
  );

  const pauseParentPreview = useCallback(async () => {
    if (!isVideoParent) return;
    try {
      await videoRef.current?.pauseAsync();
      setIsPreviewPlaying(false);
    } catch (error) {
      console.warn('[ReactionSheet] pause preview failed:', error);
    }
  }, [isVideoParent]);

  const toggleParentPlayback = useCallback(async () => {
    if (!isVideoParent || isRecording || recordedUri) return;
    try {
      const status = await videoRef.current?.getStatusAsync();
      if (!status?.isLoaded) return;
      if (status.isPlaying) {
        await pauseParentPreview();
        const start = trimStartMsRef.current;
        positionMillisRef.current = start;
        setPositionMillis(start);
        await commitVideoPosition(start, {
          shouldPlay: false,
          volume: getReactionParentVolume(),
        });
        return;
      }

      const start = trimStartMsRef.current;
      positionMillisRef.current = start;
      setPositionMillis(start);
      await videoRef.current?.setStatusAsync({
        positionMillis: start,
        shouldPlay: true,
        volume: getReactionParentVolume(),
      });
      setIsPreviewPlaying(true);
    } catch (error) {
      console.warn('[ReactionSheet] toggle playback failed:', error);
    }
  }, [
    commitVideoPosition,
    getReactionParentVolume,
    isRecording,
    isVideoParent,
    pauseParentPreview,
    recordedUri,
  ]);

  const toggleParentReflectionMute = useCallback(() => {
    setIsParentReflectionMuted((prev) => !prev);
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
    })();
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
      void queueVideoSeek(start, { updateUi: false });
    },
    [beginVideoDragScrub, queueVideoSeek, setReactionStartMs],
  );

  const handleSeekDragEnd = useCallback(() => {
    void (async () => {
      const start = trimStartMsRef.current;
      await queueVideoSeek(start, { updateUi: false });
      isVideoDragActiveRef.current = false;
      isScrubbingRef.current = false;
    })();
  }, [queueVideoSeek]);

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
      !(cameraPermission?.granted || cameraAccessGranted) ||
      !micReady
    ) {
      if (!recordedUri) {
        console.warn('[ReactionSheet] camera not ready for recording', {
          parentReflectionId,
          cameraReady,
          cameraGranted: cameraPermission?.granted ?? cameraAccessGranted,
          micReady,
        });
      }
      return;
    }

    const syncStart = isVideoParent ? trimStartMsRef.current : 0;
    setSyncStartTimeMillis(syncStart);
    setIsRecording(true);
    setIsPreviewPlaying(false);

    const recordingPromise = cameraRef.current?.recordAsync();
    if (recordingPromise) {
      recordingPromiseRef.current = recordingPromise;
      void recordingPromise
        .then((result) => {
          if (result?.uri) {
            setRecordedUri(result.uri);
          }
        })
        .catch((error) => {
          console.warn('[ReactionSheet] recordAsync failed:', error);
        });
    }

    if (isVideoParent) {
      void (async () => {
        try {
          await videoRef.current?.setStatusAsync({
            positionMillis: syncStart,
            shouldPlay: true,
            volume: getReactionParentVolume(),
          });
        } catch (error) {
          console.warn('[ReactionSheet] reaction playback failed:', error);
        }
      })();
    }
  }, [
    cameraAccessGranted,
    cameraPermission?.granted,
    cameraReady,
    getReactionParentVolume,
    isVideoParent,
    micReady,
    parentReflectionId,
    recordedUri,
  ]);

  const handlePressOut = useCallback(() => {
    if (!isRecording) return;

    void (async () => {
      if (isVideoParent) {
        const status = await videoRef.current?.getStatusAsync();
        if (status?.isLoaded) {
          setSyncEndTimeMillis(status.positionMillis);
        }
        await videoRef.current?.pauseAsync().catch(() => {});
        await videoRef.current?.setVolumeAsync(getReactionParentVolume()).catch(() => {});
      } else {
        setSyncEndTimeMillis(0);
      }
      setIsRecording(false);
      cameraRef.current?.stopRecording();
    })();
  }, [getReactionParentVolume, isRecording, isVideoParent]);

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
      setCameraReady(false);
      setCameraStageReady(false);
      if (nextMode === 'selfie') {
        void prepareSelfieCamera();
      } else {
        setCameraAccessGranted(null);
      }
      void videoRef.current?.pauseAsync().catch(() => {});
    },
    [isUploading, prepareSelfieCamera, reactionMode, resetVoiceRecording],
  );

  const handleStartVoiceRecording = useCallback(async () => {
    if (!micReady || isVoiceRecording) return;
    try {
      await voiceRecorder.prepareToRecordAsync();
      voiceRecorder.record();
      setIsVoiceRecording(true);
    } catch (error) {
      console.warn('[ReactionSheet] voice record start failed:', error);
      Alert.alert('Recording Failed', 'Could not start voice recording.');
    }
  }, [isVoiceRecording, micReady, voiceRecorder]);

  const handleStopVoiceRecording = useCallback(async () => {
    if (!isVoiceRecording) return;
    try {
      await voiceRecorder.stop();
      setIsVoiceRecording(false);
      if (voiceRecorder.uri) {
        setVoiceRecordedUri(voiceRecorder.uri);
      }
    } catch (error) {
      console.warn('[ReactionSheet] voice record stop failed:', error);
      setIsVoiceRecording(false);
    }
  }, [isVoiceRecording, voiceRecorder]);

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
    setCameraReady(false);
    void prepareSelfieCamera();
    void (async () => {
      if (isVideoParent && restartAt != null) {
        await commitVideoPosition(restartAt, {
          shouldPlay: false,
          volume: getReactionParentVolume(),
        });
      }
      await videoRef.current?.pauseAsync().catch(() => {});
    })();
  }, [commitVideoPosition, getReactionParentVolume, isVideoParent, prepareSelfieCamera, reactionMode, resetVoiceRecording, syncStartTimeMillis]);

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

  const isCameraGranted =
    cameraPermission?.granted === true || cameraAccessGranted === true;
  const isCameraDenied =
    cameraAccessGranted === false && cameraPermission?.granted !== true;
  const showCameraPreview =
    isCameraGranted && (Platform.OS !== 'android' || cameraStageReady);

  const canRecordSelfie =
    reactionMode === 'selfie' &&
    !recordedUri &&
    cameraReady &&
    showCameraPreview &&
    micReady;
  const isSelfiePreviewMode = reactionMode === 'selfie' && recordedUri != null;
  const isVoicePreviewMode = reactionMode === 'voice' && voiceRecordedUri != null;
  const isPreviewMode = isSelfiePreviewMode || isVoicePreviewMode;
  const canSendTyped = reactionMode === 'typed' && typedMessage.trim().length > 0;
  const scrubDurationMs = Math.max(durationMillis, 1);
  const scrubEndMs = trimEndMs > 0 ? trimEndMs : scrubDurationMs;

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
        </View>

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
                        progressUpdateIntervalMillis={100}
                        onPlaybackStatusUpdate={handlePlaybackStatusUpdate}
                      />
                      {showScrubUi ? (
                        <View style={styles.dragHintOverlay} pointerEvents="none">
                          <Text style={styles.dragHintText}>Drag to set start</Text>
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
                          style={styles.parentAudioToggle}
                          onPress={toggleParentReflectionMute}
                          accessibilityRole="button"
                          accessibilityLabel={
                            isParentReflectionMuted
                              ? 'Unmute Reflection audio'
                              : 'Mute Reflection audio'
                          }
                        >
                          <FontAwesome
                            name={isParentReflectionMuted ? 'volume-off' : 'volume-down'}
                            size={14}
                            color="#fff"
                          />
                        </Pressable>
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
                  ) : isSelfiePreviewMode ? (
                    <Pressable
                      style={styles.playbackControl}
                      onPress={toggleParentReflectionMute}
                      accessibilityRole="button"
                      accessibilityLabel={
                        isParentReflectionMuted
                          ? 'Unmute Reflection audio'
                          : 'Mute Reflection audio'
                      }
                    >
                      <FontAwesome
                        name={isParentReflectionMuted ? 'volume-off' : 'volume-down'}
                        size={14}
                        color="#fff"
                      />
                      <Text style={styles.playbackControlText}>
                        {isParentReflectionMuted ? 'Reflection muted' : 'Reflection audio (15%)'}
                      </Text>
                    </Pressable>
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
              {isSelfiePreviewMode ? (
                <View style={styles.cameraStageHost}>
                  <View style={styles.cameraStage}>
                    <Video
                      source={{ uri: recordedUri! }}
                      style={styles.selfiePreviewVideo}
                      resizeMode={ResizeMode.COVER}
                      shouldPlay
                      isLooping
                    />
                  </View>
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
              ) : showCameraPreview ? (
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
                <View style={styles.altModePane}>
                  <ActivityIndicator color="#fff" size="large" />
                  <Text style={styles.altModeHint}>Starting camera…</Text>
                </View>
              )}
            </View>
          </View>
        </View>

        <View style={[styles.interactionFooter, { paddingBottom: insets.bottom }]}>
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

          {isPreviewMode ? (
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
        </View>
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
  parentAudioToggle: {
    width: 48,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.12)',
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: 'rgba(255,255,255,0.12)',
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
});
