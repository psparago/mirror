import MainStageView, { ensureExplorerAudioSessionOnce } from '@/components/MainStageView';
import { ExplorerGradientBackdrop } from '@/components/ExplorerGradientBackdrop';
import { DEFAULT_AUTOPLAY, DEFAULT_INSTANT_VIDEO_PLAYBACK, DEFAULT_TAKE_SELFIE } from '@/constants/Defaults';
import { FontAwesome } from '@expo/vector-icons';
import {
  API_ENDPOINTS,
  AvatarFilterBar,
  coerceThumbnailTimeMs,
  Event,
  EventMetadata,
  ExplorerConfig,
  getValidVideoTrimFromFields,
  ListEventsResponse,
  toggleReflectionLike,
  useCompanionAvatars,
  useThrottledCallback,
  WaitOverlay,
} from '@projectmirror/shared';
import {
  auth,
  collection,
  db,
  deleteDoc,
  doc,
  getDoc,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch
} from '@projectmirror/shared/firebase';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio } from 'expo-av';
import { BlurView } from 'expo-blur';
import * as Clipboard from 'expo-clipboard';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as FileSystem from 'expo-file-system';
import { Image } from 'expo-image';
import { imageUrlCacheKey } from '@/utils/imageUrlCacheKey';
import * as ImageManipulator from 'expo-image-manipulator';
import { useFocusEffect, useRouter } from 'expo-router';
import * as Speech from 'expo-speech';
import type { QuerySnapshot } from 'firebase/firestore';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, AppStateStatus, FlatList, Modal, Platform, Pressable, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useExplorerSelf } from '../../context/ExplorerSelfContext';

function eventHasEmbeddedMetadata(event: Event): boolean {
  const m = event.metadata;
  if (!m || typeof m !== 'object') return false;
  return (
    typeof m.description === 'string' ||
    typeof m.short_caption === 'string' ||
    typeof m.sender === 'string' ||
    typeof m.deep_dive === 'string'
  );
}

const coerceLikedBy = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((uid): uid is string => typeof uid === 'string' && uid.length > 0) : [];

/** Coerce Firestore `metadata` field (plain JSON / Timestamp) into EventMetadata. */
function normalizeFirestoreMetadata(raw: unknown, fallbackEventId: string): EventMetadata | null {
  try {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    const description = typeof o.description === 'string' ? o.description : '';
    const shortCaption = typeof o.short_caption === 'string' ? o.short_caption : '';
    const sender = typeof o.sender === 'string' ? o.sender : '';
    const deepDive = typeof o.deep_dive === 'string' ? o.deep_dive : '';

    const trimPair = getValidVideoTrimFromFields(o.video_start_ms, o.video_end_ms);
    const hasVideoTrim =
      trimPair !== null &&
      typeof trimPair.startMs === 'number' &&
      typeof trimPair.endMs === 'number';

    if (!description && !shortCaption && !sender && !deepDive && !hasVideoTrim) return null;

    const ts = o.timestamp;
    let timestamp: string;
    if (typeof ts === 'string') {
      timestamp = ts;
    } else if (ts && typeof ts === 'object' && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
      timestamp = (ts as { toDate: () => Date }).toDate().toISOString();
    } else {
      timestamp = new Date().toISOString();
    }

    const captionSeed = shortCaption || description || (deepDive ? deepDive.trim().slice(0, 120) : '') || 'Reflection';
    const meta: EventMetadata = {
      description: description || shortCaption || captionSeed,
      sender: sender || 'Companion',
      timestamp,
      event_id: typeof o.event_id === 'string' ? o.event_id : fallbackEventId,
    };
    if (typeof o.sender_id === 'string') meta.sender_id = o.sender_id;
    if (o.content_type === 'text' || o.content_type === 'audio' || o.content_type === 'video') {
      meta.content_type = o.content_type;
    }
    if (o.image_source === 'camera' || o.image_source === 'search' || o.image_source === 'gallery') {
      meta.image_source = o.image_source;
    }
    if (shortCaption) meta.short_caption = shortCaption;
    else if (description) meta.short_caption = description;
    else if (deepDive.trim()) meta.short_caption = captionSeed;
    if (typeof o.deep_dive === 'string') meta.deep_dive = o.deep_dive;

    if (hasVideoTrim && trimPair !== null) {
      meta.video_start_ms = trimPair.startMs;
      meta.video_end_ms = trimPair.endMs;
    }
    const thumbMs = coerceThumbnailTimeMs(o.thumbnail_time_ms);
    if (thumbMs !== undefined) {
      meta.thumbnail_time_ms = thumbMs;
    }

    return meta;
  } catch (e) {
    if (__DEV__) {
      console.warn('[normalizeFirestoreMetadata]', fallbackEventId, e);
    }
    return null;
  }
}

const EVENT_DATE_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;
const STATIC_BLUR_INTENSITY = 20;

/** Avoid Intl / toLocaleDateString on hot paths (large reflection lists). */
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

export default function HomeScreen() {
  const router = useRouter();

  // Keep debug logging opt-in (Metro logs are noisy and can affect perf during testing).
  const DEBUG_LOGS = __DEV__ && false;
  const debugLog = (...args: any[]) => {
    if (DEBUG_LOGS) console.log(...args);
  };

  const [events, setEvents] = useState<Event[]>([]);
  const [recentlyArrivedIds, setRecentlyArrivedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);
  const [eventMetadata, setEventMetadata] = useState<{ [key: string]: EventMetadata }>({});
  const [reflectionLikes, setReflectionLikes] = useState<Record<string, string[]>>({});
  const [gridLikeFacesLikedBy, setGridLikeFacesLikedBy] = useState<string[] | null>(null);
  const [isCapturingSelfie, setIsCapturingSelfie] = useState(false);
  const selfieUploadInFlightRef = useRef(false);

  const SELFIE_QUEUE_KEY = 'selfie_upload_queue';
  const cameraRef = useRef<CameraView>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const insets = useSafeAreaInsets();
  const engagementTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasEngagedRef = useRef<{ [eventId: string]: boolean }>({});
  const selectedEventIdRef = useRef<string | null>(null);
  const hasReplayedRef = useRef<{ [eventId: string]: boolean }>({});
  const refreshingEventsRef = useRef<Set<string>>(new Set()); // Track events currently being refreshed
  const [readEventIds, setReadEventIds] = useState<string[]>([]);
  const readEventIdsRef = useRef<string[]>([]);
  const [isReadStateLoaded, setIsReadStateLoaded] = useState(false);

  // Responsive column count: 2 for iPhone, 4-5 for iPad
  const numColumns = width >= 768 ? (width >= 1024 ? 5 : 4) : 2;
  const gridThumbnailSize = useMemo(() => {
    const listHorizontalPadding = 16;
    const cardHorizontalMargins = numColumns * 12;
    const thumbnailWidth = Math.max(1, Math.floor((width - listHorizontalPadding - cardHorizontalMargins) / numColumns));
    return {
      width: thumbnailWidth,
      height: Math.max(1, Math.round(thumbnailWidth * 9 / 16)),
    };
  }, [numColumns, width]);

  // Explorer config with state for toggleable settings
  const [autoplay, setAutoplay] = useState(DEFAULT_AUTOPLAY);
  const [enableInfiniteScroll, setEnableInfiniteScroll] = useState(true);
  const [instantVideoPlayback, setInstantVideoPlayback] = useState(DEFAULT_INSTANT_VIDEO_PLAYBACK);
  const [takeSelfie, setTakeSelfie] = useState(DEFAULT_TAKE_SELFIE);
  const [readVideoCaptions, setReadVideoCaptions] = useState(false);
  const [startIdleOnInitialSelection, setStartIdleOnInitialSelection] = useState(false);
  const [copyToastMessage, setCopyToastMessage] = useState<string | null>(null);
  const copyToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  //const { currentExplorerId, loading: explorerLoading } = useExplorer();
  const { explorerId: currentExplorerId, explorerData } = useExplorerSelf();

  const explorerDisplayName = useMemo(() => {
    const d = explorerData as Record<string, unknown> | null | undefined;
    if (!d || typeof d !== 'object') return null;
    const raw = d.displayName ?? d.display_name ?? d.name;
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
  }, [explorerData]);

  // Companion avatar filter
  const { companions, loading: companionsLoading } = useCompanionAvatars(currentExplorerId);
  const [selectedCompanionId, setSelectedCompanionId] = useState<string | null>(null);
  const gridLikeFaces = useMemo(() => {
    return (gridLikeFacesLikedBy ?? []).map((uid) => {
      const companion = companions.find((c) => c.userId === uid);
      const fallbackName = explorerDisplayName || 'Explorer';
      return {
        uid,
        avatarUrl: companion?.avatarUrl ?? null,
        initial: (companion?.initial ?? fallbackName.trim().charAt(0).toUpperCase()) || '?',
        color: companion?.color ?? '#4FC3F7',
        isCaregiver: !!companion?.isCaregiver,
      };
    });
  }, [companions, explorerDisplayName, gridLikeFacesLikedBy]);

  const filteredEvents = useMemo(() => {
    if (!selectedCompanionId) return events;
    const companion = companions.find(c => c.userId === selectedCompanionId);
    if (!companion) return events;

    return events.filter(e => {
      const meta = eventMetadata[e.event_id];
      if (meta?.sender_id) return meta.sender_id === selectedCompanionId;
      if (meta?.sender) return meta.sender.toLowerCase() === companion.companionName.toLowerCase();
      return false;
    });
  }, [events, eventMetadata, selectedCompanionId, companions]);

  // When filter changes, ensure selectedEvent is still in the filtered list
  useEffect(() => {
    if (!selectedEvent) return;
    const stillVisible = filteredEvents.some(e => e.event_id === selectedEvent.event_id);
    if (!stillVisible && filteredEvents.length > 0) {
      setSelectedEvent(filteredEvents[0]);
    } else if (!stillVisible && filteredEvents.length === 0) {
      setSelectedEvent(null);
    }
  }, [filteredEvents, selectedEvent]);

  const showCopyReflectionIdToast = useCallback((message: string) => {
    if (copyToastTimerRef.current) {
      clearTimeout(copyToastTimerRef.current);
      copyToastTimerRef.current = null;
    }
    setCopyToastMessage(message);
    copyToastTimerRef.current = setTimeout(() => {
      setCopyToastMessage(null);
      copyToastTimerRef.current = null;
    }, 2000);
  }, []);

  useEffect(() => {
    return () => {
      if (copyToastTimerRef.current) {
        clearTimeout(copyToastTimerRef.current);
        copyToastTimerRef.current = null;
      }
    };
  }, []);

  const loadExplorerPreferences = useCallback(() => {
    AsyncStorage.getItem('enableInfiniteScroll').then(value => {
      if (value !== null) {
        setEnableInfiniteScroll(value === 'true');
      }
    }).catch(err => console.warn('Failed to load infinite scroll setting:', err));

    AsyncStorage.getItem('instantVideoPlayback').then(value => {
      if (value !== null) {
        setInstantVideoPlayback(value === 'true');
      }
    }).catch(err => console.warn('Failed to load instant video setting:', err));

    AsyncStorage.getItem('takeSelfie').then(value => {
      if (value !== null) {
        setTakeSelfie(value === 'true');
      }
    }).catch(err => console.warn('Failed to load take selfie setting:', err));

    AsyncStorage.getItem('readVideoCaptions').then(value => {
      if (value !== null) {
        setReadVideoCaptions(value === 'true');
      }
    }).catch(err => console.warn('Failed to load read video captions setting:', err));
  }, []);

  useEffect(() => {
    const firestoreAutoplay = explorerData?.settings?.autoplay;
    setAutoplay(typeof firestoreAutoplay === 'boolean' ? firestoreAutoplay : DEFAULT_AUTOPLAY);
  }, [explorerData?.settings?.autoplay]);

  // Load settings from storage on mount and when returning from Settings
  useEffect(() => {
    loadExplorerPreferences();
  }, [loadExplorerPreferences]);

  useFocusEffect(
    useCallback(() => {
      loadExplorerPreferences();
    }, [loadExplorerPreferences])
  );

  // Memoize config to prevent unnecessary re-renders
  const EXPLORER_CONFIG = useMemo(() => ({
    playVideoCaptions: false,
    autoplay,
    loopFeed: true,
    showStartMarker: true,
    enableInfiniteScroll,
    instantVideoPlayback,
    readVideoCaptions,
    takeSelfie,
  }), [autoplay, enableInfiniteScroll, instantVideoPlayback, readVideoCaptions, takeSelfie]);



  // Play chime sound for new arrivals
  const playArrivalChime = async () => {
    try {
      // Using a local chime asset for reliable playback
      const { sound } = await Audio.Sound.createAsync(
        require('../../assets/sounds/chime.mp3'),
        {
          shouldPlay: true,
          volume: 0.7,
          progressUpdateIntervalMillis: 60_000,
        }
      );
      // Clean up after playing
      sound.setOnPlaybackStatusUpdate((status: any) => {
        if (status.isLoaded && status.didJustFinish) {
          sound.unloadAsync();
        }
      });
      debugLog('🔔 Played arrival chime');
    } catch (error) {
      console.warn('Could not play arrival chime:', error);
    }
  };

  // Fetch events and listen for Firestore updates
  // Fetch events and listen for Firestore updates - Moved below to fix closure staleness

  // Process selfie upload queue (defined before useEffects that use it)
  const processSelfieQueue = useCallback(async () => {
    if (selfieUploadInFlightRef.current) return;
    selfieUploadInFlightRef.current = true;
    try {
      debugLog('[Queue] Phase: Process start');
      while (true) {
        const raw = await AsyncStorage.getItem(SELFIE_QUEUE_KEY);
        const queue = raw ? JSON.parse(raw) : [];
        if (!queue.length) {
          debugLog('[Queue] Phase: Process complete (queue empty)');
          break;
        }

        const job = queue[0];
        const jobStartTime = Date.now();
        debugLog(`[Queue] Processing job for event ${job.originalEventId}`);
        try {
          const fileInfo = await FileSystem.getInfoAsync(job.localUri);
          if (!fileInfo.exists) {
            console.warn('Selfie upload file missing, dropping job:', job.localUri);
            queue.shift();
            await AsyncStorage.setItem(SELFIE_QUEUE_KEY, JSON.stringify(queue));
            continue;
          }

          // Phase: Upload
          const uploadStartTime = Date.now();
          debugLog('[Queue] Phase: Upload to S3 (starting)');
          
          // Get presigned URL for upload
          const presignedUrlStartTime = Date.now();
          const fetchWithRetry = async (retryCount = 0): Promise<Response> => {
            try {
              const res = await fetch(`${API_ENDPOINTS.GET_S3_URL}?path=from&event_id=${job.responseEventId}&filename=image.jpg&explorer_id=${currentExplorerId}`);
              if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
              return res;
            } catch (e: any) {
              if (retryCount < 1) {
                await new Promise(r => setTimeout(r, 1500));
                return fetchWithRetry(retryCount + 1);
              }
              throw e;
            }
          };

          const imageResponse = await fetchWithRetry();
          const imageData = await imageResponse.json();
          const imageUrl = imageData.url;
          const presignedUrlTime = Date.now() - presignedUrlStartTime;
          debugLog(`[Queue] Presigned URL obtained in ${presignedUrlTime}ms`);

          const s3UploadStartTime = Date.now();
          // Yield once; do NOT wait for "no interactions" (that can delay uploads while swiping/scrolling).
          await new Promise(resolve => setTimeout(resolve, 0));
          
          const uploadResult = await FileSystem.uploadAsync(imageUrl, job.localUri, {
            httpMethod: 'PUT',
            headers: { 'Content-Type': 'image/jpeg' },
          });
          const s3UploadTime = Date.now() - s3UploadStartTime;
          debugLog(`[Queue] S3 upload completed in ${s3UploadTime}ms`);

          if (uploadResult.status !== 200) {
            throw new Error(`Selfie upload failed: ${uploadResult.status}`);
          }
          
          const totalUploadTime = Date.now() - uploadStartTime;
          debugLog(`[Queue] Total upload phase: ${totalUploadTime}ms`);

          // Phase: Firestore commit
          debugLog('[Queue] Phase: Firestore commit (atomic batch)');
          // db from shared
          const batch = writeBatch(db);
          const responseRef = doc(db, ExplorerConfig.collections.responses, job.originalEventId);
          const reflectionRef = doc(db, ExplorerConfig.collections.reflections, job.originalEventId);

          batch.set(responseRef, {
            explorerId: job.senderExplorerId,
            viewerExplorerId: job.viewerExplorerId,
            event_id: job.originalEventId,
            response_event_id: job.responseEventId,
            timestamp: serverTimestamp(),
            type: 'selfie_response',
          });

          batch.set(reflectionRef, {
            status: 'responded',
            responded_at: serverTimestamp(),
          }, { merge: true });

          await batch.commit();

          // Cleanup local file (after commit to preserve file for retry if commit fails)
          try {
            await FileSystem.deleteAsync(job.localUri, { idempotent: true });
          } catch (cleanupError) {
            console.warn("Failed to delete selfie upload file:", cleanupError);
          } finally {
            debugLog(`[Queue] Selfie upload file deleted for event ${job.originalEventId}`);
          }
          
          const totalJobTime = Date.now() - jobStartTime;
          debugLog(`[Queue] Job complete for event ${job.originalEventId} (total: ${totalJobTime}ms)`);

          queue.shift();
          await AsyncStorage.setItem(SELFIE_QUEUE_KEY, JSON.stringify(queue));
        } catch (uploadError) {
          console.error('Selfie upload failed (will retry later):', uploadError);
          break;
        }
      }
    } finally {
      selfieUploadInFlightRef.current = false;
    }
  }, []);

  // Auto-refresh events when app comes back to foreground (handles expired URLs and reconnection)
  useEffect(() => {
    const subscription = AppState.addEventListener('change', async (nextAppState: AppStateStatus) => {
      console.log(`📱 [Explorer] AppState: ${nextAppState}`);

      if (nextAppState === 'active') {
        debugLog('🔄 App came to foreground - resuming network and refreshing data');
        processSelfieQueue();

        // Commented out. Firebase should automatically resume network.
        // try {
        //   // 1. Resume Firestore
        //   await enableNetwork(db);
        //   debugLog('✅ Firestore network resumed');
        // } catch (e) {
        //   console.warn('Error resuming Firestore network:', e);
        // }

        // Refresh the overall list
        if (fetchEventsRef.current) {
          fetchEventsRef.current();
        }

        // CRITICAL: Refresh the currently selected event's URLs
        // (URLs likely expired if app was backgrounded for ~1 hour)
        if (selectedEventRef.current) {
          const eventId = selectedEventRef.current.event_id;
          debugLog(`🔄 Auto-refreshing URLs for currently selected event: ${eventId}`);

          // Wait 1 second for app to stabilize before re-triggering playback
          await new Promise(resolve => setTimeout(resolve, 1000));

          refreshEventUrlsRef.current(eventId).then(refreshed => {
            if (refreshed) {
              debugLog(`✅ Successfully refreshed URLs for ${eventId}`);
              // Use a slight hack to force a re-trigger if it's the same object/content
              // by setting to null then back, but better to just set it and ensure MainStage handles it.
              setSelectedEvent(null);
              setTimeout(() => {
                setSelectedEvent(refreshed);
              }, 50);
            }
          }).catch(err => {
            console.warn(`❌ Failed to auto-refresh current event ${eventId}:`, err);
          });
        }
      } else if (nextAppState === 'background' || nextAppState === 'inactive') {
        // Commented out. Firebase should automatically pause network.
        // try {
        //   await disableNetwork(db);
        //   debugLog(`⏸️ Firestore network paused (${nextAppState})`);
        // } catch (e) {
        //   console.warn('Error pausing Firestore network:', e);
        // }
      }
    });

    return () => {
      subscription.remove();
    };
  }, [processSelfieQueue]);

  // Request permissions and configure audio once per app session (not per Reflection selection)
  useEffect(() => {
    debugLog('📸 Triggering permission check and audio setup on startup...');

    ensureExplorerAudioSessionOnce();

    // Camera Permission
    requestCameraPermission().then(result => {
      if (result.granted) {
        debugLog('✅ Camera permission granted');
      } else {
        debugLog('❌ Camera permission denied');
      }
    }).catch(err => console.warn('Camera permission request failed:', err));
  }, []);


  // Load read state from disk on startup
  useEffect(() => {
    const loadReadState = async () => {
      try {
        const storedIds = await AsyncStorage.getItem('read_events');
        if (storedIds) {
          const parsed = JSON.parse(storedIds);
          setReadEventIds(parsed);
          readEventIdsRef.current = parsed;
        }
        setIsReadStateLoaded(true);
      } catch (error) {
        console.error('Failed to load read state:', error);
      }
    };

    loadReadState();
  }, []);

  // Keep selectedEventIdRef in sync for multi-tap guard (e.g. when closing modal or swiping)
  useEffect(() => {
    selectedEventIdRef.current = selectedEvent?.event_id ?? null;
  }, [selectedEvent?.event_id]);

  // When events list changes, ensure selectedEvent is still in the list (e.g. deleted by Companion)
  useEffect(() => {
    if (!selectedEvent) return;
    const stillInList = events.some((e) => e.event_id === selectedEvent.event_id);
    if (!stillInList) {
      setSelectedEvent(events.length > 0 ? events[0] : null);
    }
  }, [events, selectedEvent?.event_id]);


  // Fetch metadata when a reflection is selected
  useEffect(() => {
    if (!selectedEvent || eventMetadata[selectedEvent.event_id]) return;
    if (eventHasEmbeddedMetadata(selectedEvent)) {
      setEventMetadata((prev) => ({
        ...prev,
        [selectedEvent.event_id]: selectedEvent.metadata as EventMetadata,
      }));
    }
  }, [selectedEvent?.event_id, selectedEvent?.metadata, eventMetadata]);

  // Get metadata for selected event  
  const selectedMetadata = selectedEvent ? eventMetadata[selectedEvent.event_id] : null;

  const handleToggleReflectionLike = useCallback((eventId: string, userId: string, isAdd: boolean) => {
    setReflectionLikes((prev) => {
      const current = prev[eventId] ?? [];
      const next = isAdd
        ? (current.includes(userId) ? current : [...current, userId])
        : current.filter((uid) => uid !== userId);
      return { ...prev, [eventId]: next };
    });
    toggleReflectionLike(eventId, userId, isAdd);
  }, []);

  // Track engagement: send signal if Explorer views Reflection for > 5 seconds
  useEffect(() => {
    // Clear any existing timer
    if (engagementTimerRef.current) {
      clearTimeout(engagementTimerRef.current);
      engagementTimerRef.current = null;
    }

    // If a Reflection is selected, start 5-second timer
    if (selectedEvent?.event_id) {
      engagementTimerRef.current = setTimeout(() => {
        sendEngagementSignal(selectedEvent.event_id);
      }, 5000); // 5 seconds
    }

    // Cleanup timer on unmount or when selectedEvent changes
    return () => {
      if (engagementTimerRef.current) {
        clearTimeout(engagementTimerRef.current);
        engagementTimerRef.current = null;
      }
    };
  }, [selectedEvent?.event_id]);

  // Auto-mark as read when an event is opened
  useEffect(() => {
    if (selectedEvent && isReadStateLoaded) {
      debugLog(`👁️ Auto-marking as read: ${selectedEvent.event_id} (readStateLoaded=${isReadStateLoaded})`);
      markEventAsRead(selectedEvent.event_id);
    }
  }, [selectedEvent, isReadStateLoaded]);

  const fetchEvents = useCallback(async () => {
    try {
      // Avoid blanking the grid during refreshes; only show full-screen loader on cold start.
      const isInitialLoad = events.length === 0;
      if (isInitialLoad) setLoading(true);
      else setIsRefreshing(true);
      setError(null);
      const response = await fetch(`${API_ENDPOINTS.LIST_MIRROR_EVENTS}?explorer_id=${currentExplorerId}`);

      if (!response.ok) {
        throw new Error(`Failed to fetch events: ${response.status}`);
      }

      const data: ListEventsResponse = await response.json();

      // Filter out events without image URLs and log issues
      const validEvents = (data.events || []).filter((event) => {
        if (!event.image_url || event.image_url === '') {
          debugLog(`Skipping incomplete event ${event.event_id} (no image_url)`);
          return false;
        }
        return true;
      });

      // Sort by event_id (timestamp) in descending order (latest first)
      // This ensures the newest events appear first in the grid
      const sortedEvents = validEvents.sort((a, b) => {
        // event_id is a timestamp string, so we can compare them directly
        // For descending order (latest first), we want b - a
        return b.event_id.localeCompare(a.event_id);
      });

      const now = Date.now();
      const eventsWithTimestamp = sortedEvents.map(e => ({ ...e, refreshedAt: now }));

      // Just update immediately, the centering logic in MainStageView will handle the focus stability
      setEvents(eventsWithTimestamp);

      const embeddedById: Record<string, EventMetadata> = {};
      for (const e of sortedEvents) {
        if (eventHasEmbeddedMetadata(e)) {
          embeddedById[e.event_id] = e.metadata as EventMetadata;
        }
      }
      if (Object.keys(embeddedById).length > 0) {
        setEventMetadata((prev) => ({ ...prev, ...embeddedById }));
      }
    } catch (err: any) {
      console.error('Error fetching events:', err);
      setError(err.message || 'Failed to load events');
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, [events.length]);

  // Keep ref to latest fetchEvents to avoid dependency cycles
  const fetchEventsRef = useRef(fetchEvents);
  // Refs for stable access inside the listener
  const eventsRef = useRef(events);
  const selectedEventRef = useRef(selectedEvent);

  useEffect(() => {
    fetchEventsRef.current = fetchEvents;
    eventsRef.current = events;
    selectedEventRef.current = selectedEvent;
  }, [events, selectedEvent, fetchEvents]);

  // STABLE Firestore Listener
  useEffect(() => {
    debugLog('🔌 Firestore listener attached');
    
    // Initial fetch
    fetchEventsRef.current();

    // 1. Set up Firestore listener (The "Doorbell")
    // db from shared
    // LIST_MIRROR_EVENTS does not include metadata; captions live on Firestore signal docs.
    // Keep enough rows to cover typical libraries so grid + stage can resolve sender/caption/deep_dive.
    const REFLECTION_SIGNALS_LIMIT = 400;
    const q = query(
      collection(db, ExplorerConfig.collections.reflections),
      where('explorerId', '==', currentExplorerId),
      orderBy('timestamp', 'desc'),
      limit(REFLECTION_SIGNALS_LIMIT)
    );
    let isInitialLoad = true;

    const unsubscribe = onSnapshot(q,
      async (snapshot: QuerySnapshot) => {
        // Always merge metadata from the full snapshot (fixes cold start: we used to skip the
        // first snapshot entirely, so eventMetadata stayed empty and every card showed "Reflection").
        // One setEventMetadata per snapshot — docChanges metadata is redundant with this full pass
        // but we still walk docChanges for arrival/delete signals and list-vs-Firestore merge hints.
        const metadataFromFirestore: Record<string, EventMetadata> = {};
        const likesFromFirestore: Record<string, string[]> = {};
        for (const docSnap of snapshot.docs) {
          const id = docSnap.id;
          const data = docSnap.data();
          const meta = normalizeFirestoreMetadata(data?.metadata, id);
          if (meta) metadataFromFirestore[id] = meta;
          likesFromFirestore[id] = coerceLikedBy(data?.likedBy);
        }
        if (Object.keys(metadataFromFirestore).length > 0) {
          setEventMetadata((prev) => ({ ...prev, ...metadataFromFirestore }));
        }
        setReflectionLikes((prev) => ({ ...prev, ...likesFromFirestore }));

        if (isInitialLoad) {
          isInitialLoad = false;
          return;
        }

        // 2. Check for added / modified / removed reflections
        const newReflectionIds: string[] = [];
        const removedReflectionIds: string[] = [];
        /** Ids that got non-null Firestore metadata this batch (for list API merge). Reuse snapshot map — no second normalize. */
        const firestoreMetadataById: Record<string, EventMetadata> = {};
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'added') {
            const id = change.doc.id;
            newReflectionIds.push(id);
            const m = metadataFromFirestore[id];
            if (m) firestoreMetadataById[id] = m;
          } else if (change.type === 'modified') {
            const id = change.doc.id;
            const m = metadataFromFirestore[id];
            if (m) firestoreMetadataById[id] = m;
          } else if (change.type === 'removed') {
            removedReflectionIds.push(change.doc.id);
          }
        });

        // Remove deleted reflections from local state immediately
        if (removedReflectionIds.length > 0) {
          const remaining = eventsRef.current.filter(
            (e) => !removedReflectionIds.includes(e.event_id)
          );
          setEvents(remaining);
          setReflectionLikes((prev) => {
            const next = { ...prev };
            removedReflectionIds.forEach((id) => {
              delete next[id];
            });
            return next;
          });
          setSelectedEvent((current) => {
            if (!current || !removedReflectionIds.includes(current.event_id)) return current;
            return remaining.length > 0 ? remaining[0] : null;
          });
        }

        if (newReflectionIds.length === 0) return;

        debugLog(`🔔 Reflections received for: ${newReflectionIds.join(', ')}`);

        // 3. FETCH & SIGN (The "Mailbox Walk")
        try {
          const response = await fetch(`${API_ENDPOINTS.LIST_MIRROR_EVENTS}?explorer_id=${currentExplorerId}`);
          if (!response.ok) throw new Error('Failed to fetch fresh events');

          const data: ListEventsResponse = await response.json();
          const freshEvents = data.events || [];

          // 4. IMMEDIATE INJECTION LOGIC
          const currentIds = new Set(eventsRef.current.map(e => e.event_id));
          const newItems = freshEvents.filter(e => !currentIds.has(e.event_id));

          if (newItems.length > 0) {
            debugLog(`✨ Injecting ${newItems.length} new items immediately`);

            const now = Date.now();
            const signedNewItems = newItems.map(e => ({ ...e, refreshedAt: now }));

            const fromListOnly: Record<string, EventMetadata> = {};
            for (const item of newItems) {
              if (eventHasEmbeddedMetadata(item) && !firestoreMetadataById[item.event_id]) {
                fromListOnly[item.event_id] = item.metadata as EventMetadata;
              }
            }
            if (Object.keys(fromListOnly).length > 0) {
              setEventMetadata((prev) => ({ ...prev, ...fromListOnly }));
            }

            // Merge new events immediately; metadata and arrival UI follow incrementally
            setEvents(prev => {
              const merged = [...signedNewItems, ...prev];
              return merged.sort((a, b) => b.event_id.localeCompare(a.event_id));
            });

            const notifyNewArrivalForEvent = (eventId: string) => {
              let shouldChime = false;
              setRecentlyArrivedIds(prev => {
                if (prev.includes(eventId) || readEventIdsRef.current.includes(eventId)) return prev;
                shouldChime = true;
                debugLog(`✨ New arrival: ${eventId}`);
                return [...prev, eventId];
              });
              if (shouldChime) void playArrivalChime();
            };

            const newIds = newItems.map((item) => item.event_id);
            debugLog(`🔔 New arrivals detected: ${newIds.join(', ')}`);

            for (const item of newItems) {
              notifyNewArrivalForEvent(item.event_id);
            }
          }

        } catch (error) {
          console.error('Error fetching fresh data on reflection:', error);
        }
      },
      (error) => {
        console.error("Firestore listener error:", error);
      }
    );

    return () => {
      debugLog('🔌 Firestore listener detached');
      unsubscribe();
    };
  }, [currentExplorerId]); // Stable dependency


  const refreshEventUrls = useCallback(async (eventId: string): Promise<Event | null> => {
    try {
      // Fetch fresh URLs for a single event bundle (Expiry: 4 hours)
      const response = await fetch(`${API_ENDPOINTS.GET_EVENT_BUNDLE}?event_id=${eventId}&explorer_id=${currentExplorerId}`);
      if (!response.ok) {
        console.warn(`Failed to refresh URLs for event ${eventId}`);
        return null;
      }

      const refreshedEvent: Event = await response.json();
      const refreshedEventWithTimestamp = { ...refreshedEvent, refreshedAt: Date.now() };

      // Update the event in the events array
      setEvents(prevEvents =>
        prevEvents.map(e => e.event_id === eventId ? { ...e, ...refreshedEventWithTimestamp } : e)
      );
      return refreshedEventWithTimestamp;
    } catch (error) {
      console.error(`Error refreshing URLs for event ${eventId}:`, error);
      return null;
    }
  }, []);

  // Predictive Neighbor Refresh: Silently refresh the next 2 events in circular order
  const refreshNeighborUrls = useCallback(async (currentEventId: string) => {
    if (events.length <= 1) return;

    const currentIndex = events.findIndex(e => e.event_id === currentEventId);
    if (currentIndex === -1) return;

    // We refresh the next 2 events to stay ahead of the user
    const neighborIndices = [
      (currentIndex + 1) % events.length,
      (currentIndex + 2) % events.length
    ].filter(idx => idx !== currentIndex);

    for (const idx of neighborIndices) {
      const neighbor = events[idx];
      // Only refresh if about to expire (e.g. older than 3 hours)
      const STALE_THRESHOLD = 3 * 60 * 60 * 1000;
      if (!neighbor.refreshedAt || Date.now() - neighbor.refreshedAt > STALE_THRESHOLD) {
        debugLog(`📡 Predictive refresh for neighbor: ${neighbor.event_id} (Stale)`);
        refreshEventUrls(neighbor.event_id).catch(() => { });
      }
    }
  }, [events, refreshEventUrls]);

  // Keep ref to latest refreshEventUrls
  const refreshEventUrlsRef = useRef(refreshEventUrls);
  useEffect(() => {
    refreshEventUrlsRef.current = refreshEventUrls;
  }, [refreshEventUrls]);

  /** Blocks rapid Reflection switches — avoids repeated native media / Media Remote setup */
  const lastSelectionTime = useRef(0);

  const markEventAsRead = useCallback(async (eventId: string) => {
    setReadEventIds(prev => {
      if (prev.includes(eventId)) return prev;
      const next = [...prev, eventId];
      readEventIdsRef.current = next;
      // Save to disk asynchronously
      AsyncStorage.setItem('read_events', JSON.stringify(next)).catch(err => {
        console.error('Failed to save read state:', err);
      });
      debugLog(`✅ Marked event ${eventId} as read. Total read: ${next.length}`);
      return next;
    });
  }, []);

  const handleEventPress = useCallback(async (item: Event) => {
    setStartIdleOnInitialSelection(false);
    // Ignore multiple taps on the already-selected card (use ref for immediate effect before state updates)
    if (item.event_id === selectedEventIdRef.current) return;

    const now = Date.now();
    if (now - lastSelectionTime.current < 800) {
      debugLog('Reflections: selection ignored (800ms lockout)');
      return;
    }
    lastSelectionTime.current = now;

    selectedEventIdRef.current = item.event_id;
    // Open immediately with existing URLs for instant response
    setSelectedEvent(item);

    // Remove from "Recent" arrivals once selected
    debugLog(`Reflections: ${item.event_id} selected. Removing from recent arrivals.`);
    setRecentlyArrivedIds(prev => {
      const filtered = prev.filter(id => id !== item.event_id);
      if (filtered.length !== prev.length) {
        debugLog(`   Removed ${item.event_id} from recent arrivals. New count: ${filtered.length}`);
      }
      return filtered;
    });

    // Copy embedded metadata into grid state if not already loaded
    if (!eventMetadata[item.event_id] && eventHasEmbeddedMetadata(item)) {
      setEventMetadata((prev) => ({
        ...prev,
        [item.event_id]: item.metadata as EventMetadata,
      }));
    }

    // Refresh URLs in background (non-blocking) if they are stale
    const STALE_THRESHOLD = 3 * 60 * 60 * 1000; // 3 hours
    const isStale = !item.refreshedAt || (Date.now() - item.refreshedAt > STALE_THRESHOLD);

    if (isStale) {
      debugLog(`Reflections: item ${item.event_id} is stale. Refreshing in background...`);
      const eventIdToRefresh = item.event_id;
      refreshEventUrls(eventIdToRefresh).then(refreshedEvent => {
        if (refreshedEvent) {
          // Trigger predictive refresh for neighbors
          refreshNeighborUrls(eventIdToRefresh);

          // Merge embedded metadata from refreshed bundle if not already loaded
          if (!eventMetadata[refreshedEvent.event_id] && eventHasEmbeddedMetadata(refreshedEvent)) {
            setEventMetadata((prev) => ({
              ...prev,
              [refreshedEvent.event_id]: refreshedEvent.metadata as EventMetadata,
            }));
          }
        }
      }).catch(err => {
        console.warn("Background URL refresh failed:", err);
      });
    } else {
      // Still refresh neighbors, they might be stale
      refreshNeighborUrls(item.event_id);
    }
  }, [eventMetadata, refreshEventUrls, refreshNeighborUrls]);

  const throttledHandleEventPress = useThrottledCallback(handleEventPress, 800);

  // Auto-select the first (most recent) event when events load (only once)
  const hasAutoSelectedRef = useRef(false);
  useEffect(() => {
    if (events.length > 0 && !hasAutoSelectedRef.current) {
      hasAutoSelectedRef.current = true;
      if (autoplay) {
        handleEventPress(events[0]);
      } else {
        selectedEventIdRef.current = events[0].event_id;
        setStartIdleOnInitialSelection(true);
        setSelectedEvent(events[0]);
      }
    }
  }, [autoplay, events, handleEventPress]);

  const renderEvent = ({ item }: { item: Event }) => {
    const metadata = eventMetadata[item.event_id];
    const isRead = readEventIds.includes(item.event_id);
    const isNewArrival = recentlyArrivedIds.includes(item.event_id);
    const likedBy = reflectionLikes[item.event_id] ?? [];
    const currentUserId = auth.currentUser?.uid ?? null;
    const likedByMe = !!currentUserId && likedBy.includes(currentUserId);
    const likeCount = likedBy.length;

    // Don't render if no image URL
    if (!item.image_url || item.image_url === '') {
      return null;
    }

    return (
      <TouchableOpacity
        style={[
          styles.gridCard,
          isNewArrival && styles.gridCardNewArrival
        ]}
        onPress={() => throttledHandleEventPress(item)}
        activeOpacity={0.8}
      >
        {/* Unread indicator dot */}
        {!isRead && (
          <View style={styles.unreadDot} />
        )}

        {/* Thumbnail */}
        <View style={styles.gridThumbnailContainer}>
          <Image
            source={{
              uri: item.image_url,
              cacheKey: imageUrlCacheKey(item.image_url),
              width: gridThumbnailSize.width,
              height: gridThumbnailSize.height,
            }}
            style={styles.gridThumbnail}
            contentFit="cover"
            recyclingKey={item.event_id}
            cachePolicy="memory-disk"
            priority="low"
            onError={(error) => {
              console.error(`Error loading image for event ${item.event_id}:`, error);
            }}
          />
          {/* Media type badge overlay */}
          <View style={styles.mediaTypeBadge}>
            {item.video_url ? (
              <FontAwesome name="video-camera" size={12} color="#fff" />
            ) : metadata?.image_source === 'search' ? (
              <FontAwesome name="search" size={12} color="#fff" />
            ) : (
              <FontAwesome name="camera" size={12} color="#fff" />
            )}
          </View>
          <Pressable
            onPress={(event) => {
              event.stopPropagation();
              if (!currentUserId) return;
              handleToggleReflectionLike(item.event_id, currentUserId, !likedByMe);
            }}
            onLongPress={(event) => {
              event.stopPropagation();
              if (likeCount > 0) {
                setGridLikeFacesLikedBy(likedBy);
              }
            }}
            delayLongPress={250}
            style={({ pressed }) => [
              styles.gridLikeBadge,
              likedByMe && styles.gridLikeBadgeActive,
              pressed && styles.gridLikeBadgePressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={likedByMe ? 'Unlike this Reflection' : 'Like this Reflection'}
          >
            <FontAwesome
              name={likeCount > 0 ? 'heart' : 'heart-o'}
              size={13}
              color={likedByMe ? '#4FC3F7' : likeCount > 0 ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.88)'}
            />
            {likeCount > 0 ? (
              <Text style={[styles.gridLikeCount, likedByMe && styles.gridLikeCountActive]}>{likeCount}</Text>
            ) : null}
          </Pressable>
        </View>

        {/* Card Content */}
        <View style={styles.gridCardContent}>
          {/* Description/Title */}
          <Text style={styles.gridCardTitle} numberOfLines={2}>
            {metadata?.short_caption || metadata?.description || 'Reflection'}
          </Text>

          {/* Metadata row */}
          <View style={styles.gridCardMeta}>
            <Text style={styles.gridCardDate}>
              {formatEventDateFromId(item.event_id)}
            </Text>
            {isNewArrival && (
              <Text style={styles.gridCardNewBadge}>NEW</Text>
            )}
          </View>

          {/* Sender */}
          {metadata?.sender && (
            <Text style={styles.gridCardSender} numberOfLines={1}>
              From {metadata.sender}
            </Text>
          )}

          <Pressable
            onPress={async () => {
              try {
                await Clipboard.setStringAsync(item.event_id);
                showCopyReflectionIdToast('Copied reflection ID');
              } catch {
                showCopyReflectionIdToast('Could not copy');
              }
            }}
            style={({ pressed }) => [styles.eventIdPressable, pressed && styles.eventIdPressablePressed]}
            accessibilityRole="button"
            accessibilityLabel={`Reflection ID ${item.event_id}`}
            accessibilityHint="Copies the reflection ID to the clipboard"
          >
            <Text style={styles.eventIdLabel}>Reflection ID: </Text>
            <Text style={styles.eventIdText} numberOfLines={1}>
              {item.event_id}
            </Text>
          </Pressable>
        </View>
      </TouchableOpacity>
    );
  };

  const closeFullScreen = useCallback(async () => {
    // Stop speech if playing
    Speech.stop();

    // Auto-fetch fresh list if closing (optional, but robust)
    fetchEvents();

    setSelectedEvent(null);
  }, [fetchEvents]);

  const navigateToPhoto = useCallback(async (direction: 'prev' | 'next') => {
    if (!selectedEvent) return;

    // Find current index
    const currentIndex = events.findIndex(e => e.event_id === selectedEvent.event_id);
    if (currentIndex === -1) return;

    // Determine the target event
    let targetEvent: Event | null = null;
    if (direction === 'prev') {
      if (currentIndex === 0) {
        // At first photo - go back to gallery
        closeFullScreen();
        return;
      } else {
        // Go to previous photo (newer)
        targetEvent = events[currentIndex - 1];
      }
    } else {
      // direction === 'next'
      if (currentIndex === events.length - 1) {
        // At last photo - go back to gallery
        closeFullScreen();
        return;
      } else {
        // Go to next photo (older)
        targetEvent = events[currentIndex + 1];
      }
    }

    if (targetEvent) {
      // Refresh URLs for the target photo
      const refreshedEvent = await refreshEventUrls(targetEvent.event_id);
      // Update selectedEvent - MainStageView will handle the audio transition
      setSelectedEvent(refreshedEvent || targetEvent);
    }
  }, [selectedEvent, events, refreshEventUrls, closeFullScreen]);

  // Handle media load errors (e.g., expired S3 URLs) by refreshing URLs
  const handleMediaError = useCallback(async (event: Event) => {
    // Prevent duplicate refresh calls for the same event
    if (refreshingEventsRef.current.has(event.event_id)) {
      return;
    }

    // Add to set IMMEDIATELY to block concurrent calls
    refreshingEventsRef.current.add(event.event_id);
    debugLog(`🔄 Refreshing expired URLs for event ${event.event_id}`);

    try {
      const refreshedEvent = await refreshEventUrls(event.event_id);
      if (refreshedEvent && selectedEvent?.event_id === event.event_id) {
        // Update the selected event with fresh URLs
        setSelectedEvent(refreshedEvent);
      }
    } finally {
      // Remove from set after a short delay to allow the refresh to complete
      setTimeout(() => {
        refreshingEventsRef.current.delete(event.event_id);
      }, 1000);
    }
  }, [selectedEvent, refreshEventUrls]);

  // Send engagement signal to Firestore
  const sendEngagementSignal = async (eventId: string) => {
    try {
      // db from shared
      const signalRef = doc(db, ExplorerConfig.collections.reflections, eventId);
      await setDoc(signalRef, {
        event_id: eventId,
        status: 'engaged',
        timestamp: serverTimestamp(),
        type: 'engagement_heartbeat',
        engagement_count: increment(1),
      }, { merge: true });
      hasEngagedRef.current[eventId] = true;
    } catch (error) {
      console.error('Error sending engagement signal:', error);
    }
  };

  // Send replay signal to Firestore
  const sendReplaySignal = async (eventId: string) => {
    try {
      // db from shared
      const signalRef = doc(db, ExplorerConfig.collections.reflections, eventId);
      await setDoc(signalRef, {
        event_id: eventId,
        status: 'replayed',
        timestamp: serverTimestamp(),
        type: 'engagement_heartbeat',
        engagement_count: increment(1),
      }, { merge: true });
      hasReplayedRef.current[eventId] = true;
    } catch (error) {
      console.error('Error sending replay signal:', error);
    }
  };

  const enqueueSelfieUpload = useCallback(async (job: {
    originalEventId: string;
    responseEventId: string;
    localUri: string; // Persistent, processed selfie file (documentDirectory)
    senderExplorerId: string | null;
    viewerExplorerId: string | null;
    createdAt: number;
  }) => {
    try {
      debugLog(`[Queue] Enqueue job for event ${job.originalEventId}`);
      const existingRaw = await AsyncStorage.getItem(SELFIE_QUEUE_KEY);
      const existingQueue = existingRaw ? JSON.parse(existingRaw) : [];
      // Replace any existing job for same reflection - only latest selfie matters (overwrites in S3)
      const replaced = existingQueue.find((j: any) => j?.originalEventId === job.originalEventId);
      if (replaced?.localUri && replaced.localUri !== job.localUri) {
        FileSystem.deleteAsync(replaced.localUri, { idempotent: true }).catch(() => {});
      }
      const filtered = existingQueue.filter((j: any) => j?.originalEventId !== job.originalEventId);
      filtered.push(job);
      await AsyncStorage.setItem(SELFIE_QUEUE_KEY, JSON.stringify(filtered));
      // NOTE: We intentionally do NOT process immediately.
      // We trigger queue processing when MainStage playback ends (or on dismiss),
      // and also whenever the app becomes active.
    } catch (error) {
      console.error('Failed to enqueue selfie upload:', error);
    }
  }, [processSelfieQueue]);

  // Capture and upload selfie response
  const captureSelfieResponse = useCallback(async (silent: boolean = false) => {
    if (!selectedEvent || !cameraRef.current || isCapturingSelfie) {
      return;
    }

    // Check camera permissions
    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission();
      if (!result.granted) {
        Alert.alert("Camera Permission", "Camera permission is required to take a selfie response.");
        return;
      }
    }

    setIsCapturingSelfie(true);

    try {
      // Phase: Capture
      debugLog('[Selfie] Phase: Capture');
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.3,
        base64: false,
      });

      if (!photo) {
        throw new Error("Failed to capture photo");
      }

      // Use reflection's event_id as the response key - selfie overwrites previous one at same path
      const originalEventId = selectedEvent.event_id;
      const localUniqueId = Date.now().toString(); // For unique local filename only

      // Phase: Process (resize/compress) + persist to documentDirectory
      // NOTE: We do this here because doing ImageManipulator work inside the queue
      // was intermittently taking tens of seconds and freezing the UI.
      debugLog('[Selfie] Phase: Process (resize/compress)');
      const processedPhoto = await ImageManipulator.manipulateAsync(
        photo.uri,
        [{ resize: { width: 1080 } }],
        { compress: 0.5, format: ImageManipulator.SaveFormat.JPEG }
      );

      const persistentDir = FileSystem.documentDirectory;
      const persistentPath = `${persistentDir}selfie_${originalEventId}_${localUniqueId}.jpg`;
      await FileSystem.copyAsync({ from: processedPhoto.uri, to: persistentPath });

      // Cleanup temp files (best-effort). Keep only the persistentPath for queue.
      try {
        if (photo.uri && photo.uri !== persistentPath && photo.uri !== processedPhoto.uri) {
          await FileSystem.deleteAsync(photo.uri, { idempotent: true });
        }
        if (processedPhoto.uri && processedPhoto.uri !== persistentPath) {
          await FileSystem.deleteAsync(processedPhoto.uri, { idempotent: true });
        }
      } catch (cleanupError) {
        console.warn('Failed cleaning up selfie temp files:', cleanupError);
      }

      // Phase: Enqueue (processed file is now persistent)
      debugLog('[Selfie] Phase: Enqueue');
      await enqueueSelfieUpload({
        originalEventId,
        responseEventId: originalEventId, // Same as reflection - overwrites previous selfie in S3
        localUri: persistentPath,
        senderExplorerId: currentExplorerId,
        viewerExplorerId: currentExplorerId,
        createdAt: Date.now(),
      });

      // For non-videos (photos/images/audio-only), flush the queue immediately after selfie.
      // For videos, we still prefer flushing on "idle" (finish/dismiss/next) to avoid mid-playback updates.
      const isVideo =
        !!selectedEvent.video_url || eventMetadata[selectedEvent.event_id]?.content_type === 'video';
      if (!isVideo) {
        debugLog('[Queue] Flushing after selfie (non-video)');
        processSelfieQueue();
      }

      // Speak confirmation message (only if not silent)
      // DISABLED for now - can be distracting during video playback
      // if (!silent) {
      //   const metadata = selectedEvent ? eventMetadata[selectedEvent.event_id] : null;
      //   const companionName = metadata?.sender || 'your companion';
      //   Speech.speak(`I sent a selfie to ${companionName}`, {
      //     pitch: 1.0,
      //     rate: 1.0,
      //     language: 'en-US',
      //   });
      // }

      // Upload + Firestore updates now happen in the deferred queue

    } catch (error: any) {
      console.error("❌ Error capturing selfie:", error);
      // Detailed logging for tricky network/platform errors
      if (error && typeof error === 'object') {
        console.error("❌ Detailed Error Info:", {
          message: error.message,
          code: error.code,
          domain: error.domain,
          userInfo: error.userInfo
        });
      }

      let errorMessage = "Failed to capture selfie. Please try again.";
      if (error?.code === 'permission-denied' || error?.message?.includes('permission')) {
        errorMessage = `Permission error. Please check Firestore security rules for '${ExplorerConfig.collections.responses}' collection.`;
      }

      if (!silent) {
        Alert.alert("Error", `${errorMessage}\n\nTechnical info: ${error.message || 'Unknown error'}`);
      }
    } finally {
      setIsCapturingSelfie(false);
    }
  }, [selectedEvent, cameraPermission, isCapturingSelfie, requestCameraPermission, eventMetadata]);


  const deleteEvent = async (event: Event) => {
    try {
      // 1. Delete S3 objects
      const deleteResponse = await fetch(
        `${API_ENDPOINTS.DELETE_MIRROR_EVENT}?event_id=${event.event_id}&explorer_id=${currentExplorerId}`
      );

      if (!deleteResponse.ok) {
        const errorData = await deleteResponse.json();
        throw new Error(errorData.errors?.join(', ') || 'Failed to delete S3 objects');
      }

      // 2. Delete selfie response image from S3 and response doc if it exists
      const responseRef = doc(db, ExplorerConfig.collections.responses, event.event_id);
      try {
        const responseDoc = await getDoc(responseRef);
        if (responseDoc.exists()) {
          const responseData = responseDoc.data();
          const responseEventId = responseData?.response_event_id;
          if (responseEventId) {
            await fetch(
              `${API_ENDPOINTS.DELETE_MIRROR_EVENT}?event_id=${responseEventId}&path=from&explorer_id=${currentExplorerId}`,
              { method: 'DELETE' }
            ).catch(() => {});
          }
          await deleteDoc(responseRef);
        }
      } catch (selfieError: any) {
        console.warn("Failed to delete selfie response:", selfieError);
      }

      // 3. Hard delete reflection document
      const reflectionRef = doc(db, ExplorerConfig.collections.reflections, event.event_id);
      await deleteDoc(reflectionRef);

      // 4. Stop any ongoing speech (defensive cleanup)
      Speech.stop();

      // 5. Remove from local state and select next event
      const remainingEvents = events.filter(e => e.event_id !== event.event_id);
      setEvents(remainingEvents);

      // Select the first remaining event, or null if no events left
      if (remainingEvents.length > 0) {
        setSelectedEvent(remainingEvents[0]);
      } else {
        setSelectedEvent(null);
      }

      Alert.alert("Success", "Reflection deleted successfully");
    } catch (error: any) {
      console.error("Delete error:", error);
      Alert.alert("Delete Failed", error.message || "Failed to delete Reflection");
    }
  };

  const handleMainStagePlaybackIdle = useCallback(() => {
    // When playback finishes (video/audio/narration) or the user dismisses MainStage,
    // run any pending selfie upload work.
    processSelfieQueue();
  }, [processSelfieQueue]);

  if (loading) {
    return (
      <View style={styles.container}>
        <ExplorerGradientBackdrop layout="screen" />
        <WaitOverlay
          title="Loading Reflections..."
          detail="Checking for new Reflections from your Companions."
          icon={<FontAwesome name="cloud-download" size={20} color="#dbeafe" />}
          tone="media"
        />
        <TouchableOpacity
          onPress={() => router.push('/settings')}
          style={{ position: 'absolute', top: insets.top + 10, right: 20, padding: 10, zIndex: 100 }}
          hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}
        >
          <FontAwesome name="info-circle" size={24} color="rgba(255, 255, 255, 0.4)" />
        </TouchableOpacity>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.container}>
        <ExplorerGradientBackdrop layout="screen" />
        <View style={styles.centerContainer}>
          <Text style={[styles.errorText, { color: '#fff' }]}>Error: {error}</Text>
          <Text style={[styles.retryText, { color: '#4FC3F7' }]} onPress={fetchEvents}>
            Tap to retry
          </Text>
        </View>
      </View>
    );
  }

  if (events.length === 0) {
    return (
      <View style={styles.container}>
        <ExplorerGradientBackdrop layout="screen" />
        <View style={styles.centerContainer} pointerEvents="box-none">
          <TouchableOpacity
            onPress={() => router.push('/settings')}
            style={{ position: 'absolute', top: insets.top + 10, right: 20, padding: 10, zIndex: 100 }}
            hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}
          >
            <FontAwesome name="info-circle" size={24} color="rgba(255, 255, 255, 0.4)" />
          </TouchableOpacity>

          <Text style={[styles.emptyText, { color: '#fff' }]}>No Reflections yet</Text>
          <Text style={[styles.emptySubtext, { color: 'rgba(255,255,255,0.7)' }]}>Reflections from companions will appear here</Text>
        </View>
      </View>
    );
  }

  // Z-Stack Layout: Grid (bottom) + MainStageView Overlay (top)
  return (
    <View style={styles.container}>
      <ExplorerGradientBackdrop layout="overlay" />
      {/* Header Bar */}
      <View style={[styles.gridHeader, { paddingTop: insets.top + 12 }]}>
        <View style={styles.gridHeaderLeft}>
          {recentlyArrivedIds.length > 0 ? (
            <TouchableOpacity
              onPress={() => {
                // Find and select the first new arrival
                const newestArrival = events.find(e => recentlyArrivedIds.includes(e.event_id));
                if (newestArrival) {
                  throttledHandleEventPress(newestArrival);
                }
              }}
              style={styles.newArrivalPill}
              activeOpacity={0.7}
            >
              <BlurView intensity={STATIC_BLUR_INTENSITY} style={styles.newArrivalPillBlur}>
                <Text style={styles.newArrivalPillText}>
                  ✨ {recentlyArrivedIds.length} New Reflection{recentlyArrivedIds.length > 1 ? 's' : ''}
                </Text>
              </BlurView>
            </TouchableOpacity>
          ) : (
            <Text style={styles.gridHeaderTitle}>Reflections</Text>
          )}
        </View>
        <View style={styles.gridHeaderActions}>
          {isRefreshing && (
            <ActivityIndicator size="small" color="rgba(255, 255, 255, 0.6)" />
          )}
          <TouchableOpacity
            onPress={() => router.push('/settings')}
            style={styles.gridHeaderButton}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <FontAwesome name="info-circle" size={20} color="rgba(255, 255, 255, 0.6)" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Companion Filter Bar */}
      {companions.length > 0 && (
        <AvatarFilterBar
          companions={companions}
          selectedId={selectedCompanionId}
          onSelect={setSelectedCompanionId}
          loading={companionsLoading}
        />
      )}

      {/* Layer 1 (Bottom): Always-rendered Grid of Reflections */}
      <FlatList
        data={filteredEvents}
        renderItem={renderEvent}
        // Stable keys prevent cell churn/flicker (index-based keys cause "blank then there" on refresh)
        keyExtractor={(item) => item.event_id}
        numColumns={numColumns}
        key={numColumns} // Force re-render when column count changes
        contentContainerStyle={[
          styles.listContainer,
          { paddingBottom: insets.bottom + 20 }
        ]}
        columnWrapperStyle={styles.row}
        showsVerticalScrollIndicator={false}
        removeClippedSubviews={true}
        initialNumToRender={12}
        maxToRenderPerBatch={6}
        updateCellsBatchingPeriod={80}
        windowSize={3}
      />

      {/* Layer 2 (Top): MainStageView Overlay - Only rendered when event selected */}
      {selectedEvent !== null && (
        <View style={[StyleSheet.absoluteFill, { zIndex: 100 }]}>
          <MainStageView
            visible={true}
            selectedEvent={selectedEvent}
            events={filteredEvents}
            filterBar={
              companions.length > 0 ? (
                <AvatarFilterBar
                  companions={companions}
                  selectedId={selectedCompanionId}
                  onSelect={setSelectedCompanionId}
                  loading={companionsLoading}
                />
              ) : undefined
            }
            eventMetadata={eventMetadata}
            likedBy={reflectionLikes[selectedEvent.event_id] ?? []}
            reflectionLikes={reflectionLikes}
            currentUserId={auth.currentUser?.uid ?? null}
            companions={companions}
            onToggleLike={handleToggleReflectionLike}
            onClose={closeFullScreen}
            onEventSelect={throttledHandleEventPress}
            onDelete={deleteEvent}
            onCaptureSelfie={captureSelfieResponse}
            onPlaybackIdle={handleMainStagePlaybackIdle}
            onMediaError={handleMediaError}
            cameraRef={cameraRef}
            cameraPermission={cameraPermission}
            requestCameraPermission={requestCameraPermission}
            isCapturingSelfie={isCapturingSelfie}
            recentlyArrivedIds={recentlyArrivedIds}
            readEventIds={readEventIds}
            onReplay={(event) => sendReplaySignal(event.event_id)}
            config={EXPLORER_CONFIG}
            startIdleOnInitialSelection={startIdleOnInitialSelection}
            explorerDisplayName={explorerDisplayName}
          />
        </View>
      )}

      {copyToastMessage ? (
        <View
          style={[styles.clipboardToastRoot, { bottom: insets.bottom + 20 }]}
          pointerEvents="none"
        >
          <BlurView intensity={STATIC_BLUR_INTENSITY} style={styles.clipboardToastBlur}>
            <Text style={styles.clipboardToastText}>{copyToastMessage}</Text>
          </BlurView>
        </View>
      ) : null}

      <Modal
        visible={!!gridLikeFacesLikedBy}
        transparent
        animationType="fade"
        onRequestClose={() => setGridLikeFacesLikedBy(null)}
      >
        <View style={styles.gridFacesModalOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setGridLikeFacesLikedBy(null)} />
          <View style={styles.gridFacesModalCard}>
            <TouchableOpacity
              style={styles.gridFacesCloseButton}
              onPress={() => setGridLikeFacesLikedBy(null)}
              hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}
              accessibilityLabel="Close faces"
            >
              <FontAwesome name="close" size={18} color="#fff" />
            </TouchableOpacity>
            <FlatList
              data={gridLikeFaces}
              keyExtractor={(item) => item.uid}
              numColumns={3}
              contentContainerStyle={styles.gridFacesList}
              renderItem={({ item }) => (
                <View style={styles.gridFaceItem}>
                  {item.avatarUrl ? (
                    <Image
                      source={{ uri: item.avatarUrl }}
                      style={styles.gridFaceAvatar}
                      contentFit="cover"
                      recyclingKey={`grid-face-${item.uid}`}
                    />
                  ) : (
                    <View style={[styles.gridFaceAvatarFallback, { backgroundColor: item.color }]}>
                      <Text style={styles.gridFaceAvatarInitial}>{item.initial}</Text>
                    </View>
                  )}
                  {item.isCaregiver ? (
                    <View style={styles.gridFaceCaregiverBadge}>
                      <FontAwesome name="shield" size={12} color="#fff" />
                    </View>
                  ) : null}
                </View>
              )}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centerContainer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    padding: 16,
    color: '#2C3E50',
    backgroundColor: 'transparent',
  },
  // --- Grid Header Styles ---
  gridHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    backgroundColor: 'transparent',
  },
  gridHeaderLeft: {
    flex: 1,
  },
  gridHeaderTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: -0.5,
  },
  gridHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  gridHeaderButton: {
    padding: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  // --- New Arrival Pill Notification ---
  newArrivalPill: {
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: 'rgba(255, 215, 0, 0.2)',
    alignSelf: 'flex-start',
  },
  newArrivalPillBlur: {
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  newArrivalPillText: {
    color: '#FFD700',
    fontWeight: 'bold',
    fontSize: 16,
    textShadowColor: 'rgba(0, 0, 0, 0.75)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  listContainer: {
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  row: {
    justifyContent: 'flex-start',
    marginBottom: 4,
  },
  photoContainer: {
    flex: 1,
    margin: 4,
    aspectRatio: 1,
    borderRadius: 24,
    overflow: 'hidden',
    position: 'relative',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.5)',
  },
  photoBlurContainer: {
    width: '100%',
    height: '100%',
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
  },
  photo: {
    width: '100%',
    height: '100%',
  },
  descriptionBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(46, 120, 183, 0.9)',
    borderRadius: 20,
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },
  descriptionBadgeText: {
    fontSize: 18,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: '#2C3E50',
  },
  errorText: {
    fontSize: 16,
    color: '#ff6b6b',
    textAlign: 'center',
    marginBottom: 8,
  },
  retryText: {
    fontSize: 14,
    color: '#2E78B7',
    textDecorationLine: 'underline',
  },
  emptyText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#2C3E50',
    textAlign: 'center',
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 14,
    color: '#2C3E50',
    textAlign: 'center',
    opacity: 0.7,
  },
  fullScreenContainer: {
    flex: 1,
  },
  topButtonContainer: {
    position: 'absolute',
    width: '90%',
    alignSelf: 'center',
    zIndex: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'transparent',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 16,
  },
  reflectionHeader: {
    color: '#2C3E50',
    fontSize: 18,
    fontWeight: 'bold',
    flex: 1,
  },
  closeButton: {
    backgroundColor: 'rgba(0,0,0,0.6)',
    padding: 12,
    borderRadius: 8,
  },
  closeButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  deleteButton: {
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    padding: 12,
    borderRadius: 8,
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  imageFrameContainer: {
    position: 'absolute',
    borderRadius: 40,
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.8)',
    overflow: 'hidden',
    backgroundColor: 'transparent',
    zIndex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    ...Platform.select({
      android: {
        elevation: 5,
      },
    }),
  },
  fullScreenImage: {
    width: '100%',
    height: '100%',
  },
  tellMeMoreButton: {
    position: 'absolute',
    width: 60,
    height: 60,
    borderRadius: 30,
    overflow: 'hidden',
    zIndex: 10,
  },
  tellMeMoreBlur: {
    width: '100%',
    height: '100%',
    backgroundColor: 'rgba(255, 255, 255, 0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 30,
  },
  tellMeMoreIcon: {
    fontSize: 28,
    color: '#2C3E50',
  },
  descriptionContainer: {
    position: 'absolute',
    minHeight: 120,
    width: '90%',
    left: '5%',
    backgroundColor: 'transparent',
    paddingTop: 24,
    paddingHorizontal: 24,
    borderRadius: 30,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.8)',
    zIndex: 5,
  },
  descriptionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
    gap: 12,
  },
  descriptionLabel: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
    flex: 1,
  },
  buttonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  playButton: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#2C3E50',
    justifyContent: 'center',
    alignItems: 'center',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 4,
      },
      android: {
        elevation: 4,
      },
      default: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 4,
      },
    }),
  },
  closeButtonInline: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: 'rgba(211, 47, 47, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 4,
      },
      android: {
        elevation: 4,
      },
      default: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 4,
      },
    }),
  },
  descriptionText: {
    color: '#2C3E50',
    flex: 1,
    fontSize: 24,
    fontWeight: '600',
    lineHeight: 32,
  },
  selfieMirrorContainer: {
    position: 'absolute',
    right: 20,
    width: 120,
    height: 120,
    borderRadius: 60,
    overflow: 'visible',
    borderWidth: 4,
    borderColor: '#fff',
    backgroundColor: '#000', // Required for efficient shadow rendering
    zIndex: 10,
    ...Platform.select({
      ios: {
        shadowColor: '#2E78B7',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.2,
        shadowRadius: 20,
      },
      android: {
        elevation: 8,
      },
      default: {
        shadowColor: '#2E78B7',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.2,
        shadowRadius: 20,
      },
    }),
  },
  selfieMirrorWrapper: {
    width: '100%',
    height: '100%',
    borderRadius: 60,
    overflow: 'hidden',
  },
  selfieMirror: {
    width: '100%',
    height: '100%',
  },
  cameraShutterButton: {
    position: 'absolute',
    bottom: -15,
    alignSelf: 'center',
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 20,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.3,
        shadowRadius: 4,
      },
      android: {
        elevation: 4,
      },
      default: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.3,
        shadowRadius: 4,
      },
    }),
  },
  selfieMirrorPermissionButton: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    borderRadius: 60,
  },
  // --- YouTube-Style Grid Card Styles ---
  gridCard: {
    flex: 1,
    margin: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 16,
    overflow: 'hidden',
    position: 'relative',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
  },
  gridCardNewArrival: {
    backgroundColor: 'rgba(255, 215, 0, 0.15)',
    borderColor: 'rgba(255, 215, 0, 0.5)',
    borderWidth: 1,
  },
  unreadDot: {
    position: 'absolute',
    left: 8,
    top: 8,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#007AFF',
    zIndex: 10,
  },
  gridThumbnailContainer: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: '#1a3a44',
    position: 'relative',
  },
  gridThumbnail: {
    width: '100%',
    height: '100%',
  },
  mediaTypeBadge: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  gridLikeBadge: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    minWidth: 30,
    minHeight: 24,
    paddingHorizontal: 8,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,0,0,0.62)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  gridLikeBadgeActive: {
    backgroundColor: 'rgba(79, 195, 247, 0.22)',
    borderColor: 'rgba(79, 195, 247, 0.55)',
  },
  gridLikeBadgePressed: {
    opacity: 0.75,
  },
  gridLikeCount: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '800',
  },
  gridLikeCountActive: {
    color: '#4FC3F7',
  },
  gridCardContent: {
    padding: 12,
  },
  gridCardTitle: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 18,
    marginBottom: 6,
  },
  gridCardMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  gridCardDate: {
    color: 'rgba(255, 255, 255, 0.6)',
    fontSize: 12,
  },
  gridCardNewBadge: {
    color: '#FFD700',
    fontSize: 10,
    fontWeight: 'bold',
    marginLeft: 8,
  },
  gridCardSender: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 11,
    marginTop: 2,
  },
  eventIdPressable: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    paddingVertical: 2,
    paddingRight: 4,
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
    flex: 1,
    fontSize: 11,
    lineHeight: 14,
    color: 'rgba(200, 210, 220, 0.9)',
    fontVariant: ['tabular-nums'],
  },
  clipboardToastRoot: {
    position: 'absolute',
    left: 24,
    right: 24,
    zIndex: 250,
    alignItems: 'center',
  },
  clipboardToastBlur: {
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 999,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  clipboardToastText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  gridFacesModalOverlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: 'rgba(0,0,0,0.62)',
  },
  gridFacesModalCard: {
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
  gridFacesCloseButton: {
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
  gridFacesList: {
    alignItems: 'center',
    gap: 18,
  },
  gridFaceItem: {
    width: 108,
    height: 108,
    margin: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gridFaceAvatar: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  gridFaceAvatarFallback: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gridFaceAvatarInitial: {
    color: '#fff',
    fontSize: 38,
    fontWeight: '900',
  },
  gridFaceCaregiverBadge: {
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
});
