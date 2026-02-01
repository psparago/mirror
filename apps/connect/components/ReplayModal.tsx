import { FontAwesome } from '@expo/vector-icons';
import { Event, EventMetadata, playerMachine } from '@projectmirror/shared';
import { useMachine } from '@xstate/react';
import { Audio } from 'expo-av';
import { BlurView } from 'expo-blur';
import { Image } from 'expo-image';
import * as Speech from 'expo-speech';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface ReplayModalProps {
  visible: boolean;
  event: Event | null;
  onClose: () => void;
}

export function ReplayModal({ visible, event, onClose }: ReplayModalProps) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  // Keep debug logging opt-in.
  const DEBUG_LOGS = __DEV__ && false;
  const debugLog = (...args: any[]) => {
    if (DEBUG_LOGS) console.log(...args);
  };
  
  // 1. Audio Player Refs
  const soundRef = useRef<Audio.Sound | null>(null);
  const captionSoundRef = useRef<Audio.Sound | null>(null);
  const [captionSound, setCaptionSound] = useState<Audio.Sound | null>(null);

  // 2. Video Player Setup
  const videoPlayer = useVideoPlayer(event?.video_url || '', player => {
    player.loop = false;
  });

  // 3. Animation for sparkle button
  const tellMeMorePulse = useSharedValue(1);
  
  useEffect(() => {
    if (event?.metadata?.deep_dive) {
      tellMeMorePulse.value = withRepeat(
        withTiming(1.15, { duration: 600 }),
        -1,
        true
      );
    } else {
      tellMeMorePulse.value = 1;
    }
  }, [event?.metadata?.deep_dive]);

  // FORCE AUDIO TO SPEAKER
  useEffect(() => {
    const configureAudioSession = async () => {
      try {
        debugLog('🔊 Configuring Audio Session for Playback...');
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false, // Critical: Turn off recording mode
          playsInSilentModeIOS: true, // Critical: Play even if mute switch is on
          staysActiveInBackground: false,
          shouldDuckAndroid: true,
          playThroughEarpieceAndroid: false, // Critical: Force speaker on Android
        });
      } catch (error) {
        console.error('Failed to configure audio session:', error);
      }
    };

    if (visible) {
      configureAudioSession();
    }
  }, [visible]);

  const tellMeMoreAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: tellMeMorePulse.value }],
  }));

  // 4. The State Machine & Refs
  const sendRef = useRef<any>(() => {});
  const eventRef = useRef<Event | null>(event);
  
  useEffect(() => {
    eventRef.current = event;
  }, [event]);

  const machine = useMemo(() => playerMachine.provide({
    actions: {
      // --- MEDIA CONTROL ---
      stopAllMedia: async () => {
        try { Speech.stop(); } catch (e) {}
        
        if (soundRef.current) {
          try {
            await soundRef.current.stopAsync();
            await soundRef.current.unloadAsync();
          } catch (e) {}
          soundRef.current = null;
        }
        
        if (captionSoundRef.current) {
          try {
            await captionSoundRef.current.stopAsync();
            await captionSoundRef.current.unloadAsync();
          } catch (e) {}
          captionSoundRef.current = null;
        }
        setCaptionSound(null);
        
        try {
          videoPlayer.pause();
          videoPlayer.currentTime = 0;
        } catch (e) {}
      },

      speakCaption: () => {
        const audioUrl = normalizeAudioUrl(eventRef.current?.audio_url);
        // expo-av accepts http/https URLs and file:// URLs
        const isValidUrl = audioUrl && 
          (audioUrl.startsWith('http://') || 
           audioUrl.startsWith('https://') || 
           audioUrl.startsWith('file://'));
        
        if (isValidUrl) {
          debugLog('🔊 [speakCaption] Playing caption audio file:', audioUrl);
          
          // FIX: Await logic inside the async creator isn't available in sync action, 
          // so we use the promise chain, but ensure we set volume immediately.
          Audio.Sound.createAsync(
            { uri: audioUrl },
            { shouldPlay: true, volume: 1.0 }
          ).then(({ sound }) => {
            captionSoundRef.current = sound;
            sound.setOnPlaybackStatusUpdate((status) => {
              if (status.isLoaded && status.didJustFinish) {
                debugLog('✅ [speakCaption] Caption audio finished');
                sound.unloadAsync();
                captionSoundRef.current = null;
                sendRef.current({ type: 'NARRATION_FINISHED' });
              }
            });
          }).catch((err) => {
            console.error('❌ [speakCaption] Audio load error:', err);
            console.warn('Falling back to TTS');
            sendRef.current({ type: 'NARRATION_FINISHED' });
          });
        } else if (eventRef.current?.audio_url) {
          console.warn('⚠️ [speakCaption] Invalid audio URL, falling back to TTS. Raw:', eventRef.current.audio_url, 'Normalized:', audioUrl);
          sendRef.current({ type: 'NARRATION_FINISHED' });
        } else if (eventRef.current?.metadata?.short_caption || eventRef.current?.metadata?.description) {
          const textToSpeak = eventRef.current.metadata.short_caption || eventRef.current.metadata.description;
          Speech.speak(textToSpeak, {
            volume: 1.0,
            onDone: () => sendRef.current({ type: 'NARRATION_FINISHED' }),
            onStopped: () => sendRef.current({ type: 'NARRATION_FINISHED' }),
            onError: () => sendRef.current({ type: 'NARRATION_FINISHED' }),
          });
        } else {
          sendRef.current({ type: 'NARRATION_FINISHED' });
        }
      },

      playVideo: () => {
        videoPlayer.play();
      },

      playAudio: async () => {
        // This is the main audio for an "Image + Audio" reflection
        const audioUrl = normalizeAudioUrl(eventRef.current?.audio_url);
        // expo-av accepts http/https URLs and file:// URLs
        const isValidUrl = audioUrl && 
          (audioUrl.startsWith('http://') || 
           audioUrl.startsWith('https://') || 
           audioUrl.startsWith('file://'));
        
        if (isValidUrl) {
          debugLog('🔊 [playAudio] Playing main audio. Raw:', eventRef.current?.audio_url, 'Normalized:', audioUrl);
          try {
            const { sound } = await Audio.Sound.createAsync(
              { uri: audioUrl },
              { shouldPlay: true, volume: 1.0 }
            );
            soundRef.current = sound;
            
            sound.setOnPlaybackStatusUpdate((status) => {
              if (status.isLoaded && status.didJustFinish) {
                // CRITICAL FIX: Send AUDIO_FINISHED when playback is done.
                // In Companion mode, we do not wait for the selfie.
                debugLog("✅ Main Audio Finished");
                sendRef.current({ type: 'AUDIO_FINISHED' });
              }
            });
          } catch (e) {
            console.error("❌ [playAudio] Audio Load Error:", e);
            sendRef.current({ type: 'AUDIO_FINISHED' });
          }
        } else if (eventRef.current?.audio_url) {
          console.warn('⚠️ [playAudio] Invalid audio URL. Raw:', eventRef.current.audio_url, 'Normalized:', audioUrl);
          sendRef.current({ type: 'AUDIO_FINISHED' });
        } else {
          sendRef.current({ type: 'AUDIO_FINISHED' });
        }
      },

      pauseMedia: () => {
        videoPlayer.pause();
        if (soundRef.current) soundRef.current.pauseAsync();
        if (captionSoundRef.current) captionSoundRef.current.pauseAsync();
        Speech.stop();
      },
      
      resumeMedia: () => {
        videoPlayer.play();
        if (soundRef.current) soundRef.current.playAsync();
        if (captionSoundRef.current) captionSoundRef.current.playAsync();
      },

      // --- SELFIE ACTIONS ---
      triggerSelfie: () => {
        debugLog("📸 [Replay] Selfie trigger - marking as taken to allow state machine to progress");
        // In Companion mode, we need to mark selfie as taken so the parallel state can complete
        // The state machine's assign({ selfieTaken: true }) should handle this,
        // but we also send a signal to ensure the state progresses
        // Actually, the assign happens automatically in the state machine, so we just log
      },
      
      showSelfieBubble: () => {}, 

      playDeepDive: async () => {
        // Stop previous media
        Speech.stop();
        if (captionSoundRef.current) {
          await captionSoundRef.current.unloadAsync().catch(()=>{});
          setCaptionSound(null);
          captionSoundRef.current = null;
        }

        if (eventRef.current?.deep_dive_audio_url) {
          debugLog('🧠 Playing deep dive audio');
          try {
            const { sound: newSound } = await Audio.Sound.createAsync(
              { uri: eventRef.current.deep_dive_audio_url },
              { shouldPlay: true, volume: 1.0 }
            );
            soundRef.current = newSound;
            
            newSound.setOnPlaybackStatusUpdate((status) => {
              if (status.isLoaded && status.didJustFinish) {
                debugLog('✅ Deep dive audio finished');
                sendRef.current({ type: 'NARRATION_FINISHED' });
                newSound.unloadAsync();
                soundRef.current = null;
              }
            });
          } catch (err) {
            console.warn('Deep dive error, fallback to TTS');
            sendRef.current({ type: 'NARRATION_FINISHED' });
          }
        } else if (eventRef.current?.metadata?.deep_dive) {
           Speech.speak(eventRef.current.metadata.deep_dive, {
             onDone: () => sendRef.current({ type: 'NARRATION_FINISHED' }),
             onError: () => sendRef.current({ type: 'NARRATION_FINISHED' }),
           });
        } else {
          sendRef.current({ type: 'NARRATION_FINISHED' });
        }
      },
    }
  }), [event, videoPlayer]);

  const [state, send] = useMachine(machine);

  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  useEffect(() => {
    if (visible && event) {
      sendRef.current({ 
        type: 'SELECT_EVENT_INSTANT', 
        event: event, 
        metadata: event.metadata || ({} as EventMetadata)
      });
    } else {
      sendRef.current({ type: 'CLOSE' });
    }
    return () => { sendRef.current({ type: 'CLOSE' }); };
  }, [visible, event, send]);

  useEffect(() => {
    const subscription = videoPlayer.addListener('playToEnd', () => {
       send({ type: 'VIDEO_FINISHED' });
    });
    return () => subscription.remove();
  }, [videoPlayer, send]);


  // LOGIC FOR SPARKLE BUTTON
  // Check if we are stuck in the "Done but waiting for selfie" state
  const isAudioDoneButStuck = state.matches({ playingAudio: { playback: 'done' } });
  
  // For images (non-video, non-audio), check if we're in viewingPhoto state
  // The state machine accepts TELL_ME_MORE from any viewingPhoto sub-state
  const isViewingPhoto = state.matches('viewingPhoto');
  const isViewingPhotoViewing = state.matches({ viewingPhoto: 'viewing' });
  const isViewingPhotoNarrating = state.matches({ viewingPhoto: 'narrating' });
  
  const isFinished = state.matches('finished');
  
  // Show sparkle if:
  // 1. Finished state
  // 2. Audio done (bypassing selfie wait)
  // 3. Viewing photo - show after a short delay to allow narration to start, or if we're in viewing sub-state
  // For images, we use SELECT_EVENT_INSTANT which sets hasSpoken: true, but viewingPhoto still calls speakCaption
  // So we show the button when not actively narrating
  const canShowSparkle = event?.metadata?.deep_dive && (
    isFinished || 
    isAudioDoneButStuck ||
    (isViewingPhoto && !isViewingPhotoNarrating) // Show when in viewingPhoto but not narrating
  );

  if (!visible || !event) return null;

  // --- RENDER ---
  const isVideo = state.hasTag('video_mode');
  const isSpeaking = state.hasTag('speaking');
  const isPlaying = state.hasTag('playing');
  const isAnyAudioPlaying = isSpeaking || isPlaying || (captionSound !== null);

  // Helper to normalize audio URLs
  // For local file paths, we need to use file:// prefix for expo-av
  // For remote URLs (http/https), use as-is
  const normalizeAudioUrl = (url: string | undefined): string | undefined => {
    if (!url) return undefined;
    
    // If it's already a valid URL format, return as-is
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://')) {
      return url;
    }
    
    // If it's an absolute file path (starts with /), add file:// prefix
    // expo-av needs file:// prefix for local absolute paths
    if (url.startsWith('/')) {
      return `file://${url}`;
    }
    
    // Otherwise return as-is (might be a relative path or invalid)
    return url;
  };

  const handleSwipeClose = () => {
    sendRef.current({ type: 'CLOSE' });
    setTimeout(() => { onClose(); }, 100);
  };

  const swipeDownGesture = Gesture.Pan()
    .activeOffsetY([10, 200])
    .failOffsetX([-50, 50])
    .onEnd((event) => {
      if (event.translationY > 100) runOnJS(handleSwipeClose)();
    });

  const handlePlayCaption = async () => {
    if (isAnyAudioPlaying) return; // Prevent overlapping

    // Stop existing
    Speech.stop();
    if (captionSoundRef.current) await captionSoundRef.current.unloadAsync().catch(()=>{});

    const audioUrl = normalizeAudioUrl(event?.audio_url);
    // expo-av accepts http/https URLs and file:// URLs
    const isValidUrl = audioUrl && 
      (audioUrl.startsWith('http://') || 
       audioUrl.startsWith('https://') || 
       audioUrl.startsWith('file://'));

    if (isValidUrl) {
      debugLog('🔊 [handlePlayCaption] Playing caption audio:', audioUrl);
      try {
        // Replay the main audio
        const { sound } = await Audio.Sound.createAsync(
          { uri: audioUrl },
          { shouldPlay: true, volume: 1.0 }
        );
        setCaptionSound(sound);
        captionSoundRef.current = sound;
        sound.setOnPlaybackStatusUpdate((status) => {
          if (status.isLoaded && status.didJustFinish) {
            sound.unloadAsync();
            setCaptionSound(null);
            captionSoundRef.current = null;
          }
        });
      } catch (e) {
        console.error('❌ [handlePlayCaption] Audio load error:', e);
        // Fall back to TTS
        if (event?.metadata?.description) {
          Speech.speak(event.metadata.description, { volume: 1.0 });
        }
      }
    } else if (event?.audio_url) {
      console.warn('⚠️ [handlePlayCaption] Invalid audio URL, using TTS. Raw:', event.audio_url, 'Normalized:', audioUrl);
      if (event?.metadata?.description) {
        Speech.speak(event.metadata.description, { volume: 1.0 });
      }
    } else if (event?.metadata?.description) {
      Speech.speak(event.metadata.description, { volume: 1.0 });
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent={false}>
      <GestureDetector gesture={swipeDownGesture}>
        <View style={styles.container}>
          {/* MAIN STAGE */}
          <View style={styles.mediaContainer}>
            <View style={styles.mediaFrame}>
              {isVideo ? (
                 <VideoView 
                   player={videoPlayer} 
                   style={styles.mediaImage} 
                   contentFit="contain"
                   nativeControls={false}
                 />
              ) : (
                 <Image
                   source={{ uri: event.image_url }}
                   style={styles.mediaImage}
                   contentFit="contain"
                   cachePolicy="memory-disk"
                 />
              )}
            </View>
          </View>

          {/* CAPTION BAR */}
          <View style={[styles.captionBar, { paddingBottom: insets.bottom + 16 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
              {isAnyAudioPlaying && (
                <View style={{ marginRight: 12, marginTop: 2 }}>
                  <FontAwesome name="volume-up" size={20} color="rgba(255, 255, 255, 0.9)" />
                </View>
              )}

              <View style={{ flex: 1 }}>
                <Text style={styles.captionText} numberOfLines={2}>
                  {event.metadata?.short_caption || event.metadata?.description || 'No caption'}
                </Text>
                {event.metadata?.sender && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6 }}>
                    <Text style={styles.senderText}>From {event.metadata.sender}</Text>
                  </View>
                )}
              </View>

              {(event?.audio_url || event?.metadata?.description) && (
                <TouchableOpacity
                  style={[styles.playCaptionButton, isAnyAudioPlaying && styles.playCaptionButtonDisabled]}
                  onPress={handlePlayCaption}
                  disabled={!!isAnyAudioPlaying}
                >
                  <FontAwesome
                    name="volume-up"
                    size={18}
                    color={isAnyAudioPlaying ? "rgba(255, 255, 255, 0.3)" : "rgba(255, 255, 255, 0.8)"}
                  />
                </TouchableOpacity>
              )}
            </View>
          </View>

          {/* TELL ME MORE SPARKLE */}
          {canShowSparkle && (
            <Animated.View style={[styles.tellMeMoreFAB, tellMeMoreAnimatedStyle]}>
              <TouchableOpacity
                onPress={async () => {
                  // If we're stuck in playingAudio state, directly play deep dive (bypass state machine)
                  if (isAudioDoneButStuck || state.matches('playingAudio')) {
                    // Stop previous media
                    Speech.stop();
                    if (captionSoundRef.current) {
                      await captionSoundRef.current.unloadAsync().catch(()=>{});
                      setCaptionSound(null);
                      captionSoundRef.current = null;
                    }
                    if (soundRef.current) {
                      await soundRef.current.unloadAsync().catch(()=>{});
                      soundRef.current = null;
                    }

                    // Play deep dive directly
                    if (event?.deep_dive_audio_url) {
                      try {
                        const { sound: newSound } = await Audio.Sound.createAsync(
                          { uri: event.deep_dive_audio_url },
                          { shouldPlay: true, volume: 1.0 }
                        );
                        soundRef.current = newSound;
                        newSound.setOnPlaybackStatusUpdate((status) => {
                          if (status.isLoaded && status.didJustFinish) {
                            newSound.unloadAsync();
                            soundRef.current = null;
                          }
                        });
                      } catch (err) {
                        if (event?.metadata?.deep_dive) {
                          Speech.speak(event.metadata.deep_dive, {
                            volume: 1.0,
                            onError: () => {},
                          });
                        }
                      }
                    } else if (event?.metadata?.deep_dive) {
                      Speech.speak(event.metadata.deep_dive, {
                        volume: 1.0,
                        onError: () => {},
                      });
                    }
                  } else if (isViewingPhoto) {
                    // For viewingPhoto state, try state machine first, but have fallback
                    send({ type: 'TELL_ME_MORE' });
                    
                    // Fallback: if state doesn't change after a short delay, play directly
                    setTimeout(() => {
                      if (state.matches('viewingPhoto') && !state.matches('playingDeepDive')) {
                        // Play deep dive directly
                        Speech.stop();
                        if (event?.deep_dive_audio_url) {
                          Audio.Sound.createAsync(
                            { uri: event.deep_dive_audio_url },
                            { shouldPlay: true, volume: 1.0 }
                          ).then(({ sound }) => {
                            soundRef.current = sound;
                            sound.setOnPlaybackStatusUpdate((status) => {
                              if (status.isLoaded && status.didJustFinish) {
                                sound.unloadAsync();
                                soundRef.current = null;
                              }
                            });
                          }).catch(() => {
                            if (event?.metadata?.deep_dive) {
                              Speech.speak(event.metadata.deep_dive, { volume: 1.0 });
                            }
                          });
                        } else if (event?.metadata?.deep_dive) {
                          Speech.speak(event.metadata.deep_dive, { volume: 1.0 });
                        }
                      }
                    }, 300);
                  } else {
                    // For finished state or any other state, use state machine
                    send({ type: 'TELL_ME_MORE' });
                  }
                }}
                style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}
              >
                <BlurView intensity={50} style={styles.tellMeMoreBlur}>
                  <Text style={{ fontSize: 32 }}>✨</Text>
                </BlurView>
              </TouchableOpacity>
            </Animated.View>
          )}

          {/* TOP CONTROLS - Rendered last to appear on top */}
          <View style={[styles.topControls, { top: insets.top - 15 }]}>
            <View style={{ flex: 1 }} />
            <TouchableOpacity style={styles.closeButton} onPress={handleSwipeClose}>
              <FontAwesome name="times" size={18} color="#fff" />
            </TouchableOpacity>
          </View>

        </View>
      </GestureDetector>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  topControls: {
    position: 'absolute',
    left: 10,
    right: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
    zIndex: 1000,
    elevation: 1000,
  },
  closeButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.4)',
    zIndex: 1001,
    elevation: 1001,
  },
  mediaContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    paddingTop: 60, 
    paddingBottom: 120, 
  },
  mediaFrame: {
    flex: 1,
    width: '100%',
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: '#1a3a44',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
  },
  mediaImage: {
    width: '100%',
    height: '100%',
  },
  captionBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingTop: 20,
    paddingHorizontal: 20,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 20,
  },
  captionText: {
    color: '#fff',
    fontSize: 18,
    lineHeight: 24,
  },
  senderText: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 14,
    fontWeight: '600',
  },
  playCaptionButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 12,
  },
  playCaptionButtonDisabled: {
    opacity: 0.4,
  },
  tellMeMoreFAB: {
    position: 'absolute',
    bottom: 120,
    right: 30,
    width: 64,
    height: 64,
    borderRadius: 32,
    overflow: 'hidden',
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
  },
  tellMeMoreBlur: {
    flex: 1,
    width: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
});
