import ReflectedWatchView from '@/components/ReflectedWatchView';
import { API_ENDPOINTS, Event, EventMetadata, ListEventsResponse } from '@projectmirror/shared';
import { db } from '@projectmirror/shared/firebase';
import { BlurView } from 'expo-blur';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as FileSystem from 'expo-file-system';
import { LinearGradient } from 'expo-linear-gradient';
import * as Speech from 'expo-speech';
import { collection, doc, DocumentData, getDoc, onSnapshot, orderBy, query, QuerySnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, AppStateStatus, Image, PanResponder, Platform, StyleSheet, Text, TouchableOpacity, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function ColeInboxScreen() {
  const [events, setEvents] = useState<Event[]>([]);
  const [pendingUpdates, setPendingUpdates] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);
  const [eventMetadata, setEventMetadata] = useState<{ [key: string]: EventMetadata }>({});
  const [isCapturingSelfie, setIsCapturingSelfie] = useState(false);
  const cameraRef = useRef<CameraView>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const insets = useSafeAreaInsets();
  const engagementTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasEngagedRef = useRef<{ [eventId: string]: boolean }>({});
  const hasReplayedRef = useRef<{ [eventId: string]: boolean }>({});
  const refreshingEventsRef = useRef<Set<string>>(new Set()); // Track events currently being refreshed

  // Responsive column count: 2 for iPhone, 4-5 for iPad
  const numColumns = width >= 768 ? (width >= 1024 ? 5 : 4) : 2;

  // Fetch events and listen for Firestore updates
  // Fetch events and listen for Firestore updates - Moved below to fix closure staleness

  // Auto-refresh events when app comes back to foreground (handles expired URLs and reconnection)
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      if (nextAppState === 'active') {
        // App came to foreground - refresh events to get fresh URLs
        fetchEvents();
      }
    });

    return () => {
      subscription.remove();
    };
  }, []);

  // Auto-select the first (most recent) event when events load (only once)
  const hasAutoSelectedRef = useRef(false);
  useEffect(() => {
    if (events.length > 0 && !hasAutoSelectedRef.current) {
      hasAutoSelectedRef.current = true;
      handleEventPress(events[0]);
    }
  }, [events.length]);


  // Fetch metadata when a reflection is selected
  useEffect(() => {
    if (selectedEvent && !eventMetadata[selectedEvent.event_id] && selectedEvent.metadata_url) {
      fetch(selectedEvent.metadata_url)
        .then(res => {
          if (res.ok) {
            return res.json();
          }
          throw new Error(`Failed to fetch metadata: ${res.status}`);
        })
        .then((metadata: EventMetadata) => {
          setEventMetadata(prev => ({
            ...prev,
            [selectedEvent.event_id]: metadata
          }));
        })
        .catch(err => {
          console.warn(`Failed to fetch metadata for ${selectedEvent.event_id}:`, err);
        });
    }
  }, [selectedEvent?.event_id, selectedEvent?.metadata_url, eventMetadata]);

  // Get metadata for selected event  
  const selectedMetadata = selectedEvent ? eventMetadata[selectedEvent.event_id] : null;

  // Track engagement: send signal if Star views Reflection for > 5 seconds
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

  const fetchEvents = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch(API_ENDPOINTS.LIST_MIRROR_EVENTS);

      if (!response.ok) {
        throw new Error(`Failed to fetch events: ${response.status}`);
      }

      const data: ListEventsResponse = await response.json();

      // Filter out events without image URLs and log issues
      const validEvents = (data.events || []).filter((event) => {
        if (!event.image_url || event.image_url === '') {
          console.log(`Skipping incomplete event ${event.event_id} (no image_url)`);
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

      // Hot Update Logic:
      // If user is viewing a reflection (selectedEvent exists), queue updates instead of showing immediately.
      if (selectedEvent) {
        // Only update if there are changes. Simple check: if mismatch in first event ID or length
        const currentTopId = events.length > 0 ? events[0].event_id : null;
        const newTopId = sortedEvents.length > 0 ? sortedEvents[0].event_id : null;

        if (currentTopId !== newTopId || events.length !== sortedEvents.length) {
          console.log('🔥 Hot Update: Queueing pending events');
          setPendingUpdates(sortedEvents);
        }
      } else {
        // Idle state: Update immediately
        setEvents(sortedEvents);
        setPendingUpdates([]); // Clear pending
      }

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

  // Keep ref to latest fetchEvents to avoid dependency cycles
  const fetchEventsRef = useRef(fetchEvents);
  useEffect(() => {
    fetchEventsRef.current = fetchEvents;
  });

  // Fetch events and listen for Firestore updates
  useEffect(() => {
    fetchEventsRef.current(); // Initial fetch

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
            // Trigger refresh of the gallery
            // Use ref to call the LATEST fetchEvents (with fresh closures over selectedEvent)
            if (fetchEventsRef.current) {
              fetchEventsRef.current();
            }
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

  // Flush pending updates to the main list
  const onFlushUpdates = () => {
    if (pendingUpdates.length > 0) {
      setEvents(pendingUpdates);
      setPendingUpdates([]);
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

    // Fetch metadata if not already loaded
    if (!eventMetadata[item.event_id] && item.metadata_url) {
      try {
        const metaResponse = await fetch(item.metadata_url);
        if (metaResponse.ok) {
          const metadata: EventMetadata = await metaResponse.json();
          setEventMetadata(prev => ({
            ...prev,
            [item.event_id]: metadata
          }));
        }
      } catch (err) {
        console.warn(`Failed to fetch metadata for ${item.event_id}:`, err);
      }
    }

    // Refresh URLs in background (non-blocking) to ensure they're not expired
    const eventIdToRefresh = item.event_id;
    refreshEventUrls(eventIdToRefresh).then(refreshedEvent => {
      if (refreshedEvent) {
        // DON'T update selectedEvent - this would trigger re-renders and re-playback
        // Just update the events array in the background

        // Fetch metadata for refreshed event if not already loaded
        if (refreshedEvent.metadata_url && !eventMetadata[refreshedEvent.event_id]) {
          fetch(refreshedEvent.metadata_url)
            .then(res => res.json())
            .then((metadata: EventMetadata) => {
              setEventMetadata(prev => ({
                ...prev,
                [refreshedEvent.event_id]: metadata
              }));
            })
            .catch(err => console.warn("Failed to fetch metadata for refreshed event:", err));
        }
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
        <BlurView intensity={30} style={styles.photoBlurContainer}>
          <Image
            source={{ uri: item.image_url }}
            style={styles.photo}
            resizeMode="cover"
            onError={(error) => {
              console.error(`Error loading image for event ${item.event_id}:`, error);
            }}
          />
        </BlurView>
      </TouchableOpacity>
    );
  };

  const closeFullScreen = useCallback(async () => {
    // Stop speech if playing
    Speech.stop();

    // Auto-flush pending updates when closing
    if (pendingUpdates.length > 0) {
      onFlushUpdates();
    }

    // Only fetch fresh list if we didn't just flush (optional, but robust)
    if (pendingUpdates.length === 0) {
      fetchEvents();
    }

    setSelectedEvent(null);
  }, [pendingUpdates, events]);

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
      // Update selectedEvent - ReflectedWatchView will handle the audio transition
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
    console.log(`🔄 Refreshing expired URLs for event ${event.event_id}`);

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

  // Send engagement signal to Firestore
  const sendEngagementSignal = async (eventId: string) => {
    if (hasEngagedRef.current[eventId]) return; // Already sent

    try {
      const signalRef = doc(db, 'signals', eventId);
      await setDoc(signalRef, {
        event_id: eventId,
        status: 'engaged',
        timestamp: serverTimestamp(),
        type: 'engagement_heartbeat',
      }, { merge: true });
      hasEngagedRef.current[eventId] = true;
    } catch (error) {
      console.error('Error sending engagement signal:', error);
    }
  };

  // Send replay signal to Firestore
  const sendReplaySignal = async (eventId: string) => {
    if (hasReplayedRef.current[eventId]) {
      return; // Already sent
    }

    try {
      const signalRef = doc(db, 'signals', eventId);
      await setDoc(signalRef, {
        event_id: eventId,
        status: 'replayed',
        timestamp: serverTimestamp(),
        type: 'engagement_heartbeat',
      }, { merge: true });
      hasReplayedRef.current[eventId] = true;
    } catch (error) {
      console.error('Error sending replay signal:', error);
    }
  };

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
      // Capture photo
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.8,
        base64: false,
      });

      if (!photo) {
        throw new Error("Failed to capture photo");
      }

      // Generate event ID for the response
      const responseEventId = Date.now().toString();

      // Get presigned URL for upload (path=from for Star to Companion)
      let imageUrl: string;
      try {
        console.log("Getting presigned URL for selfie upload...");
        const imageResponse = await fetch(`${API_ENDPOINTS.GET_S3_URL}?path=from&event_id=${responseEventId}&filename=image.jpg`);
        if (!imageResponse.ok) {
          throw new Error(`Failed to get presigned URL: ${imageResponse.status} ${imageResponse.statusText}`);
        }
        const imageData = await imageResponse.json();
        imageUrl = imageData.url;

        console.log("Got presigned URL, uploading image...");
        const imageBlob = await fetch(photo.uri).then(r => r.blob());
        const uploadResponse = await fetch(imageUrl, {
          method: 'PUT',
          body: imageBlob,
          headers: { 'Content-Type': 'image/jpeg' },
        });

        if (uploadResponse.status !== 200) {
          throw new Error(`Image upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`);
        }
        console.log("Image uploaded successfully");
      } catch (error: any) {
        console.error("Error getting presigned URL or uploading image:", error);
        throw new Error(`Failed to get upload URL or upload image: ${error.message || 'Network request failed'}`);
      }

      // Cleanup local file
      try {
        await FileSystem.deleteAsync(photo.uri, { idempotent: true });
      } catch (cleanupError) {
        console.warn("Failed to delete local file:", cleanupError);
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

      // Create reflection_response document in Firestore (non-blocking)
      // Use original event_id as document ID for easy lookup
      const responseRef = doc(db, 'reflection_responses', selectedEvent.event_id);
      setDoc(responseRef, {
        event_id: selectedEvent.event_id, // Link to original Reflection
        response_event_id: responseEventId,
        timestamp: serverTimestamp(),
        type: 'selfie_response',
      })
        .catch((firestoreError: any) => {
          console.error("Failed to save reflection response to Firestore:", firestoreError);
          // Don't show error to user - S3 upload succeeded, which is the important part
          // Firestore is just for tracking/display in Companion app
        });

    } catch (error: any) {
      console.error("Error capturing selfie:", error);
      let errorMessage = "Failed to capture selfie. Please try again.";
      if (error?.code === 'permission-denied' || error?.message?.includes('permission')) {
        errorMessage = "Permission error. Please check Firestore security rules for 'reflection_responses' collection.";
      }
      if (!silent) {
        Alert.alert("Error", errorMessage);
      }
    } finally {
      setIsCapturingSelfie(false);
    }
  }, [selectedEvent, cameraPermission, isCapturingSelfie, requestCameraPermission, eventMetadata]);


  const deleteEvent = async (event: Event) => {
    try {
      // 1. Delete S3 objects
      const deleteResponse = await fetch(
        `${API_ENDPOINTS.DELETE_MIRROR_EVENT}?event_id=${event.event_id}`
      );

      if (!deleteResponse.ok) {
        const errorData = await deleteResponse.json();
        throw new Error(errorData.errors?.join(', ') || 'Failed to delete S3 objects');
      }

      // 2. Delete selfie response image from S3 if it exists (keep the document)
      try {
        const responseRef = doc(db, 'reflection_responses', event.event_id);
        const responseDoc = await getDoc(responseRef);

        if (responseDoc.exists()) {
          const responseData = responseDoc.data();
          const responseEventId = responseData.response_event_id;

          if (responseEventId) {
            // Delete selfie image from S3 (path: from/{response_event_id}/image.jpg)
            // Keep the reflection_response document in Firestore for history
            const deleteSelfieResponse = await fetch(
              `${API_ENDPOINTS.DELETE_MIRROR_EVENT}?event_id=${responseEventId}&path=from`
            );

            if (!deleteSelfieResponse.ok) {
              console.warn("Failed to delete selfie image from S3, continuing with deletion");
            }
          }
        }
      } catch (selfieError: any) {
        console.warn("Failed to delete selfie response:", selfieError);
        // Continue even if selfie deletion fails
      }

      // 3. Mark Firestore signal document as deleted (instead of deleting it)
      try {
        const signalRef = doc(db, 'signals', event.event_id);
        await setDoc(signalRef, {
          status: 'deleted',
          deleted_at: serverTimestamp(),
        }, { merge: true });
      } catch (firestoreError: any) {
        console.warn("Failed to mark Firestore signal as deleted:", firestoreError);
        // Continue even if Firestore update fails
      }

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

  if (loading) {
    return (
      <LinearGradient
        colors={['#A1C4FD', '#C2E9FB']}
        style={styles.centerContainer}
      >
        <ActivityIndicator size="large" color="#2e78b7" />
        <Text style={styles.loadingText}>Loading Reflections...</Text>
      </LinearGradient>
    );
  }

  if (error) {
    return (
      <LinearGradient
        colors={['#A1C4FD', '#C2E9FB']}
        style={styles.centerContainer}
      >
        <Text style={styles.errorText}>Error: {error}</Text>
        <Text style={styles.retryText} onPress={fetchEvents}>
          Tap to retry
        </Text>
      </LinearGradient>
    );
  }

  if (events.length === 0) {
    return (
      <LinearGradient
        colors={['#A1C4FD', '#C2E9FB']}
        style={styles.centerContainer}
      >
        <Text style={styles.emptyText}>No Reflections yet</Text>
        <Text style={styles.emptySubtext}>Reflections from companions will appear here</Text>
      </LinearGradient>
    );
  }

  return (
    <ReflectedWatchView
      visible={!!selectedEvent}
      selectedEvent={selectedEvent}
      events={events}
      eventMetadata={eventMetadata}
      onClose={closeFullScreen}
      onEventSelect={handleEventPress}
      onDelete={deleteEvent}
      onCaptureSelfie={captureSelfieResponse}
      onMediaError={handleMediaError}
      cameraRef={cameraRef}
      cameraPermission={cameraPermission}
      requestCameraPermission={requestCameraPermission}
      isCapturingSelfie={isCapturingSelfie}
      pendingCount={pendingUpdates.length > 0 ? Math.max(0, pendingUpdates.length - events.length) + (pendingUpdates[0]?.event_id !== events[0]?.event_id ? 1 : 0) : 0}
      onFlushUpdates={onFlushUpdates}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
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
    color: '#2C3E50',
    backgroundColor: 'transparent',
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
});
