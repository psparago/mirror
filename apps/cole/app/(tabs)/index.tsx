import { db } from '@/config/firebase';
import { FontAwesome } from '@expo/vector-icons';
import { API_ENDPOINTS, Event, EventMetadata, ListEventsResponse } from '@projectmirror/shared';
import { Audio } from 'expo-av';
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
  const soundRef = useRef<Audio.Sound | null>(null);
  
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

  // Auto-play speech/audio when photo with description opens
  // Using useRef to prevent state loops - only trigger once per photo
  const selectedMetadata = selectedEvent ? eventMetadata[selectedEvent.event_id] : null;
  const currentEventIdRef = useRef<string | null>(null);
  
  useEffect(() => {
    // IMMEDIATELY stop any existing audio/speech when event changes
    const previousEventId = currentEventIdRef.current;
    const newEventId = selectedEvent?.event_id || null;
    
    // If we're switching to a different photo, stop everything immediately
    if (previousEventId && previousEventId !== newEventId) {
      Speech.stop();
      const oldSound = soundRef.current;
      if (oldSound) {
        // Stop and unload immediately - don't wait, but do both
        oldSound.stopAsync().catch(() => {});
        oldSound.unloadAsync().catch(() => {});
        soundRef.current = null;
      }
      // Reset hasSpokenRef when switching photos
      hasSpokenRef.current = false;
    }
    
    // If this is the same event (just a URL refresh), don't restart audio
    // This prevents duplicate playback when refreshEventUrls updates selectedEvent
    if (previousEventId === newEventId && newEventId !== null && hasSpokenRef.current) {
      // Same event and audio already started - this is just a URL refresh
      // Update the ref but don't restart playback
      currentEventIdRef.current = newEventId;
      return;
    }
    
    // Update the current event ID reference
    currentEventIdRef.current = newEventId;
    
    if (selectedEvent && selectedMetadata && (selectedMetadata.description || selectedEvent.audio_url)) {
      // Reset the ref when opening a new photo
      if (previousEventId !== newEventId) {
        hasSpokenRef.current = false;
      }
      
      // If audio is already playing for this event, don't start it again
      if (hasSpokenRef.current && currentEventIdRef.current === newEventId) {
        return; // Audio already playing for this event, don't restart
      }
      
      // Capture the event_id to check if we're still on the same photo
      const eventIdForThisEffect = selectedEvent.event_id;
      
      // Small delay (100ms) before speaking to ensure modal is ready
      const timer = setTimeout(async () => {
        // Double-check we're still on the same photo before playing
        // Also check if audio is already playing for this event
        if (!hasSpokenRef.current && currentEventIdRef.current === eventIdForThisEffect) {
          hasSpokenRef.current = true;
          
          // Check if we have audio_url from Event (presigned GET URL) and content_type is 'audio'
          // Use selectedEvent.audio_url (from ListMirrorEvents) not selectedMetadata.audio_url (from metadata.json)
          if (selectedEvent.audio_url && selectedMetadata.content_type === 'audio') {
            // Play audio file
            try {
              // Stop any existing audio immediately (defensive check)
              const existingSound = soundRef.current;
              if (existingSound) {
                existingSound.stopAsync().catch(() => {});
                existingSound.unloadAsync().catch(() => {});
                soundRef.current = null;
              }
              
              // Small delay to ensure old audio is stopped before starting new one
              await new Promise(resolve => setTimeout(resolve, 50));
              
              // Check again if we're still on the same photo
              if (currentEventIdRef.current !== eventIdForThisEffect) {
                return; // User switched photos, don't start audio
              }
              
              // Load and play the audio using the presigned GET URL from the Event
              const { sound } = await Audio.Sound.createAsync(
                { uri: selectedEvent.audio_url },
                { shouldPlay: true }
              );
              
              // Final check before assigning
              if (currentEventIdRef.current === eventIdForThisEffect) {
                soundRef.current = sound;
                
                // Cleanup when audio finishes
                sound.setOnPlaybackStatusUpdate((status) => {
                  if (status.isLoaded && status.didJustFinish) {
                    sound.unloadAsync();
                    if (soundRef.current === sound) {
                      soundRef.current = null;
                    }
                  }
                });
              } else {
                // User switched photos while loading, unload immediately
                sound.unloadAsync().catch(() => {});
              }
            } catch (error) {
              console.error("Error playing audio:", error);
              // Fallback to TTS if audio fails
              if (currentEventIdRef.current === eventIdForThisEffect && selectedMetadata.description) {
                Speech.speak(selectedMetadata.description, {
                  pitch: 0.9,
                  rate: 0.9,
                  language: 'en-US',
                });
              }
            }
          } else if (selectedMetadata.description && currentEventIdRef.current === eventIdForThisEffect) {
            // Use TTS for text descriptions
            Speech.speak(selectedMetadata.description, {
              pitch: 0.9,
              rate: 0.9,
              language: 'en-US',
            });
          }
        }
      }, 100);

      return () => {
        clearTimeout(timer);
        Speech.stop();
        // Cleanup audio - stop first, then unload
        const soundToCleanup = soundRef.current;
        if (soundToCleanup) {
          soundToCleanup.stopAsync().catch(() => {});
          soundToCleanup.unloadAsync().catch(() => {});
          soundRef.current = null;
        }
      };
    } else {
      // Stop speech/audio if no description
      Speech.stop();
      const soundToCleanup = soundRef.current;
      if (soundToCleanup) {
        soundToCleanup.stopAsync().catch(() => {});
        soundToCleanup.unloadAsync().catch(() => {});
        soundRef.current = null;
      }
    }
  }, [selectedEvent?.event_id, selectedEvent?.audio_url, selectedMetadata?.description, selectedMetadata?.content_type]);

  const fetchEvents = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch(API_ENDPOINTS.LIST_MIRROR_EVENTS);
      
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
      
      // Sort by event_id (timestamp) in descending order (latest first)
      // This ensures the newest events appear first in the grid
      const sortedEvents = validEvents.sort((a, b) => {
        // event_id is a timestamp string, so we can compare them directly
        // For descending order (latest first), we want b - a
        return b.event_id.localeCompare(a.event_id);
      });
      
      setEvents(sortedEvents);
      
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

  const refreshEventUrls = async (eventId: string): Promise<Event | null> => {
    try {
      // Fetch fresh URLs for all events (backend generates new presigned URLs)
      const response = await fetch(API_ENDPOINTS.LIST_MIRROR_EVENTS);
      if (!response.ok) {
        console.warn(`Failed to refresh URLs for event ${eventId}`);
        return null;
      }
      
      const data: ListEventsResponse = await response.json();
      const refreshedEvent = data.events?.find(e => e.event_id === eventId);
      
      if (refreshedEvent) {
        // Update the event in the events array
        setEvents(prevEvents => 
          prevEvents.map(e => e.event_id === eventId ? refreshedEvent : e)
        );
        return refreshedEvent;
      }
      return null;
    } catch (error) {
      console.error(`Error refreshing URLs for event ${eventId}:`, error);
      return null;
    }
  };

  const handleEventPress = async (item: Event) => {
    // Open immediately with existing URLs for instant response
    setSelectedEvent(item);
    
    // Refresh URLs in background (non-blocking) to ensure they're not expired
    // This happens after the modal opens so Cole doesn't wait
    const eventIdToRefresh = item.event_id; // Capture event_id for closure
    refreshEventUrls(eventIdToRefresh).then(refreshedEvent => {
      if (refreshedEvent) {
        // Update selectedEvent if it's still the same event
        setSelectedEvent(prev => {
          if (prev?.event_id === eventIdToRefresh) {
            return refreshedEvent;
          }
          return prev; // Don't update if user switched to a different photo
        });
      }
    }).catch(err => {
      console.warn("Background URL refresh failed:", err);
      // Continue with original URLs - they might still work
    });
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
        onPress={() => handleEventPress(item)}
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

  const closeFullScreen = useCallback(async () => {
    // Stop any ongoing speech/audio
    Speech.stop();
    if (soundRef.current) {
      await soundRef.current.unloadAsync();
      soundRef.current = null;
    }
    setSelectedEvent(null);
  }, []);

  const navigateToPhoto = useCallback(async (direction: 'prev' | 'next') => {
    if (!selectedEvent) return;
    
    // Find current index
    const currentIndex = events.findIndex(e => e.event_id === selectedEvent.event_id);
    if (currentIndex === -1) return;
    
    // Stop any ongoing speech/audio IMMEDIATELY
    Speech.stop();
    
    // Stop and unload audio - wait for stop to actually complete
    const currentSound = soundRef.current;
    if (currentSound) {
      try {
        // Stop playback and wait for it to actually stop
        await currentSound.stopAsync();
      } catch (e) {
        // Ignore errors if already stopped
      }
      try {
        // Unload after stopping
        await currentSound.unloadAsync();
      } catch (e) {
        // Ignore errors
      }
      soundRef.current = null;
    }
    
    // Reset the hasSpokenRef to prevent new audio from starting too early
    hasSpokenRef.current = false;
    
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
      // Don't update the ref here - let the useEffect handle it
      // This ensures the useEffect sees the transition from old event ID to new event ID
      
      // Refresh URLs for the target photo
      const refreshedEvent = await refreshEventUrls(targetEvent.event_id);
      
      // Update selectedEvent - this will trigger useEffect which will:
      // 1. See the change from old event ID to new event ID
      // 2. Stop old audio
      // 3. Update the ref to the new event ID
      // 4. Start new audio
      setSelectedEvent(refreshedEvent || targetEvent);
    }
  }, [selectedEvent, events, refreshEventUrls, closeFullScreen]);

  // PanResponder for swipe navigation:
  // - Left/Right: Navigate between photos
  // - Up/Down: Return to inbox
  const swipeResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true, // Respond to all swipes
        onPanResponderRelease: (_, gestureState) => {
          const absDx = Math.abs(gestureState.dx);
          const absDy = Math.abs(gestureState.dy);
          
          // Minimum swipe distance of 50 pixels
          if (absDx < 50 && absDy < 50) {
            return; // Too small, ignore
          }
          
          // Vertical swipe (up or down) - return to inbox
          if (absDy > absDx && absDy > 50) {
            closeFullScreen();
          }
          // Horizontal swipe (left or right) - navigate between photos
          // Standard interpretation: swipe left = next (forward), swipe right = previous (back)
          else if (absDx > absDy && absDx > 50 && absDy < 100) {
            if (gestureState.dx < 0) {
              // Swipe left - go to next photo (older, forward in array)
              navigateToPhoto('next');
            } else {
              // Swipe right - go to previous photo (newer, backward in array)
              navigateToPhoto('prev');
            }
          }
        },
      }),
    [navigateToPhoto, closeFullScreen]
  );

  const playDescription = async () => {
    const metadata = selectedEvent ? eventMetadata[selectedEvent.event_id] : null;
    if (!metadata || !selectedEvent) return;
    
    // Refresh URLs before playing to ensure they're not expired
    const refreshedEvent = await refreshEventUrls(selectedEvent.event_id);
    const eventToUse = refreshedEvent || selectedEvent;
    
    // Stop any ongoing speech/audio first
    Speech.stop();
    if (soundRef.current) {
      await soundRef.current.unloadAsync();
      soundRef.current = null;
    }
    
    // Check if we have audio_url from Event (presigned GET URL) and content_type is 'audio'
    // Use eventToUse.audio_url (from ListMirrorEvents) not metadata.audio_url (from metadata.json)
    if (eventToUse.audio_url && metadata.content_type === 'audio') {
      // Play audio file
      try {
        const { sound } = await Audio.Sound.createAsync(
          { uri: eventToUse.audio_url },
          { shouldPlay: true }
        );
        soundRef.current = sound;
        
        // Update selectedEvent with fresh URLs
        if (refreshedEvent) {
          setSelectedEvent(refreshedEvent);
        }
        
        // Cleanup when audio finishes
        sound.setOnPlaybackStatusUpdate((status) => {
          if (status.isLoaded && status.didJustFinish) {
            sound.unloadAsync();
            soundRef.current = null;
          }
        });
      } catch (error) {
        console.error("Error playing audio:", error);
        Alert.alert("Error", "Failed to play audio message");
      }
    } else if (metadata.description) {
      // Use TTS for text descriptions
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

              // 3. Stop any ongoing speech/audio
              Speech.stop();
              if (soundRef.current) {
                await soundRef.current.unloadAsync();
                soundRef.current = null;
              }
              
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
            
            {selectedMetadata && (selectedMetadata.description || selectedEvent?.audio_url) && (
              <View style={styles.descriptionContainer}>
                <View style={styles.descriptionHeader}>
                  <Text style={styles.descriptionLabel}>From {selectedMetadata.sender}:</Text>
                  <View style={styles.buttonRow}>
                    <TouchableOpacity 
                      style={styles.playButton}
                      onPress={playDescription}
                      activeOpacity={0.7}
                    >
                      <FontAwesome 
                        name={selectedMetadata.content_type === 'audio' ? "volume-up" : "play"} 
                        size={24} 
                        color="#fff" 
                      />
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
                {selectedMetadata.content_type === 'audio' ? (
                  <Text style={styles.descriptionText}>
                    🎤 Voice message
                  </Text>
                ) : (
                  <Text style={styles.descriptionText}>
                    {selectedMetadata.description}
                  </Text>
                )}
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
    backgroundColor: '#1a1a1a',
  },
  centerContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    backgroundColor: '#1a1a1a',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    padding: 16,
    backgroundColor: '#2a2a2a',
    color: '#fff',
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
    backgroundColor: '#2a2a2a',
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
    color: '#ccc',
  },
  errorText: {
    fontSize: 16,
    color: '#ff6b6b',
    textAlign: 'center',
    marginBottom: 8,
  },
  retryText: {
    fontSize: 14,
    color: '#4a9eff',
    textDecorationLine: 'underline',
  },
  emptyText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#ccc',
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
