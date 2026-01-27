import MainStageView from '@/components/MainStageView';
import { FontAwesome } from '@expo/vector-icons';
import { API_ENDPOINTS, Event, EventMetadata, ExplorerIdentity, ListEventsResponse } from '@projectmirror/shared';
import { db } from '@projectmirror/shared/firebase';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio } from 'expo-av';
import { BlurView } from 'expo-blur';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as FileSystem from 'expo-file-system';
import { Image } from 'expo-image';
import * as ImageManipulator from 'expo-image-manipulator';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import * as Speech from 'expo-speech';
import { collection, disableNetwork, doc, DocumentData, enableNetwork, getDoc, increment, limit, onSnapshot, orderBy, query, QuerySnapshot, serverTimestamp, setDoc, where, writeBatch } from 'firebase/firestore';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, AppStateStatus, FlatList, InteractionManager, PanResponder, Platform, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';


import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function ColeInboxScreen() {
  const router = useRouter();

  const [events, setEvents] = useState<Event[]>([]);
  const [recentlyArrivedIds, setRecentlyArrivedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);
  const [eventMetadata, setEventMetadata] = useState<{ [key: string]: EventMetadata }>({});
  const [isCapturingSelfie, setIsCapturingSelfie] = useState(false);
  const selfieUploadInFlightRef = useRef(false);

  const SELFIE_QUEUE_KEY = 'selfie_upload_queue';
  const cameraRef = useRef<CameraView>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const insets = useSafeAreaInsets();
  const engagementTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasEngagedRef = useRef<{ [eventId: string]: boolean }>({});
  const hasReplayedRef = useRef<{ [eventId: string]: boolean }>({});
  const refreshingEventsRef = useRef<Set<string>>(new Set()); // Track events currently being refreshed
  const [readEventIds, setReadEventIds] = useState<string[]>([]);
  const readEventIdsRef = useRef<string[]>([]);
  const [isReadStateLoaded, setIsReadStateLoaded] = useState(false);

  // Responsive column count: 2 for iPhone, 4-5 for iPad
  const numColumns = width >= 768 ? (width >= 1024 ? 5 : 4) : 2;

  // Explorer config with state for toggleable settings
  const [enableInfiniteScroll, setEnableInfiniteScroll] = useState(true);
  const [instantVideoPlayback, setInstantVideoPlayback] = useState(true);
  const [readVideoCaptions, setReadVideoCaptions] = useState(false);

  // Load settings from storage
  useEffect(() => {
    AsyncStorage.getItem('enableInfiniteScroll').then(value => {
      if (value !== null) {
        setEnableInfiniteScroll(value === 'true');
      }
    }).catch(err => console.warn('Failed to load infinite scroll setting:', err));

    AsyncStorage.getItem('instantVideoPlayback').then(value => {
      if (value !== null) {
        setInstantVideoPlayback(value === 'true');
      }
    }).catch(err => console.warn('Failed to load instant video setting:', err));

    AsyncStorage.getItem('readVideoCaptions').then(value => {
      if (value !== null) {
        setReadVideoCaptions(value === 'true');
      }
    }).catch(err => console.warn('Failed to load read video captions setting:', err));
  }, []);

  // Memoize config to prevent unnecessary re-renders
  const EXPLORER_CONFIG = useMemo(() => ({
    playVideoCaptions: false,
    autoplay: true,
    loopFeed: true,
    showStartMarker: true,
    enableInfiniteScroll,
    instantVideoPlayback,
    readVideoCaptions,
  }), [enableInfiniteScroll, instantVideoPlayback, readVideoCaptions]);



  // Play chime sound for new arrivals
  const playArrivalChime = async () => {
    try {
      // Using a local chime asset for reliable playback
      const { sound } = await Audio.Sound.createAsync(
        require('../../assets/sounds/chime.mp3'),
        { shouldPlay: true, volume: 0.7 }
      );
      // Clean up after playing
      sound.setOnPlaybackStatusUpdate((status: any) => {
        if (status.isLoaded && status.didJustFinish) {
          sound.unloadAsync();
        }
      });
      console.log('🔔 Played arrival chime');
    } catch (error) {
      console.warn('Could not play arrival chime:', error);
    }
  };

  // Fetch events and listen for Firestore updates
  // Fetch events and listen for Firestore updates - Moved below to fix closure staleness

  // Process selfie upload queue (defined before useEffects that use it)
  const processSelfieQueue = useCallback(async () => {
    if (selfieUploadInFlightRef.current) return;
    selfieUploadInFlightRef.current = true;
    try {
      console.log('[Queue] Phase: Process start');
      while (true) {
        const raw = await AsyncStorage.getItem(SELFIE_QUEUE_KEY);
        const queue = raw ? JSON.parse(raw) : [];
        if (!queue.length) {
          console.log('[Queue] Phase: Process complete (queue empty)');
          break;
        }

        const job = queue[0];
        const jobStartTime = Date.now();
        console.log(`[Queue] Processing job for event ${job.originalEventId}`);
        try {
          const fileInfo = await FileSystem.getInfoAsync(job.localUri);
          if (!fileInfo.exists) {
            console.warn('Selfie upload file missing, dropping job:', job.localUri);
            queue.shift();
            await AsyncStorage.setItem(SELFIE_QUEUE_KEY, JSON.stringify(queue));
            continue;
          }

          // Phase: Upload
          const uploadStartTime = Date.now();
          console.log('[Queue] Phase: Upload to S3 (starting)');
          
          // Get presigned URL for upload
          const presignedUrlStartTime = Date.now();
          const fetchWithRetry = async (retryCount = 0): Promise<Response> => {
            try {
              const res = await fetch(`${API_ENDPOINTS.GET_S3_URL}?path=from&event_id=${job.responseEventId}&filename=image.jpg&explorer_id=${ExplorerIdentity.currentExplorerId}`);
              if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
              return res;
            } catch (e: any) {
              if (retryCount < 1) {
                await new Promise(r => setTimeout(r, 1500));
                return fetchWithRetry(retryCount + 1);
              }
              throw e;
            }
          };

          const imageResponse = await fetchWithRetry();
          const imageData = await imageResponse.json();
          const imageUrl = imageData.url;
          const presignedUrlTime = Date.now() - presignedUrlStartTime;
          console.log(`[Queue] Presigned URL obtained in ${presignedUrlTime}ms`);

          const s3UploadStartTime = Date.now();
          // Yield to main thread before large upload to prevent UI blocking
          await new Promise(resolve => InteractionManager.runAfterInteractions(() => {
            // Small additional delay to ensure UI is responsive
            setTimeout(resolve, 50);
          }));
          
          const uploadResult = await FileSystem.uploadAsync(imageUrl, job.localUri, {
            httpMethod: 'PUT',
            headers: { 'Content-Type': 'image/jpeg' },
          });
          const s3UploadTime = Date.now() - s3UploadStartTime;
          console.log(`[Queue] S3 upload completed in ${s3UploadTime}ms`);

          if (uploadResult.status !== 200) {
            throw new Error(`Selfie upload failed: ${uploadResult.status}`);
          }
          
          const totalUploadTime = Date.now() - uploadStartTime;
          console.log(`[Queue] Total upload phase: ${totalUploadTime}ms`);

          // Phase: Firestore commit
          console.log('[Queue] Phase: Firestore commit (atomic batch)');
          // Atomic Firestore update: response + reflection status in one batch
          const batch = writeBatch(db);
          const responseRef = doc(db, ExplorerIdentity.collections.responses, job.originalEventId);
          const reflectionRef = doc(db, ExplorerIdentity.collections.reflections, job.originalEventId);

          batch.set(responseRef, {
            explorerId: job.senderExplorerId,
            viewerExplorerId: job.viewerExplorerId,
            event_id: job.originalEventId,
            response_event_id: job.responseEventId,
            timestamp: serverTimestamp(),
            type: 'selfie_response',
          });

          batch.set(reflectionRef, {
            status: 'responded',
            responded_at: serverTimestamp(),
          }, { merge: true });

          await batch.commit();

          // Cleanup local file (after commit to preserve file for retry if commit fails)
          try {
            await FileSystem.deleteAsync(job.localUri, { idempotent: true });
          } catch (cleanupError) {
            console.warn("Failed to delete selfie upload file:", cleanupError);
          } finally {
            console.log(`[Queue] Selfie upload file deleted for event ${job.originalEventId}`);
          }
          
          const totalJobTime = Date.now() - jobStartTime;
          console.log(`[Queue] Job complete for event ${job.originalEventId} (total: ${totalJobTime}ms)`);

          queue.shift();
          await AsyncStorage.setItem(SELFIE_QUEUE_KEY, JSON.stringify(queue));
        } catch (uploadError) {
          console.error('Selfie upload failed (will retry later):', uploadError);
          break;
        }
      }
    } finally {
      selfieUploadInFlightRef.current = false;
    }
  }, []);

  // Auto-refresh events when app comes back to foreground (handles expired URLs and reconnection)
  useEffect(() => {
    const subscription = AppState.addEventListener('change', async (nextAppState: AppStateStatus) => {
      console.log(`📱 AppState changed to: ${nextAppState}`);

      if (nextAppState === 'active') {
        console.log('🔄 App came to foreground - resuming network and refreshing data');
        processSelfieQueue();
        try {
          // 1. Resume Firestore
          await enableNetwork(db);
          console.log('✅ Firestore network resumed');
        } catch (e) {
          console.warn('Error resuming Firestore network:', e);
        }

        // 2. Refresh the overall list
        if (fetchEventsRef.current) {
          fetchEventsRef.current();
        }

        // 3. CRITICAL: Refresh the currently selected event's URLs
        // (URLs likely expired if app was backgrounded for ~1 hour)
        if (selectedEventRef.current) {
          const eventId = selectedEventRef.current.event_id;
          console.log(`🔄 Auto-refreshing URLs for currently selected event: ${eventId}`);

          // Wait 1 second for app to stabilize before re-triggering playback
          await new Promise(resolve => setTimeout(resolve, 1000));

          refreshEventUrlsRef.current(eventId).then(refreshed => {
            if (refreshed) {
              console.log(`✅ Successfully refreshed URLs for ${eventId}`);
              // Use a slight hack to force a re-trigger if it's the same object/content
              // by setting to null then back, but better to just set it and ensure MainStage handles it.
              setSelectedEvent(null);
              setTimeout(() => {
                setSelectedEvent(refreshed);
              }, 50);
            }
          }).catch(err => {
            console.warn(`❌ Failed to auto-refresh current event ${eventId}:`, err);
          });
        }
      } else if (nextAppState === 'background' || nextAppState === 'inactive') {
        try {
          await disableNetwork(db);
          console.log(`⏸️ Firestore network paused (${nextAppState})`);
        } catch (e) {
          console.warn('Error pausing Firestore network:', e);
        }
      }
    });

    return () => {
      subscription.remove();
    };
  }, [processSelfieQueue]);

  // Request permissions and configure audio on startup
  useEffect(() => {
    console.log('📸 Triggering permission check and audio setup on startup...');

    // 1. Audio Mode setup
    Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true, // Crucial for iPad usage
      shouldDuckAndroid: true,
      staysActiveInBackground: true,
      playThroughEarpieceAndroid: false,
    }).catch(err => console.warn('Audio.setAudioModeAsync failed:', err));

    // 2. Camera Permission
    requestCameraPermission().then(result => {
      if (result.granted) {
        console.log('✅ Camera permission granted');
      } else {
        console.log('❌ Camera permission denied');
      }
    }).catch(err => console.warn('Camera permission request failed:', err));
  }, []);


  // Load read state from disk on startup
  useEffect(() => {
    const loadReadState = async () => {
      try {
        const storedIds = await AsyncStorage.getItem('read_events');
        if (storedIds) {
          const parsed = JSON.parse(storedIds);
          setReadEventIds(parsed);
          readEventIdsRef.current = parsed;
        }
        setIsReadStateLoaded(true);
      } catch (error) {
        console.error('Failed to load read state:', error);
      }
    };

    loadReadState();
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

  // Auto-mark as read when an event is opened
  useEffect(() => {
    if (selectedEvent && isReadStateLoaded) {
      console.log(`👁️ Auto-marking as read: ${selectedEvent.event_id} (readStateLoaded=${isReadStateLoaded})`);
      markEventAsRead(selectedEvent.event_id);
    }
  }, [selectedEvent, isReadStateLoaded]);

  const fetchEvents = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch(`${API_ENDPOINTS.LIST_MIRROR_EVENTS}?explorer_id=${ExplorerIdentity.currentExplorerId}`);

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

      const now = Date.now();
      const eventsWithTimestamp = sortedEvents.map(e => ({ ...e, refreshedAt: now }));

      // Just update immediately, the centering logic in MainStageView will handle the focus stability
      setEvents(eventsWithTimestamp);

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
  }, []);

  // Keep ref to latest fetchEvents to avoid dependency cycles
  const fetchEventsRef = useRef(fetchEvents);
  // Refs for stable access inside the listener
  const eventsRef = useRef(events);
  const selectedEventRef = useRef(selectedEvent);

  useEffect(() => {
    fetchEventsRef.current = fetchEvents;
    eventsRef.current = events;
    selectedEventRef.current = selectedEvent;
  }, [events, selectedEvent, fetchEvents]);

  // STABLE Firestore Listener
  useEffect(() => {
    console.log('🔌 Firestore listener attached');
    
    // Initial fetch
    fetchEventsRef.current();

    // 1. Set up Firestore listener (The "Doorbell")
    const reflectionsRef = collection(db, ExplorerIdentity.collections.reflections);
    const q = query(
      reflectionsRef,
      where('explorerId', '==', ExplorerIdentity.currentExplorerId),
      orderBy('timestamp', 'desc'),
      limit(10)
    );
    let isInitialLoad = true;

    const unsubscribe = onSnapshot(
      q,
      async (snapshot: QuerySnapshot<DocumentData>) => {
        // Skip initial load to prevent double-fetching on mount
        if (isInitialLoad) {
          isInitialLoad = false;
          return;
        }

        // 2. Check for NEW reflections
        const newReflectionIds: string[] = [];
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'added') {
            newReflectionIds.push(change.doc.id);
          }
        });

        if (newReflectionIds.length === 0) return;

        console.log(`🔔 Reflections received for: ${newReflectionIds.join(', ')}`);


        // 3. FETCH & SIGN (The "Mailbox Walk")
        try {
          const response = await fetch(`${API_ENDPOINTS.LIST_MIRROR_EVENTS}?explorer_id=${ExplorerIdentity.currentExplorerId}`);
          if (!response.ok) throw new Error('Failed to fetch fresh events');

          const data: ListEventsResponse = await response.json();
          const freshEvents = data.events || [];

          // 4. IMMEDIATE INJECTION LOGIC
          const currentIds = new Set(eventsRef.current.map(e => e.event_id));
          const newItems = freshEvents.filter(e => !currentIds.has(e.event_id));

          if (newItems.length > 0) {
            console.log(`✨ Injecting ${newItems.length} new items immediately`);

            const now = Date.now();
            const signedNewItems = newItems.map(e => ({ ...e, refreshedAt: now }));

            // 5. PRE-FETCH METADATA for New Items (Blocking for auto-play safety)
            const metaPromises = newItems.map(async (item) => {
              if (item.metadata_url) {
                try {
                  const mRes = await fetch(item.metadata_url);
                  if (mRes.ok) {
                    const meta: EventMetadata = await mRes.json();
                    return { id: item.event_id, meta };
                  }
                } catch (e) {
                  console.warn(`Failed pre-fetching meta for ${item.event_id}`, e);
                }
              }
              return null;
            });

            // Sequential: Wait for meta, then inject, then auto-play
            Promise.all(metaPromises).then(results => {
              const updates: { [key: string]: EventMetadata } = {};
              results.forEach(r => { if (r) updates[r.id] = r.meta; });

              if (Object.keys(updates).length > 0) {
                console.log(`✅ Pre-fetched metadata for ${Object.keys(updates).length} new items`);
                setEventMetadata(prev => ({ ...prev, ...updates }));
              }

              // Update events list
              setEvents(prev => {
                const merged = [...signedNewItems, ...prev];
                return merged.sort((a, b) => b.event_id.localeCompare(a.event_id));
              });

              // Mark new arrivals (shows pill notification) but DO NOT auto-play
              if (newItems.length > 0) {
                const newIds = newItems.map(item => item.event_id);
                console.log(`🔔 New arrivals detected: ${newIds.join(', ')} - checking against read state`);

                setRecentlyArrivedIds(prev => {
                  // Only add IDs that aren't already in recentlyArrivedIds AND aren't read (using Ref for freshest values)
                  const freshIds = newIds.filter(id => !prev.includes(id) && !readEventIdsRef.current.includes(id));
                  if (freshIds.length === 0) return prev;

                  console.log(`✨ Adding ${freshIds.length} truly fresh arrivals to notify user`);
                  playArrivalChime();
                  return [...prev, ...freshIds];
                });
              }
            });
          }

        } catch (error) {
          console.error('Error fetching fresh data on reflection:', error);
        }
      },
      (error) => {
        console.error("Firestore listener error:", error);
      }
    );

    return () => {
      console.log('🔌 Firestore listener detached');
      unsubscribe();
    };
  }, [ExplorerIdentity.currentExplorerId]); // Stable dependency


  const refreshEventUrls = useCallback(async (eventId: string): Promise<Event | null> => {
    try {
      // Fetch fresh URLs for a single event bundle (Expiry: 4 hours)
      const response = await fetch(`${API_ENDPOINTS.GET_EVENT_BUNDLE}?event_id=${eventId}&explorer_id=${ExplorerIdentity.currentExplorerId}`);
      if (!response.ok) {
        console.warn(`Failed to refresh URLs for event ${eventId}`);
        return null;
      }

      const refreshedEvent: Event = await response.json();
      const refreshedEventWithTimestamp = { ...refreshedEvent, refreshedAt: Date.now() };

      // Update the event in the events array
      setEvents(prevEvents =>
        prevEvents.map(e => e.event_id === eventId ? { ...e, ...refreshedEventWithTimestamp } : e)
      );
      return refreshedEventWithTimestamp;
    } catch (error) {
      console.error(`Error refreshing URLs for event ${eventId}:`, error);
      return null;
    }
  }, []);

  // Predictive Neighbor Refresh: Silently refresh the next 2 events in circular order
  const refreshNeighborUrls = useCallback(async (currentEventId: string) => {
    if (events.length <= 1) return;

    const currentIndex = events.findIndex(e => e.event_id === currentEventId);
    if (currentIndex === -1) return;

    // We refresh the next 2 events to stay ahead of the user
    const neighborIndices = [
      (currentIndex + 1) % events.length,
      (currentIndex + 2) % events.length
    ].filter(idx => idx !== currentIndex);

    for (const idx of neighborIndices) {
      const neighbor = events[idx];
      // Only refresh if about to expire (e.g. older than 3 hours)
      const STALE_THRESHOLD = 3 * 60 * 60 * 1000;
      if (!neighbor.refreshedAt || Date.now() - neighbor.refreshedAt > STALE_THRESHOLD) {
        console.log(`📡 Predictive refresh for neighbor: ${neighbor.event_id} (Stale)`);
        refreshEventUrls(neighbor.event_id).catch(() => { });
      }
    }
  }, [events, refreshEventUrls]);

  // Keep ref to latest refreshEventUrls
  const refreshEventUrlsRef = useRef(refreshEventUrls);
  useEffect(() => {
    refreshEventUrlsRef.current = refreshEventUrls;
  }, [refreshEventUrls]);

  const markEventAsRead = useCallback(async (eventId: string) => {
    setReadEventIds(prev => {
      if (prev.includes(eventId)) return prev;
      const next = [...prev, eventId];
      readEventIdsRef.current = next;
      // Save to disk asynchronously
      AsyncStorage.setItem('read_events', JSON.stringify(next)).catch(err => {
        console.error('Failed to save read state:', err);
      });
      console.log(`✅ Marked event ${eventId} as read. Total read: ${next.length}`);
      return next;
    });
  }, []);

  const handleEventPress = useCallback(async (item: Event) => {
    // Open immediately with existing URLs for instant response
    setSelectedEvent(item);

    // Remove from "Recent" arrivals once selected
    console.log(`🖱️ Event ${item.event_id} selected. Removing from recent arrivals.`);
    setRecentlyArrivedIds(prev => {
      const filtered = prev.filter(id => id !== item.event_id);
      if (filtered.length !== prev.length) {
        console.log(`   Removed ${item.event_id} from recent arrivals. New count: ${filtered.length}`);
      }
      return filtered;
    });

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

    // Refresh URLs in background (non-blocking) if they are stale
    const STALE_THRESHOLD = 3 * 60 * 60 * 1000; // 3 hours
    const isStale = !item.refreshedAt || (Date.now() - item.refreshedAt > STALE_THRESHOLD);

    if (isStale) {
      console.log(`🔄 Item ${item.event_id} is stale. Refreshing in background...`);
      const eventIdToRefresh = item.event_id;
      refreshEventUrls(eventIdToRefresh).then(refreshedEvent => {
        if (refreshedEvent) {
          // Trigger predictive refresh for neighbors
          refreshNeighborUrls(eventIdToRefresh);

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
      });
    } else {
      // Still refresh neighbors, they might be stale
      refreshNeighborUrls(item.event_id);
    }
  }, [eventMetadata, refreshEventUrls, refreshNeighborUrls]);

  // Helper to format event date
  const formatEventDate = (eventId: string): string => {
    const timestamp = parseInt(eventId, 10);
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return 'today';
    if (diffDays === 1) return 'yesterday';
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const renderEvent = ({ item }: { item: Event }) => {
    const metadata = eventMetadata[item.event_id];
    const isRead = readEventIds.includes(item.event_id);
    const isNewArrival = recentlyArrivedIds.includes(item.event_id);

    // Don't render if no image URL
    if (!item.image_url || item.image_url === '') {
      return null;
    }

    return (
      <TouchableOpacity
        style={[
          styles.gridCard,
          isNewArrival && styles.gridCardNewArrival
        ]}
        onPress={() => handleEventPress(item)}
        activeOpacity={0.8}
      >
        {/* Unread indicator dot */}
        {!isRead && (
          <View style={styles.unreadDot} />
        )}

        {/* Thumbnail */}
        <View style={styles.gridThumbnailContainer}>
          <Image
            source={{ uri: item.image_url }}
            style={styles.gridThumbnail}
            contentFit="cover"
            recyclingKey={item.event_id}
            cachePolicy="memory-disk"
            onError={(error) => {
              console.error(`Error loading image for event ${item.event_id}:`, error);
            }}
          />
          {/* Media type badge overlay */}
          <View style={styles.mediaTypeBadge}>
            {item.video_url ? (
              <FontAwesome name="video-camera" size={12} color="#fff" />
            ) : metadata?.image_source === 'search' ? (
              <FontAwesome name="search" size={12} color="#fff" />
            ) : (
              <FontAwesome name="camera" size={12} color="#fff" />
            )}
          </View>
        </View>

        {/* Card Content */}
        <View style={styles.gridCardContent}>
          {/* Description/Title */}
          <Text style={styles.gridCardTitle} numberOfLines={2}>
            {metadata?.description || metadata?.short_caption || 'Reflection'}
          </Text>

          {/* Metadata row */}
          <View style={styles.gridCardMeta}>
            <Text style={styles.gridCardDate}>
              {formatEventDate(item.event_id)}
            </Text>
            {isNewArrival && (
              <Text style={styles.gridCardNewBadge}>NEW</Text>
            )}
          </View>

          {/* Sender */}
          {metadata?.sender && (
            <Text style={styles.gridCardSender} numberOfLines={1}>
              From {metadata.sender}
            </Text>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  const closeFullScreen = useCallback(async () => {
    // Stop speech if playing
    Speech.stop();

    // Auto-fetch fresh list if closing (optional, but robust)
    fetchEvents();

    setSelectedEvent(null);
  }, [fetchEvents]);

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
      // Update selectedEvent - MainStageView will handle the audio transition
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
    try {
      const signalRef = doc(db, ExplorerIdentity.collections.reflections, eventId);
      await setDoc(signalRef, {
        event_id: eventId,
        status: 'engaged',
        timestamp: serverTimestamp(),
        type: 'engagement_heartbeat',
        engagement_count: increment(1),
      }, { merge: true });
      hasEngagedRef.current[eventId] = true;
    } catch (error) {
      console.error('Error sending engagement signal:', error);
    }
  };

  // Send replay signal to Firestore
  const sendReplaySignal = async (eventId: string) => {
    // REPLAY SIGNAL: Always send to update timestamp (bubbling up list)

    try {
      const signalRef = doc(db, ExplorerIdentity.collections.reflections, eventId);
      await setDoc(signalRef, {
        event_id: eventId,
        status: 'replayed',
        timestamp: serverTimestamp(),
        type: 'engagement_heartbeat',
        engagement_count: increment(1),
      }, { merge: true });
      hasReplayedRef.current[eventId] = true;
    } catch (error) {
      console.error('Error sending replay signal:', error);
    }
  };

  const enqueueSelfieUpload = useCallback(async (job: {
    originalEventId: string;
    responseEventId: string;
    localUri: string; // Persistent, processed selfie file (documentDirectory)
    senderExplorerId: string;
    viewerExplorerId: string;
    createdAt: number;
  }) => {
    try {
      console.log(`[Queue] Enqueue job for event ${job.originalEventId}`);
      const existingRaw = await AsyncStorage.getItem(SELFIE_QUEUE_KEY);
      const existingQueue = existingRaw ? JSON.parse(existingRaw) : [];
      existingQueue.push(job);
      await AsyncStorage.setItem(SELFIE_QUEUE_KEY, JSON.stringify(existingQueue));
      await processSelfieQueue();
    } catch (error) {
      console.error('Failed to enqueue selfie upload:', error);
    }
  }, [processSelfieQueue]);

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
      // Phase: Capture
      console.log('[Selfie] Phase: Capture');
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.3,
        base64: false,
      });

      if (!photo) {
        throw new Error("Failed to capture photo");
      }

      // Generate event ID for the response
      const responseEventId = Date.now().toString();

      // Phase: Process (resize/compress) + persist to documentDirectory
      // NOTE: We do this here because doing ImageManipulator work inside the queue
      // was intermittently taking tens of seconds and freezing the UI.
      console.log('[Selfie] Phase: Process (resize/compress)');
      const processedPhoto = await ImageManipulator.manipulateAsync(
        photo.uri,
        [{ resize: { width: 1080 } }],
        { compress: 0.5, format: ImageManipulator.SaveFormat.JPEG }
      );

      const persistentDir = FileSystem.documentDirectory;
      const persistentPath = `${persistentDir}selfie_${responseEventId}.jpg`;
      await FileSystem.copyAsync({ from: processedPhoto.uri, to: persistentPath });

      // Cleanup temp files (best-effort). Keep only the persistentPath for queue.
      try {
        if (photo.uri && photo.uri !== persistentPath && photo.uri !== processedPhoto.uri) {
          await FileSystem.deleteAsync(photo.uri, { idempotent: true });
        }
        if (processedPhoto.uri && processedPhoto.uri !== persistentPath) {
          await FileSystem.deleteAsync(processedPhoto.uri, { idempotent: true });
        }
      } catch (cleanupError) {
        console.warn('Failed cleaning up selfie temp files:', cleanupError);
      }

      // Phase: Enqueue (processed file is now persistent)
      console.log('[Selfie] Phase: Enqueue');
      await enqueueSelfieUpload({
        originalEventId: selectedEvent.event_id,
        responseEventId,
        localUri: persistentPath,
        senderExplorerId: ExplorerIdentity.currentExplorerId,
        viewerExplorerId: ExplorerIdentity.currentExplorerId,
        createdAt: Date.now(),
      });

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

      // Upload + Firestore updates now happen in the deferred queue

    } catch (error: any) {
      console.error("❌ Error capturing selfie:", error);
      // Detailed logging for tricky network/platform errors
      if (error && typeof error === 'object') {
        console.error("❌ Detailed Error Info:", {
          message: error.message,
          code: error.code,
          domain: error.domain,
          userInfo: error.userInfo
        });
      }

      let errorMessage = "Failed to capture selfie. Please try again.";
      if (error?.code === 'permission-denied' || error?.message?.includes('permission')) {
        errorMessage = `Permission error. Please check Firestore security rules for '${ExplorerIdentity.collections.responses}' collection.`;
      }

      if (!silent) {
        Alert.alert("Error", `${errorMessage}\n\nTechnical info: ${error.message || 'Unknown error'}`);
      }
    } finally {
      setIsCapturingSelfie(false);
    }
  }, [selectedEvent, cameraPermission, isCapturingSelfie, requestCameraPermission, eventMetadata]);


  const deleteEvent = async (event: Event) => {
    try {
      // 1. Delete S3 objects
      const deleteResponse = await fetch(
        `${API_ENDPOINTS.DELETE_MIRROR_EVENT}?event_id=${event.event_id}&explorer_id=${ExplorerIdentity.currentExplorerId}`
      );

      if (!deleteResponse.ok) {
        const errorData = await deleteResponse.json();
        throw new Error(errorData.errors?.join(', ') || 'Failed to delete S3 objects');
      }

      // 2. Delete selfie response image from S3 if it exists (keep the document)
      try {
        const responseRef = doc(db, ExplorerIdentity.collections.responses, event.event_id);
        const responseDoc = await getDoc(responseRef);

        if (responseDoc.exists()) {
          const responseData = responseDoc.data();
          const responseEventId = responseData.response_event_id;

          if (responseEventId) {
            // Delete selfie image from S3 (path: from/{response_event_id}/image.jpg)
            // Keep the reflection_response document in Firestore for history
            const deleteSelfieResponse = await fetch(
              `${API_ENDPOINTS.DELETE_MIRROR_EVENT}?event_id=${responseEventId}&path=from&explorer_id=${ExplorerIdentity.currentExplorerId}`
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
        const signalRef = doc(db, ExplorerIdentity.collections.reflections, event.event_id);
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

  const processedEvents = useMemo(() => {
    if (!events.length) return [];
    if (!EXPLORER_CONFIG.loopFeed) return events;

    // Repeat the whole list 10 times.
    // [A,B,C] -> [A,B,C, A,B,C, A,B,C ...]
    const loops = 10;
    let combined: Event[] = [];

    for (let i = 0; i < loops; i++) {
      const loopChunk = events.map((e, index) => ({
        ...e,
        // Mark the start of a loop so you can show the "Replaying" badge
        isLoopStart: index === 0 && i > 0,
      }));
      combined = [...combined, ...loopChunk];
    }
    return combined;
  }, [events, EXPLORER_CONFIG.loopFeed]);

  if (loading) {
    return (
      <LinearGradient
        colors={['#0f2027', '#203a43', '#2c5364']}
        style={styles.centerContainer}
      >
        <TouchableOpacity
          onPress={() => router.push('/settings')}
          style={{ position: 'absolute', top: insets.top + 10, right: 20, padding: 10, zIndex: 100 }}
          hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}
        >
          <FontAwesome name="info-circle" size={24} color="rgba(255, 255, 255, 0.4)" />
        </TouchableOpacity>

        <ActivityIndicator size="large" color="#fff" />
        <Text style={[styles.loadingText, { color: '#fff' }]}>Loading Reflections...</Text>
      </LinearGradient>


    );
  }

  if (error) {
    return (
      <LinearGradient
        colors={['#0f2027', '#203a43', '#2c5364']}
        style={styles.centerContainer}
      >
        <Text style={[styles.errorText, { color: '#fff' }]}>Error: {error}</Text>
        <Text style={[styles.retryText, { color: '#4FC3F7' }]} onPress={fetchEvents}>
          Tap to retry
        </Text>
      </LinearGradient>

    );
  }

  if (events.length === 0) {
    return (
      <LinearGradient
        colors={['#0f2027', '#203a43', '#2c5364']}
        style={styles.centerContainer}
      >
        <TouchableOpacity
          onPress={() => router.push('/settings')}
          style={{ position: 'absolute', top: insets.top + 10, right: 20, padding: 10, zIndex: 100 }}
          hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}
        >
          <FontAwesome name="info-circle" size={24} color="rgba(255, 255, 255, 0.4)" />
        </TouchableOpacity>

        <Text style={[styles.emptyText, { color: '#fff' }]}>No Reflections yet</Text>
        <Text style={[styles.emptySubtext, { color: 'rgba(255,255,255,0.7)' }]}>Reflections from companions will appear here</Text>
      </LinearGradient>


    );
  }

  // Z-Stack Layout: Grid (bottom) + MainStageView Overlay (top)
  return (
    <LinearGradient
      colors={['#0f2027', '#203a43', '#2c5364']}
      style={styles.container}
    >
      {/* Header Bar */}
      <View style={[styles.gridHeader, { paddingTop: insets.top + 12 }]}>
        <View style={styles.gridHeaderLeft}>
          {recentlyArrivedIds.length > 0 ? (
            <TouchableOpacity
              onPress={() => {
                // Find and select the first new arrival
                const newestArrival = events.find(e => recentlyArrivedIds.includes(e.event_id));
                if (newestArrival) {
                  handleEventPress(newestArrival);
                }
              }}
              style={styles.newArrivalPill}
              activeOpacity={0.7}
            >
              <BlurView intensity={80} style={styles.newArrivalPillBlur}>
                <Text style={styles.newArrivalPillText}>
                  ✨ {recentlyArrivedIds.length} New Reflection{recentlyArrivedIds.length > 1 ? 's' : ''}
                </Text>
              </BlurView>
            </TouchableOpacity>
          ) : (
            <Text style={styles.gridHeaderTitle}>Reflections</Text>
          )}
        </View>
        <View style={styles.gridHeaderActions}>
          <TouchableOpacity
            onPress={() => router.push('/settings')}
            style={styles.gridHeaderButton}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <FontAwesome name="info-circle" size={20} color="rgba(255, 255, 255, 0.6)" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Layer 1 (Bottom): Always-rendered Grid of Reflections */}
      <FlatList
        data={processedEvents}
        renderItem={renderEvent}
        keyExtractor={(item, index) => `${item.event_id}_grid_${index}`}
        numColumns={numColumns}
        key={numColumns} // Force re-render when column count changes
        contentContainerStyle={[
          styles.listContainer,
          { paddingBottom: insets.bottom + 20 }
        ]}
        columnWrapperStyle={styles.row}
        showsVerticalScrollIndicator={false}
      />

      {/* Layer 2 (Top): MainStageView Overlay - Only rendered when event selected */}
      {selectedEvent !== null && (
        <View style={[StyleSheet.absoluteFill, { zIndex: 100 }]}>
          <MainStageView
            visible={true}
            selectedEvent={selectedEvent}
            events={processedEvents}
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
            recentlyArrivedIds={recentlyArrivedIds}
            readEventIds={readEventIds}
            onReplay={(event) => sendReplaySignal(event.event_id)}
            config={EXPLORER_CONFIG}
          />
        </View>
      )}
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
  // --- Grid Header Styles ---
  gridHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    backgroundColor: 'transparent',
  },
  gridHeaderLeft: {
    flex: 1,
  },
  gridHeaderTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: -0.5,
  },
  gridHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  gridHeaderButton: {
    padding: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  // --- New Arrival Pill Notification ---
  newArrivalPill: {
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: 'rgba(255, 215, 0, 0.2)',
    alignSelf: 'flex-start',
  },
  newArrivalPillBlur: {
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  newArrivalPillText: {
    color: '#FFD700',
    fontWeight: 'bold',
    fontSize: 16,
    textShadowColor: 'rgba(0, 0, 0, 0.75)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  listContainer: {
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  row: {
    justifyContent: 'flex-start',
    marginBottom: 4,
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
  // --- YouTube-Style Grid Card Styles ---
  gridCard: {
    flex: 1,
    margin: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 16,
    overflow: 'hidden',
    position: 'relative',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
  },
  gridCardNewArrival: {
    backgroundColor: 'rgba(255, 215, 0, 0.15)',
    borderColor: 'rgba(255, 215, 0, 0.5)',
    borderWidth: 1,
  },
  unreadDot: {
    position: 'absolute',
    left: 8,
    top: 8,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#007AFF',
    zIndex: 10,
  },
  gridThumbnailContainer: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: '#1a3a44',
    position: 'relative',
  },
  gridThumbnail: {
    width: '100%',
    height: '100%',
  },
  mediaTypeBadge: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  gridCardContent: {
    padding: 12,
  },
  gridCardTitle: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 18,
    marginBottom: 6,
  },
  gridCardMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  gridCardDate: {
    color: 'rgba(255, 255, 255, 0.6)',
    fontSize: 12,
  },
  gridCardNewBadge: {
    color: '#FFD700',
    fontSize: 10,
    fontWeight: 'bold',
    marginLeft: 8,
  },
  gridCardSender: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 11,
    marginTop: 2,
  },
});
