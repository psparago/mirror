import { FontAwesome } from '@expo/vector-icons';
import { Event, EventMetadata } from '@projectmirror/shared';

import { useMachine } from '@xstate/react';
import { Audio } from 'expo-av';
import { BlurView } from 'expo-blur';
import { CameraView, PermissionResponse } from 'expo-camera';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';

import * as Speech from 'expo-speech';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  Alert,
  Animated,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  StyleSheet,
  Text,
  TextInput,
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
  readEventIds: string[];
  recentlyArrivedIds: string[]; // State for items that arrived during this session
  onReplay?: (event: Event) => void;
  config?: {
    autoplay?: boolean;
    loopFeed?: boolean;
    showStartMarker?: boolean;
    playVideoCaptions?: boolean;
    enableInfiniteScroll?: boolean;
  };

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
  readEventIds,
  recentlyArrivedIds,
  onReplay,
  config,
}: MainStageProps) {

  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const insets = useSafeAreaInsets();
  const router = useRouter();


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

  // Track caption sound in ref to handle race condition with stopAllMedia
  const captionSoundRef = useRef<Audio.Sound | null>(null);

  // Toast state
  const [toastMessage, setToastMessage] = useState<string>('');
  const toastOpacity = useRef(new Animated.Value(0)).current;

  // Get metadata (memoized to prevent unnecessary re-renders)
  const selectedMetadata = useMemo(
    () => selectedEvent ? eventMetadata[selectedEvent.event_id] : null,
    [selectedEvent, eventMetadata]
  );

  // Track previous event to prevent restart loops
  const prevEventIdRef = useRef<string | null>(null);

  // Track active caption session to prevent ghost TTS callbacks
  const captionSessionRef = useRef(0);

  const [isAdminMode, setIsAdminMode] = useState(false);
  const [showAdminChallenge, setShowAdminChallenge] = useState(false);
  const [adminAnswer, setAdminAnswer] = useState('');
  const [mathChallenge, setMathChallenge] = useState({ a: 3, b: 3, sum: 6 });
  const safetyTimeoutRef = useRef<any>(null);

  // --- STABILITY REFS (Anti-stale closure) ---
  const eventsRef = useRef(events);
  const selectedEventRef = useRef(selectedEvent);
  const stateRef = useRef<any>(null);
  const onEventSelectRef = useRef(onEventSelect);
  const onDeleteRef = useRef(onDelete);
  const onCaptureSelfieRef = useRef(onCaptureSelfie);
  const onReplayRef = useRef(onReplay);
  const selectedMetadataRef = useRef(selectedMetadata);
  // --- THE XSTATE MACHINE ---
  // Using let to allow for closure usage in refs defined later
  let [state, send] = useMachine(playerMachine.provide({
    actions: {
      stopAllMedia: async () => {
        // Increment session IMMEDIATELY and SYNCHRONOUSLY to invalidate any pending Narration/TTS
        captionSessionRef.current += 1;
        const thisStopSession = captionSessionRef.current;
        console.log(`🛑 stopAllMedia [Session: ${thisStopSession}]`);

        // Clear any existing safety timers
        if (safetyTimeoutRef.current) {
          clearTimeout(safetyTimeoutRef.current);
          safetyTimeoutRef.current = null;
        }

        // Stop TTS immediately and forcefully
        Speech.stop();

        // Stop voice message audio
        const soundToUnload = sound;
        setSound(null); // Clear state immediately to prevent race conditions
        if (soundToUnload) {
          try {
            const status = await soundToUnload.getStatusAsync();
            if (status.isLoaded) {
              await soundToUnload.stopAsync();
              await soundToUnload.unloadAsync();
            }
          } catch (e) {
            // Ignore errors - sound may already be unloaded
            console.log('Sound already unloaded or error:', (e as Error).message);
          }
        }

        // Stop companion caption audio
        const soundToStop = captionSound || captionSoundRef.current;
        if (soundToStop) {
          try {
            const status = await soundToStop.getStatusAsync();
            if (status.isLoaded) {
              await soundToStop.stopAsync();
              await soundToStop.unloadAsync();
            }
          } catch (e) {
            console.error('Error stopping caption:', e);
          }
          captionSoundRef.current = null;
          setCaptionSound(null);
        }

        if (player) {
          try {
            player.pause();
            player.currentTime = 0;
          } catch (err) {
            console.warn('Silent failure stopping player:', err);
          }
        }
        Animated.timing(controlsOpacity, { toValue: 0, duration: 300, useNativeDriver: true }).start();

        // Small delay to ensure everything stops
        await new Promise(resolve => setTimeout(resolve, 100));
      },

      speakCaption: async () => {
        const text = selectedMetadataRef.current?.description;
        const audioUrl = selectedEventRef.current?.audio_url;

        // Use current session (already incremented by stopAllMedia or initial)
        const thisSession = captionSessionRef.current;
        console.log(`🎙️ speakCaption [Session: ${thisSession}]`);

        Animated.timing(controlsOpacity, { toValue: 0, duration: 300, useNativeDriver: true }).start();

        if (audioUrl) {
          const playAudioWithRetry = async (retryCount = 0) => {
            try {
              console.log(`🎧 Loading narration [Session: ${thisSession}] (Attempt ${retryCount + 1}): ${audioUrl.substring(0, 50)}...`);

              const { sound: newCaptionSound, status } = await Audio.Sound.createAsync(
                { uri: audioUrl },
                { shouldPlay: false },
                (status) => {
                  if (status.isLoaded && !status.isPlaying && status.didJustFinish) {
                    if (captionSessionRef.current === thisSession) {
                      if (safetyTimeoutRef.current) {
                        clearTimeout(safetyTimeoutRef.current);
                        safetyTimeoutRef.current = null;
                      }
                      newCaptionSound.unloadAsync();
                      setCaptionSound(null);
                      captionSoundRef.current = null;
                      console.log(`✅ Narration finished [Session: ${thisSession}] - sending NARRATION_FINISHED`);
                      send({ type: 'NARRATION_FINISHED' });
                    } else {
                      console.log(`🚫 Narration finished but session changed [${thisSession} vs ${captionSessionRef.current}] - cleaning up`);
                      newCaptionSound.unloadAsync();
                      captionSoundRef.current = null;
                    }
                  }
                }
              );

              // CHECK SESSION AGAIN after load completes
              if (captionSessionRef.current !== thisSession) {
                console.log(`🚫 Session changed during narration load [${thisSession} vs ${captionSessionRef.current}] - discarding`);
                newCaptionSound.unloadAsync();
                return;
              }

              captionSoundRef.current = newCaptionSound;
              setCaptionSound(newCaptionSound);

              await newCaptionSound.playAsync();
              console.log(`🎧 Narration playing [Session: ${thisSession}]`);

              // Smart Fallback based on actual duration
              const duration = (status as any).durationMillis || 5000;
              const safetyTimeout = duration + 2500; // Small buffer

              safetyTimeoutRef.current = setTimeout(() => {
                if (captionSessionRef.current === thisSession) {
                  console.warn(`⚠️ Narration safety fallback triggered [Session: ${thisSession}]`);
                  safetyTimeoutRef.current = null;
                  send({ type: 'NARRATION_FINISHED' });
                }
              }, safetyTimeout);

            } catch (error: any) {
              console.error(`❌ Audio caption error (Attempt ${retryCount + 1}):`, error);
              if (retryCount < 1 && captionSessionRef.current === thisSession) {
                await new Promise(r => setTimeout(r, 1500));
                return playAudioWithRetry(retryCount + 1);
              }
              if (captionSessionRef.current === thisSession) {
                send({ type: 'NARRATION_FINISHED' });
              }
            }
          };
          playAudioWithRetry();
        } else if (text) {
          Speech.speak(text, {
            onDone: () => {
              if (captionSessionRef.current === thisSession) {
                if (safetyTimeoutRef.current) {
                  clearTimeout(safetyTimeoutRef.current);
                  safetyTimeoutRef.current = null;
                }
                console.log('✅ TTS finished - sending NARRATION_FINISHED');
                send({ type: 'NARRATION_FINISHED' });
              }
            },
            onError: () => {
              if (captionSessionRef.current === thisSession) {
                if (safetyTimeoutRef.current) {
                  clearTimeout(safetyTimeoutRef.current);
                  safetyTimeoutRef.current = null;
                }
                send({ type: 'NARRATION_FINISHED' });
              }
            }
          });

          // TTS Fallback
          safetyTimeoutRef.current = setTimeout(() => {
            if (captionSessionRef.current === thisSession) {
              console.warn('⚠️ TTS safety fallback triggered');
              safetyTimeoutRef.current = null;
              send({ type: 'NARRATION_FINISHED' });
            }
          }, 15000);
        } else {
          if (captionSessionRef.current === thisSession) {
            send({ type: 'NARRATION_FINISHED' });
          }
        }
      },

      playVideo: async () => {
        // Preparation logic for video
        if (!player) return;

        console.log(`🎬 playVideo called: status=${player.status}`);

        // Reset to start
        player.currentTime = 0;

        // Trigger bubble animation
        Animated.timing(selfieMirrorOpacity, { toValue: 1, duration: 500, useNativeDriver: true }).start();

        // The actual .play() call is now managed by the Hardware Sync useEffect for maximum reliability
      },

      playAudio: async () => {
        const playWithRetry = async (retryCount = 0) => {
          try {
            if (sound) await sound.unloadAsync();

            if (!selectedEventRef.current?.audio_url) {
              send({ type: 'AUDIO_FINISHED' });
              return;
            }

            console.log(`🎧 Playing audio: ${selectedEventRef.current.audio_url.substring(0, 80)}... (Attempt ${retryCount + 1})`);
            const { sound: newSound } = await Audio.Sound.createAsync(
              { uri: selectedEventRef.current.audio_url as string },
              { shouldPlay: true }
            );

            newSound.setOnPlaybackStatusUpdate((status) => {
              if (status.isLoaded && status.didJustFinish) {
                send({ type: 'AUDIO_FINISHED' });
              }
            });
            setSound(newSound);

          } catch (err: any) {
            console.error(`❌ Audio error (Attempt ${retryCount + 1}):`, err);

            if (retryCount < 1) {
              console.log('🔄 Retrying audio load in 1.5s...');
              await new Promise(r => setTimeout(r, 1500));
              return playWithRetry(retryCount + 1);
            }

            if (err && typeof err === 'object') {
              console.error("❌ Detailed Audio Error:", {
                message: err.message,
                code: err.code,
                domain: err.domain
              });
            }
            send({ type: 'AUDIO_FINISHED' });
          }
        };

        playWithRetry();
      },

      playDeepDive: async () => {
        const playDeepDiveWithRetry = async (retryCount = 0) => {
          try {
            if (sound) await sound.unloadAsync();

            if (selectedEventRef.current?.deep_dive_audio_url) {
              console.log(`🧠 Playing deep dive audio: ${selectedEventRef.current.deep_dive_audio_url.substring(0, 80)}... (Attempt ${retryCount + 1})`);
              const { sound: newSound, status } = await Audio.Sound.createAsync(
                { uri: selectedEventRef.current.deep_dive_audio_url },
                { shouldPlay: true }
              );
              newSound.setOnPlaybackStatusUpdate((status) => {
                if (status.isLoaded && status.didJustFinish) {
                  if (safetyTimeoutRef.current) {
                    clearTimeout(safetyTimeoutRef.current);
                    safetyTimeoutRef.current = null;
                  }
                  console.log('✅ Deep dive audio finished - sending NARRATION_FINISHED');
                  send({ type: 'NARRATION_FINISHED' });
                }
              });
              setSound(newSound);

              // Smart Fallback for deep dive
              const duration = (status as any).durationMillis || 15000;
              const safetyTimeout = duration + 5000; // Extra generous buffer for deep dives

              if (safetyTimeoutRef.current) clearTimeout(safetyTimeoutRef.current);
              safetyTimeoutRef.current = setTimeout(() => {
                console.warn('⚠️ Deep dive safety timeout reached (Smart Fallback)');
                safetyTimeoutRef.current = null;
                send({ type: 'NARRATION_FINISHED' });
              }, safetyTimeout);

            } else if (selectedMetadataRef.current?.deep_dive) {
              Speech.speak(selectedMetadataRef.current.deep_dive, {
                onDone: () => {
                  if (safetyTimeoutRef.current) {
                    clearTimeout(safetyTimeoutRef.current);
                    safetyTimeoutRef.current = null;
                  }
                  send({ type: 'NARRATION_FINISHED' });
                },
                onError: () => {
                  if (safetyTimeoutRef.current) {
                    clearTimeout(safetyTimeoutRef.current);
                    safetyTimeoutRef.current = null;
                  }
                  send({ type: 'NARRATION_FINISHED' });
                }
              });

              // TTS Fallback - Deep dives are long, give it 60s
              if (safetyTimeoutRef.current) clearTimeout(safetyTimeoutRef.current);
              safetyTimeoutRef.current = setTimeout(() => {
                console.warn('⚠️ Deep dive TTS safety timeout reached');
                safetyTimeoutRef.current = null;
                send({ type: 'NARRATION_FINISHED' });
              }, 60000);
            } else {
              send({ type: 'NARRATION_FINISHED' });
            }
          } catch (err: any) {
            console.error(`❌ Deep dive audio error (Attempt ${retryCount + 1}):`, err);

            if (retryCount < 1 && selectedEventRef.current?.deep_dive_audio_url) {
              console.log('🔄 Retrying deep dive audio load in 1.5s...');
              await new Promise(r => setTimeout(r, 1500));
              return playDeepDiveWithRetry(retryCount + 1);
            }

            if (err && typeof err === 'object') {
              console.error("❌ Detailed Deep Dive Error:", {
                message: err.message,
                code: err.code,
                domain: err.domain
              });
            }
            send({ type: 'NARRATION_FINISHED' });
          }
        };
        playDeepDiveWithRetry();
      },

      showSelfieBubble: () => {
        Animated.timing(selfieMirrorOpacity, { toValue: 1, duration: 0, useNativeDriver: true }).start();
      },

      triggerSelfie: async () => {
        await performSelfieCapture(0);
      },

      pauseMedia: async () => {
        if (player && state.hasTag('video_mode')) player.pause();
        if (sound) await sound.pauseAsync();
        if (captionSound) await captionSound.pauseAsync();
      },

      resumeMedia: async () => {
        if (player && state.hasTag('video_mode')) player.play();
        if (sound) await sound.playAsync();
        if (captionSound) await captionSound.playAsync();
      }
    }
  }));

  const lastTapRef = useRef<number>(0);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: (evt) => {
        // Don't capture touches in the top header area or the Up Next sidebar
        // This allows buttons (Gear icon) and list items to receive touches
        const isHeader = evt.nativeEvent.pageY < 120;
        const isSidebar = isLandscape ? evt.nativeEvent.pageX > width * 0.65 : false;

        if (isHeader || isSidebar) {
          return false;
        }
        return true;
      },
      onMoveShouldSetPanResponder: (_, gestureState) => {


        return Math.abs(gestureState.dx) > 20;
      },
      onPanResponderRelease: (_, gestureState) => {
        // Handle Single Tap (Pause/Resume)
        if (Math.abs(gestureState.dx) < 10 && Math.abs(gestureState.dy) < 10) {
          const currentState = stateRef.current;
          if (currentState && currentState.hasTag('active')) {
            if (currentState.hasTag('paused')) {
              console.log('⏯️ Tapped to Resume');
              send({ type: 'RESUME' });
            } else {
              console.log('⏸️ Tapped to Pause');
              send({ type: 'PAUSE' });
            }
          } else if (currentState && (currentState.matches('finished') || currentState.matches({ viewingPhoto: 'viewing' }))) {
            handleReplay();
          }
          return;
        }

        const currentEvents = eventsRef.current;
        const currentSelected = selectedEventRef.current;

        const currentIndex = currentEvents.findIndex(e => e.event_id === currentSelected?.event_id);
        if (currentIndex === -1) return;

        if (gestureState.dx < -50) {
          console.log('👈 Swiped Left (Next)');
          if (currentIndex < currentEvents.length - 1) {
            onEventSelectRef.current(currentEvents[currentIndex + 1]);
          }
        }

        else if (gestureState.dx > 50) {
          console.log('👉 Swiped Right (Previous)');
          if (currentIndex > 0) {
            onEventSelectRef.current(currentEvents[currentIndex - 1]);
          }
        }
      },
    })
  ).current;

  // Show toast notification
  const showToast = (message: string) => {
    setToastMessage(message);
    Animated.sequence([
      Animated.timing(toastOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
      Animated.delay(2000),
      Animated.timing(toastOpacity, { toValue: 0, duration: 300, useNativeDriver: true })
    ]).start(() => setToastMessage(''));
  };

  // --- AUDIO/VIDEO REFS ---
  const videoSource = selectedEvent?.video_url || null;

  const player = useVideoPlayer(videoSource || '', (player) => {
    setIsVideoPlaying(player.playing);
  });

  // --- ACTIONS IMPLEMENTATION ---

  // Helper for reused selfie logic
  const performSelfieCapture = useCallback(async (delay = 0) => {
    // Check permission first before starting ANY UI transitions (mirror, flash, etc)
    if (!cameraPermission?.granted) {
      console.log('📸 Helper: Skipping selfie - camera permission not granted');
      return;
    }

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
      await onCaptureSelfieRef.current();

      // Fade out
      setTimeout(() => {
        console.log('📸 Helper: Fading out bubble');
        Animated.timing(selfieMirrorOpacity, { toValue: 0, duration: 500, useNativeDriver: true }).start();
      }, 500);
    }, delay);
  }, [onCaptureSelfie, flashOpacity, selfieMirrorOpacity]);



  // --- HARDWARE SYNC (Side Effects) ---
  // This effect ensures the actual hardware (Video/Audio) matches the machine state.
  // This is more reliable than actions due to closure staleness in active rendercycles.
  useEffect(() => {
    if (!player) return;

    const isMachinePlayingVideo = state.matches({ playingVideo: { playback: 'playing' } });
    const isMachinePaused = state.hasTag('paused');

    if (isMachinePlayingVideo) {
      if (!isVideoPlaying) {
        console.log('⚡ Hardware Sync: Playing Video');
        player.play();
      }
    } else if (isMachinePaused) {
      console.log('⚡ Hardware Sync: Pausing Video');
      player.pause();
    }
  }, [state.value, player, isVideoPlaying]);

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
    stateRef.current = state;
    onEventSelectRef.current = onEventSelect;
    onDeleteRef.current = onDelete;
    onCaptureSelfieRef.current = onCaptureSelfie;
    onReplayRef.current = onReplay;
    selectedMetadataRef.current = selectedMetadata;
  }, [events, selectedEvent, state, onEventSelect, onDelete, onCaptureSelfie, onReplay, selectedMetadata]);

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

      // Auto-scroll the list to show the selected item
      if (flatListRef.current) {
        const index = events.findIndex(e => e.event_id === currentEventId);
        if (index !== -1) {
          try {
            flatListRef.current.scrollToIndex({
              index,
              animated: true,
              viewPosition: 0.5 // Center the item in the list
            });
          } catch (err) {
            // scrollToOffset as fallback if scrollToIndex fails (common in early renders)
            console.warn('Scroll to index failed, using fallback');
          }
        }
      }
    }
  }, [selectedEvent?.event_id, selectedEvent, selectedMetadata, send, events]);

  // 2. Video Player Finished
  useEffect(() => {
    if (!player) return;
    const interval = setInterval(() => {
      // ONLY check for finish if we are in the 'playing' state
      if (!state.matches({ playingVideo: { playback: 'playing' } })) {
        return;
      }

      // Use 0.2s threshold to ensure we catch it before it actually stops
      if (player.duration > 0 && player.currentTime >= player.duration - 0.2) {
        console.log(`🎬 Video finished at ${player.currentTime}/${player.duration}`);
        send({ type: 'VIDEO_FINISHED' });
      }
    }, 200);
    return () => clearInterval(interval);
  }, [player, send, state.value]); // Use state.value to minimize re-renders but still update on transition

  // 3. Rewind video on completion for deep dive context
  useEffect(() => {
    if (state?.matches('finished') && player && (selectedMetadata?.content_type === 'video' || !!selectedEvent?.video_url)) {
      console.log('🏁 Rewinding video to start for deep dive context');
      player.pause();
      player.currentTime = 0;
    }
  }, [state?.matches('finished'), player, selectedMetadata, selectedEvent]);

  // 4. Show/Hide Controls AND Bubble Based on State
  useEffect(() => {
    if (!state) return;

    if (state.matches('finished')) {
      // Finished: Show controls AND hide bubble
      Animated.timing(controlsOpacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
      Animated.timing(selfieMirrorOpacity, { toValue: 0, duration: 500, useNativeDriver: true }).start();
    } else if (state.hasTag('paused') || state.matches({ viewingPhoto: 'viewing' })) {
      // Paused or photo viewing: Show controls
      Animated.timing(controlsOpacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    } else {
      // Playing: Hide controls
      Animated.timing(controlsOpacity, { toValue: 0, duration: 200, useNativeDriver: true }).start();
    }
  }, [state, controlsOpacity, selfieMirrorOpacity]);

  // 4. ANIMATIONS (VU Meter & Pulse)
  const isMachineSpeaking = state && (state.matches({ playingVideo: { playback: 'narrating' } }) ||
    state.matches({ viewingPhoto: 'narrating' }) ||
    state.matches({ playingDeepDive: { active: 'playing' } }));
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
    if (onReplayRef.current && selectedEventRef.current) onReplayRef.current(selectedEventRef.current);
  };

  const handleAdminToggle = () => {
    // Only verify answer when ENTERING admin mode
    if (adminAnswer.trim() === String(mathChallenge.sum)) {
      setIsAdminMode(true);
      showToast('🔓 Admin Mode ENABLED');
      setShowAdminChallenge(false);
      setAdminAnswer('');
    } else {
      showToast('❌ Incorrect answer');
      setAdminAnswer('');
    }
  };

  const generateNewChallenge = () => {
    const a = Math.floor(Math.random() * 5) + 1;
    const b = Math.floor(Math.random() * 5) + 1;
    setMathChallenge({ a, b, sum: a + b });
  };

  const handleAdminTrigger = () => {
    const now = Date.now();
    const DOUBLE_TAP_DELAY = 500;

    if (now - lastTapRef.current < DOUBLE_TAP_DELAY) {
      if (isAdminMode) {
        // Exit directly
        setIsAdminMode(false);
        showToast('🔒 Admin Mode DISABLED');
      } else {
        // Enter: Generate challenge and show modal
        generateNewChallenge();
        setShowAdminChallenge(true);
      }
      lastTapRef.current = 0; // Reset
    } else {
      lastTapRef.current = now;
    }
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

  // --- LAZY INFINITE SCROLL ---
  // Local state for the feed data that can be appended
  const [feedData, setFeedData] = useState<Event[]>([]);
  const originalEventsRef = useRef<Event[]>([]);
  const prevEventIdsRef = useRef<string>('');

  // Initialize/reset feedData only when the actual source events change (not just reference)
  useEffect(() => {
    if (events.length > 0) {
      // Create a stable ID string from event IDs to detect actual changes
      const currentEventIds = events.map(e => e.event_id).join(',');

      if (currentEventIds !== prevEventIdsRef.current) {
        console.log('📜 Source events changed - resetting feed data');
        prevEventIdsRef.current = currentEventIds;
        originalEventsRef.current = events;
        setFeedData(events);
      }
    }
  }, [events]);


  // Handler for infinite scroll - append more events when near the end
  const handleEndReached = useCallback(() => {
    // Check if infinite scroll is enabled (default to true if not specified)
    if (config?.enableInfiniteScroll === false) {
      console.log('📜 End reached - infinite scroll disabled');
      return;
    }

    if (originalEventsRef.current.length === 0) return;

    console.log('📜 End reached - appending more events for infinite scroll');
    setFeedData(prev => [...prev, ...originalEventsRef.current]);
  }, [config?.enableInfiniteScroll]);


  // Use feedData for the list, fallback to events if feedData is empty
  const upNextEvents = feedData.length > 0 ? feedData : events;


  const scrollToNewestArrival = () => {
    if (recentlyArrivedIds.length === 0 || !flatListRef.current) return;

    // Find the first (newest) event in the list that is currently marked as a recent arrival
    const newestIndex = events.findIndex(e => recentlyArrivedIds.includes(e.event_id));

    if (newestIndex !== -1) {
      console.log(`📜 Scrolling and playing newest arrival at index ${newestIndex}`);

      // 1. Select the event (Auto-play)
      onEventSelect(events[newestIndex]);

      // 2. Scroll to it
      try {
        flatListRef.current.scrollToIndex({
          index: newestIndex,
          animated: true,
          viewPosition: 0.5 // Center it
        });
      } catch (err) {
        console.warn('Scroll to newest arrival failed');
      }
    }
  };

  const renderUpNextItem = ({ item }: { item: Event }) => {
    const itemMetadata = eventMetadata[item.event_id];
    const isNowPlaying = item.event_id === selectedEvent?.event_id;
    const isRead = readEventIds.includes(item.event_id);
    const isNewArrival = recentlyArrivedIds.includes(item.event_id);

    return (
      <View style={styles.upNextItemContainer}>
        <TouchableOpacity
          style={[
            styles.upNextItem,
            isNowPlaying && styles.upNextItemNowPlaying,
            isNewArrival && !isNowPlaying && styles.upNextItemNewArrival
          ]}
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
              {isNowPlaying && '▶️ '}{itemMetadata?.description || 'Reflection'}
            </Text>

            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              {item.video_url ? (
                <>
                  <FontAwesome name="video-camera" size={12} color="rgba(255, 255, 255, 0.7)" style={{ marginRight: 4 }} />
                  <Text style={[styles.upNextMeta, isNowPlaying && styles.upNextMetaNowPlaying]}>Video</Text>
                </>
              ) : itemMetadata?.image_source === 'search' ? (
                <>
                  <FontAwesome name="search" size={12} color="rgba(255, 255, 255, 0.7)" style={{ marginRight: 4 }} />
                  <Text style={[styles.upNextMeta, isNowPlaying && styles.upNextMetaNowPlaying]}>Image</Text>
                </>
              ) : (
                <>
                  <FontAwesome name="camera" size={12} color="rgba(255, 255, 255, 0.7)" style={{ marginRight: 4 }} />
                  <Text style={[styles.upNextMeta, isNowPlaying && styles.upNextMetaNowPlaying]}>Photo</Text>
                </>
              )}
              {isNowPlaying && <Text style={styles.upNextMetaNowPlaying}> • NOW PLAYING</Text>}
              {isNewArrival && !isNowPlaying && <Text style={styles.upNextMetaNew}> • NEW</Text>}
            </View>

            <Text style={[styles.upNextDate, isNowPlaying && styles.upNextDateNowPlaying]}>
              {formatEventDate(item.event_id)}
            </Text>

            <Text style={styles.reflectionId}>
              Reflection ID: {item.event_id}
            </Text>
          </View>

          {/* Delete Button - Only visible in Admin Mode */}
          {isAdminMode && (
            <TouchableOpacity
              style={styles.deleteButton}
              onPress={() => {
                Alert.alert(
                  "Delete Reflection",
                  "Are you sure you want to permanently delete this reflection?",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Delete",
                      style: "destructive",
                      onPress: () => {
                        onDelete(item);
                        showToast('🗑️ Reflection deleted');
                      }
                    }
                  ]
                );
              }}
            >
              <FontAwesome name="trash" size={20} color="rgba(255, 100, 100, 0.9)" />
            </TouchableOpacity>
          )}
        </TouchableOpacity>
      </View>
    );
  };


  if (!selectedEvent) return <View style={styles.modalContainer} />;


  return (
    <LinearGradient
      colors={['#0f2027', '#203a43', '#2c5364']}
      style={styles.modalContainer}
      {...panResponder.panHandlers}
    >
      <View style={[styles.splitContainer, isLandscape ? styles.splitContainerLandscape : styles.splitContainerPortrait]}>

        {/* LEFT PANE */}
        <View style={[styles.stagePane, isLandscape ? { flex: 0.7 } : { flex: 0.55 }]}>

          {/* Header */}
          <View style={[styles.headerBar, { top: insets.top + 10 }]}>
            <View style={{ flexDirection: 'row', justifyContent: 'flex-start', alignItems: 'center', backgroundColor: 'transparent' }}>
              <View style={{ flex: 1 }}>
                {recentlyArrivedIds.length > 0 ? (
                  <TouchableOpacity
                    onPress={scrollToNewestArrival}
                    style={styles.newArrivalNotification}
                    activeOpacity={0.7}
                  >
                    <BlurView intensity={80} style={styles.notificationBlur}>
                      <Text style={styles.newArrivalText}>✨ {recentlyArrivedIds.length} New Reflection{recentlyArrivedIds.length > 1 ? 's' : ''}</Text>
                    </BlurView>
                  </TouchableOpacity>
                ) : (
                  events.length > 1 && <Text style={styles.reflectionsTitle}>Reflections</Text>
                )}
              </View>
            </View>



          </View>

          {/* Media Container */}
          <View style={styles.mediaContainer}>
            <View style={styles.mediaFrame}>
              {videoSource ? (
                <VideoView player={player} style={styles.mediaImage} nativeControls={false} contentFit="contain" />
              ) : (
                <Image source={{ uri: selectedEvent.image_url }} style={styles.mediaImage} resizeMode="contain" />
              )}


              {/* Replay / Pause Icon Overlay */}
              <Animated.View
                style={[styles.playOverlay, { opacity: controlsOpacity }]}
                pointerEvents={(state.matches('finished') || state.hasTag('paused')) ? 'auto' : 'none'}
              >
                {state.matches('finished') ? (
                  <TouchableOpacity onPress={handleReplay} style={styles.playButton}>
                    <BlurView intensity={30} style={styles.playOverlayBlur}>
                      <FontAwesome name="repeat" size={64} color="rgba(255, 255, 255, 0.95)" />
                    </BlurView>
                  </TouchableOpacity>
                ) : state.hasTag('paused') ? (
                  <View style={styles.playButton}>
                    <BlurView intensity={30} style={styles.playOverlayBlur}>
                      <FontAwesome name="pause" size={64} color="rgba(255, 255, 255, 0.95)" />
                    </BlurView>
                  </View>
                ) : null}
              </Animated.View>
            </View>

            {/* Loading Indicator removed - was blocking video */}
          </View>

          {/* Caption & Metadata */}
          <View style={[styles.metadataContainer, { paddingBottom: insets.bottom + 16 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
              {/* VU Meter for audio playback */}
              {isAnyAudioPlaying && (
                <Animated.View style={{ opacity: audioIndicatorAnim, marginRight: 12, marginTop: 2 }}>
                  <FontAwesome name="volume-up" size={20} color="rgba(255, 255, 255, 0.9)" />
                </Animated.View>
              )}

              <View style={{ flex: 1 }}>
                {/* Caption/Description - FIRST */}
                <Text style={styles.descriptionText} numberOfLines={2}>
                  {selectedMetadata?.short_caption || selectedMetadata?.description || ''}
                </Text>

                {/* From + Date line - SECOND */}
                {selectedMetadata?.sender && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6 }}>
                    <Text style={styles.senderText}>
                      From {selectedMetadata.sender}
                    </Text>
                    {selectedEvent?.event_id && (
                      <Text style={styles.dateText}>
                        {' • '}{formatEventDate(selectedEvent.event_id)}
                      </Text>
                    )}
                  </View>
                )}
              </View>
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
        <View style={[styles.upNextPane, isLandscape ? { flex: 0.3 } : { flex: 0.45 }, { paddingTop: insets.top + 10 }]}>
          <View style={styles.upNextHeader}>
            <Text style={styles.upNextHeaderText}>Up Next</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <TouchableOpacity
                onPress={handleAdminTrigger}
                activeOpacity={0.6}
                style={{ padding: 4 }}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <FontAwesome
                  name={isAdminMode ? "unlock" : "cog"}
                  size={15}
                  color={isAdminMode ? "#FF3B30" : "rgba(255,255,255,0.4)"}
                />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => router.push('/settings')}
                style={{ marginLeft: 12, padding: 4 }}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <FontAwesome name="info-circle" size={15} color="rgba(255,255,255,0.4)" />
              </TouchableOpacity>
            </View>
          </View>

          <FlatList
            ref={flatListRef}
            data={upNextEvents}
            renderItem={renderUpNextItem}
            keyExtractor={(item, index) => `${item.event_id}_${index}`}
            onEndReached={handleEndReached}
            onEndReachedThreshold={0.5}
            removeClippedSubviews={true}
            maxToRenderPerBatch={10}
            windowSize={5}
            onScrollToIndexFailed={(info) => {
              const wait = new Promise(resolve => setTimeout(resolve, 500));
              wait.then(() => {
                flatListRef.current?.scrollToIndex({ index: info.index, animated: true });
              });
            }}
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

      {/* Toast Notification */}
      {toastMessage ? (
        <Animated.View style={[styles.toast, { opacity: toastOpacity }]}>
          <Text style={styles.toastText}>{toastMessage}</Text>
        </Animated.View>
      ) : null}

      {/* Admin Challenge Modal */}
      <Modal
        visible={showAdminChallenge}
        transparent
        animationType="fade"
        onRequestClose={() => setShowAdminChallenge(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.adminChallengeOverlay}
        >
          <View style={styles.adminChallengeBox}>
            <View style={styles.adminLockIcon}>
              <FontAwesome name="lock" size={32} color="#007AFF" />
            </View>
            <Text style={styles.adminChallengeTitle}>Caregiver Mode</Text>
            <Text style={styles.adminChallengeSub}>To toggle delete access, please solve:</Text>
            <Text style={styles.mathProblem}>{mathChallenge.a} + {mathChallenge.b} = ?</Text>

            <TextInput
              style={styles.adminInput}
              keyboardType="number-pad"
              autoFocus
              maxLength={2}
              value={adminAnswer}
              onChangeText={setAdminAnswer}
              onSubmitEditing={handleAdminToggle}
              placeholder="?"
            />

            <View style={styles.adminButtonRow}>
              <TouchableOpacity
                style={[styles.adminButton, styles.adminCancelButton]}
                onPress={() => {
                  setShowAdminChallenge(false);
                  setAdminAnswer('');
                }}
              >
                <Text style={styles.adminCancelButtonText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.adminButton, styles.adminSubmitButton]}
                onPress={handleAdminToggle}
              >
                <Text style={styles.adminButtonText}>Verify</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  modalContainer: { flex: 1 },
  splitContainer: { flex: 1 },
  splitContainerLandscape: { flexDirection: 'row' },
  splitContainerPortrait: { flexDirection: 'column' },
  stagePane: { position: 'relative' },
  headerBar: { position: 'absolute', left: 20, right: 20, zIndex: 100 },

  reflectionsTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
  newUpdatesButton: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFD700', padding: 8, borderRadius: 20 },
  newUpdatesText: { color: '#000', fontWeight: 'bold' },
  mediaContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    paddingTop: 80, // More space for header
    paddingBottom: 120, // More space for caption bar
  },
  mediaFrame: {
    flex: 1,
    width: '100%',
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: '#1a3a44', // Match gradient midpoint instead of black
    // Subtle shadow for depth
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 10,
    // Subtle border
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
  },
  mediaImage: { width: '100%', height: '100%', resizeMode: 'contain' },
  playOverlay: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, justifyContent: 'center', alignItems: 'center' },
  playButton: { width: 120, height: 120, borderRadius: 60, overflow: 'hidden', justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0, 0, 0, 0.3)' },
  playOverlayBlur: { width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(255, 255, 255, 0.1)' },
  cameraBubble: { position: 'absolute', width: 100, height: 100, borderRadius: 50, overflow: 'hidden', borderWidth: 2, borderColor: '#fff', zIndex: 99999, elevation: 10 },
  cameraPreview: { flex: 1 },
  metadataContainer: {
    position: 'absolute',
    bottom: 20,
    left: 20,
    right: 20,
    padding: 20,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 20,
  },
  senderText: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 14,
    fontWeight: '600',
  },
  dateText: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 14,
  },
  descriptionText: { color: '#fff', fontSize: 18, lineHeight: 24 },


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
  tellMeMoreBlur: { flex: 1, width: '100%', justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(255, 255, 255, 0.1)' },
  upNextPane: {
    borderLeftWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.25)',
    paddingHorizontal: 12,
  },

  upNextHeader: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, paddingHorizontal: 4 },
  upNextHeaderText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
  upNextCount: { color: '#ccc' },
  upNextItemContainer: { marginVertical: 6, marginHorizontal: 4 },
  upNextItem: { flexDirection: 'row', padding: 12, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 12 },
  upNextItemNowPlaying: { backgroundColor: 'rgba(0,122,255,0.3)' },
  upNextThumbnail: { width: 56, height: 56, borderRadius: 8, marginRight: 12 },

  upNextTitle: { color: '#fff' },
  upNextTitleNowPlaying: { color: '#4FC3F7', fontWeight: 'bold' },
  upNextDate: { color: '#aaa', fontSize: 12, marginTop: 2 },
  upNextDateNowPlaying: { color: '#4FC3F7' },
  upNextMeta: { color: '#aaa', fontSize: 12, marginTop: 2 },
  upNextMetaNowPlaying: { color: '#4FC3F7', fontWeight: 'bold' },
  reflectionId: { fontSize: 9, color: 'rgba(255,255,255,0.3)', marginTop: 2, fontFamily: 'Courier' },
  upNextInfo: { flex: 1, justifyContent: 'center' },
  upNextItemNewArrival: {
    backgroundColor: 'rgba(255, 215, 0, 0.15)', // Soft gold tint
    borderColor: 'rgba(255, 215, 0, 0.5)',
    borderWidth: 1,
  },
  upNextMetaNew: { color: '#FFD700', fontWeight: 'bold', fontSize: 10, marginLeft: 4 },
  newArrivalNotification: {
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: 'rgba(255, 215, 0, 0.2)',
  },
  notificationBlur: {
    paddingVertical: 6,
    paddingHorizontal: 16,
  },
  newArrivalText: {
    color: '#FFD700',
    fontWeight: 'bold',
    fontSize: 14,
    textShadowColor: 'rgba(0, 0, 0, 0.75)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2
  },
  deleteButton: { padding: 10, justifyContent: 'center', alignItems: 'center' },
  toast: {
    position: 'absolute',
    bottom: 100,
    left: '50%',
    transform: [{ translateX: -150 }],
    width: 300,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
  },
  toastText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  videoLoadingOverlay: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 50,
  },
  videoLoadingText: {
    color: '#fff',
    marginTop: 10,
    fontSize: 18,
    fontWeight: '600',
  },
  // --- Admin Styles ---
  lockBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    marginLeft: 10,
  },
  lockText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 10,
    fontWeight: 'bold',
  },
  adminBadge: {
    backgroundColor: '#FF3B30',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    marginLeft: 10,
  },
  adminBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: 'bold',
  },
  adminChallengeOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.8)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  adminChallengeBox: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: '#fff',
    borderRadius: 24,
    padding: 24,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 10,
  },
  adminLockIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(0,122,255,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  adminChallengeTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#1C1C1E',
    marginBottom: 8,
  },
  adminChallengeSub: {
    fontSize: 14,
    color: '#8E8E93',
    textAlign: 'center',
    marginBottom: 20,
  },
  mathProblem: {
    fontSize: 32,
    fontWeight: '700',
    color: '#007AFF',
    marginBottom: 20,
  },
  adminInput: {
    width: '60%',
    height: 60,
    backgroundColor: '#F2F2F7',
    borderRadius: 16,
    fontSize: 28,
    textAlign: 'center',
    color: '#000',
    marginBottom: 24,
    borderWidth: 1,
    borderColor: '#E5E5EA',
  },
  adminButtonRow: {
    flexDirection: 'row',
    width: '100%',
    gap: 12,
  },
  adminButton: {
    flex: 1,
    height: 50,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  adminCancelButton: {
    backgroundColor: '#E5E5EA',
  },
  adminCancelButtonText: {
    color: '#3A3A3C',
    fontWeight: '600',
    fontSize: 16,
  },
  adminSubmitButton: {
    backgroundColor: '#007AFF',
  },
  adminButtonText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 16,
  },
});