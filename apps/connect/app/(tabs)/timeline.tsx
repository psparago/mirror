import { FontAwesome } from '@expo/vector-icons';
import {
  API_ENDPOINTS,
  AvatarFilterBar,
  coerceThumbnailTimeMs,
  Event,
  EventMetadata,
  ExplorerConfig,
  getValidVideoTrimFromFields,
  toggleReflectionLike,
  useAuth,
  useCompanionAvatars,
  useExplorer,
} from '@projectmirror/shared';
import { collection, db, deleteDoc, doc, getCountFromServer, getDoc, onSnapshot, orderBy, query, where } from '@projectmirror/shared/firebase';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system';
import { Image } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import type { QuerySnapshot } from 'firebase/firestore';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  FlatList,
  Modal,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { ReplayModal } from '@/components/ReplayModal';

interface SentReflection {
  event_id: string;
  timestamp: any;
  sentTimestamp?: any;
  status?: 'ready' | 'engaged' | 'replayed' | 'deleted';
  engagementTimestamp?: any;
  engagementCount?: number;
  likedBy: string[];
  deletedAt?: any;
  hasResponse?: boolean;
  responseImageUrl?: string;
  reflectionImageUrl?: string;
  /** Denormalized for list row; prefer reading from `metadata` when present */
  description?: string;
  sender?: string;
  sender_id?: string;
  metadata?: EventMetadata;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const asOptionalString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const coerceLikedBy = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((uid): uid is string => typeof uid === 'string' && uid.length > 0) : [];

function coerceEmbeddedMetadata(raw: unknown, fallbackEventId: string): EventMetadata | undefined {
  if (!isRecord(raw)) return undefined;
  const o = raw;
  const description = typeof o.description === 'string' ? o.description : '';
  const shortCaption = typeof o.short_caption === 'string' ? o.short_caption : '';
  const sender = typeof o.sender === 'string' ? o.sender : '';
  if (!description && !shortCaption && !sender) return undefined;

  let timestamp: string;
  const ts = o.timestamp;
  if (typeof ts === 'string') {
    timestamp = ts;
  } else if (ts && typeof ts === 'object' && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    timestamp = (ts as { toDate: () => Date }).toDate().toISOString();
  } else {
    timestamp = new Date().toISOString();
  }

  const event_id =
    typeof o.event_id === 'string' && o.event_id.length > 0 ? o.event_id : fallbackEventId;
  const meta: EventMetadata = {
    description: description || shortCaption || 'Reflection',
    sender: sender || 'Companion',
    timestamp,
    event_id,
  };
  if (typeof o.sender_id === 'string' && o.sender_id) meta.sender_id = o.sender_id;
  if (o.content_type === 'text' || o.content_type === 'audio' || o.content_type === 'video') {
    meta.content_type = o.content_type;
  }
  if (o.image_source === 'camera' || o.image_source === 'search' || o.image_source === 'gallery') {
    meta.image_source = o.image_source;
  }
  if (shortCaption) meta.short_caption = shortCaption;
  if (typeof o.deep_dive === 'string' && o.deep_dive) meta.deep_dive = o.deep_dive;
  if (typeof o.companion_in_reflection === 'boolean') meta.companion_in_reflection = o.companion_in_reflection;
  if (typeof o.explorer_in_reflection === 'boolean') meta.explorer_in_reflection = o.explorer_in_reflection;
  if (typeof o.is_companion_present === 'boolean') meta.is_companion_present = o.is_companion_present;
  if (typeof o.is_explorer_present === 'boolean') meta.is_explorer_present = o.is_explorer_present;
  if (typeof o.is_selfie === 'boolean') meta.is_selfie = o.is_selfie;
  if (typeof o.people_context === 'string' && o.people_context.trim()) meta.people_context = o.people_context;
  if (typeof o.people_context_hints === 'string' && o.people_context_hints.trim()) {
    meta.people_context_hints = o.people_context_hints;
  }
  if (typeof o.search_query === 'string' && o.search_query.trim()) meta.search_query = o.search_query;
  if (typeof o.search_canonical_name === 'string' && o.search_canonical_name.trim()) meta.search_canonical_name = o.search_canonical_name;
  if (typeof o.library_id === 'string' && o.library_id.trim()) meta.library_id = o.library_id.trim();
  if (o.library_source === 'unsplash' || o.library_source === 'camera' || o.library_source === 'gallery') {
    meta.library_source = o.library_source;
  }
  if (typeof o.library_search_term === 'string' && o.library_search_term.trim()) {
    meta.library_search_term = o.library_search_term.trim();
  }
  if (typeof o.last_edited_at === 'string' && o.last_edited_at.trim()) {
    meta.last_edited_at = o.last_edited_at.trim();
  }
  const trim = getValidVideoTrimFromFields(o.video_start_ms, o.video_end_ms);
  if (trim) {
    meta.video_start_ms = trim.startMs;
    meta.video_end_ms = trim.endMs;
  }
  const thumbMs = coerceThumbnailTimeMs(o.thumbnail_time_ms);
  if (thumbMs !== undefined) {
    meta.thumbnail_time_ms = thumbMs;
  }
  return meta;
}

function applyDisplayFromMetadata(reflection: SentReflection): void {
  const m = reflection.metadata;
  if (!m) return;
  const blurb = m.short_caption || m.description;
  if (blurb) reflection.description = blurb;
  if (m.sender) reflection.sender = m.sender;
  if (m.sender_id) reflection.sender_id = m.sender_id;
  if (!reflection.sentTimestamp && m.timestamp) {
    try {
      reflection.sentTimestamp = new Date(m.timestamp);
    } catch {
      /* ignore */
    }
  }
}

function reflectionBlurb(item: SentReflection): string | undefined {
  const m = item.metadata;
  const text = m?.short_caption || m?.description || item.description;
  const s = typeof text === 'string' ? text.trim() : '';
  return s || undefined;
}

function reflectionSenderLabel(item: SentReflection): string | undefined {
  return item.metadata?.sender || item.sender;
}

/**
 * Whether this row is the current Companion's own reflection (for showing Edit).
 * Firestore often has `metadata.sender_id` but omits root `sender_id`; older rows may only match by display name.
 */
function timelineRowIsOwnedByCurrentCompanion(
  item: SentReflection,
  authUid: string | undefined,
  currentIdentity: string | null
): boolean {
  if (authUid) {
    if (item.sender_id === authUid) return true;
    if (item.metadata?.sender_id === authUid) return true;
  }
  if (currentIdentity) {
    const label = reflectionSenderLabel(item);
    if (label?.toLowerCase() === currentIdentity.toLowerCase()) return true;
  }
  return false;
}

type SentTimelineScreenProps = {
  /** Open CreationModal in edit mode for this reflection (same Explorer). */
  onEditReflection?: (event: Event) => void;
};

export default function SentTimelineScreen({ onEditReflection }: SentTimelineScreenProps) {
  const [reflections, setReflections] = useState<SentReflection[]>([]);
  const [loading, setLoading] = useState(true);
  const [responseEventIds, setResponseEventIds] = useState<Set<string>>(new Set());
  const [responseEventIdMap, setResponseEventIdMap] = useState<Map<string, string>>(new Map()); // event_id -> response_event_id
  const [selectedSelfieEventId, setSelectedSelfieEventId] = useState<string | null>(null);
  const [responseTimestampMap, setResponseTimestampMap] = useState<Map<string, any>>(new Map()); // event_id -> timestamp
  const [selfieImageUrl, setSelfieImageUrl] = useState<string | null>(null);
  const [loadingSelfie, setLoadingSelfie] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0); // Increment to force refresh
  const [filterMode, setFilterModeState] = useState<'mine' | 'all'>('mine');
  const [sortBy, setSortByState] = useState<'recent' | 'sent' | 'impact'>('recent');

  const SORT_STORAGE_KEY = 'timeline_sort_order';
  const FILTER_STORAGE_KEY = 'timeline_filter_mode';
  const VALID_SORTS = new Set(['recent', 'sent', 'impact']);
  const VALID_FILTERS = new Set(['mine', 'all']);

  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(SORT_STORAGE_KEY),
      AsyncStorage.getItem(FILTER_STORAGE_KEY),
    ]).then(([sort, filter]) => {
      if (sort && VALID_SORTS.has(sort)) setSortByState(sort as typeof sortBy);
      if (filter && VALID_FILTERS.has(filter)) setFilterModeState(filter as typeof filterMode);
    }).catch(() => {});
  }, []);

  const setSortBy = useCallback((val: typeof sortBy) => {
    setSortByState(val);
    AsyncStorage.setItem(SORT_STORAGE_KEY, val).catch(() => {});
  }, []);

  const setFilterMode = useCallback((val: typeof filterMode) => {
    setFilterModeState(val);
    AsyncStorage.setItem(FILTER_STORAGE_KEY, val).catch(() => {});
  }, []);
  const [selectedReflection, setSelectedReflection] = useState<Event | null>(null);
  /** Row opened via ⋮ overflow (Edit / Delete use the same icon styling as before). */
  const [reflectionActionMenu, setReflectionActionMenu] = useState<SentReflection | null>(null);
  const [likesModalReflection, setLikesModalReflection] = useState<SentReflection | null>(null);
  const [eventObjectsMap, setEventObjectsMap] = useState<Map<string, Event>>(new Map()); // event_id -> full Event object
  /** True total Firestore reflection signals for this Explorer (list query is capped at 100). */
  const [totalReflectionCount, setTotalReflectionCount] = useState<number | null>(null);
  const countRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { currentExplorerId, activeRelationship, explorerName, loading: explorerLoading } = useExplorer();
  const { user: authUser } = useAuth();
  const currentIdentity = activeRelationship?.companionName || null;
  const snapshotGenRef = useRef(0);

  // Companion avatar filter
  const { companions, loading: companionsLoading } = useCompanionAvatars(currentExplorerId);
  const [selectedCompanionId, setSelectedCompanionId] = useState<string | null>(null);
  const companionById = useMemo(() => new Map(companions.map((companion) => [companion.userId, companion])), [companions]);

  // Toast state
  const [toastMessage, setToastMessage] = useState('');
  const toastOpacity = useRef(new Animated.Value(0)).current;

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    Animated.sequence([
      Animated.timing(toastOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
      Animated.delay(2000),
      Animated.timing(toastOpacity, { toValue: 0, duration: 300, useNativeDriver: true })
    ]).start(() => setToastMessage(''));
  }, [toastOpacity]);

  const updateReflectionLikedBy = useCallback((eventId: string, likedBy: string[]) => {
    setReflections((prev) => prev.map((reflection) => (
      reflection.event_id === eventId ? { ...reflection, likedBy } : reflection
    )));
    setLikesModalReflection((current) => (
      current?.event_id === eventId ? { ...current, likedBy } : current
    ));
  }, []);

  const handleToggleLike = useCallback((item: SentReflection) => {
    const userId = authUser?.uid;
    if (!userId) {
      showToast('Sign in to like Reflections');
      return;
    }
    const likedBy = Array.isArray(item.likedBy) ? item.likedBy : [];
    const isLiked = likedBy.includes(userId);
    const nextLikedBy = isLiked ? likedBy.filter((uid) => uid !== userId) : [...likedBy, userId];
    updateReflectionLikedBy(item.event_id, nextLikedBy);
    toggleReflectionLike(item.event_id, userId, !isLiked);
  }, [authUser?.uid, showToast, updateReflectionLikedBy]);

  const handleReplayToggleLike = useCallback((eventId: string, isAdd: boolean) => {
    const userId = authUser?.uid;
    if (!userId) {
      showToast('Sign in to like Reflections');
      return;
    }
    const currentLikedBy = reflections.find((reflection) => reflection.event_id === eventId)?.likedBy ?? [];
    const nextLikedBy = isAdd
      ? (currentLikedBy.includes(userId) ? currentLikedBy : [...currentLikedBy, userId])
      : currentLikedBy.filter((uid) => uid !== userId);
    updateReflectionLikedBy(eventId, nextLikedBy);
    toggleReflectionLike(eventId, userId, isAdd);
  }, [authUser?.uid, reflections, showToast, updateReflectionLikedBy]);

  const selectedReflectionLikedBy = useMemo(() => (
    selectedReflection
      ? reflections.find((reflection) => reflection.event_id === selectedReflection.event_id)?.likedBy ?? []
      : []
  ), [reflections, selectedReflection]);

  // Derive display reflections with fresh hasResponse values
  // This ensures the list updates when responseEventIds changes
  // SORTED BY: Response timestamp (viewed) first, so most recently viewed are at top
  const displayReflections = useMemo(() => {
    let result = (Array.isArray(reflections) ? reflections : []).filter(Boolean).map(r => ({
      ...r,
      hasResponse: !r.deletedAt && r.status !== 'deleted' && responseEventIds.has(r.event_id),
    }));

    // Do not include soft-deleted items in the timeline list
    result = result.filter(r => !r.deletedAt && r.status !== 'deleted');

    // Filter by selected companion avatar (null = show all)
    if (selectedCompanionId) {
      const companion = (Array.isArray(companions) ? companions : []).find(c => c?.userId === selectedCompanionId);
      if (companion) {
        result = result.filter(r => {
          if (r.sender_id) return r.sender_id === selectedCompanionId;
          if (r.sender && companion?.companionName) {
            return r.sender.toLowerCase() === companion.companionName.toLowerCase();
          }
          return false;
        });
      }
    }

    // Helper to get timestamp value in milliseconds (Firestore Timestamp, Date, ISO string, or epoch ms)
    const getTimestampMs = (ts: any): number => {
      if (ts == null) return 0;
      if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
      if (typeof ts === 'string') {
        const parsed = Date.parse(ts);
        return Number.isNaN(parsed) ? 0 : parsed;
      }
      if (ts instanceof Date) return ts.getTime();
      if (typeof ts.toMillis === 'function') return ts.toMillis();
      if (typeof ts.seconds === 'number') {
        return ts.seconds * 1000 + (typeof ts.nanoseconds === 'number' ? ts.nanoseconds : 0) / 1e6;
      }
      return 0;
    };

    result.sort((a, b) => {
      if (sortBy === 'impact') {
        const scoreA = (a.engagementCount || 0) + (responseEventIds.has(a.event_id) ? 1 : 0);
        const scoreB = (b.engagementCount || 0) + (responseEventIds.has(b.event_id) ? 1 : 0);
        const diff = scoreB - scoreA;
        if (diff !== 0) return diff;
      }

      if (sortBy === 'sent') {
        // Sent view should prioritize original send time (metadata timestamp),
        // not later activity/edit bumps on the root timestamp.
        const aSentTime = getTimestampMs(a.metadata?.timestamp || a.sentTimestamp || a.timestamp);
        const bSentTime = getTimestampMs(b.metadata?.timestamp || b.sentTimestamp || b.timestamp);
        const sentDiff = bSentTime - aSentTime;
        if (sentDiff !== 0) return sentDiff;

        // If original send times tie, use most recent root update as tiebreaker.
        const aRootTime = getTimestampMs(a.timestamp);
        const bRootTime = getTimestampMs(b.timestamp);
        const rootDiff = bRootTime - aRootTime;
        if (rootDiff !== 0) return rootDiff;
        return (reflectionSenderLabel(a) || '').localeCompare(reflectionSenderLabel(b) || '');
      }

      // 'recent' (default) and 'impact' tiebreaker: response time first, then doc timestamp (edit bumps order)
      const aResponseTs = responseTimestampMap.get(a.event_id);
      const bResponseTs = responseTimestampMap.get(b.event_id);
      const aTime = aResponseTs ? getTimestampMs(aResponseTs) : getTimestampMs(a.timestamp || a.sentTimestamp);
      const bTime = bResponseTs ? getTimestampMs(bResponseTs) : getTimestampMs(b.timestamp || b.sentTimestamp);
      return bTime - aTime;
    });

    return result;
  }, [reflections, responseEventIds, responseTimestampMap, selectedCompanionId, companions, sortBy]);

  const timelineBadgeCount = useMemo(() => {
    const listLen = displayReflections.length;
    if (selectedCompanionId) {
      return listLen;
    }
    if (totalReflectionCount !== null) {
      return totalReflectionCount;
    }
    return listLen;
  }, [displayReflections.length, selectedCompanionId, totalReflectionCount]);

  const scheduleReflectionCountRefresh = useCallback(() => {
    if (!currentExplorerId) return;
    if (countRefreshTimerRef.current) clearTimeout(countRefreshTimerRef.current);
    countRefreshTimerRef.current = setTimeout(async () => {
      countRefreshTimerRef.current = null;
      try {
        const reflectionsRef = collection(db, ExplorerConfig.collections.reflections);
        const countQuery = query(reflectionsRef, where('explorerId', '==', currentExplorerId));
        const countSnap = await getCountFromServer(countQuery);
        const count = countSnap?.data?.()?.count ?? 0;
        setTotalReflectionCount(typeof count === 'number' ? count : 0);
      } catch {
        setTotalReflectionCount(null);
      }
    }, 350);
  }, [currentExplorerId]);

  // Listen to reflection_responses collection to detect new selfie responses
  useEffect(() => {
    // GUARD: If no Explorer ID is set yet, do not query
    if (!currentExplorerId) return;

    const responsesRef = collection(db, ExplorerConfig.collections.responses);
    const q = query(responsesRef, where('explorerId', '==', currentExplorerId));
    const unsubscribeResponses = onSnapshot(q, (snapshot) => {
      const eventIds = new Set<string>();
      const eventIdMap = new Map<string, string>();
      const timestampMap = new Map<string, any>();
      (snapshot?.docs ?? []).filter(Boolean).forEach((doc) => {
        const data = doc.data?.();
        if (!isRecord(data)) return;
        // Document ID = original reflection event_id. S3 path uses response_event_id (or doc.id for new model)
        const originalEventId = doc.id;
        const responseEventId = asOptionalString(data?.response_event_id) ?? originalEventId;

        if (originalEventId) {
          eventIds.add(originalEventId);
          eventIdMap.set(originalEventId, responseEventId);
          if (data.timestamp) {
            timestampMap.set(originalEventId, data.timestamp);
          }
        }
      });
      setResponseEventIds(eventIds);
      setResponseEventIdMap(eventIdMap);
      setResponseTimestampMap(timestampMap);
    }, (error) => {
      console.error('Error listening to reflection_responses:', error);
    });

    return () => unsubscribeResponses();
  }, [currentExplorerId]); // ADDED DEPENDENCY: Only re-run when ID changes

  useEffect(() => {
    // GUARD: If no Explorer ID is set yet, stop loading and do not query
    if (!currentExplorerId) {
      setLoading(false);
      setTotalReflectionCount(null);
      if (countRefreshTimerRef.current) {
        clearTimeout(countRefreshTimerRef.current);
        countRefreshTimerRef.current = null;
      }
      return;
    }

    scheduleReflectionCountRefresh();

    setLoading(true);

    // Listen to reflections collection for sent Reflections
    const reflectionsRef = collection(db, ExplorerConfig.collections.reflections);
    const q =
      sortBy === 'sent'
        ? query(
            reflectionsRef,
            where('explorerId', '==', currentExplorerId),
            where('type', 'in', ['mirror_event', 'engagement_heartbeat']),
            orderBy('timestamp', 'desc')
          )
        : query(
            reflectionsRef,
            where('explorerId', '==', currentExplorerId),
            orderBy('timestamp', 'desc')
          );

    const unsubscribe = onSnapshot(
      q,
      async (snapshot: QuerySnapshot) => {
        const gen = ++snapshotGenRef.current;

        // Group signals by event_id, keeping the one with highest status priority
        const reflectionMap = new Map<string, SentReflection>();

        // Status priority: replayed > engaged > ready > deleted
        const statusPriority: { [key: string]: number } = {
          'replayed': 4,
          'engaged': 3,
          'ready': 2,
          'deleted': 1,
        };

        for (const docSnapshot of snapshot?.docs ?? []) {
          const data = docSnapshot.data?.();
          if (!isRecord(data)) continue;
          const docId = docSnapshot.id; // Document ID should be the event_id
          const eventIdFromData = asOptionalString(data?.event_id);

          // Use document ID as the primary key (it should be the event_id)
          // Fall back to event_id field if document ID is somehow different
          const actualEventId = docId || eventIdFromData;
          if (!actualEventId) continue;

          // Warn if document ID doesn't match event_id field
          if (eventIdFromData && docId !== eventIdFromData) {
            console.warn(`Document ID (${docId}) doesn't match event_id field (${eventIdFromData})`);
          }

          const currentStatus =
            data?.status === 'engaged' ||
            data?.status === 'replayed' ||
            data?.status === 'deleted' ||
            data?.status === 'ready'
              ? data.status
              : 'ready';
          const currentPriority = statusPriority[currentStatus] || 0;

          // Check if we already have this event_id
          const existing = reflectionMap.get(actualEventId);
          const existingPriority = existing ? (statusPriority[existing.status || 'ready'] || 0) : 0;

          // Helper to convert Firestore timestamp to number
          const getTimestampValue = (ts: any): number => {
            if (!ts) return 0;
            if (ts.toMillis) return ts.toMillis();
            if (ts.seconds) return ts.seconds * 1000 + (ts.nanoseconds || 0) / 1000000;
            if (typeof ts === 'number') return ts;
            return 0;
          };

          const currentTime = getTimestampValue(data.timestamp);

          // Deduplicate by event_id - use document ID as fallback
          // Always use the latest status we see for this event_id
          if (!existing) {
            // First time seeing this event_id
            reflectionMap.set(actualEventId, {
              event_id: actualEventId,
              timestamp: data.timestamp,
              sentTimestamp: currentStatus === 'ready' ? data.timestamp : undefined, // Preserve original sent time
              status: currentStatus,
              engagementTimestamp: (currentStatus === 'engaged' || currentStatus === 'replayed') ? data.timestamp : undefined,
              engagementCount: typeof data.engagement_count === 'number' ? data.engagement_count : 0,
              likedBy: coerceLikedBy(data.likedBy),
              deletedAt: currentStatus === 'deleted' ? data.deleted_at : undefined,
              sender: asOptionalString(data?.sender) ?? undefined,
              sender_id: asOptionalString(data?.sender_id) ?? undefined,
            });
          } else {
            // We already have this event_id - always update to higher priority status
            const existingTime = getTimestampValue(existing.timestamp);
            const existingEngTime = getTimestampValue(existing.engagementTimestamp);

            // ALWAYS preserve original sent timestamp from 'ready' status
            // This ensures we capture it even if we see 'engaged'/'replayed' first
            if (currentStatus === 'ready') {
              // If we don't have sentTimestamp yet, or this 'ready' timestamp is earlier, use it
              if (!existing.sentTimestamp) {
                existing.sentTimestamp = data.timestamp;
              } else {
                const existingSentTime = getTimestampValue(existing.sentTimestamp);
                if (currentTime < existingSentTime) {
                  // This 'ready' signal is earlier, use it as the sent time
                  existing.sentTimestamp = data.timestamp;
                }
              }
            }

            // Always update status if this signal has higher priority
            if (currentPriority > existingPriority) {
              existing.status = currentStatus;
              existing.timestamp = data.timestamp;
              // Update sender if available
              const sender = asOptionalString(data?.sender);
              if (sender) {
                existing.sender = sender;
              }
              // Update engagement timestamp for engaged/replayed
              if (currentStatus === 'engaged' || currentStatus === 'replayed') {
                existing.engagementTimestamp = data.timestamp;
              }
              // Update engagement count if provided
              if (typeof data.engagement_count === 'number') {
                existing.engagementCount = Math.max(existing.engagementCount || 0, data.engagement_count);
              }
              // Update deleted_at for deleted status
              if (currentStatus === 'deleted') {
                existing.deletedAt = data.deleted_at;
              }
            } else if (currentPriority === existingPriority && currentStatus === existing.status) {
              // Same priority and status - just update timestamp if newer
              if (currentTime > existingTime) {
                existing.timestamp = data.timestamp;
                // Update engagement timestamp if this is a newer engagement/replay signal
                if ((currentStatus === 'engaged' || currentStatus === 'replayed')) {
                  existing.engagementTimestamp = data.timestamp;
                }
              }
              // Update engagement count if provided (even if timestamp isn't newer)
              if (typeof data.engagement_count === 'number') {
                existing.engagementCount = Math.max(existing.engagementCount || 0, data.engagement_count);
              }
              // Update sender if available (even if timestamp isn't newer)
              const sender = asOptionalString(data?.sender);
              if (sender) {
                existing.sender = sender;
              }
            } else if (currentPriority === existingPriority && currentStatus !== existing.status) {
              // Same priority but different status - this shouldn't happen, but log it
              console.warn(`Same priority but different status for ${actualEventId}: ${existing.status} vs ${currentStatus}, keeping existing`);
            } else {
              // Lower priority signal - don't update status, but update engagement timestamp if newer
              if ((currentStatus === 'engaged' || currentStatus === 'replayed')) {
                if (!existing.engagementTimestamp || currentTime > existingEngTime) {
                  existing.engagementTimestamp = data.timestamp;
                }
              }
              // Update engagement count if provided
              if (typeof data.engagement_count === 'number') {
                existing.engagementCount = Math.max(existing.engagementCount || 0, data.engagement_count);
              }
            }
          }

          const row = reflectionMap.get(actualEventId);
          if (row) {
            row.likedBy = coerceLikedBy(data.likedBy);
            const m = coerceEmbeddedMetadata(data.metadata, actualEventId);
            if (m) {
              row.metadata = m;
              applyDisplayFromMetadata(row);
            }
          }
        }

        // Fetch Mirror Events List ONCE for all reflections
        let allMirrorEventsMap = new Map<string, Event>();
        try {
          const eventsResponse = await fetch(`${API_ENDPOINTS.LIST_MIRROR_EVENTS}?explorer_id=${currentExplorerId}`);
          if (gen !== snapshotGenRef.current) return; // stale — newer snapshot arrived
          if (eventsResponse.ok) {
            const eventsData = await eventsResponse.json().catch(() => null);
            const events = isRecord(eventsData) && Array.isArray(eventsData?.events) ? eventsData.events : [];
            events.filter(Boolean).forEach((e) => {
              const event = e as Event;
              const eventId = asOptionalString(event?.event_id);
              if (eventId) allMirrorEventsMap.set(eventId, event);
            });
          }
        } catch (error) {
          console.error('Error fetching reflection events list:', error);
        }

        // Enrich from list API (image URLs + embedded metadata when Firestore has none yet)
        const reflectionsList = Array.from(reflectionMap.values())
          .filter(Boolean)
          .filter((reflection) => !reflection.deletedAt && reflection.status !== 'deleted')
          .map((reflection) => {
            const matchingEvent = allMirrorEventsMap.get(reflection.event_id);
            if (matchingEvent?.image_url) {
              reflection.reflectionImageUrl = matchingEvent.image_url;
            }
            const listMeta = matchingEvent?.metadata;
            if (listMeta && !reflection.metadata) {
              reflection.metadata = listMeta;
              applyDisplayFromMetadata(reflection);
            }

            reflection.hasResponse =
              !reflection.deletedAt &&
              reflection.status !== 'deleted' &&
              responseEventIds.has(reflection.event_id);

            return reflection;
          });
        if (gen !== snapshotGenRef.current) return; // stale — newer snapshot arrived

        // Store Event objects in state for replay functionality
        const eventsMap = new Map<string, Event>();
        allMirrorEventsMap.forEach((event, eventId) => {
          eventsMap.set(eventId, event);
        });
        setEventObjectsMap(eventsMap);

        // Sort by timestamp descending (most recent first)
        // Viewed/engaged first, then doc timestamp (updates on edit) before preserved first-sent time
        reflectionsList.sort((a, b) => {
          // Helper to get timestamp value
          const getTime = (reflection: SentReflection): number => {
            const ts =
              reflection.engagementTimestamp || reflection.timestamp || reflection.sentTimestamp;
            if (!ts) return 0;
            if (ts.toMillis) return ts.toMillis();
            if (ts.seconds) return ts.seconds * 1000 + (ts.nanoseconds || 0) / 1000000;
            if (typeof ts === 'number') return ts;
            return 0;
          };

          const aTime = getTime(a);
          const bTime = getTime(b);
          return bTime - aTime; // Most recent first
        });

        setReflections(reflectionsList);
        setLoading(false);
        scheduleReflectionCountRefresh();
      },
      (error) => {
        console.error('Error listening to reflections:', error);
        setLoading(false);
      }
    );

    return () => {
      unsubscribe();
      if (countRefreshTimerRef.current) {
        clearTimeout(countRefreshTimerRef.current);
        countRefreshTimerRef.current = null;
      }
    };
  }, [currentExplorerId, scheduleReflectionCountRefresh, sortBy]);

  // Refresh local data when app comes to foreground
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'active') {
        setRefreshTrigger(prev => prev + 1);
      }
    });

    return () => subscription.remove();
  }, []);

  // Refresh local data when refreshTrigger changes
  useEffect(() => {
    // Trigger refresh when app comes to foreground
  }, [refreshTrigger]);

  const deleteReflection = useCallback(async (item: SentReflection) => {
    if (!currentExplorerId) return;

    try {
      // 1. Delete S3 objects (to/ path - reflection content)
      const deleteRes = await fetch(
        `${API_ENDPOINTS.DELETE_MIRROR_EVENT}?event_id=${item.event_id}&explorer_id=${currentExplorerId}&path=to`,
        { method: 'DELETE' }
      );
      if (!deleteRes.ok) {
        const errData = await deleteRes.json().catch(() => null);
        const errors = isRecord(errData) && Array.isArray(errData?.errors) ? errData.errors : [];
        throw new Error(errors.filter((e): e is string => typeof e === 'string').join(', ') || 'Failed to delete reflection');
      }

      // 2. Delete selfie response image from S3 if it exists
      const responseEventId = responseEventIdMap.get(item.event_id);
      if (responseEventId) {
        await fetch(
          `${API_ENDPOINTS.DELETE_MIRROR_EVENT}?event_id=${responseEventId}&path=from&explorer_id=${currentExplorerId}`,
          { method: 'DELETE' }
        ).catch(() => {});
      }

      // 3. Delete response doc if it exists
      const responseRef = doc(db, ExplorerConfig.collections.responses, item.event_id);
      try {
        const responseDoc = await getDoc(responseRef);
        if (responseDoc.exists()) {
          await deleteDoc(responseRef);
        }
      } catch {}

      // 4. Hard delete reflection document
      const reflectionRef = doc(db, ExplorerConfig.collections.reflections, item.event_id);
      await deleteDoc(reflectionRef);

      showToast('🗑️ Reflection deleted');
    } catch (error: any) {
      console.error('Delete reflection error:', error);
      Alert.alert('Delete Failed', error.message || 'Failed to delete reflection');
    }
  }, [currentExplorerId, responseEventIdMap]);

  const resolveEventForEdit = useCallback(
    async (item: SentReflection): Promise<Event | null> => {
      if (!currentExplorerId) return null;
      const tsToISO = (ts: any): string => {
        if (!ts) return new Date().toISOString();
        if (ts.toDate) return ts.toDate().toISOString();
        if (ts.seconds) return new Date(ts.seconds * 1000 + (ts.nanoseconds || 0) / 1000000).toISOString();
        if (typeof ts === 'number') return new Date(ts).toISOString();
        if (typeof ts === 'string') return ts;
        return new Date(ts).toISOString();
      };

      let fullEvent = eventObjectsMap.get(item.event_id);
      if (!fullEvent) {
        try {
          const eventsResponse = await fetch(`${API_ENDPOINTS.LIST_MIRROR_EVENTS}?explorer_id=${currentExplorerId}`);
          if (eventsResponse.ok) {
            const eventsData = await eventsResponse.json().catch(() => null);
            const events = isRecord(eventsData) && Array.isArray(eventsData?.events) ? eventsData.events : [];
            const matchingEvent = events.filter(Boolean).find((e) => (e as Event)?.event_id === item.event_id) as Event | undefined;
            if (matchingEvent) {
              fullEvent = matchingEvent;
              setEventObjectsMap((prev) => new Map(prev).set(item.event_id, matchingEvent));
            }
          }
        } catch (err) {
          console.error('Error fetching event for edit:', err);
        }
      }

      // Firestore row metadata can omit video trim/poster (stored on the S3 bundle); list API fills them.
      const rowMeta = item.metadata as EventMetadata | undefined;
      const listMeta = fullEvent?.metadata as EventMetadata | undefined;
      const metadata =
        rowMeta && listMeta
          ? ({ ...rowMeta, ...listMeta } as EventMetadata)
          : rowMeta ?? listMeta;
      const imageUrl = asOptionalString(fullEvent?.image_url) ?? asOptionalString(item.reflectionImageUrl) ?? '';
      if (!imageUrl) {
        Alert.alert('Cannot edit', 'Image URL is not available for this reflection yet.');
        return null;
      }

      return {
        event_id: item.event_id,
        image_url: imageUrl,
        audio_url: fullEvent?.audio_url,
        video_url: fullEvent?.video_url,
        deep_dive_audio_url: fullEvent?.deep_dive_audio_url,
        metadata: metadata || {
          description: item.description || 'Reflection',
          sender: reflectionSenderLabel(item) || 'Companion',
          timestamp: tsToISO(item.sentTimestamp || item.timestamp),
          event_id: item.event_id,
          short_caption: item.description || 'Reflection',
        },
      };
    },
    [currentExplorerId, eventObjectsMap]
  );

  const getStatusText = (status?: string, hasEngagementTimestamp?: boolean, hasSelfie?: boolean) => {
    if (status === 'deleted') return 'Deleted';
    if (status === 'replayed') return 'Replayed';
    if (hasSelfie) return 'Engaged';
    if (hasEngagementTimestamp) return 'Viewed';
    return 'Sent';
  };

  const getStatusColor = (status?: string, hasEngagementTimestamp?: boolean, hasSelfie?: boolean) => {
    if (status === 'deleted') return '#ef5350';
    if (status === 'replayed') return '#4ade80';
    if (hasSelfie) return '#38bdf8';
    if (hasEngagementTimestamp) return '#22d3ee'; // Viewed — bright cyan
    return '#fbbf24'; // Sent
  };

  const formatEngagementDate = (timestamp: any) => {
    if (!timestamp) return 'in the past';

    try {
      let date: Date;

      // Handle Firestore Timestamp with toDate() method
      if (timestamp.toDate) {
        date = timestamp.toDate();
      }
      // Handle serialized Firestore timestamp {seconds, nanoseconds}
      else if (timestamp.seconds !== undefined) {
        date = new Date(timestamp.seconds * 1000 + (timestamp.nanoseconds || 0) / 1000000);
      }
      // Handle raw number (milliseconds)
      else if (typeof timestamp === 'number') {
        date = new Date(timestamp);
      }
      // Fallback
      else {
        date = new Date(timestamp);
      }

      // Validate the date is actually valid
      if (isNaN(date.getTime())) {
        return 'in the past';
      }

      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return 'just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      if (diffDays < 7) return `${diffDays}d ago`;

      // For older dates, show month/day
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch (error) {
      return 'in the past';
    }
  };

  if (loading || explorerLoading || !currentExplorerId) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.gradient}>
          <View style={styles.centerContainer}>
            <ActivityIndicator size="large" color="#4FC3F7" />
            <Text style={styles.loadingText}>Loading timeline...</Text>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // Check if we should show empty state (use displayReflections for filtered view)
  const hasReflections = displayReflections.length > 0;
  const hasAnyReflections = reflections.length > 0;

  // Save selfie to camera roll
  const saveSelfieToPhotos = async () => {
    if (!selfieImageUrl) return;

    try {
      // Download the image to a temporary location
      const fileUri = FileSystem.documentDirectory + `selfie_${Date.now()}.jpg`;
      const downloadResult = await FileSystem.downloadAsync(selfieImageUrl, fileUri);

      if (downloadResult.status !== 200) {
        throw new Error('Failed to download image');
      }

      // Save to camera roll
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Denied', 'We need permission to save photos to your camera roll.');
        return;
      }

      await MediaLibrary.saveToLibraryAsync(downloadResult.uri);
      showToast('📸 Selfie saved to Photos');

    } catch (error) {
      console.error('Error saving selfie:', error);
      Alert.alert('Error', 'Failed to save selfie to Photos');
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Selfie Image Modal */}
      <Modal
        visible={selectedSelfieEventId !== null}
        transparent={true}
        animationType="fade"
        onRequestClose={() => {
          setSelectedSelfieEventId(null);
          setSelfieImageUrl(null);
        }}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => {
            setSelectedSelfieEventId(null);
            setSelfieImageUrl(null);
          }}
        >
          <View style={styles.modalContent}>
            <TouchableOpacity
              style={styles.modalCloseButton}
              onPress={() => {
                setSelectedSelfieEventId(null);
                setSelfieImageUrl(null);
              }}
            >
              <Text style={styles.modalCloseText}>✕</Text>
            </TouchableOpacity>
            {loadingSelfie ? (
              <ActivityIndicator size="large" color="#4ade80" />
            ) : selfieImageUrl ? (
              <Image
                source={{ uri: selfieImageUrl }}
                style={styles.selfieImage}
                contentFit="contain"
                cachePolicy="memory-disk"
                onError={(error) => {
                  console.error('Error loading selfie image:', error);
                }}
              />
            ) : (
              <View style={{ alignItems: 'center' }}>
                <Text style={styles.modalErrorText}>Failed to load selfie</Text>
                <Text style={[styles.modalErrorText, { fontSize: 12, marginTop: 8, opacity: 0.7 }]}>
                  {selectedSelfieEventId ? `Event: ${selectedSelfieEventId}` : ''}
                </Text>
              </View>
            )}

            {/* Save Button */}
            {selfieImageUrl && !loadingSelfie && (
              <View style={{ width: '100%', alignItems: 'center' }}>
                {selectedSelfieEventId && responseTimestampMap.has(selectedSelfieEventId) && (
                  <Text style={styles.selfieTimestamp}>
                    Captured {formatEngagementDate(responseTimestampMap.get(selectedSelfieEventId))}
                  </Text>
                )}
                <TouchableOpacity
                  style={styles.saveSelfieButton}
                  onPress={saveSelfieToPhotos}
                >
                  <FontAwesome name="download" size={18} color="#fff" style={{ marginRight: 8 }} />
                  <Text style={styles.saveSelfieButtonText}>Save to Photos</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Toast Notification (Inside Modal) */}
            {toastMessage ? (
              <Animated.View style={[styles.toast, { opacity: toastOpacity, bottom: 20 }]}>
                <Text style={styles.toastText}>{toastMessage}</Text>
              </Animated.View>
            ) : null}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Timeline content: black background to blend with title (IG-style) */}
      <View style={styles.gradient}>
      {/* Header Section */}
      <View style={styles.headerContainer}>
        {/* Companion Avatar Filter */}
        {(Array.isArray(companions) ? companions : []).length > 0 && (
          <AvatarFilterBar
            companions={Array.isArray(companions) ? companions : []}
            selectedId={selectedCompanionId}
            onSelect={setSelectedCompanionId}
            loading={companionsLoading}
          />
        )}

        {/* Sort Toggle */}
        <View style={styles.sortContainer}>
          <View style={styles.sortButtonGroup}>
            <TouchableOpacity
              style={[styles.sortButton, sortBy === 'recent' && styles.sortButtonActive]}
              onPress={() => setSortBy('recent')}
            >
              <FontAwesome name="clock-o" size={12} color={sortBy === 'recent' ? '#4FC3F7' : '#aaa'} style={{ marginRight: 4 }} />
              <Text style={[styles.sortText, sortBy === 'recent' && styles.sortTextActive]}>Recent</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.sortButton, sortBy === 'sent' && styles.sortButtonActive]}
              onPress={() => setSortBy('sent')}
            >
              <FontAwesome name="paper-plane" size={12} color={sortBy === 'sent' ? '#4FC3F7' : '#aaa'} style={{ marginRight: 4 }} />
              <Text style={[styles.sortText, sortBy === 'sent' && styles.sortTextActive]}>Sent</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.sortButton, sortBy === 'impact' && styles.sortButtonActive]}
              onPress={() => setSortBy('impact')}
            >
              <FontAwesome name="fire" size={12} color={sortBy === 'impact' ? '#4FC3F7' : '#aaa'} style={{ marginRight: 4 }} />
              <Text style={[styles.sortText, sortBy === 'impact' && styles.sortTextActive]}>Impact</Text>
            </TouchableOpacity>
          </View>
          {timelineBadgeCount > 0 ? (
            <View
              style={styles.countBadge}
              accessibilityLabel={`${timelineBadgeCount.toLocaleString()} Reflections`}
            >
              <Text style={styles.countBadgeText}>{timelineBadgeCount.toLocaleString()}</Text>
            </View>
          ) : null}
        </View>
      </View>

      {/* Empty State */}
      {!hasReflections && hasAnyReflections && selectedCompanionId && (
        <View style={styles.centerContainer}>
          <FontAwesome name="inbox" size={64} color="#aaa" />
          <Text style={styles.emptyText}>No Reflections from this companion</Text>
        </View>
      )}

      {!hasAnyReflections && (
        <View style={styles.centerContainer}>
          <FontAwesome name="inbox" size={64} color="#aaa" />
          <Text style={styles.emptyText}>No Reflections sent yet</Text>
          <Text style={styles.emptySubtext}>Send a Reflection to see it here</Text>
        </View>
      )}

      {hasReflections && (
        <View style={styles.listArea}>
        <FlatList
          data={(Array.isArray(displayReflections) ? displayReflections : []).filter(Boolean)}
          keyExtractor={(item, index) => item?.event_id ?? `reflection-${index}`}
          renderItem={({ item, index }) => {
            if (!item?.event_id) return null;
            const hasSelfie = !!item.hasResponse;
            const rawEngagementCount = item.engagementCount ?? 0;
            const engagementCount = rawEngagementCount > 0 ? rawEngagementCount : (hasSelfie ? 1 : 0);
            const engagementTimestamp = hasSelfie
              ? responseTimestampMap.get(item.event_id)
              : item.engagementTimestamp;
            const sentDisplayTimestamp =
              item.metadata?.timestamp ||
              item.timestamp ||
              null;

            const isTopRanked = sortBy === 'impact' && index < 3 && engagementCount > 0;
            const rankColor = isTopRanked ? '#facc15' : '#cbd5e1';
            const likedBy = Array.isArray(item.likedBy) ? item.likedBy : [];
            const likeCount = likedBy.length;
            const likedByMe = !!authUser?.uid && likedBy.includes(authUser.uid);
            const likedByOthers = likeCount > 0 && !likedByMe;

            return (
              <TouchableOpacity
                style={styles.reflectionItem}
                activeOpacity={0.7}
                onPress={async () => {
                  // Get the full Event object if available
                  let fullEvent = eventObjectsMap.get(item.event_id);

                  // If we don't have the Event object, fetch it from the API
                  if (!fullEvent) {
                    try {
                      const eventsResponse = await fetch(`${API_ENDPOINTS.LIST_MIRROR_EVENTS}?explorer_id=${currentExplorerId}`);
                      if (eventsResponse.ok) {
                        const eventsData = await eventsResponse.json().catch(() => null);
                        const events = isRecord(eventsData) && Array.isArray(eventsData?.events) ? eventsData.events : [];
                        const matchingEvent = events.filter(Boolean).find((e) => (e as Event)?.event_id === item.event_id) as Event | undefined;
                        if (matchingEvent) {
                          fullEvent = matchingEvent;
                          // Update the map for future use
                          setEventObjectsMap(prev => new Map(prev).set(item.event_id, matchingEvent));
                        }
                      }
                    } catch (err) {
                      console.error('Error fetching event for replay:', err);
                    }
                  }

                  const metadata =
                    (item.metadata as EventMetadata | undefined) ??
                    (fullEvent?.metadata as EventMetadata | undefined);

                  // Helper to convert timestamp to ISO string
                  const timestampToISO = (ts: any): string => {
                    if (!ts) return new Date().toISOString();
                    if (ts.toDate) return ts.toDate().toISOString();
                    if (ts.seconds) return new Date(ts.seconds * 1000 + (ts.nanoseconds || 0) / 1000000).toISOString();
                    if (typeof ts === 'number') return new Date(ts).toISOString();
                    if (typeof ts === 'string') return ts;
                    return new Date(ts).toISOString();
                  };

                  // Construct Event object with all required fields
                  const eventForReplay: Event = {
                    event_id: item.event_id,
                    image_url: asOptionalString(fullEvent?.image_url) ?? asOptionalString(item.reflectionImageUrl) ?? '',
                    audio_url: fullEvent?.audio_url,
                    video_url: fullEvent?.video_url,
                    deep_dive_audio_url: fullEvent?.deep_dive_audio_url,
                    metadata: metadata || {
                      description: item.description || 'Reflection',
                      sender: reflectionSenderLabel(item) || 'Companion',
                      timestamp: timestampToISO(item.sentTimestamp || item.timestamp),
                      event_id: item.event_id,
                      short_caption: item.description || 'Reflection',
                    },
                  };

                  setSelectedReflection(eventForReplay);
                }}
              >
                <View style={styles.reflectionRow}>
                  {item.reflectionImageUrl ? (
                    <View style={styles.reflectionImageContainer}>
                      <Image
                        source={{ uri: item.reflectionImageUrl }}
                        style={styles.reflectionImage}
                        contentFit="cover"
                        recyclingKey={item.event_id}
                        cachePolicy="memory-disk"
                      />
                      {item.status === 'deleted' && (
                        <View style={styles.deletedOverlay}>
                          <FontAwesome name="trash" size={24} color="#fff" />
                        </View>
                      )}
                    </View>
                  ) : item.status === 'deleted' ? (
                    <View style={[styles.reflectionImage, styles.deletedImagePlaceholder]}>
                      <FontAwesome name="trash" size={32} color="#ef5350" />
                    </View>
                  ) : null}
                  <View style={styles.reflectionInfo}>
                    {/* ROW 1 — Caption + overflow (⋮); caption flexes so it never sits under actions */}
                    <View style={styles.infoTopRow}>
                      {reflectionBlurb(item) ? (
                        <View style={styles.captionRow}>
                          {item.metadata?.content_type === 'video' ? (
                            <FontAwesome name="video-camera" size={13} color="#e0e0e0" />
                          ) : (
                            <FontAwesome name="image" size={13} color="#e0e0e0" />
                          )}
                          <Text style={styles.description} numberOfLines={2} ellipsizeMode="tail">
                            {reflectionBlurb(item)}
                          </Text>
                        </View>
                      ) : (
                        <View style={styles.captionRowSpacer} />
                      )}
                      {(() => {
                        const canEditRow =
                          !!onEditReflection &&
                          timelineRowIsOwnedByCurrentCompanion(item, authUser?.uid, currentIdentity);
                        const canDeleteRow =
                          !!currentIdentity &&
                          reflectionSenderLabel(item)?.toLowerCase() === currentIdentity.toLowerCase();
                        if (!canEditRow && !canDeleteRow) return null;
                        return (
                          <TouchableOpacity
                            style={styles.overflowMenuButton}
                            onPress={() => setReflectionActionMenu(item)}
                            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                            accessibilityLabel="Reflection actions"
                          >
                            <FontAwesome name="ellipsis-v" size={18} color="rgba(255,255,255,0.75)" />
                          </TouchableOpacity>
                        );
                      })()}
                    </View>

                    {/* ROW 2 — Status + selfie badge */}
                    <View style={styles.statusRow}>
                      <View style={[styles.statusDot, { backgroundColor: getStatusColor(item.status, !!engagementTimestamp, hasSelfie) }]} />
                      <Text style={styles.statusText} numberOfLines={1}>
                        {getStatusText(item.status, !!engagementTimestamp, hasSelfie)}
                      </Text>
                      {item.status === 'deleted' && item.deletedAt ? (
                        <Text style={styles.engagementDate} numberOfLines={1}>
                          {formatEngagementDate(item.deletedAt)}
                        </Text>
                      ) : engagementTimestamp && item.status !== 'ready' ? (
                        <Text style={styles.engagementDate} numberOfLines={1}>
                          {formatEngagementDate(engagementTimestamp)}
                        </Text>
                      ) : null}
                      {item.hasResponse && (
                        <TouchableOpacity
                          style={styles.responseBadge}
                          onPress={async () => {
                            const responseEventId = responseEventIdMap.get(item.event_id);
                            if (!responseEventId) {
                              console.warn(`No responseEventId found for event ${item.event_id}`);
                              return;
                            }

                            setSelectedSelfieEventId(item.event_id);
                            setLoadingSelfie(true);
                            setSelfieImageUrl(null);

                            try {
                              const url = `${API_ENDPOINTS.GET_S3_URL}?path=from&event_id=${responseEventId}&filename=image.jpg&method=GET&explorer_id=${currentExplorerId}`;
                              const imageResponse = await fetch(url);
                              if (imageResponse.ok) {
                                const data = await imageResponse.json().catch(() => null);
                                const selfieUrl = isRecord(data) ? asOptionalString(data?.url) : null;
                                if (selfieUrl) {
                                  setSelfieImageUrl(selfieUrl);
                                } else {
                                  console.error('No URL in response:', data);
                                }
                              } else {
                                const errorText = await imageResponse.text();
                                console.error(`Failed to get selfie image URL: ${imageResponse.status}`, errorText);
                              }
                            } catch (error) {
                              console.error('Error fetching selfie image URL:', error);
                            } finally {
                              setLoadingSelfie(false);
                            }
                          }}
                          activeOpacity={0.7}
                        >
                          <FontAwesome name="camera" size={12} color="#4ade80" />
                          <Text style={styles.responseText}>Selfie</Text>
                        </TouchableOpacity>
                      )}
                    </View>

                    {/* ROW 3 — Likes + engagement metrics */}
                    <View style={styles.engagementMetaRow}>
                      <Pressable
                        onPress={() => handleToggleLike(item)}
                        onLongPress={() => likeCount > 0 && setLikesModalReflection(item)}
                        delayLongPress={250}
                        style={({ pressed }) => [
                          styles.likeControl,
                          likedByMe && styles.likeControlActive,
                          pressed && styles.likeControlPressed,
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel={likedByMe ? 'Unlike this Reflection' : 'Like this Reflection'}
                        accessibilityHint="Long press to see who liked this Reflection"
                      >
                        <FontAwesome
                          name={likeCount > 0 ? 'heart' : 'heart-o'}
                          size={16}
                          color={likedByMe ? '#4FC3F7' : likedByOthers ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.7)'}
                        />
                        {likeCount > 0 ? (
                          <Text style={[styles.likeCountText, likedByMe && styles.likeCountTextActive]}>{likeCount}</Text>
                        ) : null}
                      </Pressable>
                      {engagementCount > 0 ? (
                        <Text style={styles.engagementMetaText}>
                          Engagements: {engagementCount}
                        </Text>
                      ) : null}
                    </View>

                    {/* ROW 4 — Sent by / date */}
                    <Text style={styles.sentDate}>
                      {reflectionSenderLabel(item) ? (
                        <>
                          Sent by{' '}
                          <Text style={styles.senderName}>{reflectionSenderLabel(item)}</Text> •{' '}
                          {formatEngagementDate(sentDisplayTimestamp)}
                          {item.metadata?.last_edited_at ? (
                            <Text style={styles.sentDateEdited}> • (Edited)</Text>
                          ) : null}
                        </>
                      ) : (
                        <>
                          Sent •{' '}
                          {formatEngagementDate(sentDisplayTimestamp)}
                          {item.metadata?.last_edited_at ? (
                            <Text style={styles.sentDateEdited}> • (Edited)</Text>
                          ) : null}
                        </>
                      )}
                    </Text>

                    <Pressable
                      onPress={async () => {
                        try {
                          await Clipboard.setStringAsync(item.event_id);
                          showToast('Copied reflection ID');
                        } catch {
                          showToast('Could not copy');
                        }
                      }}
                      style={({ pressed }) => [styles.eventIdPressable, pressed && styles.eventIdPressablePressed]}
                      accessibilityRole="button"
                      accessibilityLabel={`Reflection ID ${item.event_id}`}
                      accessibilityHint="Copies the reflection ID to the clipboard"
                    >
                      <Text style={styles.eventIdLabel}>Reflection ID: </Text>
                      <Text style={styles.eventIdText}>{item.event_id}</Text>
                    </Pressable>
                  </View>
                </View>
              </TouchableOpacity>
            );
          }}
          contentContainerStyle={styles.listContainer}
        />
        </View>
      )}

      </View>

      <ReplayModal
        visible={!!selectedReflection}
        event={selectedReflection}
        likedBy={selectedReflectionLikedBy}
        currentUserId={authUser?.uid ?? null}
        onToggleLike={handleReplayToggleLike}
        onClose={() => setSelectedReflection(null)}
      />

      <Modal
        visible={!!likesModalReflection}
        transparent
        animationType="fade"
        onRequestClose={() => setLikesModalReflection(null)}
      >
        <View style={styles.likesModalOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setLikesModalReflection(null)} />
          <View style={styles.likesModalSheet}>
            <Text style={styles.likesModalTitle}>Liked by</Text>
            {(likesModalReflection?.likedBy ?? []).map((uid) => {
              const companion = companionById.get(uid);
              const fallbackName =
                uid === authUser?.uid
                  ? currentIdentity || 'You'
                  : explorerName || 'Explorer';
              const displayName = companion?.companionName || fallbackName;
              const initial = displayName.trim().charAt(0).toUpperCase() || '?';
              return (
                <View key={uid} style={styles.likePersonRow}>
                  {companion?.avatarUrl ? (
                    <Image
                      source={{ uri: companion.avatarUrl }}
                      style={styles.likePersonAvatar}
                      contentFit="cover"
                      recyclingKey={`like-${uid}`}
                    />
                  ) : (
                    <View style={[styles.likePersonAvatarFallback, { backgroundColor: companion?.color || '#4FC3F7' }]}>
                      <Text style={styles.likePersonAvatarInitial}>{companion?.initial || initial}</Text>
                    </View>
                  )}
                  <Text style={styles.likePersonName} numberOfLines={1}>{displayName}</Text>
                  {companion?.isCaregiver ? (
                    <FontAwesome name="shield" size={13} color="rgba(255,255,255,0.58)" />
                  ) : null}
                </View>
              );
            })}
          </View>
        </View>
      </Modal>

      <Modal
        visible={!!reflectionActionMenu}
        transparent
        animationType="fade"
        onRequestClose={() => setReflectionActionMenu(null)}
      >
        <View style={styles.actionMenuOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setReflectionActionMenu(null)} />
          <View style={styles.actionMenuSheet}>
            {reflectionActionMenu &&
              (() => {
                const row = reflectionActionMenu;
                const menuCanEdit =
                  !!onEditReflection &&
                  timelineRowIsOwnedByCurrentCompanion(row, authUser?.uid, currentIdentity);
                const menuCanDelete =
                  !!currentIdentity &&
                  reflectionSenderLabel(row)?.toLowerCase() === currentIdentity.toLowerCase();
                return (
                  <>
                    {menuCanEdit && (
                      <TouchableOpacity
                        style={[styles.actionMenuRow, !menuCanDelete && styles.actionMenuRowLast]}
                        activeOpacity={0.75}
                        onPress={async () => {
                          setReflectionActionMenu(null);
                          const event = await resolveEventForEdit(row);
                          if (event) onEditReflection?.(event);
                        }}
                      >
                        <View style={styles.editReflectionButton}>
                          <FontAwesome name="pencil" size={16} color="#4FC3F7" />
                        </View>
                        <Text style={styles.actionMenuLabel}>Edit reflection</Text>
                      </TouchableOpacity>
                    )}
                    {menuCanDelete && (
                      <TouchableOpacity
                        style={[styles.actionMenuRow, styles.actionMenuRowLast]}
                        activeOpacity={0.75}
                        onPress={() => {
                          setReflectionActionMenu(null);
                          Alert.alert(
                            'Delete Reflection',
                            'Are you sure you want to permanently delete this reflection?',
                            [
                              { text: 'Cancel', style: 'cancel' },
                              {
                                text: 'Delete',
                                style: 'destructive',
                                onPress: () => deleteReflection(row),
                              },
                            ]
                          );
                        }}
                      >
                        <View style={styles.deleteReflectionButton}>
                          <FontAwesome name="trash-o" size={16} color="#ef5350" />
                        </View>
                        <Text style={styles.actionMenuLabel}>Delete reflection</Text>
                      </TouchableOpacity>
                    )}
                  </>
                );
              })()}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  gradient: {
    flex: 1,
    backgroundColor: '#000',
  },
  centerContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  listArea: {
    flex: 1,
  },
  listContainer: {
    padding: 8,
  },
  // Explorer up-next style: soft cards on gradient (dark but inviting)
  reflectionItem: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    padding: 12,
    marginVertical: 4,
    marginHorizontal: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.25)',
  },
  reflectionRow: {
    flexDirection: 'row',
    gap: 12,
  },
  reflectionImageContainer: {
    width: 80,
    height: 80,
    borderRadius: 8,
    overflow: 'hidden',
    position: 'relative',
  },
  reflectionImage: {
    width: 80,
    height: 80,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  deletedImagePlaceholder: {
    backgroundColor: '#f5f5f5',
    borderWidth: 2,
    borderColor: '#ef5350',
    borderStyle: 'dashed',
    justifyContent: 'center',
    alignItems: 'center',
  },
  deletedOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(239, 83, 80, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  reflectionInfo: {
    flex: 1,
    minWidth: 0,
  },
  infoTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 2,
  },
  captionRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
  },
  captionRowSpacer: {
    flex: 1,
  },
  overflowMenuButton: {
    paddingVertical: 4,
    paddingHorizontal: 6,
    marginTop: -2,
    flexShrink: 0,
    zIndex: 1,
    elevation: 2,
  },
  description: {
    fontSize: 14,
    color: '#fff',
    flex: 1,
    minWidth: 0,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 1,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 13,
    color: '#ccc',
    fontWeight: '600',
  },
  engagementDate: {
    fontSize: 12,
    color: '#aaa',
    fontStyle: 'italic',
  },
  responseBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(74, 222, 128, 0.25)',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 10,
    marginLeft: 4,
  },
  responseText: {
    fontSize: 11,
    color: '#4ade80',
    fontWeight: '600',
  },
  sentDate: {
    fontSize: 12,
    color: '#aaa',
    marginTop: 2,
  },
  eventIdPressable: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    paddingVertical: 1,
    paddingRight: 4,
    borderRadius: 4,
  },
  eventIdPressablePressed: {
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  eventIdLabel: {
    fontSize: 11,
    lineHeight: 14,
    color: 'rgba(160, 170, 180, 0.7)',
  },
  eventIdText: {
    fontSize: 11,
    lineHeight: 14,
    color: 'rgba(200, 210, 220, 0.85)',
    fontVariant: ['tabular-nums'],
  },
  sentDateEdited: {
    fontSize: 12,
    color: '#aaa',
  },
  senderName: {
    fontSize: 12,
    color: '#fff',
    fontWeight: '600',
  },
  actionMenuOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  actionMenuSheet: {
    minWidth: 260,
    maxWidth: '88%',
    borderRadius: 14,
    backgroundColor: 'rgba(34, 34, 34, 0.98)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
    zIndex: 1,
  },
  actionMenuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.12)',
  },
  actionMenuRowLast: {
    borderBottomWidth: 0,
  },
  actionMenuLabel: {
    fontSize: 16,
    color: '#fff',
    fontWeight: '600',
  },
  editReflectionButton: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(79, 195, 247, 0.55)',
    backgroundColor: 'rgba(79, 195, 247, 0.12)',
  },
  deleteReflectionButton: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(239, 83, 80, 0.55)',
    backgroundColor: 'rgba(239, 83, 80, 0.12)',
  },

  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: '#ccc',
  },
  emptyText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#fff',
    marginTop: 16,
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 14,
    color: '#aaa',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.9)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    width: '90%',
    height: '80%',
    backgroundColor: '#000',
    borderRadius: 12,
    padding: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCloseButton: {
    position: 'absolute',
    top: 20,
    right: 20,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1,
  },
  modalCloseText: {
    color: '#fff',
    fontSize: 24,
    fontWeight: 'bold',
  },
  selfieImage: {
    width: '100%',
    height: '100%',
  },
  modalErrorText: {
    color: '#fff',
    fontSize: 16,
  },
  saveSelfieButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#4ade80',
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 25,
    marginTop: 20,
  },
  saveSelfieButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  toast: {
    position: 'absolute',
    bottom: 50,
    alignSelf: 'center',
    backgroundColor: 'rgba(50, 50, 50, 0.9)',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 25,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  toastText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  selfieTimestamp: {
    color: '#888',
    fontSize: 14,
    marginBottom: 10,
    fontStyle: 'italic',
  },
  timestampRow: {
    marginTop: 4,
  },
  engagementCount: {
    fontSize: 12,
    color: '#fbbf24',
    marginTop: 4,
  },
  engagementMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 4,
  },
  engagementMetaText: {
    fontSize: 12,
    color: '#fbbf24',
  },
  likeControl: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  likeControlActive: {
    backgroundColor: 'rgba(79, 195, 247, 0.16)',
    borderColor: 'rgba(79, 195, 247, 0.45)',
  },
  likeControlPressed: {
    opacity: 0.75,
  },
  likeCountText: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 12,
    fontWeight: '700',
  },
  likeCountTextActive: {
    color: '#4FC3F7',
  },
  likesModalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  likesModalSheet: {
    margin: 14,
    padding: 18,
    borderRadius: 18,
    backgroundColor: 'rgba(26, 26, 26, 0.98)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    gap: 12,
  },
  likesModalTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  likePersonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  likePersonAvatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  likePersonAvatarFallback: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  likePersonAvatarInitial: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
  },
  likePersonName: {
    flex: 1,
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  tabContainer: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  tabActive: {
    backgroundColor: 'rgba(79, 195, 247, 0.2)',
    borderColor: 'rgba(79, 195, 247, 0.5)',
  },
  tabText: {
    fontSize: 16,
    color: '#ccc',
    fontWeight: '500',
  },
  tabTextActive: {
    color: '#fff',
    fontWeight: '600',
  },
  tabTextDisabled: {
    color: 'rgba(255,255,255,0.4)',
    opacity: 0.5,
  },
  headerContainer: {},
  filterSortRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sortContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  countBadge: {
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 12,
    minWidth: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countBadgeText: {
    color: '#ccc',
    fontSize: 12,
    fontWeight: '700',
  },
  sortButtonGroup: {
    flexDirection: 'row',
    gap: 8,
  },
  sortButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  sortButtonActive: {
    backgroundColor: 'rgba(0,122,255,0.3)',
    borderWidth: 1,
    borderColor: 'rgba(79, 195, 247, 0.5)',
  },
  sortText: {
    fontSize: 12,
    color: '#aaa',
    fontWeight: '600',
  },
  sortTextActive: {
    color: '#4FC3F7',
  },
  rankBadge: {
    position: 'absolute',
    top: -6,
    left: -6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    zIndex: 10,
    borderWidth: 1,
    borderColor: '#fff',
  },
  rankText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: 'bold',
  },
});