import { FontAwesome } from '@expo/vector-icons';
import { Event, EventMetadata } from '@projectmirror/shared';
import { useMachine } from '@xstate/react';
import { Audio } from 'expo-av';
import { BlurView } from 'expo-blur';
import { CameraView, PermissionResponse } from 'expo-camera';
import { LinearGradient } from 'expo-linear-gradient';
import * as Speech from 'expo-speech';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  Image,
  PanResponder,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { playerMachine } from '../machines/playerMachine';
interface MainStageProps {
  visible: boolean;
  selectedEvent: Event | null;
  events: Event[];
  eventMetadata: { [key: string]: EventMetadata };
  onClose: () => void;
  onEventSelect: (event: Event) => void;
  onDelete: (event: Event) => void;
  onCaptureSelfie: () => Promise<void>;
  onMediaError?: (event: Event) => void;
  cameraRef: React.RefObject<CameraView>;
  cameraPermission: PermissionResponse | null;
  requestCameraPermission: () => Promise<PermissionResponse>;
  isCapturingSelfie: boolean;
  pendingCount: number;
  onFlushUpdates: () => void;
  readEventIds: string[];
  onReplay?: (event: Event) => void;
}

export default function MainStageView({
  visible,
  selectedEvent,
  events,
  eventMetadata,
  onClose,
  onEventSelect,
  onDelete,
  onCaptureSelfie,
  onMediaError,
  cameraRef,
  cameraPermission,
  requestCameraPermission,
  isCapturingSelfie,
  pendingCount,
  onFlushUpdates,
  readEventIds,
  onReplay,
}: MainStageProps) {
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const insets = useSafeAreaInsets();

  // --- LOCAL STATE (Visuals Only) ---
  const [flashOpacity] = useState(new Animated.Value(0));
  const [controlsOpacity] = useState(new Animated.Value(0)); // 0 = Hidden
  const [selfieMirrorOpacity] = useState(new Animated.Value(0));
  const [audioIndicatorAnim] = useState(new Animated.Value(0.7));
  const [tellMeMorePulse] = useState(new Animated.Value(1));
  const flatListRef = useRef<FlatList>(null);

  // Need to track video playing for VU meter
  const [isVideoPlaying, setIsVideoPlaying] = useState(false);

  // --- AUDIO/VIDEO REFS ---
  const [sound, setSound] = useState<Audio.Sound | null>(null); // Voice messages
  const [captionSound, setCaptionSound] = useState<Audio.Sound | null>(null); // Companion audio captions

  // --- Live refs used by pan responder ---
  const eventsRef = useRef(events);
  const selectedEventRef = useRef(selectedEvent);

  // Track caption sound in ref to handle race condition with stopAllMedia
  const captionSoundRef = useRef<Audio.Sound | null>(null);

  // Get metadata (memoized to prevent unnecessary re-renders)
  const selectedMetadata = useMemo(
    () => selectedEvent ? eventMetadata[selectedEvent.event_id] : null,
    [selectedEvent, eventMetadata]
  );

  // Track previous event to prevent restart loops
  const prevEventIdRef = useRef<string | null>(null);

  // Track active caption session to prevent ghost TTS callbacks
  const captionSessionRef = useRef(0);

  // Initialize Video Player
  const videoSource = selectedMetadata?.content_type === 'video' && selectedEvent?.video_url
    ? selectedEvent.video_url
    : null;

  const player = useVideoPlayer(videoSource || '', (player) => {
    setIsVideoPlaying(player.playing);
  });

  // --- ACTIONS IMPLEMENTATION ---

  // Helper for reused selfie logic
  const performSelfieCapture = useCallback(async (delay = 0) => {
    console.log(`📸 Helper: Starting Selfie Sequence (delay: ${delay}ms)`);
    // Fade in mirror
    Animated.timing(selfieMirrorOpacity, { toValue: 1, duration: 500, useNativeDriver: true }).start();

    // Wait...
    setTimeout(async () => {
      console.log('📸 Helper: Snapping now...');
      // Flash
      Animated.sequence([
        Animated.timing(flashOpacity, { toValue: 1, duration: 150, useNativeDriver: true }),
        Animated.timing(flashOpacity, { toValue: 0, duration: 250, useNativeDriver: true }),
      ]).start();

      // Capture
      await onCaptureSelfie();

      // Fade out
      setTimeout(() => {
        console.log('📸 Helper: Fading out bubble');
        Animated.timing(selfieMirrorOpacity, { toValue: 0, duration: 500, useNativeDriver: true }).start();
      }, 500);
    }, delay);
  }, [onCaptureSelfie, flashOpacity, selfieMirrorOpacity]);

  // --- THE XSTATE MACHINE ---
  // Debug: Check if machine is imported correctly
  if (!playerMachine) {
    console.error('CRITICAL: playerMachine is undefined in MainStageView!');
  }

  const [state, send] = useMachine(playerMachine.provide({
    // ... actions ... (we keep the actions block same, just modify lines around it)
    actions: {
      stopAllMedia: async () => {
        console.log('🛑 Stopping all media');
        // Increment session to invalidate any pending callbacks
        captionSessionRef.current += 1;
        // Stop TTS immediately and forcefully
        Speech.stop();
        // Stop voice message audio
        if (sound) {
          try {
            await sound.stopAsync();
            await sound.unloadAsync();
          } catch (e) {
            console.error('Error stopping sound:', e);
          }
          setSound(null);
        }
        // Stop companion caption audio (check both state AND ref for race condition)
        const soundToStop = captionSound || captionSoundRef.current;
        if (soundToStop) {
          try {
            await soundToStop.stopAsync();
            await soundToStop.unloadAsync();
          } catch (e) {
            console.error('Error stopping caption:', e);
          }
          setCaptionSound(null);
          captionSoundRef.current = null;
        }
        if (player) player.pause();
        Animated.timing(controlsOpacity, { toValue: 0, duration: 300, useNativeDriver: true }).start();

        // Small delay to ensure everything stops
        await new Promise(resolve => setTimeout(resolve, 100));
      },

      speakCaption: async () => {
        const text = selectedMetadata?.description;
        const audioUrl = selectedEvent?.audio_url; // Companion-recorded caption

        // Start new caption session
        captionSessionRef.current += 1;
        const thisSession = captionSessionRef.current;

        // Hide controls while speaking
        Animated.timing(controlsOpacity, { toValue: 0, duration: 300, useNativeDriver: true }).start();

        // If there's a companion audio recording, play that instead of TTS
        if (audioUrl) {
          try {
            console.log(`🎧 Playing companion audio from: ${audioUrl.substring(0, 50)}...`);
            const { sound: newCaptionSound } = await Audio.Sound.createAsync(
              { uri: audioUrl },
              { shouldPlay: true },
              (status) => {
                if (status.isLoaded && !status.isPlaying && status.didJustFinish) {
                  // Only send if this is still the active session
                  if (captionSessionRef.current === thisSession) {
                    console.log('✅ Companion audio finished - sending NARRATION_FINISHED');
                    newCaptionSound.unloadAsync();
                    setCaptionSound(null);
                    captionSoundRef.current = null;
                    send({ type: 'NARRATION_FINISHED' });
                  } else {
                    console.log('🚫 Companion audio finished but session changed - ignoring');
                    newCaptionSound.unloadAsync();
                    captionSoundRef.current = null;
                  }
                }
              }
            );
            // Set ref immediately for stopAllMedia race condition protection
            captionSoundRef.current = newCaptionSound;
            setCaptionSound(newCaptionSound);
            console.log('🎧 Companion audio started, waiting for completion...');
            // DO NOT send NARRATION_FINISHED here - wait for callback!
          } catch (error) {
            if (captionSessionRef.current === thisSession) {
              console.error('❌ Audio caption error - sending NARRATION_FINISHED:', error);
              send({ type: 'NARRATION_FINISHED' });
            }
          }
        } else if (text) {
          Speech.speak(text, {
            onDone: () => {
              // Only send if this is still the active session
              if (captionSessionRef.current === thisSession) {
                console.log('✅ TTS finished - sending NARRATION_FINISHED');
                send({ type: 'NARRATION_FINISHED' });
              } else {
                console.log('🚫 TTS finished but session changed - ignoring');
              }
            },
            onError: () => {
              if (captionSessionRef.current === thisSession) {
                console.error('❌ TTS error - sending NARRATION_FINISHED');
                send({ type: 'NARRATION_FINISHED' });
              }
            }
          });
        } else {
          if (captionSessionRef.current === thisSession) {
            console.log('⚠️ No caption - sending NARRATION_FINISHED immediately');
            send({ type: 'NARRATION_FINISHED' });
          }
        }
      },

      playVideo: async () => {
        // Wait for video to be ready (max 2 seconds)
        const maxWaitMs = 2000;
        const checkIntervalMs = 100;
        let waitedMs = 0;

        while (waitedMs < maxWaitMs) {
          if (player && player.duration > 0) {
            console.log(`▶️ Playing video: duration=${player.duration}s (waited ${waitedMs}ms)`);
            player.currentTime = 0;
            player.play();
            Animated.timing(selfieMirrorOpacity, { toValue: 1, duration: 500, useNativeDriver: true }).start();
            return;
          }
          await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
          waitedMs += checkIntervalMs;
        }

        // Video never loaded
        console.error(`⚠️ Video not ready after ${waitedMs}ms - duration=${player?.duration || 0}s`);
        send({ type: 'VIDEO_FINISHED' });
      },

      playAudio: async () => {
        try {
          if (sound) await sound.unloadAsync();

          if (!selectedEvent?.audio_url) {
            send({ type: 'AUDIO_FINISHED' });
            return;
          }

          const { sound: newSound } = await Audio.Sound.createAsync(
            { uri: selectedEvent.audio_url as string },
            { shouldPlay: true }
          );

          newSound.setOnPlaybackStatusUpdate((status) => {
            if (status.isLoaded && status.didJustFinish) {
              send({ type: 'AUDIO_FINISHED' });
            }
          });
          setSound(newSound);

        } catch (err) {
          console.error("Audio error", err);
          send({ type: 'AUDIO_FINISHED' });
        }
      },

      playDeepDive: () => {
        if (selectedMetadata?.deep_dive) {
          Speech.speak(selectedMetadata.deep_dive, {
            onDone: () => send({ type: 'NARRATION_FINISHED' })
          });
        } else {
          send({ type: 'NARRATION_FINISHED' });
        }
      },

      showSelfieBubble: () => {
        Animated.timing(selfieMirrorOpacity, { toValue: 1, duration: 0, useNativeDriver: true }).start();
      },

      triggerSelfie: async () => {
        await performSelfieCapture(0);
      }
    }
  }));

  // --- DEBUG LOGGER (State Transitions) ---
  const prevStateRef = useRef<any>(null);
  useEffect(() => {
    if (state) {
      const stateStr = JSON.stringify(state.value);
      const prevStr = prevStateRef.current ? JSON.stringify(prevStateRef.current) : 'none';
      if (stateStr !== prevStr) {
        console.log(`🤖 TRANSITION: ${prevStr} → ${stateStr}`);
        prevStateRef.current = state.value;
      }
    }
  }, [state]);

  // Sync Live refs on every render
  useEffect(() => {
    eventsRef.current = events;
    selectedEventRef.current = selectedEvent;
  }, [events, selectedEvent]);

  // --- SYNC REACT EVENTS TO MACHINE ---

  // 1. New Event Selected (ONLY when event_id actually changes)
  useEffect(() => {
    const currentEventId = selectedEvent?.event_id || null;

    if (!selectedMetadata) return;

    // Only send SELECT_EVENT if the event ID actually changed
    if (currentEventId && currentEventId !== prevEventIdRef.current) {
      prevEventIdRef.current = currentEventId;
      console.log(`📩 User selected reflection: ${currentEventId}`);
      send({ type: 'SELECT_EVENT', event: selectedEvent!, metadata: selectedMetadata! });
    }
  }, [selectedEvent?.event_id, selectedEvent, selectedMetadata, send]);

  // 2. Video Player Finished
  useEffect(() => {
    if (!player) return;
    const interval = setInterval(() => {
      if (player.duration > 0 && player.currentTime >= player.duration - 0.1) {
        send({ type: 'VIDEO_FINISHED' });
      }
    }, 200);
    return () => clearInterval(interval);
  }, [player, send]);

  // 3. Show/Hide Controls AND Bubble Based on State
  useEffect(() => {
    if (!state) return;

    if (state.matches('finished')) {
      // Finished: Show controls AND hide bubble
      Animated.timing(controlsOpacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
      Animated.timing(selfieMirrorOpacity, { toValue: 0, duration: 500, useNativeDriver: true }).start();
    } else if (state.matches({ viewingPhoto: 'viewing' })) {
      // Photo viewing: Show controls but DON'T touch bubble (it needs to stay visible!)
      Animated.timing(controlsOpacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    } else {
      // Playing: Hide controls
      Animated.timing(controlsOpacity, { toValue: 0, duration: 200, useNativeDriver: true }).start();
    }
  }, [state, controlsOpacity, selfieMirrorOpacity]);

  // 4. ANIMATIONS (VU Meter & Pulse)
  const isMachineSpeaking = state && (state.matches({ playingVideo: 'narrating' }) ||
    state.matches({ viewingPhoto: 'narrating' }) ||
    state.matches('playingDeepDive'));
  const isPlayingAudioState = state && state.matches('playingAudio');
  const isAnyAudioPlaying = isMachineSpeaking || isPlayingAudioState || isVideoPlaying;

  useEffect(() => {
    if (isAnyAudioPlaying) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(audioIndicatorAnim, { toValue: 1, duration: 300, useNativeDriver: true }),
          Animated.timing(audioIndicatorAnim, { toValue: 0.7, duration: 300, useNativeDriver: true }),
        ])
      ).start();
    } else {
      audioIndicatorAnim.setValue(0.7);
    }
  }, [isAnyAudioPlaying, audioIndicatorAnim]);

  // Pulse animation for Tell Me More button
  useEffect(() => {
    if (state && (state.matches('finished') || state.matches({ viewingPhoto: 'viewing' }))) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(tellMeMorePulse, { toValue: 1.15, duration: 600, useNativeDriver: true }),
          Animated.timing(tellMeMorePulse, { toValue: 1, duration: 600, useNativeDriver: true }),
        ])
      ).start();
    } else {
      tellMeMorePulse.setValue(1);  // stop animation
    }
  }, [state, tellMeMorePulse]);


  // --- RENDERING HELPERS ---

  const handleReplay = () => {
    console.log('🔁 User pressed REPLAY');
    send({ type: 'REPLAY' });
    if (onReplay && selectedEvent) onReplay(selectedEvent);
  };

  const handleUpNextItemPress = (event: Event) => {
    onEventSelect(event);
  };

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

  const upNextEvents = useMemo(() => events, [events]);

  const renderUpNextItem = ({ item }: { item: Event }) => {
    const metadata = eventMetadata[item.event_id];
    const isNowPlaying = item.event_id === selectedEvent?.event_id;
    const isRead = readEventIds.includes(item.event_id);

    return (
      <View style={styles.upNextItemContainer}>
        <TouchableOpacity
          style={[styles.upNextItem, isNowPlaying && styles.upNextItemNowPlaying]}
          onPress={() => handleUpNextItemPress(item)}
          disabled={isNowPlaying}
        >
          {!isRead && (
            <View style={{
              width: 10, height: 10, borderRadius: 5, backgroundColor: '#007AFF',
              position: 'absolute', left: -6, top: '50%', marginTop: -5, zIndex: 10
            }} />
          )}
          <Image source={{ uri: item.image_url }} style={styles.upNextThumbnail} />
          <View style={styles.upNextInfo}>
            <Text style={[styles.upNextTitle, isNowPlaying && styles.upNextTitleNowPlaying]} numberOfLines={2}>
              {isNowPlaying && '▶️ '}{metadata?.description || 'Reflection'}
            </Text>

            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              {item.video_url ? (
                <>
                  <FontAwesome name="video-camera" size={12} color="rgba(255, 255, 255, 0.7)" style={{ marginRight: 4 }} />
                  <Text style={[styles.upNextMeta, isNowPlaying && styles.upNextMetaNowPlaying]}>Video</Text>
                </>
              ) : item.audio_url ? (
                <>
                  <FontAwesome name="microphone" size={12} color="rgba(255, 255, 255, 0.7)" style={{ marginRight: 4 }} />
                  <Text style={[styles.upNextMeta, isNowPlaying && styles.upNextMetaNowPlaying]}>Voice</Text>
                </>
              ) : (
                <>
                  <FontAwesome name="camera" size={12} color="rgba(255, 255, 255, 0.7)" style={{ marginRight: 4 }} />
                  <Text style={[styles.upNextMeta, isNowPlaying && styles.upNextMetaNowPlaying]}>Photo</Text>
                </>
              )}
              {isNowPlaying && <Text style={styles.upNextMetaNowPlaying}> • NOW PLAYING</Text>}
            </View>

            <Text style={[styles.upNextDate, isNowPlaying && styles.upNextDateNowPlaying]}>
              {formatEventDate(item.event_id)}
            </Text>

            <Text style={styles.reflectionId}>
              Reflection ID: {item.event_id}
            </Text>
          </View>
        </TouchableOpacity>
      </View>
    );
  };


  if (!selectedEvent) return <View style={styles.modalContainer} />;

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) => {
        return Math.abs(gestureState.dx) > 20;
      },
      onPanResponderRelease: (_, gestureState) => {
        const currentEvents = eventsRef.current;
        const currentSelected = selectedEventRef.current;

        const currentIndex = currentEvents.findIndex(e => e.event_id === currentSelected?.event_id);
        if (currentIndex === -1) return;

        if (gestureState.dx < -50) {
          console.log('👈 Swiped Left (Next)');
          if (currentIndex < currentEvents.length - 1) {
            onEventSelect(currentEvents[currentIndex + 1]);
          }
        }

        else if (gestureState.dx > 50) {
          console.log('👉 Swiped Right (Previous)');
          if (currentIndex > 0) {
            onEventSelect(currentEvents[currentIndex - 1]);
          }
        }
      },
    })
  ).current;

  return (
    <LinearGradient
      colors={['#0f2027', '#203a43', '#2c5364']}
      style={styles.modalContainer}
      {...panResponder.panHandlers}
    >
      <View style={[styles.splitContainer, isLandscape ? styles.splitContainerLandscape : styles.splitContainerPortrait]}>

        {/* LEFT PANE */}
        <View style={[styles.stagePane, isLandscape ? { flex: 0.7 } : { flex: 0.4 }]}>

          {/* Header */}
          <View style={[styles.headerBar, { top: insets.top + 10 }]}>
            {pendingCount > 0 ? (
              <TouchableOpacity onPress={onFlushUpdates} style={styles.newUpdatesButton}>
                <Text style={styles.newUpdatesText}>Load {pendingCount} New</Text>
              </TouchableOpacity>
            ) : (
              events.length > 1 && <Text style={styles.reflectionsTitle}>Reflections</Text>
            )}
          </View>

          {/* Media Container */}
          <TouchableOpacity
            style={styles.mediaContainer}
            activeOpacity={1}
            onPress={() => {
              if (state && (state.matches('finished') || state.matches({ viewingPhoto: 'viewing' }))) {
                handleReplay();
              }
            }}
          >
            {selectedMetadata?.content_type === 'video' && videoSource ? (
              <VideoView player={player} style={styles.mediaImage} nativeControls={false} />
            ) : (
              <Image source={{ uri: selectedEvent.image_url }} style={styles.mediaImage} />
            )}

            {/* Replay Button */}
            <Animated.View style={[styles.playOverlay, { opacity: controlsOpacity }]}>
              <TouchableOpacity onPress={handleReplay} style={styles.playButton}>
                <BlurView intensity={30} style={styles.playOverlayBlur}>
                  <FontAwesome name="repeat" size={64} color="rgba(255, 255, 255, 0.95)" />
                </BlurView>
              </TouchableOpacity>
            </Animated.View>
          </TouchableOpacity>

          {/* Capraion & Metadata */}
          <View style={[styles.metadataContainer, { paddingBottom: insets.bottom + 16 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              {/* VU Meter for audio playback */}
              {isAnyAudioPlaying && (
                <Animated.View style={{ opacity: audioIndicatorAnim, marginRight: 10 }}>
                  <FontAwesome name="volume-up" size={20} color="rgba(255, 255, 255, 0.9)" />
                </Animated.View>
              )}
              {/* Microphone icon for voice recordings */}
              {selectedEvent?.audio_url && (
                <View style={{ marginRight: 10 }}>
                  <FontAwesome name="microphone" size={18} color="rgba(255, 255, 255, 0.9)" />
                </View>
              )}
              <Text style={styles.descriptionText}>
                {selectedEvent?.audio_url ? 'Voice recording' : selectedMetadata?.description}
              </Text>
            </View>

            {/* Tell Me More FAB */}
            {selectedMetadata?.deep_dive && state && (state.matches('finished') || state.matches({ viewingPhoto: 'viewing' })) && (
              <Animated.View style={[styles.tellMeMoreFAB, { transform: [{ scale: tellMeMorePulse }] }]}>
                <TouchableOpacity
                  onPress={() => {
                    console.log('✨ User pressed Tell Me More button');
                    send({ type: 'TELL_ME_MORE' });
                  }}
                  style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}
                >
                  <BlurView intensity={50} style={styles.tellMeMoreBlur}>
                    <Text style={{ fontSize: 32 }}>✨</Text>
                  </BlurView>
                </TouchableOpacity>
              </Animated.View>
            )}
          </View>
        </View>

        {/* RIGHT PANE */}
        <View style={[styles.upNextPane, isLandscape ? { flex: 0.3 } : { flex: 0.6 }, { paddingTop: insets.top + 10 }]}>
          <View style={styles.upNextHeader}>
            <Text style={styles.upNextHeaderText}>Up Next</Text>
            <Text style={styles.upNextCount}>{events.length}</Text>
          </View>
          <FlatList
            ref={flatListRef}
            data={upNextEvents}
            renderItem={renderUpNextItem}
            keyExtractor={(item) => item.event_id}
          />
        </View>

      </View>

      {/* Selfie Mirror - Rendered at ROOT level to override native Image/Video layers */}
      <Animated.View style={[styles.cameraBubble, {
        top: insets.top + 16,
        // In landscape, offset by right pane width (30%) to keep bubble in left pane
        right: isLandscape ? (width * 0.3 + insets.right + 16) : (insets.right + 16),
        opacity: selfieMirrorOpacity
      }]}>
        {cameraPermission?.granted ? (
          <CameraView ref={cameraRef} style={styles.cameraPreview} facing="front" />
        ) : null}
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: 'white', opacity: flashOpacity }]} />
      </Animated.View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  modalContainer: { flex: 1 },
  splitContainer: { flex: 1 },
  splitContainerLandscape: { flexDirection: 'row' },
  splitContainerPortrait: { flexDirection: 'column' },
  stagePane: { position: 'relative' },
  headerBar: { position: 'absolute', left: 20, zIndex: 100 },
  reflectionsTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
  newUpdatesButton: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFD700', padding: 8, borderRadius: 20 },
  newUpdatesText: { color: '#000', fontWeight: 'bold' },
  mediaContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  mediaImage: { width: '100%', height: '100%' },
  playOverlay: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, justifyContent: 'center', alignItems: 'center' },
  playButton: { width: 100, height: 100, borderRadius: 50, overflow: 'hidden', justifyContent: 'center', alignItems: 'center' },
  playOverlayBlur: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, borderRadius: 50, justifyContent: 'center', alignItems: 'center' },
  cameraBubble: { position: 'absolute', width: 100, height: 100, borderRadius: 50, overflow: 'hidden', borderWidth: 2, borderColor: '#fff', zIndex: 99999, elevation: 10 },
  cameraPreview: { flex: 1 },
  metadataContainer: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 20, backgroundColor: 'rgba(0,0,0,0.5)' },
  descriptionText: { color: '#fff', fontSize: 18, flex: 1 },
  tellMeMoreFAB: { position: 'absolute', bottom: 100, right: 20, width: 64, height: 64, borderRadius: 32, overflow: 'hidden' },
  tellMeMoreBlur: { flex: 1, width: '100%', justifyContent: 'center', alignItems: 'center' },
  upNextPane: { borderLeftWidth: 1, borderColor: '#333' },
  upNextHeader: { flexDirection: 'row', justifyContent: 'space-between', padding: 10 },
  upNextHeaderText: { color: '#fff', fontWeight: 'bold' },
  upNextCount: { color: '#ccc' },
  upNextItemContainer: { margin: 5 },
  upNextItem: { flexDirection: 'row', padding: 10, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 8 },
  upNextItemNowPlaying: { backgroundColor: 'rgba(0,122,255,0.3)' },
  upNextThumbnail: { width: 50, height: 50, borderRadius: 4, marginRight: 10 },
  upNextTitle: { color: '#fff' },
  upNextTitleNowPlaying: { color: '#4FC3F7', fontWeight: 'bold' },
  upNextDate: { color: '#aaa', fontSize: 12, marginTop: 2 },
  upNextDateNowPlaying: { color: '#4FC3F7' },
  upNextMeta: { color: '#aaa', fontSize: 12, marginTop: 2 },
  upNextMetaNowPlaying: { color: '#4FC3F7', fontWeight: 'bold' },
  reflectionId: { fontSize: 9, color: 'rgba(255,255,255,0.3)', marginTop: 2, fontFamily: 'Courier' },
  upNextInfo: { flex: 1, justifyContent: 'center' },
});