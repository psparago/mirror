import { db } from '@/config/firebase';
import { FontAwesome } from '@expo/vector-icons';
import { API_ENDPOINTS } from '@projectmirror/shared';
import { collection, doc, getDoc, getDocs, onSnapshot, orderBy, query, QuerySnapshot, where } from 'firebase/firestore';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface SentReflection {
  event_id: string;
  timestamp: any;
  status?: 'ready' | 'engaged' | 'replayed';
  engagementTimestamp?: any;
  hasResponse?: boolean;
  responseImageUrl?: string;
  reflectionImageUrl?: string;
  description?: string;
}

export default function SentHistoryScreen() {
  const [reflections, setReflections] = useState<SentReflection[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Listen to signals collection for sent Reflections
    const signalsRef = collection(db, 'signals');
    const q = query(signalsRef, orderBy('timestamp', 'desc'));

    const unsubscribe = onSnapshot(
      q,
      async (snapshot: QuerySnapshot) => {
        // Group signals by event_id, keeping the one with highest status priority
        const reflectionMap = new Map<string, SentReflection>();
        
        // Status priority: replayed > engaged > ready
        const statusPriority: { [key: string]: number } = {
          'replayed': 3,
          'engaged': 2,
          'ready': 1,
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
          // Fetch Reflection image URL from backend
          try {
            const eventsResponse = await fetch(API_ENDPOINTS.LIST_MIRROR_EVENTS);
            if (eventsResponse.ok) {
              const eventsData = await eventsResponse.json();
              const matchingEvent = eventsData.events?.find((e: any) => e.event_id === reflection.event_id);
              if (matchingEvent?.image_url) {
                reflection.reflectionImageUrl = matchingEvent.image_url;
                // Also fetch metadata for description
                if (matchingEvent.metadata_url) {
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

          // Check for selfie response - use event_id as document ID
          try {
            const responseRef = doc(db, 'reflection_responses', reflection.event_id);
            const responseDoc = await getDoc(responseRef);
            if (responseDoc.exists()) {
              reflection.hasResponse = true;
              const responseData = responseDoc.data();
              // Store response_event_id for later use (we'll need backend support for GET URLs)
              if (responseData.response_event_id) {
                // For now, we'll just mark that a response exists
                // TODO: Add backend function to get presigned GET URLs for response images
              }
            }
          } catch (error) {
            console.error('Error checking response:', error);
          }

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
  }, []);

  const getStatusText = (status?: string) => {
    switch (status) {
      case 'engaged':
        return 'Engaged';
      case 'replayed':
        return 'Replayed';
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
      <FlatList
        data={reflections}
        keyExtractor={(item) => item.event_id}
        renderItem={({ item }) => (
          <View style={styles.reflectionItem}>
            <View style={styles.reflectionRow}>
              {item.reflectionImageUrl && (
                <Image
                  source={{ uri: item.reflectionImageUrl }}
                  style={styles.reflectionImage}
                  resizeMode="cover"
                />
              )}
              <View style={styles.reflectionInfo}>
                <View style={styles.reflectionContent}>
                  <View style={styles.statusBadge}>
                    <View style={[styles.statusDot, { backgroundColor: getStatusColor(item.status) }]} />
                    <Text style={styles.statusText}>{getStatusText(item.status)}</Text>
                    {item.engagementTimestamp && (
                      <Text style={styles.engagementDate}>
                        {formatEngagementDate(item.engagementTimestamp)}
                      </Text>
                    )}
                  </View>
                  {item.hasResponse && (
                    <View style={styles.responseBadge}>
                      <FontAwesome name="camera" size={16} color="#2ecc71" />
                      <Text style={styles.responseText}>Selfie</Text>
                    </View>
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
    backgroundColor: '#fff',
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
    backgroundColor: '#f9f9f9',
    padding: 12,
    marginVertical: 4,
    marginHorizontal: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  reflectionRow: {
    flexDirection: 'row',
    gap: 12,
  },
  reflectionImage: {
    width: 80,
    height: 80,
    borderRadius: 8,
    backgroundColor: '#e0e0e0',
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
});

