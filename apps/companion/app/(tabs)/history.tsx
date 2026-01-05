import { FontAwesome } from '@expo/vector-icons';
import { API_ENDPOINTS } from '@projectmirror/shared';
import { db } from '@projectmirror/shared/firebase';
import { collection, onSnapshot, orderBy, query, QuerySnapshot } from 'firebase/firestore';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

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
  const [selfieImageUrl, setSelfieImageUrl] = useState<string | null>(null);
  const [loadingSelfie, setLoadingSelfie] = useState(false);

  // Listen to reflection_responses collection to detect new selfie responses
  useEffect(() => {
    const responsesRef = collection(db, 'reflection_responses');
    const unsubscribeResponses = onSnapshot(responsesRef, (snapshot) => {
      const eventIds = new Set<string>();
      const eventIdMap = new Map<string, string>();
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
        }
      });
      setResponseEventIds(eventIds);
      setResponseEventIdMap(eventIdMap);
    }, (error) => {
      console.error('Error listening to reflection_responses:', error);
    });

    return () => unsubscribeResponses();
  }, []);

  useEffect(() => {
    // Listen to signals collection for sent Reflections
    const signalsRef = collection(db, 'signals');
    const q = query(signalsRef, orderBy('timestamp', 'desc'));

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

        // Convert map to array and fetch additional data
        const reflectionPromises = Array.from(reflectionMap.values()).map(async (reflection) => {
          // Fetch Reflection image URL from backend (including deleted ones so we can show thumbnail)
          try {
            const eventsResponse = await fetch(API_ENDPOINTS.LIST_MIRROR_EVENTS);
            if (eventsResponse.ok) {
              const eventsData = await eventsResponse.json();
              const matchingEvent = eventsData.events?.find((e: any) => e.event_id === reflection.event_id);
              if (matchingEvent?.image_url) {
                reflection.reflectionImageUrl = matchingEvent.image_url;
                // Also fetch metadata for description (only for non-deleted)
                if (reflection.status !== 'deleted' && matchingEvent.metadata_url) {
                  try {
                    const metaResponse = await fetch(matchingEvent.metadata_url);
                    if (metaResponse.ok) {
                      const metadata = await metaResponse.json();
                      reflection.description = metadata.description;
                    }
                  } catch (err) {
                    console.error('Error fetching metadata:', err);
                  }
                }
              }
            }
          } catch (error) {
            console.error('Error fetching reflection image:', error);
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
  }, [responseEventIds]);

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
                  <Text style={styles.description} numberOfLines={2}>
                    {item.description}
                  </Text>
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
    backgroundColor: '#f5f5f5',
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
    backgroundColor: '#f5f5f5',
  },
  listContainer: {
    padding: 8,
  },
  reflectionItem: {
    backgroundColor: '#fff',
    padding: 12,
    marginVertical: 4,
    marginHorizontal: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d0d0d0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
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
    backgroundColor: '#e0e0e0',
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
    color: '#333',
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
    color: '#666',
    fontWeight: '600',
  },
  engagementDate: {
    fontSize: 12,
    color: '#999',
    marginLeft: 8,
    fontStyle: 'italic',
  },
  responseBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#e8f5e9',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  responseText: {
    fontSize: 12,
    color: '#2ecc71',
    fontWeight: '600',
  },
  eventId: {
    fontSize: 12,
    color: '#999',
    fontFamily: 'monospace',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: '#666',
  },
  emptyText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#666',
    marginTop: 16,
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 14,
    color: '#999',
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
});

