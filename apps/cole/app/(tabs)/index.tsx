import { db } from '@/config/firebase';
import { FontAwesome } from '@expo/vector-icons';
import { API_ENDPOINTS, Event, EventMetadata, ListEventsResponse } from '@projectmirror/shared';
import * as Speech from 'expo-speech';
import { collection, deleteDoc, doc, DocumentData, onSnapshot, orderBy, query, QuerySnapshot } from 'firebase/firestore';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Modal, PanResponder, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';

export default function ColeInboxScreen() {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);
  const [eventMetadata, setEventMetadata] = useState<{ [key: string]: EventMetadata }>({});
  const { width } = useWindowDimensions();
  const hasSpokenRef = useRef(false); // Must be declared before any conditional returns
  
  // Responsive column count: 2 for iPhone, 4-5 for iPad
  const numColumns = width >= 768 ? (width >= 1024 ? 5 : 4) : 2;

  useEffect(() => {
    fetchEvents();

    // Set up Firestore listener for real-time signals
    const signalsRef = collection(db, 'signals');
    const q = query(signalsRef, orderBy('timestamp', 'desc'));
    
    let isInitialLoad = true;
    
    const unsubscribe = onSnapshot(
      q,
      (snapshot: QuerySnapshot<DocumentData>) => {
        // Skip the initial load - we already fetched events on mount
        if (isInitialLoad) {
          isInitialLoad = false;
          return;
        }

        // Check if this is a new document (not just initial load)
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'added') {
            const signalData = change.doc.data();
            console.log("New Mirror Event Detected!", signalData);
            // Trigger refresh of the gallery
            fetchEvents();
          }
        });
      },
      (error) => {
        console.error("Firestore listener error:", error);
      }
    );

    // Cleanup listener on unmount to prevent memory leaks
    return () => {
      unsubscribe();
    };
  }, []);

  // Auto-play speech when photo with description opens
  // Using useRef to prevent state loops - only trigger once per photo
  const selectedMetadata = selectedEvent ? eventMetadata[selectedEvent.event_id] : null;
  useEffect(() => {
    if (selectedEvent && selectedMetadata && selectedMetadata.description) {
      // Reset the ref when a new photo opens
      hasSpokenRef.current = false;
      
      // Small delay to ensure modal is fully rendered
      const timer = setTimeout(() => {
        if (!hasSpokenRef.current) {
          hasSpokenRef.current = true;
          Speech.speak(selectedMetadata.description, {
            pitch: 0.9,
            rate: 0.9,
            language: 'en-US',
          });
        }
      }, 300);

      return () => {
        clearTimeout(timer);
        Speech.stop();
      };
    } else {
      // Stop speech if no description
      Speech.stop();
    }
  }, [selectedEvent?.event_id, selectedMetadata?.description]);

  const fetchEvents = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch(API_ENDPOINTS.LIST_MIRROR_PHOTOS);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch events: ${response.status}`);
      }
      
      const data: ListEventsResponse = await response.json();
      console.log('Fetched events:', JSON.stringify(data, null, 2));
      
      // Filter out events without image URLs and log issues
      const validEvents = (data.events || []).filter((event) => {
        if (!event.image_url || event.image_url === '') {
          console.warn(`Event ${event.event_id} has no image_url`);
          return false;
        }
        return true;
      });
      
      setEvents(validEvents);
      
      // Fetch metadata for each event
      const metadataPromises = (data.events || []).map(async (event) => {
        if (event.metadata_url) {
          try {
            const metaResponse = await fetch(event.metadata_url);
            if (metaResponse.ok) {
              const metadata: EventMetadata = await metaResponse.json();
              return { eventId: event.event_id, metadata };
            }
          } catch (err) {
            console.warn(`Failed to fetch metadata for ${event.event_id}:`, err);
          }
        }
        return null;
      });
      
      const metadataResults = await Promise.all(metadataPromises);
      const metadataMap: { [key: string]: EventMetadata } = {};
      metadataResults.forEach(result => {
        if (result) {
          metadataMap[result.eventId] = result.metadata;
        }
      });
      setEventMetadata(metadataMap);
    } catch (err: any) {
      console.error('Error fetching events:', err);
      setError(err.message || 'Failed to load events');
    } finally {
      setLoading(false);
    }
  };

  const renderEvent = ({ item }: { item: Event }) => {
    const metadata = eventMetadata[item.event_id];
    const hasDescription = metadata?.description;
    
    // Don't render if no image URL
    if (!item.image_url || item.image_url === '') {
      return null;
    }
    
    return (
      <TouchableOpacity 
        style={styles.photoContainer}
        onPress={() => setSelectedEvent(item)}
        activeOpacity={0.8}
      >
        <Image
          source={{ uri: item.image_url }}
          style={styles.photo}
          resizeMode="cover"
          onError={(error) => {
            console.error(`Error loading image for event ${item.event_id}:`, error);
          }}
        />
        {hasDescription && (
          <View style={styles.descriptionBadge}>
            <Text style={styles.descriptionBadgeText}>📝</Text>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  const closeFullScreen = useCallback(() => {
    // Stop any ongoing speech
    Speech.stop();
    setSelectedEvent(null);
  }, []);

  // PanResponder for swipe left or right to close
  const swipeResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, gestureState) => {
          // Only respond to horizontal swipes
          return Math.abs(gestureState.dx) > Math.abs(gestureState.dy);
        },
        onPanResponderRelease: (_, gestureState) => {
          // Swipe left or right with minimum distance of 50 pixels
          if (Math.abs(gestureState.dx) > 50 && Math.abs(gestureState.dy) < 100) {
            closeFullScreen();
          }
        },
      }),
    [closeFullScreen]
  );

  const playDescription = () => {
    const metadata = selectedEvent ? eventMetadata[selectedEvent.event_id] : null;
    if (metadata && metadata.description) {
      Speech.stop(); // Stop any ongoing speech first
      Speech.speak(metadata.description, {
        pitch: 0.9,
        rate: 0.9,
        language: 'en-US',
      });
    }
  };

  const deleteEvent = async (event: Event) => {
    Alert.alert(
      "Delete Event",
      "Are you sure you want to delete this photo and description?",
      [
        {
          text: "Cancel",
          style: "cancel",
        },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              // 1. Delete S3 objects
              const deleteResponse = await fetch(
                `${API_ENDPOINTS.DELETE_MIRROR_EVENT}?event_id=${event.event_id}`
              );
              
              if (!deleteResponse.ok) {
                const errorData = await deleteResponse.json();
                throw new Error(errorData.errors?.join(', ') || 'Failed to delete S3 objects');
              }

              // 2. Delete Firestore signal document
              try {
                const signalRef = doc(db, 'signals', event.event_id);
                await deleteDoc(signalRef);
                console.log("Firestore signal deleted");
              } catch (firestoreError: any) {
                console.warn("Failed to delete Firestore signal:", firestoreError);
                // Continue even if Firestore delete fails
              }

              // 3. Stop any ongoing speech
              Speech.stop();
              
              // 4. Remove from local state and refresh
              setEvents(events.filter(e => e.event_id !== event.event_id));
              setSelectedEvent(null);
              
              // 5. Refresh the list to ensure consistency
              fetchEvents();
              
              Alert.alert("Success", "Event deleted successfully");
            } catch (error: any) {
              console.error("Delete error:", error);
              Alert.alert("Delete Failed", error.message || "Failed to delete event");
            }
          },
        },
      ]
    );
  };

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#2e78b7" />
        <Text style={styles.loadingText}>Loading Cole's inbox...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.errorText}>Error: {error}</Text>
        <Text style={styles.retryText} onPress={fetchEvents}>
          Tap to retry
        </Text>
      </View>
    );
  }

  if (events.length === 0) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.emptyText}>No photos in Cole's inbox yet</Text>
        <Text style={styles.emptySubtext}>Photos from companions will appear here</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Cole's Inbox</Text>
      <FlatList
        key={numColumns}
        data={events}
        renderItem={renderEvent}
        keyExtractor={(item) => item.event_id}
        numColumns={numColumns}
        contentContainerStyle={styles.listContainer}
        columnWrapperStyle={numColumns > 1 ? styles.row : undefined}
      />

      {/* Full-screen modal with description */}
      <Modal
        visible={selectedEvent !== null}
        transparent={false}
        animationType="fade"
        onRequestClose={closeFullScreen}
      >
        {selectedEvent && (
          <View style={styles.fullScreenContainer} {...swipeResponder.panHandlers}>
            <View style={styles.topButtonContainer}>
              {/* Delete button - for caregiver mode */}
              <TouchableOpacity 
                style={styles.deleteButton}
                onPress={() => deleteEvent(selectedEvent)}
              >
                <FontAwesome name="trash" size={20} color="#fff" />
              </TouchableOpacity>
            </View>
            
            <Image
              source={{ uri: selectedEvent.image_url }}
              style={styles.fullScreenImage}
              resizeMode="contain"
            />
            
            {selectedMetadata && selectedMetadata.description && (
              <View style={styles.descriptionContainer}>
                <View style={styles.descriptionHeader}>
                  <Text style={styles.descriptionLabel}>From {selectedMetadata.sender}:</Text>
                  <View style={styles.buttonRow}>
                    <TouchableOpacity 
                      style={styles.playButton}
                      onPress={playDescription}
                      activeOpacity={0.7}
                    >
                      <FontAwesome name="play" size={24} color="#fff" />
                    </TouchableOpacity>
                    <TouchableOpacity 
                      style={styles.closeButtonInline}
                      onPress={closeFullScreen}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.closeButtonTextInline}>X</Text>
                    </TouchableOpacity>
                  </View>
                </View>
                <Text style={styles.descriptionText}>
                  {selectedMetadata.description}
                </Text>
              </View>
            )}
          </View>
        )}
      </Modal>
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
  row: {
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  photoContainer: {
    flex: 1,
    margin: 4,
    aspectRatio: 1,
    backgroundColor: '#f0f0f0',
    borderRadius: 8,
    overflow: 'hidden',
    position: 'relative',
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
    color: '#666',
  },
  errorText: {
    fontSize: 16,
    color: '#d32f2f',
    textAlign: 'center',
    marginBottom: 8,
  },
  retryText: {
    fontSize: 14,
    color: '#2e78b7',
    textDecorationLine: 'underline',
  },
  emptyText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#666',
    textAlign: 'center',
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 14,
    color: '#999',
    textAlign: 'center',
  },
  fullScreenContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  topButtonContainer: {
    position: 'absolute',
    top: 50,
    right: 20,
    zIndex: 1,
    flexDirection: 'row',
    gap: 10,
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
    backgroundColor: 'rgba(211, 47, 47, 0.8)',
    padding: 12,
    borderRadius: 8,
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  fullScreenImage: {
    flex: 1,
    width: '100%',
  },
  descriptionContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.85)',
    padding: 24,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  descriptionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
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
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'rgba(46, 120, 183, 0.9)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeButtonInline: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#fff',
  },
  closeButtonTextInline: {
    color: '#fff',
    fontSize: 24,
    fontWeight: 'bold',
  },
  descriptionText: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '600',
    lineHeight: 32,
  },
});
