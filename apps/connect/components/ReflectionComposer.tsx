import { FontAwesome } from '@expo/vector-icons';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { Event } from '@projectmirror/shared';
import { Image } from 'expo-image';
import { Audio } from 'expo-av';
import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import { useVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';
import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
import { captureRef } from 'react-native-view-shot';
import * as VideoThumbnails from 'expo-video-thumbnails';
import {
  PHOTO_EXPORT_SIZE_PX,
  REFLECTION_MAX_VIDEO_MS,
  REFLECTION_MAX_VIDEO_SECONDS,
} from '@/utils/mediaProcessor';
import { ReplayModal } from './ReplayModal';
import {
  VideoTrimSlider,
  coerceThumbnailTimeMs,
  getValidVideoTrimFromFields,
} from '@projectmirror/shared';

export type ComposerVideoMeta = {
  video_start_ms: number;
  video_end_ms: number;
  thumbnail_time_ms: number | null;
  /** Local JPEG from view-shot when native thumbnails fail (e.g. Space Saver / codec quirks). */
  poster_custom_uri?: string | null;
};

export type ComposerSendPayload = {
  caption: string;
  audioUri: string | null;
  deepDive: string | null;
  videoMeta?: ComposerVideoMeta | null;
  /** Final square photo export (framing baked) to upload instead of the raw source photo. */
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
  /** Workbench back: where re-pick media opens (Library, Camera, Search). */
  replaceMediaBackLabel?: string;
}

const MIN_PHOTO_SCALE = 0.35;
const MAX_PHOTO_SCALE = 4;
const SOFT_VIDEO_RECOMMENDED_SECONDS = 60;

function clampVideoTrimWindowMs(
  start: number,
  end: number,
  durationMs: number,
  maxSpanMs: number,
): { start: number; end: number } {
  const d = Math.max(0, Math.round(durationMs));
  let s = Math.max(0, Math.min(Math.round(start), Math.max(0, d - 1)));
  let e = Math.max(s + 1, Math.min(Math.round(end), d));
  if (e - s > maxSpanMs) {
    e = s + maxSpanMs;
    if (e > d) {
      e = d;
      s = Math.max(0, e - maxSpanMs);
    }
  }
  return { start: s, end: Math.max(s + 1, e) };
}

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

const ReflectionComposerVideoPlayerContext = React.createContext<VideoPlayer | null>(null);

function ReflectionComposerVideoPlayerProvider({
  mediaUri,
  children,
}: {
  mediaUri: string;
  children: React.ReactNode;
}) {
  const player = useVideoPlayer(mediaUri, (p) => {
    p.loop = false;
    // Android: starting in the hook setup races SurfaceView attach; play after readyToPlay below.
    if (Platform.OS !== 'android') {
      p.play();
    }
  });
  return (
    <ReflectionComposerVideoPlayerContext.Provider value={player}>
      {children}
    </ReflectionComposerVideoPlayerContext.Provider>
  );
}

function ReflectionComposerInner({
  mediaUri,
  mediaType,
  initialCaption = '',
  audioUri,
  aiArtifacts,
  isAiThinking,
  onCancel: onRetake,
  onReplaceMedia,
  onSend,
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
  replaceMediaBackLabel = 'Library',
}: ReflectionComposerProps) {
  // --- STATE ---
  const insets = useSafeAreaInsets();
  const infoSheetRef = useRef<BottomSheet>(null);
  const [caption, setCaption] = useState(initialCaption);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [videoEnded, setVideoEnded] = useState(false);
  const [videoPaused, setVideoPaused] = useState(false);
  const [videoRangeMs, setVideoRangeMs] = useState<{ start: number; end: number } | null>(null);
  const [thumbnailTimeMs, setThumbnailTimeMs] = useState<number | null>(null);
  /** Fallback poster file when VideoThumbnails fails; forwarded via `onVideoMetaChange`. */
  const [posterCustomUri, setPosterCustomUri] = useState<string | null>(null);
  const [posterViewShotPending, setPosterViewShotPending] = useState(false);
  const videoPosterCaptureRef = useRef<View>(null);
  const posterThumbDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isPosterMode, setIsPosterMode] = useState(false);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [sourceVideoDurationMs, setSourceVideoDurationMs] = useState(0);
  const lastSendAtRef = useRef(0);

  const photoExportStageRef = useRef<View>(null);

  useEffect(() => {
    if (mediaType !== 'video') return;
    setPosterCustomUri(null);
    setPosterViewShotPending(false);
  }, [mediaUri, mediaType]);
  const [photoExportBusy, setPhotoExportBusy] = useState(false);
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
  /** Photo export for Replay preview (not upload). Keeps spinner on Preview, not Send, while `photoExportBusy`. */
  const [previewBuilding, setPreviewBuilding] = useState(false);
  /** Photo export before `onSend` while parent `isSending` may still be false. */
  const [sendPreparing, setSendPreparing] = useState(false);

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
    photoEditRevision: number;
    companionInReflection: boolean;
    explorerInReflection: boolean;
    peopleContextNorm: string;
  } | null>(null);
  const prevAiThinkingRef = useRef(isAiThinking);
  /** `playAiPreview` is declared later; the AI-completion effect calls through this ref to satisfy TS ordering. */
  const playAiPreviewRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    const wasThinking = prevAiThinkingRef.current;
    prevAiThinkingRef.current = isAiThinking;
    if (wasThinking && !isAiThinking && !isAiCancelled) {
      aiSnapshotRef.current = {
        trimStart: videoRangeMs?.start ?? null,
        trimEnd: videoRangeMs?.end ?? null,
        thumbMs: thumbnailTimeMs,
        caption,
        photoEditRevision,
        companionInReflection: !!companionInReflection,
        explorerInReflection: !!explorerInReflection,
        peopleContextNorm: (peopleContext ?? '').trim(),
      };
      if (autoAdvanceRef.current) {
        autoAdvanceRef.current = false;
        wantsAutoPlayRef.current = false;
        setTimeout(() => onStageChange('send'), 400);
      } else if (wantsAutoPlayRef.current) {
        wantsAutoPlayRef.current = false;
        setTimeout(() => void playAiPreviewRef.current?.(), 400);
      }
    }
  }, [
    isAiThinking,
    isAiCancelled,
    videoRangeMs,
    thumbnailTimeMs,
    caption,
    photoEditRevision,
    companionInReflection,
    explorerInReflection,
    peopleContext,
    onStageChange,
  ]);

  const isAiStale = useCallback((): boolean => {
    const snap = aiSnapshotRef.current;
    if (!snap) return false;
    if (caption.trim() !== snap.caption.trim()) return true;
    if (photoEditRevision !== snap.photoEditRevision) return true;
    if ((videoRangeMs?.start ?? null) !== snap.trimStart) return true;
    if ((videoRangeMs?.end ?? null) !== snap.trimEnd) return true;
    if (thumbnailTimeMs !== snap.thumbMs) return true;
    if (!!companionInReflection !== snap.companionInReflection) return true;
    if (!!explorerInReflection !== snap.explorerInReflection) return true;
    if ((peopleContext ?? '').trim() !== snap.peopleContextNorm) return true;
    return false;
  }, [
    caption,
    photoEditRevision,
    videoRangeMs,
    thumbnailTimeMs,
    companionInReflection,
    explorerInReflection,
    peopleContext,
  ]);

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
      photoEditRevision,
      companionInReflection: !!companionInReflection,
      explorerInReflection: !!explorerInReflection,
      peopleContextNorm: (peopleContext ?? '').trim(),
    };
  }, [
    hasAnyAiArtifacts,
    videoRangeMs,
    thumbnailTimeMs,
    caption,
    photoEditRevision,
    companionInReflection,
    explorerInReflection,
    peopleContext,
  ]);

  const ensureAiCurrent = useCallback(
    (): boolean => {
      const needsRun = (!aiSnapshotRef.current && !hasAnyAiArtifacts) || isAiStale();
      if (!needsRun) return true;
      autoAdvanceRef.current = false;
      wantsAutoPlayRef.current = false;
      setIsAiCancelled(false);
      onTriggerMagic(caption || undefined).catch(() => {});
      return false;
    },
    [hasAnyAiArtifacts, isAiStale, onTriggerMagic, caption],
  );

  const { height: screenHeight, width: screenWidth } = useWindowDimensions();
  const FOOTER_HEIGHT_PX = 36;

  /** Utility bar block height used for media top offset. */
  const TOP_TOOLBAR_BLOCK_PX = 38;
  /** Video action strip (Replay/Poster) below back/close row. */
  const VIDEO_TOOLBAR_STRIP_PX = 44;
  /** Compact trim bar height below action strip. */
  const VIDEO_TRIM_BAR_PX = 56;
  /** Photo tools strip (rotate / reset) height for media top offset. */
  const PHOTO_TOOLS_STRIP_PX = 56;
  /** Visual breathing room between bars. */
  const PHOTO_BARS_GAP_PX = 8;

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


  const isRemoteMediaUri =
    typeof mediaUri === 'string' &&
    (mediaUri.startsWith('http://') || mediaUri.startsWith('https://'));

  // New asset: clear trim state so duration-based init is not mixed with a previous clip.
  useEffect(() => {
    if (mediaType !== 'video') return;
    setVideoRangeMs(null);
    setThumbnailTimeMs(null);
    setIsPosterMode(false);
    setVideoPaused(false);
    setVideoEnded(false);
  }, [mediaUri, mediaType]);

  const player = useContext(ReflectionComposerVideoPlayerContext);
  const trimAppliedRef = useRef(false);

  useEffect(() => {
    if (mediaType !== 'video' || !player) return;
    player.loop = false;
  }, [player, mediaType, mediaUri]);

  // Android: defer first play until the decoder reports ready — avoids a permanently black SurfaceView.
  useEffect(() => {
    if (mediaType !== 'video' || !player || Platform.OS !== 'android') return;
    let started = false;
    const maybeStart = () => {
      if (started) return;
      if (player.status === 'readyToPlay') {
        started = true;
        try {
          player.play();
        } catch {
          /* ignore */
        }
      }
    };
    maybeStart();
    const sub = player.addListener('statusChange', maybeStart);
    return () => {
      sub.remove();
    };
  }, [mediaType, mediaUri, player]);

  useEffect(() => {
    if (!player) return;
    const sub = player.addListener('playToEnd', () => {
      setVideoEnded(true);
    });
    return () => sub.remove();
  }, [player]);

  useEffect(() => {
    if (!player || mediaType !== 'video' || Platform.OS !== 'android') return;
    if (!__DEV__) return;
    const subStatus = player.addListener('statusChange', ({ status, error }) => {
      console.log(
        `🎬 [ReflectionComposer][android] status=${status} duration=${player.duration.toFixed(3)} current=${player.currentTime.toFixed(3)} uri=${mediaUri}`
      );
      if (error?.message) {
        console.warn(`🎬 [ReflectionComposer][android] player error: ${error.message}`);
      }
    });
    const subSource = player.addListener('sourceChange', () => {
      console.log(`🎬 [ReflectionComposer][android] sourceChange uri=${mediaUri}`);
    });
    const subPlaying = player.addListener('playingChange', ({ isPlaying }) => {
      console.log(
        `🎬 [ReflectionComposer][android] playing=${isPlaying} status=${player.status} uri=${mediaUri}`
      );
    });
    return () => {
      subStatus.remove();
      subSource.remove();
      subPlaying.remove();
    };
  }, [player, mediaType, mediaUri]);

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
      const trim = getValidVideoTrimFromFields(
        initialVideoMeta?.video_start_ms,
        initialVideoMeta?.video_end_ms,
      );
      const thumbMs = coerceThumbnailTimeMs(initialVideoMeta?.thumbnail_time_ms);
      if (thumbMs !== undefined) {
        setThumbnailTimeMs(thumbMs);
      }

      if (trim) {
        const clampedEnd = Math.min(trim.endMs, durationMs);
        const clampedStart = Math.max(0, Math.min(trim.startMs, clampedEnd - 1));
        const window = clampVideoTrimWindowMs(
          clampedStart,
          Math.max(clampedStart + 1, clampedEnd),
          durationMs,
          REFLECTION_MAX_VIDEO_MS,
        );
        setVideoRangeMs(window);
        try { player.currentTime = window.start / 1000; } catch { /* ignore */ }
      } else {
        const window = clampVideoTrimWindowMs(0, durationMs, durationMs, REFLECTION_MAX_VIDEO_MS);
        setVideoRangeMs(window);
        try { player.currentTime = window.start / 1000; } catch { /* ignore */ }
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

    // Polling fallback — statusChange may not fire on all platforms
    const poll = setInterval(() => {
      if (player.duration > 0) {
        applyTrim();
        clearInterval(poll);
      }
    }, 250);

    return () => { sub.remove(); clearInterval(poll); };
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
      poster_custom_uri: posterCustomUri,
    });
  }, [videoRangeMs, thumbnailTimeMs, posterCustomUri, onVideoMetaChange]);

  useEffect(() => {
    if (mediaType !== 'video' || !mediaUri) return;
    if (posterThumbDebounceRef.current) clearTimeout(posterThumbDebounceRef.current);
    posterThumbDebounceRef.current = setTimeout(() => {
      const t = thumbnailTimeMs != null ? thumbnailTimeMs : 1000;
      const dur = sourceVideoDurationMs > 0 ? sourceVideoDurationMs : 60_000;
      const time = Math.max(0, Math.min(Math.round(t), Math.max(0, dur - 1)));
      void (async () => {
        try {
          const { uri } = await VideoThumbnails.getThumbnailAsync(mediaUri, { time, quality: 0.5 });
          setPosterCustomUri(uri);
          setPosterViewShotPending(false);
        } catch {
          setPosterCustomUri(null);
          setPosterViewShotPending(true);
        }
      })();
    }, 320);
    return () => {
      if (posterThumbDebounceRef.current) clearTimeout(posterThumbDebounceRef.current);
    };
  }, [mediaType, mediaUri, thumbnailTimeMs, sourceVideoDurationMs]);

  useEffect(() => {
    if (mediaType !== 'video' || !posterViewShotPending || !player) return;
    if (player.status !== 'readyToPlay') return;
    let cancelled = false;
    void (async () => {
      try {
        const dur = player.duration > 0 ? player.duration : 0;
        const seekSec = Math.min(1, Math.max(0.05, dur > 0.15 ? dur - 0.05 : 0.05));
        try {
          player.pause();
        } catch {
          /* ignore */
        }
        try {
          player.currentTime = seekSec;
        } catch {
          /* ignore */
        }
        await new Promise((r) => setTimeout(r, Platform.OS === 'android' ? 450 : 280));
        const node = videoPosterCaptureRef.current;
        if (!node || cancelled) return;
        const raw = await captureRef(node, { format: 'jpg', quality: 0.85, result: 'tmpfile' });
        const path = typeof raw === 'string' ? raw : '';
        if (!path || cancelled) return;
        const uri = path.startsWith('file://') ? path : `file://${path}`;
        setPosterCustomUri(uri);
      } catch (e) {
        if (__DEV__) console.warn('[ReflectionComposer] view-shot poster failed', e);
      } finally {
        if (!cancelled) setPosterViewShotPending(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mediaType, posterViewShotPending, player, player?.status, mediaUri]);

  useEffect(() => {
    if (!videoRangeMs || thumbnailTimeMs === null) return;
    let next = thumbnailTimeMs;
    if (next > videoRangeMs.end) next = videoRangeMs.end;
    if (next < 0) next = 0;
    // Poster may intentionally sit slightly before the playback in-point (cover vs trim window).
    if (next !== thumbnailTimeMs) setThumbnailTimeMs(next);
  }, [videoRangeMs, thumbnailTimeMs]);

  useEffect(() => {
    if (mediaType !== 'video' || !player || !videoRangeMs) return;
    player.timeUpdateEventInterval = 0.25;
    const sub = player.addListener('timeUpdate', () => {
      const curMs = player.currentTime * 1000;
      setPlayheadMs(curMs);
      if (curMs > videoRangeMs.end - 50) {
        player.pause();
        player.currentTime = videoRangeMs.end / 1000;
        setVideoEnded(true);
        setVideoPaused(false);
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
          poster_custom_uri: posterCustomUri,
        } as ComposerVideoMeta,
      };
    }
    return { ...base, videoMeta: null };
  }, [caption, audioUri, aiArtifacts?.deepDive, mediaType, videoRangeMs, thumbnailTimeMs, posterCustomUri]);

  const currentPlaybackWindowSeconds = useMemo(() => {
    if (mediaType !== 'video' || !videoRangeMs) return 0;
    return Math.round((videoRangeMs.end - videoRangeMs.start) / 1000);
  }, [mediaType, videoRangeMs]);

  const showSoftVideoWarning =
    mediaType === 'video' && currentPlaybackWindowSeconds > SOFT_VIDEO_RECOMMENDED_SECONDS;

  const exportCurrentPhoto = useCallback(async (): Promise<string | null> => {
    if (mediaType !== 'photo') return null;
    const target = photoExportStageRef.current;
    if (!target) return null;
    syncPhotoExportTransform();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    setPhotoExportBusy(true);
    try {
      const raw = await captureRef(target, {
        format: 'jpg',
        quality: 0.88,
        result: 'tmpfile',
      });
      const path = typeof raw === 'string' ? raw : '';
      if (!path) return null;
      return path.startsWith('file://') ? path : `file://${path}`;
    } catch {
      return null;
    } finally {
      setPhotoExportBusy(false);
    }
  }, [mediaType, syncPhotoExportTransform]);


  const doSendNow = useCallback(async () => {
    const now = Date.now();
    if (now - lastSendAtRef.current < 800) return;
    lastSendAtRef.current = now;
    setSendPreparing(true);
    try {
      let filteredPhotoUri: string | null = null;
      if (mediaType === 'photo') {
        filteredPhotoUri = await exportCurrentPhoto();
      }
      onSend({ ...buildSendPayload(), filteredPhotoUri });
    } finally {
      setSendPreparing(false);
    }
  }, [buildSendPayload, onSend, mediaType, exportCurrentPhoto]);

  const handleSendWithThrottle = useCallback(async () => {
    if (!ensureAiCurrent()) return;
    doSendNow();
  }, [ensureAiCurrent, doSendNow]);


  const doPreviewNow = useCallback(async () => {
    setPreviewBuilding(true);
    try {
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
    } finally {
      setPreviewBuilding(false);
    }
  }, [mediaUri, mediaType, audioUri, aiArtifacts, caption, exportCurrentPhoto]);

  const handlePreview = useCallback(() => {
    if (!ensureAiCurrent()) return;
    void doPreviewNow();
  }, [ensureAiCurrent, doPreviewNow]);

  const goToWorkbench = () => {
    onStageChange('workbench');
    Keyboard.dismiss();
  };
  const goToAi = useCallback(() => {
    if (mediaType === 'video' && player) {
      try { player.pause(); } catch { /* tearing down */ }
    }
    onStageChange('ai');
  }, [mediaType, player, onStageChange]);

  const goToSend = useCallback(() => {
    Keyboard.dismiss();
    const needsRun = (!aiSnapshotRef.current && !hasAnyAiArtifacts) || isAiStale();
    if (needsRun) {
      autoAdvanceRef.current = true;
      wantsAutoPlayRef.current = false;
      setIsAiCancelled(false);
      onTriggerMagic(caption || undefined).catch(() => {
        autoAdvanceRef.current = false;
      });
      return;
    }
    onStageChange('send');
  }, [hasAnyAiArtifacts, isAiStale, onStageChange, onTriggerMagic, caption]);

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

  playAiPreviewRef.current = playAiPreview;

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
  const autoAdvanceRef = useRef(false);

  const handleRunSparkleAndPlay = useCallback(() => {
    wantsAutoPlayRef.current = true;
    autoAdvanceRef.current = false;
    setIsAiCancelled(false);
    onTriggerMagic(caption || undefined).catch(() => {
      wantsAutoPlayRef.current = false;
    });
  }, [onTriggerMagic, caption]);

  // --- RENDERERS ---

  const togglePlayPause = useCallback(() => {
    if (!player) return;
    if (videoEnded) {
      setVideoEnded(false);
      if (videoRangeMs) {
        player.currentTime = videoRangeMs.start / 1000;
      } else {
        player.currentTime = 0;
      }
      player.play();
      setVideoPaused(false);
      return;
    }
    if (videoPaused) {
      player.play();
      setVideoPaused(false);
    } else {
      player.pause();
      setVideoPaused(true);
    }
  }, [player, videoEnded, videoPaused, videoRangeMs]);

  const handleReplay = useCallback(() => {
    if (!player) return;
    setVideoEnded(false);
    setVideoPaused(false);
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
    if (!player) return;
    player.pause();
    if (thumbnailTimeMs !== null) {
      try { player.currentTime = thumbnailTimeMs / 1000; } catch { /* ignore */ }
    }
    setIsPosterMode(true);
  }, [player, thumbnailTimeMs]);

  const COVER_STEP_MS = 250;

  const handleCoverSet = useCallback(() => {
    if (!player) return;
    const curMs = Math.round(player.currentTime * 1000);
    setThumbnailTimeMs(Math.max(0, curMs));
  }, [player]);

  const handleCoverStepBack = useCallback(() => {
    if (!player) return;
    const rangeStart = videoRangeMs?.start ?? 0;
    const curMs = thumbnailTimeMs ?? Math.round(player.currentTime * 1000);
    const targetMs = Math.max(rangeStart, curMs - COVER_STEP_MS);
    try { player.currentTime = targetMs / 1000; } catch { /* ignore */ }
    setThumbnailTimeMs(targetMs);
  }, [player, thumbnailTimeMs, videoRangeMs]);

  const handleCoverStepForward = useCallback(() => {
    if (!player) return;
    const rangeEnd = videoRangeMs?.end ?? Math.round(player.duration * 1000);
    const curMs = thumbnailTimeMs ?? Math.round(player.currentTime * 1000);
    const targetMs = Math.min(rangeEnd, curMs + COVER_STEP_MS);
    try { player.currentTime = targetMs / 1000; } catch { /* ignore */ }
    setThumbnailTimeMs(targetMs);
  }, [player, thumbnailTimeMs, videoRangeMs]);

  const handleCoverClear = useCallback(() => {
    setThumbnailTimeMs(null);
  }, []);

  const exitPosterMode = useCallback(() => {
    setIsPosterMode(false);
    if (!player) return;
    player.play();
  }, [player]);

  const posterScrubOriginMs = useSharedValue(0);
  const videoDurationMs = useSharedValue(0);

  const playerDurationForWorklet = player?.duration ?? 0;
  useEffect(() => {
    if (!player || playerDurationForWorklet <= 0) return;
    videoDurationMs.value = player.duration * 1000;
  }, [player, playerDurationForWorklet, videoDurationMs]);

  const seekToMs = useCallback((ms: number) => {
    if (!player) return;
    try { player.currentTime = ms / 1000; } catch { /* ignore */ }
  }, [player]);

  const posterScrubPan = useMemo(() =>
    Gesture.Pan()
      .enabled(isPosterMode)
      .onBegin(() => {
        posterScrubOriginMs.value = Math.round((player?.currentTime ?? 0) * 1000);
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
    [isPosterMode, videoRangeMs, screenWidth, seekToMs, posterScrubOriginMs, videoDurationMs, player],
  );

  const tapToTogglePlay = useMemo(() =>
    Gesture.Tap()
      .enabled(!isPosterMode)
      .onEnd(() => {
        runOnJS(togglePlayPause)();
      }),
    [isPosterMode, togglePlayPause],
  );

  const videoGesture = useMemo(() =>
    Gesture.Race(posterScrubPan, tapToTogglePlay),
    [posterScrubPan, tapToTogglePlay],
  );

  const isWorkbenchStage = stage === 'workbench';

  const photoEditBarPx = mediaType === 'photo' && isWorkbenchStage ? TOP_TOOLBAR_BLOCK_PX : 0;
  const footerBottomInsetPx = isWorkbenchStage || stage === 'send'
    ? FOOTER_HEIGHT_PX + Math.max(insets.bottom, 8)
    : 0;
  const videoTopBarsPx = TOP_TOOLBAR_BLOCK_PX + PHOTO_BARS_GAP_PX + VIDEO_TOOLBAR_STRIP_PX + VIDEO_TRIM_BAR_PX + 8;
  const videoTrimTopPx = insets.top + TOP_TOOLBAR_BLOCK_PX + PHOTO_BARS_GAP_PX + VIDEO_TOOLBAR_STRIP_PX + 4;

  const renderBackground = () => (
    <View
      style={[
        styles.backgroundContainer,
        {
          top:
            insets.top +
            (isWorkbenchStage && mediaType === 'photo'
              ? photoEditBarPx + PHOTO_TOOLS_STRIP_PX + PHOTO_BARS_GAP_PX
              : 0) +
            (isWorkbenchStage && mediaType === 'video'
              ? videoTopBarsPx
              : 0),
          bottom: footerBottomInsetPx,
        },
      ]}
    >
      {mediaType === 'video' ? (
        <View style={styles.videoMediaFill}>
          <View
            ref={videoPosterCaptureRef}
            style={styles.videoMediaSurface}
            collapsable={false}
          >
            {/*
              VideoView must not be a child of RNGH GestureDetector on Android — the native
              surface often never paints. Keep VideoView under a plain View; gestures on overlay.
            */}
            {player ? (
              <VideoView
                key={mediaUri}
                player={player}
                style={styles.videoViewLayer}
                contentFit="contain"
                nativeControls={false}
              />
            ) : null}
            <GestureDetector gesture={videoGesture}>
              <View style={styles.videoGestureOverlay} />
            </GestureDetector>
            {isPosterMode && (
              <View style={styles.posterModeIndicator} pointerEvents="none">
                <Text style={styles.posterModeText}>Use arrows or swipe to find your frame</Text>
              </View>
            )}
          </View>
        </View>
      ) : (
        <View style={styles.photoRoot}>
          <View style={styles.photoStage} onLayout={handlePhotoStageLayout}>
            <GestureDetector gesture={photoEditorGesture}>
              <View style={styles.photoStageClip}>
                <Animated.View style={[styles.photoStageFill, photoTransformStyle]}>
                  <Image
                    source={{ uri: mediaUri }}
                    style={styles.photoStageFill}
                    contentFit="contain"
                    cachePolicy={isRemoteMediaUri ? 'memory-disk' : 'disk'}
                    transition={isRemoteMediaUri ? 200 : 0}
                  />
                </Animated.View>
              </View>
            </GestureDetector>
            <View pointerEvents="none" style={styles.photoFrameChrome}>
              <View style={styles.photoFrameBorder} />
              <View style={styles.photoFrameLabelPill}>
                <Text style={styles.photoFrameLabelText}>Crop</Text>
              </View>
            </View>
          </View>
        </View>
      )}
      <LinearGradient
        pointerEvents="none"
        colors={['transparent', 'rgba(0,0,0,0.5)']}
        style={styles.gradientOverlay}
      />

      {/* REPLAY OVERLAY — shown when video finishes, hidden during poster mode */}
      {mediaType === 'video' && videoEnded && !isPosterMode && (
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
      <View style={styles.coverToolbarRow}>
        <View style={styles.coverArrowPair}>
          <TouchableOpacity
            style={styles.coverArrowBtn}
            onPress={handleCoverStepBack}
            activeOpacity={0.6}
          >
            <FontAwesome name="backward" size={16} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.coverArrowBtn}
            onPress={handleCoverStepForward}
            activeOpacity={0.6}
          >
            <FontAwesome name="forward" size={16} color="#fff" />
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          style={[styles.coverActionBtn, { borderColor: 'rgba(74, 222, 128, 0.4)' }]}
          onPress={handleCoverSet}
            activeOpacity={0.7}
          >
          <FontAwesome name="check" size={16} color="#4ade80" />
          <Text style={[styles.coverActionBtnText, { color: '#4ade80' }]}>Set</Text>
          </TouchableOpacity>
            <TouchableOpacity
          style={styles.coverActionBtn}
              onPress={handleReplay}
              activeOpacity={0.7}
            >
          <FontAwesome name="repeat" size={16} color="#fff" />
          <Text style={styles.coverActionBtnText}>Replay</Text>
            </TouchableOpacity>
        <TouchableOpacity
          style={styles.coverActionBtn}
          onPress={handleCoverClear}
          activeOpacity={0.7}
        >
          <FontAwesome name="eraser" size={16} color="#fff" />
          <Text style={styles.coverActionBtnText}>Clear</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.coverActionBtn, { borderColor: 'rgba(79, 195, 247, 0.4)' }]}
          onPress={exitPosterMode}
          activeOpacity={0.7}
        >
          <FontAwesome name="check-circle" size={16} color="#4FC3F7" />
          <Text style={[styles.coverActionBtnText, { color: '#4FC3F7' }]}>Done</Text>
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
              style={styles.workbenchNavPillBack}
              onPress={goToAi}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Back to Sparkle"
            >
              <FontAwesome name="arrow-left" size={16} color="#fff" />
              <Text style={styles.workbenchNavPillLabel}>Sparkle</Text>
            </TouchableOpacity>
            <Text style={[styles.sendStageTitle, styles.sendStageTitleCenter]} numberOfLines={1}>
              Preview & Send
            </Text>
            <TouchableOpacity
              style={[styles.toolbarCloseBtn, isBlockedByAi && { opacity: 0.35 }]}
              onPress={onRetake}
              disabled={isSending || isBlockedByAi}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Close"
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
            <TouchableOpacity
              style={[styles.workbenchNavPillBack, isBlockedByAi && { opacity: 0.35 }]}
              onPress={onReplaceMedia}
              disabled={isSending || isBlockedByAi}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Back to ${replaceMediaBackLabel}`}
            >
              <FontAwesome name="arrow-left" size={16} color="#fff" />
              <Text style={styles.workbenchNavPillLabel}>{replaceMediaBackLabel}</Text>
        </TouchableOpacity>
            <View style={styles.workbenchTopBarSpacer} />
            <View style={styles.topBarRight}>
              <TouchableOpacity
                style={[styles.workbenchNavPillNext, (isSending || isAiThinking || photoExportBusy) && { opacity: 0.35 }]}
                onPress={goToAi}
                disabled={isSending || isAiThinking || photoExportBusy}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Go to Sparkle"
              >
                <Text style={styles.workbenchNavPillLabel}>Sparkle</Text>
                <FontAwesome name="arrow-right" size={12} color="#fff" />
        </TouchableOpacity>
              <TouchableOpacity
                style={[styles.toolbarCloseBtn, styles.toolbarCloseBtnWorkbench, isBlockedByAi && { opacity: 0.35 }]}
                onPress={onRetake}
                disabled={isSending || isBlockedByAi}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Close"
              >
                <FontAwesome name="times" size={14} color="rgba(255,255,255,0.8)" />
              </TouchableOpacity>
            </View>
          </View>
        </View>
      );
    }

    return (
      <>
        <View style={[styles.topToolbar, { top: insets.top }]}>
          <View style={styles.videoUtilityRow}>
          <TouchableOpacity 
              style={[styles.workbenchNavPillBack, isBlockedByAi && { opacity: 0.35 }]}
              onPress={onReplaceMedia}
              disabled={isSending || isBlockedByAi}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Back to ${replaceMediaBackLabel}`}
            >
              <FontAwesome name="arrow-left" size={16} color="#fff" />
              <Text style={styles.workbenchNavPillLabel}>{replaceMediaBackLabel}</Text>
            </TouchableOpacity>
            <View style={styles.workbenchTopBarSpacer} />
            <View style={styles.topBarRight}>
              <TouchableOpacity
                style={[styles.workbenchNavPillNext, (isSending || isAiThinking || photoExportBusy) && { opacity: 0.35 }]}
                onPress={goToAi}
                disabled={isSending || isAiThinking || photoExportBusy}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Go to Sparkle"
              >
                <Text style={styles.workbenchNavPillLabel}>Sparkle</Text>
                <FontAwesome name="arrow-right" size={12} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.toolbarCloseBtn, styles.toolbarCloseBtnWorkbench, isBlockedByAi && { opacity: 0.35 }]}
                onPress={onRetake}
                disabled={isSending || isBlockedByAi}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Close"
              >
                <FontAwesome name="times" size={14} color="rgba(255,255,255,0.8)" />
              </TouchableOpacity>
            </View>
          </View>
        </View>
        <View
            style={[
            styles.videoActionsWrap,
            { top: insets.top + TOP_TOOLBAR_BLOCK_PX + PHOTO_BARS_GAP_PX, height: VIDEO_TOOLBAR_STRIP_PX },
          ]}
          pointerEvents="box-none"
        >
          <View style={styles.looksToolbar}>
            <View style={styles.videoActionsRow}>
              <TouchableOpacity
                style={[styles.toolbarChip, styles.videoActionChip, isBlockedByAi && { opacity: 0.35 }]}
                onPress={togglePlayPause}
                disabled={isSending || isBlockedByAi}
                activeOpacity={0.7}
              >
                <FontAwesome name={videoPaused || videoEnded ? 'play' : 'pause'} size={16} color="#fff" />
                <Text style={styles.toolbarChipText}>{videoPaused || videoEnded ? 'Play' : 'Pause'}</Text>
          </TouchableOpacity>
              <TouchableOpacity
                style={[styles.toolbarChip, styles.videoActionChip, isBlockedByAi && { opacity: 0.35 }]}
                onPress={handleReplay}
                disabled={isSending || isBlockedByAi}
                activeOpacity={0.7}
              >
                <FontAwesome name="repeat" size={16} color="#fff" />
                <Text style={styles.toolbarChipText}>Replay</Text>
              </TouchableOpacity>
          <TouchableOpacity 
            style={[
                  styles.toolbarChip,
                  styles.videoActionChip,
                  thumbnailTimeMs !== null && styles.toolbarChipActive,
                  isBlockedByAi && { opacity: 0.35 },
                ]}
                onPress={enterPosterMode}
                disabled={isSending || isBlockedByAi}
                activeOpacity={0.7}
              >
                <FontAwesome name="image" size={16} color={thumbnailTimeMs !== null ? '#4ade80' : '#fff'} />
                <Text style={[styles.toolbarChipText, thumbnailTimeMs !== null && { color: '#4ade80' }]}>Poster</Text>
          </TouchableOpacity>
      </View>
          </View>
        </View>
      </>
  );
  };

  const renderWorkbenchTab = () => (
    <Animated.View entering={FadeIn} exiting={FadeOut} style={styles.tabContainer}>
      {showSoftVideoWarning ? (
        <View style={styles.videoGuidanceBanner}>
          <FontAwesome name="clock-o" size={14} color="#f5c842" />
          <Text style={styles.videoGuidanceText}>
            Best under 60s for the Explorer. Current: {currentPlaybackWindowSeconds}s.
          </Text>
        </View>
      ) : null}
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
  const sparkleNeeded =
    (!aiSnapshotRef.current && !hasAnyAiArtifacts) || isAiStale();

  const renderAiTab = () => (
    <Animated.View entering={FadeIn} exiting={FadeOut} style={[styles.aiScreen, { paddingTop: insets.top + 8 }]}>
      <View style={styles.aiNavBar}>
        <TouchableOpacity
          onPress={goToWorkbench}
          style={styles.aiNavBackRow}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Back to Workbench"
        >
          <FontAwesome name="arrow-left" size={16} color="#fff" />
          <Text style={styles.aiNavBackLabel}>Workbench</Text>
        </TouchableOpacity>
        <Text style={[styles.aiNavTitle, styles.aiNavTitleCenter]} numberOfLines={1}>
          Sparkle
        </Text>
        <View style={[styles.topBarRight, styles.aiNavRightCluster]}>
          <TouchableOpacity
            onPress={goToSend}
            style={styles.aiNavNextBtn}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Finish Sparkle and go to preview and send"
          >
            <Text style={styles.aiNavNextText} numberOfLines={1}>
              Finish
            </Text>
            <FontAwesome name="arrow-right" size={12} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.toolbarCloseBtn,
              styles.toolbarCloseBtnWorkbench,
              (isSending || isBlockedByAi) && { opacity: 0.35 },
            ]}
            onPress={onRetake}
            disabled={isSending || isBlockedByAi}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <FontAwesome name="times" size={14} color="rgba(255,255,255,0.8)" />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        style={styles.aiScreenScroll}
        contentContainerStyle={{ flexGrow: 1, paddingBottom: 8 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.aiSubtitleText}>
          No changes needed? Tap Finish (top-right) to keep your current draft and open preview.
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
              onPress={() =>
                onCompanionInReflectionChange?.(!companionInReflection)
              }
              activeOpacity={0.7}
            >
              <FontAwesome
                name={companionInReflection ? 'check-square-o' : 'square-o'}
                size={16}
                color={companionInReflection ? '#4FC3F7' : 'rgba(255,255,255,0.45)'}
              />
              <Text
                style={[
                  styles.aiToggleLabel,
                  companionInReflection && styles.aiToggleLabelActive,
                ]}
              >
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
              <Text
                style={[
                  styles.aiToggleLabel,
                  explorerInReflection && styles.aiToggleLabelActive,
                ]}
              >
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
            style={[styles.aiSparkleBtn, (!sparkleNeeded && !isAiThinking) && { opacity: 0.35 }]}
            onPress={handleRunSparkleAndPlay}
            disabled={isAiThinking || !sparkleNeeded}
            activeOpacity={0.8}
          >
            <FontAwesome name="magic" size={14} color="#fff" />
            <Text style={styles.aiSparkleBtnText}>
              {isAiThinking ? 'Running...' : sparkleNeeded ? 'Run Sparkle' : 'Up to Date'}
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
            style={[
              styles.sendSlimBtn,
              styles.previewSlimBtn,
              (isSending || isAiThinking || previewBuilding || photoExportBusy) && { opacity: 0.4 },
            ]}
            onPress={handlePreview}
            disabled={isSending || isAiThinking || photoExportBusy || previewBuilding}
            activeOpacity={0.7}
          >
            {previewBuilding ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <FontAwesome name="eye" size={15} color="#fff" />
                <Text style={styles.sendSlimBtnText}>Preview</Text>
              </>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.sendSlimBtn,
              styles.sendSlimBtnPrimary,
              (isSending || sendPreparing || (!caption && !hasRecordedAudio)) && { opacity: 0.4 },
            ]}
            onPress={handleSendWithThrottle}
            disabled={isSending || sendPreparing || photoExportBusy || (!caption && !hasRecordedAudio)}
            activeOpacity={0.7}
          >
            {isSending || sendPreparing ? (
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
          <View ref={photoExportStageRef} collapsable={false} style={styles.photoExportStage}>
            <View
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
            >
              <Image
                source={{ uri: mediaUri }}
                style={styles.photoExportFill}
                contentFit="contain"
                cachePolicy={isRemoteMediaUri ? 'memory-disk' : 'disk'}
              />
            </View>
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
              {mediaType === 'video'
                ? 'Trimming & optimizing… Adding sparkle to your Reflection!'
                : 'Adding sparkle to your Reflection!'}
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

      {/* 2b. INLINE VIDEO TRIMMER — below action buttons, above video */}
      {isWorkbenchStage && mediaType === 'video' && videoRangeMs && player && player.duration > 0 && (
        <View style={[styles.trimSliderOverlay, { top: videoTrimTopPx }]}>
          <VideoTrimSlider
            durationMs={Math.round(player.duration * 1000)}
            startMs={videoRangeMs.start}
            endMs={videoRangeMs.end}
            currentTimeMs={playheadMs}
            maxRangeMs={REFLECTION_MAX_VIDEO_MS}
            onChange={(s, e) => setVideoRangeMs({ start: s, end: e })}
            onSeek={(ms) => { try { player.currentTime = ms / 1000; } catch { /* ignore */ } }}
          />
        </View>
      )}

      {isWorkbenchStage && mediaType === 'photo' && (
        <View
          style={[
            styles.looksBarWrap,
            { top: insets.top + photoEditBarPx + PHOTO_BARS_GAP_PX, height: PHOTO_TOOLS_STRIP_PX },
          ]}
          pointerEvents="box-none"
        >
          <View style={styles.photoEditToolsToolbar}>
            <TouchableOpacity
              style={[styles.photoToolBtn, (isBlockedByAi || photoExportBusy) && { opacity: 0.35 }]}
              onPress={() => rotatePhotoBy(-90)}
              disabled={isSending || isBlockedByAi || photoExportBusy}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel="Rotate photo"
            >
              <FontAwesome name="rotate-left" size={20} color="#fff" />
              <Text style={styles.photoToolBtnText}>Rotate</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.photoToolBtn, (isBlockedByAi || photoExportBusy) && { opacity: 0.35 }]}
              onPress={resetPhotoTransform}
              disabled={isSending || isBlockedByAi || photoExportBusy}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel="Reset crop and rotation"
            >
              <FontAwesome name="refresh" size={20} color="#fff" />
              <Text style={styles.photoToolBtnText}>Reset</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* 3. FIXED FOOTER */}
      {stage !== 'ai' ? (
        <View style={[styles.footerBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
          {stage === 'workbench' && renderWorkbenchTab()}
          {stage === 'send' && renderSendTab()}
        </View>
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
              ? `Three stages: Workbench → Sparkle → Preview & Send. In the Workbench you trim, tap the video to pause or resume, replay, and set a poster frame. The top-right chip is labeled with the next stage (Sparkle); the top-left chip shows where you picked media (Camera, Library, or Search) to re-pick. The video stops when you leave Workbench. X closes back to the timeline. Reflections work best under ${SOFT_VIDEO_RECOMMENDED_SECONDS} seconds; ${REFLECTION_MAX_VIDEO_SECONDS} seconds (${Math.round(REFLECTION_MAX_VIDEO_SECONDS / 60)} minutes) is the hard cap.`
              : 'Three stages: Workbench → Sparkle → Preview & Send. In the Workbench, drag and pinch to frame the photo inside the square, rotate with two fingers or the Rotate button, and tap Reset to undo zoom, pan, and rotation. The top-right chip is labeled with the next stage (Sparkle); the top-left chip shows where you picked media (Camera, Library, or Search) to re-pick. X closes back to the timeline.'}
          </Text>

          {mediaType === 'video' ? (
            <>
              <View style={styles.infoRow}>
                <View style={styles.infoIconWrap}>
                  <FontAwesome name="scissors" size={14} color="#4FC3F7" />
                </View>
                <View style={styles.infoTextWrap}>
                  <Text style={styles.infoLabel}>Trim & Playback</Text>
                  <Text style={styles.infoDesc}>
                    The gold trim bar sits below the top controls. Drag the handles to set the playback window the Explorer will experience — start and end times are saved as metadata only, the full source video is uploaded. The selected duration shows inside the bar. You get a light tap when a handle hits the start, end, or minimum length. Hold a handle to zoom in: the bar temporarily maps to about four seconds centered on that handle so you can nudge the edge with precision. Tap the video itself to pause or resume playback. The video does not loop — when it reaches the end, a Replay button appears. There is also a play/pause button in the top control bar.
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
                    The poster is the frame the Explorer sees first, before the video plays — think of it like a movie poster. Tap Poster to enter poster mode. The video pauses and the top bar shows arrow buttons to step backward and forward in quarter-second jumps. Tap Set to lock the current frame. You can also swipe on the video to scrub freely. Clear drops back to the default frame, and Done exits and resumes playback. If the poster time falls after the end of your trim, it moves to the end of the trim; you can also place it slightly before the trim start if you want a cover frame that is not the first moment of playback.
                  </Text>
                </View>
              </View>
            </>
          ) : (
            <View style={styles.infoRow}>
              <View style={styles.infoIconWrap}>
                <FontAwesome name="crop" size={14} color="#f39c12" />
              </View>
              <View style={styles.infoTextWrap}>
                <Text style={styles.infoLabel}>Crop & position</Text>
                <Text style={styles.infoDesc}>
                  Frame the photo inside the square by dragging and pinching. Twist with two fingers to rotate, or tap Rotate for a 90° turn. Reset snaps back to the original fit. What you see in that square is what gets exported and uploaded for the Explorer — same idea as cropping before you post elsewhere.
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
                Optional. Record a short intro in your own voice on the Sparkle screen. After you send, the Explorer hears that recording first when present; it always takes priority over AI-generated intro audio. If you do not record, Sparkle can synthesize speech from your caption after you run Sparkle — so run Sparkle at least once before sending if you want an AI voice intro.
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
                Sparkle writes a caption automatically based on your hints and media. You can edit it or replace it entirely on the Sparkle screen. If you did not record a voice intro, this caption text is spoken aloud to the Explorer in an AI voice before the content plays. The caption is also saved as metadata on the reflection.
              </Text>
            </View>
          </View>

          <View style={styles.infoRow}>
            <View style={styles.infoIconWrap}>
              <FontAwesome name="magic" size={14} color="#f5c842" />
            </View>
            <View style={styles.infoTextWrap}>
              <Text style={styles.infoLabel}>Run Sparkle & Play</Text>
              <Text style={styles.infoDesc}>
                {mediaType === 'video'
                  ? 'On the Sparkle screen, add context for AI, mark who is in the clip, and optionally record your voice or write a caption. Run Sparkle uses your hints and media to draft a caption and generate an AI voice intro — after it finishes, it auto-plays the result: caption audio first, then the deep dive. The Play button lets you re-listen to an existing Sparkle result without regenerating it. Run Sparkle is disabled and shows "Up to Date" when nothing has changed; it re-enables when you change trim, poster, caption, or Sparkle hints (toggles or context text). If you recorded your own voice, that always takes priority over the AI voice. Run Sparkle as many times as you want.'
                  : 'On the Sparkle screen, add context for AI, mark who is in the photo, and optionally record your voice or write a caption. Run Sparkle uses your hints and media to draft a caption and generate an AI voice intro — after it finishes, it auto-plays the result: caption audio first, then the deep dive. The Play button lets you re-listen to an existing Sparkle result without regenerating it. Run Sparkle is disabled and shows "Up to Date" when nothing has changed; it re-enables when you change caption, Sparkle hints (toggles or context text), or how the photo is framed in Workbench. If you recorded your own voice, that always takes priority over the AI voice. Run Sparkle as many times as you want.'}
              </Text>
            </View>
          </View>

          <View style={styles.infoDivider} />

          <Text style={styles.infoProTipHeader}>A few things worth knowing</Text>
          <Text style={styles.infoProTip}>
            Workbench: left chip re-opens where you picked media (Camera, Library, or Search); right side is Sparkle and X. Sparkle: left is Workbench; right is Finish (opens Preview & Send) and X. Preview & Send: left is Sparkle; right is X. X always closes to the timeline (same behavior on every stage). Nothing sends until you tap Send on the final screen.
          </Text>
          <Text style={styles.infoProTip}>
            Fast path: on Sparkle, tap Finish (top-right). If Sparkle has not finished yet or your edits are out of date with the last run, it runs first and then moves on to Preview & Send when ready — you do not need a separate Run Sparkle tap in that case.
          </Text>
          <Text style={styles.infoProTip}>
            After Sparkle has run, changing trim, poster, caption, Sparkle hints, or (for photos) framing in Workbench makes Run Sparkle light up again. Tapping Finish will run Sparkle first when needed, then take you to Preview & Send so AI stays aligned with your edits.
          </Text>
          <Text style={styles.infoProTip}>
            {mediaType === 'video'
              ? 'The Explorer sees your poster frame first, then hears your voice or AI intro, then the video plays. Think of it as setting a stage. Tap the video to pause or resume; it does not loop. Video stops when you leave Workbench for Sparkle.'
              : 'The Explorer sees your cropped photo first, then hears your voice or AI intro. Order and pacing stay calm — no auto-advancing feed.'}
          </Text>
          <Text style={styles.infoProTip}>
            On Android, the system back key steps back between Workbench, Sparkle, and Preview & Send; from Workbench it closes like the X button.
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
        isSendDisabled={isBlockedByAi || photoExportBusy || (!caption && !hasRecordedAudio)}
      />

    </GestureHandlerRootView>
  );
}

export default function ReflectionComposer(props: ReflectionComposerProps) {
  if (props.mediaType === 'video') {
    return (
      <ReflectionComposerVideoPlayerProvider mediaUri={props.mediaUri}>
        <ReflectionComposerInner {...props} />
      </ReflectionComposerVideoPlayerProvider>
    );
  }
  return (
    <ReflectionComposerVideoPlayerContext.Provider value={null}>
      <ReflectionComposerInner {...props} />
    </ReflectionComposerVideoPlayerContext.Provider>
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
  /** Fills the workbench media band; required so GestureDetector’s child gets a real height on Android. */
  videoMediaFill: {
    flex: 1,
    width: '100%',
    minHeight: 0,
  },
  videoMediaSurface: {
    flex: 1,
    width: '100%',
    minHeight: 0,
  },
  videoViewLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 0,
  },
  /** Transparent hit target for tap / poster scrub; sits above VideoView. */
  videoGestureOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1,
    backgroundColor: 'transparent',
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
    overflow: 'visible',
  },
  photoStageClip: {
    flex: 1,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  /** Sits on the square crop (sibling of clip) so the badge can extend past the mask without clipping. */
  photoFrameChrome: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 2,
    alignItems: 'center',
  },
  photoFrameBorder: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 2,
    borderColor: 'rgba(79,195,247,0.65)',
  },
  /**
   * Pill behind “Crop”: background + radius live on a View so iOS and Android clip the same.
   * (Radius on Text alone is inconsistent across platforms.)
   */
  photoFrameLabelPill: {
    marginTop: -12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(38,52,68,0.86)',
    overflow: 'hidden',
    alignSelf: 'center',
  },
  photoFrameLabelText: {
    color: 'rgba(226,244,255,0.98)',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.2,
    ...Platform.select({
      android: { includeFontPadding: false },
      default: {},
    }),
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
    zIndex: 28,
  },
  videoActionsWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 29,
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
  /** Photo workbench: left-aligned tools (rotate / reset), larger targets — similar rhythm to native crop UIs. */
  photoEditToolsToolbar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 12,
    paddingLeft: 14,
    paddingRight: 14,
    paddingVertical: 4,
    backgroundColor: 'rgba(0,0,0,0.42)',
  },
  photoToolBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    minHeight: 48,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  photoToolBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  photoUtilityRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 0,
    minWidth: 0,
  },
  videoUtilityRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
  },
  workbenchTopBarSpacer: {
    flex: 1,
    minWidth: 6,
  },
  videoActionsRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  videoActionChip: {
    flex: 1,
    minWidth: 0,
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
  workbenchNavPillBack: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    minHeight: 36,
    borderRadius: 20,
    backgroundColor: 'rgba(30, 30, 30, 0.88)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
    flexShrink: 0,
  },
  workbenchNavPillNext: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 7,
    paddingHorizontal: 12,
    minHeight: 36,
    borderRadius: 18,
    backgroundColor: '#2e78b7',
    flexShrink: 0,
  },
  workbenchNavPillLabel: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    flexShrink: 0,
  },
  topBarRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    flexShrink: 0,
    marginRight: 2,
  },
  topBarNextBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 18,
    backgroundColor: '#2e78b7',
  },
  topBarNextText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  topToolbar: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 6,
    paddingRight: 4,
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
  coverToolbarRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
  },
  coverArrowPair: {
    flexDirection: 'row',
    gap: 8,
  },
  coverArrowBtn: {
    width: 48,
    height: 54,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  coverActionBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    width: 54,
    height: 54,
    borderRadius: 12,
    backgroundColor: 'rgba(30, 30, 30, 0.88)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  coverActionBtnText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '600',
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
  toolbarCloseBtnWorkbench: {
    marginLeft: 2,
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
  footerBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 20,
    paddingTop: 8,
    zIndex: 30,
  },
  sheetHandle: {
    backgroundColor: '#666',
    width: 40,
  },
  aiScreen: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 35,
    backgroundColor: '#0d1117',
  },
  aiNavBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.1)',
    gap: 6,
  },
  aiNavBackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.1)',
    maxWidth: '42%',
  },
  aiNavBackLabel: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  aiNavTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#f2f6fb',
    letterSpacing: 0.3,
  },
  aiNavTitleCenter: {
    flex: 1,
    textAlign: 'center',
  },
  /** Tight right column on Sparkle: Finish + X (matches workbench / send close behavior). */
  aiNavRightCluster: {
    flexShrink: 1,
    minWidth: 0,
    maxWidth: '52%',
  },
  aiNavNextBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#2e78b7',
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 18,
    flexShrink: 1,
    minWidth: 0,
  },
  aiNavNextText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    flexShrink: 1,
    minWidth: 0,
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
    paddingTop: 12,
    paddingBottom: 4,
  },
  aiInfoLinkText: {
    color: '#4a90d9',
    fontSize: 14,
    fontWeight: '500',
  },
  tabContainer: {
  },
  sendTabContainer: {
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
  sendStageTitleCenter: {
    flex: 1,
    textAlign: 'center',
    minWidth: 0,
    marginHorizontal: 4,
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
  ...StyleSheet.absoluteFillObject,
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
  fontSize: 14,
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