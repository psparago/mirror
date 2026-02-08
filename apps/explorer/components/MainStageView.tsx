import { FontAwesome } from '@expo/vector-icons';
import { Event, EventMetadata, playerMachine } from '@projectmirror/shared';

import { useMachine } from '@xstate/react';
import { Audio } from 'expo-av';
import { BlurView } from 'expo-blur';
import { CameraView, PermissionResponse } from 'expo-camera';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';

import * as Speech from 'expo-speech';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Image } from 'expo-image';
import {
    Alert,
    FlatList,
    KeyboardAvoidingView,
    Modal,
    Platform,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    useWindowDimensions,
    View
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    withTiming
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface MainStageProps {
  visible: boolean;
  selectedEvent: Event | null;
  events: Event[];
  eventMetadata: { [key: string]: EventMetadata };
  onClose: () => void;
  onEventSelect: (event: Event) => void;
  onDelete: (event: Event) => void;
  onCaptureSelfie: () => Promise<void>;
  // Called when MainStage becomes "idle" (playback finished or user dismissed).
  // Used by the parent to flush pending work (e.g. selfie upload queue).
  onPlaybackIdle?: () => void;
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
    instantVideoPlayback?: boolean;
    readVideoCaptions?: boolean;
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
  onPlaybackIdle,
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
  // Perf: keep console logging opt-in; excessive logs + JSON.stringify can jank Hermes.
  const DEBUG_TRANSITIONS = __DEV__ && false;
  const DEBUG_LOGS = __DEV__ && false;
  const debugLog = (...args: any[]) => {
    if (DEBUG_LOGS) console.log(...args);
  };

  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const insets = useSafeAreaInsets();
  const router = useRouter();


  // --- LOCAL STATE (Visuals Only) ---
  // Reanimated shared values
  const flashOpacity = useSharedValue(0);
  const controlsOpacity = useSharedValue(0); // 0 = Hidden
  const selfieMirrorOpacity = useSharedValue(0);
  const audioIndicatorAnim = useSharedValue(0.7);
  const tellMeMorePulse = useSharedValue(1);

  // Swipe-to-minimize shared values
  const translateY = useSharedValue(0);
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);

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

  // Track when caption OR sparkle (Tell Me More) is playing - disable both buttons to prevent impatient multiple taps
  const [isCaptionOrSparklePlaying, setIsCaptionOrSparklePlaying] = useState(false);
  const setIsCaptionOrSparklePlayingRef = useRef<(v: boolean) => void>(() => {});
  useEffect(() => {
    setIsCaptionOrSparklePlayingRef.current = setIsCaptionOrSparklePlaying;
  }, []);

  // Get metadata (memoized to prevent unnecessary re-renders)
  const selectedMetadata = useMemo(
    () => selectedEvent ? eventMetadata[selectedEvent.event_id] : null,
    [selectedEvent, eventMetadata]
  );

  const positionText = useMemo(() => {
    if (!selectedEvent || events.length === 0) return '';
    const idx = events.findIndex(e => e.event_id === selectedEvent.event_id);
    if (idx === -1) return '';
    return `${idx + 1} of ${events.length}`;
  }, [events, selectedEvent?.event_id]);

  // Track previous event to prevent restart loops
  const prevEventIdRef = useRef<string | null>(null);
  const lastVideoFinishedEventIdRef = useRef<string | null>(null);

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
  const onPlaybackIdleRef = useRef(onPlaybackIdle);
  const configRef = useRef(config);
  
  // Bridge pattern refs for machine actions
  const sendRef = useRef<any>(() => {});
  const soundRef = useRef<Audio.Sound | null>(null);
  const playerRef = useRef<any>(null);
  const captionSoundRefForActions = useRef<Audio.Sound | null>(null);
  const performSelfieCaptureRef = useRef<((delay?: number) => Promise<void>) | null>(null);

  // --- THE XSTATE MACHINE ---
  const machine = useMemo(() => playerMachine.provide({
  actions: {
      stopAllMedia: async () => {
        // Increment session IMMEDIATELY and SYNCHRONOUSLY to invalidate any pending Narration/TTS
        captionSessionRef.current += 1;
        const thisStopSession = captionSessionRef.current;
        debugLog(`🛑 stopAllMedia [Session: ${thisStopSession}]`);

        // Clear any existing safety timers
        if (safetyTimeoutRef.current) {
          clearTimeout(safetyTimeoutRef.current);
          safetyTimeoutRef.current = null;
        }

        // Stop TTS immediately and forcefully
        Speech.stop();

        // Stop voice message audio
        const soundToUnload = soundRef.current;
        soundRef.current = null;
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
            debugLog('Sound already unloaded or error:', (e as Error).message);
          }
        }

        // Stop companion caption audio
        const soundToStop = captionSoundRefForActions.current || captionSoundRef.current;
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
          captionSoundRefForActions.current = null;
          setCaptionSound(null);
        }

        if (playerRef.current) {
          try {
            playerRef.current.pause();
            playerRef.current.currentTime = 0;
          } catch (err) {
            console.warn('Silent failure stopping player:', err);
          }
        }
        controlsOpacity.value = withTiming(0, { duration: 300 });

        // Clear caption/sparkle playing state
        setIsCaptionOrSparklePlayingRef.current(false);

        // Small delay to ensure everything stops
        await new Promise(resolve => setTimeout(resolve, 100));
      },

      speakCaption: async () => {
        const text = selectedMetadataRef.current?.description;
        const audioUrl = selectedEventRef.current?.audio_url;

        // Use current session (already incremented by stopAllMedia or initial)
        const thisSession = captionSessionRef.current;
        debugLog(`🎙️ speakCaption [Session: ${thisSession}]`);

        controlsOpacity.value = withTiming(0, { duration: 300 });

        if (audioUrl) {
          const playAudioWithRetry = async (retryCount = 0) => {
            try {
              debugLog(`🎧 Loading narration [Session: ${thisSession}] (Attempt ${retryCount + 1}): ${audioUrl.substring(0, 50)}...`);

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
                      debugLog(`✅ Narration finished [Session: ${thisSession}] - sending NARRATION_FINISHED`);
                      sendRef.current({ type: 'NARRATION_FINISHED' });
                    } else {
                      debugLog(`🚫 Narration finished but session changed [${thisSession} vs ${captionSessionRef.current}] - cleaning up`);
                      newCaptionSound.unloadAsync();
                      captionSoundRef.current = null;
                    }
                  }
                }
              );

              // CHECK SESSION AGAIN after load completes
              if (captionSessionRef.current !== thisSession) {
                debugLog(`🚫 Session changed during narration load [${thisSession} vs ${captionSessionRef.current}] - discarding`);
                newCaptionSound.unloadAsync();
                return;
              }

              captionSoundRef.current = newCaptionSound;
              captionSoundRefForActions.current = newCaptionSound;
              setCaptionSound(newCaptionSound);

              await newCaptionSound.playAsync();
              debugLog(`🎧 Narration playing [Session: ${thisSession}]`);

              // Smart Fallback based on actual duration
              const duration = (status as any).durationMillis || 5000;
              const safetyTimeout = duration + 2500; // Small buffer

              safetyTimeoutRef.current = setTimeout(() => {
                if (captionSessionRef.current === thisSession) {
                  console.warn(`⚠️ Narration safety fallback triggered [Session: ${thisSession}]`);
                  safetyTimeoutRef.current = null;
                  sendRef.current({ type: 'NARRATION_FINISHED' });
                }
              }, safetyTimeout);

            } catch (error: any) {
              console.error(`❌ Audio caption error (Attempt ${retryCount + 1}):`, error);
              if (retryCount < 1 && captionSessionRef.current === thisSession) {
                await new Promise(r => setTimeout(r, 1500));
                return playAudioWithRetry(retryCount + 1);
              }
              if (captionSessionRef.current === thisSession) {
                sendRef.current({ type: 'NARRATION_FINISHED' });
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
                debugLog('✅ TTS finished - sending NARRATION_FINISHED');
                sendRef.current({ type: 'NARRATION_FINISHED' });
              }
            },
            onError: () => {
              if (captionSessionRef.current === thisSession) {
                if (safetyTimeoutRef.current) {
                  clearTimeout(safetyTimeoutRef.current);
                  safetyTimeoutRef.current = null;
                }
                sendRef.current({ type: 'NARRATION_FINISHED' });
              }
            }
          });

          // TTS Fallback
          safetyTimeoutRef.current = setTimeout(() => {
            if (captionSessionRef.current === thisSession) {
              console.warn('⚠️ TTS safety fallback triggered');
              safetyTimeoutRef.current = null;
              sendRef.current({ type: 'NARRATION_FINISHED' });
            }
          }, 15000);
        } else {
          if (captionSessionRef.current === thisSession) {
            sendRef.current({ type: 'NARRATION_FINISHED' });
          }
        }
      },

      playVideo: async () => {
        // Preparation logic for video
        if (!playerRef.current) return;

        debugLog(`🎬 playVideo called: status=${playerRef.current.status}`);

        // Reset to start
        playerRef.current.currentTime = 0;

        // Trigger bubble animation
        selfieMirrorOpacity.value = withTiming(1, { duration: 500 });

        // The actual .play() call is now managed by the Hardware Sync useEffect for maximum reliability
      },

      playAudio: async () => {
        const playWithRetry = async (retryCount = 0) => {
          try {
            if (soundRef.current) await soundRef.current.unloadAsync();

            if (!selectedEventRef.current?.audio_url) {
              sendRef.current({ type: 'AUDIO_FINISHED' });
              return;
            }

            debugLog(`🎧 Playing audio: ${selectedEventRef.current.audio_url.substring(0, 80)}... (Attempt ${retryCount + 1})`);
            const { sound: newSound } = await Audio.Sound.createAsync(
              { uri: selectedEventRef.current.audio_url as string },
              { shouldPlay: true }
            );

            newSound.setOnPlaybackStatusUpdate((status) => {
              if (status.isLoaded && status.didJustFinish) {
                sendRef.current({ type: 'AUDIO_FINISHED' });
              }
            });
            soundRef.current = newSound;
            setSound(newSound);

          } catch (err: any) {
            console.error(`❌ Audio error (Attempt ${retryCount + 1}):`, err);

            if (retryCount < 1) {
              debugLog('🔄 Retrying audio load in 1.5s...');
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
            sendRef.current({ type: 'AUDIO_FINISHED' });
          }
        };

        playWithRetry();
      },

      playDeepDive: async () => {
        setIsCaptionOrSparklePlayingRef.current(true);

        // Stop any existing audio before playing deep dive
        Speech.stop();
        if (captionSoundRefForActions.current) {
          try {
            await captionSoundRefForActions.current.stopAsync();
            await captionSoundRefForActions.current.unloadAsync();
          } catch (e) {
            debugLog('Caption already stopped');
          }
          setCaptionSound(null);
          captionSoundRef.current = null;
          captionSoundRefForActions.current = null;
        }
        
        const playDeepDiveWithRetry = async (retryCount = 0) => {
          try {
            if (soundRef.current) await soundRef.current.unloadAsync();

            if (selectedEventRef.current?.deep_dive_audio_url) {
              debugLog(`🧠 Playing deep dive audio: ${selectedEventRef.current.deep_dive_audio_url.substring(0, 80)}... (Attempt ${retryCount + 1})`);
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
                  debugLog('✅ Deep dive audio finished - sending NARRATION_FINISHED');
                  setIsCaptionOrSparklePlayingRef.current(false);
                  sendRef.current({ type: 'NARRATION_FINISHED' });
                }
              });
              soundRef.current = newSound;
              setSound(newSound);

              // Smart Fallback for deep dive
              const duration = (status as any).durationMillis || 15000;
              const safetyTimeout = duration + 5000; // Extra generous buffer for deep dives

              if (safetyTimeoutRef.current) clearTimeout(safetyTimeoutRef.current);
              safetyTimeoutRef.current = setTimeout(() => {
                console.warn('⚠️ Deep dive safety timeout reached (Smart Fallback)');
                safetyTimeoutRef.current = null;
                setIsCaptionOrSparklePlayingRef.current(false);
                sendRef.current({ type: 'NARRATION_FINISHED' });
              }, safetyTimeout);

            } else if (selectedMetadataRef.current?.deep_dive) {
              Speech.speak(selectedMetadataRef.current.deep_dive, {
                onDone: () => {
                  if (safetyTimeoutRef.current) {
                    clearTimeout(safetyTimeoutRef.current);
                    safetyTimeoutRef.current = null;
                  }
                  setIsCaptionOrSparklePlayingRef.current(false);
                  sendRef.current({ type: 'NARRATION_FINISHED' });
                },
                onError: () => {
                  if (safetyTimeoutRef.current) {
                    clearTimeout(safetyTimeoutRef.current);
                    safetyTimeoutRef.current = null;
                  }
                  setIsCaptionOrSparklePlayingRef.current(false);
                  sendRef.current({ type: 'NARRATION_FINISHED' });
                }
              });

              // TTS Fallback - Deep dives are long, give it 60s
              if (safetyTimeoutRef.current) clearTimeout(safetyTimeoutRef.current);
              safetyTimeoutRef.current = setTimeout(() => {
                console.warn('⚠️ Deep dive TTS safety timeout reached');
                safetyTimeoutRef.current = null;
                setIsCaptionOrSparklePlayingRef.current(false);
                sendRef.current({ type: 'NARRATION_FINISHED' });
              }, 60000);
            } else {
              setIsCaptionOrSparklePlayingRef.current(false);
              sendRef.current({ type: 'NARRATION_FINISHED' });
            }
          } catch (err: any) {
            console.error(`❌ Deep dive audio error (Attempt ${retryCount + 1}):`, err);

            if (retryCount < 1 && selectedEventRef.current?.deep_dive_audio_url) {
              debugLog('🔄 Retrying deep dive audio load in 1.5s...');
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
            setIsCaptionOrSparklePlayingRef.current(false);
            sendRef.current({ type: 'NARRATION_FINISHED' });
          }
        };
        playDeepDiveWithRetry();
      },

      showSelfieBubble: () => {
        selfieMirrorOpacity.value = 1;
      },

      triggerSelfie: async () => {
        if (performSelfieCaptureRef.current) {
          await performSelfieCaptureRef.current(0);
        }
      },

      pauseMedia: async () => {
        if (playerRef.current && stateRef.current?.hasTag('video_mode')) {
          playerRef.current.pause();
        }
        if (soundRef.current) await soundRef.current.pauseAsync();
        if (captionSoundRefForActions.current) await captionSoundRefForActions.current.pauseAsync();
      },

      resumeMedia: async () => {
        if (playerRef.current && stateRef.current?.hasTag('video_mode')) {
          playerRef.current.play();
        }
        if (soundRef.current) await soundRef.current.playAsync();
        if (captionSoundRefForActions.current) await captionSoundRefForActions.current.playAsync();
      }
    }
  }), []); // Empty deps - all values accessed via refs (bridge pattern)

  // Initialize the Hook
  const [state, send] = useMachine(machine);

  // Update all bridge refs
  useEffect(() => {
    sendRef.current = send;
    stateRef.current = state;
    soundRef.current = sound;
    captionSoundRefForActions.current = captionSound;
  }, [send, state, sound, captionSound]);

  const lastTapRef = useRef<number>(0);
  const lastUpNextSelectionRef = useRef<{ id: string; time: number } | null>(null);
  const replayInProgressRef = useRef(false);

  // Helper functions to handle gestures (must be on JS thread, not worklets)
  const handleHorizontalSwipe = useCallback((translationX: number) => {
    const currentEvents = eventsRef.current;
    const currentSelected = selectedEventRef.current;
    const currentIndex = currentEvents.findIndex(e => e.event_id === currentSelected?.event_id);

    if (currentIndex === -1) return;

    if (translationX < -50) {
      debugLog('👈 Swiped Left (Next)');
      if (currentIndex < currentEvents.length - 1) {
        onEventSelectRef.current(currentEvents[currentIndex + 1]);
      } else if (configRef.current?.loopFeed && currentEvents.length > 0) {
        debugLog('↩️ Wrapped to start');
        onEventSelectRef.current(currentEvents[0]);
        try {
          flatListRef.current?.scrollToIndex({ index: 0, animated: true, viewPosition: 0.5 });
        } catch { }
      }
    } else if (translationX > 50) {
      debugLog('👉 Swiped Right (Previous)');
      if (currentIndex > 0) {
        onEventSelectRef.current(currentEvents[currentIndex - 1]);
      } else if (configRef.current?.loopFeed && currentEvents.length > 0) {
        debugLog('↪️ Wrapped to end');
        onEventSelectRef.current(currentEvents[currentEvents.length - 1]);
        try {
          flatListRef.current?.scrollToIndex({ index: currentEvents.length - 1, animated: true, viewPosition: 0.5 });
        } catch { }
      }
    }
  }, []);

  // Handle swipe-down dismiss - stops all media before closing
  const handleSwipeDismiss = useCallback(() => {
    debugLog('👇 Swipe Dismiss - stopping all media');

    // 1. Increment session to invalidate any pending callbacks
    captionSessionRef.current += 1;

    // 2. Stop TTS immediately
    Speech.stop();

    // 3. Stop any playing audio
    if (sound) {
      sound.stopAsync().catch(() => { });
      sound.unloadAsync().catch(() => { });
    }
    if (captionSound || captionSoundRef.current) {
      const soundToStop = captionSound || captionSoundRef.current;
      soundToStop?.stopAsync().catch(() => { });
      soundToStop?.unloadAsync().catch(() => { });
    }

    // 4. Clear safety timers
    if (safetyTimeoutRef.current) {
      clearTimeout(safetyTimeoutRef.current);
      safetyTimeoutRef.current = null;
    }

    // 5. Call the actual close handler (video stops when component unmounts)
    onPlaybackIdleRef.current?.();
    onClose();
  }, [sound, captionSound, onClose]);

  const handleSingleTap = useCallback(() => {
    const currentState = stateRef.current;
    const isVideo =
      !!selectedEventRef.current?.video_url || selectedMetadataRef.current?.content_type === 'video';
    
    // For videos: no pause/resume - only replay when finished
    if (isVideo) {
      if (currentState && (currentState.matches('finished') || currentState.matches({ viewingPhoto: 'viewing' }))) {
        debugLog('🔁 User pressed REPLAY (video)');
        
        // For videos, respect instant playback config on replay
        const useInstantPlayback = config?.instantVideoPlayback;
        
        if (useInstantPlayback && selectedEventRef.current && selectedMetadataRef.current) {
          // Replay with instant playback (skip narration)
          debugLog('⚡ Replaying with instant video playback (skipping narration)');
          send({ 
            type: 'SELECT_EVENT_INSTANT', 
            event: selectedEventRef.current, 
            metadata: selectedMetadataRef.current 
          });
        } else {
          // Standard replay (respects narration for videos)
          send({ type: 'REPLAY' });
        }
        
        if (onReplayRef.current && selectedEventRef.current) {
          onReplayRef.current(selectedEventRef.current);
        }
      }
      // Videos don't pause - ignore tap during playback
      return;
    }
    
    // For non-videos (audio/photos): allow pause/resume
    if (currentState && currentState.hasTag('active')) {
      if (currentState.hasTag('paused')) {
        debugLog('⏯️ Tapped to Resume');
        send({ type: 'RESUME' });
      } else {
        debugLog('⏸️ Tapped to Pause');
        send({ type: 'PAUSE' });
      }
    } else if (currentState && (currentState.matches('finished') || currentState.matches({ viewingPhoto: 'viewing' }))) {
      debugLog('🔁 User pressed REPLAY');
      send({ type: 'REPLAY' });
      if (onReplayRef.current && selectedEventRef.current) {
        onReplayRef.current(selectedEventRef.current);
      }
    }
  }, [send, config?.instantVideoPlayback]);

  // Horizontal swipe gesture for next/prev (applied to root container)
  const horizontalSwipeGesture = Gesture.Pan()
    .activeOffsetX([-20, 20]) // Activate after 20px horizontal movement
    .failOffsetY([-30, 30]) // Fail if vertical movement exceeds 30px first
    .onEnd((event) => {
      'worklet';
      // Only process swipes in the stage area (exclude bottom grid in portrait)
      const isInBottomGrid = !isLandscape && event.y > height * 0.55;
      const isHeader = event.y < 120;
      const isSidebar = isLandscape && event.x > width * 0.65;
      
      if (isHeader || isSidebar || isInBottomGrid) {
        return;
      }
      
      // Handle horizontal swipe for next/prev
      // Increased threshold to 30px to avoid accidental triggers during video playback
      if (Math.abs(event.translationX) > 30 && Math.abs(event.translationX) > Math.abs(event.translationY)) {
        runOnJS(handleHorizontalSwipe)(event.translationX);
        return; // Don't process tap if swipe was detected
      }

      // Handle single tap (only if no significant movement)
      // Stricter threshold to avoid accidental taps during video
      if (Math.abs(event.translationX) < 5 && Math.abs(event.translationY) < 5 && event.velocityX === 0 && event.velocityY === 0) {
        runOnJS(handleSingleTap)();
      }
    });

  // Vertical swipe gesture for minimize (ONLY on mediaFrame)
  // Threshold set to ~80px (roughly 1-2" on iPad) for easier triggering
  const verticalSwipeGesture = Gesture.Pan()
    .activeOffsetY([-20, 20]) // Activate after 20px vertical movement
    .failOffsetX([-30, 30]) // Fail if horizontal movement exceeds 30px first
    .onUpdate((event) => {
      // Only respond to downward drags
      if (event.translationY > 0) {
        translateY.value = event.translationY;
        // Scale down and fade out as we drag (more responsive)
        const progress = Math.min(event.translationY / 200, 1);
        scale.value = 1 - progress * 0.1; // Scale down by 10% max
        opacity.value = 1 - progress * 0.5; // Fade out by 50% max
      }
    })
    .onEnd((event) => {
      const threshold = 80; // Reduced from 150px to ~1-2" swipe
      if (event.translationY > threshold) {
        // Animate off-screen and close
        translateY.value = withTiming(height, { duration: 300 });
        scale.value = withTiming(0.8, { duration: 300 });
        opacity.value = withTiming(0, { duration: 300 }, () => {
          runOnJS(handleSwipeDismiss)();
        });
      } else {
        // Spring back to original position
        translateY.value = withSpring(0, { damping: 20, stiffness: 300 });
        scale.value = withSpring(1, { damping: 20, stiffness: 300 });
        opacity.value = withSpring(1, { damping: 20, stiffness: 300 });
      }
    });

  // Toast opacity shared value
  const toastOpacityShared = useSharedValue(0);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selfieCaptureTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selfieFadeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) {
        clearTimeout(toastTimeoutRef.current);
        toastTimeoutRef.current = null;
      }
      if (selfieCaptureTimeoutRef.current) {
        clearTimeout(selfieCaptureTimeoutRef.current);
        selfieCaptureTimeoutRef.current = null;
      }
      if (selfieFadeTimeoutRef.current) {
        clearTimeout(selfieFadeTimeoutRef.current);
        selfieFadeTimeoutRef.current = null;
      }
    };
  }, []);

  // Show toast notification
  const showToast = (message: string) => {
    setToastMessage(message);
    // IMPORTANT: do not call setTimeout inside a Reanimated worklet callback.
    toastOpacityShared.value = withTiming(1, { duration: 300 });

    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
      toastTimeoutRef.current = null;
    }

    toastTimeoutRef.current = setTimeout(() => {
      toastOpacityShared.value = withTiming(0, { duration: 300 }, (finished) => {
        if (finished) {
          runOnJS(setToastMessage)('');
        }
      });
    }, 2000);
  };

  // --- AUDIO/VIDEO REFS ---
  const videoSource = selectedEvent?.video_url || null;

  const player = useVideoPlayer(videoSource || '', (player) => {
    setIsVideoPlaying(player.playing);
  });

  // Update player ref when player changes
  useEffect(() => {
    playerRef.current = player;
  }, [player]);

  // Cleanup video player on unmount
  useEffect(() => {
    return () => {
      if (player) {
        try {
          player.pause();
          player.replace(''); // Clear source to release resources
        } catch (e) {
          // Player may already be released
        }
      }
    };
  }, [player]);

  // --- ACTIONS IMPLEMENTATION ---

  // Helper for reused selfie logic
  const performSelfieCapture = useCallback(async (delay = 0) => {
    // Ensure permission before starting ANY UI transitions (mirror, flash, etc)
    if (!cameraPermission?.granted) {
      try {
        const result = await requestCameraPermission();
        if (!result.granted) {
          debugLog('📸 Helper: Skipping selfie - camera permission not granted');
          return;
        }
      } catch (error) {
        debugLog('📸 Helper: Skipping selfie - permission request failed', error);
        return;
      }
    }

    debugLog(`📸 Helper: Starting Selfie Sequence (delay: ${delay}ms)`);
    // Fade in mirror
    selfieMirrorOpacity.value = withTiming(1, { duration: 500 });

    // Wait...
    if (selfieCaptureTimeoutRef.current) {
      clearTimeout(selfieCaptureTimeoutRef.current);
    }
    selfieCaptureTimeoutRef.current = setTimeout(async () => {
      debugLog('📸 Helper: Snapping now...');
      // Flash
      flashOpacity.value = withTiming(1, { duration: 150 }, () => {
        flashOpacity.value = withTiming(0, { duration: 250 });
      });

      // Capture
      await onCaptureSelfieRef.current();

      // Fade out
      if (selfieFadeTimeoutRef.current) {
        clearTimeout(selfieFadeTimeoutRef.current);
      }
      selfieFadeTimeoutRef.current = setTimeout(() => {
        debugLog('📸 Helper: Fading out bubble');
        selfieMirrorOpacity.value = withTiming(0, { duration: 500 });
      }, 500);
    }, delay);
  }, [onCaptureSelfie, flashOpacity, selfieMirrorOpacity]);

  // Update performSelfieCapture ref for machine
  useEffect(() => {
    performSelfieCaptureRef.current = performSelfieCapture;
  }, [performSelfieCapture]);



  // --- HARDWARE SYNC (Side Effects) ---
  // This effect ensures the actual hardware (Video/Audio) matches the machine state.
  // This is more reliable than actions due to closure staleness in active rendercycles.
  useEffect(() => {
    if (!player) return;

    // Check for both regular and instant video playback states
    const isMachinePlayingVideo = state.matches({ playingVideo: { playback: 'playing' } }) ||
      state.matches({ playingVideoInstant: { playback: 'playing' } });
    
    // Videos don't pause - only play or stop
    if (isMachinePlayingVideo) {
      if (!isVideoPlaying) {
        debugLog('⚡ Hardware Sync: Playing Video');
        player.play();
      }
    }
    // Removed pause handling for videos - they play through or finish
  }, [state.value, player, isVideoPlaying]);

  // --- DEBUG LOGGER (State Transitions) ---
  const prevStateRef = useRef<any>(null);
  useEffect(() => {
    if (!DEBUG_TRANSITIONS) return;
    if (state) {
      const stateStr = JSON.stringify(state.value);
      const prevStr = prevStateRef.current ? JSON.stringify(prevStateRef.current) : 'none';
      if (stateStr !== prevStr) {
        debugLog(`🤖 TRANSITION: ${prevStr} → ${stateStr}`);
        prevStateRef.current = state.value;
      }
    }
  }, [state, DEBUG_TRANSITIONS]);

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
    onPlaybackIdleRef.current = onPlaybackIdle;
    configRef.current = config;
  }, [events, selectedEvent, state, onEventSelect, onDelete, onCaptureSelfie, onReplay, selectedMetadata]);

  // Notify parent when we enter the finished state (video/audio/narration completed).
  const wasFinishedRef = useRef(false);
  useEffect(() => {
    const isFinished = !!state && state.matches('finished');
    if (isFinished && !wasFinishedRef.current) {
      onPlaybackIdleRef.current?.();
    }
    wasFinishedRef.current = isFinished;
  }, [state?.value]);

  // --- SYNC REACT EVENTS TO MACHINE ---

  // 1. New Event Selected (ONLY when event_id actually changes)
  useEffect(() => {
    const currentEventId = selectedEvent?.event_id || null;

    if (!selectedMetadata) return;

    // Only send SELECT_EVENT if the event ID actually changed
    if (currentEventId && currentEventId !== prevEventIdRef.current) {
      // We are leaving the previous reflection; treat this as an "idle" moment for parent work
      // (e.g. flush pending selfie upload queue).
      if (prevEventIdRef.current) {
        onPlaybackIdleRef.current?.();
      }
      prevEventIdRef.current = currentEventId;
        debugLog(`📩 User selected reflection: ${currentEventId}`);

      // Use instant video playback if configured and this is a video
      const isVideo = !!selectedEvent?.video_url;
      const useInstantPlayback = config?.instantVideoPlayback && isVideo;

      if (useInstantPlayback) {
        debugLog('⚡ Using instant video playback (skipping narration)');
        send({ type: 'SELECT_EVENT_INSTANT', event: selectedEvent!, metadata: selectedMetadata! });
      } else {
        send({ type: 'SELECT_EVENT', event: selectedEvent!, metadata: selectedMetadata! });
      }

      // Reset swipe-to-dismiss animation values for fresh overlay opening
      translateY.value = 0;
      scale.value = 1;
      opacity.value = 1;

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
  }, [selectedEvent?.event_id, selectedEvent, selectedMetadata, send, events, translateY, scale, opacity, config?.instantVideoPlayback]);

  // 2. Video Player Finished
  useEffect(() => {
    if (!player) return;
    const interval = setInterval(() => {
      // ONLY check for finish if we are in the 'playing' state (regular or instant)
      const isPlaying = state.matches({ playingVideo: { playback: 'playing' } }) ||
        state.matches({ playingVideoInstant: { playback: 'playing' } });
      if (!isPlaying) {
        return;
      }

      // Use 0.2s threshold to ensure we catch it before it actually stops
      if (player.duration > 0 && player.currentTime >= player.duration - 0.2) {
        debugLog(`🎬 Video finished at ${player.currentTime}/${player.duration}`);
        send({ type: 'VIDEO_FINISHED' });
        const currentEventId = selectedEventRef.current?.event_id || null;
        if (currentEventId && lastVideoFinishedEventIdRef.current !== currentEventId) {
          lastVideoFinishedEventIdRef.current = currentEventId;
          onPlaybackIdleRef.current?.();
        }
      }
    }, 200);
    return () => clearInterval(interval);
  }, [player, send, state.value]); // Use state.value to minimize re-renders but still update on transition

  // 3. Rewind video on completion for deep dive context
  useEffect(() => {
    if (state?.matches('finished') && player && (selectedMetadata?.content_type === 'video' || !!selectedEvent?.video_url)) {
      debugLog('🏁 Rewinding video to start for deep dive context');
      player.pause();
      player.currentTime = 0;
    }
  }, [state?.matches('finished'), player, selectedMetadata, selectedEvent]);

  // 4. Show/Hide Controls AND Bubble Based on State
  useEffect(() => {
    if (!state) return;

    const isVideo = !!selectedEvent?.video_url;
    
    if (state.matches('finished')) {
      // Finished: Show controls AND hide bubble
      controlsOpacity.value = withTiming(1, { duration: 200 });
      selfieMirrorOpacity.value = withTiming(0, { duration: 500 });
    } else if (!isVideo && state.hasTag('paused')) {
      // Paused (non-video only): Show controls
      controlsOpacity.value = withTiming(1, { duration: 200 });
    } else if (state.matches({ viewingPhoto: 'viewing' })) {
      // Photo viewing: Show controls
      controlsOpacity.value = withTiming(1, { duration: 200 });
    } else {
      // Playing: Hide controls (videos never show pause controls)
      controlsOpacity.value = withTiming(0, { duration: 200 });
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
      // Use Reanimated worklet for loop animation
      const loop = () => {
        'worklet';
        audioIndicatorAnim.value = withTiming(1, { duration: 300 }, () => {
          audioIndicatorAnim.value = withTiming(0.7, { duration: 300 }, loop);
        });
      };
      loop();
    } else {
      audioIndicatorAnim.value = 0.7;
    }
  }, [isAnyAudioPlaying]);

  // Pulse animation for Tell Me More button
  useEffect(() => {
    if (state && (state.matches('finished') || state.matches({ viewingPhoto: 'viewing' }))) {
      const loop = () => {
        'worklet';
        tellMeMorePulse.value = withTiming(1.15, { duration: 600 }, () => {
          tellMeMorePulse.value = withTiming(1, { duration: 600 }, loop);
        });
      };
      loop();
    } else {
      tellMeMorePulse.value = 1;
    }
  }, [state]);


  // --- RENDERING HELPERS ---

  const handleReplay = () => {
    // Ignore rapid multiple taps on replay
    if (replayInProgressRef.current) return;
    replayInProgressRef.current = true;
    setTimeout(() => { replayInProgressRef.current = false; }, 600);

    debugLog('🔁 User pressed REPLAY');
    
    // For videos, respect instant playback config on replay
    const isVideo = !!selectedEventRef.current?.video_url;
    const useInstantPlayback = config?.instantVideoPlayback && isVideo;
    
    if (useInstantPlayback && selectedEventRef.current && selectedMetadataRef.current) {
      // Replay with instant playback (skip narration)
      debugLog('⚡ Replaying with instant video playback (skipping narration)');
      send({ 
        type: 'SELECT_EVENT_INSTANT', 
        event: selectedEventRef.current, 
        metadata: selectedMetadataRef.current 
      });
    } else {
      // Standard replay (respects narration for videos)
      send({ type: 'REPLAY' });
    }
    
    if (onReplayRef.current && selectedEventRef.current) {
      onReplayRef.current(selectedEventRef.current);
    }
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
    // Ignore multiple taps on the already-selected card
    if (event.event_id === selectedEvent?.event_id) return;
    // Debounce rapid repeat taps on same card (before parent state propagates)
    const now = Date.now();
    const prev = lastUpNextSelectionRef.current;
    if (prev && prev.id === event.event_id && now - prev.time < 400) return;
    lastUpNextSelectionRef.current = { id: event.event_id, time: now };
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

  // Up Next list uses the unique `events` list (no duplication).
  // If looping is enabled, reaching the end wraps back to the top.
  const upNextEvents = events;
  // Require multiple "extra downward scrolls" at the end before wrapping.
  // IMPORTANT: FlatList's `onEndReached` is not reliable (fires early, and may not fire again),
  // and `scrollToIndex` can fail without `getItemLayout`. We rely on scroll metrics +
  // end-drag events, and wrap using `scrollToOffset(0)` which is reliable.
  const endWrapCountRef = useRef(0);
  const isNearEndRef = useRef(false);
  const lastUpNextScrollMetricsRef = useRef<{
    distanceFromEnd: number;
    offsetY: number;
    contentHeight: number;
    viewportHeight: number;
  } | null>(null);

  const wrapToTop = useCallback(() => {
    endWrapCountRef.current = 0;
    const m = lastUpNextScrollMetricsRef.current;
    debugLog(
      `📜 Wrapping Up Next to top (metrics: distanceFromEnd=${m?.distanceFromEnd ?? 'n/a'} offsetY=${m?.offsetY ?? 'n/a'} contentH=${m?.contentHeight ?? 'n/a'} viewportH=${m?.viewportHeight ?? 'n/a'})`
    );
    try {
      flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
    } catch (e) {
      console.warn('📜 wrapToTop scrollToOffset failed:', e);
    }
  }, []);


  const scrollToNewestArrival = () => {
    if (recentlyArrivedIds.length === 0 || !flatListRef.current) return;

    // Find the first (newest) event in the list that is currently marked as a recent arrival
    const newestIndex = events.findIndex(e => recentlyArrivedIds.includes(e.event_id));

    if (newestIndex !== -1) {
      debugLog(`📜 Scrolling and playing newest arrival at index ${newestIndex}`);

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
      <View style={[styles.upNextItemContainer, !isLandscape && { flex: 1 }]}>
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
          <Image 
            source={{ uri: item.image_url }} 
            style={styles.upNextThumbnail} 
            contentFit="cover"
            recyclingKey={item.event_id}
            cachePolicy="memory-disk"
          />
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
              {itemMetadata?.sender ? `${itemMetadata.sender} • ` : ''}{formatEventDate(item.event_id)}
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


  // CRITICAL: Return null (not empty View) so touches pass through to grid underneath
  if (!selectedEvent) return null;


  // Animated style for root container (swipe-to-minimize)
  const rootAnimatedStyle = useAnimatedStyle(() => {
    return {
      transform: [
        { translateY: translateY.value },
        { scale: scale.value },
      ],
      opacity: opacity.value,
    };
  });

  // Animated styles for other components
  const controlsAnimatedStyle = useAnimatedStyle(() => ({
    opacity: controlsOpacity.value,
  }));

  const selfieMirrorAnimatedStyle = useAnimatedStyle(() => ({
    opacity: selfieMirrorOpacity.value,
  }));

  const flashAnimatedStyle = useAnimatedStyle(() => ({
    opacity: flashOpacity.value,
  }));

  const audioIndicatorAnimatedStyle = useAnimatedStyle(() => ({
    opacity: audioIndicatorAnim.value,
  }));

  const tellMeMoreAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: tellMeMorePulse.value }],
  }));

  const toastAnimatedStyle = useAnimatedStyle(() => ({
    opacity: toastOpacityShared.value,
  }));

  return (
    <GestureDetector gesture={horizontalSwipeGesture}>
      <Animated.View style={[styles.modalContainer, rootAnimatedStyle]}>
        <LinearGradient
          colors={['#0f2027', '#203a43', '#2c5364']}
          style={StyleSheet.absoluteFill}
        >
          <View style={[styles.splitContainer, isLandscape ? styles.splitContainerLandscape : styles.splitContainerPortrait]}>

            {/* LEFT PANE */}
            <View style={[styles.stagePane, isLandscape ? { flex: 0.7 } : { flex: 0.60 }]}>

              {/* Header */}
              <View style={[styles.headerBar, { top: insets.top + 10 }]}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: 'transparent' }}>
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

                  {!!positionText && (
                    <Text style={styles.positionText}>{positionText}</Text>
                  )}
                </View>



              </View>

              {/* Media Container */}
              <View style={styles.mediaContainer}>
                <GestureDetector gesture={verticalSwipeGesture}>
                  <Animated.View style={styles.mediaFrame}>
                    {videoSource ? (
                      <VideoView player={player} style={styles.mediaImage} nativeControls={false} contentFit="contain" />
                    ) : (
                      <Image source={{ uri: selectedEvent.image_url }} style={styles.mediaImage} contentFit="contain" cachePolicy="memory-disk" />
                    )}


                    {/* Replay Icon Overlay (videos don't pause, only show replay when finished) */}
                    <Animated.View
                      style={[styles.playOverlay, controlsAnimatedStyle]}
                      pointerEvents={state.matches('finished') ? 'auto' : 'none'}
                    >
                      {state.matches('finished') ? (
                        <TouchableOpacity onPress={handleReplay} style={styles.playButton}>
                          <BlurView intensity={30} style={styles.playOverlayBlur}>
                            <FontAwesome name="repeat" size={64} color="rgba(255, 255, 255, 0.95)" />
                          </BlurView>
                        </TouchableOpacity>
                      ) : null}
                    </Animated.View>
                  </Animated.View>
                </GestureDetector>

                {/* Loading Indicator removed - was blocking video */}
              </View>

              {/* Caption & Metadata */}
              <View style={[styles.metadataContainer, { paddingBottom: insets.bottom + 16 }]}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                  {/* VU Meter for audio playback */}
                  {isAnyAudioPlaying && (
                    <Animated.View style={[audioIndicatorAnimatedStyle, { marginRight: 12, marginTop: 2 }]}>
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

                  {/* Play Caption Button - for videos and photos */}
                  {(() => {
                    const isMediaPlaying = state.hasTag('playing') || state.hasTag('speaking');
                    const isDisabled = isMediaPlaying || isCaptionOrSparklePlaying;

                    return (selectedEvent?.audio_url || selectedMetadata?.description) && (
                      <TouchableOpacity
                        style={[styles.playCaptionButton, isDisabled && styles.playCaptionButtonDisabled]}
                        onPress={async () => {
                          if (isDisabled) return;

                          setIsCaptionOrSparklePlaying(true);

                          // Stop any existing audio first
                          Speech.stop();
                          if (captionSound) {
                            try {
                              await captionSound.stopAsync();
                              await captionSound.unloadAsync();
                            } catch (e) {
                              debugLog('Caption already stopped');
                            }
                            setCaptionSound(null);
                          }

                          // Use audio file narration
                          if (selectedEvent?.audio_url) {
                            debugLog('🔊 Playing caption audio file');
                            try {
                              const { sound: newSound } = await Audio.Sound.createAsync(
                                { uri: selectedEvent.audio_url },
                                { shouldPlay: true }
                              );

                              newSound.setOnPlaybackStatusUpdate((status) => {
                                if (status.isLoaded && status.didJustFinish) {
                                  debugLog('✅ Caption audio finished');
                                  setIsCaptionOrSparklePlaying(false);
                                  newSound.unloadAsync();
                                }
                              });
                              setCaptionSound(newSound);
                            } catch (err) {
                              console.warn('Audio playback error:', err);
                              setIsCaptionOrSparklePlaying(false);
                            }
                          } else if (selectedMetadata?.description) {
                            // Only use TTS as a last resort if audio file is missing (despite expectation)
                            debugLog('🔊 Playing caption via TTS (Fallback)');
                            Speech.stop();
                            const textToSpeak = selectedMetadata.short_caption || selectedMetadata.description;
                            Speech.speak(textToSpeak, {
                              onDone: () => {
                                debugLog('✅ Caption TTS finished');
                                setIsCaptionOrSparklePlaying(false);
                              },
                              onError: (err) => {
                                console.warn('TTS error:', err);
                                setIsCaptionOrSparklePlaying(false);
                              }
                            });
                          }
                        }}
                        activeOpacity={isDisabled ? 1 : 0.7}
                        disabled={isDisabled}
                      >
                        <FontAwesome
                          name="volume-up"
                          size={18}
                          color={isDisabled ? "rgba(255, 255, 255, 0.3)" : "rgba(255, 255, 255, 0.8)"}
                        />
                      </TouchableOpacity>
                    );
                  })()}
                </View>

                {/* Tell Me More FAB */}
                {selectedMetadata?.deep_dive && state && (() => {
                  const isFinished = state.matches('finished');
                  const isViewingPhoto = state.matches('viewingPhoto');
                  const isNarrating = state.matches({ viewingPhoto: 'narrating' });
                  // Check if audio is done but stuck waiting for selfie (for images with audio_url)
                  const isAudioDoneButStuck = state.matches({ playingAudio: { playback: 'done' } });
                  const canShow = isFinished || isAudioDoneButStuck || (isViewingPhoto && !isNarrating);
                  const isMediaPlaying = state.hasTag('playing') || state.hasTag('speaking');
                  const isSparkleDisabled = isCaptionOrSparklePlaying || isMediaPlaying;
                  if (!canShow) return null;
                  return (
                  <Animated.View key="tellMeMore" style={[styles.tellMeMoreFAB, tellMeMoreAnimatedStyle]}>
                    <TouchableOpacity
                      onPress={async () => {
                        if (isSparkleDisabled) return;
                        debugLog('✨ User pressed Tell Me More button');
                        setIsCaptionOrSparklePlaying(true);
                        const currentState = state;
                        
                        // If we're in playingAudio state with audio done, play deep dive directly
                        // (the state machine doesn't handle TELL_ME_MORE in playingAudio)
                        if (currentState.matches({ playingAudio: { playback: 'done' } })) {
                          debugLog('🔄 In playingAudio state - directly playing deep dive');
                          
                          // Stop any existing audio/speech
                          Speech.stop();
                          if (captionSoundRefForActions.current) {
                            try {
                              await captionSoundRefForActions.current.stopAsync();
                              await captionSoundRefForActions.current.unloadAsync();
                            } catch (e) {}
                            captionSoundRefForActions.current = null;
                          }
                          
                          // Play deep dive directly
                          const event = selectedEventRef.current;
                          const metadata = selectedMetadataRef.current;
                          
                          if (event?.deep_dive_audio_url) {
                            try {
                              if (soundRef.current) await soundRef.current.unloadAsync();
                              const { sound: newSound } = await Audio.Sound.createAsync(
                                { uri: event.deep_dive_audio_url },
                                { shouldPlay: true, volume: 1.0 }
                              );
                              soundRef.current = newSound;
                              newSound.setOnPlaybackStatusUpdate((status) => {
                                if (status.isLoaded && status.didJustFinish) {
                                  setIsCaptionOrSparklePlaying(false);
                                  newSound.unloadAsync();
                                  soundRef.current = null;
                                }
                              });
                            } catch (err) {
                              if (metadata?.deep_dive) {
                                Speech.speak(metadata.deep_dive, {
                                  volume: 1.0,
                                  onDone: () => setIsCaptionOrSparklePlaying(false),
                                  onError: () => setIsCaptionOrSparklePlaying(false),
                                });
                              } else {
                                setIsCaptionOrSparklePlaying(false);
                              }
                            }
                          } else if (metadata?.deep_dive) {
                            Speech.speak(metadata.deep_dive, {
                              volume: 1.0,
                              onDone: () => setIsCaptionOrSparklePlaying(false),
                              onError: () => setIsCaptionOrSparklePlaying(false),
                            });
                          } else {
                            setIsCaptionOrSparklePlaying(false);
                          }
                        } else {
                          // For other states, use the state machine
                          send({ type: 'TELL_ME_MORE' });
                        }
                      }}
                      style={{ flex: 1, justifyContent: 'center', alignItems: 'center', opacity: isSparkleDisabled ? 0.4 : 1 }}
                      disabled={isSparkleDisabled}
                      activeOpacity={isSparkleDisabled ? 1 : 0.7}
                    >
                      <BlurView intensity={50} style={styles.tellMeMoreBlur}>
                        <Text style={{ fontSize: 32 }}>✨</Text>
                      </BlurView>
                    </TouchableOpacity>
                  </Animated.View>
                  );
                })()}
              </View>
            </View>

            {/* RIGHT PANE */}
            <View style={[styles.upNextPane, isLandscape ? { flex: 0.3 } : { flex: 0.40 }, { paddingTop: isLandscape ? insets.top + 10 : 5 }]}>
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
                keyExtractor={(item) => item.event_id}
                // NOTE: Avoid `onEndReached` for wrapping (it fires early and inconsistently).
                onScroll={(e) => {
                  const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
                  const distanceFromEnd = contentSize.height - (contentOffset.y + layoutMeasurement.height);
                  const nearEnd = distanceFromEnd < 80; // ~1–2 items worth of slack
                  isNearEndRef.current = nearEnd;
                  lastUpNextScrollMetricsRef.current = {
                    distanceFromEnd,
                    offsetY: contentOffset.y,
                    contentHeight: contentSize.height,
                    viewportHeight: layoutMeasurement.height,
                  };
                  // If user scrolls away from the end, reset the counter.
                  if (!nearEnd) {
                    endWrapCountRef.current = 0;
                  }
                }}
                scrollEventThrottle={16}
                onScrollEndDrag={() => {
                  if (!configRef.current?.loopFeed) return;
                  if (!isNearEndRef.current) return;
                  if (upNextEvents.length < 2) return;

                  endWrapCountRef.current += 1;
                  const m = lastUpNextScrollMetricsRef.current;
                  debugLog(
                    `📜 End extra-scroll (${endWrapCountRef.current}/2) (metrics: distanceFromEnd=${m?.distanceFromEnd ?? 'n/a'} offsetY=${m?.offsetY ?? 'n/a'})`
                  );

                  if (endWrapCountRef.current < 2) return;
                  wrapToTop();
                }}
                removeClippedSubviews={true}
                maxToRenderPerBatch={10}
                windowSize={5}
                key={isLandscape ? 'list' : 'grid'}
                numColumns={isLandscape ? 1 : 2}
                columnWrapperStyle={!isLandscape ? { gap: 8 } : undefined}
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
          }, selfieMirrorAnimatedStyle]}>
            {cameraPermission?.granted ? (
              <CameraView ref={cameraRef} style={styles.cameraPreview} facing="front" />
            ) : null}
            <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: 'white' }, flashAnimatedStyle]} />
          </Animated.View>

          {/* Toast Notification */}
          {toastMessage ? (
            <Animated.View style={[styles.toast, toastAnimatedStyle]}>
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
      </Animated.View>
    </GestureDetector>
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
  positionText: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 14,
    fontWeight: '700',
    marginLeft: 12,
  },
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