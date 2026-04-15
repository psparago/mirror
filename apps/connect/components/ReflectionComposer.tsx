import { FontAwesome } from '@expo/vector-icons';
import BottomSheet, { BottomSheetScrollView, BottomSheetTextInput, BottomSheetView } from '@gorhom/bottom-sheet';
import { Event } from '@projectmirror/shared';
import { Image } from 'expo-image';
import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Keyboard,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  FadeIn,
  FadeOut,
  runOnJS,
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
  /** Local file URI from image-filter-kit extract when Look (B&W) is on; JPEG gatekeeper runs in CreationModal. */
  filteredPhotoUri?: string | null;
};

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
}: ReflectionComposerProps) {
  // --- STATE ---
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheet>(null);
  const sparkleSheetRef = useRef<BottomSheet>(null);
  const infoSheetRef = useRef<BottomSheet>(null);
  const [caption, setCaption] = useState(initialCaption);
  const [activeTab, setActiveTab] = useState<'main' | 'voice' | 'text'>('main');
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [videoEnded, setVideoEnded] = useState(false);
  const [videoRangeMs, setVideoRangeMs] = useState<{ start: number; end: number } | null>(null);
  const [thumbnailTimeMs, setThumbnailTimeMs] = useState<number | null>(null);
  const [isPosterMode, setIsPosterMode] = useState(false);
  const [playheadMs, setPlayheadMs] = useState(0);
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
      };
    }
  }, [isAiThinking, isAiCancelled, videoRangeMs, thumbnailTimeMs, caption, currentFilterType]);

  const isAiStale = useCallback((): boolean => {
    const snap = aiSnapshotRef.current;
    if (!snap) return false;
    if (caption.trim() !== snap.caption.trim()) return true;
    if (currentFilterType !== snap.currentFilterType) return true;
    if ((videoRangeMs?.start ?? null) !== snap.trimStart) return true;
    if ((videoRangeMs?.end ?? null) !== snap.trimEnd) return true;
    if (thumbnailTimeMs !== snap.thumbMs) return true;
    return false;
  }, [caption, currentFilterType, videoRangeMs, thumbnailTimeMs]);

  const { height: screenHeight, width: screenWidth } = useWindowDimensions();

  /** Top toolbar stack height (must match `topToolbar` padding + chip row). */
  const TOP_TOOLBAR_BLOCK_PX = 62;
  /** Photo Looks strip sits directly under the toolbar; media starts below this. */
  const PHOTO_LOOKS_STRIP_PX = 70;

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

  // AUTO-OPEN SPARKLE HINTS ON MOUNT (when caption is empty — new content fast path)
  useEffect(() => {
    if (!caption && !isAiThinking && !isAiCancelled) {
      requestAnimationFrame(() => sparkleSheetRef.current?.snapToIndex(0));
    }
  }, []);

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
    const mainHeight = screenHeight * 0.18; // 18% for main tab
    const voiceHeight = screenHeight * 0.45; // 45% for voice tab
    
    // For text tab: fill the space above the keyboard
    if (keyboardHeight > 0) {
      // When keyboard is visible: sheet should fill from keyboard to near top of screen
      const topMargin = Math.max(48, insets.top + 12);
      const textHeight = screenHeight - keyboardHeight - topMargin;
      return [mainHeight, voiceHeight, textHeight];
    } else {
      // When keyboard is not visible: use 92% of screen
      return [mainHeight, voiceHeight, screenHeight * 0.92];
    }
  }, [screenHeight, keyboardHeight, insets.top]);

  // Ensure sheet snaps to correct position when tab changes or keyboard shows/hides
  useEffect(() => {
    if (!sheetRef.current) return;
    
    // Small delay to ensure the tab content has rendered and snap points are updated
    const timeoutId = setTimeout(() => {
      const targetIndex = activeTab === 'main' ? 0 : activeTab === 'voice' ? 1 : 2;
      sheetRef.current?.snapToIndex(targetIndex);
    }, 100);
    
    return () => clearTimeout(timeoutId);
  }, [activeTab, snapPoints, keyboardHeight]);

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
    const sub = player.addListener('statusChange', () => applyTrim());
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

  const openSparkleSheet = useCallback(() => {
    setIsPosterMode(false);
    sparkleSheetRef.current?.snapToIndex(0);
  }, []);

  const doSendNow = useCallback(async () => {
    const now = Date.now();
    if (now - lastSendAtRef.current < 800) return;
    lastSendAtRef.current = now;
    let filteredPhotoUri: string | null = null;
    if (mediaType === 'photo' && isFilterActive) {
      filteredPhotoUri = await extractFilteredImage();
      if (!filteredPhotoUri) {
        filteredPhotoUri = lastFilteredExtractUriRef.current;
      }
    }
    onSend({ ...buildSendPayload(), filteredPhotoUri });
  }, [buildSendPayload, onSend, mediaType, isFilterActive, extractFilteredImage]);

  const handleSendWithThrottle = useCallback(async () => {
    if (isAiStale()) {
      Alert.alert(
        'Re-run Sparkle?',
        'You\'ve made changes since the last AI pass. Re-run Sparkle before sending?',
        [
          { text: 'Send Anyway', style: 'destructive', onPress: () => { doSendNow(); } },
          { text: 'Sparkle First', onPress: openSparkleSheet },
          { text: 'Cancel', style: 'cancel' },
        ],
      );
      return;
    }
    doSendNow();
  }, [isAiStale, doSendNow, openSparkleSheet]);

  const handleSheetChange = useCallback((index: number) => {
    if (index < 2) {
      Keyboard.dismiss();
    }
  }, []);

  const doPreviewNow = useCallback(() => {
    const previewId = 'preview-temp';
    const now = new Date();

    const mockEvent: Event = {
      event_id: previewId,
      image_url: mediaUri,
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
  }, [mediaUri, mediaType, audioUri, aiArtifacts, caption]);

  const handlePreview = useCallback(() => {
    if (isAiStale()) {
      Alert.alert(
        'Re-run Sparkle?',
        'You\'ve made changes since the last AI pass. Re-run Sparkle before previewing?',
        [
          { text: 'Preview Anyway', onPress: () => { doPreviewNow(); } },
          { text: 'Sparkle First', onPress: openSparkleSheet },
          { text: 'Cancel', style: 'cancel' },
        ],
      );
      return;
    }
    doPreviewNow();
  }, [isAiStale, doPreviewNow, openSparkleSheet]);

  // --- TABS SWITCHERS ---
  const switchToVoice = () => { 
    setActiveTab('voice'); 
    requestAnimationFrame(() => {
      sheetRef.current?.snapToIndex(1);
    });
  };
  const switchToText = () => { 
    setActiveTab('text'); 
    requestAnimationFrame(() => {
      sheetRef.current?.snapToIndex(2);
    });
  };
  const resetToMain = () => {
    setActiveTab('main');
    requestAnimationFrame(() => {
      sheetRef.current?.snapToIndex(0);
    });
    Keyboard.dismiss(); 
  };

  // --- SPARKLE HINTS SHEET ---
  const handleRunSparkle = useCallback(() => {
    sparkleSheetRef.current?.close();
    setIsAiCancelled(false);
    onTriggerMagic(caption || undefined).catch(() => {});
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

  /** Photo: optional Edit-only row above Looks; Sparkle + Close live on the Looks row. */
  const photoEditBarPx = mediaType === 'photo' && showTopMediaEdit ? TOP_TOOLBAR_BLOCK_PX : 0;

  const renderBackground = () => (
    <View
      style={[
        styles.backgroundContainer,
        {
          top:
            insets.top +
            (mediaType === 'photo' ? photoEditBarPx : TOP_TOOLBAR_BLOCK_PX) +
            (mediaType === 'photo' ? PHOTO_LOOKS_STRIP_PX : 0),
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
      ) : currentFilterType !== 'original' ? (
        <ReflectionFilteredPhoto
          mediaUri={mediaUri}
          currentFilterType={currentFilterType}
          extractImageEnabled={extractImageEnabled}
          onExtractImage={handleExtractImage}
          style={styles.media}
        />
      ) : (
        <Image
          source={{ uri: mediaUri }}
          style={styles.media}
          contentFit="cover"
          cachePolicy={isRemoteMediaUri ? 'memory-disk' : 'disk'}
          transition={isRemoteMediaUri ? 200 : 0}
        />
      )}
      <LinearGradient colors={['transparent', 'rgba(0,0,0,0.5)']} style={styles.gradientOverlay} />

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
    if (isPosterMode) return renderPosterToolbar();

    if (mediaType === 'photo') {
      if (!showTopMediaEdit) return null;
      return (
        <View style={[styles.topToolbar, { top: insets.top }]}>
          <View style={[styles.topToolbarRow, styles.photoTopToolbarRow]}>
            <TouchableOpacity
              style={[styles.toolbarChip, isBlockedByAi && { opacity: 0.35 }]}
              onPress={onReplaceMedia}
              disabled={isSending || isBlockedByAi}
              activeOpacity={0.7}
            >
              <FontAwesome name="pencil" size={16} color="#fff" />
              <Text style={styles.toolbarChipText}>Edit</Text>
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
          <TouchableOpacity
            style={[styles.toolbarChip, styles.toolbarSparkleChip, isBlockedByAi && { opacity: 0.35 }]}
            onPress={openSparkleSheet}
            disabled={isSending || isBlockedByAi}
            activeOpacity={0.7}
          >
            <FontAwesome name="magic" size={16} color={isBlockedByAi ? '#f39c12' : '#f5c842'} />
            <Text style={[styles.toolbarChipText, { color: '#f5c842' }]}>Sparkle</Text>
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
    );
  };

  const renderMainTab = () => (
    <Animated.View entering={FadeIn} exiting={FadeOut} style={styles.tabContainer}>
      <View style={styles.quickActionsRow}>
        
        {/* VOICE CHIP */}
        <TouchableOpacity style={styles.actionChip} onPress={switchToVoice}>
          {hasRecordedAudio ? (
             <View style={styles.badge} />
          ) : null}
          <FontAwesome name="microphone" size={20} color={hasRecordedAudio ? "#27ae60" : "#2e78b7"} />
          <Text style={styles.actionChipText}>Voice</Text>
        </TouchableOpacity>
        
        {/* TEXT CHIP */}
        <TouchableOpacity style={styles.actionChip} onPress={switchToText}>
          {caption ? <View style={styles.badge} /> : null}
          <FontAwesome name="pencil" size={20} color={caption ? "#27ae60" : "#8e44ad"} />
          <Text style={styles.actionChipText}>Text</Text>
        </TouchableOpacity>

        {/* PREVIEW BUTTON */}
        {!isBlockedByAi && (
          <TouchableOpacity 
            style={[
              styles.actionChip,
              styles.previewChip,
              (isSending || isAiThinking) && styles.chipDisabled
            ]} 
            onPress={handlePreview}
            disabled={isSending || isAiThinking || lookExtractBusy}
          >
            <FontAwesome name="eye" size={20} color="#fff" />
            <Text style={styles.actionChipText}>Preview</Text>
          </TouchableOpacity>
        )}

        {/* SEND BUTTON */}
        {!isBlockedByAi && (
          <TouchableOpacity 
            style={[
              styles.actionChip,
              styles.sendChip,
              isSending && styles.chipDisabled,
              (!caption && !hasRecordedAudio) && styles.chipDisabled
            ]}
            onPress={handleSendWithThrottle}
            disabled={isSending || lookExtractBusy || (!caption && !hasRecordedAudio)}
          >
            {isSending || lookExtractBusy ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <FontAwesome name="paper-plane" size={20} color="#fff" />
                <Text style={styles.actionChipText}>Send</Text>
              </>
            )}
          </TouchableOpacity>
        )}
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

  const renderVoiceTab = () => (
    <Animated.View entering={FadeIn} exiting={FadeOut} style={styles.tabContainer}>
      <View style={styles.tabHeader}>
        <TouchableOpacity onPress={resetToMain} style={styles.backLink}>
          <FontAwesome name="chevron-left" size={16} color="#666" />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.tabTitle}>Voice Message</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.recorderContainer}>
        {hasRecordedAudio && !audioRecorder?.isRecording ? (
           <View style={styles.playbackState}>
             <FontAwesome name="check-circle" size={48} color="#27ae60" />
             <Text style={styles.recordingStatus}>Voice Note Recorded</Text>
             <TouchableOpacity onPress={() => { /* Logic to clear audio */ }}>
                <Text style={styles.clearText}>Tap record to overwrite</Text>
             </TouchableOpacity>
           </View>
        ) : null}

        <TouchableOpacity 
          style={[styles.recordButton, audioRecorder?.isRecording && styles.recordingActive]}
          onPress={audioRecorder?.isRecording ? onStopRecording : onStartRecording}
        >
          <FontAwesome 
            name={audioRecorder?.isRecording ? "stop" : "microphone"} 
            size={32} 
            color="#fff" 
          />
        </TouchableOpacity>
        <Text style={styles.recordingStatus}>
          {audioRecorder?.isRecording ? "Recording..." : (hasRecordedAudio ? "Record New" : "Tap to Record")}
        </Text>
      </View>
    </Animated.View>
  );

  const renderTextTab = () => (
    <Animated.View entering={FadeIn} exiting={FadeOut} style={styles.tabContainer}>
      <View style={styles.tabHeader}>
        <TouchableOpacity onPress={resetToMain} style={styles.backLink}>
          <FontAwesome name="chevron-left" size={16} color="#666" />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.tabTitle}>Description</Text>
        <TouchableOpacity onPress={resetToMain}>
          <Text style={styles.doneText}>Done</Text>
        </TouchableOpacity>
      </View>

      <BottomSheetTextInput
        style={styles.input}
        placeholder="What is happening in this reflection?"
        placeholderTextColor="#666"
        value={caption}
        onChangeText={setCaption}
        multiline
        scrollEnabled
        textAlignVertical="top"
        autoFocus
        onFocus={() => {
          // Snap to highest point when text input is focused
          sheetRef.current?.snapToIndex(2);
        }}
        onBlur={() => {
          Keyboard.dismiss();
        }}
      />
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
      {mediaType === 'video' && videoRangeMs && player.duration > 0 && (
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

      {mediaType === 'photo' && (
        <View
          style={[
            styles.looksBarWrap,
            { top: insets.top + photoEditBarPx, height: PHOTO_LOOKS_STRIP_PX },
          ]}
          pointerEvents="box-none"
        >
          <View style={styles.looksToolbar}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.photoLooksScroll}
              contentContainerStyle={styles.photoLooksScrollContent}
            >
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
            </ScrollView>
            <View style={styles.looksToolbarDivider} />
            <TouchableOpacity
              style={[styles.toolbarChip, styles.toolbarSparkleChip, isBlockedByAi && { opacity: 0.35 }]}
              onPress={openSparkleSheet}
              disabled={isSending || isBlockedByAi}
              activeOpacity={0.7}
            >
              <FontAwesome name="magic" size={16} color={isBlockedByAi ? '#f39c12' : '#f5c842'} />
              <Text style={[styles.toolbarChipText, { color: '#f5c842' }]}>Sparkle</Text>
            </TouchableOpacity>
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
      )}

      {/* 3. BOTTOM SHEET TOOLKIT */}
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
          {activeTab === 'main' && renderMainTab()}
          {activeTab === 'voice' && renderVoiceTab()}
          {activeTab === 'text' && renderTextTab()}
        </BottomSheetView>
      </BottomSheet>

      {/* 4. SPARKLE HINTS SHEET */}
      <BottomSheet
        ref={sparkleSheetRef}
        index={-1}
        snapPoints={[380]}
        enablePanDownToClose
        backgroundStyle={styles.sparkleSheetBg}
        handleIndicatorStyle={styles.sheetHandle}
      >
        <BottomSheetView style={styles.sparkleSheetContent}>
          <View style={styles.sparkleSheetHeader}>
            <FontAwesome name="magic" size={18} color="#f39c12" />
            <Text style={styles.sparkleSheetTitle}>Sparkle Hints</Text>
          </View>
          <Text style={styles.sparkleSheetSubtitle}>
            Help AI understand this Reflection before it runs.
          </Text>

          <TouchableOpacity
            style={styles.sparkleHintToggle}
            onPress={() => onCompanionInReflectionChange?.(!companionInReflection)}
            activeOpacity={0.7}
          >
            <FontAwesome
              name={companionInReflection ? 'check-square-o' : 'square-o'}
              size={18}
              color={companionInReflection ? '#4FC3F7' : 'rgba(255,255,255,0.5)'}
            />
            <Text style={[styles.sparkleHintLabel, companionInReflection && styles.sparkleHintLabelActive]}>
              I'm in this
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.sparkleHintToggle}
            onPress={() => onExplorerInReflectionChange?.(!explorerInReflection)}
            activeOpacity={0.7}
          >
            <FontAwesome
              name={explorerInReflection ? 'check-square-o' : 'square-o'}
              size={18}
              color={explorerInReflection ? '#4FC3F7' : 'rgba(255,255,255,0.5)'}
            />
            <Text style={[styles.sparkleHintLabel, explorerInReflection && styles.sparkleHintLabelActive]}>
              {explorerName || 'Explorer'} is in this
            </Text>
          </TouchableOpacity>

          <View style={styles.sparkleHintInputRow}>
            <FontAwesome name="users" size={14} color="rgba(255,255,255,0.4)" style={{ marginTop: 4 }} />
            <BottomSheetTextInput
              style={styles.sparkleHintInput}
              placeholder="e.g. Nona, dog Dalton, baby Dante, at Nona's house"
              placeholderTextColor="rgba(255,255,255,0.3)"
              value={peopleContext ?? ''}
              onChangeText={(t) => onPeopleContextChange?.(t)}
              returnKeyType="done"
              autoCorrect={false}
              autoCapitalize="words"
            />
          </View>

          <View style={styles.sparkleSheetActions}>
            <TouchableOpacity
              style={styles.sparkleRunBtn}
              onPress={handleRunSparkle}
              activeOpacity={0.8}
            >
              <FontAwesome name="magic" size={16} color="#fff" />
              <Text style={styles.sparkleRunText}>Run Sparkle</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.sparkleCancelBtn}
              onPress={() => sparkleSheetRef.current?.close()}
              activeOpacity={0.7}
            >
              <Text style={styles.sparkleCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </BottomSheetView>
      </BottomSheet>

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
              ? 'Everything here helps the Explorer understand and connect with what you are sharing. The top bar replaces or adjusts the clip (Edit, Replay, Poster), runs Sparkle, or closes to start over. From the gallery you trim to at most 60 seconds; that clip is the master file you upload. The trim bar here chooses the playback window inside that master (metadata only, no second upload). The bottom sheet has voice, text, preview, and send. Use any tool in any order, as many times as you like.'
              : `Everything here helps the Explorer understand and connect with what you are sharing.${showTopMediaEdit ? ' Edit at the very top replaces your photo when you need a different shot.' : ''} The row above your image sets Looks, runs Sparkle, and closes to start over. The bottom sheet has voice, text, preview, and send. Use any tool in any order, as many times as you like.`}
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
                    In the gallery you already trimmed to a 60 second (or shorter) master. The strip here sits over the bottom of the video so you can pick the exact playback window inside that master — for example a 15 second highlight — without uploading a new file; start and end times are saved as metadata only. You get a light tap when a handle hits the start, end, or minimum length. Hold a handle to zoom: the bar temporarily maps to about four seconds centered on that handle so you can nudge the edge with precision.
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
                  Original, Clarity, Classic, and Warm live in the bar directly above your photo (you can scroll that section sideways on a narrow screen). They set how the image is processed before upload. A slim divider separates them from Sparkle and Close on the same row so picture style stays visually grouped. Clarity bumps contrast and saturation; Classic is black and white; Warm leans golden. Your choice is baked into the file the Explorer receives — not just a preview.
                </Text>
              </View>
            </View>
          )}

          <View style={styles.infoRow}>
            <View style={styles.infoIconWrap}>
              <FontAwesome name="microphone" size={14} color="#2e78b7" />
            </View>
            <View style={styles.infoTextWrap}>
              <Text style={styles.infoLabel}>Voice</Text>
              <Text style={styles.infoDesc}>
                Say it in your own words. This plays before the content so the Explorer knows what's coming and who it's from.
              </Text>
            </View>
          </View>

          <View style={styles.infoRow}>
            <View style={styles.infoIconWrap}>
              <FontAwesome name="pencil" size={14} color="#8e44ad" />
            </View>
            <View style={styles.infoTextWrap}>
              <Text style={styles.infoLabel}>Text</Text>
              <Text style={styles.infoDesc}>
                Add a caption. Keep it short — the Explorer reads this alongside your voice intro.
              </Text>
            </View>
          </View>

          <View style={styles.infoRow}>
            <View style={styles.infoIconWrap}>
              <FontAwesome name="magic" size={14} color="#f5c842" />
            </View>
            <View style={styles.infoTextWrap}>
              <Text style={styles.infoLabel}>Sparkle</Text>
              <Text style={styles.infoDesc}>
                {mediaType === 'video'
                  ? 'Tap Sparkle in the top bar to open the hints sheet: mark if you are in the shot, if the Explorer is, and add a short people or context line. Then run Sparkle. AI uses that plus your media to write caption copy and intro audio. You can run it as many times as you want.'
                  : 'Tap the gold Sparkle chip on the right side of the bar above your photo (next to Close) to open the hints sheet: mark if you are in the shot, if the Explorer is, and add a short people or context line. Then run Sparkle. AI uses that plus your media to write caption copy and intro audio. You can run it as many times as you want.'}
              </Text>
            </View>
          </View>

          <View style={styles.infoDivider} />

          <Text style={styles.infoProTipHeader}>A few things worth knowing</Text>
          <Text style={styles.infoProTip}>
            You can go back and forth between any of these as many times as you need. Experiment freely — nothing is sent until you tap Send.
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
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  photoLooksScroll: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  photoLooksScrollContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingRight: 4,
  },
  photoLookChip: {
    flexShrink: 0,
  },
  looksToolbarDivider: {
    width: StyleSheet.hairlineWidth * 2,
    alignSelf: 'stretch',
    minHeight: 28,
    marginVertical: 4,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  photoTopToolbarRow: {
    justifyContent: 'flex-start',
    marginRight: 0,
  },
  topToolbar: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingTop: 10,
    paddingBottom: 18,
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
  tabContainer: {
    flex: 1,
    paddingTop: 10,
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
  input: {
    fontSize: 18,
    lineHeight: 24,
    color: '#fff', // White text for dark background
    minHeight: 150,
    textAlignVertical: 'top',
  },
  // Voice
  recorderContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
    gap: 20,
  },
  playbackState: {
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  recordButton: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#e74c3c',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: "#e74c3c",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  recordingActive: {
    backgroundColor: '#c0392b',
    transform: [{ scale: 1.1 }],
  },
  recordingStatus: {
    fontSize: 16,
    color: '#999', // Lighter for dark background
    fontWeight: '500',
  },
  clearText: {
    fontSize: 12,
    color: '#666',
    textDecorationLine: 'underline',
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
sparkleSheetSubtitle: {
  color: 'rgba(255,255,255,0.5)',
  fontSize: 13,
  marginBottom: 4,
},
sparkleHintToggle: {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 10,
  paddingVertical: 6,
},
sparkleHintLabel: {
  color: 'rgba(255,255,255,0.6)',
  fontSize: 15,
},
sparkleHintLabelActive: {
  color: '#4FC3F7',
},
sparkleHintInputRow: {
  flexDirection: 'row',
  alignItems: 'flex-start',
  gap: 10,
  marginTop: 2,
},
sparkleHintInput: {
  flex: 1,
  color: '#fff',
  fontSize: 14,
  borderBottomWidth: StyleSheet.hairlineWidth,
  borderBottomColor: 'rgba(255,255,255,0.2)',
  paddingVertical: 6,
},
sparkleSheetActions: {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 12,
  marginTop: 12,
},
sparkleRunBtn: {
  flex: 1,
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  backgroundColor: '#f39c12',
  paddingVertical: 14,
  borderRadius: 12,
},
sparkleRunText: {
  color: '#fff',
  fontSize: 16,
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