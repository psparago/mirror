import { FontAwesome } from '@expo/vector-icons';
import BottomSheet, { BottomSheetScrollView, BottomSheetView } from '@gorhom/bottom-sheet';
import { Event } from '@projectmirror/shared';
import { Image } from 'expo-image';
import { Audio } from 'expo-av';
import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Keyboard,
  LayoutChangeEvent,
  Image as NativeImage,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  FadeIn,
  FadeOut,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ReflectionFilteredPhoto } from '@/hooks/ReflectionFilteredPhoto';
import { useReflectionFilters, type ReflectionFilterType } from '@/hooks/useReflectionFilters';
import { PHOTO_EXPORT_SIZE_PX } from '@/utils/mediaProcessor';
import { ReplayModal } from './ReplayModal';
import { VideoTrimSlider } from '@projectmirror/shared';

export type ComposerVideoMeta = {
  video_start_ms: number;
  video_end_ms: number;
  thumbnail_time_ms: number | null;
};

export type ComposerSendPayload = {
  caption: string;
  audioUri: string | null;
  deepDive: string | null;
  videoMeta?: ComposerVideoMeta | null;
  /** Final square photo export (original or Look-baked) to upload instead of the raw source photo. */
  filteredPhotoUri?: string | null;
};

export type ComposerStage = 'workbench' | 'ai' | 'send';

// --- TYPES ---
interface ReflectionComposerProps {
  mediaUri: string;
  mediaType: 'photo' | 'video';
  // State from Parent
  initialCaption?: string;
  audioUri?: string | null;
  aiArtifacts?: {
    caption?: string;
    deepDive?: string;
    audioUrl?: string;
    deepDiveAudioUrl?: string;
  };
  isAiThinking: boolean;
  // Actions
  onCancel: () => void;
  onReplaceMedia: () => void;
  onSend: (data: ComposerSendPayload) => void;
  /** Fired when Look filter extract completes or clears (toggle off / new media). */
  onFilteredUriChange?: (uri: string | null) => void;
  /** Hydrate trim / thumbnail when editing an existing video reflection. */
  initialVideoMeta?: Partial<ComposerVideoMeta> | null;
  /** Fired whenever trim range or thumbnail frame changes (for upload + thumbnails). */
  onVideoMetaChange?: (meta: ComposerVideoMeta) => void;
  onTriggerMagic: (targetCaption?: string) => Promise<void>;
  isSending: boolean;
  /** Shown on Replay preview header when editing an existing reflection (CreationModal). */
  onReplaceMediaFromPreview?: () => void;
  
  // Audio Recorder (passed from parent or hook)
  audioRecorder?: any; 
  onStartRecording?: () => void;
  onStopRecording?: () => void;
  // AI Hint controls (surfaced in Sparkle Hints sheet)
  companionInReflection?: boolean;
  onCompanionInReflectionChange?: (v: boolean) => void;
  explorerInReflection?: boolean;
  onExplorerInReflectionChange?: (v: boolean) => void;
  peopleContext?: string;
  onPeopleContextChange?: (v: string) => void;
  explorerName?: string;
  stage: ComposerStage;
  onStageChange: (next: ComposerStage) => void;
}

const MIN_PHOTO_SCALE = 0.35;
const MAX_PHOTO_SCALE = 4;
const SOFT_VIDEO_RECOMMENDED_SECONDS = 60;
const HARD_VIDEO_MAX_SECONDS = 5 * 60;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clampNumberWorklet(value: number, min: number, max: number): number {
  'worklet';
  return Math.min(Math.max(value, min), max);
}

function getContainedPhotoMetricsWorklet(
  sourceWidth: number,
  sourceHeight: number,
  stageSize: number,
  scale: number,
): { maxOffsetX: number; maxOffsetY: number } {
  'worklet';
  const safeWidth = Math.max(1, sourceWidth);
  const safeHeight = Math.max(1, sourceHeight);
  const safeStage = Math.max(1, stageSize);
  const aspect = safeWidth / safeHeight;
  const fittedWidth = aspect >= 1 ? safeStage : safeStage * aspect;
  const fittedHeight = aspect >= 1 ? safeStage / aspect : safeStage;
  return {
    maxOffsetX: Math.max(0, (fittedWidth * scale - safeStage) / 2),
    maxOffsetY: Math.max(0, (fittedHeight * scale - safeStage) / 2),
  };
}

export default function ReflectionComposer({
  mediaUri,
  mediaType,
  initialCaption = '',
  audioUri,
  aiArtifacts,
  isAiThinking,
  onCancel: onRetake,
  onReplaceMedia,
  onSend,
  onFilteredUriChange,
  onTriggerMagic,
  isSending,
  onReplaceMediaFromPreview,
  audioRecorder,
  onStartRecording,
  onStopRecording,
  initialVideoMeta,
  onVideoMetaChange,
  companionInReflection,
  onCompanionInReflectionChange,
  explorerInReflection,
  onExplorerInReflectionChange,
  peopleContext,
  onPeopleContextChange,
  explorerName,
  stage,
  onStageChange,
}: ReflectionComposerProps) {
  // --- STATE ---
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheet>(null);
  const infoSheetRef = useRef<BottomSheet>(null);
  const [caption, setCaption] = useState(initialCaption);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [videoEnded, setVideoEnded] = useState(false);
  const [videoRangeMs, setVideoRangeMs] = useState<{ start: number; end: number } | null>(null);
  const [thumbnailTimeMs, setThumbnailTimeMs] = useState<number | null>(null);
  const [isPosterMode, setIsPosterMode] = useState(false);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [sourceVideoDurationMs, setSourceVideoDurationMs] = useState(0);
  const lastSendAtRef = useRef(0);

  const {
    currentFilterType,
    setCurrentFilterType,
    isFilterActive,
    extractImageEnabled,
    lookExtractBusy,
    handleExtractImage,
    extractFilteredImage,
    lastFilteredExtractUriRef,
  } = useReflectionFilters({ mediaUri, mediaType, onFilteredUriChange });

  const noopExtractImage = useCallback(() => {}, []);
  const [photoSourceSize, setPhotoSourceSize] = useState<{ width: number; height: number } | null>(null);
  const [photoStageSize, setPhotoStageSize] = useState(0);
  const [photoEditRevision, setPhotoEditRevision] = useState(0);
  const [photoExportTransform, setPhotoExportTransform] = useState({ scale: 1, tx: 0, ty: 0, rotationDeg: 0 });
  const photoScale = useSharedValue(1);
  const photoTranslateX = useSharedValue(0);
  const photoTranslateY = useSharedValue(0);
  const photoRotation = useSharedValue(0);
  const photoScaleStart = useSharedValue(1);
  const photoPanStartX = useSharedValue(0);
  const photoPanStartY = useSharedValue(0);
  const photoRotationStart = useSharedValue(0);
  const photoGestureRevision = useSharedValue(0);
  
  // Preview State
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [previewEvent, setPreviewEvent] = useState<Event | null>(null);

  const [isAiCancelled, setIsAiCancelled] = useState(false);
  const isBlockedByAi = isAiThinking && !isAiCancelled;
  const hasRecordedAudio = !!audioUri;

  // Sparkle animation: rotating star + pulsing text
  const sparkleRotation = useSharedValue(0);
  const sparkleScale = useSharedValue(1);
  const textOpacity = useSharedValue(1);

  useEffect(() => {
    if (isBlockedByAi) {
      sparkleRotation.value = withRepeat(
        withTiming(360, { duration: 3000, easing: Easing.linear }),
        -1,
        false,
      );
      sparkleScale.value = withRepeat(
        withSequence(
          withTiming(1.2, { duration: 800, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.9, { duration: 800, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        true,
      );
      textOpacity.value = withRepeat(
        withSequence(
          withTiming(0.5, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
          withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        true,
      );
    } else {
      sparkleRotation.value = 0;
      sparkleScale.value = 1;
      textOpacity.value = 1;
    }
  }, [isBlockedByAi]);

  const sparkleIconStyle = useAnimatedStyle(() => ({
    transform: [
      { rotate: `${sparkleRotation.value}deg` },
      { scale: sparkleScale.value },
    ],
  }));

  const sparkleTextStyle = useAnimatedStyle(() => ({
    opacity: textOpacity.value,
  }));

  // Track last AI caption for display (no auto-regen)
  const lastAiCaptionRef = useRef<string | null>(null);

  // --- Stale-AI tracking ---
  // Snapshot of editor state when AI last completed. null = AI has never run.
  const aiSnapshotRef = useRef<{
    trimStart: number | null;
    trimEnd: number | null;
    thumbMs: number | null;
    caption: string;
    currentFilterType: ReflectionFilterType;
    photoEditRevision: number;
  } | null>(null);
  const prevAiThinkingRef = useRef(isAiThinking);

  useEffect(() => {
    const wasThinking = prevAiThinkingRef.current;
    prevAiThinkingRef.current = isAiThinking;
    if (wasThinking && !isAiThinking && !isAiCancelled) {
      aiSnapshotRef.current = {
        trimStart: videoRangeMs?.start ?? null,
        trimEnd: videoRangeMs?.end ?? null,
        thumbMs: thumbnailTimeMs,
        caption,
        currentFilterType,
        photoEditRevision,
      };
      if (wantsAutoPlayRef.current) {
        wantsAutoPlayRef.current = false;
        setTimeout(() => playAiPreview(), 400);
      }
    }
  }, [isAiThinking, isAiCancelled, videoRangeMs, thumbnailTimeMs, caption, currentFilterType, photoEditRevision, playAiPreview]);

  const isAiStale = useCallback((): boolean => {
    const snap = aiSnapshotRef.current;
    if (!snap) return false;
    if (caption.trim() !== snap.caption.trim()) return true;
    if (currentFilterType !== snap.currentFilterType) return true;
    if (photoEditRevision !== snap.photoEditRevision) return true;
    if ((videoRangeMs?.start ?? null) !== snap.trimStart) return true;
    if ((videoRangeMs?.end ?? null) !== snap.trimEnd) return true;
    if (thumbnailTimeMs !== snap.thumbMs) return true;
    return false;
  }, [caption, currentFilterType, photoEditRevision, videoRangeMs, thumbnailTimeMs]);

  const hasAnyAiArtifacts = useMemo(
    () =>
      !!(
        aiArtifacts?.caption ||
        aiArtifacts?.deepDive ||
        aiArtifacts?.audioUrl ||
        aiArtifacts?.deepDiveAudioUrl
      ),
    [aiArtifacts],
  );

  useEffect(() => {
    if (!hasAnyAiArtifacts) return;
    if (aiSnapshotRef.current) return;
    aiSnapshotRef.current = {
      trimStart: videoRangeMs?.start ?? null,
      trimEnd: videoRangeMs?.end ?? null,
      thumbMs: thumbnailTimeMs,
      caption,
      currentFilterType,
      photoEditRevision,
    };
  }, [
    hasAnyAiArtifacts,
    videoRangeMs,
    thumbnailTimeMs,
    caption,
    currentFilterType,
    photoEditRevision,
  ]);

  const ensureAiCurrent = useCallback(
    (purpose: 'preview' | 'send'): boolean => {
      const requiresInitialAiRun = !aiSnapshotRef.current && !hasAnyAiArtifacts;
      const requiresAiRerun = isAiStale();
      if (!requiresInitialAiRun && !requiresAiRerun) return true;

      const title = requiresInitialAiRun ? 'Run Sparkle first' : 'Re-run Sparkle';
      const message = requiresInitialAiRun
        ? 'Run Sparkle once before preview/send so AI is generated from your current reflection.'
        : `You've changed content that affects AI. Re-run Sparkle before ${purpose}.`;

      Alert.alert(title, message, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Run Sparkle', onPress: openSparkleSheet },
      ]);
      return false;
    },
    [hasAnyAiArtifacts, isAiStale, openSparkleSheet],
  );

  const { height: screenHeight, width: screenWidth } = useWindowDimensions();
  const workbenchCollapsedHeight = screenHeight * 0.16;
  const workbenchExpandedHeight = screenHeight * 0.26;
  const aiStageHeight = screenHeight * 0.62;
  const sendSheetHeight = 80;

  /** Utility bar block height used for media top offset. */
  const TOP_TOOLBAR_BLOCK_PX = 38;
  /** Photo Looks bar block height used for media top offset. */
  const PHOTO_LOOKS_STRIP_PX = 48;
  /** Visual breathing room between photo utility bar and Looks bar. */
  const PHOTO_BARS_GAP_PX = 8;

  const LOOK_OPTIONS: {
    id: ReflectionFilterType;
    label: string;
    icon: React.ComponentProps<typeof FontAwesome>['name'];
  }[] = [
    { id: 'original', label: 'Original', icon: 'image' },
    { id: 'clarity', label: 'Clarity', icon: 'bolt' },
    { id: 'classic', label: 'Classic', icon: 'adjust' },
    { id: 'warm', label: 'Warm', icon: 'fire' },
  ];

  const handlePhotoStageLayout = useCallback((e: LayoutChangeEvent) => {
    const side = Math.min(e.nativeEvent.layout.width, e.nativeEvent.layout.height);
    if (side > 0) {
      setPhotoStageSize(side);
    }
  }, []);

  const markPhotoEdited = useCallback(() => {
    setPhotoEditRevision((v) => v + 1);
  }, []);

  useAnimatedReaction(
    () => photoGestureRevision.value,
    (next, prev) => {
      if (next !== prev) {
        runOnJS(markPhotoEdited)();
      }
    },
    [markPhotoEdited],
  );

  useEffect(() => {
    if (mediaType !== 'photo') {
      setPhotoSourceSize(null);
      return;
    }
    let alive = true;
    NativeImage.getSize(
      mediaUri,
      (width, height) => {
        if (alive) {
          setPhotoSourceSize({ width, height });
        }
      },
      () => {
        if (alive) {
          setPhotoSourceSize({ width: PHOTO_EXPORT_SIZE_PX, height: PHOTO_EXPORT_SIZE_PX });
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [mediaType, mediaUri]);

  useEffect(() => {
    if (mediaType !== 'photo') return;
    photoScale.value = 1;
    photoTranslateX.value = 0;
    photoTranslateY.value = 0;
    photoRotation.value = 0;
    setPhotoExportTransform({ scale: 1, tx: 0, ty: 0, rotationDeg: 0 });
    setPhotoEditRevision(0);
  }, [mediaType, mediaUri, photoScale, photoTranslateX, photoTranslateY, photoRotation]);

  const syncPhotoExportTransform = useCallback(() => {
    const previewSide = photoStageSize > 0 ? photoStageSize : PHOTO_EXPORT_SIZE_PX;
    const ratio = PHOTO_EXPORT_SIZE_PX / previewSide;
    setPhotoExportTransform({
      scale: photoScale.value,
      tx: photoTranslateX.value * ratio,
      ty: photoTranslateY.value * ratio,
      rotationDeg: photoRotation.value,
    });
  }, [photoScale, photoStageSize, photoTranslateX, photoTranslateY, photoRotation]);

  const photoTransformStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: photoTranslateX.value },
      { translateY: photoTranslateY.value },
      { scale: photoScale.value },
      { rotate: `${photoRotation.value}deg` },
    ],
  }));

  const photoEditorGesture = useMemo(() => {
    if (mediaType !== 'photo' || !photoSourceSize || !photoStageSize) {
      return Gesture.Simultaneous(
        Gesture.Pan().enabled(false),
        Gesture.Pinch().enabled(false),
        Gesture.Rotation().enabled(false),
      );
    }

    const pinch = Gesture.Pinch()
      .onBegin(() => {
        photoScaleStart.value = photoScale.value;
      })
      .onUpdate((e) => {
        const nextScale = clampNumberWorklet(photoScaleStart.value * e.scale, MIN_PHOTO_SCALE, MAX_PHOTO_SCALE);
        const metrics = getContainedPhotoMetricsWorklet(
          photoSourceSize.width,
          photoSourceSize.height,
          photoStageSize,
          nextScale,
        );
        photoScale.value = nextScale;
        photoTranslateX.value = clampNumberWorklet(
          photoTranslateX.value,
          -metrics.maxOffsetX,
          metrics.maxOffsetX,
        );
        photoTranslateY.value = clampNumberWorklet(
          photoTranslateY.value,
          -metrics.maxOffsetY,
          metrics.maxOffsetY,
        );
      })
      .onEnd(() => {
        photoGestureRevision.value += 1;
      });

    const pan = Gesture.Pan()
      .onBegin(() => {
        photoPanStartX.value = photoTranslateX.value;
        photoPanStartY.value = photoTranslateY.value;
      })
      .onUpdate((e) => {
        const metrics = getContainedPhotoMetricsWorklet(
          photoSourceSize.width,
          photoSourceSize.height,
          photoStageSize,
          photoScale.value,
        );
        photoTranslateX.value = clampNumberWorklet(
          photoPanStartX.value + e.translationX,
          -metrics.maxOffsetX,
          metrics.maxOffsetX,
        );
        photoTranslateY.value = clampNumberWorklet(
          photoPanStartY.value + e.translationY,
          -metrics.maxOffsetY,
          metrics.maxOffsetY,
        );
      })
      .onEnd(() => {
        photoGestureRevision.value += 1;
      });

    const rotate = Gesture.Rotation()
      .onBegin(() => {
        photoRotationStart.value = photoRotation.value;
      })
      .onUpdate((e) => {
        const deltaDeg = (e.rotation * 180) / Math.PI;
        photoRotation.value = photoRotationStart.value + deltaDeg;
      })
      .onEnd(() => {
        photoGestureRevision.value += 1;
      });

    return Gesture.Simultaneous(pan, pinch, rotate);
  }, [
    mediaType,
    photoSourceSize,
    photoStageSize,
    photoScale,
    photoScaleStart,
    photoTranslateX,
    photoTranslateY,
    photoPanStartX,
    photoPanStartY,
    photoRotation,
    photoRotationStart,
    photoGestureRevision,
  ]);

  const rotatePhotoBy = useCallback((deltaDeg: number) => {
    photoRotation.value += deltaDeg;
    markPhotoEdited();
  }, [photoRotation, markPhotoEdited]);

  const resetPhotoTransform = useCallback(() => {
    photoScale.value = 1;
    photoTranslateX.value = 0;
    photoTranslateY.value = 0;
    photoRotation.value = 0;
    markPhotoEdited();
  }, [photoScale, photoTranslateX, photoTranslateY, photoRotation, markPhotoEdited]);

  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onRetake();
      return true;
    });
    return () => sub.remove();
  }, [onRetake]);

  // Sync AI Caption if user hasn't typed yet
  useEffect(() => {
    if (aiArtifacts?.caption && !caption) {
      setCaption(aiArtifacts.caption);
    }
    if (aiArtifacts?.caption) {
      lastAiCaptionRef.current = aiArtifacts.caption;
    }
  }, [aiArtifacts?.caption, caption]);

  // Track keyboard height
  useEffect(() => {
    const showSubscription = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (e) => {
        setKeyboardHeight(e.endCoordinates.height);
      }
    );
    const hideSubscription = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => {
        setKeyboardHeight(0);
      }
    );

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  // Calculate snap points dynamically based on screen height and keyboard
  const snapPoints = useMemo(() => {
    return [workbenchCollapsedHeight, workbenchExpandedHeight, sendSheetHeight];
  }, [workbenchCollapsedHeight, workbenchExpandedHeight, sendSheetHeight]);

  useEffect(() => {
    if (!sheetRef.current) return;

    const timeoutId = setTimeout(() => {
      if (stage === 'ai') {
        sheetRef.current?.close();
        return;
      }
      if (stage === 'send') {
        sheetRef.current?.snapToIndex(2);
        return;
      }
      sheetRef.current?.snapToIndex(0);
    }, 100);

    return () => clearTimeout(timeoutId);
  }, [stage, snapPoints]);

  const isRemoteMediaUri =
    typeof mediaUri === 'string' &&
    (mediaUri.startsWith('http://') || mediaUri.startsWith('https://'));

  // New asset: clear trim state so duration-based init is not mixed with a previous clip.
  useEffect(() => {
    if (mediaType !== 'video') return;
    setVideoRangeMs(null);
    setThumbnailTimeMs(null);
    setIsPosterMode(false);
  }, [mediaUri, mediaType]);

  // Video Player (expo-video supports remote https URIs; replace() keeps source in sync when URI changes)
  const player = useVideoPlayer(mediaUri, (p) => {
    p.loop = false;
    p.play();
  });
  const trimAppliedRef = useRef(false);

  useEffect(() => {
    if (mediaType !== 'video') return;
    player.loop = false;
  }, [player, mediaType, mediaUri]);

  useEffect(() => {
    if (mediaType !== 'video' || !player) return;
    try {
      player.replace(mediaUri);
      player.loop = false;
      player.play();
    } catch {
      // player may be tearing down
    }
  }, [mediaType, mediaUri, player]);

  useEffect(() => {
    const sub = player.addListener('playToEnd', () => {
      setVideoEnded(true);
    });
    return () => sub.remove();
  }, [player]);

  // Once duration is known: apply initial trim and seek. Uses a statusChange listener
  // because player.duration is not reactive — it's 0 until the player is ready.
  useEffect(() => {
    if (mediaType !== 'video' || !player) return;
    trimAppliedRef.current = false;

    const applyTrim = () => {
      if (trimAppliedRef.current) return;
      if (!(player.duration > 0)) return;
      trimAppliedRef.current = true;

      const durationMs = Math.round(player.duration * 1000);
      setSourceVideoDurationMs(durationMs);
      const s = initialVideoMeta?.video_start_ms;
      const e = initialVideoMeta?.video_end_ms;
      const hasInitialTrim =
        typeof s === 'number' &&
        typeof e === 'number' &&
        e > s &&
        s >= 0;

      if (typeof initialVideoMeta?.thumbnail_time_ms === 'number') {
        setThumbnailTimeMs(initialVideoMeta.thumbnail_time_ms);
      }

      if (hasInitialTrim) {
        const clampedEnd = Math.min(e, durationMs);
        const clampedStart = Math.max(0, Math.min(s, clampedEnd - 1));
        setVideoRangeMs({ start: clampedStart, end: Math.max(clampedStart + 1, clampedEnd) });
        try { player.currentTime = clampedStart / 1000; } catch { /* ignore */ }
      } else {
        setVideoRangeMs({ start: 0, end: durationMs });
      }
    };

    // Try immediately (duration may already be known)
    applyTrim();

    // Also listen for status changes so we catch the moment duration becomes available
    const sub = player.addListener('statusChange', () => {
      if (player.duration > 0) {
        setSourceVideoDurationMs(Math.round(player.duration * 1000));
      }
      applyTrim();
    });
    return () => sub.remove();
  }, [
    mediaType,
    mediaUri,
    player,
    initialVideoMeta?.video_start_ms,
    initialVideoMeta?.video_end_ms,
    initialVideoMeta?.thumbnail_time_ms,
  ]);

  useEffect(() => {
    if (!videoRangeMs || !onVideoMetaChange) return;
    onVideoMetaChange({
      video_start_ms: videoRangeMs.start,
      video_end_ms: videoRangeMs.end,
      thumbnail_time_ms: thumbnailTimeMs,
    });
  }, [videoRangeMs, thumbnailTimeMs, onVideoMetaChange]);

  useEffect(() => {
    if (!videoRangeMs || thumbnailTimeMs === null) return;
    if (thumbnailTimeMs < videoRangeMs.start || thumbnailTimeMs > videoRangeMs.end) {
      setThumbnailTimeMs(videoRangeMs.start);
    }
  }, [videoRangeMs, thumbnailTimeMs]);

  useEffect(() => {
    if (mediaType !== 'video' || !player || !videoRangeMs) return;
    player.timeUpdateEventInterval = 0.25;
    const sub = player.addListener('timeUpdate', () => {
      const curMs = player.currentTime * 1000;
      setPlayheadMs(curMs);
      if (curMs > videoRangeMs.end - 50) {
        player.currentTime = videoRangeMs.start / 1000;
      } else if (curMs < videoRangeMs.start - 50) {
        player.currentTime = videoRangeMs.start / 1000;
      }
    });
    return () => {
      try {
        player.timeUpdateEventInterval = 0;
      } catch {
        /* ignore */
      }
      sub.remove();
    };
  }, [mediaType, player, videoRangeMs]);

  // --- HANDLERS ---

  const buildSendPayload = useCallback(() => {
    const base = {
      caption,
      audioUri: audioUri || null,
      deepDive: aiArtifacts?.deepDive || null,
    };
    if (mediaType === 'video' && videoRangeMs && videoRangeMs.end > videoRangeMs.start) {
      return {
        ...base,
        videoMeta: {
          video_start_ms: videoRangeMs.start,
          video_end_ms: videoRangeMs.end,
          thumbnail_time_ms: thumbnailTimeMs,
        } as ComposerVideoMeta,
      };
    }
    return { ...base, videoMeta: null };
  }, [caption, audioUri, aiArtifacts?.deepDive, mediaType, videoRangeMs, thumbnailTimeMs]);

  const currentPlaybackWindowSeconds = useMemo(() => {
    if (mediaType !== 'video' || !videoRangeMs) return 0;
    return Math.round((videoRangeMs.end - videoRangeMs.start) / 1000);
  }, [mediaType, videoRangeMs]);

  const showSoftVideoWarning =
    mediaType === 'video' && currentPlaybackWindowSeconds > SOFT_VIDEO_RECOMMENDED_SECONDS;

  const exportCurrentPhoto = useCallback(async (): Promise<string | null> => {
    if (mediaType !== 'photo') return null;
    syncPhotoExportTransform();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    let uri = await extractFilteredImage();
    if (!uri) {
      uri = lastFilteredExtractUriRef.current;
    }
    return uri;
  }, [mediaType, syncPhotoExportTransform, extractFilteredImage, lastFilteredExtractUriRef]);

  const openSparkleSheet = useCallback(() => {
    setIsPosterMode(false);
    onStageChange('ai');
  }, [onStageChange]);

  const doSendNow = useCallback(async () => {
    const now = Date.now();
    if (now - lastSendAtRef.current < 800) return;
    lastSendAtRef.current = now;
    let filteredPhotoUri: string | null = null;
    if (mediaType === 'photo') {
      filteredPhotoUri = await exportCurrentPhoto();
    }
    onSend({ ...buildSendPayload(), filteredPhotoUri });
  }, [buildSendPayload, onSend, mediaType, exportCurrentPhoto]);

  const handleSendWithThrottle = useCallback(async () => {
    if (!ensureAiCurrent('send')) return;
    doSendNow();
  }, [ensureAiCurrent, doSendNow]);

  const handleSheetChange = useCallback((index: number) => {
    setSheetIndex(index);
    if (index < 2) {
      Keyboard.dismiss();
    }
  }, []);

  const doPreviewNow = useCallback(async () => {
    const previewId = 'preview-temp';
    const now = new Date();
    const previewImageUri =
      mediaType === 'photo' ? (await exportCurrentPhoto()) || mediaUri : mediaUri;

    const mockEvent: Event = {
      event_id: previewId,
      image_url: previewImageUri,
      video_url: mediaType === 'video' ? mediaUri : undefined,
      audio_url: audioUri || aiArtifacts?.audioUrl || undefined,
      metadata: {
        description: caption || "No description yet",
        short_caption: caption || "No caption",
        sender: 'You (Preview)',
        event_id: previewId,
        timestamp: now.toISOString(),
        content_type: mediaType === 'video' ? 'video' : (audioUri ? 'audio' : 'text'),
        image_source: 'camera',
        deep_dive: aiArtifacts?.deepDive,
      },
      deep_dive_audio_url: aiArtifacts?.deepDiveAudioUrl || undefined,
    };

    setPreviewEvent(mockEvent);
    setIsPreviewOpen(true);
  }, [mediaUri, mediaType, audioUri, aiArtifacts, caption, exportCurrentPhoto]);

  const handlePreview = useCallback(() => {
    if (!ensureAiCurrent('preview')) return;
    void doPreviewNow();
  }, [ensureAiCurrent, doPreviewNow]);

  const goToWorkbench = () => {
    onStageChange('workbench');
    Keyboard.dismiss();
  };
  const goToAi = () => {
    onStageChange('ai');
  };
  const goToSend = () => {
    onStageChange('send');
    Keyboard.dismiss();
  };

  // AI audio preview playback — caption → pause → deep dive
  type PreviewPhase = 'idle' | 'caption' | 'pause' | 'deep_dive';
  const [previewSound, setPreviewSound] = useState<Audio.Sound | null>(null);
  const [previewPhase, setPreviewPhase] = useState<PreviewPhase>('idle');
  const previewAbortRef = useRef(false);

  const isPlayingPreview = previewPhase !== 'idle';

  useEffect(() => {
    return () => { previewSound?.unloadAsync(); };
  }, [previewSound]);

  const ensureSpeakerMode = useCallback(async () => {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      shouldDuckAndroid: false,
      playThroughEarpieceAndroid: false,
    });
  }, []);

  const playOneClip = useCallback((uri: string): Promise<'finished' | 'stopped'> => {
    return new Promise(async (resolve) => {
      try {
        const { sound } = await Audio.Sound.createAsync(
          { uri },
          { shouldPlay: true, volume: 1.0 },
        );
        setPreviewSound(sound);
        sound.setOnPlaybackStatusUpdate((status) => {
          if (status.isLoaded && status.didJustFinish) {
            sound.unloadAsync();
            setPreviewSound(null);
            resolve('finished');
          }
        });
      } catch {
        resolve('stopped');
      }
    });
  }, []);

  const playAiPreview = useCallback(async () => {
    previewAbortRef.current = false;

    await ensureSpeakerMode();

    const captionUrl = audioUri || aiArtifacts?.audioUrl;
    const deepDiveUrl = aiArtifacts?.deepDiveAudioUrl;

    if (captionUrl) {
      setPreviewPhase('caption');
      const result = await playOneClip(captionUrl);
      if (result === 'stopped' || previewAbortRef.current) { setPreviewPhase('idle'); return; }
    }

    if (deepDiveUrl && !previewAbortRef.current) {
      setPreviewPhase('pause');
      await new Promise<void>((r) => setTimeout(r, 800));
      if (previewAbortRef.current) { setPreviewPhase('idle'); return; }

      setPreviewPhase('deep_dive');
      const result = await playOneClip(deepDiveUrl);
      if (result === 'stopped' || previewAbortRef.current) { setPreviewPhase('idle'); return; }
    }

    setPreviewPhase('idle');
  }, [audioUri, aiArtifacts?.audioUrl, aiArtifacts?.deepDiveAudioUrl, ensureSpeakerMode, playOneClip]);

  const stopAiPreview = useCallback(async () => {
    previewAbortRef.current = true;
    if (previewSound) {
      await previewSound.stopAsync();
      await previewSound.unloadAsync();
      setPreviewSound(null);
    }
    setPreviewPhase('idle');
  }, [previewSound]);

  const wantsAutoPlayRef = useRef(false);

  const handleRunSparkleAndPlay = useCallback(() => {
    wantsAutoPlayRef.current = true;
    setIsAiCancelled(false);
    onTriggerMagic(caption || undefined).catch(() => {
      wantsAutoPlayRef.current = false;
    });
  }, [onTriggerMagic, caption]);

  // --- RENDERERS ---

  const handleReplay = useCallback(() => {
    setVideoEnded(false);
    setIsPosterMode(false);
    if (mediaType === 'video' && videoRangeMs) {
      player.currentTime = videoRangeMs.start / 1000;
    } else {
      player.currentTime = 0;
    }
    player.play();
  }, [player, mediaType, videoRangeMs]);

  // --- POSTER MODE ---

  const enterPosterMode = useCallback(() => {
    player.pause();
    if (thumbnailTimeMs !== null) {
      try { player.currentTime = thumbnailTimeMs / 1000; } catch { /* ignore */ }
    }
    setIsPosterMode(true);
  }, [player, thumbnailTimeMs]);

  const FRAME_STEP_MS = 33;

  const handlePosterSet = useCallback(() => {
    const curMs = Math.round(player.currentTime * 1000);
    const rangeEnd = videoRangeMs?.end ?? Math.round(player.duration * 1000);

    if (thumbnailTimeMs !== null && Math.abs(curMs - thumbnailTimeMs) < FRAME_STEP_MS * 2) {
      const nextMs = Math.min(thumbnailTimeMs + FRAME_STEP_MS, rangeEnd);
      try { player.currentTime = nextMs / 1000; } catch { /* ignore */ }
      setThumbnailTimeMs(nextMs);
    } else {
      const ms = Math.max(0, curMs);
      setThumbnailTimeMs(ms);
    }
  }, [player, thumbnailTimeMs, videoRangeMs]);

  const handlePosterClear = useCallback(() => {
    setThumbnailTimeMs(null);
  }, []);

  const exitPosterMode = useCallback(() => {
    setIsPosterMode(false);
    player.play();
  }, [player]);

  const posterScrubOriginMs = useSharedValue(0);
  const videoDurationMs = useSharedValue(0);

  useEffect(() => {
    if (player.duration > 0) {
      videoDurationMs.value = player.duration * 1000;
    }
  }, [player.duration, videoDurationMs]);

  const seekToMs = useCallback((ms: number) => {
    try { player.currentTime = ms / 1000; } catch { /* ignore */ }
  }, [player]);

  const posterScrubGesture = useMemo(() =>
    Gesture.Pan()
      .enabled(isPosterMode)
      .onBegin(() => {
        posterScrubOriginMs.value = Math.round(player.currentTime * 1000);
      })
      .onUpdate((e) => {
        const rangeStart = videoRangeMs?.start ?? 0;
        const rangeEnd = videoRangeMs?.end ?? videoDurationMs.value;
        const rangeDuration = rangeEnd - rangeStart;
        if (rangeDuration <= 0) return;
        const pxToMs = rangeDuration / screenWidth;
        const deltaMs = e.translationX * pxToMs;
        const targetMs = Math.max(rangeStart, Math.min(rangeEnd, posterScrubOriginMs.value + deltaMs));
        runOnJS(seekToMs)(targetMs);
      }),
    [isPosterMode, videoRangeMs, screenWidth, seekToMs, posterScrubOriginMs, videoDurationMs],
  );

  /** Remote timeline edit: use Preview → Replace for media swap; keep top Edit for local / new captures. */
  const showTopMediaEdit = !isRemoteMediaUri || !onReplaceMediaFromPreview;
  const isWorkbenchStage = stage === 'workbench';

  /** Photo utility row always exists (Back/Close). */
  const photoEditBarPx = mediaType === 'photo' && isWorkbenchStage ? TOP_TOOLBAR_BLOCK_PX : 0;
  const photoWorkbenchSheetHeightPx =
    sheetIndex <= 0 ? workbenchCollapsedHeight : workbenchExpandedHeight;
  const photoWorkbenchBottomInsetPx =
    mediaType === 'photo' && isWorkbenchStage ? Math.ceil(photoWorkbenchSheetHeightPx + 8) : 0;

  const renderBackground = () => (
    <View
      style={[
        styles.backgroundContainer,
        {
          top:
            insets.top +
            (isWorkbenchStage ? (mediaType === 'photo' ? photoEditBarPx : TOP_TOOLBAR_BLOCK_PX) : 0) +
            (isWorkbenchStage && mediaType === 'photo' ? PHOTO_LOOKS_STRIP_PX + PHOTO_BARS_GAP_PX : 0),
          bottom: photoWorkbenchBottomInsetPx,
        },
      ]}
    >
      {mediaType === 'video' ? (
        <GestureDetector gesture={posterScrubGesture}>
          <View style={styles.media}>
            <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false} />
            {isPosterMode && (
              <View style={styles.posterModeIndicator} pointerEvents="none">
                <Text style={styles.posterModeText}>Swipe to scrub</Text>
              </View>
            )}
          </View>
        </GestureDetector>
      ) : (
        <View style={styles.photoRoot}>
          <View style={styles.photoStage} onLayout={handlePhotoStageLayout}>
            <GestureDetector gesture={photoEditorGesture}>
              <View style={styles.photoStageClip}>
                <Animated.View style={[styles.photoStageFill, photoTransformStyle]}>
                  {currentFilterType !== 'original' ? (
                    <ReflectionFilteredPhoto
                      mediaUri={mediaUri}
                      currentFilterType={currentFilterType}
                      extractImageEnabled={false}
                      onExtractImage={noopExtractImage}
                      style={styles.photoStageFill}
                      imageStyle={styles.photoStageFill}
                    />
                  ) : (
                    <Image
                      source={{ uri: mediaUri }}
                      style={styles.photoStageFill}
                      contentFit="contain"
                      cachePolicy={isRemoteMediaUri ? 'memory-disk' : 'disk'}
                      transition={isRemoteMediaUri ? 200 : 0}
                    />
                  )}
                </Animated.View>
                <View pointerEvents="none" style={styles.photoFrameOverlay}>
                  <Text style={styles.photoFrameLabel}>Explorer frame</Text>
                </View>
              </View>
            </GestureDetector>
          </View>
        </View>
      )}
      <LinearGradient
        pointerEvents="none"
        colors={['transparent', 'rgba(0,0,0,0.5)']}
        style={styles.gradientOverlay}
      />

      {/* REPLAY OVERLAY — shown when video finishes, below toolbar */}
      {mediaType === 'video' && videoEnded && (
        <View style={styles.replayOverlay}>
          <TouchableOpacity style={styles.replayButton} onPress={handleReplay} activeOpacity={0.8}>
            <FontAwesome name="repeat" size={28} color="#fff" />
            <Text style={styles.replayText}>Replay</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );

  const renderPosterToolbar = () => (
    <View style={[styles.topToolbar, { top: insets.top }]}>
      <View style={styles.topToolbarRow}>
        <TouchableOpacity
          style={[styles.toolbarChip, { backgroundColor: 'rgba(30, 80, 50, 0.9)', borderColor: 'rgba(74, 222, 128, 0.4)' }]}
          onPress={handlePosterSet}
          activeOpacity={0.7}
        >
          <FontAwesome name="check" size={16} color="#4ade80" />
          <Text style={[styles.toolbarChipText, { color: '#4ade80' }]}>Set</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.toolbarChip}
          onPress={handlePosterClear}
          activeOpacity={0.7}
        >
          <FontAwesome name="eraser" size={16} color="#fff" />
          <Text style={styles.toolbarChipText}>Clear</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toolbarChip, { backgroundColor: 'rgba(40, 70, 100, 0.9)', borderColor: 'rgba(79, 195, 247, 0.4)' }]}
          onPress={exitPosterMode}
          activeOpacity={0.7}
        >
          <FontAwesome name="check-circle" size={16} color="#4FC3F7" />
          <Text style={[styles.toolbarChipText, { color: '#4FC3F7' }]}>Done</Text>
        </TouchableOpacity>
      </View>
      {thumbnailTimeMs !== null && (
        <Text style={styles.posterTimestamp}>{(thumbnailTimeMs / 1000).toFixed(1)}s</Text>
      )}
    </View>
  );

  const renderTopControls = () => {
    if (stage === 'ai') return null;
    if (!isWorkbenchStage) {
      return (
        <View style={[styles.topToolbar, { top: insets.top }]}>
          <View style={styles.sendTopBar}>
            <TouchableOpacity
              style={styles.androidBackBtn}
              onPress={goToAi}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Back to AI"
            >
              <FontAwesome name="arrow-left" size={16} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.sendStageTitle}>Preview & Send</Text>
            <TouchableOpacity
              style={[styles.toolbarCloseBtn, isBlockedByAi && { opacity: 0.35 }]}
              onPress={onRetake}
              disabled={isSending || isBlockedByAi}
              activeOpacity={0.7}
            >
              <FontAwesome name="times" size={14} color="rgba(255,255,255,0.8)" />
            </TouchableOpacity>
          </View>
        </View>
      );
    }
    if (isPosterMode) return renderPosterToolbar();

    if (mediaType === 'photo') {
      return (
        <View style={[styles.topToolbar, { top: insets.top }]}>
          <View style={styles.photoUtilityRow}>
            <View style={styles.photoUtilityLeft}>
              <TouchableOpacity
                style={[styles.androidBackBtn, isBlockedByAi && { opacity: 0.35 }]}
                onPress={onReplaceMedia}
                disabled={isSending || isBlockedByAi}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Back to media picker"
              >
                <FontAwesome name="arrow-left" size={16} color="#fff" />
              </TouchableOpacity>
            </View>
            <TouchableOpacity
              style={[styles.toolbarCloseBtn, isBlockedByAi && { opacity: 0.35 }]}
              onPress={onRetake}
              disabled={isSending || isBlockedByAi}
              activeOpacity={0.7}
            >
              <FontAwesome name="times" size={14} color="rgba(255,255,255,0.8)" />
            </TouchableOpacity>
          </View>
        </View>
      );
    }

    return (
      <View style={[styles.topToolbar, { top: insets.top }]}>
        <View style={styles.topToolbarRow}>
          {showTopMediaEdit ? (
          <TouchableOpacity
            style={[styles.toolbarChip, isBlockedByAi && { opacity: 0.35 }]}
            onPress={onReplaceMedia}
            disabled={isSending || isBlockedByAi}
            activeOpacity={0.7}
          >
            <FontAwesome name="pencil" size={16} color="#fff" />
            <Text style={styles.toolbarChipText}>Edit</Text>
          </TouchableOpacity>
          ) : null}
          {mediaType === 'video' ? (
            <TouchableOpacity
              style={[styles.toolbarChip, isBlockedByAi && { opacity: 0.35 }]}
              onPress={handleReplay}
              disabled={isSending || isBlockedByAi}
              activeOpacity={0.7}
            >
              <FontAwesome name="repeat" size={16} color="#fff" />
              <Text style={styles.toolbarChipText}>Replay</Text>
            </TouchableOpacity>
          ) : null}
          {mediaType === 'video' ? (
            <TouchableOpacity
              style={[styles.toolbarChip, thumbnailTimeMs !== null && styles.toolbarChipActive, isBlockedByAi && { opacity: 0.35 }]}
              onPress={enterPosterMode}
              disabled={isSending || isBlockedByAi}
              activeOpacity={0.7}
            >
              <FontAwesome name="image" size={16} color={thumbnailTimeMs !== null ? '#4ade80' : '#fff'} />
              <Text style={[styles.toolbarChipText, thumbnailTimeMs !== null && { color: '#4ade80' }]}>Poster</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        <TouchableOpacity 
          style={[styles.toolbarCloseBtn, isBlockedByAi && { opacity: 0.35 }]} 
          onPress={onRetake} 
          disabled={isSending || isBlockedByAi}
          activeOpacity={0.7}
        >
          <FontAwesome name="times" size={14} color="rgba(255,255,255,0.8)" />
        </TouchableOpacity>
      </View>
    );
  };

  const renderWorkbenchTab = () => (
    <Animated.View entering={FadeIn} exiting={FadeOut} style={styles.tabContainer}>
      {showSoftVideoWarning ? (
        <View style={styles.videoGuidanceBanner}>
          <FontAwesome name="clock-o" size={14} color="#f5c842" />
          <Text style={styles.videoGuidanceText}>
            Best under 60s for the Explorer. Current playback window: {currentPlaybackWindowSeconds}s.
          </Text>
        </View>
      ) : null}
      <View style={styles.quickActionsRow}>
        <TouchableOpacity
          style={[styles.actionChip, styles.previewChip, (isSending || isAiThinking) && styles.chipDisabled]}
          onPress={goToAi}
          disabled={isSending || isAiThinking || lookExtractBusy}
        >
          <FontAwesome name="arrow-right" size={20} color="#fff" />
          <Text style={styles.actionChipText}>Next: AI & Caption</Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity
        style={styles.infoBtn}
        onPress={() => infoSheetRef.current?.snapToIndex(0)}
        activeOpacity={0.7}
      >
        <FontAwesome name="info-circle" size={15} color="#4a90d9" />
        <Text style={styles.infoBtnText}>How this works</Text>
      </TouchableOpacity>
    </Animated.View>
  );

  const hasAiAudio = !!(audioUri || aiArtifacts?.audioUrl);

  const renderAiTab = () => (
    <Animated.View entering={FadeIn} exiting={FadeOut} style={[styles.aiScreen, { paddingTop: insets.top + 8 }]}>
      <View style={styles.aiNavBar}>
        <TouchableOpacity onPress={goToWorkbench} style={styles.aiNavBackBtn} activeOpacity={0.7}>
          <FontAwesome name="arrow-left" size={16} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.aiNavTitle}>AI & Caption</Text>
        <TouchableOpacity onPress={goToSend} style={styles.aiNavNextBtn} activeOpacity={0.7}>
          <Text style={styles.aiNavNextText}>Next</Text>
          <FontAwesome name="arrow-right" size={12} color="#fff" />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.aiScreenScroll}
        contentContainerStyle={{ flexGrow: 1, paddingBottom: 8 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.aiSubtitleText}>
          No changes needed? Tap Next to keep your current draft as-is.
        </Text>

        {/* SECTION: Sparkle Hints */}
        <View style={[styles.aiCard, styles.aiCardProminent]}>
          <View style={styles.aiCardHeader}>
            <FontAwesome name="magic" size={15} color="#f5c842" />
            <Text style={[styles.aiCardTitle, styles.aiCardTitleProminent]}>Sparkle Hints</Text>
          </View>
          <Text style={styles.aiCardDesc}>
            Tell AI who and what is in this reflection.
          </Text>
          <View style={styles.aiTogglePair}>
            <TouchableOpacity
              style={styles.aiToggleRow}
              onPress={() => onCompanionInReflectionChange?.(!companionInReflection)}
              activeOpacity={0.7}
            >
              <FontAwesome
                name={companionInReflection ? 'check-square-o' : 'square-o'}
                size={16}
                color={companionInReflection ? '#4FC3F7' : 'rgba(255,255,255,0.45)'}
              />
              <Text style={[styles.aiToggleLabel, companionInReflection && styles.aiToggleLabelActive]}>
                I'm in this
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.aiToggleRow}
              onPress={() => onExplorerInReflectionChange?.(!explorerInReflection)}
              activeOpacity={0.7}
            >
              <FontAwesome
                name={explorerInReflection ? 'check-square-o' : 'square-o'}
                size={16}
                color={explorerInReflection ? '#4FC3F7' : 'rgba(255,255,255,0.45)'}
              />
              <Text style={[styles.aiToggleLabel, explorerInReflection && styles.aiToggleLabelActive]}>
                {explorerName || 'Explorer'} is in this
              </Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.aiHintLabel}>Context for AI</Text>
          <View style={styles.aiInputRow}>
            <FontAwesome name="users" size={13} color="rgba(255,255,255,0.35)" style={{ marginTop: 10 }} />
            <TextInput
              style={styles.aiHintInput}
              placeholder="Names, pets, places, what's happening..."
              placeholderTextColor="rgba(255,255,255,0.28)"
              value={peopleContext ?? ''}
              onChangeText={(t) => onPeopleContextChange?.(t)}
              returnKeyType="done"
              autoCorrect={false}
              autoCapitalize="words"
            />
          </View>
        </View>

        {/* SECTION: Voice Intro */}
        <View style={styles.aiCard}>
          <View style={styles.aiCardHeader}>
            <FontAwesome name="microphone" size={14} color="#2e78b7" />
            <Text style={styles.aiCardTitle}>Voice Intro (Optional)</Text>
          </View>
          <Text style={styles.aiCardDesc}>
            Record a short intro in your own voice.
          </Text>
          <View style={styles.aiVoiceCentered}>
            <TouchableOpacity
              style={[styles.aiRecordBtn, audioRecorder?.isRecording && styles.aiRecordBtnActive]}
              onPress={audioRecorder?.isRecording ? onStopRecording : onStartRecording}
              activeOpacity={0.7}
            >
              <FontAwesome
                name={audioRecorder?.isRecording ? 'stop' : 'microphone'}
                size={18}
                color="#fff"
              />
            </TouchableOpacity>
            {hasRecordedAudio && !audioRecorder?.isRecording ? (
              <View style={styles.aiVoiceDoneCol}>
                <View style={styles.aiVoiceBadgeRow}>
                  <FontAwesome name="check-circle" size={14} color="#27ae60" />
                  <Text style={styles.aiVoiceDoneText}>Recorded</Text>
                </View>
                <Text style={styles.aiVoiceHint}>Tap to overwrite</Text>
              </View>
            ) : (
              <Text style={styles.aiVoicePrompt}>
                {audioRecorder?.isRecording ? 'Recording...' : 'Tap to Record'}
              </Text>
            )}
          </View>
        </View>

        {/* SECTION: Caption */}
        <View style={[styles.aiCard, { flex: 1 }]}>
          <View style={styles.aiCardHeader}>
            <FontAwesome name="pencil" size={14} color="#8e44ad" />
            <Text style={styles.aiCardTitle}>Caption (Optional)</Text>
          </View>
          <TextInput
            style={styles.aiCaptionInput}
            placeholder="Edit the AI caption or write your own..."
            placeholderTextColor="rgba(255,255,255,0.28)"
            value={caption}
            onChangeText={setCaption}
            multiline
            textAlignVertical="top"
          />
        </View>
      </ScrollView>

      {/* FOOTER: Run Sparkle + Play + How this works */}
      <View style={[styles.aiFooter, { paddingBottom: Math.max(insets.bottom + 8, 20) }]}>
        <View style={styles.aiFooterBtnRow}>
          <TouchableOpacity
            style={[styles.aiSparkleBtn, isAiThinking && { opacity: 0.6 }]}
            onPress={handleRunSparkleAndPlay}
            disabled={isAiThinking}
            activeOpacity={0.8}
          >
            <FontAwesome name="magic" size={14} color="#fff" />
            <Text style={styles.aiSparkleBtnText}>
              {isAiThinking ? 'Running...' : 'Run Sparkle'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.aiPlayBtn, !hasAiAudio && { opacity: 0.3 }]}
            onPress={isPlayingPreview ? stopAiPreview : playAiPreview}
            disabled={!hasAiAudio || isAiThinking}
            activeOpacity={0.7}
          >
            <FontAwesome
              name={isPlayingPreview ? 'stop' : 'play'}
              size={13}
              color="#fff"
            />
            {isPlayingPreview ? (
              <Text style={styles.aiPlayBtnLabel}>
                {previewPhase === 'caption' ? 'Caption' : previewPhase === 'deep_dive' ? 'Deep Dive' : '...'}
              </Text>
            ) : null}
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          style={styles.aiInfoLink}
          onPress={() => infoSheetRef.current?.snapToIndex(0)}
          activeOpacity={0.7}
        >
          <FontAwesome name="info-circle" size={13} color="#4a90d9" />
          <Text style={styles.aiInfoLinkText}>How this works</Text>
        </TouchableOpacity>
      </View>
    </Animated.View>
  );

  const renderSendTab = () => (
    <Animated.View entering={FadeIn} exiting={FadeOut} style={styles.sendTabContainer}>
      {!isBlockedByAi && (
        <View style={styles.sendBtnRow}>
          <TouchableOpacity
            style={[styles.sendSlimBtn, styles.previewSlimBtn, (isSending || isAiThinking) && { opacity: 0.4 }]}
            onPress={handlePreview}
            disabled={isSending || isAiThinking || lookExtractBusy}
            activeOpacity={0.7}
          >
            <FontAwesome name="eye" size={15} color="#fff" />
            <Text style={styles.sendSlimBtnText}>Preview</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.sendSlimBtn,
              styles.sendSlimBtnPrimary,
              (isSending || (!caption && !hasRecordedAudio)) && { opacity: 0.4 },
            ]}
            onPress={handleSendWithThrottle}
            disabled={isSending || lookExtractBusy || (!caption && !hasRecordedAudio)}
            activeOpacity={0.7}
          >
            {isSending || lookExtractBusy ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <FontAwesome name="paper-plane" size={15} color="#fff" />
                <Text style={styles.sendSlimBtnText}>Send</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}
    </Animated.View>
  );

  return (
    <GestureHandlerRootView style={styles.container}>
      {Platform.OS === 'android' ? (
        <StatusBar style="light" translucent backgroundColor="transparent" />
      ) : null}
      {/* 1. IMMERSIVE MEDIA (below status bar) */}
      {renderBackground()}

      {/* 1b. TOP CONTROLS (over media, below status bar) */}
      {renderTopControls()}

      {/* 1c. AI STAGE FULL SCREEN */}
      {stage === 'ai' ? renderAiTab() : null}

      {mediaType === 'photo' ? (
        <View style={styles.photoExportHidden} pointerEvents="none">
          <View style={styles.photoExportStage}>
            <ReflectionFilteredPhoto
              mediaUri={mediaUri}
              currentFilterType={currentFilterType}
              extractImageEnabled={extractImageEnabled}
              onExtractImage={handleExtractImage}
              style={[
                styles.photoExportFill,
                {
                  transform: [
                    { translateX: photoExportTransform.tx },
                    { translateY: photoExportTransform.ty },
                    { scale: photoExportTransform.scale },
                    { rotate: `${photoExportTransform.rotationDeg}deg` },
                  ],
                },
              ]}
              imageStyle={styles.photoExportFill}
            />
          </View>
        </View>
      ) : null}

      {/* 2. AI SPARKLE OVERLAY — rendered outside the bottom sheet */}
      {isBlockedByAi && (
        <Animated.View entering={FadeIn.duration(300)} style={styles.sparkleOverlay}>
          <View style={styles.sparkleCard}>
            <Animated.View style={sparkleIconStyle}>
              <FontAwesome name="magic" size={36} color="#f39c12" />
            </Animated.View>
            <Animated.Text style={[styles.aiOverlayText, sparkleTextStyle]}>
              Adding sparkle to your Reflection!
            </Animated.Text>
            <TouchableOpacity
              style={styles.cancelAiButton}
              onPress={() => setIsAiCancelled(true)}
            >
              <Text style={styles.cancelAiText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>
      )}

      {/* 2b. INLINE VIDEO TRIMMER */}
      {isWorkbenchStage && mediaType === 'video' && videoRangeMs && player.duration > 0 && (
        <View style={styles.trimSliderOverlay}>
          <VideoTrimSlider
            durationMs={Math.round(player.duration * 1000)}
            startMs={videoRangeMs.start}
            endMs={videoRangeMs.end}
            currentTimeMs={playheadMs}
            onChange={(s, e) => setVideoRangeMs({ start: s, end: e })}
            onSeek={(ms) => { try { player.currentTime = ms / 1000; } catch { /* ignore */ } }}
          />
        </View>
      )}

      {isWorkbenchStage && mediaType === 'photo' && (
        <View
          style={[
            styles.looksBarWrap,
            { top: insets.top + photoEditBarPx + PHOTO_BARS_GAP_PX, height: PHOTO_LOOKS_STRIP_PX },
          ]}
          pointerEvents="box-none"
        >
          <View style={styles.looksToolbar}>
            <View style={styles.photoLooksRow}>
              {LOOK_OPTIONS.map((opt) => {
                const selected = currentFilterType === opt.id;
                return (
                  <TouchableOpacity
                    key={opt.id}
                    style={[
                      styles.toolbarChip,
                      styles.photoLookChip,
                      selected && styles.toolbarChipActive,
                      (isBlockedByAi || lookExtractBusy) && { opacity: 0.35 },
                    ]}
                    onPress={() => {
                      if (isBlockedByAi || lookExtractBusy) return;
                      setCurrentFilterType(opt.id);
                    }}
                    disabled={isSending || isBlockedByAi || lookExtractBusy}
                    activeOpacity={0.7}
                  >
                    <FontAwesome
                      name={opt.icon}
                      size={16}
                      color={selected ? '#4FC3F7' : '#fff'}
                    />
                    <Text style={[styles.toolbarChipText, selected && { color: '#4FC3F7' }]}>{opt.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <TouchableOpacity
              style={[styles.toolbarChip, (isBlockedByAi || lookExtractBusy) && { opacity: 0.35 }]}
              onPress={() => rotatePhotoBy(-90)}
              disabled={isSending || isBlockedByAi || lookExtractBusy}
              activeOpacity={0.7}
            >
              <FontAwesome name="undo" size={16} color="#fff" />
              <Text style={styles.toolbarChipText}>Rotate</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.toolbarChip, (isBlockedByAi || lookExtractBusy) && { opacity: 0.35 }]}
              onPress={resetPhotoTransform}
              disabled={isSending || isBlockedByAi || lookExtractBusy}
              activeOpacity={0.7}
            >
              <FontAwesome name="refresh" size={16} color="#fff" />
              <Text style={styles.toolbarChipText}>Reset</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* 3. BOTTOM SHEET TOOLKIT */}
      {stage !== 'ai' ? (
        <BottomSheet
          ref={sheetRef}
          index={0}
          snapPoints={snapPoints}
          onChange={handleSheetChange}
          backgroundStyle={styles.sheetBackground}
          handleIndicatorStyle={styles.sheetHandle}
          keyboardBehavior="interactive"
          android_keyboardInputMode="adjustResize"
          enablePanDownToClose={false}
          enableOverDrag={false}
        >
          <BottomSheetView style={[styles.sheetContent, { paddingBottom: Math.max(insets.bottom, 8) }]}>
            {stage === 'workbench' && renderWorkbenchTab()}
            {stage === 'send' && renderSendTab()}
          </BottomSheetView>
        </BottomSheet>
      ) : null}

      {/* 5. EDITOR GUIDE SHEET */}
      <BottomSheet
        ref={infoSheetRef}
        index={-1}
        snapPoints={['70%']}
        enablePanDownToClose
        backgroundStyle={styles.infoSheetBg}
        handleIndicatorStyle={styles.sheetHandle}
      >
        <BottomSheetScrollView contentContainerStyle={styles.infoSheetScroll}>
          <Text style={styles.infoTitle}>Your Creative Workbench</Text>
          <Text style={styles.infoSubtitle}>
            {mediaType === 'video'
              ? 'This flow always runs in three stages: Workbench, AI/Hints, then Preview/Send. In Workbench, use Edit/Replay/Poster and trim to shape the video. In AI/Hints, add people hints, record voice, and type the caption. In Preview/Send, check it and send. Videos can be longer now, but Reflections work best under 60 seconds and 5 minutes is the hard cap.'
              : 'This flow always runs in three stages: Workbench, AI/Hints, then Preview/Send. In Workbench, use Back to pick a different photo if needed, then drag and pinch in the square and choose Looks. In AI/Hints, add people hints, record voice, and type the caption. In Preview/Send, check it and send.'}
          </Text>

          {mediaType === 'video' ? (
            <>
              <View style={styles.infoRow}>
                <View style={styles.infoIconWrap}>
                  <FontAwesome name="scissors" size={14} color="#4FC3F7" />
                </View>
                <View style={styles.infoTextWrap}>
                  <Text style={styles.infoLabel}>Trim</Text>
                  <Text style={styles.infoDesc}>
                    The strip sits over the bottom of the video so you can pick the exact playback window the Explorer will experience — for example a 15 second highlight — without uploading a new file; start and end times are saved as metadata only. Reflections work best under 60 seconds, but you can bring in a longer source video as long as it stays under 5 minutes total. You get a light tap when a handle hits the start, end, or minimum length. Hold a handle to zoom: the bar temporarily maps to about four seconds centered on that handle so you can nudge the edge with precision.
                  </Text>
                </View>
              </View>

              <View style={styles.infoRow}>
                <View style={styles.infoIconWrap}>
                  <FontAwesome name="image" size={14} color="#4ade80" />
                </View>
                <View style={styles.infoTextWrap}>
                  <Text style={styles.infoLabel}>Poster</Text>
                  <Text style={styles.infoDesc}>
                    Tap Poster to enter poster mode: the video pauses, the top bar switches to Set, Clear, and Done. Swipe on the video to scrub, tap Set to lock the frame AI will use (and the poster the Explorer sees first). Tap Set again to advance frame-by-frame. Clear drops back to the trim start frame. Done exits and resumes playback. If you trim so the poster time falls outside the new range, it snaps to the trim start automatically.
                  </Text>
                </View>
              </View>
            </>
          ) : (
            <View style={styles.infoRow}>
              <View style={styles.infoIconWrap}>
                <FontAwesome name="adjust" size={14} color="#f39c12" />
              </View>
              <View style={styles.infoTextWrap}>
                <Text style={styles.infoLabel}>Looks</Text>
                <Text style={styles.infoDesc}>
                  First, frame the photo inside the square by dragging and pinching, and rotate with a two-finger twist or the Rotate chip. Reset returns to the original framing. Then choose Original, Clarity, Classic, or Warm from the Looks bar above your photo. That same square composition is what gets baked and uploaded for the Explorer. Clarity bumps contrast and saturation; Classic is black and white; Warm leans golden.
                </Text>
              </View>
            </View>
          )}

          <View style={styles.infoRow}>
            <View style={styles.infoIconWrap}>
              <FontAwesome name="microphone" size={14} color="#2e78b7" />
            </View>
            <View style={styles.infoTextWrap}>
              <Text style={styles.infoLabel}>Voice Intro</Text>
              <Text style={styles.infoDesc}>
                Optional. Record a short intro in your own voice on the AI & Caption screen. If you record one, this is what the Explorer hears before the content plays — your real voice takes priority over any AI-generated audio. If you skip it, Sparkle creates an AI voice from your caption instead. Either way, something always plays before the content.
              </Text>
            </View>
          </View>

          <View style={styles.infoRow}>
            <View style={styles.infoIconWrap}>
              <FontAwesome name="pencil" size={14} color="#8e44ad" />
            </View>
            <View style={styles.infoTextWrap}>
              <Text style={styles.infoLabel}>Caption</Text>
              <Text style={styles.infoDesc}>
                Sparkle writes a caption automatically based on your hints and media. You can edit it or replace it entirely on the AI & Caption screen. If you did not record a voice intro, this caption text is spoken aloud to the Explorer in an AI voice before the content plays. The caption is also saved as metadata on the reflection.
              </Text>
            </View>
          </View>

          <View style={styles.infoRow}>
            <View style={styles.infoIconWrap}>
              <FontAwesome name="magic" size={14} color="#f5c842" />
            </View>
            <View style={styles.infoTextWrap}>
              <Text style={styles.infoLabel}>Sparkle & Play</Text>
              <Text style={styles.infoDesc}>
                {mediaType === 'video'
                  ? 'On the AI & Caption screen, mark who is in the clip, add names and context, then tap Run Sparkle. AI uses your hints and media to draft a caption and generate an AI voice intro. After Sparkle finishes it auto-plays what was generated — caption audio first, then the deep dive. If you already have a Sparkle result and just want to hear it again, tap the Play button without re-running. If you recorded your own voice, that always takes priority — the AI voice is the fallback when you skip recording. Run Sparkle as many times as you want.'
                  : 'On the AI & Caption screen, mark who is in the photo, add names and context, then tap Run Sparkle. AI uses your hints and media to draft a caption and generate an AI voice intro. After Sparkle finishes it auto-plays what was generated — caption audio first, then the deep dive. If you already have a Sparkle result and just want to hear it again, tap the Play button without re-running. If you recorded your own voice, that always takes priority — the AI voice is the fallback when you skip recording. Run Sparkle as many times as you want.'}
              </Text>
            </View>
          </View>

          <View style={styles.infoDivider} />

          <Text style={styles.infoProTipHeader}>A few things worth knowing</Text>
          <Text style={styles.infoProTip}>
            Use Back and Next to move between stages as many times as needed. Nothing sends until you tap Send.
          </Text>
          <Text style={styles.infoProTip}>
            If you change trim, poster, caption, or a photo Look after Sparkle, you may be prompted to run Sparkle again before preview or send so AI stays in sync with what you changed.
          </Text>
          <Text style={styles.infoProTip}>
            {mediaType === 'video'
              ? 'The Explorer sees your poster frame first, then hears your voice or AI intro, then the video plays. Think of it as setting a stage.'
              : 'The Explorer sees your photo with the Look you chose, then hears your voice or AI intro. Order and pacing stay calm — no auto-advancing feed.'}
          </Text>
          <Text style={styles.infoProTip}>
            {mediaType === 'video'
              ? 'On Android, the system back key backs out of this flow (same idea as the X in the top bar) so you are less likely to leave the app by accident while editing.'
              : 'On Android, the system back key backs out of this flow (same idea as Close on the right end of the bar above your photo) so you are less likely to leave the app by accident while editing.'}
          </Text>
        </BottomSheetScrollView>
      </BottomSheet>

      {/* REPLAY PREVIEW MODAL */}
      <ReplayModal
        visible={isPreviewOpen}
        event={previewEvent}
        onClose={() => {
          setIsPreviewOpen(false);
          setPreviewEvent(null);
        }}
        onReplaceMedia={onReplaceMediaFromPreview}
        preferRecordedAudioOnly
        onSend={() => {
          handleSendWithThrottle();
          setIsPreviewOpen(false);
          setPreviewEvent(null);
        }}
        isSending={isSending}
        isSendDisabled={isBlockedByAi || lookExtractBusy || (!caption && !hasRecordedAudio)}
      />

    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  backgroundContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 0,
  },
  media: {
    width: '100%',
    height: '100%',
  },
  /** Centers the square stage in the media area (matches exported 1080×1080 letterboxing). */
  photoRoot: {
    flex: 1,
    width: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  photoStage: {
    width: '100%',
    aspectRatio: 1,
    maxWidth: '100%',
    maxHeight: '100%',
    alignSelf: 'center',
  },
  photoStageClip: {
    flex: 1,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  photoFrameOverlay: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 2,
    borderColor: 'rgba(79,195,247,0.65)',
  },
  photoFrameLabel: {
    position: 'absolute',
    top: 8,
    left: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: 'rgba(10,15,22,0.72)',
    color: 'rgba(189,227,252,0.95)',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  photoStageFill: {
    width: '100%',
    height: '100%',
  },
  photoExportHidden: {
    position: 'absolute',
    left: -2000,
    top: -2000,
    opacity: 0,
  },
  photoExportStage: {
    width: PHOTO_EXPORT_SIZE_PX,
    height: PHOTO_EXPORT_SIZE_PX,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  photoExportFill: {
    width: PHOTO_EXPORT_SIZE_PX,
    height: PHOTO_EXPORT_SIZE_PX,
    backgroundColor: '#000',
  },
  videoGuidanceBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(63, 48, 18, 0.9)',
    borderWidth: 1,
    borderColor: 'rgba(245,200,66,0.28)',
  },
  videoGuidanceText: {
    flex: 1,
    color: 'rgba(255,255,255,0.86)',
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '600',
  },
  gradientOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 350,
    zIndex: 1,
  },
  trimSliderOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: '19%',
    zIndex: 25,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 12,
    marginHorizontal: 8,
  },
  looksBarWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 26,
  },
  looksToolbar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: 'rgba(7,10,14,0.36)',
  },
  photoLooksRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 4,
    minWidth: 0,
  },
  photoLookChip: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 6,
  },
  photoUtilityRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginRight: 0,
  },
  photoUtilityLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  androidBackBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(30, 30, 30, 0.88)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  topToolbar: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingTop: 4,
    paddingBottom: 4,
    zIndex: 30,
  },
  topToolbarRow: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    gap: 6,
    marginRight: 12,
  },
  toolbarChip: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(30, 30, 30, 0.85)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
  },
  toolbarChipActive: {
    backgroundColor: 'rgba(40, 70, 100, 0.9)',
    borderWidth: 1,
    borderColor: 'rgba(79, 195, 247, 0.4)',
  },
  toolbarSparkleChip: {
    backgroundColor: 'rgba(50, 40, 20, 0.9)',
    borderWidth: 1,
    borderColor: 'rgba(245, 200, 66, 0.3)',
  },
  toolbarChipText: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  toolbarCloseBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(60, 60, 60, 0.85)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  posterTimestamp: {
    color: '#4ade80',
    fontSize: 11,
    fontWeight: '700',
    marginLeft: 4,
  },
  posterModeIndicator: {
    position: 'absolute',
    bottom: 12,
    alignSelf: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 8,
  },
  posterModeText: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 12,
    fontWeight: '500',
  },
  previewButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(46, 120, 183, 0.8)', // Branded blue
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    gap: 6,
  },
  cancelText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
  // Sheet
  sheetBackground: {
    backgroundColor: '#1a1a1a', // Dark background
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
    elevation: 5,
  },
  sheetHandle: {
    backgroundColor: '#666', // Lighter gray for dark background
    width: 40,
  },
  sheetContent: {
    flex: 1,
    paddingHorizontal: 20,
  },
  aiScreen: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 35,
    backgroundColor: '#0d1117',
  },
  aiNavBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  aiNavBackBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  aiNavTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#f2f6fb',
    letterSpacing: 0.3,
  },
  aiNavNextBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#2e78b7',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 18,
  },
  aiNavNextText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  aiSubtitleText: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 10,
    paddingHorizontal: 32,
  },
  aiScreenScroll: {
    flex: 1,
  },
  aiCard: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 12,
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  aiCardProminent: {
    borderColor: '#f5c842',
    borderWidth: 1,
    backgroundColor: 'rgba(245, 200, 66, 0.06)',
  },
  aiCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginBottom: 3,
  },
  aiCardTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#e8ecf2',
  },
  aiCardTitleProminent: {
    fontSize: 15,
    color: '#f5d670',
  },
  aiCardDesc: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.45)',
    lineHeight: 16,
    marginBottom: 8,
  },
  aiTogglePair: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 20,
    marginBottom: 4,
  },
  aiToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
  },
  aiToggleLabel: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
  },
  aiToggleLabelActive: {
    color: '#4FC3F7',
  },
  aiHintLabel: {
    color: '#f5d670',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 6,
    marginBottom: 2,
  },
  aiInputRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  aiHintInput: {
    flex: 1,
    color: '#fff',
    fontSize: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.15)',
    paddingVertical: 8,
    marginBottom: 4,
  },
  aiSparkleBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: '#f39c12',
    paddingVertical: 9,
    borderRadius: 9,
  },
  aiSparkleBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  aiVoiceCentered: {
    alignItems: 'center',
    gap: 6,
  },
  aiVoiceDoneCol: {
    alignItems: 'center',
    gap: 1,
  },
  aiRecordBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#e74c3c',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#e74c3c',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  aiRecordBtnActive: {
    backgroundColor: '#c0392b',
    transform: [{ scale: 1.08 }],
  },
  aiVoiceBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  aiVoiceDoneText: {
    color: '#27ae60',
    fontSize: 13,
    fontWeight: '600',
  },
  aiVoiceHint: {
    color: 'rgba(255,255,255,0.35)',
    fontSize: 11,
  },
  aiVoicePrompt: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 14,
    fontWeight: '500',
  },
  aiCaptionInput: {
    flex: 1,
    color: '#fff',
    fontSize: 15,
    lineHeight: 20,
    minHeight: 80,
    textAlignVertical: 'top',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 8,
    padding: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  aiFooter: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.1)',
    paddingTop: 10,
    paddingHorizontal: 16,
  },
  aiFooterBtnRow: {
    flexDirection: 'row',
    gap: 10,
  },
  aiPlayBtn: {
    minWidth: 44,
    height: 38,
    borderRadius: 9,
    backgroundColor: '#2e78b7',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    gap: 6,
  },
  aiPlayBtnLabel: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
  aiInfoLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingTop: 8,
    paddingBottom: 2,
  },
  aiInfoLinkText: {
    color: '#4a90d9',
    fontSize: 13,
    fontWeight: '500',
  },
  tabContainer: {
    flex: 1,
    paddingTop: 10,
  },
  sendTabContainer: {
    paddingTop: 6,
  },
  sendBtnRow: {
    flexDirection: 'row',
    gap: 10,
  },
  sendSlimBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#3a3a3a',
  },
  previewSlimBtn: {
    backgroundColor: '#3a3a3a',
  },
  sendSlimBtnPrimary: {
    backgroundColor: '#2e78b7',
  },
  sendSlimBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  sendStageTitle: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 15,
    fontWeight: '600',
  },
  sendTopBar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  helperText: {
    color: '#666',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
    textAlign: 'center',
  },
  quickActionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
    gap: 10,
  },
  actionChip: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 14,
    backgroundColor: '#2a2a2a',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
    position: 'relative',
  },
  chipDisabled: {
    opacity: 0.5,
  },
  previewChip: {
    backgroundColor: '#4a4a4a', // Muted gray for preview button
  },
  sendChip: {
    backgroundColor: '#2e78b7', // Bright blue for send button (dominant)
    borderWidth: 2,
    borderColor: '#4a9bd9', // Lighter blue border for emphasis
    shadowColor: "#2e78b7",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 4,
    elevation: 4,
  },
  actionChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#fff', // White text for dark background
  },
  badge: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#27ae60',
  },
  // Header
  tabHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  backLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  backText: {
    color: '#666',
    fontSize: 14,
  },
  tabTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#333',
  },
  doneText: {
    color: '#2e78b7',
    fontWeight: '600',
    fontSize: 16,
  },
  // Footer
  footerContainer: {
    paddingBottom: 40,
    paddingTop: 20,
    borderTopWidth: 1,
    borderTopColor: '#333', // Darker border for dark background
  },
  sendButton: {
    backgroundColor: '#2e78b7',
    borderRadius: 16,
    paddingVertical: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // AI LOCKDOWN OVERLAY
  sparkleOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 50,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sparkleCard: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.85)',
    borderRadius: 20,
    paddingVertical: 36,
    paddingHorizontal: 40,
    gap: 16,
  },
  aiOverlayText: {
    color: '#f39c12', // Gold/Orange for visibility on dark
    fontWeight: '700',
    fontSize: 18,
},
cancelAiButton: {
  paddingVertical: 10,
  paddingHorizontal: 24,
  backgroundColor: '#333', // Dark grey button
  borderRadius: 20,
  borderWidth: 1,
  borderColor: '#666',
},
cancelAiText: {
  fontSize: 14,
  fontWeight: '600',
  color: '#fff',
},

// Floating Buttons Column
floatingButtonContainer: {
  position: 'absolute',
  bottom: 30,
  right: 20,
  zIndex: 999,
},
floatingButtonsColumn: {
  flexDirection: 'column',
  gap: 10,
  alignItems: 'flex-end',
},
floatingPreviewButton: {
  backgroundColor: 'rgba(46, 120, 183, 0.8)',
  borderRadius: 25,
  paddingVertical: 10,
  paddingHorizontal: 20,
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 0.3,
  shadowRadius: 8,
  elevation: 8,
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
},
floatingSendButton: {
  backgroundColor: '#2e78b7',
  borderRadius: 25,
  paddingVertical: 10,
  paddingHorizontal: 20,
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 0.3,
  shadowRadius: 8,
  elevation: 8,
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'center',
},
floatingButtonText: {
  color: '#fff',
  fontWeight: '600',
  fontSize: 14,
},
sendingButton: {
  backgroundColor: '#555',
},
disabledSendButton: {
  backgroundColor: '#444',
  opacity: 0.7,
},
emptyStateButton: {
  opacity: 0.9,
},
sendContent: {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 8,
},
sendButtonText: {
  color: '#fff',
  fontSize: 18,
  fontWeight: 'bold',
},
replayOverlay: {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: '25%',
  backgroundColor: 'rgba(0,0,0,0.5)',
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
sparkleSheetBg: {
  backgroundColor: '#1a1a2e',
  borderTopLeftRadius: 20,
  borderTopRightRadius: 20,
},
sparkleSheetContent: {
  paddingHorizontal: 20,
  paddingBottom: 24,
  gap: 10,
},
sparkleSheetHeader: {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 10,
},
sparkleSheetTitle: {
  color: '#fff',
  fontSize: 18,
  fontWeight: '700',
},
sparkleCancelBtn: {
  paddingVertical: 14,
  paddingHorizontal: 20,
},
sparkleCancelText: {
  color: 'rgba(255,255,255,0.5)',
  fontSize: 15,
},
infoBtn: {
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  paddingVertical: 4,
},
infoBtnText: {
  color: '#4a90d9',
  fontSize: 12,
  fontWeight: '500',
},
infoSheetBg: {
  backgroundColor: '#1a1a1a',
  borderTopLeftRadius: 20,
  borderTopRightRadius: 20,
},
infoSheetScroll: {
  paddingHorizontal: 24,
  paddingBottom: 40,
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
});