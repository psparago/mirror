import { db } from '@/config/firebase';
import { FontAwesome } from '@expo/vector-icons';
import { API_ENDPOINTS, Event, EventMetadata, ListEventsResponse } from '@projectmirror/shared';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { Audio } from 'expo-av';
import { BlurView } from 'expo-blur';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as FileSystem from 'expo-file-system';
import { LinearGradient } from 'expo-linear-gradient';
import * as Speech from 'expo-speech';
import { collection, doc, DocumentData, getDoc, onSnapshot, orderBy, query, QuerySnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, FlatList, Image, Modal, PanResponder, Platform, StatusBar, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const insets = useSafeAreaInsets();
  const hasSpokenRef = useRef(false); // Must be declared before any conditional returns
  const audioPlayer = useAudioPlayer(undefined);
  const audioStatus = useAudioPlayerStatus(audioPlayer);
  const shouldAutoPlayRef = useRef<{ eventId: string | null; url: string | null }>({ eventId: null, url: null });
  const engagementTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasEngagedRef = useRef<{ [eventId: string]: boolean }>({});
  const hasReplayedRef = useRef<{ [eventId: string]: boolean }>({});
  const audioFinishedRef = useRef<{ [eventId: string]: boolean }>({});
  const [playButtonPressed, setPlayButtonPressed] = useState(false);
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);
  const [isPlayingDeepDive, setIsPlayingDeepDive] = useState(false);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseAnimRef = useRef<Animated.CompositeAnimation | null>(null);
  
  // Responsive column count: 2 for iPhone, 4-5 for iPad
  const numColumns = width >= 768 ? (width >= 1024 ? 5 : 4) : 2;

  // Sanitize text for smoother TTS playback
  const sanitizeTextForTTS = (text: string): string => {
    return text
      .replace(/!/g, '.') // Replace exclamation marks with periods
      .replace(/\?/g, '.') // Replace question marks with periods
      .replace(/;/g, ',') // Replace semicolons with commas
      .replace(/:/g, ',') // Replace colons with commas
      .replace(/\.\.\./g, '.') // Replace ellipsis with single period
      .replace(/\.{2,}/g, '.') // Replace multiple periods with single period
      .replace(/,{2,}/g, ',') // Replace multiple commas with single comma
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
  };

  // Configure audio session to prevent ducking and warm up TTS
  useEffect(() => {
    const configureAudio = async () => {
      try {
        await Audio.setAudioModeAsync({
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
          shouldDuckAndroid: false,
          playThroughEarpieceAndroid: false,
        });
        
        // Warm up the TTS engine by speaking a silent, very short phrase
        // This initializes the audio session properly
        setTimeout(() => {
          Speech.speak(' ', {
            volume: 0.0,
            rate: 1.0,
            pitch: 1.0,
          });
        }, 500);
      } catch (error) {
        console.error('Error configuring audio session:', error);
      }
    };
    
    configureAudio();
  }, []);

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
                Speech.speak(sanitizeTextForTTS(selectedMetadata.description), {
                  pitch: 1.0,
                  rate: 1.0,
                  language: 'en-US',
                });
              }
            }
          } else if ((selectedMetadata.short_caption || selectedMetadata.description) && currentEventIdRef.current === eventIdForThisEffect) {
            // Use TTS for text descriptions - prefer short_caption for initial play
            const textToSpeak = selectedMetadata.short_caption || selectedMetadata.description;
            Speech.speak(sanitizeTextForTTS(textToSpeak), {
              pitch: 1.0,
              rate: 1.0,
              language: 'en-US',
            });
            // Estimate TTS duration and show mirror (rough estimate: ~150 words per minute)
            const wordCount = textToSpeak.split(/\s+/).length;
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

  // Animate the Tell Me More button when deep dive is playing
  useEffect(() => {
    if (isPlayingDeepDive) {
      // Start the pulse animation immediately
      pulseAnimRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.15,  // More noticeable scale
            duration: 600,  // Faster pulse
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 600,
            useNativeDriver: true,
          }),
        ])
      );
      pulseAnimRef.current.start();
    } else {
      // Stop the animation and reset
      if (pulseAnimRef.current) {
        pulseAnimRef.current.stop();
      }
      pulseAnim.setValue(1);
    }

    return () => {
      if (pulseAnimRef.current) {
        pulseAnimRef.current.stop();
      }
    };
  }, [isPlayingDeepDive]);

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
    setImageDimensions(null); // Reset dimensions for new image
    
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
    
    // Get image dimensions to size container correctly
    if (item.image_url) {
      Image.getSize(
        item.image_url,
        (imgWidth, imgHeight) => {
          setImageDimensions({ width: imgWidth, height: imgHeight });
        },
        (error) => {
          console.warn("Failed to get image dimensions:", error);
        }
      );
    }
    
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
        // Update dimensions if URL changed
        if (refreshedEvent.image_url && refreshedEvent.image_url !== item.image_url) {
          Image.getSize(
            refreshedEvent.image_url,
            (imgWidth, imgHeight) => {
              setImageDimensions({ width: imgWidth, height: imgHeight });
            },
            (error) => {
              console.warn("Failed to get image dimensions:", error);
            }
          );
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
      } catch (error: any) {
        console.error("Error getting presigned URL:", error);
        throw new Error(`Failed to get upload URL: ${error.message || 'Network request failed'}`);
      }

      // Upload image
      try {
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
        console.error("Error uploading image:", error);
        throw new Error(`Failed to upload image: ${error.message || 'Network request failed'}`);
      }

      // Cleanup local file
      try {
        await FileSystem.deleteAsync(photo.uri, { idempotent: true });
      } catch (cleanupError) {
        console.warn("Failed to delete local file:", cleanupError);
      }

      // Hide mirror and show success immediately (don't wait for Firestore)
      setShowSelfieMirror(false);
      
      // Speak confirmation message
      const metadata = selectedEvent ? eventMetadata[selectedEvent.event_id] : null;
      const companionName = metadata?.sender || 'your companion';
      Speech.speak(`I sent a selfie to ${companionName}`, {
        pitch: 1.0,
        rate: 1.0,
        language: 'en-US',
      });
      
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
      // Add small delay after Speech.stop() to let audio session settle
      await new Promise(resolve => setTimeout(resolve, 100));
      Speech.speak(sanitizeTextForTTS(metadata.description), {
        pitch: 1.0,
        rate: 1.0,
        language: 'en-US',
      });
    }
  };

  const playDeepDive = async () => {
    const metadata = selectedEvent ? eventMetadata[selectedEvent.event_id] : null;
    if (!metadata || !selectedEvent || !metadata.deep_dive) return;
    
    // Stop any current audio/speech
    Speech.stop();
    if (audioPlayer) {
      audioPlayer.pause();
    }
    
    setIsPlayingDeepDive(true);
    
    // Add small delay after Speech.stop() to let audio session settle
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Play deep_dive via TTS
    Speech.speak(sanitizeTextForTTS(metadata.deep_dive), {
      pitch: 1.0,
      rate: 1.0,
      language: 'en-US',
      onDone: () => {
        setIsPlayingDeepDive(false);
      },
      onStopped: () => {
        setIsPlayingDeepDive(false);
      },
    });
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
    <LinearGradient
      colors={['#A1C4FD', '#C2E9FB']}
      style={styles.container}
    >
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
          <LinearGradient
            colors={['#A1C4FD', '#C2E9FB']}
            style={styles.fullScreenContainer}
            {...swipeResponder.panHandlers}
          >
            <StatusBar barStyle="dark-content" />
            
            {/* Top Layer: Header and controls */}
            <View style={[styles.topButtonContainer, { top: insets.top + 10 }]}>
              {/* Reflection header */}
              <Text style={styles.reflectionHeader}>
                {selectedMetadata?.sender ? `Reflection from ${selectedMetadata.sender}` : 'Reflection'}
              </Text>
              {/* Close button */}
              <TouchableOpacity
                style={styles.deleteButton}
                onPress={closeFullScreen}
                activeOpacity={0.7}
              >
                <FontAwesome name="times" size={20} color="#fff" />
              </TouchableOpacity>
            </View>

            {/* Base Layer: Image with glass border */}
            <View style={[styles.imageFrameContainer, { 
              top: insets.top + 100,
              bottom: isLandscape ? 180 + Math.max(insets.bottom, 24) : 200 + Math.max(insets.bottom, 24),
              ...(imageDimensions ? (() => {
                const availableHeight = height - (insets.top + 100) - (isLandscape ? 180 + Math.max(insets.bottom, 24) : 200 + Math.max(insets.bottom, 24));
                const aspectRatio = imageDimensions.width / imageDimensions.height;
                const maxWidth = isLandscape ? width * 0.7 : width * 0.9;
                const maxHeight = isLandscape ? height * 0.6 : height * 0.5;
                
                // Calculate dimensions that fit within maxWidth and maxHeight while maintaining aspect ratio
                const widthFromHeight = availableHeight * aspectRatio;
                const heightFromWidth = maxWidth / aspectRatio;
                
                let finalWidth = maxWidth;
                let finalHeight = heightFromWidth;
                
                if (heightFromWidth > availableHeight) {
                  finalWidth = widthFromHeight;
                  finalHeight = availableHeight;
                }
                
                return {
                  width: Math.min(finalWidth, maxWidth),
                  height: Math.min(finalHeight, maxHeight),
                };
              })() : {
                width: isLandscape ? width * 0.7 : width * 0.9,
                maxHeight: isLandscape ? height * 0.6 : height * 0.5,
              }),
              alignSelf: 'center',
            }]}>
              <Image
                source={{ uri: selectedEvent.image_url }}
                style={styles.fullScreenImage}
                resizeMode="cover"
              />
            </View>

            {/* Top Layer: Selfie Mirror - appears after audio finishes */}
            {showSelfieMirror && (
              <TouchableOpacity 
                onPress={() => {
                  captureSelfieResponse();
                }}
                disabled={isCapturingSelfie}
                activeOpacity={0.9}
                style={[styles.selfieMirrorContainer, { 
                ...(imageDimensions ? (() => {
                  const availableHeight = height - (insets.top + 100) - (isLandscape ? 180 + Math.max(insets.bottom, 24) : 200 + Math.max(insets.bottom, 24));
                  const aspectRatio = imageDimensions.width / imageDimensions.height;
                  const maxWidth = isLandscape ? width * 0.7 : width * 0.9;
                  const maxHeight = isLandscape ? height * 0.6 : height * 0.5;
                  
                  const widthFromHeight = availableHeight * aspectRatio;
                  const heightFromWidth = maxWidth / aspectRatio;
                  
                  let finalWidth = maxWidth;
                  let finalHeight = heightFromWidth;
                  
                  if (heightFromWidth > availableHeight) {
                    finalWidth = widthFromHeight;
                    finalHeight = availableHeight;
                  }
                  
                  const imageWidth = Math.min(finalWidth, maxWidth);
                  const imageLeft = (width - imageWidth) / 2; // Center the image
                  const imageRight = imageLeft + imageWidth;
                  const imageTop = insets.top + 100;
                  
                  if (isLandscape) {
                    // Align with delete button: delete button is in topButtonContainer which is 90% width, centered
                    // Delete button is at the right edge of that container, which is at right: 5% of screen width
                    const deleteButtonRight = width * 0.05; // 5% from right edge (since container is 90% width, centered)
                    const selfieSize = 120;
                    
                    return {
                      top: imageTop + 20, // Align with top of image with spacing
                      right: deleteButtonRight, // Align with delete button
                      zIndex: 10
                    };
                  } else {
                    // Portrait: reduce top spacing, increase right spacing
                    return {
                      top: insets.top + 100 + 10, // Reduced spacing from top
                      right: 60, // Increased spacing from right edge
                      zIndex: 10
                    };
                  }
                })() : {
                  top: insets.top + 100 + 10,
                  right: isLandscape ? width * 0.05 : 60,
                  zIndex: 10
                })
              }]}>
                {cameraPermission?.granted ? (
                  <>
                    <View style={styles.selfieMirrorWrapper} pointerEvents="none">
                      <CameraView
                        ref={cameraRef}
                        style={styles.selfieMirror}
                        facing="front"
                      />
                    </View>
                    <View style={styles.cameraShutterButton}>
                      {isCapturingSelfie ? (
                        <ActivityIndicator size="small" color="#2C3E50" />
                      ) : (
                        <FontAwesome name="camera" size={20} color="#2C3E50" />
                      )}
                    </View>
                  </>
                ) : (
                  <TouchableOpacity
                    style={styles.selfieMirrorPermissionButton}
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
              </TouchableOpacity>
            )}

            {/* Middle Layer: Floating Info Panel */}
            <View style={[styles.descriptionContainer, { bottom: insets.bottom + 20, paddingBottom: Math.max(insets.bottom, 24) }]}>
              <View style={styles.descriptionHeader}>
                {selectedMetadata?.content_type === 'audio' || selectedEvent?.audio_url ? (
                  <Text style={styles.descriptionText}>
                    🎤 Voice message
                  </Text>
                ) : selectedMetadata?.description ? (
                  <Text style={styles.descriptionText}>
                    {selectedMetadata.description}
                  </Text>
                ) : (
                  <Text style={styles.descriptionText}>
                    Reflection
                  </Text>
                )}
                <View style={styles.buttonRow}>
                  {(selectedEvent?.audio_url || selectedMetadata?.description) && (
                    <TouchableOpacity 
                      style={[
                        styles.playButton, 
                        (audioStatus && audioStatus.playing) ? styles.playButtonPlaying : null,
                        playButtonPressed && (!audioStatus || !audioStatus.playing) ? styles.playButtonPressed : null
                      ]}
                      onPress={playDescription}
                      onPressIn={() => setPlayButtonPressed(true)}
                      onPressOut={() => setPlayButtonPressed(false)}
                      activeOpacity={0.8}
                    >
                      <FontAwesome 
                        name={audioStatus?.playing ? "stop" : "play"} 
                        size={28} 
                        color={audioStatus?.playing ? "#fff" : "#d32f2f"} 
                      />
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity 
                    style={styles.closeButtonInline}
                    onPress={() => selectedEvent && deleteEvent(selectedEvent)}
                    activeOpacity={0.8}
                  >
                    <FontAwesome name="trash" size={20} color="#fff" />
                  </TouchableOpacity>
                </View>
              </View>
            </View>

            {/* Top Layer: Tell Me More floating action button */}
            {selectedMetadata?.deep_dive && (
              <Animated.View
                style={[
                  styles.tellMeMoreButton, 
                  { 
                    bottom: insets.bottom + 20 + 120 + 20, // 20px above the bottom info bar
                    right: 20,
                    transform: [{ scale: pulseAnim }],
                  }
                ]}
              >
                <TouchableOpacity
                  style={{ width: '100%', height: '100%' }}
                  onPress={playDeepDive}
                  activeOpacity={0.8}
                  disabled={isPlayingDeepDive}
                >
                  <BlurView intensity={50} style={styles.tellMeMoreBlur}>
                    <Text style={styles.tellMeMoreIcon}>✨</Text>
                  </BlurView>
                </TouchableOpacity>
              </Animated.View>
            )}
          </LinearGradient>
        )}
      </Modal>
    </LinearGradient>
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
  playButtonPlaying: {
    opacity: 0.9,
  },
  playButtonPressed: {
    transform: [{ scale: 0.95 }],
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
