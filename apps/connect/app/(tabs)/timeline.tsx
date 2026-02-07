import { FontAwesome } from '@expo/vector-icons';
import { API_ENDPOINTS, ExplorerConfig, useAuth, useExplorer } from '@projectmirror/shared';
import { collection, db, doc, getDoc, limit, onSnapshot, orderBy, query, where } from '@projectmirror/shared/firebase';
import * as FileSystem from 'expo-file-system';
import { Image } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import { useFocusEffect } from 'expo-router';
import type { QuerySnapshot } from 'firebase/firestore';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, AppState, FlatList, Modal, SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { ReplayModal } from '@/components/ReplayModal';
import { Event, EventMetadata } from '@projectmirror/shared';

interface SentReflection {
  event_id: string;
  timestamp: any; // Current status timestamp (may be engagement/replay time)
  sentTimestamp?: any; // Original "sent" timestamp (preserved from 'ready' status)
  status?: 'ready' | 'engaged' | 'replayed' | 'deleted';
  engagementTimestamp?: any;
  engagementCount?: number;
  deletedAt?: any;
  hasResponse?: boolean;
  responseImageUrl?: string;
  reflectionImageUrl?: string;
  description?: string;
  sender?: string;
}

export default function SentTimelineScreen() {
  const [reflections, setReflections] = useState<SentReflection[]>([]);
  const [loading, setLoading] = useState(true);
  const [responseEventIds, setResponseEventIds] = useState<Set<string>>(new Set());
  const [responseEventIdMap, setResponseEventIdMap] = useState<Map<string, string>>(new Map()); // event_id -> response_event_id
  const [selectedSelfieEventId, setSelectedSelfieEventId] = useState<string | null>(null);
  const [responseTimestampMap, setResponseTimestampMap] = useState<Map<string, any>>(new Map()); // event_id -> timestamp
  const [selfieImageUrl, setSelfieImageUrl] = useState<string | null>(null);
  const [loadingSelfie, setLoadingSelfie] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0); // Increment to force refresh
  const [currentIdentity, setCurrentIdentity] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<'mine' | 'all'>('mine');
  const [sortBy, setSortBy] = useState<'recent' | 'impact'>('recent');
  const metadataCache = useRef<Map<string, any>>(new Map());
  const METADATA_CACHE_MAX = 50;
  const [selectedReflection, setSelectedReflection] = useState<Event | null>(null);
  const [eventObjectsMap, setEventObjectsMap] = useState<Map<string, Event>>(new Map()); // event_id -> full Event object

  const setMetadataCache = (key: string, value: any) => {
    const cache = metadataCache.current;
    if (cache.has(key)) {
      cache.delete(key); // refresh LRU position
    }
    cache.set(key, value);
    if (cache.size > METADATA_CACHE_MAX) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey) {
        cache.delete(oldestKey);
      }
    }
  };

  // Get the user from the Auth Hook
  const { user } = useAuth();
  const { currentExplorerId, loading: explorerLoading } = useExplorer();

  // Load current identity from Firestore
  useFocusEffect(
    useCallback(() => {
      const loadIdentity = async () => {
        if (!user?.uid) return;

        try {
          const userDoc = await getDoc(doc(db, 'users', user.uid));
          const userData = userDoc.data();
          setCurrentIdentity(userData?.companionName || null);
        } catch (error) {
          console.error('Error loading companion identity:', error);
          setCurrentIdentity(null);
        }
      };
      loadIdentity();
    }, [user?.uid]) // Re-run if user changes
  );

  // Derive display reflections with fresh hasResponse values
  // This ensures the list updates when responseEventIds changes
  // SORTED BY: Response timestamp (viewed) first, so most recently viewed are at top
  const displayReflections = useMemo(() => {
    let result = reflections.map(r => ({
      ...r,
      hasResponse: !r.deletedAt && r.status !== 'deleted' && responseEventIds.has(r.event_id),
    }));

    // Do not include soft-deleted items in the timeline list
    result = result.filter(r => !r.deletedAt && r.status !== 'deleted');

    // Filter by sender if filterMode is 'mine'
    if (filterMode === 'mine' && currentIdentity) {
      result = result.filter(r => r.sender === currentIdentity);
    }

    // Helper to get timestamp value in milliseconds
    const getTimestampMs = (ts: any): number => {
      if (!ts) return 0;
      if (ts.toMillis) return ts.toMillis();
      if (ts.seconds !== undefined) return ts.seconds * 1000 + (ts.nanoseconds || 0) / 1000000;
      if (typeof ts === 'number') return ts;
      return 0;
    };

    // Sort by RESPONSE timestamp (viewed time) - most recent first
    // If no response, use sent timestamp (original sent time, not engagement time)
    result.sort((a, b) => {
      if (sortBy === 'impact') {
        // Calculate score: Engagement count + 1 bonus point if there is a selfie response
        const scoreA = (a.engagementCount || 0) + (responseEventIds.has(a.event_id) ? 1 : 0);
        const scoreB = (b.engagementCount || 0) + (responseEventIds.has(b.event_id) ? 1 : 0);

        const diff = scoreB - scoreA;
        if (diff !== 0) return diff;
      }
      const aResponseTs = responseTimestampMap.get(a.event_id);
      const bResponseTs = responseTimestampMap.get(b.event_id);
      const aTime = aResponseTs ? getTimestampMs(aResponseTs) : getTimestampMs(a.sentTimestamp || a.timestamp);
      const bTime = bResponseTs ? getTimestampMs(bResponseTs) : getTimestampMs(b.sentTimestamp || b.timestamp);
      return bTime - aTime; // Most recent first
    });

    return result;
  }, [reflections, responseEventIds, responseTimestampMap, filterMode, currentIdentity, sortBy]);

  const reflectionCounts = useMemo(() => {
    const all = reflections.length; // already excludes soft-deleted items (filtered at source)
    const mine =
      currentIdentity ? reflections.filter(r => r.sender === currentIdentity).length : 0;
    return { all, mine };
  }, [reflections, currentIdentity]);

  // Toast state
  const [toastMessage, setToastMessage] = useState('');
  const toastOpacity = useRef(new Animated.Value(0)).current;

  // Show toast notification
  const showToast = (message: string) => {
    setToastMessage(message);
    Animated.sequence([
      Animated.timing(toastOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
      Animated.delay(2000),
      Animated.timing(toastOpacity, { toValue: 0, duration: 300, useNativeDriver: true })
    ]).start(() => setToastMessage(''));
  };

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
      snapshot.docs.forEach((doc) => {
        const data = doc.data();
        // Document ID is the original event_id, data.response_event_id is the selfie's event_id
        const originalEventId = doc.id; // This is the original reflection's event_id
        const responseEventId = data.response_event_id;

        if (originalEventId) {
          eventIds.add(originalEventId);
          if (responseEventId) {
            eventIdMap.set(originalEventId, responseEventId);
          }
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
      return;
    }
    
    setLoading(true);

    // Listen to reflections collection for sent Reflections
    const reflectionsRef = collection(db, ExplorerConfig.collections.reflections);
    const q = query(
      reflectionsRef,
      where('explorerId', '==', currentExplorerId),
      orderBy('timestamp', 'desc'),
      limit(100)
    );

    const unsubscribe = onSnapshot(
      q,
      async (snapshot: QuerySnapshot) => {
        // Group signals by event_id, keeping the one with highest status priority
        const reflectionMap = new Map<string, SentReflection>();

        // Status priority: replayed > engaged > ready > deleted
        const statusPriority: { [key: string]: number } = {
          'replayed': 4,
          'engaged': 3,
          'ready': 2,
          'deleted': 1,
        };

        for (const docSnapshot of snapshot.docs) {
          const data = docSnapshot.data();
          const docId = docSnapshot.id; // Document ID should be the event_id
          const eventIdFromData = data.event_id;

          // Use document ID as the primary key (it should be the event_id)
          // Fall back to event_id field if document ID is somehow different
          const actualEventId = docId || eventIdFromData;

          // Warn if document ID doesn't match event_id field
          if (eventIdFromData && docId !== eventIdFromData) {
            console.warn(`Document ID (${docId}) doesn't match event_id field (${eventIdFromData})`);
          }

          const currentStatus = data.status || 'ready';
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
              deletedAt: currentStatus === 'deleted' ? data.deleted_at : undefined,
              sender: data.sender,
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
              if (data.sender) {
                existing.sender = data.sender;
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
              if (data.sender) {
                existing.sender = data.sender;
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
        }

        // Fetch Mirror Events List ONCE for all reflections
        let allMirrorEventsMap = new Map<string, any>();
        try {
          const eventsResponse = await fetch(`${API_ENDPOINTS.LIST_MIRROR_EVENTS}?explorer_id=${currentExplorerId}`);
          if (eventsResponse.ok) {
            const eventsData = await eventsResponse.json();
            (eventsData.events || []).forEach((e: any) => {
              allMirrorEventsMap.set(e.event_id, e);
            });
          }
        } catch (error) {
          console.error('Error fetching reflection events list:', error);
        }

        // Convert map to array and fetch additional data
        const reflectionPromises = Array.from(reflectionMap.values())
          // Do not include soft-deleted items in the timeline list
          .filter((reflection) => !reflection.deletedAt && reflection.status !== 'deleted')
          .map(async (reflection) => {
            // Fetch Reflection image URL from backend (including deleted ones so we can show thumbnail)
            const matchingEvent = allMirrorEventsMap.get(reflection.event_id);
            if (matchingEvent?.image_url) {
              reflection.reflectionImageUrl = matchingEvent.image_url;

              // Also fetch metadata for description and timestamp (only for non-deleted)
              if (reflection.status !== 'deleted' && matchingEvent.metadata_url) {
                // Check cache first
                if (metadataCache.current.has(matchingEvent.metadata_url)) {
                  const cachedMetadata = metadataCache.current.get(matchingEvent.metadata_url);
                  if (cachedMetadata) {
                    setMetadataCache(matchingEvent.metadata_url, cachedMetadata);
                    reflection.description = cachedMetadata.description;
                    // Use metadata timestamp as sentTimestamp if we don't have one
                    if (!reflection.sentTimestamp && cachedMetadata.timestamp) {
                      try {
                        reflection.sentTimestamp = new Date(cachedMetadata.timestamp);
                      } catch (e) {
                        // Invalid timestamp in metadata, ignore
                      }
                    }
                  }
                } else {
                  try {
                    const metaResponse = await fetch(matchingEvent.metadata_url);
                    if (metaResponse.ok) {
                      const metadata = await metaResponse.json();
                      setMetadataCache(matchingEvent.metadata_url, metadata);
                      reflection.description = metadata.description;
                      // Use metadata timestamp as sentTimestamp if we don't have one
                      if (!reflection.sentTimestamp && metadata.timestamp) {
                        try {
                          reflection.sentTimestamp = new Date(metadata.timestamp);
                        } catch (e) {
                          // Invalid timestamp in metadata, ignore
                        }
                      }
                    }
                  } catch (err) {
                    console.error('Error fetching metadata:', err);
                  }
                }
              }
            }

            // Check for selfie response - use responseEventIds state (updated by listener)
            // Don't show selfie if reflection is deleted
            reflection.hasResponse = !reflection.deletedAt && reflection.status !== 'deleted' && responseEventIds.has(reflection.event_id);

            return reflection;
          });

        const reflectionsList = await Promise.all(reflectionPromises);

        // Store Event objects in state for replay functionality
        const eventsMap = new Map<string, Event>();
        allMirrorEventsMap.forEach((event, eventId) => {
          eventsMap.set(eventId, event as Event);
        });
        setEventObjectsMap(eventsMap);

        // Sort by timestamp descending (most recent first)
        // Sort by engagementTimestamp (viewed time) if available, otherwise use sentTimestamp (original sent time)
        reflectionsList.sort((a, b) => {
          // Helper to get timestamp value
          const getTime = (reflection: SentReflection): number => {
            const ts = reflection.engagementTimestamp || reflection.sentTimestamp || reflection.timestamp;
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
      },
      (error) => {
        console.error('Error listening to reflections:', error);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [currentExplorerId, responseEventIds]); // ADDED DEPENDENCY: currentExplorerId

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

  const getStatusText = (status?: string, hasEngagementTimestamp?: boolean, hasSelfie?: boolean) => {
    if (status === 'deleted') return 'Deleted';
    if (status === 'replayed') return 'Replayed';
    if (hasSelfie) return 'Engaged';
    if (hasEngagementTimestamp) return 'Viewed';
    return 'Sent';
  };

  const getStatusColor = (status?: string, hasEngagementTimestamp?: boolean, hasSelfie?: boolean) => {
    if (status === 'deleted') return '#e74c3c';
    if (status === 'replayed') return '#2ecc71';
    if (hasSelfie) return '#4a9eff';
    if (hasEngagementTimestamp) return '#999';
    return '#f39c12'; // Sent
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
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#2e78b7" />
        <Text style={styles.loadingText}>Loading timeline...</Text>
      </View>
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
              <ActivityIndicator size="large" color="#2ecc71" />
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

      {/* Filter Tabs and Sort Toggle */}
      {/* Header Section */}
      <View style={styles.headerContainer}>
        {/* Existing Tabs */}
        <View style={styles.tabContainer}>
          <TouchableOpacity
            style={[styles.tab, filterMode === 'mine' && styles.tabActive]}
            onPress={() => setFilterMode('mine')}
            disabled={!currentIdentity}
          >
            <Text style={[styles.tabText, filterMode === 'mine' && styles.tabTextActive, !currentIdentity && styles.tabTextDisabled]}>
              My Reflections ({reflectionCounts.mine})
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tab, filterMode === 'all' && styles.tabActive]}
            onPress={() => setFilterMode('all')}
          >
            <Text style={[styles.tabText, filterMode === 'all' && styles.tabTextActive]}>
              All ({reflectionCounts.all})
            </Text>
          </TouchableOpacity>
        </View>

        {/* Sort Toggle */}
        <View style={styles.sortContainer}>
          <Text style={styles.sortLabel}>Sort Order</Text>
          <View style={styles.sortButtonGroup}>
            <TouchableOpacity
              style={[styles.sortButton, sortBy === 'recent' && styles.sortButtonActive]}
              onPress={() => setSortBy('recent')}
            >
              <FontAwesome name="clock-o" size={12} color={sortBy === 'recent' ? '#fff' : '#666'} style={{ marginRight: 4 }} />
              <Text style={[styles.sortText, sortBy === 'recent' && styles.sortTextActive]}>Recent</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.sortButton, sortBy === 'impact' && styles.sortButtonActive]}
              onPress={() => setSortBy('impact')}
            >
              <FontAwesome name="fire" size={12} color={sortBy === 'impact' ? '#fff' : '#666'} style={{ marginRight: 4 }} />
              <Text style={[styles.sortText, sortBy === 'impact' && styles.sortTextActive]}>Impact</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* Empty State */}
      {!hasReflections && hasAnyReflections && filterMode === 'mine' && (
        <View style={styles.centerContainer}>
          <FontAwesome name="inbox" size={64} color="#999" />
          <Text style={styles.emptyText}>No Reflections from you yet</Text>
          <Text style={styles.emptySubtext}>
            {currentIdentity ? `Send a Reflection as ${currentIdentity} to see it here` : 'Set your name in Settings to filter your Reflections'}
          </Text>
        </View>
      )}

      {!hasAnyReflections && (
        <View style={styles.centerContainer}>
          <FontAwesome name="inbox" size={64} color="#999" />
          <Text style={styles.emptyText}>No Reflections sent yet</Text>
          <Text style={styles.emptySubtext}>Send a Reflection to see it here</Text>
        </View>
      )}

      {hasReflections && (
        <FlatList
          data={displayReflections}
          keyExtractor={(item) => item.event_id}
          renderItem={({ item, index }) => {
            const hasSelfie = !!item.hasResponse;
            const rawEngagementCount = item.engagementCount ?? 0;
            const engagementCount = rawEngagementCount > 0 ? rawEngagementCount : (hasSelfie ? 1 : 0);
            const engagementTimestamp = hasSelfie
              ? responseTimestampMap.get(item.event_id)
              : item.engagementTimestamp;

            // Impact score (used for Impact sorting): engagement count + selfie bonus
            const impactScore = rawEngagementCount + (hasSelfie ? 1 : 0);

            const isTopRanked = sortBy === 'impact' && index < 3 && engagementCount > 0;
            const rankColor = isTopRanked ? '#f1c40f' : '#bdc3c7';

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
                        const eventsData = await eventsResponse.json();
                        const matchingEvent = (eventsData.events || []).find((e: Event) => e.event_id === item.event_id);
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

                  // Fetch metadata if not already cached or in Event object
                  let metadata = fullEvent?.metadata as EventMetadata | undefined;
                  if (!metadata && fullEvent?.metadata_url) {
                    if (metadataCache.current.has(fullEvent.metadata_url)) {
                      metadata = metadataCache.current.get(fullEvent.metadata_url);
                    } else {
                      try {
                        const metaResponse = await fetch(fullEvent.metadata_url);
                        if (metaResponse.ok) {
                          metadata = await metaResponse.json();
                          setMetadataCache(fullEvent.metadata_url, metadata);
                        }
                      } catch (err) {
                        console.error('Error fetching metadata for replay:', err);
                      }
                    }
                  }

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
                    image_url: fullEvent?.image_url || item.reflectionImageUrl || '',
                    metadata_url: fullEvent?.metadata_url, // Optional - preserve undefined if not present
                    audio_url: fullEvent?.audio_url,
                    video_url: fullEvent?.video_url,
                    deep_dive_audio_url: fullEvent?.deep_dive_audio_url,
                    metadata: metadata || {
                      description: item.description || 'Reflection',
                      sender: item.sender || 'Companion',
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
                      <FontAwesome name="trash" size={32} color="#e74c3c" />
                    </View>
                  ) : null}
                  <View style={styles.reflectionInfo}>
                    <View style={styles.reflectionContent}>
                      <View style={styles.statusBadge}>
                        <View style={[styles.statusDot, { backgroundColor: getStatusColor(item.status, !!engagementTimestamp, hasSelfie) }]} />
                        <Text style={styles.statusText}>
                          {getStatusText(item.status, !!engagementTimestamp, hasSelfie)}
                        </Text>
                        {item.status === 'deleted' && item.deletedAt ? (
                          <Text style={styles.engagementDate}>
                            {formatEngagementDate(item.deletedAt)}
                          </Text>
                        ) : engagementTimestamp && item.status !== 'ready' ? (
                          <Text style={styles.engagementDate}>
                            {formatEngagementDate(engagementTimestamp)}
                          </Text>
                        ) : null}
                      </View>
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
                              // Get presigned GET URL for the selfie image (method=GET for viewing)
                              const url = `${API_ENDPOINTS.GET_S3_URL}?path=from&event_id=${responseEventId}&filename=image.jpg&method=GET&explorer_id=${currentExplorerId}`;
                              const imageResponse = await fetch(url);
                              if (imageResponse.ok) {
                                const data = await imageResponse.json();
                                const imageUrl = data.url;
                                if (imageUrl) {
                                  setSelfieImageUrl(imageUrl);
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
                          <FontAwesome name="camera" size={16} color="#2ecc71" />
                          <Text style={styles.responseText}>Selfie</Text>
                        </TouchableOpacity>
                      )}
                    </View>

                    {item.description && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        {item.description === 'Voice message' && (
                          <FontAwesome name="microphone" size={14} color="#e0e0e0" />
                        )}
                        <Text style={styles.description} numberOfLines={2}>
                          {item.description}
                        </Text>
                      </View>
                    )}
                    {/* Viewed date on its own line */}
                    {hasSelfie && engagementTimestamp && (
                      <Text style={styles.viewedDate}>
                        Viewed: {formatEngagementDate(engagementTimestamp)}
                      </Text>
                    )}
                    {(engagementCount > 0 || impactScore > 0) && (
                      <View style={styles.engagementMetaRow}>
                        {engagementCount > 0 && (
                          <Text style={styles.engagementMetaText}>
                            Engagements: {engagementCount}
                          </Text>
                        )}
                        {impactScore > 0 && (
                          <Text style={styles.engagementMetaText}>
                            Score: {impactScore}
                          </Text>
                        )}
                      </View>
                    )}
                    {/* Sent date */}
                    <View style={styles.timestampRow}>
                      <Text style={styles.sentDate}>
                        {item.sender ? (
                          <>
                            Sent by <Text style={styles.senderName}>{item.sender}</Text> • {formatEngagementDate(
                              item.sentTimestamp ||
                              (item.status === 'ready' ? item.timestamp : null) // Only use timestamp if status is 'ready' (original sent)
                            )}
                          </>
                        ) : (
                          <>Sent • {formatEngagementDate(
                            item.sentTimestamp ||
                            (item.status === 'ready' ? item.timestamp : null) // Only use timestamp if status is 'ready' (original sent)
                          )}</>
                        )}
                      </Text>
                    </View>
                    <Text style={styles.eventId}>Reflection ID: {item.event_id}</Text>
                  </View>
                </View>
              </TouchableOpacity>
            );
          }}
          contentContainerStyle={styles.listContainer}
        />
      )}

      <ReplayModal
        visible={!!selectedReflection}
        event={selectedReflection}
        onClose={() => setSelectedReflection(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a1a', // Dark background
  },
  centerContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  listContainer: {
    padding: 8,
  },
  reflectionItem: {
    backgroundColor: '#2a2a2a', // Dark card background
    padding: 12,
    marginVertical: 4,
    marginHorizontal: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)', // Subtle light border
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 4,
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
    backgroundColor: '#3a3a3a', // Darker placeholder
  },
  deletedImagePlaceholder: {
    backgroundColor: '#f5f5f5',
    borderWidth: 2,
    borderColor: '#e74c3c',
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
    backgroundColor: 'rgba(231, 76, 60, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  reflectionInfo: {
    flex: 1,
  },
  reflectionContent: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    gap: 12,
  },
  description: {
    fontSize: 14,
    color: '#e0e0e0', // Light text on dark background
    marginBottom: 4,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 14,
    color: '#b0b0b0', // Lighter gray for dark theme
    fontWeight: '600',
  },
  engagementDate: {
    fontSize: 12,
    color: '#888', // Lighter for visibility
    marginLeft: 8,
    fontStyle: 'italic',
  },
  responseBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(46, 204, 113, 0.2)', // Darker green background
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  responseText: {
    fontSize: 12,
    color: '#4ade80', // Brighter green for dark theme
    fontWeight: '600',
  },
  sentDate: {
    fontSize: 12,
    color: '#9ca3af',
    marginTop: 4,
  },
  senderName: {
    fontSize: 12,
    color: '#fff',
    fontWeight: '600',
  },
  eventId: {
    fontSize: 12,
    color: '#888', // Lighter for visibility
    fontFamily: 'monospace',
  },

  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: '#b0b0b0', // Lighter for dark theme
  },
  emptyText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#d0d0d0', // Lighter for dark theme
    marginTop: 16,
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 14,
    color: '#888', // Lighter for visibility
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
    backgroundColor: '#2ecc71',
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
  viewedDate: {
    fontSize: 12,
    color: '#60a5fa', // Blue to differentiate from green Selfie button
    marginTop: 4,
  },
  engagementCount: {
    fontSize: 12,
    color: '#f59e0b', // Amber for engagement count
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
    color: '#f59e0b', // Amber, matches old engagementCount style
  },
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: '#1a1a1a',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.1)',
    paddingHorizontal: 8,
  },
  tab: {
    flex: 1,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    borderBottomColor: '#2e78b7',
  },
  tabText: {
    fontSize: 16,
    color: '#666',
    fontWeight: '500',
  },
  tabTextActive: {
    color: '#fff',
    fontWeight: '600',
  },
  tabTextDisabled: {
    color: '#444',
    opacity: 0.5,
  },
  headerContainer: {
    backgroundColor: '#1a1a1a',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.1)',
  },
  sortContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between', // <--- This is the magic alignment fix
    alignItems: 'center',
    paddingHorizontal: 20, // Match your screen margins
    paddingVertical: 14,   // Give it vertical breathing room so it's not "squashed"
    borderBottomWidth: 1,  // Optional: adds a subtle line below sort to separate from list
    borderBottomColor: 'rgba(255, 255, 255, 0.05)',
  },
  sortLabel: {
    color: '#666',
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase', // Makes it look like a proper header
    letterSpacing: 0.5,
  },
  sortButtonGroup: {
    flexDirection: 'row',
    gap: 8, // Tighter gap between the two buttons
  },
  sortButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  sortButtonActive: {
    backgroundColor: 'rgba(46, 120, 183, 0.2)',
    borderWidth: 1,
    borderColor: 'rgba(46, 120, 183, 0.5)',
  },
  sortText: {
    fontSize: 12,
    color: '#666',
    fontWeight: '600',
  },
  sortTextActive: {
    color: '#2e78b7',
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