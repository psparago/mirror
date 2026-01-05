import { FontAwesome } from '@expo/vector-icons';
import { Event, EventMetadata } from '@projectmirror/shared';
import { Audio } from 'expo-av';
import { BlurView } from 'expo-blur';
import { CameraView, CameraPermissionResponse } from 'expo-camera';
import { LinearGradient } from 'expo-linear-gradient';
import * as Speech from 'expo-speech';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Image,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
  Alert,
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
  cameraPermission: CameraPermissionResponse | null;
  requestCameraPermission: () => Promise<CameraPermissionResponse>;
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
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseAnimRef = useRef<Animated.CompositeAnimation | null>(null);

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
      console.log(`🚫 Blocked duplicate play for event ${eventId}`);
      return; // Already playing this event, don't restart
    }

    console.log(`🎬 Starting playback for event ${eventId}`);

    // Stop any previous playback
    Speech.stop();
    if (audioPlayer) audioPlayer.pause();

    // Mark this event as playing IMMEDIATELY
    currentPlayingEventIdRef.current = eventId;
    hasSpokenRef.current = true; // Set to true immediately to block duplicates

    const timer = setTimeout(() => {
      // Triple-check we haven't moved to a different event
      if (currentPlayingEventIdRef.current !== eventId) {
        console.log(`⏭️ Skipped - moved to different event`);
        return;
      }

      // Audio message takes priority
      if (selectedEvent.audio_url && typeof selectedEvent.audio_url === 'string' && selectedEvent.audio_url.trim() !== '') {
        console.log(`🎵 Playing audio for event ${eventId}`);
        const playAudio = async () => {
          try {
            // Unload previous sound
            if (sound) {
              await sound.unloadAsync();
            }
            
            // Create and play new sound
            const { sound: newSound } = await Audio.Sound.createAsync(
              { uri: selectedEvent.audio_url },
              { shouldPlay: true },
              (status) => {
                if (status.isLoaded && status.didJustFinish) {
                  // Audio finished, auto-advance
                  const currentIndex = events.findIndex((e) => e.event_id === eventId);
                  if (currentIndex !== -1 && currentIndex < events.length - 1) {
                    const nextEvent = events[currentIndex + 1];
                    if (nextEvent) {
                      setTimeout(() => handleUpNextItemPress(nextEvent), 1500);
                    }
                  }
                }
              }
            );
            setSound(newSound);
            setIsAudioPlaying(true);
          } catch (error) {
            console.error('Error playing audio:', error);
          }
        };
        playAudio();
      } else if (selectedMetadata.description) {
        console.log(`🗣️ Speaking description for event ${eventId}`);
        const textToSpeak = sanitizeTextForTTS(selectedMetadata.description);
        Speech.speak(textToSpeak, {
          volume: 1.0,
          pitch: 1.0,
          rate: 1.0,
          language: 'en-US',
          onDone: () => {
            console.log(`✅ Speech finished for event ${eventId}`);
            // Auto-advance to next video when speech finishes (YouTube behavior)
            const currentIndex = events.findIndex((e) => e.event_id === eventId);
            if (currentIndex !== -1 && currentIndex < events.length - 1) {
              const nextEvent = events[currentIndex + 1];
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

  // Reset state when view unmounts
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
  }, [sound]);

  const playDescription = useCallback(async () => {
    if (!selectedEvent || !selectedMetadata) return;

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
  }, [selectedEvent, selectedMetadata, isAudioPlaying, sound]);

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
    console.log(`👆 User selected event ${event.event_id}`);
    
    // Stop current audio
    Speech.stop();
    if (sound) {
      await sound.unloadAsync();
      setSound(null);
    }
    setIsAudioPlaying(false);
    
    // Reset tracking completely
    hasSpokenRef.current = false;
    currentPlayingEventIdRef.current = null;
    setIsPlayingDeepDive(false);

    // Update to new event - this will trigger the useEffect
    onEventSelect(event);
  };


  const renderUpNextItem = ({ item }: { item: Event }) => {
    const metadata = eventMetadata[item.event_id];
    const isCurrentlyPlaying = item.event_id === selectedEvent?.event_id;

    return (
      <View style={styles.upNextItemContainer}>
        <TouchableOpacity
          style={[styles.upNextItem, isCurrentlyPlaying && styles.upNextItemActive]}
          onPress={() => handleUpNextItemPress(item)}
          activeOpacity={0.7}
          disabled={isCurrentlyPlaying}
        >
          <Image source={{ uri: item.image_url }} style={styles.upNextThumbnail} resizeMode="cover" />
          <View style={styles.upNextInfo}>
            <Text style={styles.upNextTitle} numberOfLines={2}>
              {metadata?.description || 'Reflection'}
            </Text>
            <Text style={styles.upNextMeta}>
              {metadata?.content_type === 'audio' ? '🎤 Voice' : '📸 Photo'}
            </Text>
          </View>
          {isCurrentlyPlaying && (
            <View style={styles.nowPlayingIndicator}>
              <FontAwesome name="play" size={10} color="#fff" />
            </View>
          )}
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

  // Filter out current event from up next list
  const upNextEvents = useMemo(() => {
    const filtered = selectedEvent ? events.filter((e) => e.event_id !== selectedEvent.event_id) : events;
    console.log(`📋 Up Next List: ${filtered.map(e => e.event_id).join(', ')}`);
    return filtered;
  }, [events, selectedEvent?.event_id]);

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
            <View style={styles.mediaContainer}>
              <Image source={{ uri: selectedEvent.image_url }} style={styles.mediaImage} resizeMode="contain" />

              {/* Massive Play/Pause Overlay */}
              {(selectedEvent.audio_url || selectedMetadata?.description) && (
                <TouchableOpacity
                  style={styles.playOverlay}
                  onPress={playDescription}
                  activeOpacity={0.7}
                  onPressIn={() => setPlayButtonPressed(true)}
                  onPressOut={() => setPlayButtonPressed(false)}
                >
                  <BlurView intensity={30} style={styles.playOverlayBlur}>
                    <FontAwesome
                      name={isAudioPlaying ? 'pause' : 'play'}
                      size={64}
                      color="rgba(255, 255, 255, 0.95)"
                    />
                  </BlurView>
                </TouchableOpacity>
              )}
            </View>

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
              data={upNextEvents}
              renderItem={renderUpNextItem}
              keyExtractor={(item) => item.event_id}
              contentContainerStyle={styles.upNextList}
              showsVerticalScrollIndicator={true}
              indicatorStyle="white"
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
    top: '50%',
    left: '50%',
    transform: [{ translateX: -80 }, { translateY: -80 }],
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

