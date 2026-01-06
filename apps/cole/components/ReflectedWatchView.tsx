import { FontAwesome } from '@expo/vector-icons';
import { Event, EventMetadata } from '@projectmirror/shared';
import { Audio } from 'expo-av';
import { BlurView } from 'expo-blur';
import { CameraView, PermissionResponse } from 'expo-camera';
import { LinearGradient } from 'expo-linear-gradient';
import * as Speech from 'expo-speech';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Animated,
    FlatList,
    Image,
    StyleSheet,
    Text,
    TouchableOpacity,
    useWindowDimensions,
    View
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface ReflectedWatchViewProps {
  visible: boolean;
  selectedEvent: Event | null;
  events: Event[];
  eventMetadata: { [key: string]: EventMetadata };
  onClose: () => void;
  onEventSelect: (event: Event) => void;
  onDelete: (event: Event) => void;
  onCaptureSelfie: () => Promise<void>;
  cameraRef: React.RefObject<CameraView>;
  cameraPermission: PermissionResponse | null;
  requestCameraPermission: () => Promise<PermissionResponse>;
  isCapturingSelfie: boolean;
}

export default function ReflectedWatchView({
  visible,
  selectedEvent,
  events,
  eventMetadata,
  onClose,
  onEventSelect,
  onDelete,
  onCaptureSelfie,
  cameraRef,
  cameraPermission,
  requestCameraPermission,
  isCapturingSelfie,
}: ReflectedWatchViewProps) {
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const insets = useSafeAreaInsets();

  const [isPlayingDeepDive, setIsPlayingDeepDive] = useState(false);
  const [playButtonPressed, setPlayButtonPressed] = useState(false);
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);

  const [sound, setSound] = useState<Audio.Sound | null>(null);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const hasSpokenRef = useRef(false);
  const currentPlayingEventIdRef = useRef<string | null>(null);
  const eventsRef = useRef<Event[]>(events); // Always have latest events array
  const selectedEventRef = useRef<Event | null>(selectedEvent); // Always have latest selected event
  const audioAutoAdvanceScheduledRef = useRef(false); // Prevent duplicate audio auto-advance
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseAnimRef = useRef<Animated.CompositeAnimation | null>(null);
  
  // Controls fade animation
  const controlsOpacity = useRef(new Animated.Value(1)).current;
  const controlsFadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flatListRef = useRef<FlatList>(null);

  // Keep refs in sync with props
  useEffect(() => {
    eventsRef.current = events;
  }, [events]);
  
  useEffect(() => {
    selectedEventRef.current = selectedEvent;
  }, [selectedEvent]);

  const selectedMetadata = selectedEvent ? eventMetadata[selectedEvent.event_id] : null;

  // Sanitize text for TTS
  const sanitizeTextForTTS = (text: string): string => {
    return text
      .replace(/!/g, '.')
      .replace(/\?/g, '.')
      .replace(/;/g, ',')
      .replace(/:/g, ',')
      .replace(/\.\.\./g, '.')
      .replace(/\.{2,}/g, '.')
      .replace(/,{2,}/g, ',')
      .replace(/\s+/g, ' ')
      .trim();
  };

  // Get image dimensions when event changes
  useEffect(() => {
    if (selectedEvent?.image_url) {
      Image.getSize(
        selectedEvent.image_url,
        (imgWidth, imgHeight) => {
          setImageDimensions({ width: imgWidth, height: imgHeight });
        },
        (error) => {
          console.warn('Failed to get image dimensions:', error);
        }
      );
    } else {
      setImageDimensions(null);
    }
  }, [selectedEvent?.image_url]);

  // Auto-play description/audio when event changes
  useEffect(() => {
    if (!selectedEvent || !selectedMetadata) {
      return;
    }

    const eventId = selectedEvent.event_id;

    // Check if this event is already playing
    if (currentPlayingEventIdRef.current === eventId && hasSpokenRef.current) {
      return; // Already playing this event, don't restart
    }

    // Stop any previous playback
    Speech.stop();
    if (sound) {
      // Remove status update listener before unloading
      sound.setOnPlaybackStatusUpdate(null);
      sound.unloadAsync().catch(err => console.warn('Error unloading sound:', err));
      setSound(null);
    }

    // Mark this event as playing IMMEDIATELY
    currentPlayingEventIdRef.current = eventId;
    hasSpokenRef.current = true; // Set to true immediately to block duplicates

    const timer = setTimeout(() => {
      // Triple-check we haven't moved to a different event
      if (currentPlayingEventIdRef.current !== eventId) {
        return;
      }

      // Audio message takes priority
      if (selectedEvent.audio_url && typeof selectedEvent.audio_url === 'string' && selectedEvent.audio_url.trim() !== '') {
        audioAutoAdvanceScheduledRef.current = false; // Reset flag for new audio
        const playAudio = async () => {
          try {
            // Unload previous sound
            if (sound) {
              await sound.unloadAsync();
            }
            
            // Create and play new sound
            const { sound: newSound } = await Audio.Sound.createAsync(
              { uri: selectedEvent.audio_url as string },
              { shouldPlay: true }
            );
            
            // Set up status update handler to detect when audio finishes
            newSound.setOnPlaybackStatusUpdate((status) => {
              if (status.isLoaded && status.didJustFinish) {
                // Prevent duplicate auto-advance triggers (callback fires multiple times)
                if (audioAutoAdvanceScheduledRef.current) {
                  return;
                }
                audioAutoAdvanceScheduledRef.current = true;
                
                // Guard: Only auto-advance if this event is STILL the current one
                if (currentPlayingEventIdRef.current !== eventId) {
                  return;
                }
                
                // Auto-advance: Use refs to get LATEST state (not stale closure)
                const latestEvents = eventsRef.current;
                const currentPlayingEvent = selectedEventRef.current;
                if (!currentPlayingEvent) return;
                
                const currentIndex = latestEvents.findIndex((e) => e.event_id === currentPlayingEvent.event_id);                
                if (currentIndex !== -1) {
                  // Loop: if at end, go to beginning; otherwise go to next
                  const nextIndex = currentIndex < latestEvents.length - 1 ? currentIndex + 1 : 0;
                  const nextEvent = latestEvents[nextIndex];
                  if (nextEvent) {
                    setTimeout(() => handleUpNextItemPress(nextEvent), 1500);
                  }
                }
              }
            });
            
            setSound(newSound);
            setIsAudioPlaying(true);
          } catch (error) {
            console.error('Error playing audio:', error);
          }
        };
        playAudio();
      } else if (selectedMetadata.description) {
        const textToSpeak = sanitizeTextForTTS(selectedMetadata.description);
        Speech.speak(textToSpeak, {
          volume: 1.0,
          pitch: 1.0,
          rate: 1.0,
          language: 'en-US',
          onDone: () => {
            // Guard: Only auto-advance if this event is STILL the current one
            if (currentPlayingEventIdRef.current !== eventId) {
              return;
            }
            
            // Auto-advance: Use refs to get LATEST state (not stale closure)
            const latestEvents = eventsRef.current;
            const currentPlayingEvent = selectedEventRef.current;
            if (!currentPlayingEvent) return;
            
            const currentIndex = latestEvents.findIndex((e) => e.event_id === currentPlayingEvent.event_id);            
            if (currentIndex !== -1) {
              // Loop: if at end, go to beginning; otherwise go to next
              const nextIndex = currentIndex < latestEvents.length - 1 ? currentIndex + 1 : 0;
              const nextEvent = latestEvents[nextIndex];
              if (nextEvent) {
                setTimeout(() => handleUpNextItemPress(nextEvent), 1500);
              }
            }
          },
        });
      }
    }, 150);

    return () => {
      clearTimeout(timer);
    };
  }, [selectedEvent?.event_id]);
  // Animate Tell Me More button
  useEffect(() => {
    if (isPlayingDeepDive) {
      pulseAnimRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.15,
            duration: 600,
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

  // Reset state when view unmounts (empty deps = runs only on unmount)
  useEffect(() => {
    return () => {
      setIsPlayingDeepDive(false);
      setPlayButtonPressed(false);
      hasSpokenRef.current = false;
      currentPlayingEventIdRef.current = null;
      Speech.stop();
      if (sound) {
        sound.unloadAsync();
      }
    };
  }, []); // Empty deps - only run on mount/unmount, not when sound changes

  // Show controls and start fade timer
  const showControls = useCallback(() => {
    // Clear any existing timer
    if (controlsFadeTimer.current) {
      clearTimeout(controlsFadeTimer.current);
    }

    // Fade controls in
    Animated.timing(controlsOpacity, {
      toValue: 1,
      duration: 200,
      useNativeDriver: true,
    }).start();

    // Set timer to fade out after 3 seconds
    controlsFadeTimer.current = setTimeout(() => {
      Animated.timing(controlsOpacity, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }).start();
    }, 3000);
  }, [controlsOpacity]);

  const playDescription = useCallback(async () => {
    if (!selectedEvent || !selectedMetadata) return;

    // Show controls when user interacts
    showControls();

    if (isAudioPlaying) {
      if (sound) await sound.pauseAsync();
      setIsAudioPlaying(false);
      Speech.stop();
      setIsPlayingDeepDive(false);
    } else {
      if (selectedEvent.audio_url && typeof selectedEvent.audio_url === 'string' && selectedEvent.audio_url.trim() !== '') {
        try {
          if (sound) {
            await sound.playAsync();
            setIsAudioPlaying(true);
          }
        } catch (error) {
          console.error('Error playing audio:', error);
        }
      } else if (selectedMetadata.description) {
        const textToSpeak = sanitizeTextForTTS(selectedMetadata.description);
        Speech.speak(textToSpeak, {
          volume: 1.0,
          pitch: 1.0,
          rate: 1.0,
          language: 'en-US',
        });
      }
    }
  }, [selectedEvent, selectedMetadata, isAudioPlaying, sound, showControls]);

  const playDeepDive = useCallback(() => {
    if (!selectedMetadata?.deep_dive) return;

    if (isPlayingDeepDive) {
      Speech.stop();
      setIsPlayingDeepDive(false);
    } else {
      const textToSpeak = sanitizeTextForTTS(selectedMetadata.deep_dive);
      Speech.speak(textToSpeak, {
        volume: 1.0,
        pitch: 1.0,
        rate: 1.0,
        language: 'en-US',
      });
      setIsPlayingDeepDive(true);
    }
  }, [selectedMetadata?.deep_dive, isPlayingDeepDive]);

  const handleUpNextItemPress = async (event: Event) => {
    // Stop current audio
    Speech.stop();
    if (sound) {
      await sound.unloadAsync();
      setSound(null);
    }
    setIsAudioPlaying(false);
    
    // Reset tracking (don't null currentPlayingEventIdRef - it will be updated by next event's useEffect)
    hasSpokenRef.current = false;
    setIsPlayingDeepDive(false);

    // Update to new event - this will trigger the useEffect which will set currentPlayingEventIdRef
    onEventSelect(event);
    
    // Scroll to the newly selected item (optional but nice UX)
    const itemIndex = events.findIndex((e) => e.event_id === event.event_id);
    if (itemIndex !== -1 && flatListRef.current) {
      setTimeout(() => {
        flatListRef.current?.scrollToIndex({ index: itemIndex, animated: true, viewPosition: 0.5 });
      }, 100);
    }
  };


  const renderUpNextItem = ({ item, index }: { item: Event; index: number }) => {
    const metadata = eventMetadata[item.event_id];
    const isNowPlaying = item.event_id === selectedEvent?.event_id;

    return (
      <View style={styles.upNextItemContainer}>
        <TouchableOpacity
          style={[
            styles.upNextItem,
            isNowPlaying && styles.upNextItemNowPlaying
          ]}
          onPress={() => handleUpNextItemPress(item)}
          activeOpacity={0.7}
          disabled={isNowPlaying} // Disable tap on currently playing item
        >
          <Image source={{ uri: item.image_url }} style={styles.upNextThumbnail} resizeMode="cover" />
          <View style={styles.upNextInfo}>
            <Text style={[styles.upNextTitle, isNowPlaying && styles.upNextTitleNowPlaying]} numberOfLines={2}>
              {isNowPlaying && '▶️ '}{metadata?.description || 'Reflection'}
            </Text>
            <Text style={[styles.upNextMeta, isNowPlaying && styles.upNextMetaNowPlaying]}>
              {metadata?.content_type === 'audio' ? '🎤 Voice' : '📸 Photo'}
              {isNowPlaying && ' • NOW PLAYING'}
            </Text>
          </View>
        </TouchableOpacity>
        
        {/* Hamburger Menu for Delete */}
        <TouchableOpacity
          style={styles.hamburgerMenu}
          onPress={() => {
            Alert.alert(
              'Delete Reflection',
              'Are you sure you want to delete this reflection?',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete',
                  style: 'destructive',
                  onPress: () => onDelete(item),
                },
              ]
            );
          }}
          activeOpacity={0.7}
        >
          <FontAwesome name="ellipsis-v" size={16} color="rgba(255, 255, 255, 0.7)" />
        </TouchableOpacity>
      </View>
    );
  };

  // Keep list static - don't reorder, just highlight the playing item in place
  const upNextEvents = useMemo(() => {
    // Return events in their original order (sorted by timestamp)
    return events;
  }, [events]);

  // If no event is selected yet, show loading state
  if (!selectedEvent) {
    return (
      <LinearGradient colors={['#0f2027', '#203a43', '#2c5364']} style={styles.modalContainer}>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={{ color: '#fff', marginTop: 16, fontSize: 18 }}>Loading Reflections...</Text>
        </View>
      </LinearGradient>
    );
  }

  return (
    <LinearGradient colors={['#0f2027', '#203a43', '#2c5364']} style={styles.modalContainer}>
        <View
          style={[
            styles.splitContainer,
            isLandscape ? styles.splitContainerLandscape : styles.splitContainerPortrait,
          ]}
        >
          {/* LEFT PANE: The Stage */}
          <View style={[styles.stagePane, isLandscape ? { flex: 0.7 } : { flex: 0.4 }]}>
            {/* Back to Reflections List Button - only show if there are multiple events */}
            {events.length > 1 && (
              <View style={[styles.headerBar, { top: insets.top + 10 }]}>
                <Text style={styles.reflectionsTitle}>Reflections</Text>
              </View>
            )}

            {/* Media Container */}
            <TouchableOpacity 
              style={styles.mediaContainer} 
              activeOpacity={1}
              onPress={showControls}
            >
              <Image source={{ uri: selectedEvent.image_url }} style={styles.mediaImage} resizeMode="cover" />

              {/* Animated Play/Pause Overlay - Fades out after 3 seconds */}
              {(selectedEvent.audio_url || selectedMetadata?.description) && (
                <Animated.View style={[styles.playOverlay, { opacity: controlsOpacity }]} pointerEvents="box-none">
                  <TouchableOpacity
                    onPress={playDescription}
                    activeOpacity={0.7}
                    style={styles.playButton}
                  >
                    <BlurView intensity={30} style={styles.playOverlayBlur}>
                      <FontAwesome
                        name={isAudioPlaying ? 'pause' : 'play'}
                        size={64}
                        color="rgba(255, 255, 255, 0.95)"
                      />
                    </BlurView>
                  </TouchableOpacity>
                </Animated.View>
              )}
            </TouchableOpacity>
            
            {/* Selfie Camera Bubble - Bottom Right */}
            {cameraPermission?.granted ? (
              <View style={[styles.cameraBubble, { bottom: insets.bottom + 100 }]}>
                <CameraView 
                  ref={cameraRef}
                  style={styles.cameraPreview}
                  facing="front"
                />
                <TouchableOpacity 
                  style={styles.cameraButton}
                  onPress={onCaptureSelfie}
                  activeOpacity={0.8}
                  disabled={isCapturingSelfie}
                >
                  <BlurView intensity={50} style={styles.cameraButtonBlur}>
                    {isCapturingSelfie ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <FontAwesome name="camera" size={20} color="#fff" />
                    )}
                  </BlurView>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={[styles.cameraBubble, { bottom: insets.bottom + 100 }]}>
                <TouchableOpacity 
                  style={styles.enableCameraButton}
                  onPress={requestCameraPermission}
                  activeOpacity={0.8}
                >
                  <BlurView intensity={50} style={styles.enableCameraBlur}>
                    <FontAwesome name="camera" size={24} color="#fff" />
                    <Text style={styles.enableCameraText}>Enable{'\n'}Camera</Text>
                  </BlurView>
                </TouchableOpacity>
              </View>
            )}

            {/* Metadata & Controls */}
            <View style={[styles.metadataContainer, { paddingBottom: insets.bottom + 16 }]}>
              <Text style={styles.descriptionText} numberOfLines={3}>
                {selectedMetadata?.content_type === 'audio' || selectedEvent.audio_url
                  ? '🎤 Voice message'
                  : selectedMetadata?.description || 'Reflection'}
              </Text>

              {/* Tell Me More FAB */}
              {selectedMetadata?.deep_dive && (
                <Animated.View style={[styles.tellMeMoreFAB, { transform: [{ scale: pulseAnim }] }]}>
                  <TouchableOpacity onPress={playDeepDive} activeOpacity={0.8} disabled={isPlayingDeepDive}>
                    <BlurView intensity={50} style={styles.tellMeMoreBlur}>
                      <Text style={styles.tellMeMoreIcon}>✨</Text>
                    </BlurView>
                  </TouchableOpacity>
                </Animated.View>
              )}
            </View>
          </View>

          {/* RIGHT PANE: The Rabbit Hole (Up Next) */}
          <View
            style={[
              styles.upNextPane,
              isLandscape ? { flex: 0.3 } : { flex: 0.6 },
              { paddingTop: insets.top + 10 },
            ]}
          >
            <View style={styles.upNextHeader}>
              <Text style={styles.upNextHeaderText}>Up Next</Text>
              <Text style={styles.upNextCount}>{upNextEvents.length}</Text>
            </View>
            <FlatList
              ref={flatListRef}
              data={upNextEvents}
              renderItem={renderUpNextItem}
              keyExtractor={(item) => item.event_id}
              extraData={selectedEvent?.event_id}
              contentContainerStyle={styles.upNextList}
              showsVerticalScrollIndicator={true}
              indicatorStyle="white"
              onScrollToIndexFailed={(info) => {
                // Fallback if scrollToIndex fails
                const wait = new Promise(resolve => setTimeout(resolve, 100));
                wait.then(() => {
                  flatListRef.current?.scrollToIndex({ index: info.index, animated: true, viewPosition: 0.5 });
                });
              }}
            />
          </View>
        </View>
      </LinearGradient>
  );
}

const styles = StyleSheet.create({
  modalContainer: {
    flex: 1,
  },
  splitContainer: {
    flex: 1,
  },
  splitContainerLandscape: {
    flexDirection: 'row',
  },
  splitContainerPortrait: {
    flexDirection: 'column',
  },

  // STAGE PANE (Left/Top)
  stagePane: {
    position: 'relative',
  },
  headerBar: {
    position: 'absolute',
    left: 20,
    zIndex: 100,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 12,
  },
  reflectionsTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  mediaContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  mediaImage: {
    width: '100%',
    height: '100%',
  },
  playOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  playButton: {
    width: 160,
    height: 160,
    borderRadius: 80,
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
  playOverlayBlur: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 80,
  },
  cameraBubble: {
    position: 'absolute',
    right: 20,
    width: 120,
    height: 120,
    borderRadius: 60,
    overflow: 'hidden',
    borderWidth: 3,
    borderColor: 'rgba(255, 255, 255, 0.3)',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  cameraPreview: {
    width: '100%',
    height: '100%',
  },
  cameraButton: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    width: 44,
    height: 44,
    borderRadius: 22,
    overflow: 'hidden',
  },
  cameraButtonBlur: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 22,
  },
  enableCameraButton: {
    width: '100%',
    height: '100%',
    borderRadius: 60,
    overflow: 'hidden',
  },
  enableCameraBlur: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 60,
  },
  enableCameraText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 4,
  },
  metadataContainer: {
    paddingHorizontal: 20,
    paddingTop: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
  },
  descriptionText: {
    fontSize: 22,
    fontWeight: '600',
    color: '#fff',
    marginBottom: 16,
    lineHeight: 28,
  },
  tellMeMoreFAB: {
    position: 'absolute',
    bottom: 100,
    right: 20,
    width: 64,
    height: 64,
    borderRadius: 32,
    overflow: 'hidden',
  },
  tellMeMoreBlur: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 32,
  },
  tellMeMoreIcon: {
    fontSize: 32,
  },

  // UP NEXT PANE (Right/Bottom)
  upNextPane: {
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    borderLeftWidth: 1,
    borderLeftColor: 'rgba(255, 255, 255, 0.1)',
  },
  upNextHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.1)',
  },
  upNextHeaderText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#fff',
  },
  upNextCount: {
    fontSize: 14,
    fontWeight: '600',
    color: 'rgba(255, 255, 255, 0.6)',
  },
  upNextList: {
    paddingVertical: 8,
  },
  upNextItemContainer: {
    position: 'relative',
    marginVertical: 4,
    marginHorizontal: 8,
  },
  upNextItem: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 8,
    paddingRight: 40, // Make room for hamburger menu
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  upNextItemActive: {
    backgroundColor: 'rgba(211, 47, 47, 0.3)',
    borderWidth: 1,
    borderColor: 'rgba(211, 47, 47, 0.6)',
  },
  upNextThumbnail: {
    width: 80,
    height: 80,
    borderRadius: 8,
    marginRight: 12,
  },
  upNextInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  upNextTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
    marginBottom: 4,
  },
  upNextMeta: {
    fontSize: 12,
    color: 'rgba(255, 255, 255, 0.6)',
  },
  upNextItemNowPlaying: {
    backgroundColor: 'rgba(30, 144, 255, 0.25)', // Blue highlight for now playing
    borderWidth: 2,
    borderColor: 'rgba(30, 144, 255, 0.6)',
  },
  upNextTitleNowPlaying: {
    color: '#4FC3F7', // Bright blue for visibility
    fontWeight: '700',
  },
  upNextMetaNowPlaying: {
    color: 'rgba(79, 195, 247, 0.9)',
  },
  nowPlayingIndicator: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: '#d32f2f',
    width: 24,
    height: 24,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  hamburgerMenu: {
    position: 'absolute',
    right: 8,
    top: 0,
    bottom: 0,
    width: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
});

