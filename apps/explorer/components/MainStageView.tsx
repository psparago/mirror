import { FontAwesome } from '@expo/vector-icons';
import {
  coerceThumbnailTimeMs,
  CompanionAvatar,
  Event,
  EventMetadata,
  getCloudMasterTrimWindow,
  getValidVideoTrimMs,
  playerMachine,
  seekVideoToSeconds,
  useThrottledCallback,
} from '@projectmirror/shared';

import { useMachine } from '@xstate/react';
import { Audio } from 'expo-av';
import { BlurView } from 'expo-blur';
import * as Clipboard from 'expo-clipboard';
import { CameraView, PermissionResponse } from 'expo-camera';
import { ExplorerGradientBackdrop } from '@/components/ExplorerGradientBackdrop';
import { useRouter } from 'expo-router';

import * as Speech from 'expo-speech';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Image } from 'expo-image';
import { imageUrlCacheKey } from '@/utils/imageUrlCacheKey';
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
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
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
  }).catch((err) => {
    isAudioModeSet = false;
    console.warn('Reflections: Audio.setAudioModeAsync failed:', err);
  });
}

function trimMeta(s?: string): string {
  return typeof s === 'string' ? s.trim() : '';
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

  return samePlayer && prev.sourceKey === next.sourceKey;
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
  onCaptureSelfie: () => Promise<void>;
  // Called when MainStage becomes "idle" (playback finished or user dismissed).
  // Used by the parent to flush pending work (e.g. selfie upload queue).
  onPlaybackIdle?: () => void;
  onMediaError?: (event: Event) => void;
  cameraRef: React.RefObject<CameraView>;
  cameraPermission: PermissionResponse | null;
  requestCameraPermission: () => Promise<PermissionResponse>;
  isCapturingSelfie: boolean;
  readEventIds: string[];
  recentlyArrivedIds: string[]; // State for items that arrived during this session
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
    /** When false, skips automatic selfie capture after reflections (default: on). */
    takeSelfie?: boolean;
  };
  filterBar?: React.ReactNode;
  /** Shown in the header as "{name}'s Reflections" when multiple items exist. */
  explorerDisplayName?: string | null;
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
  onCaptureSelfie,
  onPlaybackIdle,
  onMediaError,
  cameraRef,
  cameraPermission,
  requestCameraPermission,
  isCapturingSelfie,
  readEventIds,
  recentlyArrivedIds,
  onReplay,
  config,
  filterBar,
  explorerDisplayName,
}: MainStageProps) {
  // Perf: keep console logging opt-in; excessive logs + JSON.stringify can jank Hermes.
  const DEBUG_TRANSITIONS = __DEV__ && false;
  const DEBUG_LOGS = __DEV__ && false;
  const debugLog = (...args: any[]) => {
    if (DEBUG_LOGS) console.log(...args);
  };

  useEffect(() => {
    ensureExplorerAudioSessionOnce();
  }, []);

  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const insets = useSafeAreaInsets();
  const router = useRouter();


  // --- LOCAL STATE (Visuals Only) ---
  // Reanimated shared values
  const flashOpacity = useSharedValue(0);
  const controlsOpacity = useSharedValue(0); // 0 = Hidden
  const selfieMirrorOpacity = useSharedValue(0);
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

  const handleLikePress = useCallback(() => {
    if (!selectedEvent?.event_id || !currentUserId || !onToggleLike) {
      return;
    }
    heartScale.value = withSpring(1.28, { damping: 8, stiffness: 260 }, () => {
      heartScale.value = withSpring(1, { damping: 10, stiffness: 240 });
    });
    onToggleLike(selectedEvent.event_id, currentUserId, !likedByCurrentUser);
  }, [currentUserId, heartScale, likedByCurrentUser, onToggleLike, selectedEvent?.event_id]);

  useEffect(() => {
    setShowLikeFaces(false);
    setLikeFacesLikedBy(null);
  }, [selectedEvent?.event_id]);

  const positionText = useMemo(() => {
    if (!selectedEvent || events.length === 0) return '';
    const idx = events.findIndex(e => e.event_id === selectedEvent.event_id);
    if (idx === -1) return '';
    return `${idx + 1} of ${events.length}`;
  }, [events, selectedEvent?.event_id]);

  // Track previous event to prevent restart loops
  const prevEventIdRef = useRef<string | null>(null);
  const lastVideoFinishedEventIdRef = useRef<string | null>(null);
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
  const onCaptureSelfieRef = useRef(onCaptureSelfie);
  const onReplayRef = useRef(onReplay);
  const selectedMetadataRef = useRef(selectedMetadata);
  const onPlaybackIdleRef = useRef(onPlaybackIdle);
  const configRef = useRef(config);
  configRef.current = config;

  // Bridge pattern refs for machine actions
  const sendRef = useRef<any>(() => { });
  const soundRef = useRef<Audio.Sound | null>(null);
  const playerRef = useRef<any>(null);
  const captionSoundRefForActions = useRef<Audio.Sound | null>(null);
  const performSelfieCaptureRef = useRef<((delay?: number) => Promise<void>) | null>(null);
  const clearHeavyMediaRefsRef = useRef<() => void>(() => { });

  // --- THE XSTATE MACHINE ---
  const machine = useMemo(() => playerMachine.provide({
    actions: {
      stopAllMedia: async () => {
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
        controlsOpacity.value = withTiming(0, { duration: 300 });

        // Clear caption/sparkle playing state
        setIsCaptionOrSparklePlayingRef.current(false);

        // Small delay to ensure everything stops
        await new Promise(resolve => setTimeout(resolve, 100));
      },

      speakCaption: async () => {
        const meta = selectedMetadataRef.current;
        const text = trimMeta(meta?.short_caption) || trimMeta(meta?.description);
        const audioUrl = selectedEventRef.current?.audio_url;

        // Use current session (already incremented by stopAllMedia or initial)
        const thisSession = captionSessionRef.current;
        debugLog(`🎙️ speakCaption [Session: ${thisSession}]`);

        controlsOpacity.value = withTiming(0, { duration: 300 });

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
        // Preparation logic for video
        if (!playerRef.current) return;

        debugLog(`🎬 playVideo called: status=${playerRef.current.status}`);

        const trim = getCloudMasterTrimWindow(selectedMetadataRef.current);
        seekVideoToSeconds(playerRef.current, trim.active ? trim.startSec : 0);

        // Trigger bubble animation (only when automatic selfie is enabled)
        if (configRef.current?.takeSelfie !== false) {
          selfieMirrorOpacity.value = withTiming(1, { duration: 500 });
        }

        // The actual .play() call is now managed by the Hardware Sync useEffect for maximum reliability
      },

      playAudio: async () => {
        const playWithRetry = async (retryCount = 0): Promise<void> => {
          try {
            if (soundRef.current) await soundRef.current.unloadAsync();

            if (!selectedEventRef.current?.audio_url) {
              sendRef.current({ type: 'AUDIO_FINISHED' });
              return;
            }

            debugLog(`🎧 Playing audio: ${selectedEventRef.current.audio_url.substring(0, 80)}... (Attempt ${retryCount + 1})`);
            const { sound: newSound } = await Audio.Sound.createAsync(
              { uri: selectedEventRef.current.audio_url as string },
              {
                shouldPlay: true,
                progressUpdateIntervalMillis: EXPO_AV_PROGRESS_INTERVAL_MS,
              }
            );

            newSound.setOnPlaybackStatusUpdate((status) => {
              if (status.isLoaded && status.didJustFinish) {
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

      showSelfieBubble: () => {
        if (configRef.current?.takeSelfie === false) return;
        selfieMirrorOpacity.value = 1;
      },

      triggerSelfie: async () => {
        if (performSelfieCaptureRef.current) {
          await performSelfieCaptureRef.current(0);
        }
      },

      pauseMedia: async () => {
        if (playerRef.current && stateRef.current?.hasTag('video_mode')) {
          playerRef.current.pause();
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

  // Update all bridge refs
  useEffect(() => {
    sendRef.current = send;
    stateRef.current = state;
    soundRef.current = sound;
    captionSoundRefForActions.current = captionSound;
  }, [send, state, sound, captionSound]);

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
    onPlaybackIdleRef.current?.();
    requestAnimationFrame(onClose);
  }, [sound, captionSound, onClose]);

  const handleSingleTap = useCallback(() => {
    const currentState = stateRef.current;
    const isVideo =
      !!selectedEventRef.current?.video_url || selectedMetadataRef.current?.content_type === 'video';

    if (currentState?.matches('idle') && selectedEventRef.current && selectedMetadataRef.current) {
      debugLog('▶️ Tapped to start playback from idle');
      const useInstantPlayback = config?.instantVideoPlayback && isVideo;
      if (useInstantPlayback) {
        send({
          type: 'SELECT_EVENT_INSTANT',
          event: selectedEventRef.current,
          metadata: selectedMetadataRef.current,
          takeSelfie: configRef.current?.takeSelfie !== false,
        });
      } else {
        send({
          type: 'SELECT_EVENT',
          event: selectedEventRef.current,
          metadata: selectedMetadataRef.current,
          takeSelfie: configRef.current?.takeSelfie !== false,
        });
      }
      return;
    }

    // For videos: no pause/resume - only replay when finished
    if (isVideo) {
      if (currentState && (currentState.matches('finished') || currentState.matches({ viewingPhoto: 'viewing' }))) {
        debugLog('🔁 User pressed REPLAY (video)');
        hasAutoPlayedDeepDiveRef.current = false;

        // For videos, respect instant playback config on replay
        const useInstantPlayback = config?.instantVideoPlayback;

        if (useInstantPlayback && selectedEventRef.current && selectedMetadataRef.current) {
          // Replay with instant playback (skip narration)
          debugLog('⚡ Replaying with instant video playback (skipping narration)');
          send({
            type: 'SELECT_EVENT_INSTANT',
            event: selectedEventRef.current,
            metadata: selectedMetadataRef.current,
            takeSelfie: configRef.current?.takeSelfie !== false,
          });
        } else {
          // Standard replay (respects narration for videos)
          send({ type: 'REPLAY' });
        }

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
      debugLog('🔁 User pressed REPLAY');
      hasAutoPlayedDeepDiveRef.current = false;

      // playingAudio doesn't handle REPLAY — re-select the event
      if (currentState.matches('playingAudio') && selectedEventRef.current && selectedMetadataRef.current) {
        send({
          type: 'SELECT_EVENT',
          event: selectedEventRef.current,
          metadata: selectedMetadataRef.current,
          takeSelfie: configRef.current?.takeSelfie !== false,
        });
      } else {
        send({ type: 'REPLAY' });
      }
      if (onReplayRef.current && selectedEventRef.current) {
        onReplayRef.current(selectedEventRef.current);
      }
    }
  }, [send, config?.instantVideoPlayback]);

  const throttledSingleTap = useThrottledCallback(handleSingleTap);

  // Horizontal swipe gesture for next/prev (applied to root container)
  const horizontalSwipeGesture = Gesture.Pan()
    .activeOffsetX([-20, 20]) // Activate after 20px horizontal movement
    .failOffsetY([-30, 30]) // Fail if vertical movement exceeds 30px first
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
        return; // Don't process tap if swipe was detected
      }

      // Handle single tap (only if no significant movement)
      // Stricter threshold to avoid accidental taps during video
      if (Math.abs(event.translationX) < 5 && Math.abs(event.translationY) < 5 && event.velocityX === 0 && event.velocityY === 0) {
        runOnJS(throttledSingleTap)();
      }
    });

  // Vertical swipe gesture for dismiss-to-grid (ONLY on mediaFrame).
  // Swipe DOWN to dismiss (iOS modal-sheet convention: Apple Photos, YouTube minimize, Stories).
  // Activation threshold is aggressive (12px) so the gesture claims the touch before
  // iOS can hand it to the home indicator. A velocity-based commit rescues quick flicks.
  const verticalSwipeGesture = Gesture.Pan()
    .activeOffsetY([-12, 12])
    .failOffsetX([-30, 30])
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

  // Toast opacity shared value
  const toastOpacityShared = useSharedValue(0);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selfieCaptureTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selfieFadeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) {
        clearTimeout(toastTimeoutRef.current);
        toastTimeoutRef.current = null;
      }
      if (selfieCaptureTimeoutRef.current) {
        clearTimeout(selfieCaptureTimeoutRef.current);
        selfieCaptureTimeoutRef.current = null;
      }
      if (selfieFadeTimeoutRef.current) {
        clearTimeout(selfieFadeTimeoutRef.current);
        selfieFadeTimeoutRef.current = null;
      }
      if (deepDiveBreathTimeoutRef.current) {
        clearTimeout(deepDiveBreathTimeoutRef.current);
        deepDiveBreathTimeoutRef.current = null;
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
  const videoSource = selectedEvent?.video_url || null;
  const selectedImageUrl = selectedEvent?.image_url || null;
  const stageImageDimensions = useMemo(() => {
    const stagePaneWidth = isLandscape ? width * 0.7 : width;
    const stagePaneHeight = isLandscape ? height : height * 0.6;
    return {
      width: Math.max(1, Math.round(stagePaneWidth - 40)),
      height: Math.max(1, Math.round(stagePaneHeight - 290)),
    };
  }, [height, isLandscape, width]);
  const [stageImageSource, setStageImageSource] = useState<React.ComponentProps<typeof Image>['source']>(undefined);

  useEffect(() => {
    if (!selectedImageUrl) {
      setStageImageSource(undefined);
      return;
    }

    setStageImageSource({
      uri: selectedImageUrl,
      cacheKey: imageUrlCacheKey(selectedImageUrl),
      width: stageImageDimensions.width,
      height: stageImageDimensions.height,
    });

    return () => {
      setStageImageSource(undefined);
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

  useEffect(() => {
    if (!player) return;
    if (videoSource) {
      try {
        player.replace(videoSource);
        player.timeUpdateEventInterval = 0.25;
      } catch {
        /* teardown / invalid URI */
      }
    } else {
      try {
        player.pause();
        player.replace('');
      } catch {
        /* ignore */
      }
    }
  }, [player, videoSource]);

  // Keep playerRef in sync so machine actions (stopAllMedia, playVideo, etc.) work
  useEffect(() => {
    playerRef.current = player;
  }, [player]);

  const clearHeavyMediaRefs = useCallback(() => {
    setStageImageSource(undefined);
    setVideoReady(false);
    setIsVideoPlaying(false);
    playerRef.current = null;
    selectedEventRef.current = null;
    selectedMetadataRef.current = null;

    if (player) {
      try {
        player.pause();
        player.replace('');
      } catch {
        /* Player may already be released during teardown. */
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
      if (isPlaying) {
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
        const trim = getCloudMasterTrimWindow(selectedMetadataRef.current);
        if (isInPlayingState && player.duration > 0) {
          if (trim.active) {
            // Trim window end is handled by the cloud-master `timeUpdate` listener.
            return;
          }
          if (player.currentTime >= player.duration - 0.5) {
            debugLog('🏁 Video finished (detected via playingChange near end)');
            sendRef.current({ type: 'VIDEO_FINISHED' });

            const currentEventId = selectedEventRef.current?.event_id || null;
            if (currentEventId && lastVideoFinishedEventIdRef.current !== currentEventId) {
              lastVideoFinishedEventIdRef.current = currentEventId;
              onPlaybackIdleRef.current?.();
            }
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
      if (status === 'readyToPlay') {
        const trim = getCloudMasterTrimWindow(selectedMetadataRef.current);
        if (trim.active) {
          seekVideoToSeconds(player, trim.startSec);
        }
        const currentState = stateRef.current;
        const shouldBePlaying = currentState?.matches({ playingVideo: { playback: 'playing' } }) ||
          currentState?.matches({ playingVideoInstant: { playback: 'playing' } });
        if (shouldBePlaying && player && !player.playing) {
          debugLog('⚡ Player became ready while machine expects playback - starting play');
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
  }, [player]);

  // Cleanup video player on unmount to prevent stale playback
  useEffect(() => {
    return () => {
      clearHeavyMediaRefsRef.current();
    };
  }, []);

  // --- ACTIONS IMPLEMENTATION ---

  // Helper for reused selfie logic
  const performSelfieCapture = useCallback(async (delay = 0) => {
    if (configRef.current?.takeSelfie === false) {
      debugLog('📸 Helper: Skipping selfie — disabled in settings');
      return;
    }
    // Ensure permission before starting ANY UI transitions (mirror, flash, etc)
    if (!cameraPermission?.granted) {
      try {
        const result = await requestCameraPermission();
        if (!result.granted) {
          debugLog('📸 Helper: Skipping selfie - camera permission not granted');
          return;
        }
      } catch (error) {
        debugLog('📸 Helper: Skipping selfie - permission request failed', error);
        return;
      }
    }

    debugLog(`📸 Helper: Starting Selfie Sequence (delay: ${delay}ms)`);
    // Fade in mirror
    selfieMirrorOpacity.value = withTiming(1, { duration: 500 });

    // Wait...
    if (selfieCaptureTimeoutRef.current) {
      clearTimeout(selfieCaptureTimeoutRef.current);
    }
    selfieCaptureTimeoutRef.current = setTimeout(async () => {
      debugLog('📸 Helper: Snapping now...');
      // Flash
      flashOpacity.value = withTiming(1, { duration: 150 }, () => {
        flashOpacity.value = withTiming(0, { duration: 250 });
      });

      // Capture
      await onCaptureSelfieRef.current();

      // Fade out
      if (selfieFadeTimeoutRef.current) {
        clearTimeout(selfieFadeTimeoutRef.current);
      }
      selfieFadeTimeoutRef.current = setTimeout(() => {
        debugLog('📸 Helper: Fading out bubble');
        selfieMirrorOpacity.value = withTiming(0, { duration: 500 });
      }, 500);
    }, delay);
  }, [onCaptureSelfie, flashOpacity, selfieMirrorOpacity]);

  // Update performSelfieCapture ref for machine
  useEffect(() => {
    performSelfieCaptureRef.current = performSelfieCapture;
  }, [performSelfieCapture]);

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

    // Videos don't pause - only play or stop. Avoid redundant player.play() — limits bridge/native churn (Now Playing).
    if (isMachinePlayingVideo && !isFinished) {
      if (!isVideoPlaying) {
        debugLog('⚡ Hardware Sync: Playing Video');
        const trim = getCloudMasterTrimWindow(selectedMetadataRef.current);
        if (trim.active) {
          const t = player.currentTime;
          if (t >= trim.endSec - 0.05 || t < trim.startSec - 0.05) {
            seekVideoToSeconds(player, trim.startSec);
          }
        }
        if (player && !player.playing) {
          player.play();
        }
      }
    }
    // Removed pause handling for videos - they play through or finish
  }, [state.value, player, isVideoPlaying]);

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
    selectedEventRef.current = selectedEvent;
    stateRef.current = state;
    onEventSelectRef.current = onEventSelect;
    onDeleteRef.current = onDelete;
    onCaptureSelfieRef.current = onCaptureSelfie;
    onReplayRef.current = onReplay;
    selectedMetadataRef.current = selectedMetadata;
    onPlaybackIdleRef.current = onPlaybackIdle;
    configRef.current = config;
  }, [events, selectedEvent, state, onEventSelect, onDelete, onCaptureSelfie, onReplay, selectedMetadata, config]);

  // Notify parent when we enter the finished state (video/audio/narration completed).
  const wasFinishedRef = useRef(false);
  useEffect(() => {
    const isFinished = !!state && state.matches('finished');
    if (isFinished && !wasFinishedRef.current) {
      onPlaybackIdleRef.current?.();
    }
    wasFinishedRef.current = isFinished;
  }, [state?.value]);

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
  }, [captionCycleDone, selectedEvent?.event_id, selectedMetadata?.deep_dive, selectedEvent?.deep_dive_audio_url, config?.autoPlayDeepDive, send, playDeepDiveDirectly]);

  // --- SYNC REACT EVENTS TO MACHINE ---

  // 1. New Event Selected (ONLY when event_id actually changes)
  useEffect(() => {
    const currentEventId = selectedEvent?.event_id || null;

    if (!selectedMetadata) return;

    // Only send SELECT_EVENT if the event ID actually changed
    if (currentEventId && currentEventId !== prevEventIdRef.current) {
      // We are leaving the previous reflection; treat this as an "idle" moment for parent work
      // (e.g. flush pending selfie upload queue).
      if (prevEventIdRef.current) {
        onPlaybackIdleRef.current?.();
      }
      prevEventIdRef.current = currentEventId;
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
        send({
          type: 'SELECT_EVENT_INSTANT',
          event: selectedEvent!,
          metadata: selectedMetadata!,
          takeSelfie: config?.takeSelfie !== false,
        });
      } else {
        send({
          type: 'SELECT_EVENT',
          event: selectedEvent!,
          metadata: selectedMetadata!,
          takeSelfie: config?.takeSelfie !== false,
        });
      }

      // Reset swipe-to-dismiss animation values for fresh overlay opening
      translateY.value = 0;
      scale.value = 1;
      opacity.value = 1;

      // Auto-scroll the list to show the selected item (bounds + fallbacks in performUpNextAutoscrollToEvent).
      performUpNextAutoscrollToEvent(currentEventId);
    }
  }, [selectedEvent?.event_id, selectedEvent, selectedMetadata, send, translateY, scale, opacity, config?.instantVideoPlayback, config?.takeSelfie, performUpNextAutoscrollToEvent]);

  // 2. Video Player Finished (Event Listener)
  useEffect(() => {
    if (!player) return;

    // Listen for the specific "End of Stream" event from the native player
    const subscription = player.addListener('playToEnd', () => {
      // Guard: Only process if the machine is actually in a video-playing state.
      // This prevents spurious VIDEO_FINISHED signals during source replacement
      // or when the player emits stale events from a previous video.
      const currentState = stateRef.current;
      const isInPlayingState = currentState?.matches({ playingVideo: { playback: 'playing' } }) ||
        currentState?.matches({ playingVideoInstant: { playback: 'playing' } });

      if (!isInPlayingState) {
        debugLog('🏁 playToEnd received but not in playing state - ignoring');
        return;
      }

      debugLog('🏁 Video playToEnd event received');

      // Tell the machine we are done
      send({ type: 'VIDEO_FINISHED' });

      // Notify parent if needed (legacy logic)
      const currentEventId = selectedEventRef.current?.event_id || null;
      if (currentEventId && lastVideoFinishedEventIdRef.current !== currentEventId) {
        lastVideoFinishedEventIdRef.current = currentEventId;
        onPlaybackIdleRef.current?.();
      }
    });

    return () => {
      subscription.remove();
    };
  }, [player, send]);

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
      if (player.currentTime >= endSec - 0.03) {
        try {
          player.pause();
        } catch {
          /* ignore */
        }
        debugLog('🏁 Cloud master: trim window end (timeUpdate)');
        sendRef.current({ type: 'VIDEO_FINISHED' });
        const currentEventId = selectedEventRef.current?.event_id || null;
        if (currentEventId && lastVideoFinishedEventIdRef.current !== currentEventId) {
          lastVideoFinishedEventIdRef.current = currentEventId;
          onPlaybackIdleRef.current?.();
        }
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
  ]);

  // 3. Rewind video on completion for deep dive context
  useEffect(() => {
    if (state?.matches('finished') && player && (selectedMetadata?.content_type === 'video' || !!selectedEvent?.video_url)) {
      debugLog('🏁 Rewinding video to start for deep dive context');
      player.pause();
      const trim = getCloudMasterTrimWindow(selectedMetadata);
      seekVideoToSeconds(player, trim.active ? trim.startSec : 0);
    }
  }, [state?.matches('finished'), player, selectedMetadata, selectedEvent]);

  // 4. Show/Hide Controls AND Bubble Based on State
  useEffect(() => {
    if (!state) return;

    const isVideo = !!selectedEvent?.video_url;

    if (state.matches('idle')) {
      controlsOpacity.value = withTiming(1, { duration: 200 });
      selfieMirrorOpacity.value = withTiming(0, { duration: 500 });
    } else if (state.matches('finished')) {
      // Finished: Show controls AND hide bubble
      controlsOpacity.value = withTiming(1, { duration: 200 });
      selfieMirrorOpacity.value = withTiming(0, { duration: 500 });
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
  }, [state, controlsOpacity, selfieMirrorOpacity]);

  // 4. ANIMATIONS (VU Meter & Pulse)
  const isMachineSpeaking = state && (state.matches({ playingVideo: { playback: 'narratingCaption' } }) ||
    state.matches({ playingVideoInstant: { playback: 'narratingCaption' } }) ||
    state.matches({ viewingPhoto: 'narrating' }) ||
    state.matches({ playingDeepDive: { active: 'playing' } }));
  const isPlayingAudioState = state && state.matches('playingAudio');
  const isAnyAudioPlaying = isMachineSpeaking || isPlayingAudioState || isVideoPlaying;

  useEffect(() => {
    if (isAnyAudioPlaying) {
      // Use Reanimated worklet for loop animation
      const loop = () => {
        'worklet';
        audioIndicatorAnim.value = withTiming(1, { duration: 300 }, () => {
          audioIndicatorAnim.value = withTiming(0.7, { duration: 300 }, loop);
        });
      };
      loop();
    } else {
      audioIndicatorAnim.value = 0.7;
    }
  }, [isAnyAudioPlaying]);

  // Pulse animation for Tell Me More button
  useEffect(() => {
    if (state && (state.matches('finished') || state.matches({ viewingPhoto: 'viewing' }))) {
      const loop = () => {
        'worklet';
        tellMeMorePulse.value = withTiming(1.15, { duration: 600 }, () => {
          tellMeMorePulse.value = withTiming(1, { duration: 600 }, loop);
        });
      };
      loop();
    } else {
      tellMeMorePulse.value = 1;
    }
  }, [state]);


  // --- RENDERING HELPERS ---

  const handleReplayImpl = useCallback(() => {
    hasAutoPlayedDeepDiveRef.current = false;
    setIsDeepDivePending(false);

    Speech.stop();
    if (soundRef.current) {
      soundRef.current.stopAsync().catch(() => { });
      soundRef.current.unloadAsync().catch(() => { });
      soundRef.current = null;
    }
    setIsCaptionOrSparklePlaying(false);

    debugLog('🔁 User pressed REPLAY');

    if (state.matches('playingAudio') && selectedEventRef.current && selectedMetadataRef.current) {
      send({
        type: 'SELECT_EVENT',
        event: selectedEventRef.current,
        metadata: selectedMetadataRef.current,
        takeSelfie: configRef.current?.takeSelfie !== false,
      });
    } else {
      const isVideo = !!selectedEventRef.current?.video_url;
      const useInstantPlayback = config?.instantVideoPlayback && isVideo;

      if (useInstantPlayback && selectedEventRef.current && selectedMetadataRef.current) {
        debugLog('⚡ Replaying with instant video playback (skipping narration)');
        send({
          type: 'SELECT_EVENT_INSTANT',
          event: selectedEventRef.current,
          metadata: selectedMetadataRef.current,
          takeSelfie: configRef.current?.takeSelfie !== false,
        });
      } else {
        send({ type: 'REPLAY' });
      }
    }

    if (onReplayRef.current && selectedEventRef.current) {
      onReplayRef.current(selectedEventRef.current);
    }
  }, [state, send, config?.instantVideoPlayback]);

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
    if (recentlyArrivedIds.length === 0 || !flatListRef.current) return;

    const evs = eventsRef.current;
    const newestIndex = evs.findIndex(e => recentlyArrivedIds.includes(e.event_id));
    if (newestIndex < 0 || newestIndex >= evs.length) return;

    debugLog(`📜 Scrolling and playing newest arrival at index ${newestIndex}`);

    onEventSelect(evs[newestIndex]);
    scrollFlatListToDataIndex(newestIndex, true);
  };

  const renderUpNextItem = ({ item }: { item: Event }) => {
    const itemMetadata = eventMetadata[item.event_id];
    const isNowPlaying = item.event_id === selectedEvent?.event_id;
    const isRead = readEventIds.includes(item.event_id);
    const isNewArrival = recentlyArrivedIds.includes(item.event_id);
    const itemLikedBy = reflectionLikes[item.event_id] ?? [];
    const itemLikedByMe = !!currentUserId && itemLikedBy.includes(currentUserId);
    const itemLikeCount = itemLikedBy.length;

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
  const showReplayOverlay =
    !isCaptionOrSparklePlaying &&
    !isDeepDivePending &&
    (isInFinishedState || isCaptionDoneForPhoto || isAudioPlaybackDone);
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

  const selfieMirrorAnimatedStyle = useAnimatedStyle(() => ({
    opacity: selfieMirrorOpacity.value,
  }));

  const flashAnimatedStyle = useAnimatedStyle(() => ({
    opacity: flashOpacity.value,
  }));

  const audioIndicatorAnimatedStyle = useAnimatedStyle(() => ({
    opacity: audioIndicatorAnim.value,
  }));

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
                    {recentlyArrivedIds.length > 0 ? (
                      <TouchableOpacity
                        onPress={scrollToNewestArrival}
                        style={styles.newArrivalNotification}
                        activeOpacity={0.7}
                      >
                        <BlurView intensity={STATIC_BLUR_INTENSITY} style={styles.notificationBlur}>
                          <Text style={styles.newArrivalText}>✨ {recentlyArrivedIds.length} New Reflection{recentlyArrivedIds.length > 1 ? 's' : ''}</Text>
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

              {/* Avatar Filter Bar */}
              {filterBar && (
                <View style={[styles.stageFilterBar, { top: insets.top + 38 }]}>
                  {filterBar}
                </View>
              )}

              {/* Media Container */}
              <View style={styles.mediaContainer}>
                <GestureDetector gesture={verticalSwipeGesture}>
                  <Animated.View style={styles.mediaFrame}>
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
                        recyclingKey={selectedEvent.event_id}
                        cachePolicy="memory-disk"
                        priority="high"
                      />
                    )}
                    {/* Play/Replay overlay */}
                    <Animated.View
                      style={[styles.playOverlay, controlsAnimatedStyle]}
                      pointerEvents={showPlayOverlay || showReplayOverlay ? 'auto' : 'none'}
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
                  </Animated.View>
                </GestureDetector>

                {/* Loading Indicator removed - was blocking video */}
              </View>

              {/* Caption & Metadata */}
              <View style={[styles.metadataContainer, { paddingBottom: insets.bottom + 16 }]}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                  {/* VU Meter for audio playback */}
                  {isAnyAudioPlaying && (
                    <Animated.View style={[audioIndicatorAnimatedStyle, { marginRight: 12, marginTop: 2 }]}>
                      <FontAwesome name="volume-up" size={20} color="rgba(255, 255, 255, 0.9)" />
                    </Animated.View>
                  )}

                  <View style={{ flex: 1 }}>
                    {/* Caption/Description - FIRST */}
                    <Text style={styles.descriptionText} numberOfLines={2}>
                      {displayCaptionFrom(selectedMetadata, selectedEvent)}
                    </Text>

                    {/* From + Date line - SECOND */}
                    {selectedMetadata?.sender && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6 }}>
                        <Text style={styles.senderText}>
                          From {selectedMetadata.sender}
                        </Text>
                        {selectedEvent?.event_id && (
                          <Text style={styles.dateText}>
                            {' • '}{formatEventDateFromId(selectedEvent.event_id)}
                          </Text>
                        )}
                      </View>
                    )}

                    {selectedEvent?.event_id ? (
                      <View style={styles.stageLikeRow}>
                        <Animated.View style={heartAnimatedStyle}>
                          <TouchableOpacity
                            style={[styles.stageLikeButton, likedByCurrentUser && styles.stageLikeButtonActive]}
                            onPress={handleLikePress}
                            onLongPress={() => {
                              if (likeCount > 0) {
                                setLikeFacesLikedBy(null);
                                setShowLikeFaces(true);
                              }
                            }}
                            activeOpacity={0.72}
                            accessibilityLabel={likedByCurrentUser ? 'Unlike this Reflection' : 'Like this Reflection'}
                          >
                            <FontAwesome
                              name={likeCount > 0 ? 'heart' : 'heart-o'}
                              size={16}
                              color={likedByCurrentUser ? '#4FC3F7' : likeCount > 0 ? 'rgba(255,255,255,0.62)' : 'rgba(255,255,255,0.82)'}
                            />
                          </TouchableOpacity>
                        </Animated.View>
                        {likeCount > 0 ? (
                          <Pressable
                            onPress={() => {
                              setLikeFacesLikedBy(null);
                              setShowLikeFaces(true);
                            }}
                            onLongPress={() => {
                              setLikeFacesLikedBy(null);
                              setShowLikeFaces(true);
                            }}
                            hitSlop={12}
                            style={({ pressed }) => [styles.stageLikeCountButton, pressed && styles.stageLikeCountButtonPressed]}
                            accessibilityRole="button"
                            accessibilityLabel="Show who liked this Reflection"
                          >
                            <Text style={styles.stageLikeCount}>{likeCount}</Text>
                          </Pressable>
                        ) : null}
                      </View>
                    ) : null}

                    {selectedEvent?.event_id ? (
                      <Pressable
                        onPress={async () => {
                          try {
                            await Clipboard.setStringAsync(selectedEvent.event_id);
                            showToast('Copied reflection ID');
                          } catch {
                            showToast('Could not copy');
                          }
                        }}
                        style={({ pressed }) => [styles.eventIdPressable, pressed && styles.eventIdPressablePressed]}
                        accessibilityRole="button"
                        accessibilityLabel={`Reflection ID ${selectedEvent.event_id}`}
                        accessibilityHint="Copies the reflection ID to the clipboard"
                      >
                        <Text style={styles.eventIdLabel}>Reflection ID: </Text>
                        <Text style={styles.eventIdText}>{selectedEvent.event_id}</Text>
                      </Pressable>
                    ) : null}
                  </View>

                  {/* Play Caption Button - for videos and photos */}
                  {(() => {
                    const isMediaPlaying = state.hasTag('playing') || state.hasTag('speaking');
                    const isDisabled = isMediaPlaying || isCaptionOrSparklePlaying;

                    return (
                      selectedEvent?.audio_url ||
                      trimMeta(selectedMetadata?.short_caption) ||
                      trimMeta(selectedMetadata?.description)
                    ) && (
                      <TouchableOpacity
                        style={[
                          styles.playCaptionButton,
                          isDisabled && styles.playCaptionButtonDisabled,
                          isCaptionOrSparklePlaying && styles.playCaptionButtonWhileNarration,
                        ]}
                        onPress={throttledPlayCaptionPress}
                        activeOpacity={isDisabled ? 1 : 0.7}
                        disabled={isDisabled}
                      >
                        <FontAwesome
                          name="volume-up"
                          size={18}
                          color={
                            isCaptionOrSparklePlaying
                              ? 'rgba(255, 255, 255, 0.22)'
                              : isDisabled
                                ? 'rgba(255, 255, 255, 0.3)'
                                : 'rgba(255, 255, 255, 0.8)'
                          }
                        />
                      </TouchableOpacity>
                    );
                  })()}
                </View>

                {/* Tell Me More FAB */}
                {selectedMetadata?.deep_dive && state && (() => {
                  const isFinished = state.matches('finished');
                  const isViewingPhoto = state.matches('viewingPhoto');
                  const isNarrating = state.matches({ viewingPhoto: 'narrating' });
                  // Check if audio is done but stuck waiting for selfie (for images with audio_url)
                  const isAudioDoneButStuck = state.matches({ playingAudio: { playback: 'done' } });
                  const canShow = isFinished || isAudioDoneButStuck || (isViewingPhoto && !isNarrating);
                  const isMediaPlaying = state.hasTag('playing') || state.hasTag('speaking');
                  const isSparkleDisabled = isCaptionOrSparklePlaying || isMediaPlaying;
                  if (!canShow) return null;
                  return (
                    <Animated.View
                      key="tellMeMore"
                      style={[
                        styles.tellMeMoreFAB,
                        tellMeMoreAnimatedStyle,
                        isCaptionOrSparklePlaying && styles.tellMeMoreFABNarration,
                      ]}
                    >
                      <TouchableOpacity
                        onPress={throttledTellMeMorePress}
                        style={{
                          flex: 1,
                          justifyContent: 'center',
                          alignItems: 'center',
                          opacity: isSparkleDisabled ? 0.32 : 1,
                        }}
                        disabled={isSparkleDisabled}
                        activeOpacity={isSparkleDisabled ? 1 : 0.7}
                      >
                        <Animated.View style={[styles.tellMeMoreBlurOpacity, tellMeMoreBlurOpacityAnimatedStyle]}>
                          <BlurView
                            intensity={STATIC_BLUR_INTENSITY}
                            style={[
                              styles.tellMeMoreBlur,
                              isCaptionOrSparklePlaying && styles.tellMeMoreBlurDimmed,
                            ]}
                          >
                            <Text style={{ fontSize: 32, opacity: isCaptionOrSparklePlaying ? 0.5 : 1 }}>✨</Text>
                          </BlurView>
                        </Animated.View>
                      </TouchableOpacity>
                    </Animated.View>
                  );
                })()}
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

          {/* Selfie Mirror - Rendered at ROOT level to override native Image/Video layers */}
          <Animated.View style={[styles.cameraBubble, {
            top: insets.top + 16,
            // In landscape, offset by right pane width (30%) to keep bubble in left pane
            right: isLandscape ? (width * 0.3 + insets.right + 16) : (insets.right + 16),
          }, selfieMirrorAnimatedStyle]}>
            {cameraPermission?.granted ? (
              <CameraView ref={cameraRef} style={styles.cameraPreview} facing="front" />
            ) : null}
            <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: 'white' }, flashAnimatedStyle]} />
          </Animated.View>

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
    paddingTop: 170,
    paddingBottom: 120,
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
  mediaImage: { width: '100%', height: '100%', resizeMode: 'contain' },
  playOverlay: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 20,
    elevation: 20,
  },
  playButton: { width: 120, height: 120, borderRadius: 60, overflow: 'hidden', justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0, 0, 0, 0.3)' },
  playOverlayBlur: { width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(255, 255, 255, 0.1)' },
  cameraBubble: { position: 'absolute', width: 100, height: 100, borderRadius: 50, overflow: 'hidden', borderWidth: 2, borderColor: '#fff', zIndex: 99999, elevation: 10 },
  cameraPreview: { flex: 1 },
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
    backgroundColor: 'rgba(79, 195, 247, 0.2)',
    borderColor: 'rgba(79, 195, 247, 0.55)',
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