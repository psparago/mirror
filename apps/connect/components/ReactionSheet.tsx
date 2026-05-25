import { uploadReactionSelfie } from '@/utils/reactionUpload';
import { FontAwesome } from '@expo/vector-icons';
import { useAuth, useExplorer, VideoTrimSlider } from '@projectmirror/shared';
import { Audio, ResizeMode, Video, type AVPlaybackStatus } from 'expo-av';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { requestRecordingPermissionsAsync } from 'expo-audio';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface ReactionSheetProps {
  visible: boolean;
  onClose: () => void;
  parentReflectionId: string;
  parentVideoUrl: string;
  onUploadSuccess?: (parentReflectionId: string, relationshipId: string) => void;
}

export function ReactionSheet({
  visible,
  onClose,
  parentReflectionId,
  parentVideoUrl,
  onUploadSuccess,
}: ReactionSheetProps) {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { currentExplorerId, activeRelationship } = useExplorer();
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micReady, setMicReady] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [positionMillis, setPositionMillis] = useState(0);
  const [durationMillis, setDurationMillis] = useState(0);
  const [recordedUri, setRecordedUri] = useState<string | null>(null);
  const [syncStartTimeMillis, setSyncStartTimeMillis] = useState<number | null>(null);
  const [syncEndTimeMillis, setSyncEndTimeMillis] = useState<number | null>(null);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);

  const videoRef = useRef<Video>(null);
  const cameraRef = useRef<CameraView>(null);
  const recordingPromiseRef = useRef<Promise<{ uri: string } | undefined> | null>(null);
  const parentVideoWidthRef = useRef(0);
  const seekOriginMsRef = useRef(0);
  const durationMillisRef = useRef(0);
  const canScrubRef = useRef(true);
  const isScrubbingRef = useRef(false);
  const lastSeekAtRef = useRef(0);

  const SEEK_TOLERANCE = useMemo(
    () => ({ toleranceMillisBefore: 0, toleranceMillisAfter: 0 }),
    [],
  );
  const SEEK_THROTTLE_MS = 50;

  useEffect(() => {
    durationMillisRef.current = durationMillis;
  }, [durationMillis]);

  useEffect(() => {
    canScrubRef.current = !isRecording && recordedUri == null;
  }, [isRecording, recordedUri]);

  useEffect(() => {
    if (!visible) return;
    void (async () => {
      const micPermission = await requestRecordingPermissionsAsync();
      setMicReady(micPermission.granted);
      if (!cameraPermission?.granted) {
        await requestCameraPermission();
      }
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
    })();
  }, [visible, cameraPermission?.granted, requestCameraPermission]);

  useEffect(() => {
    if (visible) return;
    setIsRecording(false);
    setPositionMillis(0);
    setDurationMillis(0);
    setRecordedUri(null);
    setSyncStartTimeMillis(null);
    setSyncEndTimeMillis(null);
    setIsPreviewPlaying(false);
    setCameraReady(false);
    setIsUploading(false);
    recordingPromiseRef.current = null;
    void videoRef.current?.pauseAsync().catch(() => {});
    cameraRef.current?.stopRecording();
  }, [visible]);

  useEffect(() => {
    if (!recordedUri || syncStartTimeMillis == null) return;
    void (async () => {
      try {
        await videoRef.current?.setPositionAsync(syncStartTimeMillis, SEEK_TOLERANCE);
        setPositionMillis(syncStartTimeMillis);
        await videoRef.current?.playAsync();
      } catch (error) {
        console.warn('[ReactionSheet] failed to start preview loop:', error);
      }
    })();
  }, [recordedUri, syncStartTimeMillis, SEEK_TOLERANCE]);

  const handlePlaybackStatusUpdate = useCallback((status: AVPlaybackStatus) => {
    if (!status.isLoaded) return;
    if (!isScrubbingRef.current) {
      setPositionMillis(status.positionMillis);
    }
    setDurationMillis(status.durationMillis ?? 0);

    if (!recordedUri && !isRecording && !isScrubbingRef.current && status.isLoaded) {
      setIsPreviewPlaying(status.isPlaying);
      if (status.didJustFinish) {
        setIsPreviewPlaying(false);
      }
    }

    if (
      recordedUri &&
      syncStartTimeMillis != null &&
      syncEndTimeMillis != null &&
      status.positionMillis >= syncEndTimeMillis
    ) {
      void videoRef.current?.setPositionAsync(syncStartTimeMillis, SEEK_TOLERANCE);
    }
  }, [recordedUri, syncEndTimeMillis, syncStartTimeMillis, SEEK_TOLERANCE, isRecording]);

  const toggleParentPlayback = useCallback(async () => {
    if (isRecording || recordedUri) return;
    try {
      const status = await videoRef.current?.getStatusAsync();
      if (!status?.isLoaded) return;
      if (status.isPlaying) {
        await videoRef.current?.pauseAsync();
        setIsPreviewPlaying(false);
      } else {
        await videoRef.current?.playAsync();
        setIsPreviewPlaying(true);
      }
    } catch (error) {
      console.warn('[ReactionSheet] toggle playback failed:', error);
    }
  }, [isRecording, recordedUri]);

  const seekParentVideo = useCallback(
    async (nextPositionMillis: number, options?: { throttle?: boolean }) => {
      if (isRecording || recordedUri) return;
      const target = Math.max(0, nextPositionMillis);
      setPositionMillis(target);
      if (options?.throttle) {
        const now = Date.now();
        if (now - lastSeekAtRef.current < SEEK_THROTTLE_MS) return;
        lastSeekAtRef.current = now;
      }
      try {
        await videoRef.current?.setPositionAsync(target, SEEK_TOLERANCE);
      } catch (error) {
        console.warn('[ReactionSheet] seek failed:', error);
      }
    },
    [SEEK_TOLERANCE, isRecording, recordedUri],
  );

  const handleSeek = useCallback(
    (nextPositionMillis: number) => {
      void seekParentVideo(nextPositionMillis, { throttle: true });
    },
    [seekParentVideo],
  );

  const handleScrubStart = useCallback(() => {
    isScrubbingRef.current = true;
  }, []);

  const handleScrubEnd = useCallback(() => {
    isScrubbingRef.current = false;
  }, []);

  const handleSeekDragStart = useCallback(() => {
    isScrubbingRef.current = true;
    seekOriginMsRef.current = positionMillis;
  }, [positionMillis]);

  const handleSeekDrag = useCallback(
    (translationX: number) => {
      if (!canScrubRef.current) return;
      const width = parentVideoWidthRef.current;
      const duration = durationMillisRef.current;
      if (width <= 0 || duration <= 0) return;
      const deltaMs = (translationX / width) * duration;
      const target = Math.max(0, Math.min(duration, seekOriginMsRef.current + deltaMs));
      void seekParentVideo(target, { throttle: true });
    },
    [seekParentVideo],
  );

  const handleSeekDragEnd = useCallback(() => {
    isScrubbingRef.current = false;
  }, []);

  const showScrubUi = !isRecording && recordedUri == null;

  const videoPanGesture = useMemo(() => {
    return Gesture.Pan()
      .activeOffsetX([-8, 8])
      .failOffsetY([-12, 12])
      .onBegin(() => {
        runOnJS(handleSeekDragStart)();
      })
      .onUpdate((event) => {
        runOnJS(handleSeekDrag)(event.translationX);
      })
      .onFinalize(() => {
        runOnJS(handleSeekDragEnd)();
      });
  }, [handleSeekDrag, handleSeekDragEnd, handleSeekDragStart]);

  const handlePressIn = useCallback(() => {
    if (recordedUri || !cameraReady || !cameraPermission?.granted || !micReady) {
      if (!recordedUri) {
        console.warn('[ReactionSheet] camera not ready for recording', {
          parentReflectionId,
          cameraReady,
          cameraGranted: cameraPermission?.granted,
          micReady,
        });
      }
      return;
    }

    void (async () => {
      const status = await videoRef.current?.getStatusAsync();
      if (status?.isLoaded) {
        setSyncStartTimeMillis(status.positionMillis);
      }
    })();

    setIsRecording(true);
    setIsPreviewPlaying(false);

    const recordingPromise = cameraRef.current?.recordAsync();
    if (recordingPromise) {
      recordingPromiseRef.current = recordingPromise;
      void recordingPromise.then((result) => {
        if (result?.uri) {
          console.log('Recorded local URI:', result.uri);
          setRecordedUri(result.uri);
        }
      }).catch((error) => {
        console.warn('[ReactionSheet] recordAsync failed:', error);
      });
    }

    void videoRef.current?.playAsync().catch((error) => {
      console.warn('[ReactionSheet] playAsync failed:', error);
    });
  }, [cameraPermission?.granted, cameraReady, micReady, parentReflectionId, recordedUri]);

  const handlePressOut = useCallback(() => {
    if (!isRecording) return;

    void (async () => {
      const status = await videoRef.current?.getStatusAsync();
      if (status?.isLoaded) {
        setSyncEndTimeMillis(status.positionMillis);
      }
      setIsRecording(false);
      await videoRef.current?.pauseAsync().catch(() => {});
      cameraRef.current?.stopRecording();
    })();
  }, [isRecording]);

  const handleRetake = useCallback(() => {
    const restartAt = syncStartTimeMillis;
    setRecordedUri(null);
    setSyncStartTimeMillis(null);
    setSyncEndTimeMillis(null);
    setIsPreviewPlaying(false);
    setCameraReady(false);
    void (async () => {
      if (restartAt != null) {
        await videoRef.current?.setPositionAsync(restartAt, SEEK_TOLERANCE);
        setPositionMillis(restartAt);
      }
      await videoRef.current?.pauseAsync().catch(() => {});
    })();
  }, [syncStartTimeMillis, SEEK_TOLERANCE]);

  const handleSend = useCallback(() => {
    if (!recordedUri || isUploading) return;
    if (!currentExplorerId) {
      Alert.alert('Explorer Not Ready', 'Please wait for the Explorer profile to load before sending.');
      return;
    }
    if (!user?.uid) {
      Alert.alert('Sign In Required', 'Please sign in to send a reaction.');
      return;
    }
    if (!activeRelationship?.id) {
      Alert.alert('Unable to Send', 'Your Companion link to this Explorer is missing.');
      return;
    }
    if (syncStartTimeMillis == null) {
      Alert.alert('Unable to Send', 'Reaction sync timing is missing. Please retake your reaction.');
      return;
    }

    void (async () => {
      setIsUploading(true);
      try {
        await uploadReactionSelfie({
          explorerId: currentExplorerId,
          parentReflectionId,
          recordedUri,
          syncStartTimeMillis,
          senderName: activeRelationship.companionName || 'Companion',
          senderId: user.uid,
          activeRelationshipId: activeRelationship.id,
        });
        onUploadSuccess?.(parentReflectionId, activeRelationship.id);
        onClose();
      } catch (error) {
        console.error('[ReactionSheet] upload failed:', error);
        Alert.alert(
          'Send Failed',
          error instanceof Error ? error.message : 'Failed to send reaction',
        );
      } finally {
        setIsUploading(false);
      }
    })();
  }, [
    activeRelationship,
    currentExplorerId,
    isUploading,
    onClose,
    onUploadSuccess,
    parentReflectionId,
    recordedUri,
    syncStartTimeMillis,
    user?.uid,
  ]);

  const canRecord = !recordedUri && cameraReady && !!cameraPermission?.granted && micReady;
  const isPreviewMode = recordedUri != null;
  const scrubDurationMs = Math.max(durationMillis, 1);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <GestureHandlerRootView style={styles.container}>
        <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
          <Text style={styles.headerTitle}>Live Sync Reaction</Text>
          <Pressable
            style={styles.closeButton}
            onPress={onClose}
            disabled={isUploading}
            accessibilityRole="button"
            accessibilityLabel="Close reaction recorder"
          >
            <FontAwesome name="times" size={18} color="#fff" />
          </Pressable>
        </View>

        <View style={styles.splitPane}>
          <View style={styles.parentVideoPane}>
            <View style={styles.mediaCard}>
              <Pressable
                style={styles.parentVideoPressable}
                onPress={toggleParentPlayback}
                disabled={!showScrubUi}
                accessibilityRole="button"
                accessibilityLabel={isPreviewPlaying ? 'Pause parent Reflection preview' : 'Play parent Reflection preview'}
              >
                <GestureDetector gesture={showScrubUi ? videoPanGesture : Gesture.Pan().enabled(false)}>
                  <View
                    style={styles.parentVideoSurface}
                    onLayout={(event) => {
                      parentVideoWidthRef.current = event.nativeEvent.layout.width;
                    }}
                  >
                    <Video
                      ref={videoRef}
                      source={{ uri: parentVideoUrl }}
                      style={styles.parentVideo}
                      resizeMode={ResizeMode.CONTAIN}
                      shouldPlay={false}
                      isLooping={false}
                      progressUpdateIntervalMillis={250}
                      onPlaybackStatusUpdate={handlePlaybackStatusUpdate}
                    />
                    {showScrubUi ? (
                      <>
                        <View style={styles.dragHintOverlay} pointerEvents="none">
                          <Text style={styles.dragHintText}>Drag to seek</Text>
                        </View>
                        {!isPreviewPlaying ? (
                          <View style={styles.playHintOverlay} pointerEvents="none">
                            <View style={styles.playHintBadge}>
                              <FontAwesome name="play" size={22} color="#fff" />
                            </View>
                          </View>
                        ) : null}
                      </>
                    ) : null}
                  </View>
                </GestureDetector>
              </Pressable>

              {showScrubUi && durationMillis > 0 ? (
                <View style={styles.trimSliderWrap}>
                  <VideoTrimSlider
                    durationMs={scrubDurationMs}
                    startMs={0}
                    endMs={scrubDurationMs}
                    currentTimeMs={positionMillis}
                    onChange={() => {}}
                    onSeek={handleSeek}
                    onScrubStart={handleScrubStart}
                    onScrubEnd={handleScrubEnd}
                  />
                </View>
              ) : null}
            </View>
          </View>

          <View style={styles.cameraPane}>
            <View style={styles.mediaCard}>
            {isPreviewMode ? (
              <View style={styles.cameraStageHost}>
                <View style={styles.cameraStage}>
                  <Video
                    source={{ uri: recordedUri }}
                    style={styles.selfiePreviewVideo}
                    resizeMode={ResizeMode.COVER}
                    shouldPlay
                    isLooping
                  />
                </View>
              </View>
            ) : cameraPermission?.granted ? (
              <View style={styles.cameraStageHost}>
                <View style={styles.cameraStage}>
                  <CameraView
                    ref={cameraRef}
                    style={styles.cameraPreview}
                    facing="front"
                    mode="video"
                    mirror
                    onCameraReady={() => setCameraReady(true)}
                    onMountError={(event) => {
                      console.warn('[ReactionSheet] camera mount error:', event.message);
                      setCameraReady(false);
                    }}
                  />
                </View>
              </View>
            ) : (
              <View style={styles.permissionFallback}>
                <Text style={styles.permissionText}>Camera access is required to record a reaction.</Text>
                <Pressable style={styles.permissionButton} onPress={() => void requestCameraPermission()}>
                  <Text style={styles.permissionButtonText}>Grant Camera Access</Text>
                </Pressable>
              </View>
            )}
            </View>
          </View>
        </View>

        <View style={[styles.interactionFooter, { height: 110 + insets.bottom, paddingBottom: insets.bottom }]}>
          {isPreviewMode ? (
            <View style={styles.previewActions}>
              {isUploading ? (
                <ActivityIndicator color="#fff" style={styles.uploadingSpinner} />
              ) : null}
              <Pressable
                style={[styles.retakeButton, isUploading && styles.previewButtonDisabled]}
                onPress={handleRetake}
                disabled={isUploading}
                accessibilityRole="button"
                accessibilityLabel="Retake reaction"
              >
                <FontAwesome name="refresh" size={15} color="#fff" />
                <Text style={styles.retakeButtonText}>Retake</Text>
              </Pressable>
              <Pressable
                style={[styles.sendButton, isUploading && styles.previewButtonDisabled]}
                onPress={handleSend}
                disabled={isUploading}
                accessibilityRole="button"
                accessibilityLabel="Send reaction"
              >
                <FontAwesome name="paper-plane" size={15} color="#fff" />
                <Text style={styles.sendButtonText}>Send</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.recordSection}>
              {!isRecording ? (
                <Text style={styles.recordHintText}>Hold to React</Text>
              ) : null}
              <Pressable
                onPressIn={handlePressIn}
                onPressOut={handlePressOut}
                disabled={!canRecord}
                style={({ pressed }) => [
                  styles.recordButton,
                  isRecording && styles.recordButtonActive,
                  (pressed || isRecording) && styles.recordButtonPressed,
                  !canRecord && styles.recordButtonDisabled,
                ]}
                accessibilityRole="button"
                accessibilityLabel={isRecording ? 'Recording reaction' : 'Hold to react'}
                accessibilityHint="Press and hold to record your reaction while the Reflection plays"
              >
                <View style={[styles.recordButtonInner, isRecording && styles.recordButtonInnerActive]}>
                  {isRecording ? (
                    <View style={styles.recordingSquare} />
                  ) : (
                    <FontAwesome name="circle" size={18} color="#fff" />
                  )}
                </View>
                <Text style={styles.recordButtonText}>
                  {isRecording ? 'Recording…' : 'Hold to React'}
                </Text>
              </Pressable>
            </View>
          )}
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  headerTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  closeButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  splitPane: {
    flex: 1,
    minHeight: 0,
    paddingHorizontal: 12,
    gap: 10,
  },
  mediaCard: {
    flex: 1,
    minHeight: 0,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#101820',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  parentVideoPane: {
    flex: 1,
    minHeight: 0,
  },
  parentVideoPressable: {
    flex: 1,
    minHeight: 0,
  },
  parentVideoSurface: {
    flex: 1,
    minHeight: 0,
    backgroundColor: '#101820',
  },
  parentVideo: {
    flex: 1,
    backgroundColor: '#101820',
  },
  dragHintOverlay: {
    position: 'absolute',
    top: 12,
    alignSelf: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.48)',
  },
  dragHintText: {
    color: 'rgba(255,255,255,0.82)',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  playHintOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playHintBadge: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
    paddingLeft: 3,
  },
  trimSliderWrap: {
    flexShrink: 0,
    paddingBottom: 6,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  cameraPane: {
    flex: 1,
    minHeight: 0,
  },
  cameraStageHost: {
    flex: 1,
    minHeight: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000',
  },
  cameraStage: {
    flex: 1,
    width: '100%',
    maxHeight: '100%',
    aspectRatio: 3 / 4,
    alignSelf: 'center',
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000',
  },
  cameraPreview: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
  },
  selfiePreviewVideo: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
  },
  permissionFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 16,
  },
  permissionText: {
    color: '#fff',
    fontSize: 15,
    textAlign: 'center',
  },
  permissionButton: {
    backgroundColor: '#2e78b7',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 24,
  },
  permissionButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  interactionFooter: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    backgroundColor: '#000',
  },
  recordSection: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    width: '100%',
  },
  recordHintText: {
    color: 'rgba(255,255,255,0.58)',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  recordButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 22,
    borderRadius: 999,
    backgroundColor: 'rgba(46, 120, 183, 0.92)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  recordButtonActive: {
    backgroundColor: 'rgba(176, 32, 32, 0.95)',
    borderColor: 'rgba(255, 120, 120, 0.65)',
    transform: [{ scale: 1.04 }],
  },
  recordButtonPressed: {
    transform: [{ scale: 1.04 }],
  },
  recordButtonDisabled: {
    opacity: 0.45,
  },
  recordButtonInner: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  recordButtonInnerActive: {
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  recordingSquare: {
    width: 18,
    height: 18,
    borderRadius: 4,
    backgroundColor: '#fff',
  },
  recordButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  previewActions: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    width: '100%',
  },
  uploadingSpinner: {
    marginRight: 4,
  },
  previewButtonDisabled: {
    opacity: 0.45,
  },
  retakeButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  retakeButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  sendButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: '#2e78b7',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  sendButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
  },
});
