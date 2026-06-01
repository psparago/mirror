import { FontAwesome, FontAwesome5 } from '@expo/vector-icons';
import { ReactionRespondentsBar } from '@/components/ReactionRespondentsBar';
import { configureConnectPlaybackAudioSessionAsync } from '@/utils/audioSession';
import {
  buildEventForReplay,
  deleteReflectionDocument,
  fetchMirrorEventById,
  fetchReactionEventForPlayback,
  removeResponderFromParentReflection,
  resolveReactionParentPipMedia,
  resolveReactionPlaybackType,
  resolveReactionResponderFaceForPlayback,
  resolveReactionResponderFaces,
  shouldUseCompanionAvatarReactionPip,
  REACTION_PARENT_PLAYBACK_VOLUME,
  type ReactionParentPipMedia,
  type ReactionPlaybackSession,
  type ReactionResponderFace,
} from '@/utils/reactionPlayback';
import { CompanionAvatar, Event, EventMetadata, getCloudMasterTrimWindow, getVideoParkSeekSec, playerMachine, seekVideoToSeconds, WaitOverlay } from '@projectmirror/shared';
import { useMachine } from '@xstate/react';
import { Audio, ResizeMode, Video as AvVideo, type AVPlaybackStatus } from 'expo-av';
import { BlurView } from 'expo-blur';
import { Image } from 'expo-image';
import * as Speech from 'expo-speech';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, ActivityIndicator, Modal, Pressable, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface ReplayModalProps {
  visible: boolean;
  event: Event | null;
  onClose: () => void;
  likedBy?: string[];
  currentUserId?: string | null;
  currentIdentity?: string | null;
  explorerName?: string | null;
  companions?: CompanionAvatar[];
  onToggleLike?: (eventId: string, isAdd: boolean) => void;
  /** When set, shows a Send control in the header (Reflections Companion preview). */
  onSend?: () => void;
  isSending?: boolean;
  /** Extra disable reasons (e.g. empty caption); does not replace `isSending`. */
  isSendDisabled?: boolean;
  /** Edit flow: replace underlying media without closing the composer. */
  onReplaceMedia?: () => void;
  /** Preview mode: never synthesize TTS fallback; use recorded files only. */
  preferRecordedAudioOnly?: boolean;
  /** Parent reflection context for in-player reaction navigation. */
  reactionSession?: ReactionPlaybackSession | null;
  /** Called when in-player session changes (e.g. parent healed after delete). */
  onReactionSessionUpdate?: (
    session: ReactionPlaybackSession,
    parentPlaybackEvent: Event,
  ) => void;
  /** Active Companion `relationships/{id}` for arrayRemove on parent when deleting own reaction. */
  activeRelationshipId?: string | null;
  explorerId?: string;
}

async function unloadAvSoundSafely(sound: Audio.Sound | null | undefined): Promise<void> {
  if (!sound) return;
  try {
    await sound.stopAsync();
  } catch {
    /* ignore */
  }
  try {
    await sound.unloadAsync();
  } catch {
    /* ignore */
  }
}

async function takeAndUnloadSoundRef(
  ref: React.MutableRefObject<Audio.Sound | null>,
): Promise<void> {
  const sound = ref.current;
  ref.current = null;
  await unloadAvSoundSafely(sound);
}

export function ReplayModal({
  visible,
  event,
  onClose,
  likedBy = [],
  currentUserId,
  currentIdentity,
  explorerName,
  companions = [],
  onToggleLike,
  onSend,
  isSending = false,
  isSendDisabled = false,
  onReplaceMedia,
  preferRecordedAudioOnly = false,
  reactionSession = null,
  onReactionSessionUpdate,
  activeRelationshipId = null,
  explorerId,
}: ReplayModalProps) {
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
  const [isDeepDivePending, setIsDeepDivePending] = useState(false);
  const [isDirectDeepDivePlaying, setIsDirectDeepDivePlaying] = useState(false);
  const [showLikesModal, setShowLikesModal] = useState(false);
  const hasAutoPlayedDeepDiveRef = useRef(false);
  const deepDiveBreathTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoFinishHandledForEventRef = useRef<string | null>(null);
  const stateRef = useRef<any>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [playbackEvent, setPlaybackEvent] = useState<Event | null>(null);
  const [fetchingReactionFaceKey, setFetchingReactionFaceKey] = useState<string | null>(null);
  const reactionSessionRef = useRef<ReactionPlaybackSession | null>(null);
  const activeReactionResponderKeyRef = useRef<string | null>(null);
  const suppressInstantPlayEventIdRef = useRef<string | null>(null);
  const [showManualReplayOverlay, setShowManualReplayOverlay] = useState(false);
  const [isDeletingReaction, setIsDeletingReaction] = useState(false);
  const [resolvedParentPip, setResolvedParentPip] = useState<ReactionParentPipMedia | null>(null);
  const pipVideoRef = useRef<AvVideo>(null);
  const pipAlignedForEventRef = useRef<string | null>(null);
  const selfieUsesParentMainStageRef = useRef(false);
  const selfieUsesParentImageMainStageRef = useRef(false);
  const selfieUsesParentOnMainStageRef = useRef(false);

  const displayEvent = playbackEvent ?? event;
  const isReactionPlayback = displayEvent?.isReaction === true;
  const reactionPlaybackType = resolveReactionPlaybackType(displayEvent);
  const isSelfieReactionPlayback = isReactionPlayback && reactionPlaybackType === 'selfie';
  const usesCompanionAvatarPip = shouldUseCompanionAvatarReactionPip(reactionPlaybackType);
  const selfieUsesParentMainStage =
    isSelfieReactionPlayback &&
    resolvedParentPip?.mediaType === 'video' &&
    !!displayEvent?.video_url;
  const selfieUsesParentImageMainStage =
    isSelfieReactionPlayback &&
    resolvedParentPip?.mediaType === 'image' &&
    !!displayEvent?.video_url;
  const selfieUsesParentOnMainStage =
    selfieUsesParentMainStage || selfieUsesParentImageMainStage;

  useEffect(() => {
    selfieUsesParentMainStageRef.current = selfieUsesParentMainStage;
    selfieUsesParentImageMainStageRef.current = selfieUsesParentImageMainStage;
    selfieUsesParentOnMainStageRef.current = selfieUsesParentOnMainStage;
  }, [selfieUsesParentImageMainStage, selfieUsesParentMainStage, selfieUsesParentOnMainStage]);

  const reactionCaptionText = useMemo(() => {
    if (!isReactionPlayback) return null;
    if (reactionPlaybackType === 'typed') {
      return (
        displayEvent?.metadata?.reaction_message ||
        displayEvent?.metadata?.description ||
        null
      );
    }
    if (reactionPlaybackType === 'voice') {
      return 'Voice message';
    }
    return null;
  }, [displayEvent?.metadata?.description, displayEvent?.metadata?.reaction_message, isReactionPlayback, reactionPlaybackType]);

  // 2. Video Player Setup
  const videoPlayer = useVideoPlayer(event?.video_url || '', player => {
    player.loop = false;
  });

  // 3. Pulse animations for top sparkle + caption speaker while audio plays
  const tellMeMoreGlow = useSharedValue(1);
  const captionSpeakerGlow = useSharedValue(1);

  useEffect(() => {
    if (!visible) {
      setIsDeletingReaction(false);
    }
  }, [visible]);

  useEffect(() => {
    if (visible && reactionSession) {
      reactionSessionRef.current = reactionSession;
    }
    if (!visible) {
      reactionSessionRef.current = null;
    }
  }, [visible, reactionSession]);

  const playbackEventRef = useRef<Event | null>(null);
  useEffect(() => {
    playbackEventRef.current = displayEvent;
  }, [displayEvent]);

  useEffect(() => {
    if (!visible) {
      setPlaybackEvent(null);
      setFetchingReactionFaceKey(null);
      setShowManualReplayOverlay(false);
      suppressInstantPlayEventIdRef.current = null;
      return;
    }
    if (!event) return;

    const session = reactionSessionRef.current;
    const playback = playbackEventRef.current;
    // Timeline `event` may still be the deleted reaction while in-player parent is active.
    if (
      session &&
      playback &&
      playback.event_id === session.parentEventId &&
      event.event_id !== session.parentEventId
    ) {
      return;
    }

    setPlaybackEvent(event);
  }, [visible, event?.event_id]);

  useEffect(() => {
    if (!visible) return;
    if (selfieUsesParentImageMainStage) return;
    const url = selfieUsesParentMainStage
      ? resolvedParentPip?.url
      : displayEvent?.video_url;
    if (!url) return;
    try {
      videoPlayer.replace(url);
      videoPlayer.muted = false;
      videoPlayer.volume = selfieUsesParentMainStage ? REACTION_PARENT_PLAYBACK_VOLUME : 1;
      setVideoReady(false);
      videoFinishHandledForEventRef.current = null;
    } catch (error) {
      console.warn('[ReplayModal] video replace failed:', error);
    }
  }, [
    displayEvent?.event_id,
    displayEvent?.video_url,
    resolvedParentPip?.url,
    selfieUsesParentImageMainStage,
    selfieUsesParentMainStage,
    videoPlayer,
    visible,
  ]);

  const alignReactionPlayback = useCallback(async () => {
    if (!isReactionPlayback) return;
    const syncMs = displayEvent?.syncStartTimeMillis ?? 0;
    try {
      if (selfieUsesParentMainStage) {
        seekVideoToSeconds(videoPlayer, syncMs / 1000);
        videoPlayer.muted = false;
        videoPlayer.volume = REACTION_PARENT_PLAYBACK_VOLUME;
        await pipVideoRef.current?.setPositionAsync(0);
        await pipVideoRef.current?.setIsMutedAsync(false);
        await pipVideoRef.current?.setVolumeAsync(1);
        return;
      }
      if (selfieUsesParentImageMainStage) {
        await pipVideoRef.current?.setPositionAsync(0);
        await pipVideoRef.current?.setIsMutedAsync(false);
        await pipVideoRef.current?.setVolumeAsync(1);
        return;
      }
      await pipVideoRef.current?.setIsMutedAsync(true);
      await pipVideoRef.current?.setVolumeAsync(0);
      await pipVideoRef.current?.setPositionAsync(syncMs);
    } catch (error) {
      console.warn('[ReplayModal] reaction playback align failed:', error);
    }
  }, [
    displayEvent?.syncStartTimeMillis,
    isReactionPlayback,
    selfieUsesParentImageMainStage,
    selfieUsesParentMainStage,
    videoPlayer,
  ]);

  useEffect(() => {
    if (!visible || !isReactionPlayback) {
      setResolvedParentPip(null);
      pipAlignedForEventRef.current = null;
      void pipVideoRef.current?.pauseAsync().catch(() => {});
      return;
    }

    const sessionParent =
      reactionSessionRef.current?.parentEvent ?? reactionSession?.parentEvent;
    const sessionPip = resolveReactionParentPipMedia(sessionParent, {
      preferImage: false,
    });
    if (sessionPip) {
      setResolvedParentPip(sessionPip);
      return;
    }

    const parentId = displayEvent?.parentReflectionId;
    if (!parentId || !explorerId) {
      setResolvedParentPip(null);
      return;
    }

    let cancelled = false;
    void fetchMirrorEventById(parentId, explorerId)
      .then((parentEvent) => {
        if (cancelled) return;
        setResolvedParentPip(resolveReactionParentPipMedia(parentEvent, { preferImage: false }));
      })
      .catch((error) => {
        console.warn('[ReplayModal] failed to resolve parent media for PiP', error);
        if (!cancelled) setResolvedParentPip(null);
      });

    return () => {
      cancelled = true;
    };
  }, [
    visible,
    isReactionPlayback,
    displayEvent?.parentReflectionId,
    displayEvent?.event_id,
    explorerId,
    reactionSession?.parentEvent,
  ]);

  const resolvedParentVideoUrl =
    resolvedParentPip?.mediaType === 'video' &&
    isSelfieReactionPlayback &&
    !selfieUsesParentOnMainStage
      ? resolvedParentPip.url
      : null;
  const reactionSelfiePipUrl =
    selfieUsesParentOnMainStage ? displayEvent?.video_url ?? null : null;
  const reactionPipVideoActive =
    !usesCompanionAvatarPip && !!(resolvedParentVideoUrl || reactionSelfiePipUrl);

  useEffect(() => {
    if (!visible || !isReactionPlayback || !reactionPipVideoActive) return;
    if (pipAlignedForEventRef.current === displayEvent?.event_id) return;
    pipAlignedForEventRef.current = displayEvent?.event_id ?? null;
    void alignReactionPlayback();
  }, [
    alignReactionPlayback,
    displayEvent?.event_id,
    isReactionPlayback,
    reactionPipVideoActive,
    visible,
  ]);

  useEffect(() => {
    if (!visible || !isReactionPlayback || !reactionPipVideoActive) return;

    const syncPipPlayback = (shouldPlay: boolean) => {
      if (shouldPlay) {
        void (async () => {
          try {
            if (selfieUsesParentOnMainStageRef.current) {
              await pipVideoRef.current?.setIsMutedAsync(false);
              await pipVideoRef.current?.setVolumeAsync(1);
            } else {
              await pipVideoRef.current?.setIsMutedAsync(true);
              await pipVideoRef.current?.setVolumeAsync(0);
            }
            await pipVideoRef.current?.playAsync();
          } catch {
            // PiP sync is best-effort
          }
        })();
      } else {
        void pipVideoRef.current?.pauseAsync().catch(() => {});
      }
    };

    const playingSub = videoPlayer.addListener('playingChange', (evt: unknown) => {
      const isPlaying =
        evt && typeof evt === 'object' && 'isPlaying' in evt
          ? Boolean((evt as { isPlaying?: boolean }).isPlaying)
          : false;
      syncPipPlayback(isPlaying);
    });

    const endSub = videoPlayer.addListener('playToEnd', () => {
      if (selfieUsesParentOnMainStageRef.current) return;
      void pipVideoRef.current?.pauseAsync().catch(() => {});
    });

    return () => {
      playingSub.remove();
      endSub.remove();
      void pipVideoRef.current?.pauseAsync().catch(() => {});
    };
  }, [
    displayEvent?.event_id,
    isReactionPlayback,
    reactionPipVideoActive,
    selfieUsesParentOnMainStage,
    videoPlayer,
    visible,
  ]);

  const companionByRelationshipId = useMemo(() => {
    const map = new Map<string, CompanionAvatar>();
    for (const companion of companions) {
      if (companion.relationshipId) {
        map.set(companion.relationshipId, companion);
      }
    }
    return map;
  }, [companions]);

  const companionByUserId = useMemo(() => {
    const map = new Map<string, CompanionAvatar>();
    for (const companion of companions) {
      map.set(companion.userId, companion);
    }
    return map;
  }, [companions]);

  const reactionSessionForUi = reactionSessionRef.current ?? reactionSession;

  const reactionResponderFaces = useMemo(() => {
    if (!reactionSessionForUi?.respondedRelationshipIds?.length) return [];
    return resolveReactionResponderFaces(
      { respondedRelationshipIds: reactionSessionForUi.respondedRelationshipIds },
      companionByRelationshipId,
      companionByUserId,
    );
  }, [reactionSessionForUi, companionByRelationshipId, companionByUserId]);

  const isViewingChildReaction = !!(
    reactionSessionForUi &&
    displayEvent &&
    displayEvent.event_id !== reactionSessionForUi.parentEventId
  );

  const activeReactionFaceKey = useMemo(() => {
    if (!isViewingChildReaction || !displayEvent) return null;
    const senderId = displayEvent.metadata?.sender_id;
    if (senderId) {
      const matchedFace = reactionResponderFaces.find((face) => face.userId === senderId);
      if (matchedFace) {
        activeReactionResponderKeyRef.current = matchedFace.key;
        return matchedFace.key;
      }
    }
    return activeReactionResponderKeyRef.current;
  }, [isViewingChildReaction, displayEvent, reactionResponderFaces]);

  const activeReactionResponderFace = useMemo(
    () =>
      resolveReactionResponderFaceForPlayback(displayEvent, {
        companionByRelationshipId,
        companionByUserId,
        activeFaceKey: activeReactionFaceKey,
        responderFaces: reactionResponderFaces,
        reactionType: reactionPlaybackType,
      }),
    [
      activeReactionFaceKey,
      companionByRelationshipId,
      companionByUserId,
      displayEvent,
      reactionPlaybackType,
      reactionResponderFaces,
    ],
  );

  useEffect(() => {
    if (!isViewingChildReaction) {
      activeReactionResponderKeyRef.current = null;
    }
  }, [isViewingChildReaction, displayEvent?.event_id]);

  const handleInPlayerReactionPress = useCallback(async (face: ReactionResponderFace) => {
    const session = reactionSessionRef.current ?? reactionSession;
    if (!session || fetchingReactionFaceKey) return;
    if (!explorerId) {
      Alert.alert('Unable to load reaction', 'Explorer context is missing.');
      return;
    }

    const isSwitchingReaction =
      !!displayEvent && displayEvent.event_id !== session.parentEventId;
    if (isSwitchingReaction && activeReactionFaceKey === face.key) {
      return;
    }

    setFetchingReactionFaceKey(face.key);
    try {
      if (isSwitchingReaction) {
        sendRef.current({ type: 'CLOSE' });
        videoFinishHandledForEventRef.current = null;
        setVideoReady(false);
      }

      const reactionEvent = await fetchReactionEventForPlayback(
        session.parentEventId,
        face,
        explorerId,
      );
      if (!reactionEvent) {
        console.warn('[ReplayModal] reaction not found', {
          parentEventId: session.parentEventId,
          relationshipId: face.key,
        });
        Alert.alert('Unable to load reaction', 'That response could not be found.');
        return;
      }
      activeReactionResponderKeyRef.current = face.key;
      setPlaybackEvent(reactionEvent);
    } catch (error) {
      console.error('[ReplayModal] failed to load reaction', error);
      Alert.alert('Unable to load reaction', 'Something went wrong. Please try again.');
    } finally {
      setFetchingReactionFaceKey(null);
    }
  }, [
    activeReactionFaceKey,
    displayEvent,
    explorerId,
    fetchingReactionFaceKey,
    reactionSession,
  ]);

  const showReactionResponses = reactionResponderFaces.length > 0;

  const returnToParentReflection = useCallback((session: ReactionPlaybackSession) => {
    if (!session.parentEvent) return;

    suppressInstantPlayEventIdRef.current = session.parentEvent.event_id;
    activeReactionResponderKeyRef.current = null;
    try {
      Speech.stop();
    } catch {
      /* ignore */
    }
    sendRef.current({ type: 'CLOSE' });
    setShowManualReplayOverlay(true);
    setPlaybackEvent(session.parentEvent);
  }, []);

  const handleBackToParentReflection = useCallback(() => {
    const session = reactionSessionRef.current ?? reactionSession;
    returnToParentReflection(session);
  }, [reactionSession, returnToParentReflection]);

  const canDeleteReaction = !!(
    isViewingChildReaction &&
    currentUserId &&
    displayEvent?.metadata?.sender_id === currentUserId &&
    activeRelationshipId &&
    explorerId
  );

  const confirmDeleteReaction = useCallback(async () => {
    const session = reactionSessionRef.current ?? reactionSession;
    if (!session || !displayEvent || !explorerId || !activeRelationshipId) return;

    const deletedReactionId = displayEvent.event_id;

    setIsDeletingReaction(true);
    try {
      try {
        Speech.stop();
      } catch {
        /* ignore */
      }
      await takeAndUnloadSoundRef(captionSoundRef);
      setCaptionSound(null);
      await takeAndUnloadSoundRef(soundRef);
      void pipVideoRef.current?.pauseAsync().catch(() => {});
      try {
        videoPlayer.pause();
      } catch {
        /* ignore */
      }
      videoFinishHandledForEventRef.current = null;
      setVideoReady(false);
      sendRef.current({ type: 'CLOSE' });

      // Heal parent first so avatar stack updates even if media delete fails.
      await removeResponderFromParentReflection(
        session.parentEventId,
        activeRelationshipId,
      );
      await deleteReflectionDocument(deletedReactionId, explorerId);

      const fullParent = await fetchMirrorEventById(session.parentEventId, explorerId);
      const parentPlaybackEvent = buildEventForReplay(session.parentEventId, {
        metadata: session.parentEvent.metadata,
        reflectionImageUrl: session.parentEvent.image_url,
        senderLabel: session.parentAuthorName,
        description:
          session.parentEvent.metadata?.short_caption ||
          session.parentEvent.metadata?.description,
        fullEvent: fullParent,
      });

      const updatedSession: ReactionPlaybackSession = {
        ...session,
        parentEvent: parentPlaybackEvent,
        respondedRelationshipIds: session.respondedRelationshipIds.filter(
          (id) => id !== activeRelationshipId,
        ),
      };
      reactionSessionRef.current = updatedSession;
      onReactionSessionUpdate?.(updatedSession, parentPlaybackEvent);
      returnToParentReflection(updatedSession);
    } catch (error) {
      console.error('[ReplayModal] failed to delete reaction', error);
      Alert.alert(
        'Delete Failed',
        error instanceof Error ? error.message : 'Failed to delete reaction',
      );
    } finally {
      setIsDeletingReaction(false);
    }
  }, [
    activeRelationshipId,
    displayEvent,
    explorerId,
    onReactionSessionUpdate,
    reactionSession,
    returnToParentReflection,
    videoPlayer,
  ]);

  const handleDeleteReactionPress = useCallback(() => {
    Alert.alert(
      'Delete reaction?',
      'Are you sure you want to delete this reaction?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void confirmDeleteReaction();
          },
        },
      ],
    );
  }, [confirmDeleteReaction]);

  // FORCE AUDIO TO SPEAKER
  useEffect(() => {
    const configureAudioSession = async () => {
      try {
        debugLog('🔊 Configuring Audio Session for Playback...');
        await configureConnectPlaybackAudioSessionAsync();
      } catch (error) {
        console.error('Failed to configure audio session:', error);
      }
    };

    if (visible) {
      configureAudioSession();
    }
  }, [visible]);

  const tellMeMoreAnimatedStyle = useAnimatedStyle(() => ({
    opacity: tellMeMoreGlow.value,
    transform: [{ scale: 0.94 + tellMeMoreGlow.value * 0.06 }],
  }));

  const captionSpeakerAnimatedStyle = useAnimatedStyle(() => ({
    opacity: captionSpeakerGlow.value,
    transform: [{ scale: 0.94 + captionSpeakerGlow.value * 0.06 }],
  }));

  // 4. The State Machine & Refs
  const sendRef = useRef<any>(() => {});
  const eventRef = useRef<Event | null>(displayEvent);
  
  useEffect(() => {
    eventRef.current = displayEvent;
  }, [displayEvent]);

  useEffect(() => {
    hasAutoPlayedDeepDiveRef.current = false;
    setIsDeepDivePending(false);
    setIsDirectDeepDivePlaying(false);
    setShowLikesModal(false);
    setVideoReady(false);
    videoFinishHandledForEventRef.current = null;
    if (deepDiveBreathTimeoutRef.current) {
      clearTimeout(deepDiveBreathTimeoutRef.current);
      deepDiveBreathTimeoutRef.current = null;
    }
  }, [displayEvent?.event_id, visible]);

  const likedByPeople = useMemo(() => {
    return likedBy.map((uid) => {
      const companion = companions.find((c) => c.userId === uid);
      const fallbackName =
        uid === currentUserId
          ? currentIdentity || 'You'
          : explorerName || 'Explorer';
      const displayName = companion?.companionName || fallbackName;
      return {
        uid,
        displayName,
        avatarUrl: companion?.avatarUrl ?? null,
        initial: companion?.initial || displayName.trim().charAt(0).toUpperCase() || '?',
        color: companion?.color || '#4FC3F7',
        isCaregiver: !!companion?.isCaregiver,
      };
    });
  }, [companions, currentIdentity, currentUserId, explorerName, likedBy]);

  const machine = useMemo(() => playerMachine.provide({
    actions: {
      // --- MEDIA CONTROL ---
      stopAllMedia: async () => {
        try { Speech.stop(); } catch (e) {}

        await takeAndUnloadSoundRef(soundRef);
        await takeAndUnloadSoundRef(captionSoundRef);
        setCaptionSound(null);
        void pipVideoRef.current?.pauseAsync().catch(() => {});

        try {
          videoPlayer.pause();
          seekVideoToSeconds(videoPlayer, getVideoParkSeekSec(eventRef.current?.metadata));
          setVideoReady(false);
        } catch (e) {}
      },

      speakCaption: () => {
        if (eventRef.current?.isReaction) {
          sendRef.current({ type: 'NARRATION_FINISHED' });
          return;
        }

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
        } else if (!preferRecordedAudioOnly && (eventRef.current?.metadata?.short_caption || eventRef.current?.metadata?.description)) {
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
        try {
          videoFinishHandledForEventRef.current = null;
          setVideoReady(false);

          if (
            selfieUsesParentImageMainStageRef.current &&
            eventRef.current?.video_url
          ) {
            void pipVideoRef.current
              ?.setStatusAsync({
                positionMillis: 0,
                shouldPlay: true,
                isMuted: false,
                volume: 1,
              })
              .catch(() => {});
            return;
          }

          const trim = getCloudMasterTrimWindow(eventRef.current?.metadata);
          if (trim.active) {
            seekVideoToSeconds(videoPlayer, trim.startSec);
          } else if (
            eventRef.current?.isReaction &&
            resolveReactionPlaybackType(eventRef.current) === 'selfie' &&
            selfieUsesParentMainStageRef.current
          ) {
            seekVideoToSeconds(
              videoPlayer,
              (eventRef.current.syncStartTimeMillis ?? 0) / 1000,
            );
          }
          videoPlayer.muted = false;
          videoPlayer.volume = selfieUsesParentMainStageRef.current
            ? REACTION_PARENT_PLAYBACK_VOLUME
            : 1;
          videoPlayer.play();
        } catch (e) {
          console.warn('[ReplayModal] playVideo failed:', e);
        }
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
        void pipVideoRef.current?.pauseAsync().catch(() => {});
        if (soundRef.current) soundRef.current.pauseAsync();
        if (captionSoundRef.current) captionSoundRef.current.pauseAsync();
        Speech.stop();
      },
      
      resumeMedia: () => {
        if (selfieUsesParentImageMainStageRef.current) {
          void pipVideoRef.current?.playAsync().catch(() => {});
          return;
        }
        try {
          const trim = getCloudMasterTrimWindow(eventRef.current?.metadata);
          if (trim.active) {
            const t = videoPlayer.currentTime;
            if (t >= trim.endSec - 0.05 || t < trim.startSec - 0.05) {
              seekVideoToSeconds(videoPlayer, trim.startSec);
            }
          }
          videoPlayer.play();
        } catch (e) {
          console.warn('[ReplayModal] resumeMedia video failed:', e);
        }
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
        } else if (!preferRecordedAudioOnly && eventRef.current?.metadata?.deep_dive) {
           Speech.speak(eventRef.current.metadata.deep_dive, {
             onDone: () => sendRef.current({ type: 'NARRATION_FINISHED' }),
             onError: () => sendRef.current({ type: 'NARRATION_FINISHED' }),
           });
        } else {
          sendRef.current({ type: 'NARRATION_FINISHED' });
        }
      },
    }
  }), [videoPlayer, preferRecordedAudioOnly]);

  const [state, send] = useMachine(machine);

  const isDeepDivePlaying = isDirectDeepDivePlaying || state.matches('playingDeepDive');
  const isCaptionPlaying = state.hasTag('speaking') || captionSound !== null;

  useEffect(() => {
    if (isDeepDivePlaying) {
      tellMeMoreGlow.value = withRepeat(
        withTiming(0.55, { duration: 520 }),
        -1,
        true,
      );
    } else {
      tellMeMoreGlow.value = withTiming(1, { duration: 180 });
    }
  }, [isDeepDivePlaying]);

  useEffect(() => {
    if (isCaptionPlaying) {
      captionSpeakerGlow.value = withRepeat(
        withTiming(0.55, { duration: 520 }),
        -1,
        true,
      );
    } else {
      captionSpeakerGlow.value = withTiming(1, { duration: 180 });
    }
  }, [isCaptionPlaying]);

  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const parkVideoForCaption = useCallback(() => {
    const meta = eventRef.current?.metadata;
    try {
      videoPlayer.pause();
      seekVideoToSeconds(videoPlayer, getVideoParkSeekSec(meta));
      videoPlayer.muted = false;
      videoPlayer.volume = selfieUsesParentMainStageRef.current
        ? REACTION_PARENT_PLAYBACK_VOLUME
        : 1;
    } catch {
      // player may be tearing down
    }
    setVideoReady(false);
  }, [videoPlayer]);

  useEffect(() => {
    if (!visible || !selfieUsesParentMainStage) return;
    const sub = videoPlayer.addListener('playingChange', () => {
      try {
        videoPlayer.muted = false;
        videoPlayer.volume = REACTION_PARENT_PLAYBACK_VOLUME;
      } catch {
        // player may be tearing down
      }
    });
    return () => sub.remove();
  }, [selfieUsesParentMainStage, videoPlayer, visible]);

  const signalVideoFinished = useCallback(() => {
    const currentState = stateRef.current;
    const isInPlayingState =
      currentState?.matches({ playingVideo: { playback: 'playing' } }) ||
      currentState?.matches({ playingVideoInstant: { playback: 'playing' } });
    if (!isInPlayingState) return;

    const eventId = eventRef.current?.event_id;
    if (!eventId) return;
    if (videoFinishHandledForEventRef.current === eventId) return;
    videoFinishHandledForEventRef.current = eventId;

    parkVideoForCaption();
    sendRef.current({ type: 'VIDEO_FINISHED' });
  }, [parkVideoForCaption]);

  const signalVideoFinishedRef = useRef<() => void>(() => {});
  useEffect(() => {
    signalVideoFinishedRef.current = signalVideoFinished;
  }, [signalVideoFinished]);

  const handleSelfiePipStatusUpdate = useCallback(
    (status: AVPlaybackStatus) => {
      if (!selfieUsesParentOnMainStage || !status.isLoaded || !status.didJustFinish) return;
      if (selfieUsesParentMainStage) {
        try {
          videoPlayer.pause();
        } catch {
          // player may be tearing down
        }
      }
      void pipVideoRef.current?.pauseAsync().catch(() => {});
      signalVideoFinishedRef.current();
    },
    [selfieUsesParentMainStage, selfieUsesParentOnMainStage, videoPlayer],
  );

  useEffect(() => {
    if (!visible || !displayEvent?.video_url) return;
    const sub = videoPlayer.addListener('playingChange', (evt: unknown) => {
      const isPlaying =
        evt && typeof evt === 'object' && 'isPlaying' in evt
          ? Boolean((evt as { isPlaying?: boolean }).isPlaying)
          : false;
      if (isPlaying) {
        setVideoReady(true);
      }
    });
    return () => sub.remove();
  }, [visible, displayEvent?.video_url, videoPlayer]);

  useEffect(() => {
    if (!visible || !displayEvent?.video_url) return;
    if (!state.matches('finished')) return;
    try {
      videoPlayer.pause();
      seekVideoToSeconds(videoPlayer, getVideoParkSeekSec(displayEvent.metadata));
      setVideoReady(false);
    } catch {
      // player may be tearing down
    }
  }, [visible, state, displayEvent?.event_id, displayEvent?.video_url, displayEvent?.metadata, videoPlayer]);

  useEffect(() => {
    let cancelled = false;
    if (visible && displayEvent) {
      configureConnectPlaybackAudioSessionAsync()
        .catch((error) => {
          console.error('Failed to prepare playback audio session:', error);
        })
        .finally(() => {
          if (cancelled) return;
          if (suppressInstantPlayEventIdRef.current === displayEvent.event_id) {
            suppressInstantPlayEventIdRef.current = null;
            sendRef.current({ type: 'CLOSE' });
            setShowManualReplayOverlay(true);
            return;
          }
          setShowManualReplayOverlay(false);
          const playbackType = resolveReactionPlaybackType(displayEvent);
          const useInstantVideo =
            !displayEvent.isReaction || playbackType === 'selfie';
          sendRef.current({
            type: useInstantVideo ? 'SELECT_EVENT_INSTANT' : 'SELECT_EVENT',
            event: displayEvent,
            metadata: displayEvent.metadata || ({} as EventMetadata),
            takeSelfie: false,
          });
        });
    } else {
      sendRef.current({ type: 'CLOSE' });
    }
    return () => {
      cancelled = true;
      sendRef.current({ type: 'CLOSE' });
    };
  }, [visible, displayEvent?.event_id, send]);

  useEffect(() => {
    if (!showManualReplayOverlay || !displayEvent?.video_url) return;
    try {
      videoPlayer.pause();
      seekVideoToSeconds(videoPlayer, getVideoParkSeekSec(displayEvent.metadata));
      setVideoReady(false);
    } catch {
      // player may be tearing down
    }
  }, [showManualReplayOverlay, displayEvent?.event_id, displayEvent?.video_url, displayEvent?.metadata, videoPlayer]);

  useEffect(() => {
    const subscription = videoPlayer.addListener('playToEnd', () => {
      if (selfieUsesParentMainStageRef.current) return;
      signalVideoFinishedRef.current();
    });
    return () => subscription.remove();
  }, [videoPlayer]);

  // Cloud master: pause at metadata end and finish the video state (full file may extend past window).
  useEffect(() => {
    if (!visible) {
      try {
        videoPlayer.timeUpdateEventInterval = 0;
      } catch {
        /* ignore */
      }
      return;
    }
    const trim = getCloudMasterTrimWindow(displayEvent?.metadata);
    if (!trim.active || !displayEvent?.video_url) {
      try {
        videoPlayer.timeUpdateEventInterval = 0;
      } catch {
        /* ignore */
      }
      return;
    }
    const endSec = trim.endSec;
    videoPlayer.timeUpdateEventInterval = 0.1;
    const sub = videoPlayer.addListener('timeUpdate', () => {
      if (videoPlayer.currentTime >= endSec - 0.03) {
        try {
          videoPlayer.pause();
        } catch {
          /* ignore */
        }
        debugLog('🏁 Cloud master: trim window end (timeUpdate)');
        signalVideoFinishedRef.current();
      }
    });
    return () => {
      try {
        videoPlayer.timeUpdateEventInterval = 0;
      } catch {
        /* ignore */
      }
      sub.remove();
    };
  }, [
    visible,
    displayEvent?.event_id,
    displayEvent?.video_url,
    displayEvent?.metadata?.video_start_ms,
    displayEvent?.metadata?.video_end_ms,
    videoPlayer,
  ]);


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

  const playDeepDiveDirectly = useCallback(async () => {
    setIsDirectDeepDivePlaying(true);
    setIsDeepDivePending(false);

    Speech.stop();
    await takeAndUnloadSoundRef(captionSoundRef);
    setCaptionSound(null);
    await takeAndUnloadSoundRef(soundRef);

    const deepDiveAudioUrl = normalizeAudioUrl(eventRef.current?.deep_dive_audio_url);
    const isValidUrl = !!deepDiveAudioUrl &&
      (deepDiveAudioUrl.startsWith('http://') ||
       deepDiveAudioUrl.startsWith('https://') ||
       deepDiveAudioUrl.startsWith('file://'));

    if (isValidUrl) {
      try {
        const { sound: newSound } = await Audio.Sound.createAsync(
          { uri: deepDiveAudioUrl },
          { shouldPlay: true, volume: 1.0 }
        );
        soundRef.current = newSound;
        newSound.setOnPlaybackStatusUpdate((status) => {
          if (status.isLoaded && status.didJustFinish) {
            setIsDirectDeepDivePlaying(false);
            newSound.unloadAsync();
            soundRef.current = null;
          }
        });
      } catch {
        if (!preferRecordedAudioOnly && eventRef.current?.metadata?.deep_dive) {
          Speech.speak(eventRef.current.metadata.deep_dive, {
            volume: 1.0,
            onDone: () => setIsDirectDeepDivePlaying(false),
            onError: () => setIsDirectDeepDivePlaying(false),
            onStopped: () => setIsDirectDeepDivePlaying(false),
          });
        } else {
          setIsDirectDeepDivePlaying(false);
        }
      }
    } else if (!preferRecordedAudioOnly && eventRef.current?.metadata?.deep_dive) {
      Speech.speak(eventRef.current.metadata.deep_dive, {
        volume: 1.0,
        onDone: () => setIsDirectDeepDivePlaying(false),
        onError: () => setIsDirectDeepDivePlaying(false),
        onStopped: () => setIsDirectDeepDivePlaying(false),
      });
    } else {
      setIsDirectDeepDivePlaying(false);
    }
  }, [preferRecordedAudioOnly]);

  // LOGIC FOR SPARKLE / CO-HOST
  const isAudioDoneButStuck = state.matches({ playingAudio: { playback: 'done' } });
  const isViewingPhoto = state.matches('viewingPhoto');
  const isViewingPhotoViewing = state.matches({ viewingPhoto: 'viewing' });
  const isViewingPhotoNarrating = state.matches({ viewingPhoto: 'narrating' });
  const isFinished = state.matches('finished');
  const hasDeepDive = !!displayEvent?.metadata?.deep_dive || !!displayEvent?.deep_dive_audio_url;
  const canShowSparkle = hasDeepDive && (
    isFinished ||
    isAudioDoneButStuck ||
    (isViewingPhoto && !isViewingPhotoNarrating) ||
    isDeepDivePlaying
  );

  useEffect(() => {
    if (!visible || !displayEvent || !hasDeepDive) return;
    if (hasAutoPlayedDeepDiveRef.current) return;
    if (!(isViewingPhotoViewing || isAudioDoneButStuck || isFinished)) return;

    const shouldPlayDirectly = isAudioDoneButStuck;
    setIsDeepDivePending(true);
    const timeoutId = setTimeout(() => {
      hasAutoPlayedDeepDiveRef.current = true;
      deepDiveBreathTimeoutRef.current = null;
      setIsDeepDivePending(false);

      if (shouldPlayDirectly) {
        playDeepDiveDirectly();
      } else {
        send({ type: 'TELL_ME_MORE' });
      }
    }, 750);

    deepDiveBreathTimeoutRef.current = timeoutId;
    return () => {
      clearTimeout(timeoutId);
      deepDiveBreathTimeoutRef.current = null;
      setIsDeepDivePending(false);
    };
  }, [
    visible,
    displayEvent?.event_id,
    hasDeepDive,
    isViewingPhotoViewing,
    isAudioDoneButStuck,
    isFinished,
    playDeepDiveDirectly,
    send
  ]);

  if (!visible || !displayEvent) return null;

  // --- RENDER ---
  const hasVideo = !!displayEvent?.video_url;
  const usesVideoMainStage = (hasVideo || state.hasTag('video_mode')) && !selfieUsesParentImageMainStage;
  const parentMainImageUrl =
    selfieUsesParentImageMainStage && resolvedParentPip?.mediaType === 'image'
      ? resolvedParentPip.url
      : displayEvent.image_url;
  const isSpeaking = state.hasTag('speaking');
  const isPlaying = state.hasTag('playing');
  const isAnyAudioPlaying = isSpeaking || isPlaying || (captionSound !== null) || isDirectDeepDivePlaying;
  const likedByMe = !!currentUserId && likedBy.includes(currentUserId);
  const likeCount = likedBy.length;

  const handleSwipeClose = () => {
    if (isDeletingReaction) return;
    sendRef.current({ type: 'CLOSE' });
    setTimeout(() => { onClose(); }, 100);
  };

  const renderReactionPip = () => {
    if (!isReactionPlayback) return null;

    if (selfieUsesParentOnMainStage && displayEvent?.video_url) {
      return (
        <AvVideo
          ref={pipVideoRef}
          source={{ uri: displayEvent.video_url }}
          style={[styles.reactionPipVideo, styles.reactionSelfiePip]}
          resizeMode={ResizeMode.COVER}
          isMuted={false}
          volume={1}
          shouldPlay={false}
          progressUpdateIntervalMillis={100}
          onPlaybackStatusUpdate={handleSelfiePipStatusUpdate}
        />
      );
    }

    if (usesCompanionAvatarPip) {
      const face = activeReactionResponderFace;
      return (
        <View style={[styles.reactionPipVideo, styles.reactionCompanionAvatarPip]}>
          {face?.avatarUrl ? (
            <Image
              source={{ uri: face.avatarUrl }}
              style={styles.companionAvatarImage}
              contentFit="cover"
              cachePolicy="memory-disk"
            />
          ) : (
            <View
              style={[
                styles.companionAvatarFallback,
                { backgroundColor: face?.color ?? '#4FC3F7' },
              ]}
            >
              <Text style={styles.companionAvatarInitial}>{face?.initial ?? '?'}</Text>
            </View>
          )}
        </View>
      );
    }

    if (!resolvedParentPip) return null;

    if (resolvedParentPip.mediaType === 'video') {
      return (
        <AvVideo
          ref={pipVideoRef}
          source={{ uri: resolvedParentPip.url }}
          style={styles.reactionPipVideo}
          resizeMode={ResizeMode.CONTAIN}
          isMuted
          volume={0}
          shouldPlay={false}
        />
      );
    }

    return (
      <Image
        source={{ uri: resolvedParentPip.url }}
        style={styles.reactionPipVideo}
        contentFit="cover"
        cachePolicy="memory-disk"
      />
    );
  };

  const handleReplay = () => {
    hasAutoPlayedDeepDiveRef.current = false;
    setIsDeepDivePending(false);
    setIsDirectDeepDivePlaying(false);
    setShowManualReplayOverlay(false);
    if (deepDiveBreathTimeoutRef.current) {
      clearTimeout(deepDiveBreathTimeoutRef.current);
      deepDiveBreathTimeoutRef.current = null;
    }

    const playbackType = resolveReactionPlaybackType(displayEvent);
    const useInstantVideo =
      !displayEvent.isReaction || playbackType === 'selfie';

    send({
      type: useInstantVideo ? 'SELECT_EVENT_INSTANT' : 'SELECT_EVENT',
      event: displayEvent,
      metadata: displayEvent.metadata || ({} as EventMetadata),
      takeSelfie: false,
    });
    pipAlignedForEventRef.current = null;
    void alignReactionPlayback();
  };

  const handleToggleLike = () => {
    if (!displayEvent?.event_id || !currentUserId || !onToggleLike) return;
    onToggleLike(displayEvent.event_id, !likedByMe);
  };

  const handleShowLikes = () => {
    if (likeCount > 0) setShowLikesModal(true);
  };

  const showReplayOverlay =
    !isDeepDivePending &&
    !isDirectDeepDivePlaying &&
    (showManualReplayOverlay || isFinished || isAudioDoneButStuck || isViewingPhotoViewing);

  const swipeDownGesture = Gesture.Pan()
    .activeOffsetY([10, 200])
    .failOffsetX([-50, 50])
    .onEnd((event) => {
      if (event.translationY > 100) runOnJS(handleSwipeClose)();
    });

  const handlePlayCaption = async () => {
    if (isReactionPlayback) return;
    if (isAnyAudioPlaying) return; // Prevent overlapping

    // Stop existing
    Speech.stop();
    if (captionSoundRef.current) await captionSoundRef.current.unloadAsync().catch(()=>{});

    const audioUrl = normalizeAudioUrl(displayEvent?.audio_url);
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
        // Fall back to TTS only when enabled.
        if (!preferRecordedAudioOnly && displayEvent?.metadata?.description) {
          Speech.speak(displayEvent.metadata.description, { volume: 1.0 });
        }
      }
    } else if (displayEvent?.audio_url) {
      console.warn('⚠️ [handlePlayCaption] Invalid audio URL, using TTS. Raw:', displayEvent.audio_url, 'Normalized:', audioUrl);
      if (!preferRecordedAudioOnly && displayEvent?.metadata?.description) {
        Speech.speak(displayEvent.metadata.description, { volume: 1.0 });
      }
    } else if (!preferRecordedAudioOnly && displayEvent?.metadata?.description) {
      Speech.speak(displayEvent.metadata.description, { volume: 1.0 });
    }
  };

  const handleTellMeMorePress = async () => {
    hasAutoPlayedDeepDiveRef.current = true;
    setIsDeepDivePending(false);
    if (isAudioDoneButStuck || state.matches('playingAudio')) {
      await playDeepDiveDirectly();
    } else if (isViewingPhoto) {
      send({ type: 'TELL_ME_MORE' });
      setTimeout(() => {
        if (state.matches('viewingPhoto') && !state.matches('playingDeepDive')) {
          Speech.stop();
          if (displayEvent?.deep_dive_audio_url) {
            Audio.Sound.createAsync(
              { uri: displayEvent.deep_dive_audio_url },
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
              if (!preferRecordedAudioOnly && displayEvent?.metadata?.deep_dive) {
                Speech.speak(displayEvent.metadata.deep_dive, { volume: 1.0 });
              }
            });
          } else if (!preferRecordedAudioOnly && displayEvent?.metadata?.deep_dive) {
            Speech.speak(displayEvent.metadata.deep_dive, { volume: 1.0 });
          }
        }
      }, 300);
    } else {
      send({ type: 'TELL_ME_MORE' });
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent={false}>
      <GestureDetector gesture={swipeDownGesture}>
        <View style={styles.container}>
          {/* MAIN STAGE */}
          <View
            style={[
              styles.mediaContainer,
              { paddingTop: insets.top + 56 },
            ]}
          >
            <View style={styles.mediaFrame}>
              {usesVideoMainStage ? (
                <>
                  <VideoView
                    player={videoPlayer}
                    style={styles.mediaImage}
                    contentFit="contain"
                    nativeControls={false}
                  />
                  {renderReactionPip()}
                  {displayEvent.image_url && !videoReady && !selfieUsesParentMainStage ? (
                    <Image
                      source={{ uri: displayEvent.image_url }}
                      style={[styles.mediaImage, styles.posterShield]}
                      contentFit="contain"
                      cachePolicy="memory-disk"
                    />
                  ) : null}
                </>
              ) : (
                <>
                  <Image
                    source={{ uri: parentMainImageUrl }}
                    style={styles.mediaImage}
                    contentFit="contain"
                    cachePolicy="memory-disk"
                  />
                  {renderReactionPip()}
                </>
              )}

              {/* Replay overlay — appears after caption + deep dive completes */}
              {showReplayOverlay && (
                <View style={styles.replayOverlay}>
                  <TouchableOpacity
                    style={styles.replayButton}
                    onPress={handleReplay}
                    activeOpacity={0.8}
                  >
                    <FontAwesome name="repeat" size={28} color="#fff" />
                    <Text style={styles.replayText}>Replay</Text>
                  </TouchableOpacity>
                </View>
              )}

            </View>
          </View>

          {/* CAPTION BAR */}
          <View style={[styles.captionBar, { paddingBottom: insets.bottom + 16 }]}>
            {showReactionResponses ? (
              <ReactionRespondentsBar
                variant="caption"
                faces={reactionResponderFaces}
                fetchingFaceKey={fetchingReactionFaceKey}
                activeFaceKey={activeReactionFaceKey}
                onPressFace={(face) => {
                  void handleInPlayerReactionPress(face);
                }}
              />
            ) : null}
            <View style={styles.captionMainRow}>
              {!isReactionPlayback &&
              (displayEvent?.audio_url || displayEvent?.metadata?.description) ? (
                <Animated.View style={[styles.playCaptionButtonLeading, captionSpeakerAnimatedStyle]}>
                  <TouchableOpacity
                    style={[
                      styles.playCaptionButton,
                      isAnyAudioPlaying && !isCaptionPlaying && styles.playCaptionButtonDisabled,
                    ]}
                    onPress={handlePlayCaption}
                    disabled={!!isAnyAudioPlaying}
                    activeOpacity={0.85}
                    accessibilityRole="button"
                    accessibilityLabel={isCaptionPlaying ? 'Caption audio playing' : 'Play caption audio'}
                    accessibilityState={{ disabled: !!isAnyAudioPlaying }}
                  >
                    <FontAwesome
                      name="volume-up"
                      size={16}
                      color={
                        isCaptionPlaying
                          ? 'rgba(255, 255, 255, 0.9)'
                          : isAnyAudioPlaying
                            ? 'rgba(255, 255, 255, 0.35)'
                            : 'rgba(255, 255, 255, 0.9)'
                      }
                    />
                  </TouchableOpacity>
                </Animated.View>
              ) : null}

              <View style={styles.captionTextBlock}>
                {isReactionPlayback ? (
                  reactionCaptionText ? (
                    <Text style={styles.captionText} numberOfLines={3}>
                      {reactionCaptionText}
                    </Text>
                  ) : null
                ) : (
                  <Text style={styles.captionText} numberOfLines={2}>
                    {displayEvent.metadata?.short_caption ||
                      displayEvent.metadata?.description ||
                      'No caption'}
                  </Text>
                )}
              </View>

              <TouchableOpacity
                style={[styles.likeButton, likedByMe && styles.likeButtonActive]}
                onPress={handleToggleLike}
                onLongPress={handleShowLikes}
                delayLongPress={250}
                activeOpacity={0.75}
                accessibilityLabel={likedByMe ? 'Unlike this Reflection' : 'Like this Reflection'}
                accessibilityHint="Long press to see who liked this Reflection"
              >
                <FontAwesome
                  name={likeCount > 0 ? 'heart' : 'heart-o'}
                  size={18}
                  color={likedByMe ? '#4FC3F7' : likeCount > 0 ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.82)'}
                />
                {likeCount > 0 ? (
                  <Text style={[styles.likeButtonCount, likedByMe && styles.likeButtonCountActive]}>{likeCount}</Text>
                ) : null}
              </TouchableOpacity>
            </View>
            {displayEvent.metadata?.sender ? (
              <Text style={styles.senderText}>From {displayEvent.metadata.sender}</Text>
            ) : null}
          </View>

          {/* TOP CONTROLS - Rendered last to appear on top */}
          <View style={[styles.topControls, { top: insets.top + 8 }]}>
            {canShowSparkle && !isDeepDivePending ? (
              <Animated.View style={tellMeMoreAnimatedStyle}>
                <TouchableOpacity
                  style={[
                    styles.tellMeMoreTopButton,
                    isAnyAudioPlaying && !isDeepDivePlaying && styles.tellMeMoreTopButtonDisabled,
                  ]}
                  onPress={() => {
                    void handleTellMeMorePress();
                  }}
                  disabled={isAnyAudioPlaying || isDeepDivePlaying}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  accessibilityLabel={isDeepDivePlaying ? 'Deep dive playing' : 'Tell me more'}
                  accessibilityState={{ disabled: isAnyAudioPlaying || isDeepDivePlaying }}
                >
                  <BlurView intensity={45} style={styles.tellMeMoreTopBlur}>
                    <Text style={styles.tellMeMoreTopEmoji}>✨</Text>
                  </BlurView>
                </TouchableOpacity>
              </Animated.View>
            ) : null}
            {canShowSparkle && !isDeepDivePending ? (
              <View style={styles.topControlGap} />
            ) : null}
            {isViewingChildReaction && reactionSessionForUi ? (
              <TouchableOpacity
                style={[
                  styles.reactionBackButton,
                  isDeletingReaction && styles.deleteReactionButtonDisabled,
                ]}
                onPress={handleBackToParentReflection}
                disabled={isDeletingReaction}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel={`Back to ${reactionSessionForUi.parentAuthorName}'s Reflection`}
              >
                <FontAwesome name="chevron-left" size={12} color="#fff" />
                <Text style={styles.reactionBackButtonText} numberOfLines={1}>
                  {`Back to ${reactionSessionForUi.parentAuthorName}'s Reflection`}
                </Text>
              </TouchableOpacity>
            ) : (
              <View style={{ flex: 1 }} />
            )}
            {onReplaceMedia ? (
              <TouchableOpacity
                style={[styles.replacePreviewButton, isSending && styles.replacePreviewButtonDisabled]}
                onPress={onReplaceMedia}
                disabled={isSending}
                activeOpacity={0.85}
              >
                <FontAwesome name="image" size={14} color="#fff" />
                <Text style={styles.replacePreviewButtonText}>Replace Media</Text>
              </TouchableOpacity>
            ) : null}
            {onReplaceMedia ? <View style={styles.topControlGap} /> : null}
            {onSend ? (
              <TouchableOpacity
                style={[
                  styles.sendPreviewButton,
                  (isSending || isSendDisabled) && styles.sendPreviewButtonDisabled,
                ]}
                onPress={onSend}
                disabled={isSending || isSendDisabled}
                activeOpacity={0.85}
              >
                <FontAwesome5 name="paper-plane" size={14} color="#fff" solid />
                <Text style={styles.sendPreviewButtonText}>Send</Text>
              </TouchableOpacity>
            ) : null}
            {onSend ? <View style={styles.topControlGap} /> : null}
            {canDeleteReaction ? (
              <>
                <TouchableOpacity
                  style={[
                    styles.deleteReactionButton,
                    isDeletingReaction && styles.deleteReactionButtonDisabled,
                  ]}
                  onPress={handleDeleteReactionPress}
                  disabled={isDeletingReaction}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  accessibilityLabel="Delete this reaction"
                >
                  {isDeletingReaction ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <FontAwesome name="trash-o" size={17} color="#fff" />
                  )}
                </TouchableOpacity>
                <View style={styles.topControlGap} />
              </>
            ) : null}
            <TouchableOpacity
              style={[styles.closeButton, isDeletingReaction && styles.deleteReactionButtonDisabled]}
              onPress={handleSwipeClose}
              disabled={isDeletingReaction}
            >
              <FontAwesome name="times" size={18} color="#fff" />
            </TouchableOpacity>
          </View>

          {showLikesModal ? (
            <View style={styles.likesOverlay}>
              <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowLikesModal(false)} />
              <View style={styles.likesSheet}>
                <Text style={styles.likesTitle}>Liked by</Text>
                {likedByPeople.map((person) => (
                  <View key={person.uid} style={styles.likePersonRow}>
                    {person.avatarUrl ? (
                      <Image
                        source={{ uri: person.avatarUrl }}
                        style={styles.likePersonAvatar}
                        contentFit="cover"
                        recyclingKey={`replay-like-${person.uid}`}
                      />
                    ) : (
                      <View style={[styles.likePersonAvatarFallback, { backgroundColor: person.color }]}>
                        <Text style={styles.likePersonAvatarInitial}>{person.initial}</Text>
                      </View>
                    )}
                    <Text style={styles.likePersonName} numberOfLines={1}>{person.displayName}</Text>
                    {person.isCaregiver ? (
                      <FontAwesome name="shield" size={13} color="rgba(255,255,255,0.58)" />
                    ) : null}
                  </View>
                ))}
              </View>
            </View>
          ) : null}

          {isDeletingReaction ? (
            <WaitOverlay
              title="Deleting reaction…"
              detail="Removing your reaction from this Reflection."
              icon={<FontAwesome name="trash-o" size={20} color="#fecaca" />}
              tone="default"
            />
          ) : null}

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
  reactionBackButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 20,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.22)',
    marginRight: 8,
    minWidth: 0,
  },
  reactionBackButtonText: {
    flexShrink: 1,
    color: 'rgba(255, 255, 255, 0.92)',
    fontSize: 12,
    fontWeight: '600',
  },
  deleteReactionButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(120, 20, 20, 0.75)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255, 120, 120, 0.45)',
    zIndex: 1001,
    elevation: 1001,
  },
  deleteReactionButtonDisabled: {
    opacity: 0.45,
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
  topControlGap: {
    width: 10,
  },
  replacePreviewButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
    zIndex: 1001,
    elevation: 1001,
  },
  replacePreviewButtonDisabled: {
    opacity: 0.45,
  },
  replacePreviewButtonText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  sendPreviewButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 999,
    backgroundColor: '#2e78b7',
    zIndex: 1001,
    elevation: 1001,
  },
  sendPreviewButtonDisabled: {
    opacity: 0.45,
  },
  sendPreviewButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  likeButton: {
    minWidth: 44,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 12,
    marginLeft: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  likeButtonActive: {
    backgroundColor: 'rgba(79, 195, 247, 0.16)',
    borderColor: 'rgba(79, 195, 247, 0.45)',
  },
  likeButtonCount: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 13,
    fontWeight: '800',
  },
  likeButtonCountActive: {
    color: '#4FC3F7',
  },
  likesOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.45)',
    zIndex: 1200,
    elevation: 1200,
  },
  likesSheet: {
    margin: 14,
    padding: 18,
    borderRadius: 18,
    backgroundColor: 'rgba(26, 26, 26, 0.98)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    gap: 12,
  },
  likesTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  likePersonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  likePersonAvatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  likePersonAvatarFallback: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  likePersonAvatarInitial: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
  },
  likePersonName: {
    flex: 1,
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  mediaContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    paddingBottom: 120,
  },
  mediaFrame: {
    flex: 1,
    width: '100%',
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: '#1a3a44',
    boxShadow: '0px 8px 16px rgba(0, 0, 0, 0.4)',
    elevation: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
  },
  mediaImage: {
    width: '100%',
    height: '100%',
  },
  reactionPipVideo: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 148,
    height: 104,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.35)',
    backgroundColor: '#000',
    zIndex: 4,
  },
  reactionSelfiePip: {
    top: 14,
    right: 14,
    width: 112,
    height: 150,
    borderRadius: 14,
    borderColor: 'rgba(255,255,255,0.4)',
    zIndex: 5,
  },
  reactionCompanionAvatarPip: {
    top: 14,
    right: 14,
    width: 112,
    height: 150,
    borderRadius: 14,
    borderColor: 'rgba(255,255,255,0.4)',
    zIndex: 5,
    overflow: 'hidden',
    backgroundColor: '#101820',
  },
  companionAvatarImage: {
    width: '100%',
    height: '100%',
  },
  companionAvatarFallback: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  companionAvatarInitial: {
    color: '#fff',
    fontSize: 36,
    fontWeight: '700',
  },
  posterShield: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 2,
  },
  captionBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingTop: 16,
    paddingHorizontal: 20,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 20,
  },
  captionMainRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  captionTextBlock: {
    flex: 1,
    minWidth: 0,
    paddingRight: 8,
  },
  tellMeMoreTopButton: {
    width: 40,
    height: 40,
    marginLeft: 5,
    marginTop: 5,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.4)',
    zIndex: 1001,
    elevation: 1001,
  },
  tellMeMoreTopButtonDisabled: {
    opacity: 0.4,
  },
  tellMeMoreTopBlur: {
    flex: 1,
    width: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  tellMeMoreTopEmoji: {
    fontSize: 18,
  },
  captionText: {
    color: '#fff',
    fontSize: 18,
    lineHeight: 24,
  },
  senderText: {
    alignSelf: 'stretch',
    marginTop: 8,
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'left',
  },
  playCaptionButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  playCaptionButtonLeading: {
    marginRight: 12,
    marginTop: 2,
  },
  playCaptionButtonDisabled: {
    opacity: 0.4,
  },
  replayOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 24,
    zIndex: 5,
  },
  replayButton: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.4)',
  },
  replayText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
