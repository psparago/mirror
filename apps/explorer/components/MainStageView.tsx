import { FontAwesome } from '@expo/vector-icons';
import {
  buildLikeFeedbackPhrase,
  buildDocumentaryChapters,
  coerceThumbnailTimeMs,
  CompanionAvatar,
  DocumentaryChapter,
  API_ENDPOINTS,
  Event,
  EventMetadata,
  getCloudMasterTrimWindow,
  getLikeFeedbackMediaKind,
  getVideoParkSeekSec,
  isLikeFeedbackInCooldown,
  getValidVideoTrimMs,
  playerMachine,
  REACTION_PARENT_PLAYBACK_VOLUME,
  resolveReactionParentPipMedia,
  resolveReactionPlaybackType,
  seekVideoToSeconds,
  shouldUseCompanionAvatarReactionPip,
  useThrottledCallback,
  type ReactionSignal,
} from '@projectmirror/shared';
import { LikeHeartBurstOverlay, useLikeHeartBursts } from '@/components/LikeHeartBurst';
import { playLikeFeedbackAudio, stopLikeFeedbackAudio } from '@/utils/playLikeFeedbackAudio';
import { TellMeMoreButton } from '@/components/stage/TellMeMoreButton';
import { ActivityRow } from '@/components/stage/ActivityRow';
import { DocumentaryReactionPip } from '@/components/stage/DocumentaryReactionPip';
import { StageCaptionBar } from '@/components/stage/StageCaptionBar';
import { StageCrossFadeMedia } from '@/components/stage/StageCrossFadeMedia';
import { useDocumentarySequence } from '@/hooks/useDocumentarySequence';

import { useMachine } from '@xstate/react';
import * as Sentry from '@sentry/react-native';
import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';
import { BlurView } from 'expo-blur';
import * as Clipboard from 'expo-clipboard';
import { ExplorerGradientBackdrop } from '@/components/ExplorerGradientBackdrop';
import { useRouter } from 'expo-router';

import * as Speech from 'expo-speech';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Image } from 'expo-image';
import { imageUrlCacheKey } from '@/utils/imageUrlCacheKey';
import { playVideoPlayerWhenReady } from '@/utils/videoPlayerReady';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TextStyle,
  TouchableOpacity,
  useWindowDimensions,
  View
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withRepeat,
  withSequence,
  withTiming
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Heavy OS call — only once per app session. Re-running when MainStage opens repeats
 * triggers MPRemoteCommandCenter / audio route work on the main thread.
 */
let isAudioModeSet = false;

/** Called from this module and from the home tab so grid/arrival audio works before MainStage mounts. */
export function ensureExplorerAudioSessionOnce(): void {
  if (isAudioModeSet) return;
  isAudioModeSet = true;
  Audio.setAudioModeAsync({
    allowsRecordingIOS: false,
    playsInSilentModeIOS: true,
    shouldDuckAndroid: true,
    staysActiveInBackground: true,
    playThroughEarpieceAndroid: false,
    interruptionModeIOS: InterruptionModeIOS.DoNotMix,
    interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
  }).catch((err) => {
    isAudioModeSet = false;
    console.warn('Reflections: Audio.setAudioModeAsync failed:', err);
  });
}

function trimMeta(s?: string): string {
  return typeof s === 'string' ? s.trim() : '';
}

function shortDiagId(id?: string | null): string {
  if (!id) return 'none';
  return id.length <= 8 ? id : id.slice(-8);
}

function playerDiag(player: unknown): string {
  const p = player as { status?: string; playing?: boolean; currentTime?: number; duration?: number } | null;
  if (!p) return 'none';
  const time =
    typeof p.currentTime === 'number' && Number.isFinite(p.currentTime)
      ? ` @${p.currentTime.toFixed(1)}s`
      : '';
  const duration =
    typeof p.duration === 'number' && Number.isFinite(p.duration) && p.duration > 0
      ? `/${p.duration.toFixed(1)}`
      : '';
  return `${p.status ?? 'unknown'}:${p.playing ? 'play' : 'stop'}${time}${duration}`;
}

/**
 * True when a video player has effectively reached the end of its clip.
 * expo-video's `playToEnd` event is unreliable on some sources (notably reaction selfie
 * clips over image parents), so we also detect completion from currentTime vs duration.
 */
function isVideoPlayerAtEnd(player: unknown): boolean {
  const p = player as { currentTime?: number; duration?: number } | null;
  if (!p) return false;
  const dur = typeof p.duration === 'number' && Number.isFinite(p.duration) ? p.duration : 0;
  const cur = typeof p.currentTime === 'number' && Number.isFinite(p.currentTime) ? p.currentTime : 0;
  // Require a real duration; 0.3s tolerance absorbs the gap between the last frame and `duration`.
  return dur > 0.3 && cur >= dur - 0.3;
}

function chapterBadgeIcon(chapter: DocumentaryChapter) {
  if (!chapter.isReaction) return 'play' as const;
  if (chapter.reactionType === 'typed') return 'keyboard-o' as const;
  if (chapter.reactionType === 'voice') return 'microphone' as const;
  return 'video-camera' as const;
}

/** True when the decoder is showing the trim window (not frame 0 before seek settles). */
function playheadShowsTrimStart(
  trim: ReturnType<typeof getCloudMasterTrimWindow>,
  currentTimeSec: number
): boolean {
  if (!trim.active) return true;
  return currentTimeSec >= trim.startSec - 0.2 && currentTimeSec < trim.endSec + 0.5;
}

/** True when the only "caption" we have is the generic fallback word (not a real title). */
function isGenericReflectionCaption(s: string): boolean {
  return /^reflection$/i.test(s.trim());
}

/**
 * Title / caption line for tiles and stage: prefer map, then embedded Event.metadata.
 * Up Next used to read only `description`; empty string is falsy so it always showed "Reflection"
 * when the real text lived in `short_caption` or on the Event.
 */
const EVENT_DATE_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/** Avoid Intl / toLocaleDateString on hot paths (large Up Next / metadata lists). */
function formatEventDateFromId(eventId: string): string {
  const timestamp = parseInt(eventId, 10);
  if (Number.isNaN(timestamp)) return '—';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '—';
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  return `${EVENT_DATE_MONTHS[date.getMonth()]} ${date.getDate()}`;
}

/** Rough row height when `getItemLayout` is absent; used for scrollToOffset fallbacks. */
const UP_NEXT_FALLBACK_ITEM_HEIGHT = 200;

/**
 * expo-av: widen `onPlaybackStatusUpdate` spacing — handlers only need completion edges.
 * Default (~500ms iOS) progress ticks add JS work and contribute to Now Playing metadata churn.
 */
const EXPO_AV_PROGRESS_INTERVAL_MS = 60_000;
const STATIC_BLUR_INTENSITY = 20;

/** Documentary stall recovery: advance a chapter if no media progresses for this long. */
const CHAPTER_STALL_MS = 8_000;
const CHAPTER_WATCHDOG_TICK_MS = 1_000;

/** Video keeps playing during like feedback; volume ducks so like TTS stays intelligible. */
const LIKE_FEEDBACK_VIDEO_DUCK_VOLUME = 0.2;
const STAGE_VIDEO_FULL_VOLUME = 1;
/** Short pause before resuming caption/deep-dive narration interrupted by like TTS. */
const LIKE_FEEDBACK_NARRATION_RESUME_BREATH_MS = 350;

let lastVideoAudioSessionRefreshAt = 0;

type StageVideoPlayer = {
  volume?: number;
  muted?: boolean;
};

function normalizeRestoredVideoVolume(previousVolume: number | null | undefined): number {
  if (typeof previousVolume !== 'number' || Number.isNaN(previousVolume)) {
    return STAGE_VIDEO_FULL_VOLUME;
  }
  if (previousVolume <= LIKE_FEEDBACK_VIDEO_DUCK_VOLUME + 0.05) {
    return STAGE_VIDEO_FULL_VOLUME;
  }
  return previousVolume;
}

function applyStageVideoAudible(player: StageVideoPlayer | null | undefined): void {
  if (!player) return;
  try {
    player.muted = false;
    player.volume = STAGE_VIDEO_FULL_VOLUME;
  } catch {
    // player may be tearing down
  }
}

/** Re-apply audio session after expo-av (chime, like TTS) so expo-video regains output. */
export async function refreshExplorerAudioSessionForVideo(): Promise<void> {
  const now = Date.now();
  if (now - lastVideoAudioSessionRefreshAt < 350) return;
  lastVideoAudioSessionRefreshAt = now;
  try {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      shouldDuckAndroid: true,
      staysActiveInBackground: true,
      playThroughEarpieceAndroid: false,
      interruptionModeIOS: InterruptionModeIOS.DoNotMix,
      interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
    });
  } catch (err) {
    console.warn('Reflections: refreshExplorerAudioSessionForVideo failed:', err);
  }
}

type LikePauseSnapshot = {
  /** Prior player.volume when video was ducked for like TTS; null if video was not playing. */
  videoVolumeBeforeDuck: number | null;
  captionSoundPaused: boolean;
  deepDiveSoundPaused: boolean;
  speechWasActive: boolean;
  speechResumeText: string | null;
  speechResumeKind: 'caption' | 'deep_dive' | null;
};

type StageVideoViewProps = {
  player: React.ComponentProps<typeof VideoView>['player'];
  sourceKey: string;
};

function getVideoPlayerId(player: StageVideoViewProps['player']): string | number | undefined {
  const id = (player as { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

const StableStageVideoView = React.memo(function StableStageVideoView({ player }: StageVideoViewProps) {
  return (
    <VideoView
      player={player}
      style={StyleSheet.absoluteFill}
      nativeControls={false}
      contentFit="contain"
      allowsFullscreen={false}
      allowsPictureInPicture={false}
    />
  );
}, (prev, next) => {
  const prevId = getVideoPlayerId(prev.player);
  const nextId = getVideoPlayerId(next.player);
  const samePlayer = prevId !== undefined || nextId !== undefined
    ? prevId === nextId
    : prev.player === next.player;

  // The native player receives source changes through `player.replace()`. Re-rendering
  // VideoView for the same player only re-sends identical native props on the main queue.
  return samePlayer;
});

const StableNarrationVideoView = React.memo(function StableNarrationVideoView({
  player,
}: {
  player: React.ComponentProps<typeof VideoView>['player'];
}) {
  return (
    <VideoView
      player={player}
      style={styles.narrationPipVideo}
      contentFit="cover"
      nativeControls={false}
      allowsFullscreen={false}
    />
  );
}, (prev, next) => {
  const prevId = getVideoPlayerId(prev.player);
  const nextId = getVideoPlayerId(next.player);
  return prevId !== undefined || nextId !== undefined
    ? prevId === nextId
    : prev.player === next.player;
});

function displayCaptionFrom(meta: EventMetadata | null | undefined, event: Event | null | undefined): string {
  const mCap = trimMeta(meta?.short_caption) || trimMeta(meta?.description);
  const emb = event?.metadata;
  const e = emb && typeof emb === 'object' ? (emb as Partial<EventMetadata>) : null;
  const eCap = e ? trimMeta(e.short_caption) || trimMeta(e.description) : '';
  if (eCap && (!mCap || isGenericReflectionCaption(mCap))) {
    return trimMeta(e?.short_caption) || eCap || trimMeta(e?.description) || eCap;
  }
  if (mCap) return mCap;
  if (eCap) return eCap;
  return 'Reflection';
}

interface MainStageProps {
  visible: boolean;
  selectedEvent: Event | null;
  startIdleOnInitialSelection?: boolean;
  events: Event[];
  eventMetadata: { [key: string]: EventMetadata };
  likedBy?: string[];
  reflectionLikes?: Record<string, string[]>;
  currentUserId?: string | null;
  companions?: CompanionAvatar[];
  onToggleLike?: (eventId: string, userId: string, isAdd: boolean) => void;
  onClose: () => void;
  onEventSelect: (event: Event) => void;
  onDelete: (event: Event) => void;
  onMediaError?: (event: Event) => void;
  readEventIds: string[];
  newArrivalIds: string[]; // Unread reflections visible in the list (derived, not session state)
  onReplay?: (event: Event) => void;
  config?: {
    autoplay?: boolean;
    loopFeed?: boolean;
    showStartMarker?: boolean;
    playVideoCaptions?: boolean;
    enableInfiniteScroll?: boolean;
    instantVideoPlayback?: boolean;
    readVideoCaptions?: boolean;
    autoPlayDeepDive?: boolean;
  };
  filterBar?: React.ReactNode;
  /** Shown in the header as "{name}'s Reflections" when multiple items exist. */
  explorerDisplayName?: string | null;
  /** Needed to resolve fresh media URLs for Bring-It-to-Life narration bundles. */
  explorerId?: string | null;
  /** Reaction Events keyed by parent event_id; used to build documentary chapters. */
  reactionsByParentId?: Map<string, Event[]>;
  /** Firestore reaction docs keyed at render time for non-playable ribbon fallbacks. */
  reactionSignals?: ReactionSignal[];
}

export default function MainStageView({
  visible,
  selectedEvent,
  startIdleOnInitialSelection = false,
  events,
  eventMetadata,
  likedBy = [],
  reflectionLikes = {},
  currentUserId,
  companions = [],
  onToggleLike,
  onClose,
  onEventSelect,
  onDelete,
  onMediaError,
  readEventIds,
  newArrivalIds,
  onReplay,
  config,
  filterBar,
  explorerDisplayName,
  explorerId,
  reactionsByParentId,
  reactionSignals = [],
}: MainStageProps) {
  // Perf: keep console logging opt-in; excessive logs + JSON.stringify can jank Hermes.
  const DEBUG_TRANSITIONS = __DEV__ && false;
  const DEBUG_LOGS = __DEV__ && false;
  const debugLog = (...args: any[]) => {
    if (DEBUG_LOGS) console.log(...args);
  };
  // Documentary diagnostics. In development they print to the Metro console; in every build
  // they are also recorded as Sentry breadcrumbs (cheap in-memory ring buffer, auto-capped),
  // so a frenetic Explorer's exact Reflection/reaction sequence is attached to any field error
  // report. This is the One Trail that lets us debug Cole's device without a debug overlay.
  const traceDocumentary = useCallback((label: string, data?: Record<string, unknown>) => {
    const suffix = data
      ? ` ${Object.entries(data)
        .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
        .join(' ')}`
      : '';
    const message = `${label}${suffix}`;
    Sentry.addBreadcrumb({ category: 'documentary', message, level: 'info' });
    if (__DEV__) console.log(`[DOC-DIAG] ${message}`);
  }, []);

  useEffect(() => {
    ensureExplorerAudioSessionOnce();
  }, []);

  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const insets = useSafeAreaInsets();
  const router = useRouter();


  // --- LOCAL STATE (Visuals Only) ---
  // Reanimated shared values
  const controlsOpacity = useSharedValue(0); // 0 = Hidden
  const audioIndicatorAnim = useSharedValue(0.7);
  const tellMeMorePulse = useSharedValue(1);
  const tellMeMoreBlurOpacity = useSharedValue(1);
  const heartScale = useSharedValue(1);

  // Swipe-to-minimize shared values
  const translateY = useSharedValue(0);
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);

  const flatListRef = useRef<FlatList>(null);

  // Track if the video has actually buffered and started rendering
  const [videoReady, setVideoReady] = useState(false);

  // Need to track video playing for VU meter
  const [isVideoPlaying, setIsVideoPlaying] = useState(false);

  // --- AUDIO/VIDEO REFS ---
  const [sound, setSound] = useState<Audio.Sound | null>(null); // Voice messages
  const [captionSound, setCaptionSound] = useState<Audio.Sound | null>(null); // Companion audio captions

  // Track caption sound in ref to handle race condition with stopAllMedia
  const captionSoundRef = useRef<Audio.Sound | null>(null);

  // Toast state
  const [toastMessage, setToastMessage] = useState<string>('');
  const [showLikeFaces, setShowLikeFaces] = useState(false);
  const [likeFacesLikedBy, setLikeFacesLikedBy] = useState<string[] | null>(null);

  // Track when caption OR sparkle (Tell Me More) is playing - disable both buttons to prevent impatient multiple taps
  const [isCaptionOrSparklePlaying, setIsCaptionOrSparklePlaying] = useState(false);

  // True while the co-host breath timer is active (hides replay button during breath)
  const [isDeepDivePending, setIsDeepDivePending] = useState(false);
  const [chapterPlaybackPulseKey, setChapterPlaybackPulseKey] = useState(0);
  // Resolved playable video URLs for selfie reaction chapters, keyed by event_id. Selfie
  // reaction list Events frequently lack a top-level video_url (presigned URLs expire), so we
  // pre-resolve them via GET_EVENT_BUNDLE. These URLs are injected into the machine event so
  // reactions route to video playback instead of the photo/selfie path.
  const [reactionVideoUrlMap, setReactionVideoUrlMap] = useState<Record<string, string>>({});
  const setIsCaptionOrSparklePlayingRef = useRef<(v: boolean) => void>(() => { });
  useEffect(() => {
    setIsCaptionOrSparklePlayingRef.current = setIsCaptionOrSparklePlaying;
  }, []);

  useEffect(() => {
    tellMeMoreBlurOpacity.value = withTiming(isCaptionOrSparklePlaying ? 0.56 : 1, { duration: 150 });
  }, [isCaptionOrSparklePlaying, tellMeMoreBlurOpacity]);

  // Prefer merged Firestore/list map; fall back to embedded Event.metadata or a minimal
  // bundle so play / narration / refs never stall when the map is briefly empty (OTA timing).
  const selectedMetadata = useMemo((): EventMetadata | null => {
    if (!selectedEvent) return null;
    const fromMap = eventMetadata[selectedEvent.event_id];
    if (fromMap) {
      let merged: EventMetadata = fromMap;
      const emb = selectedEvent.metadata;
      if (emb && typeof emb === 'object') {
        const e = emb as Partial<EventMetadata>;
        const mapCap = trimMeta(fromMap.short_caption) || trimMeta(fromMap.description);
        const embCap = trimMeta(e.short_caption) || trimMeta(e.description);
        if (embCap && (!mapCap || isGenericReflectionCaption(mapCap))) {
          merged = {
            ...fromMap,
            short_caption: trimMeta(fromMap.short_caption) || trimMeta(e.short_caption) || embCap,
            description: trimMeta(fromMap.description) || trimMeta(e.description) || embCap,
          };
        }
        const mapTrimActive = getCloudMasterTrimWindow(merged).active;
        const embTrim = getValidVideoTrimMs(e as EventMetadata);
        if (!mapTrimActive && embTrim) {
          const embThumb = coerceThumbnailTimeMs(e.thumbnail_time_ms);
          merged = {
            ...merged,
            video_start_ms: embTrim.startMs,
            video_end_ms: embTrim.endMs,
            ...(embThumb !== undefined ? { thumbnail_time_ms: embThumb } : {}),
          };
        }
      }
      return merged;
    }

    const embedded = selectedEvent.metadata;
    if (embedded && typeof embedded === 'object') {
      const m = embedded as Partial<EventMetadata> & Record<string, unknown>;
      const desc =
        typeof m.description === 'string' && m.description.trim()
          ? m.description.trim()
          : typeof m.short_caption === 'string' && m.short_caption.trim()
            ? m.short_caption.trim()
            : '';
      const short =
        typeof m.short_caption === 'string' && m.short_caption.trim()
          ? m.short_caption.trim()
          : typeof m.description === 'string' && m.description.trim()
            ? m.description.trim()
            : '';
      const primary = short || desc || 'Reflection';
      const embeddedTrim = getValidVideoTrimMs(m as EventMetadata);
      const embeddedThumb = coerceThumbnailTimeMs(m.thumbnail_time_ms);
      return {
        event_id: typeof m.event_id === 'string' && m.event_id ? m.event_id : selectedEvent.event_id,
        description: desc || primary,
        short_caption: short || primary,
        sender: typeof m.sender === 'string' && m.sender.trim() ? m.sender.trim() : 'Companion',
        timestamp:
          typeof m.timestamp === 'string' && m.timestamp
            ? m.timestamp
            : new Date().toISOString(),
        ...(typeof m.sender_id === 'string' ? { sender_id: m.sender_id } : {}),
        ...(m.content_type === 'text' || m.content_type === 'audio' || m.content_type === 'video'
          ? { content_type: m.content_type }
          : {}),
        ...(m.image_source === 'camera' || m.image_source === 'search' || m.image_source === 'gallery'
          ? { image_source: m.image_source }
          : {}),
        ...(typeof m.deep_dive === 'string' ? { deep_dive: m.deep_dive } : {}),
        ...(typeof m.deep_dive_audio_url === 'string' ? { deep_dive_audio_url: m.deep_dive_audio_url } : {}),
        ...(embeddedTrim
          ? { video_start_ms: embeddedTrim.startMs, video_end_ms: embeddedTrim.endMs }
          : {}),
        ...(embeddedThumb !== undefined ? { thumbnail_time_ms: embeddedThumb } : {}),
      };
    }

    return {
      event_id: selectedEvent.event_id,
      description: 'Reflection',
      short_caption: 'Reflection',
      sender: 'Companion',
      timestamp: new Date().toISOString(),
      ...(selectedEvent.video_url ? { content_type: 'video' as const } : {}),
      ...(!selectedEvent.video_url && selectedEvent.audio_url ? { content_type: 'audio' as const } : {}),
    };
  }, [selectedEvent, eventMetadata]);

  const likedByCurrentUser = !!currentUserId && likedBy.includes(currentUserId);
  const likeCount = likedBy.length;
  const displayedLikeFaces = likeFacesLikedBy ?? likedBy;
  const likerFaces = useMemo(() => {
    return displayedLikeFaces.map((uid) => {
      const companion = companions.find((c) => c.userId === uid);
      const fallbackName = uid === currentUserId ? explorerDisplayName || 'Explorer' : 'Explorer';
      return {
        uid,
        avatarUrl: companion?.avatarUrl ?? null,
        initial: (companion?.initial ?? fallbackName.trim().charAt(0).toUpperCase()) || '?',
        color: companion?.color ?? '#4FC3F7',
        isCaregiver: !!companion?.isCaregiver,
      };
    });
  }, [companions, currentUserId, displayedLikeFaces, explorerDisplayName]);

  const { bursts: likeHeartBursts, spawnBurst, clearBursts, removeBurst } = useLikeHeartBursts();
  const likeCooldownByEventRef = useRef<Record<string, number>>({});
  const mediaFrameLayoutRef = useRef({ width: 0, height: 0 });
  const likePauseSnapshotRef = useRef<LikePauseSnapshot | null>(null);
  const likeVideoDuckActiveRef = useRef(false);
  const likeFeedbackResumeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pauseForLikeFeedbackRef = useRef<() => Promise<void>>(async () => {});
  const resumeAfterLikeFeedbackRef = useRef<() => Promise<void>>(async () => {});
  const abortLikeFeedbackForNavigationRef = useRef<() => void>(() => {});

  /** Heart + like TTS; Firestore write only when not already liked. Runs on every double-tap. */
  const runLikeFeedbackAtPoint = useCallback((x: number, y: number) => {
    if (!selectedEvent?.event_id) return;

    // Always celebrate a recognized double-tap (Instagram-style), even during TTS cooldown.
    spawnBurst(x, y);

    const eventId = selectedEvent.event_id;
    const lastTriggeredAt = likeCooldownByEventRef.current[eventId];
    if (isLikeFeedbackInCooldown(lastTriggeredAt)) {
      return;
    }
    likeCooldownByEventRef.current[eventId] = Date.now();

    // Commit like before audio so navigation can kill TTS without losing the write.
    if (!likedByCurrentUser && currentUserId && onToggleLike) {
      onToggleLike(eventId, currentUserId, true);
    }

    ensureExplorerAudioSessionOnce();
    const mediaKind = getLikeFeedbackMediaKind(!!selectedEvent?.video_url);
    const phrase = buildLikeFeedbackPhrase(selectedMetadata?.sender, mediaKind);
    void playLikeFeedbackAudio(phrase, {
      onBeforePlay: () => pauseForLikeFeedbackRef.current(),
      onAfterPlay: () => resumeAfterLikeFeedbackRef.current(),
    });
  }, [
    currentUserId,
    likedByCurrentUser,
    onToggleLike,
    selectedEvent?.event_id,
    selectedEvent?.video_url,
    selectedMetadata?.sender,
    spawnBurst,
  ]);

  const runLikeFeedbackCentered = useCallback(() => {
    const { width, height } = mediaFrameLayoutRef.current;
    const x = width > 0 ? width / 2 : 0;
    const y = height > 0 ? height / 2 : 0;
    runLikeFeedbackAtPoint(x, y);
  }, [runLikeFeedbackAtPoint]);

  const handleLikePress = useCallback(() => {
    if (!selectedEvent?.event_id || !currentUserId || !onToggleLike) {
      return;
    }
    heartScale.value = withSpring(1.28, { damping: 8, stiffness: 260 }, () => {
      heartScale.value = withSpring(1, { damping: 10, stiffness: 240 });
    });
    if (likedByCurrentUser) {
      onToggleLike(selectedEvent.event_id, currentUserId, false);
      return;
    }
    runLikeFeedbackCentered();
  }, [
    currentUserId,
    heartScale,
    likedByCurrentUser,
    onToggleLike,
    selectedEvent?.event_id,
    runLikeFeedbackCentered,
  ]);

  const positionText = useMemo(() => {
    if (!selectedEvent || events.length === 0) return '';
    const idx = events.findIndex(e => e.event_id === selectedEvent.event_id);
    if (idx === -1) return '';
    return `${idx + 1} of ${events.length}`;
  }, [events, selectedEvent?.event_id]);

  // Track previous event to prevent restart loops
  const prevEventIdRef = useRef<string | null>(null);
  const lastVideoFinishedEventIdRef = useRef<string | null>(null);
  const videoFinishHandledForEventRef = useRef<string | null>(null);
  const hasConsumedInitialIdleSelectionRef = useRef(false);

  // Co-Host: track whether deep dive has already auto-played for the current reflection
  const hasAutoPlayedDeepDiveRef = useRef(false);
  const deepDiveBreathTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track active caption session to prevent ghost TTS callbacks
  const captionSessionRef = useRef(0);

  const [isAdminMode, setIsAdminMode] = useState(false);
  const [showAdminChallenge, setShowAdminChallenge] = useState(false);
  const [adminAnswer, setAdminAnswer] = useState('');
  const [mathChallenge, setMathChallenge] = useState({ a: 3, b: 3, sum: 6 });
  const safetyTimeoutRef = useRef<any>(null);

  // --- STABILITY REFS (Anti-stale closure) ---
  const eventsRef = useRef(events);
  const selectedEventRef = useRef(selectedEvent);
  const stateRef = useRef<any>(null);
  const onEventSelectRef = useRef(onEventSelect);
  const onDeleteRef = useRef(onDelete);
  const onReplayRef = useRef(onReplay);
  const selectedMetadataRef = useRef(selectedMetadata);
  const configRef = useRef(config);
  configRef.current = config;

  // Bridge pattern refs for machine actions
  const sendRef = useRef<any>(() => { });
  const soundRef = useRef<Audio.Sound | null>(null);
  const playerRef = useRef<any>(null);
  const ensureStageVideoAudibleRef = useRef<(player?: StageVideoPlayer | null) => Promise<void>>(
    async () => {}
  );
  const captionSoundRefForActions = useRef<Audio.Sound | null>(null);
  const clearHeavyMediaRefsRef = useRef<() => void>(() => { });

  // Bring It to Life — resolved narration take for the selected photo, the
  // corner PIP player, and the bridge used by the speakCaption machine action.
  const narrationPlaybackRef = useRef<{ parentEventId: string; videoUrl: string } | null>(null);
  const narrationPlayerRef = useRef<any>(null);
  const narrationEndSubRef = useRef<{ remove: () => void } | null>(null);
  const playNarrationPipRef = useRef<(session: number) => Promise<boolean>>(async () => false);

  // Documentary reaction PiP — parent stays on main stage; reaction plays in the corner.
  const reactionPipPlayerRef = useRef<any>(null);
  const reactionPipEndSubRef = useRef<{ remove: () => void } | null>(null);
  const documentarySelfieStartedForEventRef = useRef<string | null>(null);
  const companionMessageVideoStartedForEventRef = useRef<string | null>(null);
  const reactionVideoUrlMapRef = useRef<Record<string, string>>({});
  // event_id of a reaction we've already tried to recover once after a PiP load error.
  const reactionPipErrorRetriedRef = useRef<string | null>(null);
  // event_id of a reaction whose PiP clip has finished — prevents the play-retry listener
  // from restarting a clip that already reached its end (it parks paused on the last frame).
  const reactionEndedForEventRef = useRef<string | null>(null);
  // Image documentaries speak the parent caption before reactions, then only the Deep Dive at end.
  const parentImageCaptionPlayedForEventRef = useRef<string | null>(null);
  // True once we've handled the machine's `finished` state for the current chapter. Reset on
  // Reflection change AND on replay (where the selected Reflection id does not change).
  const wasFinishedRef = useRef(false);
  const mainFinishIgnoredForReactionRef = useRef<string | null>(null);
  const documentaryCompleteHandledRef = useRef<string | null>(null);
  const chapterPlaybackPulseIndexRef = useRef<number | null>(null);
  // True when the selected Reflection has reactions (chapters.length > 1). When true we
  // defer the spoken caption + Deep Dive until the whole documentary ends, so Cole reaches
  // the reactions quickly instead of sitting through two narrations up front.
  const documentaryHasReactionsRef = useRef(false);
  // Guards the end-of-documentary narration so a navigation/selection change cancels it.
  const endNarrationTokenRef = useRef(0);
  const playEndNarrationRef = useRef<() => void>(() => {});
  // Watchdog heartbeat: updated whenever the main player or reaction PiP reports playback
  // progress, or a chapter advances. The watchdog recovers a chapter only if NO media has
  // made progress for CHAPTER_STALL_MS (e.g. a reaction whose video URL never resolved).
  const lastChapterProgressAtRef = useRef(0);
  // Mirrors docState.phase for use inside non-reactive player effects.
  const documentaryPhaseRef = useRef<'idle' | 'playing' | 'complete'>('idle');
  const playbackEventRef = useRef<Event | null>(null);
  const playbackMetadataRef = useRef<EventMetadata | null>(null);
  const startCompanionMessageParentVideoRef = useRef<() => Promise<void>>(async () => {});
  const documentaryReactionRef = useRef({
    active: false,
    reactionType: null as ReturnType<typeof resolveReactionPlaybackType> | null,
    usesCompanionAvatarPip: false,
    selfieUsesParentVideo: false,
    selfieUsesParentImage: false,
    companionMessageUsesParentVideo: false,
    reactionEvent: null as Event | null,
    parentEvent: null as Event | null,
  });

  // --- THE XSTATE MACHINE ---
  const machine = useMemo(() => playerMachine.provide({
    actions: {
      stopAllMedia: async () => {
        abortLikeFeedbackForNavigationRef.current();

        // Increment session IMMEDIATELY and SYNCHRONOUSLY to invalidate any pending Narration/TTS
        captionSessionRef.current += 1;
        const thisStopSession = captionSessionRef.current;
        debugLog(`🛑 stopAllMedia [Session: ${thisStopSession}]`);

        // Clear any existing safety timers
        if (safetyTimeoutRef.current) {
          clearTimeout(safetyTimeoutRef.current);
          safetyTimeoutRef.current = null;
        }

        // Stop TTS immediately and forcefully
        Speech.stop();

        // Stop voice message audio
        const soundToUnload = soundRef.current;
        soundRef.current = null;
        setSound(null); // Clear state immediately to prevent race conditions
        if (soundToUnload) {
          try {
            const status = await soundToUnload.getStatusAsync();
            if (status.isLoaded) {
              await soundToUnload.stopAsync();
              await soundToUnload.unloadAsync();
            }
          } catch (e) {
            // Ignore errors - sound may already be unloaded
            debugLog('Sound already unloaded or error:', (e as Error).message);
          }
        }

        // Stop companion caption audio
        const soundToStop = captionSoundRefForActions.current || captionSoundRef.current;
        if (soundToStop) {
          try {
            const status = await soundToStop.getStatusAsync();
            if (status.isLoaded) {
              await soundToStop.stopAsync();
              await soundToStop.unloadAsync();
            }
          } catch (e) {
            console.error('Error stopping caption:', e);
          }
          captionSoundRef.current = null;
          captionSoundRefForActions.current = null;
          setCaptionSound(null);
        }

        if (playerRef.current) {
          try {
            playerRef.current.pause();
            const trim = getCloudMasterTrimWindow(selectedMetadataRef.current);
            seekVideoToSeconds(playerRef.current, trim.active ? trim.startSec : 0);
          } catch (err) {
            console.warn('Silent failure stopping player:', err);
          }
        }

        // Stop Bring-It-to-Life narration PIP
        if (narrationEndSubRef.current) {
          narrationEndSubRef.current.remove();
          narrationEndSubRef.current = null;
        }
        if (narrationPlayerRef.current) {
          try {
            narrationPlayerRef.current.pause();
          } catch {
            /* player may be tearing down */
          }
        }

        if (reactionPipEndSubRef.current) {
          reactionPipEndSubRef.current.remove();
          reactionPipEndSubRef.current = null;
        }
        if (reactionPipPlayerRef.current) {
          try {
            reactionPipPlayerRef.current.pause();
          } catch {
            /* player may be tearing down */
          }
        }
        documentarySelfieStartedForEventRef.current = null;
        companionMessageVideoStartedForEventRef.current = null;
        controlsOpacity.value = withTiming(0, { duration: 300 });

        // Clear caption/sparkle playing state
        setIsCaptionOrSparklePlayingRef.current(false);

        // Small delay to ensure everything stops
        await new Promise(resolve => setTimeout(resolve, 100));
      },

      speakCaption: async () => {
        // Documentary reaction chapters: no spoken caption — advance immediately.
        if (documentaryReactionRef.current.active) {
          debugLog('🎙️ speakCaption skipped — documentary reaction chapter');
          sendRef.current({ type: 'NARRATION_FINISHED' });
          return;
        }

        const captionEvent = playbackEventRef.current ?? selectedEventRef.current;

        // Multi-chapter VIDEO documentaries: defer the original Reflection's caption until
        // the whole documentary ends so Cole reaches the reactions quickly.
        // Multi-chapter IMAGE documentaries are different: show the image and speak the
        // caption FIRST, then reactions, then the Deep Dive at the end.
        if (documentaryHasReactionsRef.current && !!captionEvent?.video_url) {
          debugLog('🎙️ speakCaption deferred for video documentary — caption plays after documentary ends');
          sendRef.current({ type: 'NARRATION_FINISHED' });
          return;
        }

        const meta = playbackMetadataRef.current ?? selectedMetadataRef.current;
        const text = trimMeta(meta?.short_caption) || trimMeta(meta?.description);
        const audioUrl = captionEvent?.audio_url;

        // Use current session (already incremented by stopAllMedia or initial)
        const thisSession = captionSessionRef.current;
        debugLog(`🎙️ speakCaption [Session: ${thisSession}]`);

        controlsOpacity.value = withTiming(0, { duration: 300 });

        // Bring It to Life: when a photo carries a selfie narration, the
        // narration IS the spoken caption — play the PIP video instead of
        // caption audio/TTS. Falls through to the normal path if the
        // narration can't be loaded.
        const expectsNarration =
          !documentaryReactionRef.current.active &&
          !playbackEventRef.current?.video_url &&
          (selectedMetadataRef.current?.has_narration === true ||
            !!selectedMetadataRef.current?.narration_event_id ||
            selectedEventRef.current?.has_narration === true ||
            !!selectedEventRef.current?.narration_event_id);
        if (expectsNarration) {
          const played = await playNarrationPipRef.current(thisSession);
          if (played || captionSessionRef.current !== thisSession) return;
          debugLog('⚠️ Narration unavailable — falling back to caption audio');
        }

        if (audioUrl) {
          const playAudioWithRetry = async (retryCount = 0): Promise<void> => {
            try {
              debugLog(`🎧 Loading narration [Session: ${thisSession}] (Attempt ${retryCount + 1}): ${audioUrl.substring(0, 50)}...`);

              const { sound: newCaptionSound, status } = await Audio.Sound.createAsync(
                { uri: audioUrl },
                {
                  shouldPlay: false,
                  progressUpdateIntervalMillis: EXPO_AV_PROGRESS_INTERVAL_MS,
                },
                (status) => {
                  if (status.isLoaded && !status.isPlaying && status.didJustFinish) {
                    if (captionSessionRef.current === thisSession) {
                      if (safetyTimeoutRef.current) {
                        clearTimeout(safetyTimeoutRef.current);
                        safetyTimeoutRef.current = null;
                      }
                      newCaptionSound.unloadAsync();
                      setCaptionSound(null);
                      captionSoundRef.current = null;
                      debugLog(`✅ Narration finished [Session: ${thisSession}] - sending NARRATION_FINISHED`);
                      sendRef.current({ type: 'NARRATION_FINISHED' });
                    } else {
                      debugLog(`🚫 Narration finished but session changed [${thisSession} vs ${captionSessionRef.current}] - cleaning up`);
                      newCaptionSound.unloadAsync();
                      captionSoundRef.current = null;
                    }
                  }
                }
              );

              // CHECK SESSION AGAIN after load completes
              if (captionSessionRef.current !== thisSession) {
                debugLog(`🚫 Session changed during narration load [${thisSession} vs ${captionSessionRef.current}] - discarding`);
                newCaptionSound.unloadAsync();
                return;
              }

              captionSoundRef.current = newCaptionSound;
              captionSoundRefForActions.current = newCaptionSound;
              setCaptionSound(newCaptionSound);

              await newCaptionSound.playAsync();
              debugLog(`🎧 Narration playing [Session: ${thisSession}]`);

              // Smart Fallback based on actual duration
              const duration = (status as any).durationMillis || 5000;
              const safetyTimeout = duration + 2500; // Small buffer

              safetyTimeoutRef.current = setTimeout(() => {
                if (captionSessionRef.current === thisSession) {
                  console.warn(`⚠️ Narration safety fallback triggered [Session: ${thisSession}]`);
                  safetyTimeoutRef.current = null;
                  sendRef.current({ type: 'NARRATION_FINISHED' });
                }
              }, safetyTimeout);

            } catch (error: any) {
              console.error(`❌ Audio caption error (Attempt ${retryCount + 1}):`, error);
              if (retryCount < 1 && captionSessionRef.current === thisSession) {
                await new Promise(r => setTimeout(r, 1500));
                return playAudioWithRetry(retryCount + 1);
              }
              if (captionSessionRef.current === thisSession) {
                sendRef.current({ type: 'NARRATION_FINISHED' });
              }
            }
          };
          playAudioWithRetry();
        } else if (text) {
          Speech.speak(text, {
            onDone: () => {
              if (captionSessionRef.current === thisSession) {
                if (safetyTimeoutRef.current) {
                  clearTimeout(safetyTimeoutRef.current);
                  safetyTimeoutRef.current = null;
                }
                debugLog('✅ TTS finished - sending NARRATION_FINISHED');
                sendRef.current({ type: 'NARRATION_FINISHED' });
              }
            },
            onError: () => {
              if (captionSessionRef.current === thisSession) {
                if (safetyTimeoutRef.current) {
                  clearTimeout(safetyTimeoutRef.current);
                  safetyTimeoutRef.current = null;
                }
                sendRef.current({ type: 'NARRATION_FINISHED' });
              }
            }
          });

          // TTS Fallback
          safetyTimeoutRef.current = setTimeout(() => {
            if (captionSessionRef.current === thisSession) {
              console.warn('⚠️ TTS safety fallback triggered');
              safetyTimeoutRef.current = null;
              sendRef.current({ type: 'NARRATION_FINISHED' });
            }
          }, 15000);
        } else {
          if (captionSessionRef.current === thisSession) {
            sendRef.current({ type: 'NARRATION_FINISHED' });
          }
        }
      },

      playVideo: async () => {
        if (!playerRef.current) return;

        videoFinishHandledForEventRef.current = null;

        const docReaction = documentaryReactionRef.current;
        if (docReaction.active && docReaction.reactionType === 'selfie') {
          // Selfie reaction playback is driven by the persistent reaction-PiP effect
          // (ReplayModal pattern): it retries play() on every `readyToPlay` event, which
          // is reliable across chapters where a one-shot play() races source loading.
          return;
        }
        if (docReaction.active && docReaction.usesCompanionAvatarPip) {
          return;
        }

        debugLog(`🎬 playVideo called: status=${playerRef.current.status}`);

        const trim = getCloudMasterTrimWindow(selectedMetadataRef.current);
        seekVideoToSeconds(playerRef.current, trim.active ? trim.startSec : 0);
      },

      playAudio: async () => {
        const playWithRetry = async (retryCount = 0): Promise<void> => {
          try {
            if (soundRef.current) await soundRef.current.unloadAsync();

            const audioEvent = playbackEventRef.current ?? selectedEventRef.current;
            if (!audioEvent?.audio_url) {
              sendRef.current({ type: 'AUDIO_FINISHED' });
              return;
            }

            if (documentaryReactionRef.current.companionMessageUsesParentVideo) {
              void startCompanionMessageParentVideoRef.current();
            }

            debugLog(`🎧 Playing audio: ${audioEvent.audio_url.substring(0, 80)}... (Attempt ${retryCount + 1})`);
            const { sound: newSound } = await Audio.Sound.createAsync(
              { uri: audioEvent.audio_url as string },
              {
                shouldPlay: true,
                progressUpdateIntervalMillis: EXPO_AV_PROGRESS_INTERVAL_MS,
              }
            );

            newSound.setOnPlaybackStatusUpdate((status) => {
              if (status.isLoaded && status.didJustFinish) {
                if (documentaryReactionRef.current.companionMessageUsesParentVideo && playerRef.current) {
                  try {
                    playerRef.current.pause();
                  } catch {
                    /* player may be tearing down */
                  }
                }
                sendRef.current({ type: 'AUDIO_FINISHED' });
              }
            });
            soundRef.current = newSound;
            setSound(newSound);

          } catch (err: any) {
            console.error(`❌ Audio error (Attempt ${retryCount + 1}):`, err);

            if (retryCount < 1) {
              debugLog('🔄 Retrying audio load in 1.5s...');
              await new Promise(r => setTimeout(r, 1500));
              return playWithRetry(retryCount + 1);
            }

            if (err && typeof err === 'object') {
              console.error("❌ Detailed Audio Error:", {
                message: err.message,
                code: err.code,
                domain: err.domain
              });
            }
            sendRef.current({ type: 'AUDIO_FINISHED' });
          }
        };

        playWithRetry();
      },

      playDeepDive: async () => {
        setIsCaptionOrSparklePlayingRef.current(true);

        // Stop any existing audio before playing deep dive
        Speech.stop();
        if (captionSoundRefForActions.current) {
          try {
            await captionSoundRefForActions.current.stopAsync();
            await captionSoundRefForActions.current.unloadAsync();
          } catch (e) {
            debugLog('Caption already stopped');
          }
          setCaptionSound(null);
          captionSoundRef.current = null;
          captionSoundRefForActions.current = null;
        }

        const playDeepDiveWithRetry = async (retryCount = 0): Promise<void> => {
          try {
            if (soundRef.current) await soundRef.current.unloadAsync();

            if (selectedEventRef.current?.deep_dive_audio_url) {
              debugLog(`🧠 Playing deep dive audio: ${selectedEventRef.current.deep_dive_audio_url.substring(0, 80)}... (Attempt ${retryCount + 1})`);
              const { sound: newSound, status } = await Audio.Sound.createAsync(
                { uri: selectedEventRef.current.deep_dive_audio_url },
                {
                  shouldPlay: true,
                  progressUpdateIntervalMillis: EXPO_AV_PROGRESS_INTERVAL_MS,
                }
              );
              newSound.setOnPlaybackStatusUpdate((status) => {
                if (status.isLoaded && status.didJustFinish) {
                  if (safetyTimeoutRef.current) {
                    clearTimeout(safetyTimeoutRef.current);
                    safetyTimeoutRef.current = null;
                  }
                  debugLog('✅ Deep dive audio finished - sending NARRATION_FINISHED');
                  setIsCaptionOrSparklePlayingRef.current(false);
                  sendRef.current({ type: 'NARRATION_FINISHED' });
                }
              });
              soundRef.current = newSound;
              setSound(newSound);

              // Smart Fallback for deep dive
              const duration = (status as any).durationMillis || 15000;
              const safetyTimeout = duration + 5000; // Extra generous buffer for deep dives

              if (safetyTimeoutRef.current) clearTimeout(safetyTimeoutRef.current);
              safetyTimeoutRef.current = setTimeout(() => {
                console.warn('⚠️ Deep dive safety timeout reached (Smart Fallback)');
                safetyTimeoutRef.current = null;
                setIsCaptionOrSparklePlayingRef.current(false);
                sendRef.current({ type: 'NARRATION_FINISHED' });
              }, safetyTimeout);

            } else if (selectedMetadataRef.current?.deep_dive) {
              Speech.speak(selectedMetadataRef.current.deep_dive, {
                onDone: () => {
                  if (safetyTimeoutRef.current) {
                    clearTimeout(safetyTimeoutRef.current);
                    safetyTimeoutRef.current = null;
                  }
                  setIsCaptionOrSparklePlayingRef.current(false);
                  sendRef.current({ type: 'NARRATION_FINISHED' });
                },
                onError: () => {
                  if (safetyTimeoutRef.current) {
                    clearTimeout(safetyTimeoutRef.current);
                    safetyTimeoutRef.current = null;
                  }
                  setIsCaptionOrSparklePlayingRef.current(false);
                  sendRef.current({ type: 'NARRATION_FINISHED' });
                }
              });

              // TTS Fallback - Deep dives are long, give it 60s
              if (safetyTimeoutRef.current) clearTimeout(safetyTimeoutRef.current);
              safetyTimeoutRef.current = setTimeout(() => {
                console.warn('⚠️ Deep dive TTS safety timeout reached');
                safetyTimeoutRef.current = null;
                setIsCaptionOrSparklePlayingRef.current(false);
                sendRef.current({ type: 'NARRATION_FINISHED' });
              }, 60000);
            } else {
              setIsCaptionOrSparklePlayingRef.current(false);
              sendRef.current({ type: 'NARRATION_FINISHED' });
            }
          } catch (err: any) {
            console.error(`❌ Deep dive audio error (Attempt ${retryCount + 1}):`, err);

            if (retryCount < 1 && selectedEventRef.current?.deep_dive_audio_url) {
              debugLog('🔄 Retrying deep dive audio load in 1.5s...');
              await new Promise(r => setTimeout(r, 1500));
              return playDeepDiveWithRetry(retryCount + 1);
            }

            if (err && typeof err === 'object') {
              console.error("❌ Detailed Deep Dive Error:", {
                message: err.message,
                code: err.code,
                domain: err.domain
              });
            }
            setIsCaptionOrSparklePlayingRef.current(false);
            sendRef.current({ type: 'NARRATION_FINISHED' });
          }
        };
        playDeepDiveWithRetry();
      },

      showSelfieBubble: () => {},
      triggerSelfie: async () => {},

      pauseMedia: async () => {
        if (playerRef.current && stateRef.current?.hasTag('video_mode')) {
          playerRef.current.pause();
        }
        if (reactionPipPlayerRef.current) {
          try {
            reactionPipPlayerRef.current.pause();
          } catch {
            /* ignore */
          }
        }
        if (soundRef.current) await soundRef.current.pauseAsync();
        if (captionSoundRefForActions.current) await captionSoundRefForActions.current.pauseAsync();
      },

      resumeMedia: async () => {
        if (playerRef.current && stateRef.current?.hasTag('video_mode')) {
          const trim = getCloudMasterTrimWindow(selectedMetadataRef.current);
          if (trim.active) {
            const t = playerRef.current.currentTime;
            if (t >= trim.endSec - 0.05 || t < trim.startSec - 0.05) {
              seekVideoToSeconds(playerRef.current, trim.startSec);
            }
          }
          playerRef.current.play();
        }
        if (soundRef.current) await soundRef.current.playAsync();
        if (captionSoundRefForActions.current) await captionSoundRefForActions.current.playAsync();
      }
    }
  }), []); // Empty deps - all values accessed via refs (bridge pattern)

  // Initialize the Hook
  const [state, send] = useMachine(machine);

  // --- DOCUMENTARY SEQUENCE ---
  const [docState, docActions] = useDocumentarySequence(
    selectedEvent,
    reactionsByParentId,
    eventMetadata,
    companions,
  );
  const reactionSignalsByParentId = useMemo(() => {
    const map = new Map<string, ReactionSignal[]>();
    for (const signal of reactionSignals) {
      const existing = map.get(signal.parentReflectionId) ?? [];
      existing.push(signal);
      map.set(signal.parentReflectionId, existing);
    }
    for (const [parentId, signals] of map) {
      signals.sort((a, b) => a.timestampMs - b.timestampMs);
      map.set(parentId, signals);
    }
    return map;
  }, [reactionSignals]);

  const narrationEventId = useMemo(() => {
    if (!selectedEvent || selectedEvent.video_url) return null;
    const explicitId = selectedMetadata?.narration_event_id ?? selectedEvent.narration_event_id ?? null;
    if (explicitId) return explicitId;
    const reactionNarration = reactionsByParentId
      ?.get(selectedEvent.event_id)
      ?.find((reaction) => reaction.isNarration === true);
    if (reactionNarration?.event_id) return reactionNarration.event_id;
    return (
      reactionSignalsByParentId
        .get(selectedEvent.event_id)
        ?.find((signal) => signal.isNarration)?.eventId ?? null
    );
  }, [selectedEvent, selectedMetadata?.narration_event_id, reactionsByParentId, reactionSignalsByParentId]);

  const selectedPlaybackEvent = useMemo((): Event | null => {
    if (!selectedEvent || !narrationEventId || selectedEvent.video_url) return selectedEvent;
    if (selectedEvent.has_narration === true && selectedEvent.narration_event_id === narrationEventId) {
      return selectedEvent;
    }
    return {
      ...selectedEvent,
      has_narration: true,
      narration_event_id: narrationEventId,
    };
  }, [selectedEvent, narrationEventId]);

  const selectedPlaybackMetadata = useMemo((): EventMetadata | null => {
    if (!selectedMetadata || !narrationEventId || selectedEvent?.video_url) return selectedMetadata;
    if (selectedMetadata.has_narration === true && selectedMetadata.narration_event_id === narrationEventId) {
      return selectedMetadata;
    }
    return {
      ...selectedMetadata,
      has_narration: true,
      narration_event_id: narrationEventId,
    };
  }, [selectedMetadata, narrationEventId, selectedEvent?.video_url]);

  const parentMediaEvent = docState.chapters[0]?.event ?? selectedEvent;
  const documentaryActiveChapter = docState.chapters[docState.currentIndex] ?? null;
  const isDocumentaryReactionChapter = !!documentaryActiveChapter?.isReaction;
  const documentaryReactionType = documentaryActiveChapter?.reactionType ?? null;
  const parentPipMedia = resolveReactionParentPipMedia(parentMediaEvent);
  const documentaryUsesCompanionAvatarPip =
    isDocumentaryReactionChapter &&
    documentaryReactionType != null &&
    shouldUseCompanionAvatarReactionPip(documentaryReactionType);
  const documentarySelfieUsesParentVideo =
    isDocumentaryReactionChapter &&
    documentaryReactionType === 'selfie' &&
    parentPipMedia?.mediaType === 'video';
  const documentarySelfieUsesParentImage =
    isDocumentaryReactionChapter &&
    documentaryReactionType === 'selfie' &&
    parentPipMedia?.mediaType === 'image';
  const documentaryCompanionMessageUsesParentVideo =
    documentaryUsesCompanionAvatarPip && parentPipMedia?.mediaType === 'video';

  useEffect(() => {
    documentaryReactionRef.current = {
      active: isDocumentaryReactionChapter,
      reactionType: documentaryReactionType,
      usesCompanionAvatarPip: documentaryUsesCompanionAvatarPip,
      selfieUsesParentVideo: documentarySelfieUsesParentVideo,
      selfieUsesParentImage: documentarySelfieUsesParentImage,
      companionMessageUsesParentVideo: documentaryCompanionMessageUsesParentVideo,
      reactionEvent: isDocumentaryReactionChapter ? documentaryActiveChapter!.event : null,
      parentEvent: parentMediaEvent,
    };
  }, [
    documentaryActiveChapter,
    documentaryCompanionMessageUsesParentVideo,
    documentaryReactionType,
    documentarySelfieUsesParentImage,
    documentarySelfieUsesParentVideo,
    documentaryUsesCompanionAvatarPip,
    isDocumentaryReactionChapter,
    parentMediaEvent,
  ]);

  const docActionsRef = useRef(docActions);
  const docStateRef = useRef(docState);
  const docCurrentIndexRef = useRef(docState.currentIndex);
  useEffect(() => {
    docStateRef.current = docState;
  }, [docState]);
  useEffect(() => {
    docCurrentIndexRef.current = docState.currentIndex;
  }, [docState.currentIndex]);
  useEffect(() => { docActionsRef.current = docActions; }, [docActions]);

  // Inject a pre-resolved playable video_url onto a selfie reaction event so the machine
  // routes it to video playback (playingVideoInstant) instead of the photo/selfie path.
  // Without this, reactions whose list Event lacks video_url land in viewingPhoto, which
  // stalls the documentary (and can trigger an unwanted selfie capture timeout).
  const withResolvedReactionUrl = useCallback((ev: Event): Event => {
    if (ev.video_url) return ev;
    const resolved = reactionVideoUrlMapRef.current[ev.event_id];
    return resolved ? { ...ev, video_url: resolved } : ev;
  }, []);

  // Stable send helpers for sequence transitions (avoid capturing stale closures)
  const sendSelectEventInstant = useCallback(
    (ev: Event, meta: EventMetadata) => {
      const resolvedEvent = withResolvedReactionUrl(ev);
      traceDocumentary('machine.send.SELECT_EVENT_INSTANT', {
        event: shortDiagId(ev.event_id),
        hasVideo: !!resolvedEvent.video_url,
        resolved: resolvedEvent.video_url !== ev.video_url,
        docPhase: docStateRef.current.phase,
        docIndex: docStateRef.current.currentIndex,
      });
      sendRef.current?.({
        type: 'SELECT_EVENT_INSTANT',
        event: resolvedEvent,
        metadata: meta,
        takeSelfie: false,
      });
    },
    [traceDocumentary, withResolvedReactionUrl],
  );

  const sendSelectEventForIndexing = useCallback(
    (ev: Event, meta: EventMetadata) => {
      const resolvedEvent = withResolvedReactionUrl(ev);
      traceDocumentary('machine.send.SELECT_EVENT_INSTANT.index', {
        event: shortDiagId(ev.event_id),
        hasVideo: !!resolvedEvent.video_url,
        resolved: resolvedEvent.video_url !== ev.video_url,
        docPhase: docStateRef.current.phase,
        docIndex: docStateRef.current.currentIndex,
      });
      sendRef.current?.({
        type: 'SELECT_EVENT_INSTANT',
        event: resolvedEvent,
        metadata: meta,
        takeSelfie: false,
      });
    },
    [traceDocumentary, withResolvedReactionUrl],
  );

  // Update all bridge refs
  useEffect(() => {
    sendRef.current = send;
    stateRef.current = state;
    soundRef.current = sound;
    captionSoundRefForActions.current = captionSound;
  }, [send, state, sound, captionSound]);

  /** Narration-only pause for likes: duck video audio, pause companion TTS/MP3s; video keeps playing. */
  const pauseAllMediaForLikeFeedback = useCallback(async () => {
    if (likePauseSnapshotRef.current) return;

    const snapshot: LikePauseSnapshot = {
      videoVolumeBeforeDuck: null,
      captionSoundPaused: false,
      deepDiveSoundPaused: false,
      speechWasActive: false,
      speechResumeText: null,
      speechResumeKind: null,
    };

    try {
      const player = playerRef.current;
      if (player?.playing) {
        const currentVolume = typeof player.volume === 'number' ? player.volume : STAGE_VIDEO_FULL_VOLUME;
        snapshot.videoVolumeBeforeDuck = currentVolume;
        likeVideoDuckActiveRef.current = true;
        player.volume = LIKE_FEEDBACK_VIDEO_DUCK_VOLUME;
      }
    } catch {
      // player may already be stopped
    }

    const tryPauseSound = async (activeSound: Audio.Sound | null): Promise<boolean> => {
      if (!activeSound) return false;
      try {
        const status = await activeSound.getStatusAsync();
        if (status.isLoaded && status.isPlaying) {
          await activeSound.pauseAsync();
          return true;
        }
      } catch {
        // sound may already be stopped
      }
      return false;
    };

    snapshot.captionSoundPaused = await tryPauseSound(captionSoundRefForActions.current);
    snapshot.deepDiveSoundPaused = await tryPauseSound(soundRef.current);

    let speaking = false;
    try {
      speaking = await Speech.isSpeakingAsync();
    } catch {
      speaking = false;
    }

    if (speaking) {
      snapshot.speechWasActive = true;
      const meta = selectedMetadataRef.current;
      const currentState = stateRef.current;
      const captionText = trimMeta(meta?.short_caption) || trimMeta(meta?.description) || '';
      const deepDiveText = trimMeta(meta?.deep_dive) || '';
      const isCaptionSpeech =
        !!currentState?.hasTag?.('speaking') &&
        !snapshot.captionSoundPaused &&
        !snapshot.deepDiveSoundPaused;

      if (isCaptionSpeech && captionText) {
        snapshot.speechResumeKind = 'caption';
        snapshot.speechResumeText = captionText;
      } else if (deepDiveText) {
        snapshot.speechResumeKind = 'deep_dive';
        snapshot.speechResumeText = deepDiveText;
      } else if (captionText) {
        snapshot.speechResumeKind = 'caption';
        snapshot.speechResumeText = captionText;
      }
      Speech.stop();
    }

    likePauseSnapshotRef.current = snapshot;
  }, []);

  const resumeAllMediaAfterLikeFeedback = useCallback(async () => {
    const snapshot = likePauseSnapshotRef.current;
    if (!snapshot) return;
    likePauseSnapshotRef.current = null;

    likeVideoDuckActiveRef.current = false;

    if (snapshot.videoVolumeBeforeDuck !== null && playerRef.current) {
      try {
        playerRef.current.volume = normalizeRestoredVideoVolume(snapshot.videoVolumeBeforeDuck);
        playerRef.current.muted = false;
      } catch {
        // player may have been torn down
      }
    }

    void refreshExplorerAudioSessionForVideo().then(() => {
      if (!likeVideoDuckActiveRef.current) {
        applyStageVideoAudible(playerRef.current);
      }
    });

    const resumeEventId = selectedEventRef.current?.event_id;
    const needsNarrationResume =
      snapshot.captionSoundPaused ||
      snapshot.deepDiveSoundPaused ||
      snapshot.speechWasActive;

    const resumeNarration = async () => {
      if (selectedEventRef.current?.event_id !== resumeEventId) return;

      if (snapshot.captionSoundPaused && captionSoundRefForActions.current) {
        try {
          await captionSoundRefForActions.current.playAsync();
        } catch {
          // caption may have been torn down
        }
      }

      if (snapshot.deepDiveSoundPaused && soundRef.current) {
        try {
          await soundRef.current.playAsync();
        } catch {
          // deep dive audio may have been torn down
        }
      }

      if (snapshot.speechWasActive && snapshot.speechResumeText) {
        if (snapshot.speechResumeKind === 'caption') {
          const thisSession = captionSessionRef.current;
          Speech.speak(snapshot.speechResumeText, {
            onDone: () => {
              if (captionSessionRef.current === thisSession) {
                sendRef.current({ type: 'NARRATION_FINISHED' });
              }
            },
            onError: () => {
              if (captionSessionRef.current === thisSession) {
                sendRef.current({ type: 'NARRATION_FINISHED' });
              }
            },
          });
        } else {
          setIsCaptionOrSparklePlayingRef.current(true);
          Speech.speak(snapshot.speechResumeText, {
            onDone: () => setIsCaptionOrSparklePlayingRef.current(false),
            onError: () => setIsCaptionOrSparklePlayingRef.current(false),
          });
        }
      }
    };

    if (!needsNarrationResume) return;

    if (likeFeedbackResumeTimeoutRef.current) {
      clearTimeout(likeFeedbackResumeTimeoutRef.current);
    }
    likeFeedbackResumeTimeoutRef.current = setTimeout(() => {
      likeFeedbackResumeTimeoutRef.current = null;
      void resumeNarration();
    }, LIKE_FEEDBACK_NARRATION_RESUME_BREATH_MS);
  }, []);

  /** Kill like TTS/hearts on navigation; does not undo Firestore likes already committed. */
  const abortLikeFeedbackForNavigation = useCallback(() => {
    if (likeFeedbackResumeTimeoutRef.current) {
      clearTimeout(likeFeedbackResumeTimeoutRef.current);
      likeFeedbackResumeTimeoutRef.current = null;
    }

    const snapshot = likePauseSnapshotRef.current;
    likeVideoDuckActiveRef.current = false;
    if (snapshot?.videoVolumeBeforeDuck !== null && playerRef.current && snapshot) {
      try {
        playerRef.current.volume = normalizeRestoredVideoVolume(snapshot.videoVolumeBeforeDuck);
        playerRef.current.muted = false;
      } catch {
        // player may have been torn down
      }
    }
    likePauseSnapshotRef.current = null;

    void refreshExplorerAudioSessionForVideo().then(() => {
      applyStageVideoAudible(playerRef.current);
    });

    void stopLikeFeedbackAudio({ skipResume: true });
    clearBursts();
  }, [clearBursts]);

  useEffect(() => {
    abortLikeFeedbackForNavigationRef.current = abortLikeFeedbackForNavigation;
  }, [abortLikeFeedbackForNavigation]);

  useEffect(() => {
    setShowLikeFaces(false);
    setLikeFacesLikedBy(null);
    abortLikeFeedbackForNavigation();
  }, [abortLikeFeedbackForNavigation, selectedEvent?.event_id]);

  useEffect(() => () => {
    abortLikeFeedbackForNavigationRef.current();
  }, []);

  useEffect(() => {
    pauseForLikeFeedbackRef.current = pauseAllMediaForLikeFeedback;
    resumeAfterLikeFeedbackRef.current = resumeAllMediaAfterLikeFeedback;
  }, [pauseAllMediaForLikeFeedback, resumeAllMediaAfterLikeFeedback]);

  const ensureStageVideoAudible = useCallback(async (target?: StageVideoPlayer | null) => {
    if (likeVideoDuckActiveRef.current) return;
    const player = target ?? playerRef.current;
    if (!player) return;
    ensureExplorerAudioSessionOnce();
    await refreshExplorerAudioSessionForVideo();
    applyStageVideoAudible(player);
  }, []);

  useEffect(() => {
    ensureStageVideoAudibleRef.current = ensureStageVideoAudible;
  }, [ensureStageVideoAudible]);

  const parkVideoForCaption = useCallback(() => {
    const player = playerRef.current;
    const meta = selectedMetadataRef.current;
    if (!player) return;
    try {
      player.pause();
      seekVideoToSeconds(player, getVideoParkSeekSec(meta));
    } catch {
      // player may be tearing down
    }
    setVideoReady(false);
  }, []);

  const signalVideoFinished = useCallback(() => {
    const currentState = stateRef.current;
    const isInPlayingState =
      currentState?.matches({ playingVideo: { playback: 'playing' } }) ||
      currentState?.matches({ playingVideoInstant: { playback: 'playing' } });
    if (!isInPlayingState) return;

    const eventId = playbackEventRef.current?.event_id ?? selectedEventRef.current?.event_id;
    if (!eventId) return;
    if (videoFinishHandledForEventRef.current === eventId) return;
    videoFinishHandledForEventRef.current = eventId;

    traceDocumentary('video.finish.signal', {
      event: shortDiagId(eventId),
      machine: JSON.stringify(currentState.value),
      docPhase: documentaryPhaseRef.current,
      docIndex: docStateRef.current?.currentIndex,
    });
    debugLog('🏁 Video finished — parking on poster before caption');
    parkVideoForCaption();
    sendRef.current({ type: 'VIDEO_FINISHED' });

    if (lastVideoFinishedEventIdRef.current !== eventId) {
      lastVideoFinishedEventIdRef.current = eventId;
    }
  }, [parkVideoForCaption, traceDocumentary]);

  const signalVideoFinishedRef = useRef<() => void>(() => {});
  useEffect(() => {
    signalVideoFinishedRef.current = signalVideoFinished;
  }, [signalVideoFinished]);

  useEffect(() => {
    videoFinishHandledForEventRef.current = null;
  }, [selectedEvent?.event_id]);

  const lastTapRef = useRef<number>(0);

  /** Duplicate guard: suppress repeated autoscroll for the same (eventId, list length) within 800ms. */
  const lastUpNextAutoscrollDedupeRef = useRef<{ key: string; at: number }>({ key: '', at: 0 });

  const scrollFlatListToDataIndex = useCallback((index: number, animated: boolean) => {
    const list = flatListRef.current;
    if (!list) return;
    const len = eventsRef.current.length;
    if (index < 0 || index >= len) return;
    try {
      list.scrollToIndex({ index, animated, viewPosition: 0.5 });
    } catch (e) {
      console.warn('Up Next scrollToIndex failed, using offset fallback', e);
      try {
        list.scrollToOffset({
          offset: Math.max(0, index * UP_NEXT_FALLBACK_ITEM_HEIGHT),
          animated,
        });
      } catch (e2) {
        console.warn('Up Next scrollToOffset fallback failed', e2);
      }
    }
  }, []);

  const performUpNextAutoscrollToEvent = useCallback(
    (eventId: string, opts?: { bypassDedupe?: boolean }) => {
      const evs = eventsRef.current;
      const len = evs.length;
      const index = evs.findIndex(e => e.event_id === eventId);
      if (index < 0 || index >= len) return;

      const key = `${eventId}:${len}`;
      const now = Date.now();
      const prev = lastUpNextAutoscrollDedupeRef.current;
      if (!opts?.bypassDedupe && prev.key === key && now - prev.at < 800) {
        return;
      }
      lastUpNextAutoscrollDedupeRef.current = { key, at: now };

      scrollFlatListToDataIndex(index, true);
    },
    [scrollFlatListToDataIndex]
  );

  const throttledOrientationUpNextRescroll = useThrottledCallback(() => {
    const id = selectedEventRef.current?.event_id;
    if (id) performUpNextAutoscrollToEvent(id, { bypassDedupe: true });
  }, 800);

  const prevUpNextLayoutDimsRef = useRef<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const prev = prevUpNextLayoutDimsRef.current;
    prevUpNextLayoutDimsRef.current = { w: width, h: height };
    if (prev == null) return;
    if (prev.w === width && prev.h === height) return;
    throttledOrientationUpNextRescroll();
  }, [width, height, throttledOrientationUpNextRescroll]);

  // Helper functions to handle gestures (must be on JS thread, not worklets)
  const handleHorizontalSwipe = useCallback((translationX: number) => {
    const currentEvents = eventsRef.current;
    const currentSelected = selectedEventRef.current;
    const currentIndex = currentEvents.findIndex(e => e.event_id === currentSelected?.event_id);

    if (currentIndex === -1) return;

    if (translationX < -50) {
      debugLog('👈 Swiped Left (Next)');
      if (currentIndex < currentEvents.length - 1) {
        onEventSelectRef.current(currentEvents[currentIndex + 1]);
      } else if (configRef.current?.loopFeed && currentEvents.length > 0) {
        debugLog('↩️ Wrapped to start');
        onEventSelectRef.current(currentEvents[0]);
        scrollFlatListToDataIndex(0, true);
      }
    } else if (translationX > 50) {
      debugLog('👉 Swiped Right (Previous)');
      if (currentIndex > 0) {
        onEventSelectRef.current(currentEvents[currentIndex - 1]);
      } else if (configRef.current?.loopFeed && currentEvents.length > 0) {
        debugLog('↪️ Wrapped to end');
        onEventSelectRef.current(currentEvents[currentEvents.length - 1]);
        scrollFlatListToDataIndex(currentEvents.length - 1, true);
      }
    }
  }, [scrollFlatListToDataIndex]);

  // Handle swipe-down dismiss - stops all media before closing
  const handleSwipeDismiss = useCallback(() => {
    debugLog('👇 Swipe Dismiss - stopping all media');

    abortLikeFeedbackForNavigationRef.current();

    // 1. Increment session to invalidate any pending callbacks
    captionSessionRef.current += 1;

    // 2. Stop TTS immediately
    Speech.stop();

    // 3. Stop any playing audio
    if (sound) {
      sound.stopAsync().catch(() => { });
      sound.unloadAsync().catch(() => { });
    }
    if (captionSound || captionSoundRef.current) {
      const soundToStop = captionSound || captionSoundRef.current;
      soundToStop?.stopAsync().catch(() => { });
      soundToStop?.unloadAsync().catch(() => { });
    }

    // 4. Clear safety timers
    if (safetyTimeoutRef.current) {
      clearTimeout(safetyTimeoutRef.current);
      safetyTimeoutRef.current = null;
    }

    // 5. Pre-clear native media before the overlay unmounts.
    clearHeavyMediaRefsRef.current();
    requestAnimationFrame(onClose);
  }, [sound, captionSound, onClose]);

  // Replay must restart the whole Reflection from chapter 0 by re-selecting the PARENT event.
  // A raw `REPLAY` relies on the machine's `context.event`, which — after a documentary plays
  // its reactions via SELECT_EVENT_INSTANT — is the last *reaction* (a video), not the parent.
  // For an image parent that misroutes REPLAY into `playingVideo` (no video → error → watchdog
  // stall) and skips the caption. Re-selecting the parent restores caption → reactions → deep dive.
  const replayFromParent = useCallback(() => {
    const parent = selectedEventRef.current;
    const parentMeta = selectedMetadataRef.current;
    // Replaying re-runs the whole documentary from chapter 0. These one-shot guards are
    // otherwise only cleared when the selected Reflection changes (which it doesn't on a
    // replay), so reset them here — otherwise the parent image caption is skipped and the
    // end-of-documentary deep dive never fires (its complete-handler is already "handled").
    documentaryCompleteHandledRef.current = null;
    parentImageCaptionPlayedForEventRef.current = null;
    chapterPlaybackPulseIndexRef.current = null;
    mainFinishIgnoredForReactionRef.current = null;
    reactionEndedForEventRef.current = null;
    documentarySelfieStartedForEventRef.current = null;
    wasFinishedRef.current = false;
    endNarrationTokenRef.current += 1;

    const replayInstant = !!(config?.instantVideoPlayback && parent?.video_url);
    traceDocumentary('replay.from_parent', {
      parent: shortDiagId(parent?.event_id),
      hasMeta: !!parentMeta,
      instant: replayInstant,
      machine: JSON.stringify(stateRef.current?.value),
    });
    if (parent && parentMeta) {
      // Prime the playback refs to the PARENT *before* sending. The machine's entry actions
      // (playAudio / speakCaption) run synchronously inside send() — before the ref-sync effect
      // updates — and read playbackEventRef. After a documentary that ref still points at the
      // last reaction (a video with no audio_url), so the caption would be skipped via an
      // immediate AUDIO_FINISHED. Setting it here makes the parent caption play on replay.
      playbackEventRef.current = parent;
      playbackMetadataRef.current = parentMeta;
      send({
        type: replayInstant ? 'SELECT_EVENT_INSTANT' : 'SELECT_EVENT',
        event: parent,
        metadata: parentMeta,
        takeSelfie: false,
      });
    } else {
      send({ type: 'REPLAY' });
    }
  }, [send, config?.instantVideoPlayback, traceDocumentary]);

  const handleSingleTap = useCallback(() => {
    const currentState = stateRef.current;
    const isVideo =
      !!selectedEventRef.current?.video_url || selectedMetadataRef.current?.content_type === 'video';

    if (currentState?.matches('idle') && selectedEventRef.current && selectedMetadataRef.current) {
      debugLog('▶️ Tapped to start playback from idle');
      docActionsRef.current.markPlaying();
      const useInstantPlayback = config?.instantVideoPlayback && isVideo;
      if (useInstantPlayback) {
        send({
          type: 'SELECT_EVENT_INSTANT',
          event: selectedEventRef.current,
          metadata: selectedMetadataRef.current,
          takeSelfie: false,
        });
      } else {
        send({
          type: 'SELECT_EVENT',
          event: selectedEventRef.current,
          metadata: selectedMetadataRef.current,
          takeSelfie: false,
        });
      }
      return;
    }

    // For videos: no pause/resume - only replay when finished
    if (isVideo) {
      if (currentState && (currentState.matches('finished') || currentState.matches({ viewingPhoto: 'viewing' }))) {
        traceDocumentary('replay.tap.video', {
          event: shortDiagId(selectedEventRef.current?.event_id),
          machine: JSON.stringify(currentState.value),
          docPhase: docStateRef.current.phase,
          docIndex: docStateRef.current.currentIndex,
        });
        debugLog('🔁 User pressed REPLAY (video)');
        hasAutoPlayedDeepDiveRef.current = false;

        replayFromParent();

        if (onReplayRef.current && selectedEventRef.current) {
          onReplayRef.current(selectedEventRef.current);
        }
      }
      // Videos don't pause - ignore tap during playback
      return;
    }

    // For non-videos (audio/photos): allow pause/resume
    if (currentState && currentState.hasTag('active')) {
      if (currentState.hasTag('paused')) {
        debugLog('⏯️ Tapped to Resume');
        send({ type: 'RESUME' });
      } else {
        debugLog('⏸️ Tapped to Pause');
        send({ type: 'PAUSE' });
      }
    } else if (currentState && (
      currentState.matches('finished') ||
      currentState.matches({ viewingPhoto: 'viewing' }) ||
      currentState.matches({ playingAudio: { playback: 'done' } })
    )) {
      traceDocumentary('replay.tap.generic', {
        event: shortDiagId(selectedEventRef.current?.event_id),
        machine: JSON.stringify(currentState.value),
        docPhase: docStateRef.current.phase,
        docIndex: docStateRef.current.currentIndex,
      });
      debugLog('🔁 User pressed REPLAY');
      hasAutoPlayedDeepDiveRef.current = false;

      replayFromParent();
      if (onReplayRef.current && selectedEventRef.current) {
        onReplayRef.current(selectedEventRef.current);
      }
    }
  }, [send, config?.instantVideoPlayback, traceDocumentary, replayFromParent]);

  const throttledSingleTap = useThrottledCallback(handleSingleTap);

  const handleChapterAvatarPress = useCallback(
    (index: number) => {
      const chapter = docStateRef.current.chapters[index];
      if (!chapter) return;

      traceDocumentary('avatar.chapter.tap', {
        index,
        event: shortDiagId(chapter.event.event_id),
        reaction: chapter.isReaction ? chapter.reactionType ?? 'unknown' : 'parent',
        phase: docStateRef.current.phase,
        machine: JSON.stringify(stateRef.current?.value),
      });

      // Any chapter tap is an explicit gear shift: cancel in-flight end narration and allow
      // completion handling to run again after the newly chosen chapter path finishes.
      documentaryCompleteHandledRef.current = null;
      chapterPlaybackPulseIndexRef.current = null;
      mainFinishIgnoredForReactionRef.current = null;
      endNarrationTokenRef.current += 1;

      // A tap on avatar 1 is an explicit restart of the whole documentary. Reset the
      // image-caption marker so image captions advance to reactions again after replaying.
      if (index === 0) {
        parentImageCaptionPlayedForEventRef.current = null;
      }

      docActionsRef.current.gotoIndex({
        index,
        sendSelectEvent: sendSelectEventForIndexing,
      });
    },
    [sendSelectEventForIndexing, traceDocumentary],
  );

  const handleMediaDoubleTapLike = useCallback((x: number, y: number) => {
    runLikeFeedbackAtPoint(x, y);
  }, [runLikeFeedbackAtPoint]);

  const handleMediaSingleTap = useCallback(() => {
    throttledSingleTap();
  }, [throttledSingleTap]);

  // Horizontal swipe gesture for next/prev (applied to root container)
  const horizontalSwipeGesture = Gesture.Pan()
    .activeOffsetX([-48, 48]) // High threshold — don't steal gross-motor double-taps on media
    .failOffsetY([-40, 40])
    .onEnd((event) => {
      'worklet';
      // Only process swipes in the stage area (exclude bottom grid in portrait)
      const isInBottomGrid = !isLandscape && event.y > height * 0.55;
      const isHeader = event.y < 120;
      const isSidebar = isLandscape && event.x > width * 0.65;

      if (isHeader || isSidebar || isInBottomGrid) {
        return;
      }

      // Handle horizontal swipe for next/prev
      // Increased threshold to 30px to avoid accidental triggers during video playback
      if (Math.abs(event.translationX) > 30 && Math.abs(event.translationX) > Math.abs(event.translationY)) {
        runOnJS(handleHorizontalSwipe)(event.translationX);
      }
    });

  // Vertical swipe gesture for dismiss-to-grid (ONLY on mediaFrame).
  // Swipe DOWN to dismiss (iOS modal-sheet convention: Apple Photos, YouTube minimize, Stories).
  // Only activates on deliberate downward drags so double-taps aren't stolen.
  const verticalSwipeGesture = Gesture.Pan()
    .activeOffsetY(32)
    .failOffsetX([-50, 50])
    .onUpdate((event) => {
      if (event.translationY > 0) {
        translateY.value = event.translationY;
        const progress = Math.min(event.translationY / 200, 1);
        scale.value = 1 - progress * 0.1;
        opacity.value = 1 - progress * 0.5;
      }
    })
    .onEnd((event) => {
      // ~80pt drag OR a quick downward fling (>600 pt/s) commits.
      const shouldDismiss = event.translationY > 80 || event.velocityY > 600;
      if (shouldDismiss) {
        translateY.value = withTiming(height, { duration: 250 });
        scale.value = withTiming(0.8, { duration: 250 });
        opacity.value = withTiming(0, { duration: 250 }, () => {
          runOnJS(handleSwipeDismiss)();
        });
      } else {
        translateY.value = withSpring(0, { damping: 20, stiffness: 300 });
        scale.value = withSpring(1, { damping: 20, stiffness: 300 });
        opacity.value = withSpring(1, { damping: 20, stiffness: 300 });
      }
    });

  const mediaTapGestures = useMemo(
    () =>
      Gesture.Exclusive(
        Gesture.Tap()
          .numberOfTaps(2)
          .maxDelay(500)
          .maxDistance(48)
          .onEnd((event, success) => {
            'worklet';
            if (success) {
              runOnJS(handleMediaDoubleTapLike)(event.x, event.y);
            }
          }),
        Gesture.Tap()
          .maxDistance(48)
          .onEnd((_event, success) => {
            'worklet';
            if (success) {
              runOnJS(handleMediaSingleTap)();
            }
          }),
        verticalSwipeGesture
      ),
    [verticalSwipeGesture, handleMediaDoubleTapLike, handleMediaSingleTap]
  );

  // Toast opacity shared value
  const toastOpacityShared = useSharedValue(0);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) {
        clearTimeout(toastTimeoutRef.current);
        toastTimeoutRef.current = null;
      }
      if (deepDiveBreathTimeoutRef.current) {
        clearTimeout(deepDiveBreathTimeoutRef.current);
        deepDiveBreathTimeoutRef.current = null;
      }
      if (likeFeedbackResumeTimeoutRef.current) {
        clearTimeout(likeFeedbackResumeTimeoutRef.current);
        likeFeedbackResumeTimeoutRef.current = null;
      }
    };
  }, []);

  // Show toast notification
  const showToast = (message: string) => {
    setToastMessage(message);
    // IMPORTANT: do not call setTimeout inside a Reanimated worklet callback.
    toastOpacityShared.value = withTiming(1, { duration: 300 });

    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
      toastTimeoutRef.current = null;
    }

    toastTimeoutRef.current = setTimeout(() => {
      toastOpacityShared.value = withTiming(0, { duration: 300 }, (finished) => {
        if (finished) {
          runOnJS(setToastMessage)('');
        }
      });
    }, 2000);
  };

  // --- AUDIO/VIDEO REFS ---
  // Use the active documentary chapter's media (falls back to base Reflection)
  // Parent Reflection media stays on the main stage during documentary reactions.
  const activeMediaEvent = parentMediaEvent;
  const videoSource = parentMediaEvent?.video_url || null;
  const selectedImageUrl = parentMediaEvent?.image_url || null;
  const stageImageDimensions = useMemo(() => {
    const stagePaneWidth = isLandscape ? width * 0.7 : width;
    const stagePaneHeight = isLandscape ? height : height * 0.6;
    return {
      width: Math.max(1, Math.round(stagePaneWidth - 40)),
      height: Math.max(1, Math.round(stagePaneHeight - 290)),
    };
  }, [height, isLandscape, width]);
  const stageImageSource = useMemo<React.ComponentProps<typeof Image>['source']>(() => {
    if (!selectedImageUrl) {
      return undefined;
    }

    return {
      uri: selectedImageUrl,
      cacheKey: imageUrlCacheKey(selectedImageUrl),
      width: stageImageDimensions.width,
      height: stageImageDimensions.height,
    };
  }, [selectedImageUrl, stageImageDimensions.height, stageImageDimensions.width]);

  // Reset readiness when source changes
  useEffect(() => {
    setVideoReady(false);
  }, [videoSource]);

  // Stable source for the hook — expo-video's useVideoPlayer recreates the native player when
  // its `source` argument changes (see JSON.stringify(parsedSource) in the hook). Recreating
  // AVPlayerViewController on each signed URL / selection churn triggers heavy main-thread UIKit
  // work. Initialize empty and swap media via replace() instead.
  const player = useVideoPlayer('', (p) => {
    p.timeUpdateEventInterval = 0.25;
  });
  const playerSourceRef = useRef<string | null>(null);

  useEffect(() => {
    if (!player) return;
    if (videoSource) {
      try {
        likeVideoDuckActiveRef.current = false;
        if (playerSourceRef.current !== videoSource) {
          player.replace(videoSource);
          playerSourceRef.current = videoSource;
        }
        player.timeUpdateEventInterval = 0.25;
        void ensureStageVideoAudibleRef.current(player);
      } catch {
        /* teardown / invalid URI */
      }
    } else {
      try {
        player.pause();
        if (playerSourceRef.current !== null) {
          player.replace('');
          playerSourceRef.current = null;
        }
      } catch {
        /* ignore */
      }
    }
  }, [player, videoSource]);

  // Keep playerRef in sync so machine actions (stopAllMedia, playVideo, etc.) work
  useEffect(() => {
    playerRef.current = player;
  }, [player]);

  // --- BRING IT TO LIFE (selfie narration PIP for photos) ---
  // The parent doc points at a child narration event; resolve its video URL
  // from the already-fetched feed when possible, else fetch a fresh bundle.
  const [narrationPlayback, setNarrationPlayback] = useState<{
    parentEventId: string;
    videoUrl: string;
  } | null>(null);

  useEffect(() => {
    narrationPlaybackRef.current = null;
    setNarrationPlayback(null);
    if (!narrationEventId || !selectedEvent?.event_id) return;

    const parentEventId = selectedEvent.event_id;
    let cancelled = false;
    const apply = (videoUrl: string) => {
      if (cancelled) return;
      const next = { parentEventId, videoUrl };
      // Ref is set immediately so the speakCaption action's wait loop sees it.
      narrationPlaybackRef.current = next;
      setNarrationPlayback(next);
    };

    // Narration child events are filtered out of the feed prop (they're
    // reaction docs), so always resolve fresh URLs via the bundle endpoint.
    if (!explorerId) return;
    (async () => {
      try {
        const response = await fetch(
          `${API_ENDPOINTS.GET_EVENT_BUNDLE}?event_id=${narrationEventId}&explorer_id=${explorerId}`,
        );
        if (!response.ok) return;
        const bundle = (await response.json()) as Event;
        if (bundle?.video_url) apply(bundle.video_url);
      } catch (error) {
        console.warn('[MainStage] narration bundle fetch failed:', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [narrationEventId, selectedEvent?.event_id, explorerId]);

  // Dedicated PIP player — the main player stays bound to the parent media.
  const narrationPlayer = useVideoPlayer('', (p) => {
    p.loop = false;
  });
  const narrationPlayerSourceRef = useRef<string | null>(null);

  useEffect(() => {
    narrationPlayerRef.current = narrationPlayer;
  }, [narrationPlayer]);

  useEffect(() => {
    if (!narrationPlayer) return;
    if (narrationPlayback?.videoUrl) {
      try {
        if (narrationPlayerSourceRef.current !== narrationPlayback.videoUrl) {
          narrationPlayer.replace(narrationPlayback.videoUrl);
          narrationPlayerSourceRef.current = narrationPlayback.videoUrl;
        }
      } catch {
        /* teardown / invalid URI */
      }
    } else {
      try {
        narrationPlayer.pause();
        if (narrationPlayerSourceRef.current !== null) {
          narrationPlayer.replace('');
          narrationPlayerSourceRef.current = null;
        }
      } catch {
        /* ignore */
      }
    }
  }, [narrationPlayer, narrationPlayback?.videoUrl]);

  // Machine bridge: invoked by speakCaption in place of caption audio/TTS.
  // Waits briefly for the narration bundle (resolution may still be in
  // flight on first open), then plays the PIP and reports NARRATION_FINISHED.
  const playNarrationPip = useCallback(
    async (session: number): Promise<boolean> => {
      const deadline = Date.now() + 5000;
      const matchesSelected = () =>
        !!narrationPlaybackRef.current &&
        narrationPlaybackRef.current.parentEventId === selectedEventRef.current?.event_id;

      while (!matchesSelected() && Date.now() < deadline && captionSessionRef.current === session) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (captionSessionRef.current !== session) return true; // superseded — no fallback
      if (!matchesSelected()) return false;

      const pipPlayer = narrationPlayerRef.current;
      if (!pipPlayer) return false;

      narrationEndSubRef.current?.remove();
      narrationEndSubRef.current = null;
      try {
        seekVideoToSeconds(pipPlayer, 0);
        pipPlayer.play();
      } catch {
        return false;
      }

      // The narration replaces the caption; when it ends, NARRATION_FINISHED moves
      // the machine to viewingPhoto.viewing and the normal auto deep dive chain
      // (breath → TELL_ME_MORE) takes over, so do NOT mark deep dive as played here.

      narrationEndSubRef.current = pipPlayer.addListener('playToEnd', () => {
        narrationEndSubRef.current?.remove();
        narrationEndSubRef.current = null;
        if (safetyTimeoutRef.current) {
          clearTimeout(safetyTimeoutRef.current);
          safetyTimeoutRef.current = null;
        }
        if (captionSessionRef.current === session) {
          debugLog(`✅ Narration PIP finished [Session: ${session}]`);
          sendRef.current({ type: 'NARRATION_FINISHED' });
        }
      });

      const durationSec =
        Number.isFinite(pipPlayer.duration) && pipPlayer.duration > 0 ? pipPlayer.duration : 60;
      safetyTimeoutRef.current = setTimeout(() => {
        if (captionSessionRef.current === session) {
          console.warn(`⚠️ Narration PIP safety fallback triggered [Session: ${session}]`);
          safetyTimeoutRef.current = null;
          sendRef.current({ type: 'NARRATION_FINISHED' });
        }
      }, durationSec * 1000 + 4000);

      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    playNarrationPipRef.current = playNarrationPip;
  }, [playNarrationPip]);

  const reactionChapterEventId = isDocumentaryReactionChapter
    ? documentaryActiveChapter?.event.event_id ?? null
    : null;

  // Active selfie reaction's resolved URL — the freshly-fetched map URL wins; the list URL is
  // only a fallback for the brief window before the fresh fetch lands.
  const reactionPipResolvedUrl =
    isDocumentaryReactionChapter && documentaryReactionType === 'selfie' && reactionChapterEventId
      ? reactionVideoUrlMap[reactionChapterEventId] ??
        documentaryActiveChapter?.event.video_url ??
        null
      : null;

  const reactionPipVideoUrl = reactionPipResolvedUrl ?? '';

  // Recreate the PiP player per reaction clip. expo-video's `useVideoPlayer` keys the native
  // player on the source (useReleasingSharedObject), so passing the URL gives every reaction a
  // FRESH player and releases the previous one. Reusing one player via `replace()` left the
  // 2nd/3rd clip rendering as a solid black box — the swapped source reported `readyToPlay` but
  // the reused decoder never produced a frame.
  const reactionPipPlayer = useVideoPlayer(reactionPipVideoUrl || '', (p) => {
    p.loop = false;
    // Emit timeUpdate so the documentary stall watchdog sees PiP playback as progress.
    p.timeUpdateEventInterval = 0.25;
  });
  const [reactionPipReady, setReactionPipReady] = useState(false);

  useEffect(() => {
    reactionPipPlayerRef.current = reactionPipPlayer;
  }, [reactionPipPlayer]);

  useEffect(() => {
    reactionVideoUrlMapRef.current = reactionVideoUrlMap;
  }, [reactionVideoUrlMap]);

  const reactionPrefetchKey = useMemo(
    () =>
      docState.chapters
        .filter((c) => c.isReaction && c.reactionType === 'selfie')
        .map((c) => c.event.event_id)
        .join('|'),
    [docState.chapters],
  );

  // Pre-resolve playable video URLs for ALL selfie reaction chapters up front. We ALWAYS fetch
  // a fresh presigned URL via GET_EVENT_BUNDLE rather than trusting the list Event's video_url,
  // which is frequently an expired presigned URL (the cause of the broken-triangle PiP). The
  // list URL is only seeded as a provisional fallback so routing has *something* immediately.
  useEffect(() => {
    if (docState.chapters.length <= 1) return;
    let cancelled = false;

    const seed: Record<string, string> = {};
    docState.chapters.forEach((c) => {
      if (
        c.isReaction &&
        c.reactionType === 'selfie' &&
        c.event.video_url &&
        !reactionVideoUrlMapRef.current[c.event.event_id]
      ) {
        seed[c.event.event_id] = c.event.video_url;
      }
    });
    if (Object.keys(seed).length) {
      traceDocumentary('reaction.url.seed', {
        count: Object.keys(seed).length,
        events: Object.keys(seed).map(shortDiagId).join(','),
      });
      setReactionVideoUrlMap((prev) => ({ ...seed, ...prev }));
    }

    if (!explorerId) return;
    const toFetch = docState.chapters.filter(
      (c) => c.isReaction && c.reactionType === 'selfie',
    );
    if (!toFetch.length) return;
    traceDocumentary('reaction.url.prefetch.start', {
      count: toFetch.length,
      events: toFetch.map((c) => shortDiagId(c.event.event_id)).join(','),
    });

    (async () => {
      for (const c of toFetch) {
        if (cancelled) return;
        try {
          const response = await fetch(
            `${API_ENDPOINTS.GET_EVENT_BUNDLE}?event_id=${c.event.event_id}&explorer_id=${explorerId}`,
          );
          if (cancelled) return;
          if (!response.ok) {
            traceDocumentary('reaction.url.prefetch.http_fail', {
              event: shortDiagId(c.event.event_id),
              status: response.status,
            });
            continue;
          }
          const bundle = (await response.json()) as Event;
          if (!cancelled && bundle?.video_url) {
            const url = bundle.video_url;
            // Fresh URL always wins over the seeded (possibly expired) list URL.
            traceDocumentary('reaction.url.prefetch.ok', {
              event: shortDiagId(c.event.event_id),
            });
            setReactionVideoUrlMap((prev) => ({ ...prev, [c.event.event_id]: url }));
          } else {
            traceDocumentary('reaction.url.prefetch.no_video', {
              event: shortDiagId(c.event.event_id),
            });
          }
        } catch (error) {
          traceDocumentary('reaction.url.prefetch.error', {
            event: shortDiagId(c.event.event_id),
            error: error instanceof Error ? error.message : String(error),
          });
          console.warn('[MainStage] reaction bundle prefetch failed:', error);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reactionPrefetchKey, explorerId, traceDocumentary]);

  // A new clip (fresh player) starts un-ready; the play driver below marks it ready once the
  // native player reports `readyToPlay` for this source.
  useEffect(() => {
    setReactionPipReady(false);
    if (reactionPipVideoUrl) {
      traceDocumentary('reaction.pip.player.new_source', {
        event: shortDiagId(reactionChapterEventId),
        urlTail: reactionPipVideoUrl.slice(-18),
      });
    }
  }, [reactionPipPlayer, reactionPipVideoUrl, reactionChapterEventId, traceDocumentary]);

  useEffect(() => {
    if (!reactionPipPlayer || !reactionPipVideoUrl) return;
    const event = () => shortDiagId(reactionChapterEventId);
    traceDocumentary('reaction.pip.player.attached', {
      event: event(),
      player: playerDiag(reactionPipPlayer),
    });
    const statusSub = reactionPipPlayer.addListener('statusChange', () => {
      traceDocumentary('reaction.pip.status', {
        event: event(),
        player: playerDiag(reactionPipPlayerRef.current),
      });
    });
    const playingSub = reactionPipPlayer.addListener('playingChange', () => {
      traceDocumentary('reaction.pip.playing', {
        event: event(),
        player: playerDiag(reactionPipPlayerRef.current),
      });
    });
    return () => {
      statusSub.remove();
      playingSub.remove();
    };
  }, [reactionPipPlayer, reactionPipVideoUrl, reactionChapterEventId, traceDocumentary]);

  // Single, idempotent end-of-reaction handler. Marks the clip ended (so the play driver
  // never restarts it), pauses the PiP + any synced parent video, and advances the
  // documentary exactly once per reaction — regardless of whether completion was detected
  // via `playToEnd`, a `timeUpdate` at-end check, or the play driver.
  const finishReactionClip = useCallback(
    (eventId: string) => {
      if (reactionEndedForEventRef.current === eventId) return;
      reactionEndedForEventRef.current = eventId;
      traceDocumentary('reaction.pip.finish', {
        event: shortDiagId(eventId),
        player: playerDiag(reactionPipPlayerRef.current),
      });
      const docReaction = documentaryReactionRef.current;
      const mainPlayer = playerRef.current;
      if (docReaction.selfieUsesParentVideo && mainPlayer) {
        try {
          mainPlayer.pause();
        } catch {
          /* ignore */
        }
      }
      try {
        reactionPipPlayerRef.current?.pause();
      } catch {
        /* ignore */
      }
      signalVideoFinishedRef.current();
    },
    [traceDocumentary],
  );
  const finishReactionClipRef = useRef(finishReactionClip);
  useEffect(() => {
    finishReactionClipRef.current = finishReactionClip;
  }, [finishReactionClip]);

  // Drive selfie-reaction PiP playback the proven ReplayModal way: a persistent listener that
  // (re)issues play() on every readiness signal. A one-shot play() races source loading and
  // silently no-ops — fatal for the 2nd/3rd chapter, where `replace()` swaps in a new clip while
  // the previous one is still reported `readyToPlay`. We retry on statusChange/playingChange and
  // via a short bounded poll, so the clip starts even if a status event is coalesced after
  // `replace()`. Errors refetch a fresh presigned URL once, then advance so it never stalls.
  useEffect(() => {
    if (!reactionPipPlayer) return;
    if (!isDocumentaryReactionChapter || documentaryReactionType !== 'selfie') return;
    if (!reactionPipVideoUrl) return;
    const eventId = reactionChapterEventId;
    if (!eventId) return;

    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let loggedReady = false;
    let loggedWantsFalse = false;
    let loggedPlayAttempt = false;
    let loggedStarted = false;

    const stopPoll = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const wantsPlaying = () =>
      Boolean(
        stateRef.current?.matches({ playingVideoInstant: { playback: 'playing' } }) ||
          stateRef.current?.matches({ playingVideo: { playback: 'playing' } }),
      );

    const ensure = () => {
      if (cancelled) return;
      const pipPlayer = reactionPipPlayerRef.current;
      if (!pipPlayer) return;

      let status: string | undefined;
      try {
        status = pipPlayer.status;
      } catch {
        return;
      }

      if (status === 'error') {
        if (explorerId && reactionPipErrorRetriedRef.current !== eventId) {
          reactionPipErrorRetriedRef.current = eventId;
          traceDocumentary('reaction.pip.error.retry_fetch', {
            event: shortDiagId(eventId),
            player: playerDiag(pipPlayer),
          });
          debugLog('🟧 Reaction PiP load error — refetching fresh URL and retrying');
          (async () => {
            try {
              const res = await fetch(
                `${API_ENDPOINTS.GET_EVENT_BUNDLE}?event_id=${eventId}&explorer_id=${explorerId}`,
              );
              if (res.ok) {
                const bundle = (await res.json()) as Event;
                if (bundle?.video_url) {
                  traceDocumentary('reaction.pip.error.retry_url_ok', {
                    event: shortDiagId(eventId),
                  });
                  setReactionVideoUrlMap((prev) => ({
                    ...prev,
                    [eventId]: bundle.video_url as string,
                  }));
                  return;
                }
              }
              traceDocumentary('reaction.pip.error.retry_url_fail', {
                event: shortDiagId(eventId),
                status: res.status,
              });
            } catch {
              traceDocumentary('reaction.pip.error.retry_throw', {
                event: shortDiagId(eventId),
              });
              /* fall through to advance */
            }
            signalVideoFinishedRef.current();
          })();
        } else {
          traceDocumentary('reaction.pip.error.advance', {
            event: shortDiagId(eventId),
            player: playerDiag(pipPlayer),
          });
          debugLog('🟥 Reaction PiP still failing after retry — advancing past this chapter');
          stopPoll();
          signalVideoFinishedRef.current();
        }
        return;
      }

      if (status !== 'readyToPlay') return;

      // Mount the VideoView (swap the avatar fallback for the live frame).
      setReactionPipReady(true);
      if (!loggedReady) {
        loggedReady = true;
        traceDocumentary('reaction.pip.ready', {
          event: shortDiagId(eventId),
          player: playerDiag(pipPlayer),
          machine: JSON.stringify(stateRef.current?.value),
        });
      }

      // Clip already played to its end (it parks paused on the last frame) — never restart it.
      if (reactionEndedForEventRef.current === eventId) {
        stopPoll();
        return;
      }
      if (!wantsPlaying()) {
        if (!loggedWantsFalse) {
          loggedWantsFalse = true;
          traceDocumentary('reaction.pip.ready_but_machine_not_playing', {
            event: shortDiagId(eventId),
            machine: JSON.stringify(stateRef.current?.value),
          });
        }
        return;
      }

      // Best-effort: play the parent video quietly underneath for time-synced selfies.
      const docReaction = documentaryReactionRef.current;
      const mainPlayer = playerRef.current;
      if (docReaction.selfieUsesParentVideo && mainPlayer) {
        try {
          if (mainPlayer.status === 'readyToPlay' && !mainPlayer.playing) {
            const syncSec = (docReaction.reactionEvent?.syncStartTimeMillis ?? 0) / 1000;
            seekVideoToSeconds(mainPlayer, syncSec);
            mainPlayer.muted = false;
            mainPlayer.volume = REACTION_PARENT_PLAYBACK_VOLUME;
            mainPlayer.play();
          }
        } catch {
          /* parent playback is best-effort only */
        }
      }

      // If the clip already started and has reached its end, finish instead of re-playing.
      // Re-issuing play() on a clip parked at its last frame re-buffers in a loop (loading ↔
      // readyToPlay) and floods status/playing events — the source of the runaway PiP churn.
      if (
        documentarySelfieStartedForEventRef.current === eventId &&
        isVideoPlayerAtEnd(pipPlayer)
      ) {
        stopPoll();
        finishReactionClipRef.current(eventId);
        return;
      }

      try {
        if (!pipPlayer.playing) {
          if (!loggedPlayAttempt) {
            loggedPlayAttempt = true;
            traceDocumentary('reaction.pip.play_attempt', {
              event: shortDiagId(eventId),
              player: playerDiag(pipPlayer),
            });
          }
          pipPlayer.muted = false;
          pipPlayer.volume = 1;
          pipPlayer.play();
        }
        if (pipPlayer.playing) {
          documentarySelfieStartedForEventRef.current = eventId;
          if (!loggedStarted) {
            loggedStarted = true;
            traceDocumentary('reaction.pip.started', {
              event: shortDiagId(eventId),
              player: playerDiag(pipPlayer),
            });
          }
          stopPoll();
        }
      } catch {
        /* player may be tearing down */
      }
    };

    ensure();
    const statusSub = reactionPipPlayer.addListener('statusChange', ensure);
    const playingSub = reactionPipPlayer.addListener('playingChange', ensure);
    pollTimer = setInterval(ensure, 250);
    const pollStop = setTimeout(stopPoll, 8000);

    return () => {
      cancelled = true;
      stopPoll();
      clearTimeout(pollStop);
      statusSub.remove();
      playingSub.remove();
    };
  }, [
    reactionPipPlayer,
    isDocumentaryReactionChapter,
    documentaryReactionType,
    reactionPipVideoUrl,
    reactionChapterEventId,
    explorerId,
    state.value,
    traceDocumentary,
  ]);

  // Attach the end-of-clip handler once per reaction chapter. Kept separate from the play
  // driver above so re-running that driver (on every machine sub-state change) can never drop
  // the end signal that advances the documentary to the next chapter.
  useEffect(() => {
    if (!reactionPipPlayer) return;
    if (!isDocumentaryReactionChapter || documentaryReactionType !== 'selfie') return;
    const eventId = reactionChapterEventId;
    if (!eventId) return;

    reactionPipEndSubRef.current?.remove();
    const onEnd = () => {
      traceDocumentary('reaction.pip.end', {
        event: shortDiagId(eventId),
        player: playerDiag(reactionPipPlayerRef.current),
      });
      finishReactionClipRef.current(eventId);
    };
    // `playToEnd` is the primary completion signal, but it is unreliable on some sources
    // (selfie reactions over image parents never emit it). A `timeUpdate` backstop detects
    // completion from currentTime vs duration so the documentary always advances.
    const onTimeUpdate = () => {
      if (reactionEndedForEventRef.current === eventId) return;
      if (documentarySelfieStartedForEventRef.current !== eventId) return;
      if (isVideoPlayerAtEnd(reactionPipPlayerRef.current)) {
        finishReactionClipRef.current(eventId);
      }
    };
    const sub = reactionPipPlayer.addListener('playToEnd', onEnd);
    const timeSub = reactionPipPlayer.addListener('timeUpdate', onTimeUpdate);
    reactionPipEndSubRef.current = {
      remove: () => {
        sub.remove();
        timeSub.remove();
      },
    };
    const currentSub = reactionPipEndSubRef.current;
    return () => {
      sub.remove();
      timeSub.remove();
      if (reactionPipEndSubRef.current === currentSub) {
        reactionPipEndSubRef.current = null;
      }
    };
  }, [reactionPipPlayer, isDocumentaryReactionChapter, documentaryReactionType, reactionChapterEventId, traceDocumentary]);

  const startCompanionMessageParentVideo = useCallback(async () => {
    const player = playerRef.current;
    const reactionEvent = playbackEventRef.current;
    if (!player || !reactionEvent) return;
    const eventId = reactionEvent.event_id;
    if (companionMessageVideoStartedForEventRef.current === eventId) return;

    const syncSec = (reactionEvent.syncStartTimeMillis ?? 0) / 1000;
    const started = await playVideoPlayerWhenReady(player, {
      seekSec: syncSec,
      beforePlay: () => {
        player.muted = false;
        player.volume = REACTION_PARENT_PLAYBACK_VOLUME;
      },
    });
    if (started) {
      companionMessageVideoStartedForEventRef.current = eventId;
    }
  }, []);

  useEffect(() => {
    startCompanionMessageParentVideoRef.current = startCompanionMessageParentVideo;
  }, [startCompanionMessageParentVideo]);

  // Reset all per-chapter playback guards whenever the active chapter changes.
  useEffect(() => {
    documentarySelfieStartedForEventRef.current = null;
    companionMessageVideoStartedForEventRef.current = null;
    reactionPipErrorRetriedRef.current = null;
    reactionEndedForEventRef.current = null;
    mainFinishIgnoredForReactionRef.current = null;
  }, [documentaryActiveChapter?.event.event_id]);

  const documentaryReactionPipVisible =
    isDocumentaryReactionChapter &&
    (documentaryUsesCompanionAvatarPip || !!reactionPipVideoUrl);

  const narrationPipVisible =
    !!narrationPlayback && narrationPlayback.parentEventId === selectedEvent?.event_id;

  const clearHeavyMediaRefs = useCallback(() => {
    setVideoReady(false);
    setIsVideoPlaying(false);
    playerRef.current = null;
    selectedEventRef.current = null;
    selectedMetadataRef.current = null;

    if (player) {
      try {
        player.pause();
        if (playerSourceRef.current !== null) {
          player.replace('');
          playerSourceRef.current = null;
        }
      } catch {
        /* Player may already be released during teardown. */
      }
    }
    if (narrationPlayerRef.current) {
      try {
        narrationPlayerRef.current.pause();
      } catch {
        /* ignore */
      }
    }
    if (reactionPipPlayerRef.current) {
      try {
        reactionPipPlayerRef.current.pause();
      } catch {
        /* ignore */
      }
    }
  }, [player]);

  useEffect(() => {
    clearHeavyMediaRefsRef.current = clearHeavyMediaRefs;
  }, [clearHeavyMediaRefs]);

  // Listen for "playing" status to lift the thumbnail shield & track isVideoPlaying.
  // For trimmed video, `isPlaying` can become true before seek-to-trim completes; keep the
  // poster shield until `currentTime` enters the trim window (or fallback timeout).
  useEffect(() => {
    if (!player) return;

    let shieldLiftFallback: ReturnType<typeof setTimeout> | null = null;
    const clearShieldLiftFallback = () => {
      if (shieldLiftFallback) {
        clearTimeout(shieldLiftFallback);
        shieldLiftFallback = null;
      }
    };

    const tryLiftThumbnailShield = () => {
      const trim = getCloudMasterTrimWindow(selectedMetadataRef.current);
      if (playheadShowsTrimStart(trim, player.currentTime)) {
        clearShieldLiftFallback();
        setVideoReady(true);
      }
    };

    const playingSub = player.addListener('playingChange', (evt: unknown) => {
      const isPlaying =
        evt && typeof evt === 'object' && 'isPlaying' in evt
          ? Boolean((evt as { isPlaying?: boolean }).isPlaying)
          : false;
      setIsVideoPlaying(isPlaying);
      traceDocumentary('main.playing', {
        event: shortDiagId(selectedEventRef.current?.event_id),
        player: playerDiag(player),
        machine: JSON.stringify(stateRef.current?.value),
      });
      if (isPlaying) {
        void ensureStageVideoAudibleRef.current(player);
        const trim = getCloudMasterTrimWindow(selectedMetadataRef.current);
        if (!trim.active) {
          clearShieldLiftFallback();
          setVideoReady(true);
        } else {
          tryLiftThumbnailShield();
          if (!playheadShowsTrimStart(trim, player.currentTime)) {
            clearShieldLiftFallback();
            shieldLiftFallback = setTimeout(() => {
              shieldLiftFallback = null;
              setVideoReady(true);
            }, 3200);
          }
        }
      } else {
        clearShieldLiftFallback();
        // When the video stops playing, check if it reached the end.
        // playingChange fires immediately when the player stops, which is faster
        // than the native playToEnd event (which can lag seconds behind on streamed content).
        // This keeps detection event-driven (no polling) while being responsive.
        const currentState = stateRef.current;
        const isInPlayingState = currentState?.matches({ playingVideo: { playback: 'playing' } }) ||
          currentState?.matches({ playingVideoInstant: { playback: 'playing' } });
        const docReaction = documentaryReactionRef.current;
        if (docReaction.active) {
          const ignoreKey = `playingChange:${docReaction.reactionEvent?.event_id ?? 'unknown'}`;
          if (mainFinishIgnoredForReactionRef.current !== ignoreKey) {
            mainFinishIgnoredForReactionRef.current = ignoreKey;
            traceDocumentary('main.finish.ignore_reaction.playingChange', {
              active: shortDiagId(docReaction.reactionEvent?.event_id),
              machine: JSON.stringify(currentState?.value),
              main: playerDiag(player),
            });
          }
          return;
        }
        const trim = getCloudMasterTrimWindow(selectedMetadataRef.current);
        if (isInPlayingState && player.duration > 0) {
          if (trim.active) {
            // Trim window end is handled by the cloud-master `timeUpdate` listener.
            return;
          }
          if (player.currentTime >= player.duration - 0.5) {
            debugLog('🏁 Video finished (detected via playingChange near end)');
            signalVideoFinishedRef.current();
          }
        }
      }
    });

    const timeSub = player.addListener('timeUpdate', () => {
      if (!player.playing) return;
      const trim = getCloudMasterTrimWindow(selectedMetadataRef.current);
      if (!trim.active) return;
      tryLiftThumbnailShield();
    });

    // When the player finishes loading a new source, retry play() if the machine
    // expects the video to be playing. This handles the race condition where
    // Hardware Sync called player.play() before the source was ready.
    const statusSub = player.addListener('statusChange', (evt: unknown) => {
      const status =
        evt && typeof evt === 'object' && 'status' in evt
          ? String((evt as { status?: string }).status)
          : '';
      traceDocumentary('main.status', {
        event: shortDiagId(selectedEventRef.current?.event_id),
        status,
        player: playerDiag(player),
        machine: JSON.stringify(stateRef.current?.value),
      });
      if (status === 'readyToPlay') {
        const trim = getCloudMasterTrimWindow(selectedMetadataRef.current);
        if (trim.active) {
          seekVideoToSeconds(player, trim.startSec);
        }
        const currentState = stateRef.current;
        const docReaction = documentaryReactionRef.current;
        const deferMainPlay =
          documentaryPhaseRef.current === 'complete' ||
          docReaction.active;
        const shouldBePlaying = currentState?.matches({ playingVideo: { playback: 'playing' } }) ||
          currentState?.matches({ playingVideoInstant: { playback: 'playing' } });
        if (shouldBePlaying && !deferMainPlay && player && !player.playing) {
          traceDocumentary('main.ready_retry_play', {
            event: shortDiagId(selectedEventRef.current?.event_id),
            deferMainPlay,
            player: playerDiag(player),
          });
          debugLog('⚡ Player became ready while machine expects playback - starting play');
          void ensureStageVideoAudibleRef.current(player);
          player.play();
        }
      }
    });

    return () => {
      clearShieldLiftFallback();
      playingSub.remove();
      timeSub.remove();
      statusSub.remove();
    };
  }, [player, traceDocumentary]);

  // Cleanup video player on unmount to prevent stale playback
  useEffect(() => {
    return () => {
      clearHeavyMediaRefsRef.current();
    };
  }, []);

  // --- ACTIONS IMPLEMENTATION ---

  // Play deep dive directly (bypasses state machine).
  // Used when the machine is in a state that doesn't handle TELL_ME_MORE
  // (e.g. playingAudio). All values accessed via refs so deps are empty.
  const playDeepDiveDirectly = useCallback(async () => {
    setIsCaptionOrSparklePlayingRef.current(true);
    Speech.stop();
    if (captionSoundRefForActions.current) {
      try {
        await captionSoundRefForActions.current.stopAsync();
        await captionSoundRefForActions.current.unloadAsync();
      } catch (e) { /* already stopped */ }
      captionSoundRefForActions.current = null;
      captionSoundRef.current = null;
      setCaptionSound(null);
    }

    const event = selectedEventRef.current;
    const metadata = selectedMetadataRef.current;

    if (event?.deep_dive_audio_url) {
      try {
        if (soundRef.current) await soundRef.current.unloadAsync();
        const { sound: newSound } = await Audio.Sound.createAsync(
          { uri: event.deep_dive_audio_url },
          {
            shouldPlay: true,
            volume: 1.0,
            progressUpdateIntervalMillis: EXPO_AV_PROGRESS_INTERVAL_MS,
          }
        );
        soundRef.current = newSound;
        setSound(newSound);
        newSound.setOnPlaybackStatusUpdate((status) => {
          if (status.isLoaded && status.didJustFinish) {
            setIsCaptionOrSparklePlayingRef.current(false);
            newSound.unloadAsync();
            soundRef.current = null;
          }
        });
      } catch (err) {
        console.warn('❌ Direct deep dive audio error:', err);
        if (metadata?.deep_dive) {
          Speech.speak(metadata.deep_dive, {
            volume: 1.0,
            onDone: () => setIsCaptionOrSparklePlayingRef.current(false),
            onError: () => setIsCaptionOrSparklePlayingRef.current(false),
          });
        } else {
          setIsCaptionOrSparklePlayingRef.current(false);
        }
      }
    } else if (metadata?.deep_dive) {
      Speech.speak(metadata.deep_dive, {
        volume: 1.0,
        onDone: () => setIsCaptionOrSparklePlayingRef.current(false),
        onError: () => setIsCaptionOrSparklePlayingRef.current(false),
      });
    } else {
      setIsCaptionOrSparklePlayingRef.current(false);
    }
  }, []);

  // End-of-documentary narration: plays the original Reflection's caption, then its Deep Dive,
  // over the parked poster/image. Deferred to here (instead of the start of chapter 0) so a
  // short-attention Explorer reaches the reactions first. Guarded by a token so navigating
  // away cancels it cleanly (One Voice / Kill Switch).
  const playEndNarration = useCallback(() => {
    const event = selectedEventRef.current;
    const metadata = selectedMetadataRef.current;
    if (!event) return;

    const token = endNarrationTokenRef.current + 1;
    endNarrationTokenRef.current = token;
    const stillCurrent = () =>
      endNarrationTokenRef.current === token &&
      selectedEventRef.current?.event_id === event.event_id;

    const captionAudioUrl = event.audio_url ?? null;
    const captionText = trimMeta(metadata?.short_caption) || trimMeta(metadata?.description);
    const parentImageCaptionAlreadySpoken =
      !event.video_url && parentImageCaptionPlayedForEventRef.current === event.event_id;

    setIsCaptionOrSparklePlayingRef.current(true);

    const proceedToDeepDive = () => {
      if (!stillCurrent()) return;
      void playDeepDiveDirectly();
    };

    void (async () => {
      try {
        Speech.stop();
        if (soundRef.current) {
          try {
            await soundRef.current.unloadAsync();
          } catch {
            /* already unloaded */
          }
          soundRef.current = null;
        }
        if (!stillCurrent()) {
          setIsCaptionOrSparklePlayingRef.current(false);
          return;
        }

        if (parentImageCaptionAlreadySpoken) {
          traceDocumentary('doc.end.skip_caption_for_image', {
            parent: shortDiagId(event.event_id),
          });
          proceedToDeepDive();
          return;
        }

        if (captionAudioUrl) {
          const { sound: newSound } = await Audio.Sound.createAsync(
            { uri: captionAudioUrl },
            {
              shouldPlay: true,
              volume: 1.0,
              progressUpdateIntervalMillis: EXPO_AV_PROGRESS_INTERVAL_MS,
            },
          );
          if (!stillCurrent()) {
            try {
              await newSound.unloadAsync();
            } catch {
              /* ignore */
            }
            setIsCaptionOrSparklePlayingRef.current(false);
            return;
          }
          soundRef.current = newSound;
          setSound(newSound);
          newSound.setOnPlaybackStatusUpdate((status) => {
            if (status.isLoaded && status.didJustFinish) {
              newSound.unloadAsync().catch(() => {});
              if (soundRef.current === newSound) soundRef.current = null;
              proceedToDeepDive();
            }
          });
        } else if (captionText) {
          Speech.speak(captionText, {
            volume: 1.0,
            onDone: proceedToDeepDive,
            onError: proceedToDeepDive,
          });
        } else {
          proceedToDeepDive();
        }
      } catch (err) {
        console.warn('❌ End-of-documentary caption error:', err);
        proceedToDeepDive();
      }
    })();
  }, [playDeepDiveDirectly, traceDocumentary]);

  useEffect(() => {
    playEndNarrationRef.current = playEndNarration;
  }, [playEndNarration]);



  // --- HARDWARE SYNC (Side Effects) ---
  // Audio session: `ensureExplorerAudioSessionOnce` at module scope + home tab — not per Reflection.
  // This effect ensures the actual hardware (Video/Audio) matches the machine state.
  // This is more reliable than actions due to closure staleness in active rendercycles.
  useEffect(() => {
    if (!player) return;

    // Check for both regular and instant video playback states
    const isMachinePlayingVideo = state.matches({ playingVideo: { playback: 'playing' } }) ||
      state.matches({ playingVideoInstant: { playback: 'playing' } });

    // Ensure we aren't finished
    const isFinished = state.matches('finished');

    // Videos don't pause - only play or stop (including during like feedback; narration-only duck/pause).
    // Avoid redundant player.play() — limits bridge/native churn (Now Playing).
    if (isMachinePlayingVideo && !isFinished) {
      const docReaction = documentaryReactionRef.current;
      // Don't auto-play the parent video during the end-of-documentary narration.
      // Read the reactive `docState.phase` (not the ref) so this effect re-runs and
      // resumes playback when phase flips complete→playing on replay. The ref lags by
      // one commit because its sync effect is declared after this one.
      if (docState.phase === 'complete') {
        return;
      }
      if (docReaction.active) {
        traceDocumentary('main.hardware_sync.defer_reaction', {
          active: shortDiagId(docReaction.reactionEvent?.event_id),
          main: playerDiag(player),
          machine: JSON.stringify(state.value),
        });
        return;
      }
      if (!isVideoPlaying) {
        debugLog('⚡ Hardware Sync: Playing Video');
        void (async () => {
          const trim = getCloudMasterTrimWindow(selectedMetadataRef.current);
          const seekSec = trim.active ? trim.startSec : undefined;
          const started = await playVideoPlayerWhenReady(player, {
            seekSec,
            beforePlay: () => {
              void ensureStageVideoAudibleRef.current(player);
            },
          });
          if (started) {
            setVideoReady(true);
          }
        })();
      }
    }
    // Removed pause handling for videos - they play through or finish
  }, [state.value, player, isVideoPlaying, docState.phase, traceDocumentary]);

  // --- DEBUG LOGGER (State Transitions) ---
  const prevStateRef = useRef<any>(null);
  useEffect(() => {
    if (!DEBUG_TRANSITIONS) return;
    if (state) {
      const stateStr = JSON.stringify(state.value);
      const prevStr = prevStateRef.current ? JSON.stringify(prevStateRef.current) : 'none';
      if (stateStr !== prevStr) {
        debugLog(`🤖 TRANSITION: ${prevStr} → ${stateStr}`);
        prevStateRef.current = state.value;
      }
    }
  }, [state, DEBUG_TRANSITIONS]);

  // Sync Live refs on every render
  useEffect(() => {
    eventsRef.current = events;
    selectedEventRef.current = selectedPlaybackEvent;
    stateRef.current = state;
    onEventSelectRef.current = onEventSelect;
    onDeleteRef.current = onDelete;
    onReplayRef.current = onReplay;
    selectedMetadataRef.current = selectedPlaybackMetadata;
    configRef.current = config;
    playbackEventRef.current = state.context.event ?? selectedPlaybackEvent;
    playbackMetadataRef.current = state.context.metadata ?? selectedPlaybackMetadata;
    documentaryHasReactionsRef.current = docState.chapters.length > 1;
    documentaryPhaseRef.current = docState.phase;
  }, [events, selectedPlaybackEvent, state, onEventSelect, onDelete, onReplay, selectedPlaybackMetadata, config, docState.chapters.length, docState.phase]);

  useEffect(() => {
    traceDocumentary('doc.state', {
      phase: docState.phase,
      index: `${docState.currentIndex + 1}/${Math.max(docState.chapters.length, 1)}`,
      active: shortDiagId(docState.activeEvent?.event_id),
      reaction: isDocumentaryReactionChapter ? documentaryReactionType ?? 'unknown' : 'parent',
      machine: JSON.stringify(state.value),
    });
  }, [
    docState.phase,
    docState.currentIndex,
    docState.chapters.length,
    docState.activeEvent?.event_id,
    isDocumentaryReactionChapter,
    documentaryReactionType,
    state.value,
    traceDocumentary,
  ]);

  // Notify parent when we enter the finished state (video/audio/narration completed).
  useEffect(() => {
    wasFinishedRef.current = false;
  }, [selectedEvent?.event_id]);

  useEffect(() => {
    const isFinished = !!state && state.matches('finished');
    if (isFinished && !wasFinishedRef.current) {
      const finishedEventId = playbackEventRef.current?.event_id ?? selectedEventRef.current?.event_id;
      const activeDocEventId = docState.activeEvent?.event_id ?? null;
      traceDocumentary('machine.finished.enter', {
        docPhase: docState.phase,
        docIndex: docState.currentIndex,
        chapters: docState.chapters.length,
        event: shortDiagId(finishedEventId),
      });
      if (docState.chapters.length > 1 && docState.phase === 'playing') {
        if (activeDocEventId && finishedEventId && activeDocEventId !== finishedEventId) {
          traceDocumentary('doc.advance.ignore_stale_finished', {
            active: shortDiagId(activeDocEventId),
            finished: shortDiagId(finishedEventId),
          });
          wasFinishedRef.current = isFinished;
          return;
        }
        const activeParent = docState.currentIndex === 0
          ? (docState.chapters[0]?.event ?? selectedEventRef.current)
          : null;
        if (activeParent && !activeParent.video_url) {
          parentImageCaptionPlayedForEventRef.current = activeParent.event_id;
          traceDocumentary('doc.image_parent.caption_done.finished', {
            parent: shortDiagId(activeParent.event_id),
            machine: JSON.stringify(state.value),
          });
        }
        // Caption + Deep Dive are deferred to the end of the documentary, so every
        // chapter (including the original Reflection at index 0) advances immediately.
        // When the final reaction finishes, onChapterFinished flips phase -> 'complete',
        // which triggers the end-of-documentary narration over the parked poster.
        traceDocumentary('doc.advance.from_finished', {
          fromIndex: docState.currentIndex,
        });
        docActions.onChapterFinished({ sendSelectEventInstant });
      }
    }
    wasFinishedRef.current = isFinished;
  }, [state?.value]); // eslint-disable-line react-hooks/exhaustive-deps

  // Image documentaries intentionally speak the parent image caption before reactions.
  // `viewingPhoto` does not transition through the machine's top-level `finished` state,
  // so advance the documentary as soon as that parent caption has completed.
  useEffect(() => {
    if (docState.phase !== 'playing') return;
    if (docState.chapters.length <= 1) return;
    if (docState.currentIndex !== 0) return;
    const parent = docState.chapters[0]?.event ?? selectedEvent;
    if (!parent || parent.video_url) return;
    if (parentImageCaptionPlayedForEventRef.current === parent.event_id) return;
    if (!state.matches('viewingPhoto')) return;
    if (state.matches({ viewingPhoto: 'narrating' })) return;

    parentImageCaptionPlayedForEventRef.current = parent.event_id;
    traceDocumentary('doc.image_parent.caption_done.advance', {
      parent: shortDiagId(parent.event_id),
      machine: JSON.stringify(state.value),
    });
    docActionsRef.current.onChapterFinished({ sendSelectEventInstant });
  }, [
    docState.phase,
    docState.chapters,
    docState.currentIndex,
    selectedEvent,
    state,
    sendSelectEventInstant,
    traceDocumentary,
  ]);

  // When the documentary finishes, reset UI to the original Reflection (chapter 0, parked poster, no PiP).
  useEffect(() => {
    if (docState.phase !== 'complete') return;
    if (docState.chapters.length <= 1) return;
    const parentId = selectedEvent?.event_id;
    if (!parentId) return;
    if (documentaryCompleteHandledRef.current === parentId) return;
    documentaryCompleteHandledRef.current = parentId;
    traceDocumentary('doc.complete.handle', {
      parent: shortDiagId(parentId),
      chapters: docState.chapters.length,
    });

    if (reactionPipEndSubRef.current) {
      reactionPipEndSubRef.current.remove();
      reactionPipEndSubRef.current = null;
    }
    if (reactionPipPlayerRef.current) {
      try {
        reactionPipPlayerRef.current.pause();
      } catch {
        /* ignore */
      }
    }
    setReactionPipReady(false);
    documentarySelfieStartedForEventRef.current = null;
    companionMessageVideoStartedForEventRef.current = null;

    // Park the original Reflection's poster/image on the main stage, then narrate the
    // caption + Deep Dive over it (deferred from the start of chapter 0 for Cole's sake).
    parkVideoForCaption();
    playEndNarrationRef.current();
  }, [docState.phase, docState.chapters.length, selectedEvent?.event_id, parkVideoForCaption]);

  useEffect(() => {
    documentaryCompleteHandledRef.current = null;
    chapterPlaybackPulseIndexRef.current = null;
    parentImageCaptionPlayedForEventRef.current = null;
    mainFinishIgnoredForReactionRef.current = null;
    // Invalidate any in-flight end-of-documentary narration when the Reflection changes.
    endNarrationTokenRef.current += 1;
  }, [selectedEvent?.event_id]);

  // Watchdog heartbeat — any real playback progress (main stage OR reaction PiP) is "alive".
  useEffect(() => {
    const bump = () => {
      lastChapterProgressAtRef.current = Date.now();
    };
    const subs: Array<{ remove: () => void }> = [];
    if (player) subs.push(player.addListener('timeUpdate', bump));
    if (reactionPipPlayer) subs.push(reactionPipPlayer.addListener('timeUpdate', bump));
    return () => subs.forEach((s) => s.remove());
  }, [player, reactionPipPlayer]);

  // Reset the heartbeat whenever a new chapter begins so each chapter gets a full
  // CHAPTER_STALL_MS window to load + start before the watchdog considers it stalled.
  useEffect(() => {
    lastChapterProgressAtRef.current = Date.now();
  }, [docState.currentIndex, docState.phase]);

  // Per-chapter stall watchdog: only while a multi-chapter documentary is actively playing.
  // If nothing has progressed for CHAPTER_STALL_MS, force-advance so the sequence can never
  // zombie (e.g. a selfie reaction whose video URL never resolved).
  useEffect(() => {
    if (docState.phase !== 'playing' || docState.chapters.length <= 1) return;
    lastChapterProgressAtRef.current = Date.now();
    const interval = setInterval(() => {
      // Audio-only / spoken reactions (e.g. a voice reaction over an image parent) make no
      // video timeUpdate, but they are healthy — keep them alive.
      const st = stateRef.current;
      const machineActivelyPlaying =
        !!st &&
        (st.matches({ playingAudio: { playback: 'playing' } }) || st.hasTag('speaking'));
      if (machineActivelyPlaying) {
        lastChapterProgressAtRef.current = Date.now();
        return;
      }
      if (Date.now() - lastChapterProgressAtRef.current < CHAPTER_STALL_MS) return;
      debugLog('🐶 Chapter watchdog: no playback progress — recovering by advancing');
      traceDocumentary('watchdog.advance', {
        docIndex: docStateRef.current.currentIndex,
        active: shortDiagId(docStateRef.current.activeEvent?.event_id),
        machine: JSON.stringify(stateRef.current?.value),
        main: playerDiag(playerRef.current),
        pip: playerDiag(reactionPipPlayerRef.current),
        msSinceProgress: Date.now() - lastChapterProgressAtRef.current,
      });
      lastChapterProgressAtRef.current = Date.now();
      docActionsRef.current.onChapterFinished({ sendSelectEventInstant });
    }, CHAPTER_WATCHDOG_TICK_MS);
    return () => clearInterval(interval);
  }, [docState.phase, docState.chapters.length, sendSelectEventInstant, traceDocumentary]);

  // Bounce the active Activity avatar when its chapter begins playing.
  useEffect(() => {
    const isMediaActive = !!state && (state.hasTag('playing') || state.hasTag('speaking'));
    if (!isMediaActive) return;
    const idx = docState.currentIndex;
    if (chapterPlaybackPulseIndexRef.current === idx) return;
    chapterPlaybackPulseIndexRef.current = idx;
    setChapterPlaybackPulseKey((k) => k + 1);
  }, [state?.value, docState.currentIndex, state]);

  // --- CO-HOST: Auto-Play Deep Dive ---

  // Stable booleans derived from state (never object references) so the effect
  // dependency comparison is reliable and doesn't spuriously re-fire.
  const isCaptionDoneForPhoto = !!state && state.matches({ viewingPhoto: 'viewing' });
  const isAudioPlaybackDone = !!state && state.matches({ playingAudio: { playback: 'done' } });
  const isInFinishedState = !!state && state.matches('finished');
  const captionCycleDone = isCaptionDoneForPhoto || isAudioPlaybackDone || isInFinishedState;

  // Reset the auto-play guard whenever the reflection changes
  useEffect(() => {
    hasAutoPlayedDeepDiveRef.current = false;
    setIsDeepDivePending(false);
    if (deepDiveBreathTimeoutRef.current) {
      clearTimeout(deepDiveBreathTimeoutRef.current);
      deepDiveBreathTimeoutRef.current = null;
    }
  }, [selectedEvent?.event_id]);

  // After the caption/audio finishes, take a short "breath" then auto-trigger deep dive.
  // For viewingPhoto/finished: sends TELL_ME_MORE (machine handles it).
  // For playingAudio: plays deep dive directly (machine doesn't handle TELL_ME_MORE there).
  useEffect(() => {
    if (!captionCycleDone || !selectedEvent) return;
    if (config?.autoPlayDeepDive === false) return;
    if (hasAutoPlayedDeepDiveRef.current) return;
    // Deep Dive is only for the original Reflection (chapter 0), not reactions.
    if (docState.currentIndex > 0) return;
    // Multi-chapter documentary: caption + Deep Dive are played together at the very
    // end (see the documentary-complete effect), not while chapter 0 is finishing.
    if (docState.chapters.length > 1) return;

    const hasDeepDive = !!selectedMetadata?.deep_dive || !!selectedEvent?.deep_dive_audio_url;
    if (!hasDeepDive) return;

    setIsDeepDivePending(true);

    const timeoutId = setTimeout(() => {
      hasAutoPlayedDeepDiveRef.current = true;
      deepDiveBreathTimeoutRef.current = null;
      setIsDeepDivePending(false);

      const currentState = stateRef.current;
      if (currentState?.matches({ playingAudio: { playback: 'done' } })) {
        playDeepDiveDirectly();
      } else {
        send({ type: 'TELL_ME_MORE' });
      }
    }, 400);
    deepDiveBreathTimeoutRef.current = timeoutId;

    return () => {
      clearTimeout(timeoutId);
      deepDiveBreathTimeoutRef.current = null;
      setIsDeepDivePending(false);
    };
  }, [captionCycleDone, selectedEvent?.event_id, docState.currentIndex, docState.chapters.length, selectedMetadata?.deep_dive, selectedEvent?.deep_dive_audio_url, config?.autoPlayDeepDive, send, playDeepDiveDirectly]);

  // --- SYNC REACT EVENTS TO MACHINE ---

  // 1. New Event Selected (ONLY when event_id actually changes)
  useEffect(() => {
    const currentEventId = selectedEvent?.event_id || null;

    if (!selectedPlaybackMetadata || !selectedPlaybackEvent) return;

    // Only send SELECT_EVENT if the event ID actually changed
    if (currentEventId && currentEventId !== prevEventIdRef.current) {
      prevEventIdRef.current = currentEventId;
      traceDocumentary('selection.new', {
        event: shortDiagId(currentEventId),
        hasVideo: !!selectedEvent?.video_url,
        reactions: docStateRef.current.chapters.length,
      });
      debugLog(`📩 User selected reflection: ${currentEventId}`);

      // Use instant video playback if configured and this is a video
      const isVideo = !!selectedEvent?.video_url;
      const useInstantPlayback = config?.instantVideoPlayback && isVideo;

      if (startIdleOnInitialSelection && !hasConsumedInitialIdleSelectionRef.current) {
        hasConsumedInitialIdleSelectionRef.current = true;
        translateY.value = 0;
        scale.value = 1;
        opacity.value = 1;
      } else if (useInstantPlayback) {
        debugLog('⚡ Using instant video playback (skipping narration)');
        // Mark the sequence as playing so chapter advance + avatar blur work the same
        // whether playback started here (auto) or via the play-overlay tap.
        docActionsRef.current.markPlaying();
        send({
          type: 'SELECT_EVENT_INSTANT',
          event: selectedPlaybackEvent,
          metadata: selectedPlaybackMetadata,
          takeSelfie: false,
        });
      } else {
        docActionsRef.current.markPlaying();
        send({
          type: 'SELECT_EVENT',
          event: selectedPlaybackEvent,
          metadata: selectedPlaybackMetadata,
          takeSelfie: false,
        });
      }

      // Reset swipe-to-dismiss animation values for fresh overlay opening
      translateY.value = 0;
      scale.value = 1;
      opacity.value = 1;

      // Auto-scroll the list to show the selected item (bounds + fallbacks in performUpNextAutoscrollToEvent).
      performUpNextAutoscrollToEvent(currentEventId);
    }
  }, [selectedEvent?.event_id, selectedPlaybackEvent, selectedPlaybackMetadata, send, translateY, scale, opacity, config?.instantVideoPlayback, performUpNextAutoscrollToEvent, traceDocumentary]);

  // 2. Video Player Finished (Event Listener)
  useEffect(() => {
    if (!player) return;

    // Listen for the specific "End of Stream" event from the native player
    const subscription = player.addListener('playToEnd', () => {
      const docReaction = documentaryReactionRef.current;
      if (docReaction.active) {
        const ignoreKey = `playToEnd:${docReaction.reactionEvent?.event_id ?? 'unknown'}`;
        if (mainFinishIgnoredForReactionRef.current !== ignoreKey) {
          mainFinishIgnoredForReactionRef.current = ignoreKey;
          traceDocumentary('main.finish.ignore_reaction.playToEnd', {
            active: shortDiagId(docReaction.reactionEvent?.event_id),
            machine: JSON.stringify(stateRef.current?.value),
            main: playerDiag(player),
          });
        }
        return;
      }
      signalVideoFinishedRef.current();
    });

    return () => {
      subscription.remove();
    };
  }, [player, send, traceDocumentary]);

  // Cloud master: pause at metadata end (full file may extend past the visible window).
  useEffect(() => {
    if (!player || !selectedEvent?.video_url) return;
    const trim = getCloudMasterTrimWindow(selectedMetadataRef.current);
    if (!trim.active) {
      return;
    }
    const endSec = trim.endSec;
    player.timeUpdateEventInterval = 0.1;
    const sub = player.addListener('timeUpdate', () => {
      const currentState = stateRef.current;
      const isInPlayingState =
        currentState?.matches({ playingVideo: { playback: 'playing' } }) ||
        currentState?.matches({ playingVideoInstant: { playback: 'playing' } });
      if (!isInPlayingState) return;
      const docReaction = documentaryReactionRef.current;
      if (docReaction.active) {
        const ignoreKey = `trim:${docReaction.reactionEvent?.event_id ?? 'unknown'}`;
        if (mainFinishIgnoredForReactionRef.current !== ignoreKey) {
          mainFinishIgnoredForReactionRef.current = ignoreKey;
          traceDocumentary('main.finish.ignore_reaction.trim', {
            active: shortDiagId(docReaction.reactionEvent?.event_id),
            machine: JSON.stringify(currentState?.value),
            main: playerDiag(player),
          });
        }
        return;
      }
      if (player.currentTime >= endSec - 0.03) {
        try {
          player.pause();
        } catch {
          /* ignore */
        }
        debugLog('🏁 Cloud master: trim window end (timeUpdate)');
        signalVideoFinishedRef.current();
      }
    });
    return () => {
      sub.remove();
      try {
        player.timeUpdateEventInterval = 0.25;
      } catch {
        /* ignore */
      }
    };
  }, [
    player,
    selectedEvent?.event_id,
    selectedEvent?.video_url,
    selectedMetadata?.video_start_ms,
    selectedMetadata?.video_end_ms,
    traceDocumentary,
  ]);

  // 3. Keep video parked on poster/trim start when fully finished (replay / deep dive context)
  useEffect(() => {
    if (state?.matches('finished') && player && (selectedMetadata?.content_type === 'video' || !!selectedEvent?.video_url)) {
      debugLog('🏁 Keeping video parked on poster at finished');
      player.pause();
      seekVideoToSeconds(player, getVideoParkSeekSec(selectedMetadata));
      setVideoReady(false);
    }
  }, [state?.matches('finished'), player, selectedMetadata, selectedEvent]);

  // 4. Show/Hide Controls AND Bubble Based on State
  useEffect(() => {
    if (!state) return;

    const isVideo = !!selectedEvent?.video_url;

    if (state.matches('idle')) {
      controlsOpacity.value = withTiming(1, { duration: 200 });
    } else if (state.matches('finished')) {
      controlsOpacity.value = withTiming(1, { duration: 200 });
    } else if (!isVideo && state.hasTag('paused')) {
      // Paused (non-video only): Show controls
      controlsOpacity.value = withTiming(1, { duration: 200 });
    } else if (state.matches({ viewingPhoto: 'viewing' })) {
      // Photo viewing: Show controls
      controlsOpacity.value = withTiming(1, { duration: 200 });
    } else if (state.matches({ playingAudio: { playback: 'done' } })) {
      // Audio playback done: Show controls (replay button)
      controlsOpacity.value = withTiming(1, { duration: 200 });
    } else {
      // Playing: Hide controls (videos never show pause controls)
      controlsOpacity.value = withTiming(0, { duration: 200 });
    }
  }, [state, controlsOpacity]);

  // 4. ANIMATIONS (VU Meter & Pulse)
  const isMachineSpeaking = state && (state.matches({ playingVideo: { playback: 'narratingCaption' } }) ||
    state.matches({ playingVideoInstant: { playback: 'narratingCaption' } }) ||
    state.matches({ viewingPhoto: 'narrating' }) ||
    state.matches({ playingDeepDive: { active: 'playing' } }));
  const isPlayingAudioState = state && state.matches('playingAudio');
  const isAnyAudioPlaying = isMachineSpeaking || isPlayingAudioState || isVideoPlaying;

  useEffect(() => {
    if (isAnyAudioPlaying) {
      audioIndicatorAnim.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 300 }),
          withTiming(0.7, { duration: 300 }),
        ),
        -1,
        false,
      );
    } else {
      cancelAnimation(audioIndicatorAnim);
      audioIndicatorAnim.value = 0.7;
    }
    return () => {
      cancelAnimation(audioIndicatorAnim);
    };
  }, [audioIndicatorAnim, isAnyAudioPlaying]);

  // Pulse animation for Tell Me More button
  const shouldPulseTellMeMore =
    !!state && (state.matches('finished') || state.matches({ viewingPhoto: 'viewing' }));
  useEffect(() => {
    if (shouldPulseTellMeMore) {
      tellMeMorePulse.value = withRepeat(
        withSequence(
          withTiming(1.15, { duration: 600 }),
          withTiming(1, { duration: 600 }),
        ),
        -1,
        false,
      );
    } else {
      cancelAnimation(tellMeMorePulse);
      tellMeMorePulse.value = 1;
    }
    return () => {
      cancelAnimation(tellMeMorePulse);
    };
  }, [shouldPulseTellMeMore, tellMeMorePulse]);


  // --- RENDERING HELPERS ---

  const handleReplayImpl = useCallback(() => {
    traceDocumentary('replay.overlay', {
      event: shortDiagId(selectedEventRef.current?.event_id),
      machine: JSON.stringify(state.value),
      docPhase: docStateRef.current.phase,
      docIndex: docStateRef.current.currentIndex,
      main: playerDiag(playerRef.current),
      pip: playerDiag(reactionPipPlayerRef.current),
    });
    hasAutoPlayedDeepDiveRef.current = false;
    setIsDeepDivePending(false);
    docActionsRef.current.reset();
    docActionsRef.current.markPlaying();

    Speech.stop();
    if (soundRef.current) {
      soundRef.current.stopAsync().catch(() => { });
      soundRef.current.unloadAsync().catch(() => { });
      soundRef.current = null;
    }
    setIsCaptionOrSparklePlaying(false);

    debugLog('🔁 User pressed REPLAY');

    replayFromParent();

    if (onReplayRef.current && selectedEventRef.current) {
      onReplayRef.current(selectedEventRef.current);
    }
  }, [state, replayFromParent, traceDocumentary]);

  const handleReplay = useThrottledCallback(handleReplayImpl);

  const handleAdminToggle = () => {
    // Only verify answer when ENTERING admin mode
    if (adminAnswer.trim() === String(mathChallenge.sum)) {
      setIsAdminMode(true);
      showToast('🔓 Admin Mode ENABLED');
      setShowAdminChallenge(false);
      setAdminAnswer('');
    } else {
      showToast('❌ Incorrect answer');
      setAdminAnswer('');
    }
  };

  const generateNewChallenge = () => {
    const a = Math.floor(Math.random() * 5) + 1;
    const b = Math.floor(Math.random() * 5) + 1;
    setMathChallenge({ a, b, sum: a + b });
  };

  const handleAdminTrigger = () => {
    const now = Date.now();
    const DOUBLE_TAP_DELAY = 500;

    if (now - lastTapRef.current < DOUBLE_TAP_DELAY) {
      if (isAdminMode) {
        // Exit directly
        setIsAdminMode(false);
        showToast('🔒 Admin Mode DISABLED');
      } else {
        // Enter: Generate challenge and show modal
        generateNewChallenge();
        setShowAdminChallenge(true);
      }
      lastTapRef.current = 0; // Reset
    } else {
      lastTapRef.current = now;
    }
  };

  const handleUpNextItemPressCore = useCallback(
    (event: Event) => {
      if (event.event_id === selectedEvent?.event_id) return;
      onEventSelect(event);
    },
    [selectedEvent?.event_id, onEventSelect]
  );

  const handleUpNextItemPress = useThrottledCallback(handleUpNextItemPressCore);

  const handlePlayCaptionPress = useCallback(async () => {
    const isMediaPlaying = state.hasTag('playing') || state.hasTag('speaking');
    const isDisabled = isMediaPlaying || isCaptionOrSparklePlaying;
    if (isDisabled) return;

    setIsCaptionOrSparklePlaying(true);
    Speech.stop();
    if (captionSound) {
      try {
        await captionSound.stopAsync();
        await captionSound.unloadAsync();
      } catch (e) {
        debugLog('Caption already stopped');
      }
      setCaptionSound(null);
    }

    if (selectedEvent?.audio_url) {
      debugLog('🔊 Playing caption audio file');
      try {
        const { sound: newSound } = await Audio.Sound.createAsync(
          { uri: selectedEvent.audio_url },
          {
            shouldPlay: true,
            progressUpdateIntervalMillis: EXPO_AV_PROGRESS_INTERVAL_MS,
          }
        );

        newSound.setOnPlaybackStatusUpdate((status) => {
          if (status.isLoaded && status.didJustFinish) {
            debugLog('✅ Caption audio finished');
            setIsCaptionOrSparklePlaying(false);
            newSound.unloadAsync();
          }
        });
        setCaptionSound(newSound);
      } catch (err) {
        console.warn('Audio playback error:', err);
        setIsCaptionOrSparklePlaying(false);
      }
    } else if (trimMeta(selectedMetadata?.short_caption) || trimMeta(selectedMetadata?.description)) {
      debugLog('🔊 Playing caption via TTS (Fallback)');
      Speech.stop();
      const textToSpeak =
        trimMeta(selectedMetadata?.short_caption) || trimMeta(selectedMetadata?.description) || '';
      Speech.speak(textToSpeak, {
        onDone: () => {
          debugLog('✅ Caption TTS finished');
          setIsCaptionOrSparklePlaying(false);
        },
        onError: (err) => {
          console.warn('TTS error:', err);
          setIsCaptionOrSparklePlaying(false);
        }
      });
    } else {
      setIsCaptionOrSparklePlaying(false);
    }
  }, [state, isCaptionOrSparklePlaying, captionSound, selectedEvent, selectedMetadata]);

  const throttledPlayCaptionPress = useThrottledCallback(handlePlayCaptionPress);

  const handleTellMeMorePress = useCallback(async () => {
    const isFinished = state.matches('finished');
    const isViewingPhoto = state.matches('viewingPhoto');
    const isNarrating = state.matches({ viewingPhoto: 'narrating' });
    const isAudioDoneButStuck = state.matches({ playingAudio: { playback: 'done' } });
    const canShow = isFinished || isAudioDoneButStuck || (isViewingPhoto && !isNarrating);
    if (!canShow) return;

    const isMediaPlaying = state.hasTag('playing') || state.hasTag('speaking');
    const isSparkleDisabled = isCaptionOrSparklePlaying || isMediaPlaying;
    if (isSparkleDisabled) return;

    debugLog('✨ User pressed Tell Me More button');
    setIsCaptionOrSparklePlaying(true);
    const currentState = state;

    if (currentState.matches({ playingAudio: { playback: 'done' } })) {
      debugLog('🔄 In playingAudio state - directly playing deep dive');
      Speech.stop();
      if (captionSoundRefForActions.current) {
        try {
          await captionSoundRefForActions.current.stopAsync();
          await captionSoundRefForActions.current.unloadAsync();
        } catch (e) { /* already stopped */ }
        captionSoundRefForActions.current = null;
      }

      const event = selectedEventRef.current;
      const metadata = selectedMetadataRef.current;

      if (event?.deep_dive_audio_url) {
        try {
          if (soundRef.current) await soundRef.current.unloadAsync();
          const { sound: newSound } = await Audio.Sound.createAsync(
            { uri: event.deep_dive_audio_url },
            {
              shouldPlay: true,
              volume: 1.0,
              progressUpdateIntervalMillis: EXPO_AV_PROGRESS_INTERVAL_MS,
            }
          );
          soundRef.current = newSound;
          newSound.setOnPlaybackStatusUpdate((status) => {
            if (status.isLoaded && status.didJustFinish) {
              setIsCaptionOrSparklePlaying(false);
              newSound.unloadAsync();
              soundRef.current = null;
            }
          });
        } catch (err) {
          if (metadata?.deep_dive) {
            Speech.speak(metadata.deep_dive, {
              volume: 1.0,
              onDone: () => setIsCaptionOrSparklePlaying(false),
              onError: () => setIsCaptionOrSparklePlaying(false),
            });
          } else {
            setIsCaptionOrSparklePlaying(false);
          }
        }
      } else if (metadata?.deep_dive) {
        Speech.speak(metadata.deep_dive, {
          volume: 1.0,
          onDone: () => setIsCaptionOrSparklePlaying(false),
          onError: () => setIsCaptionOrSparklePlaying(false),
        });
      } else {
        setIsCaptionOrSparklePlaying(false);
      }
    } else {
      send({ type: 'TELL_ME_MORE' });
    }
  }, [state, isCaptionOrSparklePlaying, send]);

  const throttledTellMeMorePress = useThrottledCallback(handleTellMeMorePress);

  // Up Next list uses the unique `events` list (no duplication).
  // If looping is enabled, reaching the end wraps back to the top.
  const upNextEvents = events;
  // Require multiple "extra downward scrolls" at the end before wrapping.
  // IMPORTANT: FlatList's `onEndReached` is not reliable (fires early, and may not fire again),
  // and `scrollToIndex` can fail without `getItemLayout`. We rely on scroll metrics +
  // end-drag events, and wrap using `scrollToOffset(0)` which is reliable.
  const endWrapCountRef = useRef(0);
  const isNearEndRef = useRef(false);
  const lastUpNextScrollMetricsRef = useRef<{
    distanceFromEnd: number;
    offsetY: number;
    contentHeight: number;
    viewportHeight: number;
  } | null>(null);

  const wrapToTop = useCallback(() => {
    endWrapCountRef.current = 0;
    const m = lastUpNextScrollMetricsRef.current;
    debugLog(
      `📜 Wrapping Up Next to top (metrics: distanceFromEnd=${m?.distanceFromEnd ?? 'n/a'} offsetY=${m?.offsetY ?? 'n/a'} contentH=${m?.contentHeight ?? 'n/a'} viewportH=${m?.viewportHeight ?? 'n/a'})`
    );
    try {
      flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
    } catch (e) {
      console.warn('📜 wrapToTop scrollToOffset failed:', e);
    }
  }, []);


  const scrollToNewestArrival = () => {
    if (newArrivalIds.length === 0 || !flatListRef.current) return;

    const evs = eventsRef.current;
    const newestIndex = evs.findIndex(e => newArrivalIds.includes(e.event_id));
    if (newestIndex < 0 || newestIndex >= evs.length) return;

    debugLog(`📜 Scrolling and playing newest arrival at index ${newestIndex}`);

    onEventSelect(evs[newestIndex]);
    scrollFlatListToDataIndex(newestIndex, true);
  };

  const renderUpNextItem = ({ item }: { item: Event }) => {
    const itemMetadata = eventMetadata[item.event_id];
    const isNowPlaying = item.event_id === selectedEvent?.event_id;
    const isRead = readEventIds.includes(item.event_id);
    const isNewArrival = newArrivalIds.includes(item.event_id);
    const itemLikedBy = reflectionLikes[item.event_id] ?? [];
    const itemLikedByMe = !!currentUserId && itemLikedBy.includes(currentUserId);
    const itemLikeCount = itemLikedBy.length;
    const itemReactionEvents = reactionsByParentId?.get(item.event_id) ?? [];
    const resolvedReactionEventIds = new Set(itemReactionEvents.map((reaction) => reaction.event_id));
    const ribbonReactionEvents = itemReactionEvents;
    const fallbackReactionEvents = (reactionSignalsByParentId.get(item.event_id) ?? [])
      .filter((signal) => !resolvedReactionEventIds.has(signal.eventId))
      .map((signal) => ({
        event_id: signal.eventId,
        image_url: item.image_url,
        metadata: {
          ...(eventMetadata[signal.eventId] ?? {}),
          event_id: signal.eventId,
          description: eventMetadata[signal.eventId]?.description ?? signal.senderName ?? 'Reaction',
          sender: eventMetadata[signal.eventId]?.sender ?? signal.senderName ?? 'Companion',
          timestamp: eventMetadata[signal.eventId]?.timestamp ?? new Date(signal.timestampMs || Date.now()).toISOString(),
          ...(signal.senderId ? { sender_id: signal.senderId } : {}),
        } as EventMetadata,
        isReaction: true,
        isNarration: signal.isNarration,
        parentReflectionId: signal.parentReflectionId,
        reactionType: signal.reactionType,
        responderRelationshipId: signal.responderRelationshipId,
      }) as Event & { responderRelationshipId?: string });
    const itemChapters = buildDocumentaryChapters(
      item,
      [...ribbonReactionEvents, ...fallbackReactionEvents],
      eventMetadata,
      companions,
    );

    return (
      <View style={[styles.upNextItemContainer, !isLandscape && { flex: 1 }]}>
        <TouchableOpacity
          style={[
            styles.upNextItem,
            isNowPlaying && styles.upNextItemNowPlaying,
            isNewArrival && !isNowPlaying && styles.upNextItemNewArrival
          ]}
          onPress={() => handleUpNextItemPress(item)}
          disabled={isNowPlaying}
        >
          {!isRead && (
            <View style={{
              width: 10, height: 10, borderRadius: 5, backgroundColor: '#007AFF',
              position: 'absolute', left: -6, top: '50%', marginTop: -5, zIndex: 10
            }} />
          )}
          <Image
            source={{
              uri: item.image_url,
              cacheKey: imageUrlCacheKey(item.image_url),
              width: 56,
              height: 56,
            }}
            style={styles.upNextThumbnail}
            contentFit="cover"
            recyclingKey={item.event_id}
            cachePolicy="memory-disk"
            priority="low"
          />
          <View style={styles.upNextInfo}>
            <Text style={[styles.upNextTitle, isNowPlaying && styles.upNextTitleNowPlaying]} numberOfLines={2}>
              {isNowPlaying && '▶️ '}
              {displayCaptionFrom(itemMetadata, item)}
            </Text>

            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              {item.video_url ? (
                <>
                  <FontAwesome name="video-camera" size={12} color="rgba(255, 255, 255, 0.7)" style={{ marginRight: 4 }} />
                  <Text style={[styles.upNextMeta, isNowPlaying && styles.upNextMetaNowPlaying]}>Video</Text>
                </>
              ) : itemMetadata?.image_source === 'search' ? (
                <>
                  <FontAwesome name="search" size={12} color="rgba(255, 255, 255, 0.7)" style={{ marginRight: 4 }} />
                  <Text style={[styles.upNextMeta, isNowPlaying && styles.upNextMetaNowPlaying]}>Image</Text>
                </>
              ) : (
                <>
                  <FontAwesome name="camera" size={12} color="rgba(255, 255, 255, 0.7)" style={{ marginRight: 4 }} />
                  <Text style={[styles.upNextMeta, isNowPlaying && styles.upNextMetaNowPlaying]}>Photo</Text>
                </>
              )}
              {isNowPlaying && <Text style={styles.upNextMetaNowPlaying}> • Reflections.</Text>}
              {isNewArrival && !isNowPlaying && <Text style={styles.upNextMetaNew}> • NEW</Text>}
            </View>

            <Text style={[styles.upNextDate, isNowPlaying && styles.upNextDateNowPlaying]}>
              {itemMetadata?.sender ? `${itemMetadata.sender} • ` : ''}{formatEventDateFromId(item.event_id)}
            </Text>

            {itemChapters.length > 0 ? (
              <View
                style={styles.upNextChapterRibbon}
                pointerEvents="none"
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              >
                <Text style={styles.upNextChapterRibbonLabel}>Chapters</Text>
                <View style={styles.upNextChapterRibbonFaces}>
                  {itemChapters.slice(0, 6).map((chapter) => (
                    <View
                      key={chapter.event.event_id}
                      style={[
                        styles.upNextChapterAvatarWrap,
                        !chapter.isReaction && styles.upNextChapterAvatarWrapParent,
                      ]}
                    >
                      {chapter.speakerAvatarUrl ? (
                        <Image
                          source={{ uri: chapter.speakerAvatarUrl }}
                          style={styles.upNextChapterAvatar}
                          contentFit="cover"
                        />
                      ) : (
                        <View
                          style={[
                            styles.upNextChapterAvatar,
                            styles.upNextChapterAvatarFallback,
                            { backgroundColor: chapter.speakerColor },
                          ]}
                        >
                          <Text style={styles.upNextChapterAvatarInitial}>
                            {chapter.speakerInitial}
                          </Text>
                        </View>
                      )}
                      <View
                        style={[
                          styles.upNextChapterBadge,
                          !chapter.isReaction && styles.upNextChapterBadgeParent,
                        ]}
                      >
                        <FontAwesome name={chapterBadgeIcon(chapter)} size={7} color="#fff" />
                      </View>
                    </View>
                  ))}
                  {itemChapters.length > 6 ? (
                    <View style={styles.upNextChapterMore}>
                      <Text style={styles.upNextChapterMoreText}>+{itemChapters.length - 6}</Text>
                    </View>
                  ) : null}
                </View>
              </View>
            ) : null}

            <Pressable
              onPress={(event) => {
                event.stopPropagation();
                if (!currentUserId || !onToggleLike) return;
                onToggleLike(item.event_id, currentUserId, !itemLikedByMe);
              }}
              onLongPress={(event) => {
                event.stopPropagation();
                if (itemLikeCount > 0) {
                  setLikeFacesLikedBy(itemLikedBy);
                  setShowLikeFaces(true);
                }
              }}
              style={({ pressed }) => [
                styles.upNextLikeControl,
                itemLikedByMe && styles.upNextLikeControlActive,
                pressed && styles.upNextLikeControlPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={itemLikedByMe ? 'Unlike this Reflection' : 'Like this Reflection'}
            >
              <FontAwesome
                name={itemLikeCount > 0 ? 'heart' : 'heart-o'}
                size={12}
                color={itemLikedByMe ? '#4FC3F7' : itemLikeCount > 0 ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.75)'}
              />
              {itemLikeCount > 0 ? (
                <Text style={[styles.upNextLikeCount, itemLikedByMe && styles.upNextLikeCountActive]}>{itemLikeCount}</Text>
              ) : null}
            </Pressable>

            <Text style={styles.reflectionId}>
              Reflection ID: {item.event_id}
            </Text>
          </View>

          {/* Delete Button - Only visible in Admin Mode */}
          {isAdminMode && (
            <TouchableOpacity
              style={styles.deleteButton}
              onPress={() => {
                Alert.alert(
                  "Delete Reflection",
                  "Are you sure you want to permanently delete this reflection?",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Delete",
                      style: "destructive",
                      onPress: () => {
                        onDelete(item);
                        showToast('🗑️ Reflection deleted');
                      }
                    }
                  ]
                );
              }}
            >
              <FontAwesome name="trash" size={20} color="rgba(255, 100, 100, 0.9)" />
            </TouchableOpacity>
          )}
        </TouchableOpacity>
      </View>
    );
  };


  // CRITICAL: Return null (not empty View) so touches pass through to grid underneath
  if (!selectedEvent) return null;


  // Replay overlay: visible when media isn't actively playing.
  // Hidden during the co-host breath (isDeepDivePending) and direct deep dive playback.
  // Also hidden between documentary chapters (sequence is still playing, just advancing).
  const showReplayOverlay =
    !isCaptionOrSparklePlaying &&
    !isDeepDivePending &&
    (isInFinishedState ||
      isCaptionDoneForPhoto ||
      isAudioPlaybackDone ||
      docState.phase === 'complete') &&
    (docState.chapters.length <= 1 || docState.phase === 'complete' || docState.phase === 'idle');
  const showPlayOverlay = state.matches('idle');

  // Animated style for root container (swipe-to-minimize)
  const rootAnimatedStyle = useAnimatedStyle(() => {
    return {
      transform: [
        { translateY: translateY.value },
        { scale: scale.value },
      ],
      opacity: opacity.value,
    };
  });

  // Animated styles for other components
  const controlsAnimatedStyle = useAnimatedStyle(() => ({
    opacity: controlsOpacity.value,
  }));

  const audioIndicatorAnimatedStyle = useAnimatedStyle(() => ({
    opacity: audioIndicatorAnim.value,
  }));

  const activeChapter = docState.chapters[docState.currentIndex] ?? docState.chapters[0] ?? null;
  const stageCaptionText =
    docState.activeSubtitle ??
    displayCaptionFrom(selectedMetadata, selectedEvent);
  const stageSenderName = activeChapter?.speakerName ?? selectedMetadata?.sender ?? null;
  const stageCaptionEventId = activeChapter?.event.event_id ?? selectedEvent?.event_id ?? null;
  const stageCaptionDate = stageCaptionEventId ? formatEventDateFromId(stageCaptionEventId) : null;

  const tellMeMoreAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: tellMeMorePulse.value }],
  }));

  const heartAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: heartScale.value }],
  }));

  const tellMeMoreBlurOpacityAnimatedStyle = useAnimatedStyle(() => ({
    opacity: tellMeMoreBlurOpacity.value,
  }));

  const toastAnimatedStyle = useAnimatedStyle(() => ({
    opacity: toastOpacityShared.value,
  }));

  const reflectionsHeaderTitle =
    explorerDisplayName?.trim().length
      ? `${explorerDisplayName.trim()}'s Reflections`
      : 'Reflections';

  return (
    <GestureDetector gesture={horizontalSwipeGesture}>
      <Animated.View style={[styles.modalContainer, rootAnimatedStyle]}>
        <ExplorerGradientBackdrop layout="overlay" />
        <View style={styles.modalForeground}>
          <View style={[styles.splitContainer, isLandscape ? styles.splitContainerLandscape : styles.splitContainerPortrait]}>

            {/* LEFT PANE */}
            <View style={[styles.stagePane, isLandscape ? { flex: 0.7 } : { flex: 0.60 }]}>

              {/* Header */}
              <View style={[styles.headerBar, { top: insets.top + 10 }]}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: 'transparent' }}>
                  <View style={{ flex: 1 }}>
                    {newArrivalIds.length > 0 ? (
                      <TouchableOpacity
                        onPress={scrollToNewestArrival}
                        style={styles.newArrivalNotification}
                        activeOpacity={0.7}
                      >
                        <BlurView intensity={STATIC_BLUR_INTENSITY} style={styles.notificationBlur}>
                          <Text style={styles.newArrivalText}>✨ {newArrivalIds.length} New Reflection{newArrivalIds.length > 1 ? 's' : ''}</Text>
                        </BlurView>
                      </TouchableOpacity>
                    ) : (
                      events.length > 1 && (
                        <Text
                          style={styles.reflectionsTitle}
                          numberOfLines={1}
                          ellipsizeMode="tail"
                        >
                          {reflectionsHeaderTitle}
                        </Text>
                      )
                    )}
                  </View>

                  {!!positionText && (
                    <Text style={styles.positionText}>{positionText}</Text>
                  )}
                </View>



              </View>

              {/* Media Container */}
              <View style={styles.mediaContainer}>
                <Animated.View
                  style={styles.mediaFrame}
                  onLayout={(event) => {
                    mediaFrameLayoutRef.current = {
                      width: event.nativeEvent.layout.width,
                      height: event.nativeEvent.layout.height,
                    };
                  }}
                >
                    <StageCrossFadeMedia activeEventId={selectedEvent?.event_id ?? null}>
                    {/* Layer 1: stage video player, rendered only after a Reflection has a valid source. */}
                    {videoSource && player ? (
                      <StableStageVideoView
                        player={player}
                        sourceKey={videoSource}
                      />
                    ) : null}

                    {/* Layer 2: Thumbnail Shield (Rendered ON TOP until video is ready) */}
                    {/* We keep this visible if: (1) It's a photo OR (2) It's a video that hasn't started playing yet */}
                    {stageImageSource && (!videoSource || !videoReady) && (
                      <Image
                        source={stageImageSource}
                        style={[styles.mediaImage, { position: 'absolute', zIndex: 10 }]}
                        contentFit="contain"
                        recyclingKey={activeMediaEvent?.event_id ?? selectedEvent.event_id}
                        cachePolicy="memory-disk"
                        priority="high"
                      />
                    )}
                    </StageCrossFadeMedia>

                    {documentaryReactionPipVisible ? (
                      <DocumentaryReactionPip
                        visible
                        mode={reactionPipVideoUrl ? 'selfie-video' : 'companion-avatar'}
                        chapter={documentaryActiveChapter}
                        reactionPlayer={reactionPipPlayer}
                        videoReady={reactionPipReady}
                      />
                    ) : null}

                    {/* Bring It to Life: selfie narration PIP over the full-screen photo */}
                    {narrationPipVisible ? (
                      <View style={styles.narrationPipFrame} pointerEvents="none">
                        <StableNarrationVideoView player={narrationPlayer} />
                      </View>
                    ) : null}
                    {/*
                      VideoView must not be a child of RNGH GestureDetector on Android — the native
                      surface often never paints. Keep VideoView under a plain View; gestures on overlay.
                    */}
                    <GestureDetector gesture={mediaTapGestures}>
                      <View style={styles.mediaGestureOverlay} pointerEvents="box-only" collapsable={false} />
                    </GestureDetector>

                    <LikeHeartBurstOverlay bursts={likeHeartBursts} onBurstComplete={removeBurst} />

                    {/* Tell Me More button — top-left of media area */}
                    {selectedMetadata?.deep_dive && state && (() => {
                      const isFinished = state.matches('finished');
                      const isViewingPhoto = state.matches('viewingPhoto');
                      const isNarrating = state.matches({ viewingPhoto: 'narrating' });
                      const isAudioDoneButStuck = state.matches({ playingAudio: { playback: 'done' } });
                      const canShow = isFinished || isAudioDoneButStuck || (isViewingPhoto && !isNarrating);
                      const isMediaPlaying = state.hasTag('playing') || state.hasTag('speaking');
                      const isSparkleDisabled = isCaptionOrSparklePlaying || isMediaPlaying;
                      if (!canShow) return null;
                      return (
                        <TellMeMoreButton
                          key="tellMeMore"
                          onPress={throttledTellMeMorePress}
                          disabled={isSparkleDisabled}
                          isNarrating={isCaptionOrSparklePlaying}
                          bypassed={docState.bypassDeepDive}
                          containerStyle={tellMeMoreAnimatedStyle}
                          blurOpacityStyle={tellMeMoreBlurOpacityAnimatedStyle}
                        />
                      );
                    })()}

                    {(showPlayOverlay || showReplayOverlay) ? (
                      <Animated.View
                        style={[styles.playOverlay, controlsAnimatedStyle]}
                        pointerEvents="box-none"
                      >
                        {showPlayOverlay ? (
                          <TouchableOpacity onPress={throttledSingleTap} style={styles.playButton}>
                            <BlurView intensity={STATIC_BLUR_INTENSITY} style={styles.playOverlayBlur}>
                              <FontAwesome name="play" size={64} color="rgba(255, 255, 255, 0.95)" />
                            </BlurView>
                          </TouchableOpacity>
                        ) : null}
                        {showReplayOverlay ? (
                          <TouchableOpacity onPress={handleReplay} style={styles.playButton}>
                            <BlurView intensity={STATIC_BLUR_INTENSITY} style={styles.playOverlayBlur}>
                              <FontAwesome name="repeat" size={64} color="rgba(255, 255, 255, 0.95)" />
                            </BlurView>
                          </TouchableOpacity>
                        ) : null}
                      </Animated.View>
                    ) : null}

                </Animated.View>

                {/* Loading Indicator removed - was blocking video */}
              </View>

              {/* Companion avatars + production caption bar */}
              <View style={[styles.stageMetadataSection, { paddingBottom: insets.bottom + 8 }]}>
                <ActivityRow
                  chapters={docState.chapters}
                  activeIndex={docState.currentIndex}
                  isPlayingSequence={docState.isPlayingSequence}
                  chapterPlaybackPulseKey={chapterPlaybackPulseKey}
                  onAvatarPress={handleChapterAvatarPress}
                />

                <StageCaptionBar
                  captionText={stageCaptionText}
                  senderName={stageSenderName}
                  formattedDate={stageCaptionDate}
                  reflectionId={selectedEvent?.event_id}
                  isAnyAudioPlaying={isAnyAudioPlaying}
                  audioIndicatorAnimatedStyle={audioIndicatorAnimatedStyle}
                  likedByCurrentUser={likedByCurrentUser}
                  likeCount={likeCount}
                  heartAnimatedStyle={heartAnimatedStyle}
                  onLike={handleLikePress}
                  onShowLikedBy={() => {
                    setLikeFacesLikedBy(null);
                    setShowLikeFaces(true);
                  }}
                  onCopyReflectionId={async () => {
                    if (!selectedEvent?.event_id) return;
                    try {
                      await Clipboard.setStringAsync(selectedEvent.event_id);
                      showToast('Copied reflection ID');
                    } catch {
                      showToast('Could not copy');
                    }
                  }}
                />
              </View>

            </View>

            {/* RIGHT PANE */}
            <View style={[styles.upNextPane, isLandscape ? { flex: 0.3 } : { flex: 0.40 }, { paddingTop: isLandscape ? insets.top + 10 : 5 }]}>
              <View style={styles.upNextHeader}>
                <Text style={styles.upNextHeaderText}>Up Next</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <TouchableOpacity
                    onPress={handleAdminTrigger}
                    activeOpacity={0.6}
                    style={{ padding: 4 }}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <FontAwesome
                      name={isAdminMode ? "unlock" : "cog"}
                      size={15}
                      color={isAdminMode ? "#FF3B30" : "rgba(255,255,255,0.4)"}
                    />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => router.push('/settings')}
                    style={{ marginLeft: 12, padding: 4 }}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <FontAwesome name="info-circle" size={15} color="rgba(255,255,255,0.4)" />
                  </TouchableOpacity>
                </View>
              </View>

              <FlatList
                ref={flatListRef}
                data={upNextEvents}
                renderItem={renderUpNextItem}
                keyExtractor={(item) => item.event_id}
                // Up Next stays thumbnail-only; the video player is initialized only on Stage.
                // NOTE: Avoid `onEndReached` for wrapping (it fires early and inconsistently).
                onScroll={(e) => {
                  const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
                  const distanceFromEnd = contentSize.height - (contentOffset.y + layoutMeasurement.height);
                  const nearEnd = distanceFromEnd < 80; // ~1–2 items worth of slack
                  isNearEndRef.current = nearEnd;
                  lastUpNextScrollMetricsRef.current = {
                    distanceFromEnd,
                    offsetY: contentOffset.y,
                    contentHeight: contentSize.height,
                    viewportHeight: layoutMeasurement.height,
                  };
                  // If user scrolls away from the end, reset the counter.
                  if (!nearEnd) {
                    endWrapCountRef.current = 0;
                  }
                }}
                scrollEventThrottle={16}
                onScrollEndDrag={() => {
                  if (!configRef.current?.loopFeed) return;
                  if (!isNearEndRef.current) return;
                  if (upNextEvents.length < 2) return;

                  endWrapCountRef.current += 1;
                  const m = lastUpNextScrollMetricsRef.current;
                  debugLog(
                    `📜 End extra-scroll (${endWrapCountRef.current}/2) (metrics: distanceFromEnd=${m?.distanceFromEnd ?? 'n/a'} offsetY=${m?.offsetY ?? 'n/a'})`
                  );

                  if (endWrapCountRef.current < 2) return;
                  wrapToTop();
                }}
                removeClippedSubviews={true}
                initialNumToRender={6}
                maxToRenderPerBatch={6}
                windowSize={3}
                key={isLandscape ? 'list' : 'grid'}
                numColumns={isLandscape ? 1 : 2}
                columnWrapperStyle={!isLandscape ? { gap: 8 } : undefined}
                onScrollToIndexFailed={(info) => {
                  const list = flatListRef.current;
                  if (!list) return;
                  const len = eventsRef.current.length;
                  const h =
                    info.averageItemLength > 1 ? info.averageItemLength : UP_NEXT_FALLBACK_ITEM_HEIGHT;
                  const clampedIndex = Math.max(0, Math.min(info.index, Math.max(0, len - 1)));
                  const offset = Math.max(0, clampedIndex * h);
                  try {
                    list.scrollToOffset({ offset, animated: true });
                  } catch (e) {
                    console.warn('Up Next onScrollToIndexFailed offset fallback failed', e);
                  }
                }}
              />

            </View>



          </View>

          {/* Toast Notification */}
          {toastMessage ? (
            <Animated.View style={[styles.toast, toastAnimatedStyle]}>
              <Text style={styles.toastText}>{toastMessage}</Text>
            </Animated.View>
          ) : null}

          <Modal
            visible={showLikeFaces}
            transparent
            animationType="fade"
            onRequestClose={() => {
              setShowLikeFaces(false);
              setLikeFacesLikedBy(null);
            }}
          >
            <View style={styles.facesModalOverlay}>
              <Pressable
                style={StyleSheet.absoluteFill}
                onPress={() => {
                  setShowLikeFaces(false);
                  setLikeFacesLikedBy(null);
                }}
              />
              <View style={styles.facesModalCard}>
                <TouchableOpacity
                  style={styles.facesCloseButton}
                  onPress={() => {
                    setShowLikeFaces(false);
                    setLikeFacesLikedBy(null);
                  }}
                  hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}
                  accessibilityLabel="Close faces"
                >
                  <FontAwesome name="close" size={18} color="#fff" />
                </TouchableOpacity>
                <FlatList
                  data={likerFaces}
                  keyExtractor={(item) => item.uid}
                  numColumns={3}
                  contentContainerStyle={styles.facesGrid}
                  renderItem={({ item }) => (
                    <View style={styles.faceGridItem}>
                      {item.avatarUrl ? (
                        <Image
                          source={{ uri: item.avatarUrl }}
                          style={styles.faceAvatar}
                          contentFit="cover"
                          recyclingKey={`face-${item.uid}`}
                        />
                      ) : (
                        <View style={[styles.faceAvatarFallback, { backgroundColor: item.color }]}>
                          <Text style={styles.faceAvatarInitial}>{item.initial}</Text>
                        </View>
                      )}
                      {item.isCaregiver ? (
                        <View style={styles.faceCaregiverBadge}>
                          <FontAwesome name="shield" size={12} color="#fff" />
                        </View>
                      ) : null}
                    </View>
                  )}
                />
              </View>
            </View>
          </Modal>

          {/* Admin Challenge Modal */}
          <Modal
            visible={showAdminChallenge}
            transparent
            animationType="fade"
            onRequestClose={() => setShowAdminChallenge(false)}
          >
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
              style={styles.adminChallengeOverlay}
            >
              <View style={styles.adminChallengeBox}>
                <View style={styles.adminLockIcon}>
                  <FontAwesome name="lock" size={32} color="#007AFF" />
                </View>
                <Text style={styles.adminChallengeTitle}>Caregiver Mode</Text>
                <Text style={styles.adminChallengeSub}>To toggle delete access, please solve:</Text>
                <Text style={styles.mathProblem}>{mathChallenge.a} + {mathChallenge.b} = ?</Text>

                <TextInput
                  style={styles.adminInput}
                  keyboardType="number-pad"
                  autoFocus
                  maxLength={2}
                  value={adminAnswer}
                  onChangeText={setAdminAnswer}
                  onSubmitEditing={handleAdminToggle}
                  placeholder="?"
                />

                <View style={styles.adminButtonRow}>
                  <TouchableOpacity
                    style={[styles.adminButton, styles.adminCancelButton]}
                    onPress={() => {
                      setShowAdminChallenge(false);
                      setAdminAnswer('');
                    }}
                  >
                    <Text style={styles.adminCancelButtonText}>Cancel</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.adminButton, styles.adminSubmitButton]}
                    onPress={handleAdminToggle}
                  >
                    <Text style={styles.adminButtonText}>Verify</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </KeyboardAvoidingView>
          </Modal>
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  modalContainer: { flex: 1 },
  modalForeground: { flex: 1, zIndex: 1 },
  splitContainer: { flex: 1 },
  splitContainerLandscape: { flexDirection: 'row' },
  splitContainerPortrait: { flexDirection: 'column' },
  stagePane: { position: 'relative' },
  headerBar: { position: 'absolute', left: 20, right: 20, zIndex: 100 },
  stageFilterBar: {
    position: 'absolute',
    left: 20,
    right: 20,
    zIndex: 90,
  },

  reflectionsTitle: { color: '#fff', fontSize: 18, fontWeight: '700', flexShrink: 1 },
  positionText: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 14,
    fontWeight: '700',
    marginLeft: 12,
  },
  newUpdatesButton: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFD700', padding: 8, borderRadius: 20 },
  newUpdatesText: { color: '#000', fontWeight: 'bold' },
  mediaContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    paddingTop: 80,
    paddingBottom: 12,
  },
  stageMetadataSection: {
    width: '100%',
  },
  mediaFrame: {
    flex: 1,
    width: '100%',
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: '#1a3a44', // Match gradient midpoint instead of black
    // Subtle shadow for depth
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 10,
    // Subtle border
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
  },
  mediaGestureOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 45,
    elevation: 45,
  },
  mediaImage: { width: '100%', height: '100%', resizeMode: 'contain' },
  narrationPipFrame: {
    position: 'absolute',
    top: 18,
    right: 18,
    width: 132,
    height: 176,
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.45)',
    backgroundColor: '#000',
    zIndex: 40,
    elevation: 40,
  },
  narrationPipVideo: {
    width: '100%',
    height: '100%',
  },
  playOverlay: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 55,
    elevation: 55,
  },
  playButton: { width: 120, height: 120, borderRadius: 60, overflow: 'hidden', justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0, 0, 0, 0.3)' },
  playOverlayBlur: { width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(255, 255, 255, 0.1)' },
  metadataContainer: {
    position: 'absolute',
    bottom: 20,
    left: 20,
    right: 20,
    padding: 20,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 20,
  },
  senderText: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 14,
    fontWeight: '600',
  },
  dateText: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 14,
  },
  eventIdPressable: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    paddingVertical: 2,
    paddingRight: 6,
    borderRadius: 4,
  },
  eventIdPressablePressed: {
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  eventIdLabel: {
    fontSize: 11,
    lineHeight: 14,
    color: 'rgba(160, 170, 180, 0.75)',
  },
  eventIdText: {
    fontSize: 11,
    lineHeight: 14,
    color: 'rgba(200, 210, 220, 0.9)',
    fontVariant: ['tabular-nums'],
  },
  stageLikeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  stageLikeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  stageLikeButtonActive: {
    backgroundColor: 'rgba(255, 48, 64, 0.18)',
    borderColor: 'rgba(255, 48, 64, 0.45)',
  },
  stageLikeHint: {
    flex: 1,
    color: 'rgba(255, 255, 255, 0.72)',
    fontSize: 14,
    fontWeight: '500',
    marginLeft: 2,
  },
  stageLikeCountButton: {
    minWidth: 30,
    height: 30,
    paddingHorizontal: 9,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  stageLikeCountButtonPressed: {
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  stageLikeCount: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
  },
  descriptionText: { color: '#fff', fontSize: 18, lineHeight: 24 },
  playCaptionButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 12,
  },
  playCaptionButtonDisabled: {
    opacity: 0.35,
  },
  playCaptionButtonWhileNarration: {
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
  },

  tellMeMoreFAB: {
    position: 'absolute',
    bottom: 120,
    right: 30,
    width: 64,
    height: 64,
    borderRadius: 32,
    overflow: 'hidden',
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
  },
  tellMeMoreFABNarration: {
    opacity: 0.88,
  },
  tellMeMoreBlurOpacity: { flex: 1, width: '100%' },
  tellMeMoreBlur: { flex: 1, width: '100%', justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(255, 255, 255, 0.1)' },
  tellMeMoreBlurDimmed: {
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  upNextPane: {
    borderLeftWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.25)',
    paddingHorizontal: 12,
  },

  upNextHeader: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, paddingHorizontal: 4 },
  upNextHeaderText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
  upNextCount: { color: '#ccc' },
  upNextItemContainer: { marginVertical: 6, marginHorizontal: 4 },
  upNextItem: { flexDirection: 'row', padding: 12, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 12 },
  upNextItemNowPlaying: { backgroundColor: 'rgba(0,122,255,0.3)' },
  upNextThumbnail: { width: 56, height: 56, borderRadius: 8, marginRight: 12 },

  upNextTitle: { color: '#fff' },
  upNextTitleNowPlaying: { color: '#4FC3F7', fontWeight: 'bold' },
  upNextDate: { color: '#aaa', fontSize: 12, marginTop: 2 },
  upNextDateNowPlaying: { color: '#4FC3F7' },
  upNextMeta: { color: '#aaa', fontSize: 12, marginTop: 2 },
  upNextMetaNowPlaying: { color: '#4FC3F7', fontWeight: 'bold' },
  upNextChapterRibbon: {
    marginTop: 8,
    marginHorizontal: -4,
    paddingTop: 7,
    paddingHorizontal: 4,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.26)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  upNextChapterRibbonLabel: {
    color: 'rgba(255, 255, 255, 0.45)',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.35,
    textTransform: 'uppercase',
  },
  upNextChapterRibbonFaces: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    overflow: 'hidden',
  },
  upNextChapterAvatarWrap: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: 'rgba(18, 18, 18, 0.95)',
    backgroundColor: 'rgba(18, 18, 18, 0.95)',
    position: 'relative',
  },
  upNextChapterAvatarWrapParent: {
    borderColor: 'rgba(79, 195, 247, 0.72)',
  },
  upNextChapterAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
  },
  upNextChapterAvatarFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  upNextChapterAvatarInitial: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '800',
  },
  upNextChapterBadge: {
    position: 'absolute',
    right: -3,
    bottom: -3,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: 'rgba(46, 120, 183, 0.95)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  upNextChapterBadgeParent: {
    backgroundColor: 'rgba(79, 195, 247, 0.95)',
  },
  upNextChapterMore: {
    minWidth: 26,
    height: 24,
    paddingHorizontal: 5,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  upNextChapterMoreText: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 10,
    fontWeight: '800',
  },
  reflectionId: { fontSize: 9, color: 'rgba(255,255,255,0.3)', marginTop: 2, fontFamily: 'Courier' },
  upNextLikeControl: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  upNextLikeControlActive: {
    backgroundColor: 'rgba(79, 195, 247, 0.16)',
    borderColor: 'rgba(79, 195, 247, 0.45)',
  },
  upNextLikeControlPressed: {
    opacity: 0.75,
  },
  upNextLikeCount: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 11,
    fontWeight: '800',
  },
  upNextLikeCountActive: {
    color: '#4FC3F7',
  },
  upNextInfo: { flex: 1, justifyContent: 'center' },
  upNextItemNewArrival: {
    backgroundColor: 'rgba(255, 215, 0, 0.15)', // Soft gold tint
    borderColor: 'rgba(255, 215, 0, 0.5)',
    borderWidth: 1,
  },
  upNextMetaNew: { color: '#FFD700', fontWeight: 'bold', fontSize: 10, marginLeft: 4 },
  newArrivalNotification: {
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: 'rgba(255, 215, 0, 0.2)',
  },
  notificationBlur: {
    paddingVertical: 6,
    paddingHorizontal: 16,
  },
  newArrivalText: {
    color: '#FFD700',
    fontWeight: 'bold',
    fontSize: 14,
    textShadow: '0px 1px 2px rgba(0, 0, 0, 0.75)',
  } as TextStyle,
  deleteButton: { padding: 10, justifyContent: 'center', alignItems: 'center' },
  toast: {
    position: 'absolute',
    bottom: 100,
    left: '50%',
    transform: [{ translateX: -150 }],
    width: 300,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
  },
  toastText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  videoLoadingOverlay: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 50,
  },
  videoLoadingText: {
    color: '#fff',
    marginTop: 10,
    fontSize: 18,
    fontWeight: '600',
  },
  facesModalOverlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: 'rgba(0,0,0,0.62)',
  },
  facesModalCard: {
    width: '100%',
    maxWidth: 430,
    maxHeight: '72%',
    paddingTop: 48,
    paddingHorizontal: 22,
    paddingBottom: 22,
    borderRadius: 28,
    backgroundColor: 'rgba(18, 28, 34, 0.96)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  facesCloseButton: {
    position: 'absolute',
    top: 14,
    right: 14,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
    zIndex: 2,
  },
  facesGrid: {
    alignItems: 'center',
    gap: 18,
  },
  faceGridItem: {
    width: 108,
    height: 108,
    margin: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  faceAvatar: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  faceAvatarFallback: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  faceAvatarInitial: {
    color: '#fff',
    fontSize: 38,
    fontWeight: '900',
  },
  faceCaregiverBadge: {
    position: 'absolute',
    right: 10,
    bottom: 12,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(79, 195, 247, 0.95)',
    borderWidth: 2,
    borderColor: 'rgba(18, 28, 34, 0.96)',
  },
  // --- Admin Styles ---
  lockBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    marginLeft: 10,
  },
  lockText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 10,
    fontWeight: 'bold',
  },
  adminBadge: {
    backgroundColor: '#FF3B30',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    marginLeft: 10,
  },
  adminBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: 'bold',
  },
  adminChallengeOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.8)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  adminChallengeBox: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: '#fff',
    borderRadius: 24,
    padding: 24,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 10,
  },
  adminLockIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(0,122,255,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  adminChallengeTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#1C1C1E',
    marginBottom: 8,
  },
  adminChallengeSub: {
    fontSize: 14,
    color: '#8E8E93',
    textAlign: 'center',
    marginBottom: 20,
  },
  mathProblem: {
    fontSize: 32,
    fontWeight: '700',
    color: '#007AFF',
    marginBottom: 20,
  },
  adminInput: {
    width: '60%',
    height: 60,
    backgroundColor: '#F2F2F7',
    borderRadius: 16,
    fontSize: 28,
    textAlign: 'center',
    color: '#000',
    marginBottom: 24,
    borderWidth: 1,
    borderColor: '#E5E5EA',
  },
  adminButtonRow: {
    flexDirection: 'row',
    width: '100%',
    gap: 12,
  },
  adminButton: {
    flex: 1,
    height: 50,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  adminCancelButton: {
    backgroundColor: '#E5E5EA',
  },
  adminCancelButtonText: {
    color: '#3A3A3C',
    fontWeight: '600',
    fontSize: 16,
  },
  adminSubmitButton: {
    backgroundColor: '#007AFF',
  },
  adminButtonText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 16,
  },
});