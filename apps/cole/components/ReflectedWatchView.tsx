import { FontAwesome } from '@expo/vector-icons';
import { Event, EventMetadata } from '@projectmirror/shared';
import { Audio } from 'expo-av';
import { BlurView } from 'expo-blur';
import { CameraView, PermissionResponse } from 'expo-camera';
import { LinearGradient } from 'expo-linear-gradient';
import * as Speech from 'expo-speech';
import { useVideoPlayer, VideoView } from 'expo-video';
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

// Config
const AUTO_SHOW_SELFIE_MIRROR = true;

interface ReflectedWatchViewProps {
  visible: boolean;
  selectedEvent: Event | null;
  events: Event[];
  eventMetadata: { [key: string]: EventMetadata };
  onClose: () => void;
  onEventSelect: (event: Event) => void;
  onDelete: (event: Event) => void;
  onCaptureSelfie: () => Promise<void>;
  onMediaError?: (event: Event) => void; // Callback when media fails to load (e.g., expired URLs)
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
  onMediaError,
  cameraRef,
  cameraPermission,
  requestCameraPermission,
  isCapturingSelfie,
}: ReflectedWatchViewProps) {
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const insets = useSafeAreaInsets();

  const [isPlayingDeepDive, setIsPlayingDeepDive] = useState(false);

  // Audio playback state
  const [sound, setSound] = useState<Audio.Sound | null>(null);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);

  // Video playback state  
  const [isVideoPlaying, setIsVideoPlaying] = useState(false);
  const [videoFinished, setVideoFinished] = useState(false);
  const [isSpeakingCaption, setIsSpeakingCaption] = useState(false);

  // Get metadata for selected event (needed for video source check)
  const selectedMetadata = selectedEvent ? eventMetadata[selectedEvent.event_id] : null;

  // Initialize video player with current event's video URL
  const videoSource = selectedMetadata?.content_type === 'video' && selectedEvent?.video_url
    ? selectedEvent.video_url
    : null;

  const player = useVideoPlayer(videoSource || '', (player) => {
    // Status update callback
    setIsVideoPlaying(player.playing);

    // Check if video finished (idle status after playing)
    if (player.status === 'idle' && player.currentTime > 0 && !videoFinished) {
      handleVideoFinished();
    }
  });

  // Tracking refs
  const hasSpokenRef = useRef(false);
  const currentPlayingEventIdRef = useRef<string | null>(null);
  const eventsRef = useRef<Event[]>(events);
  const selectedEventRef = useRef<Event | null>(selectedEvent);
  const audioAutoAdvanceScheduledRef = useRef(false);

  // Animation refs
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseAnimRef = useRef<Animated.CompositeAnimation | null>(null);
  const controlsOpacity = useRef(new Animated.Value(1)).current; // Start visible (paused state)
  const selfieMirrorOpacity = useRef(new Animated.Value(1)).current; // Start visible by default
  const selfieTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // UI refs
  const flatListRef = useRef<FlatList>(null);

  // "One Voice" locking rule: controls locked while video is playing
  const areControlsLocked = isVideoPlaying;

  // Track player's playing state and sync with component state
  useEffect(() => {
    if (!player) return;

    const checkPlaying = () => {
      setIsVideoPlaying(player.playing);
    };

    // Check immediately
    checkPlaying();

    // Set up interval to poll player state (expo-video callback may not always fire)
    const interval = setInterval(checkPlaying, 100);

    return () => clearInterval(interval);
  }, [player, videoSource]);

  // Keep refs in sync with props
  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  useEffect(() => {
    selectedEventRef.current = selectedEvent;
  }, [selectedEvent]);

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

  // "KILL SWITCH" + "Context First" Entry Sequence
  useEffect(() => {
    if (!selectedEvent || !selectedMetadata) {
      return;
    }

    const eventId = selectedEvent.event_id;

    // Check if this event is already playing
    if (currentPlayingEventIdRef.current === eventId && hasSpokenRef.current) {
      return;
    }

    // ═══ KILL SWITCH ═══
    // IMMEDIATELY stop all playback from previous event
    Speech.stop();
    if (sound) {
      sound.setOnPlaybackStatusUpdate(null);
      sound.unloadAsync().catch(err => console.warn('Error unloading sound:', err));
      setSound(null);
    }
    if (player && videoSource) {
      try {
        player.pause();
      } catch (err) {
        console.warn('Error pausing video:', err);
      }
    }
    if (selfieTimerRef.current) {
      clearTimeout(selfieTimerRef.current);
      selfieTimerRef.current = null;
    }

    // Reset state
    setIsAudioPlaying(false);
    setIsVideoPlaying(false);
    setVideoFinished(false);
    setIsSpeakingCaption(false);
    setIsPlayingDeepDive(false);

    // Reset selfie mirror: visible by default, or fade in for videos
    const isVideoContent = selectedMetadata?.content_type === 'video';
    selfieMirrorOpacity.setValue(isVideoContent ? 0 : 1);

    // Mark this event as current
    currentPlayingEventIdRef.current = eventId;
    hasSpokenRef.current = true;
    audioAutoAdvanceScheduledRef.current = false;

    const timer = setTimeout(() => {
      if (currentPlayingEventIdRef.current !== eventId) {
        return;
      }

      const hasVideo = selectedMetadata.content_type === 'video';
      const hasAudio = selectedEvent.audio_url && typeof selectedEvent.audio_url === 'string' && selectedEvent.audio_url.trim() !== '';
      const hasCaption = selectedMetadata.description;



      // ═══ CONTEXT FIRST LOGIC (with brief initial delay) ═══
      if (hasVideo) {
        // Video content: Play audio caption OR speak text caption, then auto-play video
        if (hasAudio) {
          // Video with VOICE caption: play audio first, then video
          const playAudioThenVideo = async () => {
            try {
              if (sound) {
                await sound.unloadAsync();
              }

              const { sound: newSound } = await Audio.Sound.createAsync(
                { uri: selectedEvent.audio_url as string },
                { shouldPlay: true }
              );

              newSound.setOnPlaybackStatusUpdate((status) => {
                if (!status.isLoaded) return;

                // When audio finishes, start the video
                if (status.didJustFinish) {
                  if (currentPlayingEventIdRef.current === eventId && player && videoSource) {
                    try {
                      player.play();
                    } catch (err) {
                      console.warn('Error auto-starting video after audio caption:', err);
                    }
                  }
                }
              });

              setSound(newSound);
              setIsAudioPlaying(true);
            } catch (error) {
              console.error('Error playing audio caption:', error);
              // Fallback: just play video
              if (player && videoSource) {
                player.play();
              }
            }
          };

          setTimeout(() => {
            if (currentPlayingEventIdRef.current === eventId) {
              playAudioThenVideo();
            }
          }, 500);
        } else if (hasCaption) {
          // Video with TEXT caption: speak it, then play video
          setIsSpeakingCaption(true);
          const textToSpeak = sanitizeTextForTTS(selectedMetadata.description);
          Speech.speak(textToSpeak, {
            volume: 1.0,
            pitch: 1.0,
            rate: 1.0,
            language: 'en-US',
            onDone: () => {
              setIsSpeakingCaption(false);
              // Auto-start video after caption finishes
              if (currentPlayingEventIdRef.current === eventId && player && videoSource) {
                try {
                  player.play();
                } catch (err) {
                  console.warn('Error auto-starting video after caption:', err);
                }
              }
            },
          });
        } else {
          // No caption: auto-start video after brief pause
          setTimeout(() => {
            if (currentPlayingEventIdRef.current === eventId && player && videoSource) {
              try {
                player.play();
              } catch (err) {
                console.warn('Error auto-starting video:', err);
              }
            }
          }, 500);
        }
      } else if (hasAudio) {
        // Audio recording: Skip caption, just auto-play audio after brief pause
        // (No need to speak "Voice message" when they're about to hear the actual voice)
        setTimeout(() => {
          if (currentPlayingEventIdRef.current === eventId) {
            playAudioNow();
          }
        }, 500);

        // Audio playback function
        const playAudioNow = async () => {
          audioAutoAdvanceScheduledRef.current = false;
          try {
            if (sound) {
              await sound.unloadAsync();
            }

            const { sound: newSound } = await Audio.Sound.createAsync(
              { uri: selectedEvent.audio_url as string },
              { shouldPlay: true } // Auto-play
            );

            newSound.setOnPlaybackStatusUpdate((status) => {
              if (!status.isLoaded) {
                // Check if it's an error status (URL expired, etc.)
                if ('error' in status) {
                  console.log('🔄 Audio failed to load (likely expired URL), refreshing...');
                  if (onMediaError && selectedEvent) {
                    onMediaError(selectedEvent);
                  }
                }
                return;
              }

              // Update state to match actual playback
              setIsAudioPlaying(status.isPlaying);

              // Handle audio finish
              if (status.didJustFinish) {
                if (audioAutoAdvanceScheduledRef.current) return;
                audioAutoAdvanceScheduledRef.current = true;

                if (currentPlayingEventIdRef.current !== eventId) return;

                // Audio finished
                setIsAudioPlaying(false);
              }
            });

            setSound(newSound);
            setIsAudioPlaying(true);
          } catch (error: any) {
            // Check if this is a URL expiration error
            const errorMessage = error?.message || String(error);
            if (errorMessage.includes('-1102') || errorMessage.includes('NSURLErrorDomain') || errorMessage.includes('failed')) {
              console.log('🔄 Audio URL expired during auto-play, refreshing...');
              if (onMediaError && selectedEvent) {
                onMediaError(selectedEvent);
              }
            } else {
              console.error('Error playing audio:', error);
            }
          }
        };
      } else if (hasCaption) {
        // Just a photo with caption: speak it (after brief pause)
        setTimeout(() => {
          if (currentPlayingEventIdRef.current === eventId) {
            setIsSpeakingCaption(true);
            const textToSpeak = sanitizeTextForTTS(selectedMetadata.description);
            Speech.speak(textToSpeak, {
              volume: 1.0,
              pitch: 1.0,
              rate: 1.0,
              language: 'en-US',
              onDone: () => {
                setIsSpeakingCaption(false);
              },
            });
          }
        }, 500);
      }
    }, 150);

    return () => {
      clearTimeout(timer);
    };
  }, [selectedEvent?.event_id]);

  // Control visibility functions
  const showControls = useCallback(() => {
    Animated.timing(controlsOpacity, {
      toValue: 1,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [controlsOpacity]);

  const hideControls = useCallback(() => {
    Animated.timing(controlsOpacity, {
      toValue: 0,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [controlsOpacity]);

  // Video playback status handler
  // Helper function for video finished state
  const handleVideoFinished = useCallback(() => {
    const eventId = selectedEvent?.event_id;
    if (!eventId || currentPlayingEventIdRef.current !== eventId) return;

    if (!videoFinished) {
      setVideoFinished(true);
      setIsVideoPlaying(false);
      showControls(); // Show replay button

      // Start pulse animation on sparkle button (visual prompt)
      if (selectedMetadata?.deep_dive) {
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
      }

      // NO auto-advance - Cole must manually select next video (no doom scrolling)
    }
  }, [videoFinished, selectedEvent?.event_id, selectedMetadata, showControls]);

  // Track video playing state changes for auto-selfie timer
  useEffect(() => {
    if (isVideoPlaying && selectedMetadata?.content_type === 'video') {
      hideControls(); // Hide play button when video starts

      // ═══ AUTO-SELFIE TIMER ═══
      // Fade in selfie mirror 5 seconds after video STARTS playing
      if (AUTO_SHOW_SELFIE_MIRROR && !selfieTimerRef.current) {
        selfieTimerRef.current = setTimeout(() => {
          Animated.timing(selfieMirrorOpacity, {
            toValue: 1,
            duration: 500,
            useNativeDriver: true,
          }).start();
        }, 5000);
      }
    } else if (!isVideoPlaying && selectedMetadata?.content_type === 'video') {
      showControls(); // Show play button when video pauses
    }
  }, [isVideoPlaying, selectedMetadata, hideControls, showControls]);

  // Animate sparkle button when deep dive is playing OR post-roll
  useEffect(() => {
    if (isPlayingDeepDive || videoFinished) {
      if (!pulseAnimRef.current) {
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
      }
    } else {
      if (pulseAnimRef.current) {
        pulseAnimRef.current.stop();
        pulseAnimRef.current = null;
      }
      pulseAnim.setValue(1);
    }

    return () => {
      if (pulseAnimRef.current) {
        pulseAnimRef.current.stop();
        pulseAnimRef.current = null;
      }
    };
  }, [isPlayingDeepDive, videoFinished]);

  // Reset state when view unmounts (empty deps = runs only on unmount)
  useEffect(() => {
    return () => {
      setIsPlayingDeepDive(false);
      hasSpokenRef.current = false;
      currentPlayingEventIdRef.current = null;
      Speech.stop();
      if (sound) {
        sound.unloadAsync();
      }
      if (player && videoSource) {
        try {
          player.pause();
        } catch (err) {
          console.warn('Error pausing video on cleanup:', err);
        }
      }
      if (selfieTimerRef.current) {
        clearTimeout(selfieTimerRef.current);
      }
    };
  }, []); // Empty deps - only run on mount/unmount

  const toggleVideo = useCallback(() => {
    if (!player || !videoSource || selectedMetadata?.content_type !== 'video') return;

    try {
      if (isVideoPlaying) {
        player.pause();
        showControls(); // Show button when paused
      } else {
        // Reset post-roll state if replaying
        if (videoFinished) {
          setVideoFinished(false);
          player.currentTime = 0; // Seek to beginning
          player.play();
        } else {
          player.play();
        }
        hideControls(); // Hide button when playing
      }
    } catch (err) {
      console.warn('Error toggling video:', err);
    }
  }, [player, videoSource, isVideoPlaying, videoFinished, selectedMetadata, showControls, hideControls]);

  const playDescription = useCallback(async () => {
    if (!selectedEvent || !selectedMetadata) return;
    // ONE VOICE: Cannot trigger caption while video is playing
    if (areControlsLocked) return;

    // Only handle video playback - audio auto-plays, photos are not interactive
    if (selectedMetadata.content_type === 'video') {
      toggleVideo();
    }
  }, [selectedEvent, selectedMetadata, areControlsLocked, toggleVideo]);

  const playDeepDive = useCallback(() => {
    if (!selectedMetadata?.deep_dive) return;
    // ONE VOICE: Cannot trigger deep dive while video is playing
    if (areControlsLocked) return;

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
  }, [selectedMetadata?.deep_dive, isPlayingDeepDive, areControlsLocked]);

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


  // Format event timestamp with relative or absolute date
  const formatEventDate = (eventId: string): string => {
    const timestamp = parseInt(eventId, 10);
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return 'today';
    } else if (diffDays === 1) {
      return 'yesterday';
    } else {
      // Show formatted date and time for older items
      const dateStr = date.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric'
      });
      const timeStr = date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });
      return `${dateStr}, ${timeStr}`;
    }
  };

  const renderUpNextItem = ({ item, index }: { item: Event; index: number }) => {
    const metadata = eventMetadata[item.event_id];
    const isNowPlaying = item.event_id === selectedEvent?.event_id;
    const dateStr = formatEventDate(item.event_id);

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
            <Text style={[styles.upNextDate, isNowPlaying && styles.upNextDateNowPlaying]}>
              {dateStr}
            </Text>
            <Text style={[styles.upNextMeta, isNowPlaying && styles.upNextMetaNowPlaying]}>
              {metadata?.content_type === 'video' ? '🎥 Video' : metadata?.content_type === 'audio' ? '🎤 Voice' : '📸 Photo'}
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

          {/* Media Container - Tap to pause/play for videos only (photos and audio not interactive) */}
          <TouchableOpacity
            style={styles.mediaContainer}
            activeOpacity={1}
            onPress={selectedMetadata?.content_type === 'video' ? playDescription : undefined}
            disabled={selectedMetadata?.content_type !== 'video'}
          >
            {selectedMetadata?.content_type === 'video' && videoSource ? (
              <VideoView
                player={player}
                style={styles.mediaImage}
                contentFit="cover"
                nativeControls={false}
              />
            ) : selectedMetadata?.content_type === 'video' ? (
              <ActivityIndicator size="large" color="#fff" />
            ) : (
              <Image
                source={{ uri: selectedEvent.image_url }}
                style={styles.mediaImage}
                resizeMode="cover"
                onError={(error) => {
                  console.warn('Image load error (possibly expired URL):', error);
                  if (onMediaError && selectedEvent) {
                    onMediaError(selectedEvent);
                  }
                }}
              />
            )}

            {/* Play/Pause Button - Only for videos (not photos or audio) */}
            {selectedMetadata?.content_type === 'video' && (
              <Animated.View style={[styles.playOverlay, { opacity: controlsOpacity }]} pointerEvents="box-none">
                <TouchableOpacity
                  onPress={playDescription}
                  activeOpacity={0.7}
                  style={styles.playButton}
                >
                  <BlurView intensity={30} style={styles.playOverlayBlur}>
                    <FontAwesome
                      name={videoFinished ? 'refresh' : (isVideoPlaying ? 'pause' : 'play')}
                      size={64}
                      color="rgba(255, 255, 255, 0.95)"
                    />
                  </BlurView>
                </TouchableOpacity>
              </Animated.View>
            )}
          </TouchableOpacity>

          {/* Selfie Camera Bubble - Auto-shows 5s after video starts */}
          {cameraPermission?.granted ? (
            <Animated.View style={[styles.cameraBubble, { bottom: insets.bottom + 100, opacity: selfieMirrorOpacity }]}>
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
            </Animated.View>
          ) : (
            <Animated.View style={[styles.cameraBubble, { bottom: insets.bottom + 100, opacity: selfieMirrorOpacity }]}>
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
            </Animated.View>
          )}

          {/* Metadata & Controls */}
          <View style={[styles.metadataContainer, { paddingBottom: insets.bottom + 16 }]}>
            {/* Caption with inline TTS button for items with description (no audio) */}
            {selectedMetadata?.description && !selectedEvent.audio_url ? (
              <View style={styles.captionRow}>
                <Text style={[styles.descriptionText, { flex: 1, marginBottom: 0 }]} numberOfLines={3}>
                  {selectedMetadata.description}
                </Text>
                <TouchableOpacity
                  onPress={() => {
                    if (areControlsLocked) return;
                    if (isSpeakingCaption) {
                      Speech.stop();
                      setIsSpeakingCaption(false);
                    } else {
                      setIsSpeakingCaption(true);
                      const textToSpeak = sanitizeTextForTTS(selectedMetadata.description);
                      Speech.speak(textToSpeak, {
                        volume: 1.0,
                        pitch: 1.0,
                        rate: 1.0,
                        language: 'en-US',
                        onDone: () => {
                          setIsSpeakingCaption(false);
                        },
                      });
                    }
                  }}
                  activeOpacity={0.8}
                  disabled={areControlsLocked}
                  style={[styles.captionButtonInline, { opacity: areControlsLocked ? 0.5 : 1 }]}
                >
                  <BlurView intensity={50} style={styles.captionButtonInlineBlur}>
                    <FontAwesome
                      name={isSpeakingCaption ? 'stop' : 'volume-up'}
                      size={24}
                      color="#fff"
                    />
                  </BlurView>
                </TouchableOpacity>
              </View>
            ) : selectedEvent.audio_url ? (
              /* Voice message with inline audio play/pause button */
              <View style={styles.captionRow}>
                <Text style={[styles.descriptionText, { flex: 1, marginBottom: 0 }]} numberOfLines={3}>
                  🎤 Voice message
                </Text>
                <TouchableOpacity
                  onPress={async () => {
                    if (!sound) {
                      console.warn('Audio not loaded yet');
                      return;
                    }
                    try {
                      if (isAudioPlaying) {
                        await sound.pauseAsync();
                      } else {
                        // Check if audio has finished and needs to be repositioned
                        const status = await sound.getStatusAsync();

                        if (status.isLoaded) {
                          // If at the end (finished or very close), rewind to start
                          const positionMillis = status.positionMillis || 0;
                          const durationMillis = status.durationMillis || 0;
                          const isAtEnd = durationMillis > 0 && (positionMillis >= durationMillis - 100);

                          if (isAtEnd) {
                            await sound.setPositionAsync(0);
                            audioAutoAdvanceScheduledRef.current = false; // Reset auto-advance flag for replay
                          }
                        }

                        await sound.playAsync();
                      }
                    } catch (error: any) {
                      // Check if this is a URL expiration error (error code -1102 or similar network errors)
                      const errorMessage = error?.message || String(error);
                      if (errorMessage.includes('-1102') || errorMessage.includes('NSURLErrorDomain') || errorMessage.includes('failed')) {
                        console.log('🔄 Audio URL expired, refreshing...');
                        if (onMediaError && selectedEvent) {
                          onMediaError(selectedEvent);
                        }
                      } else {
                        console.error('Error controlling audio playback:', error);
                      }
                    }
                  }}
                  activeOpacity={0.8}
                  disabled={!sound}
                  style={[styles.captionButtonInline, { opacity: sound ? 1 : 0.5 }]}
                >
                  <BlurView intensity={50} style={styles.captionButtonInlineBlur}>
                    <FontAwesome
                      name={isAudioPlaying ? 'pause' : 'play'}
                      size={24}
                      color="#fff"
                    />
                  </BlurView>
                </TouchableOpacity>
              </View>
            ) : (
              <Text style={styles.descriptionText} numberOfLines={3}>
                Reflection
              </Text>
            )}

            {/* Tell Me More FAB - Locked during video playback */}
            {selectedMetadata?.deep_dive && (
              <Animated.View style={[
                styles.tellMeMoreFAB,
                {
                  transform: [{ scale: pulseAnim }],
                  opacity: areControlsLocked ? 0.5 : 1
                }
              ]}>
                <TouchableOpacity
                  onPress={playDeepDive}
                  activeOpacity={0.8}
                  disabled={isPlayingDeepDive || areControlsLocked}
                >
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
    backgroundColor: 'transparent', // Required for efficient shadow rendering
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
    backgroundColor: 'transparent', // Required for efficient shadow rendering
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
    backgroundColor: 'transparent', // Required for efficient shadow rendering
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
    fontSize: 20,
    fontWeight: '600',
    color: '#fff',
    marginBottom: 12,
    lineHeight: 26,
  },
  captionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    gap: 10,
  },
  captionButtonInline: {
    width: 48,
    height: 48,
    borderRadius: 24,
    overflow: 'hidden',
    flexShrink: 0,
  },
  captionButtonInlineBlur: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 24,
    backgroundColor: 'transparent', // Required for efficient shadow rendering
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
    backgroundColor: 'transparent', // Required for efficient shadow rendering
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
  upNextDate: {
    fontSize: 11,
    color: 'rgba(255, 255, 255, 0.5)',
    marginBottom: 2,
    fontStyle: 'italic',
  },
  upNextDateNowPlaying: {
    color: 'rgba(79, 195, 247, 0.8)',
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

