import { FontAwesome } from '@expo/vector-icons';
import { API_ENDPOINTS, ExplorerIdentity } from '@projectmirror/shared';
import { db } from '@projectmirror/shared/firebase';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import { collection, limit, onSnapshot, orderBy, query, QuerySnapshot, where } from 'firebase/firestore';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, AppState, FlatList, Image, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface SentReflection {
  event_id: string;
  timestamp: any;
  status?: 'ready' | 'engaged' | 'replayed' | 'deleted';
  engagementTimestamp?: any;
  deletedAt?: any;
  hasResponse?: boolean;
  responseImageUrl?: string;
  reflectionImageUrl?: string;
  description?: string;
}

export default function SentHistoryScreen() {
  const [reflections, setReflections] = useState<SentReflection[]>([]);
  const [loading, setLoading] = useState(true);
  const [responseEventIds, setResponseEventIds] = useState<Set<string>>(new Set());
  const [responseEventIdMap, setResponseEventIdMap] = useState<Map<string, string>>(new Map()); // event_id -> response_event_id
  const [selectedSelfieEventId, setSelectedSelfieEventId] = useState<string | null>(null);
  const [responseTimestampMap, setResponseTimestampMap] = useState<Map<string, any>>(new Map()); // event_id -> timestamp
  const [selfieImageUrl, setSelfieImageUrl] = useState<string | null>(null);
  const [loadingSelfie, setLoadingSelfie] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0); // Increment to force refresh
  const metadataCache = useRef<Map<string, any>>(new Map());
  const isRefreshingRef = useRef(false);

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
    const responsesRef = collection(db, ExplorerIdentity.collections.responses);
    const q = query(responsesRef, where('explorerId', '==', ExplorerIdentity.currentExplorerId));
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
  }, []);

  useEffect(() => {
    // Listen to signals collection for sent Reflections
    const signalsRef = collection(db, ExplorerIdentity.collections.reflections);
    const q = query(
      signalsRef,
      where('explorerId', '==', ExplorerIdentity.currentExplorerId),
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
              status: currentStatus,
              engagementTimestamp: (currentStatus === 'engaged' || currentStatus === 'replayed') ? data.timestamp : undefined,
              deletedAt: currentStatus === 'deleted' ? data.deleted_at : undefined,
            });
          } else {
            // We already have this event_id - always update to higher priority status
            const existingTime = getTimestampValue(existing.timestamp);
            const existingEngTime = getTimestampValue(existing.engagementTimestamp);

            // Always update status if this signal has higher priority
            if (currentPriority > existingPriority) {
              existing.status = currentStatus;
              existing.timestamp = data.timestamp;
              // Update engagement timestamp for engaged/replayed
              if (currentStatus === 'engaged' || currentStatus === 'replayed') {
                existing.engagementTimestamp = data.timestamp;
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
            }
          }
        }

        // Debug: log deduplication results

        // Fetch Mirror Events List ONCE for all reflections
        let allMirrorEventsMap = new Map<string, any>();
        try {
          const eventsResponse = await fetch(API_ENDPOINTS.LIST_MIRROR_EVENTS);
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
        const reflectionPromises = Array.from(reflectionMap.values()).map(async (reflection) => {
          // Fetch Reflection image URL from backend (including deleted ones so we can show thumbnail)
          const matchingEvent = allMirrorEventsMap.get(reflection.event_id);
          if (matchingEvent?.image_url) {
            reflection.reflectionImageUrl = matchingEvent.image_url;

            // Also fetch metadata for description (only for non-deleted)
            if (reflection.status !== 'deleted' && matchingEvent.metadata_url) {
              // Check cache first
              if (metadataCache.current.has(matchingEvent.metadata_url)) {
                reflection.description = metadataCache.current.get(matchingEvent.metadata_url).description;
              } else {
                try {
                  const metaResponse = await fetch(matchingEvent.metadata_url);
                  if (metaResponse.ok) {
                    const metadata = await metaResponse.json();
                    metadataCache.current.set(matchingEvent.metadata_url, metadata);
                    reflection.description = metadata.description;
                  }
                } catch (err) {
                  console.error('Error fetching metadata:', err);
                }
              }
            }
          }

          // Check for selfie response - use responseEventIds state (updated by listener)
          // Don't show selfie if reflection is deleted
          reflection.hasResponse = reflection.status !== 'deleted' && responseEventIds.has(reflection.event_id);

          return reflection;
        });

        const reflectionsList = await Promise.all(reflectionPromises);

        // Sort by timestamp descending (most recent first)
        // Use engagementTimestamp if available (for engaged/replayed), otherwise use timestamp
        // Use engagementTimestamp if available (for engaged/replayed), otherwise use timestamp
        reflectionsList.sort((a, b) => {
          // Helper to get timestamp value
          const getTime = (reflection: SentReflection): number => {
            const ts = reflection.engagementTimestamp || reflection.timestamp;
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
        console.error('Error listening to signals:', error);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [responseEventIds]); // Removed refreshTrigger from dependency list to prevent unnecessary resubscriptions

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
    if (refreshTrigger > 0) {
      console.log('🔄 [History] Refreshing data on foreground');
    }
  }, [refreshTrigger]);

  const getStatusText = (status?: string) => {
    switch (status) {
      case 'engaged':
        return 'Engaged';
      case 'replayed':
        return 'Replayed';
      case 'deleted':
        return 'Deleted';
      default:
        return 'Viewed';
    }
  };

  const getStatusColor = (status?: string) => {
    switch (status) {
      case 'engaged':
        return '#4a9eff';
      case 'replayed':
        return '#2ecc71';
      case 'deleted':
        return '#e74c3c';
      default:
        return '#999';
    }
  };

  const formatEngagementDate = (timestamp: any) => {
    if (!timestamp) return '';

    try {
      // Handle Firestore Timestamp
      const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
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
      return '';
    }
  };

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#2e78b7" />
        <Text style={styles.loadingText}>Loading sent history...</Text>
      </View>
    );
  }

  if (reflections.length === 0) {
    return (
      <View style={styles.centerContainer}>
        <FontAwesome name="inbox" size={64} color="#999" />
        <Text style={styles.emptyText}>No Reflections sent yet</Text>
        <Text style={styles.emptySubtext}>Send a Reflection to see it here</Text>
      </View>
    );
  }

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
    <View style={styles.container}>
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
                resizeMode="contain"
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

      <FlatList
        data={reflections}
        keyExtractor={(item) => item.event_id}
        renderItem={({ item }) => (
          <View style={styles.reflectionItem}>
            <View style={styles.reflectionRow}>
              {item.reflectionImageUrl ? (
                <View style={styles.reflectionImageContainer}>
                  <Image
                    source={{ uri: item.reflectionImageUrl }}
                    style={styles.reflectionImage}
                    resizeMode="cover"
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
                    <View style={[styles.statusDot, { backgroundColor: getStatusColor(item.status) }]} />
                    <Text style={styles.statusText}>{getStatusText(item.status)}</Text>
                    {item.status === 'deleted' && item.deletedAt ? (
                      <Text style={styles.engagementDate}>
                        {formatEngagementDate(item.deletedAt)}
                      </Text>
                    ) : item.engagementTimestamp ? (
                      <Text style={styles.engagementDate}>
                        {formatEngagementDate(item.engagementTimestamp)}
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
                          const url = `${API_ENDPOINTS.GET_S3_URL}?path=from&event_id=${responseEventId}&filename=image.jpg&method=GET`;
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
                <Text style={styles.eventId}>Reflection ID: {item.event_id}</Text>
              </View>
            </View>
          </View>
        )}
        contentContainerStyle={styles.listContainer}
      />
    </View>
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
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    padding: 16,
    backgroundColor: '#1a1a1a',
    color: '#ffffff',
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
});

