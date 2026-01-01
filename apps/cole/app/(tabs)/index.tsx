import { db } from '@/config/firebase';
import { FontAwesome } from '@expo/vector-icons';
import { API_ENDPOINTS, Event, EventMetadata, ListEventsResponse } from '@projectmirror/shared';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as FileSystem from 'expo-file-system/legacy';
import * as Speech from 'expo-speech';
import { collection, deleteDoc, doc, DocumentData, getDoc, onSnapshot, orderBy, query, QuerySnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Modal, PanResponder, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';

export default function ColeInboxScreen() {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);
  const [eventMetadata, setEventMetadata] = useState<{ [key: string]: EventMetadata }>({});
  const [showSelfieMirror, setShowSelfieMirror] = useState(false);
  const [isCapturingSelfie, setIsCapturingSelfie] = useState(false);
  const cameraRef = useRef<CameraView>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const { width } = useWindowDimensions();
  const hasSpokenRef = useRef(false); // Must be declared before any conditional returns
  const audioPlayer = useAudioPlayer(undefined);
  const audioStatus = useAudioPlayerStatus(audioPlayer);
  const shouldAutoPlayRef = useRef<{ eventId: string | null; url: string | null }>({ eventId: null, url: null });
  const engagementTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasEngagedRef = useRef<{ [eventId: string]: boolean }>({});
  const hasReplayedRef = useRef<{ [eventId: string]: boolean }>({});
  const audioFinishedRef = useRef<{ [eventId: string]: boolean }>({});
  const [playButtonPressed, setPlayButtonPressed] = useState(false);
  
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

  // Listen to audio player status to detect when audio finishes
  useEffect(() => {
    if (!audioStatus || !selectedEvent) return;
    
    if (audioStatus.isLoaded && audioStatus.didJustFinish && !audioStatus.playing) {
      // Show selfie mirror after audio finishes
      // Only show if we haven't already shown it for this event in this session
      if (!audioFinishedRef.current[selectedEvent.event_id]) {
        audioFinishedRef.current[selectedEvent.event_id] = true;
        setShowSelfieMirror(true);
      }
    }
  }, [audioStatus?.isLoaded, audioStatus?.didJustFinish, audioStatus?.playing, selectedEvent?.event_id, cameraPermission?.granted]);

  // Auto-play when audio loads (for initial selection and manual play)
  useEffect(() => {
    if (!audioStatus || !audioPlayer || !shouldAutoPlayRef.current.eventId) return;
    
    // If audio just loaded and we're waiting to auto-play
    if (audioStatus.isLoaded && !audioStatus.playing && shouldAutoPlayRef.current.eventId) {
      const waitingEventId = shouldAutoPlayRef.current.eventId;
      // Check if we're still on the same event
      if (currentEventIdRef.current === waitingEventId) {
        // Small delay to ensure everything is ready
        const playTimer = setTimeout(() => {
          if (currentEventIdRef.current === waitingEventId && audioStatus.isLoaded && !audioStatus.playing) {
            audioPlayer.play();
            shouldAutoPlayRef.current = { eventId: null, url: null };
          }
        }, 100);
        return () => clearTimeout(playTimer);
      } else {
        // Event changed, clear the flag
        shouldAutoPlayRef.current = { eventId: null, url: null };
      }
    }
  }, [audioStatus?.isLoaded, audioStatus?.playing, audioPlayer]);


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
      if (audioPlayer) {
        // Pause playback (source stays loaded, will be replaced when new audio loads)
        audioPlayer.pause();
      }
      // Reset hasSpokenRef and clear auto-play flag when switching photos
      hasSpokenRef.current = false;
      shouldAutoPlayRef.current = { eventId: null, url: null };
      // Hide selfie mirror when switching to a different reflection
      setShowSelfieMirror(false);
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
        // Hide selfie mirror when opening a new reflection (it will show after audio finishes)
        setShowSelfieMirror(false);
        // Reset audioFinishedRef for the new event so mirror can show after audio finishes
        if (selectedEvent.event_id) {
          audioFinishedRef.current[selectedEvent.event_id] = false;
        }
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
              if (audioPlayer) {
                audioPlayer.pause();
              }
              
              // Small delay to ensure old audio is stopped before starting new one
              await new Promise(resolve => setTimeout(resolve, 50));
              
              // Check again if we're still on the same photo
              if (currentEventIdRef.current !== eventIdForThisEffect) {
                return; // User switched photos, don't start audio
              }
              
              // Load and play the audio using the presigned GET URL from the Event
              if (audioPlayer && currentEventIdRef.current === eventIdForThisEffect) {
                audioPlayer.replace(selectedEvent.audio_url);
                // Set flag to auto-play when audio loads
                shouldAutoPlayRef.current = { eventId: eventIdForThisEffect, url: selectedEvent.audio_url };
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
            // Estimate TTS duration and show mirror (rough estimate: ~150 words per minute)
            const wordCount = selectedMetadata.description.split(/\s+/).length;
            const estimatedDuration = (wordCount / 150) * 60 * 1000; // Convert to milliseconds
            setTimeout(() => {
              if (selectedEvent?.event_id && currentEventIdRef.current === selectedEvent.event_id && !audioFinishedRef.current[selectedEvent.event_id]) {
                audioFinishedRef.current[selectedEvent.event_id] = true;
                setShowSelfieMirror(true);
              }
            }, Math.max(estimatedDuration, 2000)); // At least 2 seconds
          }
        }
      }, 100);

      return () => {
        clearTimeout(timer);
        Speech.stop();
        // Cleanup audio - pause playback
        if (audioPlayer) {
          audioPlayer.pause();
        }
      };
    } else {
      // Stop speech/audio if no description
      Speech.stop();
      if (audioPlayer) {
        audioPlayer.pause();
      }
    }
  }, [selectedEvent?.event_id, selectedEvent?.audio_url, selectedMetadata?.description, selectedMetadata?.content_type]);

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
    if (audioPlayer) {
      audioPlayer.pause();
    }
    setShowSelfieMirror(false);
    setSelectedEvent(null);
  }, [audioPlayer]);

  const navigateToPhoto = useCallback(async (direction: 'prev' | 'next') => {
    if (!selectedEvent) return;
    
    // Find current index
    const currentIndex = events.findIndex(e => e.event_id === selectedEvent.event_id);
    if (currentIndex === -1) return;
    
    // Stop any ongoing speech/audio IMMEDIATELY
    Speech.stop();
    
    // Pause audio
    if (audioPlayer) {
      audioPlayer.pause();
    }
    
    // Reset the hasSpokenRef to prevent new audio from starting too early
    hasSpokenRef.current = false;
    
    // Hide selfie mirror when navigating
    setShowSelfieMirror(false);
    
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
  const captureSelfieResponse = async () => {
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
      const imageResponse = await fetch(`${API_ENDPOINTS.GET_S3_URL}?path=from&event_id=${responseEventId}&filename=image.jpg`);
      const { url: imageUrl } = await imageResponse.json();

      // Upload image
      const imageBlob = await fetch(photo.uri).then(r => r.blob());
      const uploadResponse = await fetch(imageUrl, {
        method: 'PUT',
        body: imageBlob,
        headers: { 'Content-Type': 'image/jpeg' },
      });

      if (uploadResponse.status !== 200) {
        throw new Error(`Image upload failed: ${uploadResponse.status}`);
      }

      // Cleanup local file
      try {
        await FileSystem.deleteAsync(photo.uri, { idempotent: true });
      } catch (cleanupError) {
        console.warn("Failed to delete local file:", cleanupError);
      }

      // Hide mirror and show success immediately (don't wait for Firestore)
      setShowSelfieMirror(false);
      Alert.alert("Success!", "Your selfie response has been sent!");

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
      Alert.alert("Error", errorMessage);
    } finally {
      setIsCapturingSelfie(false);
    }
  };

  const playDescription = async () => {
    const metadata = selectedEvent ? eventMetadata[selectedEvent.event_id] : null;
    if (!metadata || !selectedEvent) return;
    
    // If audio is currently playing, pause it
    if (audioStatus?.playing) {
      if (audioPlayer) {
        audioPlayer.pause();
      }
      Speech.stop();
      return;
    }
    
    // Track replay if this is a manual play after auto-play
    const eventId = selectedEvent.event_id;
    // Send replay signal if:
    // 1. hasSpokenRef is true (meaning audio was auto-played or manually played before)
    // 2. AND we haven't already sent a replay signal for this event
    if (hasSpokenRef.current && eventId && !hasReplayedRef.current[eventId]) {
      sendReplaySignal(eventId);
    }
    
    // Refresh URLs before playing to ensure they're not expired
    const refreshedEvent = await refreshEventUrls(selectedEvent.event_id);
    const eventToUse = refreshedEvent || selectedEvent;
    
    // Stop any ongoing speech/audio first
    Speech.stop();
    if (audioPlayer) {
      audioPlayer.pause();
    }
    
    // Check if we have audio_url from Event (presigned GET URL) and content_type is 'audio'
    // Use eventToUse.audio_url (from ListMirrorEvents) not metadata.audio_url (from metadata.json)
    if (eventToUse.audio_url && metadata.content_type === 'audio') {
      // Play audio file
      try {
        if (audioPlayer && selectedEvent) {
          audioPlayer.replace(eventToUse.audio_url);
          // Set flag to auto-play when audio loads
          shouldAutoPlayRef.current = { eventId: selectedEvent.event_id, url: eventToUse.audio_url };
          
          // Update selectedEvent with fresh URLs
          if (refreshedEvent) {
            setSelectedEvent(refreshedEvent);
          }
        }
      } catch (error) {
        console.error("Error playing audio:", error);
        Alert.alert("Error", "Failed to play audio Reflection");
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
      "Delete Reflection",
      "Are you sure you want to delete this Reflection?",
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

              // 3. Stop any ongoing speech/audio
              Speech.stop();
              if (audioPlayer) {
                audioPlayer.pause();
              }
              
              // 4. Remove from local state and refresh
              setEvents(events.filter(e => e.event_id !== event.event_id));
              setSelectedEvent(null);
              
              // 5. Refresh the list to ensure consistency
              fetchEvents();
              
              Alert.alert("Success", "Reflection deleted successfully");
            } catch (error: any) {
              console.error("Delete error:", error);
              Alert.alert("Delete Failed", error.message || "Failed to delete Reflection");
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
        <Text style={styles.loadingText}>Loading Reflections...</Text>
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
        <Text style={styles.emptyText}>No Reflections yet</Text>
        <Text style={styles.emptySubtext}>Reflections from companions will appear here</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{selectedEvent ? 'Reflection' : 'Reflections'}</Text>
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
              {/* Reflection header */}
              {selectedMetadata && (
                <Text style={styles.reflectionHeader}>
                  Reflection from {selectedMetadata.sender}
                </Text>
              )}
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
            
            {/* Selfie Mirror - appears after audio finishes */}
            {showSelfieMirror && (
              <View style={styles.selfieMirrorContainer}>
                {cameraPermission?.granted ? (
                  <>
                    <CameraView
                      ref={cameraRef}
                      style={styles.selfieMirror}
                      facing="front"
                    />
                    <TouchableOpacity
                      style={styles.selfieMirrorButton}
                      onPress={captureSelfieResponse}
                      disabled={isCapturingSelfie}
                      activeOpacity={0.8}
                    >
                      {isCapturingSelfie ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <View style={styles.selfieMirrorInner} />
                      )}
                    </TouchableOpacity>
                  </>
                ) : (
                  <TouchableOpacity
                    style={[styles.selfieMirrorButton, { backgroundColor: 'rgba(0, 0, 0, 0.7)' }]}
                    onPress={async () => {
                      const result = await requestCameraPermission();
                      if (!result.granted) {
                        Alert.alert("Camera Permission", "Camera permission is required to take a selfie response.");
                      }
                    }}
                    activeOpacity={0.8}
                  >
                    <FontAwesome name="camera" size={32} color="#fff" />
                    <Text style={{ color: '#fff', fontSize: 12, marginTop: 8, textAlign: 'center' }}>Tap to enable</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
            
            {selectedMetadata && (selectedMetadata.description || selectedEvent?.audio_url) && (
              <View style={styles.descriptionContainer}>
                <View style={styles.descriptionHeader}>
                  {selectedMetadata.content_type === 'audio' ? (
                    <Text style={styles.descriptionText}>
                      🎤 Voice message
                    </Text>
                  ) : (
                    <Text style={styles.descriptionText}>
                      {selectedMetadata.description}
                    </Text>
                  )}
                  <View style={styles.buttonRow}>
                    <TouchableOpacity 
                      style={[
                        styles.playButton, 
                        (audioStatus && audioStatus.playing) ? styles.playButtonPlaying : null,
                        playButtonPressed && (!audioStatus || !audioStatus.playing) ? styles.playButtonPressed : null
                      ]}
                      onPress={playDescription}
                      onPressIn={() => setPlayButtonPressed(true)}
                      onPressOut={() => setPlayButtonPressed(false)}
                      activeOpacity={0.7}
                    >
                      <FontAwesome 
                        name={audioStatus?.playing ? "stop" : "play"} 
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
    left: 20,
    right: 20,
    zIndex: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  reflectionHeader: {
    color: '#fff',
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
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'rgba(46, 120, 183, 0.9)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  playButtonPlaying: {
    backgroundColor: 'rgba(46, 120, 183, 1)',
  },
  playButtonPressed: {
    backgroundColor: 'rgba(46, 120, 183, 0.6)',
    transform: [{ scale: 0.95 }],
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
    flex: 1,
    fontSize: 24,
    fontWeight: '600',
    lineHeight: 32,
  },
  selfieMirrorContainer: {
    position: 'absolute',
    top: 100,
    right: 20,
    width: 120,
    height: 120,
    borderRadius: 60,
    overflow: 'hidden',
    borderWidth: 3,
    borderColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.8,
    shadowRadius: 4,
    elevation: 5,
  },
  selfieMirror: {
    width: '100%',
    height: '100%',
  },
  selfieMirrorButton: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    borderRadius: 60,
  },
  selfieMirrorInner: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 3,
    borderColor: '#fff',
    backgroundColor: 'transparent',
  },
});
