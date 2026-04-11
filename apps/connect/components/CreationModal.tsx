import ReflectionComposer from '@/components/ReflectionComposer';
import { useReflectionMedia } from '@/context/ReflectionMediaContext';
import { prepareImageForUpload } from '@/utils/mediaProcessor';
import { buildReflectionPrompt } from '@/utils/buildReflectionPrompt';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { FontAwesome } from '@expo/vector-icons';
import { API_ENDPOINTS, EventMetadata, ExplorerConfig, useAuth, useExplorer } from '@projectmirror/shared';
import { collection, db, doc, serverTimestamp, setDoc } from '@projectmirror/shared/firebase';
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import * as FileSystem from 'expo-file-system';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import * as VideoThumbnails from 'expo-video-thumbnails';
import BottomSheet, { BottomSheetBackdrop, BottomSheetTextInput, BottomSheetView } from '@gorhom/bottom-sheet';
import { useIsFocused } from '@react-navigation/native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, AppState, AppStateStatus, KeyboardAvoidingView, Modal, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Keep debug logging opt-in (Metro logs are noisy and can affect perf during testing).
const DEBUG_LOGS = __DEV__ && false;
const debugLog = (...args: any[]) => {
  if (DEBUG_LOGS) console.log(...args);
};

const CAPTION_VOICE_STORAGE_KEY = 'tts_voice_caption';
const DEEP_DIVE_VOICE_STORAGE_KEY = 'tts_voice_deep_dive';
const DEFAULT_TTS_VOICE = 'en-US-Journey-O';

// Helper to upload securely using FileSystem
const safeUploadToS3 = async (localUri: string, presignedUrl: string) => {
  debugLog(`📡 safeUploadToS3: Starting upload. Source: ${localUri.substring(0, 50)}... Target: ${presignedUrl.substring(0, 50)}...`);
  let uriToUpload = localUri;
  let tempUri: string | null = null;

  // If remote URL (e.g. Unsplash or AI TTS), download to cache first
  if (localUri.startsWith('http')) {
    try {
      // Extract extension from URL path (before query params), default to jpg for images
      const urlPath = localUri.split('?')[0];
      const lastSegment = urlPath.split('/').pop() || '';
      const dotParts = lastSegment.split('.');
      // Only use extension if there's a proper file extension (2-4 chars), otherwise default to jpg
      const extractedExt = dotParts.length > 1 ? dotParts.pop()?.toLowerCase() : null;
      const extension = (extractedExt && extractedExt.length <= 4 && !extractedExt.includes('/')) ? extractedExt : 'jpg';
      const filename = `temp_upload_${Date.now()}_${Math.floor(Math.random() * 1000)}.${extension}`;
      debugLog(`📥 safeUploadToS3 [${filename}]: Downloading remote file...`);
      const downloadRes = await FileSystem.downloadAsync(
        localUri,
        `${FileSystem.cacheDirectory}${filename}`
      );
      uriToUpload = downloadRes.uri;
      tempUri = downloadRes.uri;
      debugLog(`✅ safeUploadToS3 [${filename}]: Download complete`);
    } catch (err) {
      console.error(`❌ safeUploadToS3: Download failed:`, err);
      throw err;
    }
  }

  try {
    // Determine content type based on extension
    const extension = uriToUpload.split('.').pop()?.toLowerCase();
    const contentType = extension === 'm4a' || extension === 'mp3' ? 'audio/mpeg' : 'image/jpeg';

    debugLog(`📤 safeUploadToS3: Uploading ${uriToUpload} (ContentType: ${contentType})...`);
    const uploadResult = await FileSystem.uploadAsync(presignedUrl, uriToUpload, {
      httpMethod: 'PUT',
      headers: { 'Content-Type': contentType },
    });

    if (uploadResult.status !== 200) {
      console.error(`❌ safeUploadToS3: Upload failed with status ${uploadResult.status}`);
      throw new Error(`Upload failed with status ${uploadResult.status}`);
    }
    debugLog(`✅ safeUploadToS3: Upload SUCCESS for ${uriToUpload}`);
    return uploadResult;
  } catch (err) {
    console.error(`❌ safeUploadToS3: Upload error:`, err);
    throw err;
  } finally {
    // Cleanup temp file if we created one
    if (tempUri) {
      FileSystem.deleteAsync(tempUri, { idempotent: true }).catch(() => { });
    }
  }
};

export type CreationModalInitialAction = 'camera' | 'gallery' | 'search';

export interface CreationModalProps {
  visible: boolean;
  onClose: () => void;
  initialAction?: CreationModalInitialAction | null;
  onActionTriggered?: () => void;
}

export default function CreationModal({ visible, onClose, initialAction, onActionTriggered }: CreationModalProps) {
  const MAX_VIDEO_DURATION_SECONDS = 60;
  const [photo, setPhoto] = useState<any>(null);
  const [uploading, setUploading] = useState(false);
  const [description, setDescription] = useState('');
  const [showDescriptionInput, setShowDescriptionInput] = useState(false);
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [audioUri, setAudioUri] = useState<string | null>(null);
  const [isStartingRecording, setIsStartingRecording] = useState(false);
  const [isAiThinking, setIsAiThinking] = useState(false);
  const [isAiGenerated, setIsAiGenerated] = useState(false);
  const [shortCaption, setShortCaption] = useState<string>('');
  const [deepDive, setDeepDive] = useState<string>('');
  const [stagingEventId, setStagingEventId] = useState<string | null>(null);
  const [aiAudioUrl, setAiAudioUrl] = useState<string | null>(null);
  const [aiDeepDiveAudioUrl, setAiDeepDiveAudioUrl] = useState<string | null>(null);
  const [aiAudioS3Key, setAiAudioS3Key] = useState<string | null>(null);
  const [aiDeepDiveS3Key, setAiDeepDiveS3Key] = useState<string | null>(null);
  const stagingEventIdRef = useRef<string | null>(null); // Sync fallback; state can lag after async Magic
  const [intent, setIntent] = useState<'none' | 'voice' | 'ai' | 'note'>('none');
  const [captionVoice, setCaptionVoice] = useState<string>(DEFAULT_TTS_VOICE);
  const [deepDiveVoice, setDeepDiveVoice] = useState<string>(DEFAULT_TTS_VOICE);
  const { currentExplorerId, explorerName, activeRelationship } = useExplorer();
  const { pendingMedia, consumePendingMedia } = useReflectionMedia();
  const isFocused = useIsFocused();

  // Toast state
  const [toastMessage, setToastMessage] = useState<string>('');
  const toastOpacity = useRef(new Animated.Value(0)).current;

  // Video support state
  const [mediaType, setMediaType] = useState<'photo' | 'video'>('photo');
  const [videoUri, setVideoUri] = useState<string | null>(null);
  const [imageSourceType, setImageSourceType] = useState<'camera' | 'search'>('camera');
  const [isCompanionInReflection, setIsCompanionInReflection] = useState(false);
  const [isExplorerInReflection, setIsExplorerInReflection] = useState(false);
  const [peopleContext, setPeopleContext] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [mediaSource, setMediaSource] = useState<'/camera' | '/gallery' | '/search' | null>(null);
  const [showNameModal, setShowNameModal] = useState(false);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<'picker' | 'creating'>('picker');
  const pendingRouteRef = useRef<'/camera' | '/gallery' | '/search' | null>(null);
  const sourceTransitionLockRef = useRef(false);
  const suppressPickerRecoveryRef = useRef(false);
  const [transitionUnlockTick, setTransitionUnlockTick] = useState(0);
  const sheetRef = useRef<BottomSheet>(null);
  const detailsSheetRef = useRef<BottomSheet>(null);

  const beginSourceFlow = useCallback((route: '/camera' | '/gallery' | '/search') => {
    sourceTransitionLockRef.current = true;
    pendingRouteRef.current = route;
    sheetRef.current?.close();
    setPhase('creating');
  }, []);

  useEffect(() => {
    if (visible) {
      setPhase('picker');
      setConfirming(false);
      setIsCompanionInReflection(false);
      setIsExplorerInReflection(false);
      setPeopleContext('');
      sourceTransitionLockRef.current = false;
      suppressPickerRecoveryRef.current = false;
      setTransitionUnlockTick((v) => v + 1);
    } else {
      // Reset one-shot suppression when modal is fully closed by parent.
      suppressPickerRecoveryRef.current = false;
    }
  }, [visible]);

  useEffect(() => {
    if (phase !== 'creating') return;
    const route = pendingRouteRef.current;
    if (!route) return;
    pendingRouteRef.current = null;
    // Wait one frame for state/UI transition before navigation.
    requestAnimationFrame(() => {
      router.push(route);
      // Keep lock briefly so sheet close callbacks can't immediately tear down the flow.
      setTimeout(() => {
        sourceTransitionLockRef.current = false;
        setTransitionUnlockTick((v) => v + 1);
      }, 1200);
    });
  }, [phase, router]);

  // If a source screen (camera/gallery/search) is dismissed without selecting media,
  // we return to this screen focused but with no pending media. In that case, restore
  // the picker sheet instead of staying on the "Opening creation tools..." overlay.
  useEffect(() => {
    if (!visible || !isFocused) return;
    if (phase !== 'creating') return;
    if (suppressPickerRecoveryRef.current) return;
    if (sourceTransitionLockRef.current) return;
    if (pendingRouteRef.current) return;
    if (pendingMedia) return;
    if (photo || showDescriptionInput) return;
    setPhase('picker');
  }, [visible, isFocused, phase, pendingMedia, photo, showDescriptionInput, transitionUnlockTick]);

  const initialActionTriggeredRef = useRef(false);
  useEffect(() => {
    if (!visible || !initialAction) {
      initialActionTriggeredRef.current = false;
      return;
    }
    if (initialActionTriggeredRef.current) return;
    initialActionTriggeredRef.current = true;
    sourceTransitionLockRef.current = true;
    pendingRouteRef.current = `/${initialAction}` as '/camera' | '/gallery' | '/search';
    setPhase('creating');
    onActionTriggered?.();
  }, [visible, initialAction, router, onActionTriggered]);

  // Video player for preview
  const videoPlayer = useVideoPlayer(videoUri || '', (player) => {
    // Optional: handle status updates
  });
  
  const companionName = activeRelationship?.companionName || '';
  
  // Cleanup video player on unmount
  useEffect(() => {
    return () => {
      if (videoPlayer) {
        try {
          videoPlayer.pause();
          videoPlayer.replace(''); // Clear source to release resources
        } catch (e) {
          // Player may already be released
        }
      }
    };
  }, [videoPlayer]);

  useEffect(() => {
    if (!visible) return;
    const loadVoicePrefs = async () => {
      try {
        const [savedCaption, savedDeepDive] = await Promise.all([
          AsyncStorage.getItem(CAPTION_VOICE_STORAGE_KEY),
          AsyncStorage.getItem(DEEP_DIVE_VOICE_STORAGE_KEY),
        ]);
        if (savedCaption) {
          setCaptionVoice(savedCaption);
        } else {
          await AsyncStorage.setItem(CAPTION_VOICE_STORAGE_KEY, DEFAULT_TTS_VOICE);
        }
        if (savedDeepDive) {
          setDeepDiveVoice(savedDeepDive);
        } else {
          await AsyncStorage.setItem(DEEP_DIVE_VOICE_STORAGE_KEY, DEFAULT_TTS_VOICE);
        }
      } catch {
        // keep defaults
      }
    };
    loadVoicePrefs();
  }, [visible]);

  const lastProcessedUriRef = useRef<string | null>(null);

  // Timeout refs for cleanup
  const loadingImageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioUriTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cache cleanup helpers (best-effort). We only delete files inside cacheDirectory.
  const isCacheUri = useCallback((uri?: string | null) => {
    if (!uri) return false;
    const cacheDir = FileSystem.cacheDirectory;
    return !!cacheDir && uri.startsWith(cacheDir);
  }, []);

  const safeDeleteCacheFile = useCallback(async (uri?: string | null) => {
    if (!uri) return;
    if (!isCacheUri(uri)) return;
    try {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    } catch {
      // ignore
    }
  }, [isCacheUri]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (loadingImageTimeoutRef.current) clearTimeout(loadingImageTimeoutRef.current);
      if (audioUriTimeoutRef.current) clearTimeout(audioUriTimeoutRef.current);
    };
  }, []);

  // Show toast notification
  const showToast = (message: string) => {
    setToastMessage(message);
    Animated.sequence([
      Animated.timing(toastOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
      Animated.delay(2000),
      Animated.timing(toastOpacity, { toValue: 0, duration: 300, useNativeDriver: true })
    ]).start(() => setToastMessage(''));
  };


  // Global AppState listener for Companion
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      debugLog(`📱 [Companion App] AppState changed to: ${nextAppState}`);
    });
    return () => subscription.remove();
  }, []);

  // Get the user from the Auth Hook
  const { user } = useAuth();
  
  // Request audio permissions on mount
  useEffect(() => {
    (async () => {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        console.warn('🎤 Microphone permission denied');
      } else {
        debugLog('✅ Microphone permission granted');
      }
    })();
  }, []);

  // Consume pending media from camera/gallery/search screens.
  // CRITICAL: Only consume when isFocused is true. While the camera/gallery/search
  // screen is presented on top, isFocused is false. If we consumed media while
  // unfocused, the Composer Modal would present on top of the camera modal, and
  // iOS would dismiss BOTH when router.back() pops the camera.
  useEffect(() => {
    if (!isFocused) return;
    if (!pendingMedia) return;
    const media = consumePendingMedia();
    if (media) {
      setPhase('creating');
      if (media.type === 'video') {
        setMediaType('video');
        setVideoUri(media.uri);
        setPhoto({ uri: media.uri });
      } else {
        setMediaType('photo');
        setVideoUri(null);
        setPhoto({ uri: media.uri });
      }
      setImageSourceType(media.source === 'search' ? 'search' : 'camera');
      setMediaSource(`/${media.source}` as '/camera' | '/gallery' | '/search');
      setConfirming(true);
      setDescription('');
      setIsAiGenerated(false);
      setShortCaption('');
      setDeepDive('');
      setIntent('none');
      setAudioUri(null);
      setStagingEventId(null);
      stagingEventIdRef.current = null;
      lastProcessedUriRef.current = audioRecorder.uri ?? lastProcessedUriRef.current;
    }
  }, [isFocused, pendingMedia]);

  // Only update audioUri from recorder when we have a NEW URI and we're not recording.
  // Skip cache paths so we don't lock onto a transient file that may be deleted.
  useEffect(() => {
    const currentUri = audioRecorder.uri;
    const isNewUri = currentUri && currentUri !== lastProcessedUriRef.current;
    const isCachePath = currentUri?.startsWith(FileSystem.cacheDirectory || '');

    // Only set audioUri if we have a NEW URI, we're not recording, and audioUri is currently null
    // Don't include audioUri in dependencies to prevent infinite loops
    if (isNewUri && !audioRecorder.isRecording && !isCachePath) {
      // Double-check audioUri is null before setting (read from state, not dependency)
      setAudioUri(prev => {
        if (prev === null) {
          lastProcessedUriRef.current = currentUri;
          return currentUri;
        }
        return prev;
      });
    }
  }, [audioRecorder.uri, audioRecorder.isRecording]);

  const getAIDescription = async (imageUrl: string, options: { silent?: boolean, targetCaption?: string, targetDeepDive?: string, skipTts?: boolean } = {}) => {
    try {
      if (!options.silent) {
        setIsAiThinking(true);
        setIsAiGenerated(false);
      }

      const prompt = buildReflectionPrompt({
        explorerName: explorerName || 'the Explorer',
        companionName: companionName || undefined,
        companionInReflection: isCompanionInReflection,
        explorerInReflection: isExplorerInReflection,
        peopleContext: peopleContext.trim() || undefined,
      });

      let fetchUrl = `${API_ENDPOINTS.AI_DESCRIPTION}?image_url=${encodeURIComponent(imageUrl)}&explorer_id=${currentExplorerId}`;
      fetchUrl += `&prompt=${encodeURIComponent(prompt)}`;
      if (options.targetCaption) fetchUrl += `&target_caption=${encodeURIComponent(options.targetCaption)}`;
      if (options.targetDeepDive) fetchUrl += `&target_deep_dive=${encodeURIComponent(options.targetDeepDive)}`;
      if (options.skipTts) fetchUrl += `&skip_tts=true`;
      if (captionVoice) fetchUrl += `&caption_voice=${encodeURIComponent(captionVoice)}`;
      if (deepDiveVoice) fetchUrl += `&deep_dive_voice=${encodeURIComponent(deepDiveVoice)}`;

      // Add timeout to prevent 504 errors (60 seconds for AI generation)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);

      let response;
      try {
        response = await fetch(fetchUrl, {
          signal: controller.signal
        });
        clearTimeout(timeoutId);
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          throw new Error('AI description request timed out after 60 seconds');
        }
        throw fetchError;
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`AI description failed: ${response.status} - ${errorText}`);
        throw new Error(`AI description failed: ${response.status} - ${errorText}`);
      }

      // Parse JSON response
      const aiResponse = await response.json();

      if (aiResponse && aiResponse.short_caption && aiResponse.deep_dive) {
        setShortCaption(aiResponse.short_caption);
        setDeepDive(aiResponse.deep_dive);
        setAiAudioUrl(aiResponse.audio_url || null);
        setAiDeepDiveAudioUrl(aiResponse.deep_dive_audio_url || null);
        setAiAudioS3Key(aiResponse.audio_s3_key || null);
        setAiDeepDiveS3Key(aiResponse.deep_dive_audio_s3_key || null);
        if (aiResponse.staging_event_id) {
          setStagingEventId(aiResponse.staging_event_id);
          stagingEventIdRef.current = aiResponse.staging_event_id;
        }

        if (!options.silent) {
          // PROTECTION: Only update the description if the current one is empty
          // OR if it's already an AI generated one (user hasn't manually tweaked it yet)
          if (!description.trim() || isAiGenerated) {
            setDescription(aiResponse.short_caption);
          } else {
            debugLog('📝 User has custom text, keeping it but updating AI metadata in background');
          }
          setIsAiGenerated(true);
        }
        return aiResponse;
      } else {
        throw new Error("Invalid response format from AI");
      }
    } catch (error: any) {
      console.error("Error getting AI description:", error);
      return null;
    } finally {
      if (!options.silent) {
        setIsAiThinking(false);
      }
    }
  };

  const startRecording = async () => {
    // Prevent multiple simultaneous calls
    if (isStartingRecording || audioRecorder.isRecording) {
      return;
    }

    try {
      setIsStartingRecording(true);
      // Clear previous audio URI when starting a new recording
      setAudioUri(null);
      // Reset the last processed URI so we can detect the new recording
      lastProcessedUriRef.current = null;

      // Request permissions if needed
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        Alert.alert("Permission Required", "Audio recording permission is required.");
        return;
      }

      // Enable recording mode on iOS
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      // Prepare and start recording
      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      setDescription(''); // Clear text description when starting audio
    } catch (error: any) {
      console.error("Failed to start recording:", error);
      Alert.alert("Error", `Failed to start audio recording: ${error.message || error}`);
      // Reset state on error
      setAudioUri(null);
    } finally {
      setIsStartingRecording(false);
    }
  };

  const stopRecording = async () => {
    if (!audioRecorder.isRecording) {
      return;
    }

    try {
      await audioRecorder.stop();

      // Disable recording mode after stopping
      // Note: playsInSilentMode must be true when staysActiveInBackground is true (iOS default)
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
      });

      // Persist the recording to a stable location so it won't be cleaned from cache
      const recordingUri = audioRecorder.uri;
      if (recordingUri && recordingUri !== lastProcessedUriRef.current) {
        try {
          const filename = `caption-${Date.now()}.m4a`;
          const persistentUri = `${FileSystem.documentDirectory}${filename}`;
          await FileSystem.copyAsync({ from: recordingUri, to: persistentUri });
          setAudioUri(persistentUri);
          lastProcessedUriRef.current = recordingUri;
        } catch (copyError) {
          console.error("Failed to persist audio recording:", copyError);
          // Fallback to the original URI if copy fails
          setAudioUri(recordingUri);
          lastProcessedUriRef.current = recordingUri;
        }
      }
    } catch (error: any) {
      console.error("Failed to stop recording:", error);
      Alert.alert("Error", "Failed to stop audio recording");
    }
  };

  const uploadEventBundle = async (overrides?: { caption?: string, audioUri?: string | null, deepDive?: string | null }) => {
    if (!photo) return;

    // 1. Resolve Data (Prefer overrides from Composer, fall back to State)
    const activeAudioUri = overrides?.audioUri !== undefined ? overrides.audioUri : audioUri;
    let finalCaption = (overrides?.caption !== undefined ? overrides.caption : description).trim();
    let finalDeepDive = overrides?.deepDive !== undefined ? overrides.deepDive : deepDive;

    // Require either text description OR audio recording
    if (!finalCaption && !activeAudioUri) {
      Alert.alert("Description Required", "Please add a text description or record an audio message.");
      return;
    }

    let tempThumbnail: string | null = null;
    let tempGatekeptImage: string | null = null;
    let finalCaptionAudio = activeAudioUri || aiAudioUrl;
    let finalDeepDiveAudio = aiDeepDiveAudioUrl;
      const stagingTtsKeysToDelete: string[] = [];
      let stagingIdToDelete: string | null = null;

    try {
      setUploading(true);

      // ALWAYS ensure we have a Deep Dive and correct TTS before proceeding
      // If we are missing deep dive, or if the caption text has changed from the original AI caption (meaning it was edited or manually typed)
      // and we don't have human audio, we should refresh the TTS.

      const needsDeepDive = !finalDeepDive;
      const needsCaptionAudio = !activeAudioUri && (!finalCaptionAudio || finalCaption !== (shortCaption || ""));

      debugLog(`🔍 Enhancement Check: needsDeepDive=${needsDeepDive}, needsCaptionAudio=${needsCaptionAudio}, existingDeepDive="${finalDeepDive?.substring(0, 20)}..."`);

      if (needsDeepDive || needsCaptionAudio) {
        debugLog("🛠️ Reflection needs enhancement (Deep Dive or TTS), calling AI backend...");

        // Use our robust background generator which handles staging uploads and thumbnails correctly
        const aiResult = await generateDeepDiveBackground({
          silent: true,
          targetCaption: finalCaption,
          targetDeepDive: finalDeepDive || undefined,
          skipTts: !!activeAudioUri
        });

        if (aiResult) {
          if (aiResult._stagingId) stagingIdToDelete = aiResult._stagingId;
          if (aiResult.short_caption || aiResult.deep_dive) {
            debugLog(`✅ AI Enhancement Success: Caption="${aiResult.short_caption?.substring?.(0, 30)}...", DeepDive="${aiResult.deep_dive?.substring?.(0, 30)}..."`);
          }
          // PROTECTION: Never overwrite the user's manual caption during this final polish phase
          // if it doesn't match the AI's returned version. We favor what the user sees on screen.
          if (!finalCaption && aiResult.short_caption) {
            finalCaption = aiResult.short_caption;
          }

          finalDeepDive = aiResult.deep_dive;
          finalCaptionAudio = activeAudioUri || aiResult.audio_url; // Keep human audio as absolute priority
          finalDeepDiveAudio = aiResult.deep_dive_audio_url;
          if (aiResult.audio_s3_key) stagingTtsKeysToDelete.push(aiResult.audio_s3_key);
          if (aiResult.deep_dive_audio_s3_key) stagingTtsKeysToDelete.push(aiResult.deep_dive_audio_s3_key);
          debugLog(`✨ Final Enhancement State: AudioURL=${finalCaptionAudio ? 'YES' : 'NO'}, DeepDiveAudioURL=${finalDeepDiveAudio ? 'YES' : 'NO'}`);
        } else {
          console.warn("⚠️ AI enhancement failed, proceeding with available content.");
        }
      } else {
        // Capture TTS keys and staging from state/ref for cleanup (no inline AI call)
        if (aiAudioS3Key) stagingTtsKeysToDelete.push(aiAudioS3Key);
        if (aiDeepDiveS3Key) stagingTtsKeysToDelete.push(aiDeepDiveS3Key);
        stagingIdToDelete = stagingEventId || stagingEventIdRef.current;
      }

      // Guardrail: never send text-only reflections that force Explorer TTS fallback.
      // If no recorded human audio exists, we require AI-generated audio to be present.
      if (!activeAudioUri && !finalCaptionAudio) {
        Alert.alert(
          'Voice Generation Failed',
          'We could not generate the Reflection voice. Please tap Magic again, wait for it to finish, or record your own voice before sending.'
        );
        return;
      }

      // Generate unique event_id (timestamp-based)
      const eventID = Date.now().toString();
      debugLog(`📡 uploadEventBundle: Starting for EventID: ${eventID}. Needs enhancement? ${needsDeepDive || needsCaptionAudio}`);
      const timestamp = new Date().toISOString();

      // 1. Prepare list of files to upload
      const filesToSign = ['image.jpg', 'metadata.json'];
      if (mediaType === 'video' && videoUri) {
        filesToSign.push('video.mp4');
      }

      // Verify audio exists before adding to list
      let hasAudio = false;
      if (activeAudioUri) {
        const fileInfo = await FileSystem.getInfoAsync(activeAudioUri);
        if (fileInfo.exists) {
          filesToSign.push('audio.m4a');
          hasAudio = true;
        }
      } else if (finalCaptionAudio) {
        filesToSign.push('audio.m4a'); // Store AI TTS as audio.m4a for consistency
        hasAudio = true;
      }

      // Check for AI Deep Dive audio
      let hasDeepDiveAudio = false;
      if (finalDeepDiveAudio) {
        filesToSign.push('deep_dive.m4a');
        hasDeepDiveAudio = true;
      }

      debugLog(`📡 uploadEventBundle: Files to sign:`, filesToSign);

      // 2. Get permissions (Batch Request)
      debugLog('getting batch urls...');
      const batchRes = await fetch(API_ENDPOINTS.GET_BATCH_S3_UPLOAD_URLS, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          explorer_id: currentExplorerId,
          event_id: eventID,
          path: 'to',
          files: filesToSign
        })
      });

      if (!batchRes.ok) {
        throw new Error(`Failed to get upload URLs: ${batchRes.status}`);
      }

      const { urls } = await batchRes.json();
      debugLog('📡 uploadEventBundle: Received presigned URLs for:', Object.keys(urls));
      const uploadPromises: Promise<any>[] = [];

      // 3. Prepare Image Source
      let imageSource = photo.uri;

      if (mediaType === 'video' && videoUri) {
        // Generate thumbnail
        const { uri } = await VideoThumbnails.getThumbnailAsync(videoUri, {
          time: 0,
          quality: 0.5,
        });
        imageSource = uri;
        tempThumbnail = uri; // Mark for cleanup
      } else if (stagingEventId) {
        // If Staging exists, fetch the READ URL for the staging image
        // We use that remote URL as the source for safeUploadToS3, which will download it then upload it
        const stagingRes = await fetch(`${API_ENDPOINTS.GET_S3_URL}?path=staging&event_id=${stagingEventId}&filename=image.jpg&method=GET&explorer_id=${currentExplorerId}`);
        if (stagingRes.ok) {
          const { url } = await stagingRes.json();
          imageSource = url;
        }
      }

      // 4. Queue Image Upload
      if (urls['image.jpg']) {
        debugLog('📤 uploadEventBundle: Queuing image upload...');
        // Only gatekeep here when needed:
        // - remote (staging GET URL) needs download + resize
        // - video thumbnails may be >1080 and must be resized
        // All photo flows already go through Gatekeeper on selection/capture.
        const gatekeptImageUri =
          imageSource.startsWith('http') || mediaType === 'video'
            ? await prepareImageForUpload(imageSource)
            : imageSource;

        if (gatekeptImageUri !== imageSource) {
          tempGatekeptImage = gatekeptImageUri;
        }

        uploadPromises.push(safeUploadToS3(gatekeptImageUri, urls['image.jpg']).then(res => {
          debugLog('✅ uploadEventBundle: Image upload completed');
          return res;
        }));
      } else {
        console.error('❌ uploadEventBundle: Missing image.jpg presigned URL');
      }

      // 5. Queue Video Upload
      if (mediaType === 'video' && videoUri && urls['video.mp4']) {
        uploadPromises.push(
          FileSystem.uploadAsync(urls['video.mp4'], videoUri, {
            httpMethod: 'PUT',
            headers: { 'Content-Type': 'video/mp4' },
          }).then(res => {
            if (res.status !== 200) throw new Error(`Video upload failed: ${res.status}`);
            return res;
          })
        );
      }

      // 6. Queue Audio Upload
      if (hasAudio && urls['audio.m4a']) {
        const audioSource = activeAudioUri || finalCaptionAudio;
        if (audioSource) {
          debugLog('📤 uploadEventBundle: Queuing audio upload...');
          uploadPromises.push(safeUploadToS3(audioSource, urls['audio.m4a']).then(res => {
            debugLog('✅ uploadEventBundle: Audio upload completed');
            return res;
          }));
        }
      }

      // 6.5 Queue Deep Dive Audio Upload
      if (hasDeepDiveAudio && finalDeepDiveAudio && urls['deep_dive.m4a']) {
        debugLog('📤 uploadEventBundle: Queuing deep dive audio upload...');
        uploadPromises.push(safeUploadToS3(finalDeepDiveAudio, urls['deep_dive.m4a']).then(res => {
          debugLog('✅ uploadEventBundle: Deep dive audio upload completed');
          return res;
        }));
      }

      // 7. Queue Metadata Upload (S3 metadata.json + same object on Firestore after upload)
      const contentType: NonNullable<EventMetadata['content_type']> =
        mediaType === 'video' ? 'video' : hasAudio ? 'audio' : 'text';
      const eventMetadata: EventMetadata = {
        description:
          finalCaption ||
          (hasAudio ? 'Voice message' : mediaType === 'video' ? 'Video message' : ''),
        sender: companionName || 'Companion',
        timestamp,
        event_id: eventID,
        content_type: contentType,
        image_source: imageSourceType,
        ...(user?.uid ? { sender_id: user.uid } : {}),
        ...(finalCaption ? { short_caption: finalCaption } : {}),
        ...(finalDeepDive?.trim() ? { deep_dive: finalDeepDive } : {}),
      };

      debugLog('📄 Final Metadata to upload:', JSON.stringify(eventMetadata, null, 2));

      if (urls['metadata.json']) {
        debugLog('📤 uploadEventBundle: Queuing metadata upload...');
        uploadPromises.push(
          fetch(urls['metadata.json'], {
            method: 'PUT',
            body: JSON.stringify(eventMetadata, null, 2),
            headers: { 'Content-Type': 'application/json' },
          }).then(async res => {
            if (!res.ok) throw new Error(`Metadata upload failed: ${res.status}`);
            debugLog('✅ uploadEventBundle: Metadata upload SUCCESS');
            return res;
          })
        );
      } else {
        console.error('❌ uploadEventBundle: Missing metadata.json presigned URL');
      }

      // 8. Execute All Uploads Parallelly
      debugLog(`📡 uploadEventBundle: Executing ${uploadPromises.length} uploads in parallel...`);
      await Promise.all(uploadPromises);
      debugLog('✅ uploadEventBundle: All uploads completed successfully');

      // 8b. Presigned GET for metadata.json (for older Explorers + parity with list API)
      let metadataGetUrl: string | undefined;
      if (currentExplorerId) {
        try {
          const metaUrlRes = await fetch(
            `${API_ENDPOINTS.GET_S3_URL}?path=to&event_id=${encodeURIComponent(eventID)}&filename=metadata.json&method=GET&explorer_id=${encodeURIComponent(currentExplorerId)}`
          );
          if (metaUrlRes.ok) {
            const { url } = await metaUrlRes.json();
            metadataGetUrl = url;
          } else {
            console.warn('GET_S3_URL for metadata.json failed:', metaUrlRes.status);
          }
        } catch (e) {
          console.warn('Failed to obtain metadata.json presigned GET URL:', e);
        }
      }

      // 9. Cleanup Staging & Local (image + TTS artifacts)
      showToast('✅ Reflection sent!');

      if ((stagingIdToDelete || stagingEventId || stagingEventIdRef.current || stagingTtsKeysToDelete.length > 0) && currentExplorerId) {
        try {
          const deleteParams = new URLSearchParams({
            path: 'staging',
            explorer_id: currentExplorerId,
          });
          const idToDelete = stagingIdToDelete || stagingEventId || stagingEventIdRef.current;
          if (idToDelete) deleteParams.set('event_id', idToDelete);
          if (stagingTtsKeysToDelete.length > 0) {
            deleteParams.set('extra_keys', JSON.stringify(stagingTtsKeysToDelete));
          }
          const deleteRes = await fetch(`${API_ENDPOINTS.DELETE_MIRROR_EVENT}?${deleteParams.toString()}`, { method: 'DELETE' });
          if (!deleteRes.ok) {
            const body = await deleteRes.text();
            console.warn('Staging cleanup request failed:', deleteRes.status, body);
          }
        } catch (err) {
          console.warn('Staging cleanup failed (non-blocking):', err);
        }
      }

      if (photo.uri && !photo.uri.startsWith('http')) {
        safeDeleteCacheFile(photo.uri).catch(() => { });
      }
      if (mediaType === 'video' && videoUri) {
        safeDeleteCacheFile(videoUri).catch(() => { });
      }

      // 10. Reset State & close creation overlay.
      // Do NOT reset phase to 'picker' — see handleClose comment.
      // On successful send, we want to fully close, not resurface picker.
      suppressPickerRecoveryRef.current = true;
      setPhoto(null);
      setVideoUri(null);
      setMediaType('photo');
      setDescription('');
      setShowDescriptionInput(false);
      setIsAiGenerated(false);
      setShortCaption('');
      setDeepDive('');
      setStagingEventId(null);
      stagingEventIdRef.current = null;
      setAudioUri(null);
      setAiAudioS3Key(null);
      setAiDeepDiveS3Key(null);
      setIsCompanionInReflection(false);
      setIsExplorerInReflection(false);
      setPeopleContext('');
      setConfirming(false);
      sheetRef.current?.close();
      onClose();
      if (audioRecorder.isRecording) {
        await stopRecording();
      }

      // 11. Write Signal to Firestore (metadata embedded for Explorers; metadata_url for backward compatibility)
      setDoc(doc(collection(db, ExplorerConfig.collections.reflections), eventID), {
        explorerId: currentExplorerId,
        event_id: eventID,
        sender: companionName || "Companion",
        sender_id: user?.uid || undefined,
        status: "ready",
        timestamp: serverTimestamp(),
        type: "mirror_event",
        engagement_count: 0,
        metadata: eventMetadata,
        ...(metadataGetUrl ? { metadata_url: metadataGetUrl } : {}),
      }).catch(err => console.error("Firestore signal error:", err));

    } catch (error: any) {
      console.error("Full Upload Error:", error);
      Alert.alert("Upload Error", error.message);
    } finally {
      if (tempThumbnail) {
        FileSystem.deleteAsync(tempThumbnail, { idempotent: true }).catch(() => { });
      }
      if (tempGatekeptImage) {
        safeDeleteCacheFile(tempGatekeptImage).catch(() => { });
      }
      setUploading(false);
    }
  };

  const deleteStagingArtifacts = async () => {
    if (!currentExplorerId) return;
    const ttsKeys: string[] = [];
    if (aiAudioS3Key) ttsKeys.push(aiAudioS3Key);
    if (aiDeepDiveS3Key) ttsKeys.push(aiDeepDiveS3Key);
    const stagingId = stagingEventId || stagingEventIdRef.current;
    if (!stagingId && ttsKeys.length === 0) return;
    try {
      const params = new URLSearchParams({ path: 'staging', explorer_id: currentExplorerId });
      if (stagingId) params.set('event_id', stagingId);
      if (ttsKeys.length > 0) params.set('extra_keys', JSON.stringify(ttsKeys));
      const res = await fetch(`${API_ENDPOINTS.DELETE_MIRROR_EVENT}?${params.toString()}`, { method: 'DELETE' });
      if (!res.ok) console.warn('Staging cleanup request failed:', res.status, await res.text());
    } catch (err) {
      console.warn('Staging cleanup failed:', err);
    }
  };

  const cancelPhoto = async () => {
    const photoUriToClean = photo?.uri ?? null;
    const videoUriToClean = videoUri;
    await deleteStagingArtifacts();

    await safeDeleteCacheFile(photoUriToClean);
    await safeDeleteCacheFile(videoUriToClean);

    setPhoto(null);
    setVideoUri(null);
    setMediaType('photo');
    setDescription('');
    setShowDescriptionInput(false);
    setIsAiGenerated(false);
    setShortCaption('');
    setDeepDive('');
    setIsAiThinking(false);
    setStagingEventId(null);
    stagingEventIdRef.current = null;
    setIntent('none');
    setAudioUri(null);
    setAiAudioS3Key(null);
    setAiDeepDiveS3Key(null);
    setIsCompanionInReflection(false);
    setIsExplorerInReflection(false);
    setPeopleContext('');
    setConfirming(false);
  };

  const retakePhoto = async () => {
    const photoUriToClean = photo?.uri ?? null;
    const videoUriToClean = videoUri;
    await deleteStagingArtifacts();

    await safeDeleteCacheFile(photoUriToClean);
    await safeDeleteCacheFile(videoUriToClean);

    setPhoto(null);
    setVideoUri(null);
    setMediaType('photo');
    setDescription('');
    setShowDescriptionInput(false);
    setIsAiGenerated(false);
    setShortCaption('');
    setDeepDive('');
    setIsAiThinking(false);
    setStagingEventId(null);
    stagingEventIdRef.current = null;
    setIntent('none');
    setAudioUri(null);
    setAiAudioS3Key(null);
    setAiDeepDiveS3Key(null);
    setIsCompanionInReflection(false);
    setIsExplorerInReflection(false);
    setPeopleContext('');
    setConfirming(false);
    lastProcessedUriRef.current = audioRecorder.uri ?? lastProcessedUriRef.current;
  };

  const generateDeepDiveBackground = async (options: { silent?: boolean, targetCaption?: string, targetDeepDive?: string, skipTts?: boolean } = { silent: true }) => {
    if (!photo) return null;

    try {
      if (!options.silent) {
        setIsAiThinking(true);
        setIsAiGenerated(false);
      }
      // Generate staging event_id and upload image if not already uploaded
      let stagingId = stagingEventId;
      if (!stagingId) {
        stagingId = Date.now().toString();
        setStagingEventId(stagingId);
        stagingEventIdRef.current = stagingId;

        let uriToUpload = photo.uri;
        let isTempThumbnail = false;

        // If it's a video, generate a thumbnail to use for AI description
        if (mediaType === 'video' && videoUri) {
          try {
            const { uri } = await VideoThumbnails.getThumbnailAsync(videoUri, {
              time: 0,
              quality: 0.5,
            });
            uriToUpload = uri;
            isTempThumbnail = true;
          } catch (thumbnailError) {
            console.error("Failed to generate thumbnail for AI:", thumbnailError);
          }
        }

        // Upload to staging first
        const stagingResponse = await fetch(`${API_ENDPOINTS.GET_S3_URL}?path=staging&event_id=${stagingId}&filename=image.jpg&explorer_id=${currentExplorerId}`);
        const { url: stagingUrl } = await stagingResponse.json();
        // Only gatekeep here when needed: video thumbnail may exceed 1080px.
        const stagingImageUri =
          mediaType === 'video' ? await prepareImageForUpload(uriToUpload) : uriToUpload;
        const tempGatekeptStagingUri = stagingImageUri !== uriToUpload ? stagingImageUri : null;
        await safeUploadToS3(stagingImageUri, stagingUrl);
        if (tempGatekeptStagingUri) {
          safeDeleteCacheFile(tempGatekeptStagingUri).catch(() => { });
        }

        // Cleanup temp thumbnail
        if (isTempThumbnail) {
          try {
            await FileSystem.deleteAsync(uriToUpload, { idempotent: true });
          } catch (cleanupError) { }
        }
      }

      // Get presigned GET URL for staging image
      const getStagingUrlResponse = await fetch(`${API_ENDPOINTS.GET_S3_URL}?path=staging&event_id=${stagingId}&filename=image.jpg&method=GET&explorer_id=${currentExplorerId}`);
      if (getStagingUrlResponse.ok) {
        const { url: getStagingUrl } = await getStagingUrlResponse.json();
        const aiResult = await getAIDescription(getStagingUrl, options);
        // Always return _stagingId so caller can delete staging even when AI fails
        return aiResult ? { ...aiResult, _stagingId: stagingId } : { _stagingId: stagingId };
      }
    } catch (error: any) {
      console.error("Error generating background Deep Dive:", error);
    } finally {
      if (!options.silent) {
        setIsAiThinking(false);
      }
    }
    return null;
  };

  const triggerAI = async () => {
    if (!photo) return;
    setIntent('ai');
    const aiResult = await generateDeepDiveBackground({ silent: false });
    // Special handling to ensure description is set from the now-fetched AI result
    if (aiResult?.short_caption) {
      setDescription(aiResult.short_caption);
    }
  };

  const changeMethod = () => {
    // Clear description and audio, return to action buttons
    setDescription('');
    setAudioUri(null);
    setIntent('none');
    setIsAiGenerated(false);
    setShortCaption('');
    setDeepDive('');
    setIsAiThinking(false);
    lastProcessedUriRef.current = audioRecorder.uri ?? lastProcessedUriRef.current;
  };

  const handleReplaceMedia = async () => {
    const photoUriToClean = photo?.uri ?? null;
    const videoUriToClean = videoUri;
    await deleteStagingArtifacts();

    await safeDeleteCacheFile(photoUriToClean);
    await safeDeleteCacheFile(videoUriToClean);

    setPhoto(null);
    setVideoUri(null);
    setMediaType('photo');
    setDescription('');
    setShowDescriptionInput(false);
    setIsAiGenerated(false);
    setShortCaption('');
    setDeepDive('');
    setAiAudioUrl(null);
    setAiDeepDiveAudioUrl(null);
    setAiAudioS3Key(null);
    setAiDeepDiveS3Key(null);
    setIsAiThinking(false);
    setStagingEventId(null);
    stagingEventIdRef.current = null;
    setIntent('none');
    setAudioUri(null);
    lastProcessedUriRef.current = audioRecorder.uri ?? lastProcessedUriRef.current;

    if (mediaSource) {
      beginSourceFlow(mediaSource);
    } else {
      setPhase('picker');
      setTimeout(() => sheetRef.current?.snapToIndex(0), 100);
    }
  };

  const handleClose = () => {
    suppressPickerRecoveryRef.current = false;
    if (confirming && photo) {
      setConfirming(false);
      setPhoto(null);
      setVideoUri(null);
    } else if (showDescriptionInput && photo) {
      cancelPhoto();
    }
    // Do NOT reset phase to 'picker' here — that would briefly make showPicker
    // true before onClose() propagates visible=false from the parent, causing
    // the bottom sheet to flash open. Keep phase as-is; the [visible] effect
    // resets it to 'picker' when the user next opens the FAB.
    sheetRef.current?.close();
    onClose();
  };

  const createSnapPoints = useMemo(() => ['44%'], []);
  const renderBackdrop = useCallback(
    (props: any) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        pressBehavior="close"
      />
    ),
    []
  );

  // Loop the video preview during the confirmation screen
  useEffect(() => {
    if (confirming && videoUri && videoPlayer) {
      videoPlayer.loop = true;
      videoPlayer.play();
    } else if (videoPlayer && confirming === false) {
      videoPlayer.pause();
    }
  }, [confirming, videoUri, videoPlayer]);

  const handleConfirmCancel = async () => {
    const photoUriToClean = photo?.uri ?? null;
    const videoUriToClean = videoUri;
    await safeDeleteCacheFile(photoUriToClean);
    await safeDeleteCacheFile(videoUriToClean);
    setPhoto(null);
    setVideoUri(null);
    setMediaType('photo');
    setConfirming(false);
    setPhase('picker');
    setTimeout(() => sheetRef.current?.snapToIndex(0), 100);
  };

  const handleConfirmChoose = () => {
    setConfirming(false);
    setShowDescriptionInput(true);
  };

  // Compute visibility states — NO conditional returns so nothing unmounts/remounts.
  // Uses an absolutely-positioned View instead of <Modal> to avoid iOS UIWindow
  // stacking issues with the camera's fullScreenModal presentation.
  const showConfirmation = confirming && !!photo;
  const showComposer = showDescriptionInput && !!photo && !confirming;
  const showCreatingWait = phase === 'creating' && !showComposer && !showConfirmation;
  const showFullScreenOverlay = visible && isFocused && (showComposer || showCreatingWait || showConfirmation);
  const showPicker = visible && phase === 'picker' && !showFullScreenOverlay;


  return (
    <>
      {/* Bottom sheet picker — always in the tree, ref for imperative close */}
      <BottomSheet
        ref={sheetRef}
        index={showPicker ? 0 : -1}
        snapPoints={createSnapPoints}
        enablePanDownToClose
        enableDynamicSizing={false}
        backdropComponent={renderBackdrop}
        onChange={(index) => {
          if (sourceTransitionLockRef.current) return;
          if (phase === 'picker' && index === -1) onClose();
        }}
        handleIndicatorStyle={styles.sheetHandle}
        backgroundStyle={styles.sheetBackground}
      >
        <BottomSheetView style={styles.sheetContent}>
          <LinearGradient
            colors={['#A1C4FD', '#C2E9FB']}
            style={styles.dashboardContainer}
          >
            <View style={styles.dashboardContent}>
              <Text style={styles.dashboardTitle}>
                Create a Reflection
              </Text>

              {companionName && (
                <View style={styles.companionNameContainer}>
                  <Text style={styles.companionNameText}>Posting as {companionName}</Text>
                </View>
              )}

              <View style={styles.dashboardButtons}>
                <TouchableOpacity
                  style={[styles.simpleButton, styles.captureButton]}
                  onPress={() => beginSourceFlow('/camera')}
                  disabled={uploading}
                  activeOpacity={0.7}
                >
                  <FontAwesome name="camera" size={20} color="#fff" />
                  <Text style={styles.simpleButtonText}>Capture Photo or Video</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.simpleButton, styles.galleryButton]}
                  onPress={() => beginSourceFlow('/gallery')}
                  disabled={uploading}
                  activeOpacity={0.7}
                >
                  <FontAwesome name="photo" size={20} color="#fff" />
                  <Text style={styles.simpleButtonText}>Pick from Gallery</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.simpleButton, styles.searchButton]}
                  onPress={() => beginSourceFlow('/search')}
                  disabled={uploading}
                  activeOpacity={0.7}
                >
                  <FontAwesome name="search" size={20} color="#fff" />
                  <Text style={styles.simpleButtonText}>Search Images</Text>
                </TouchableOpacity>
              </View>
            </View>
          </LinearGradient>
        </BottomSheetView>
      </BottomSheet>

      {/* Full-screen creation overlay — absolute View, NOT Modal.
          React Native <Modal> uses a separate iOS UIWindow that gets left in a
          stale/invisible state after the camera's fullScreenModal dismisses.
          An absolute View stays in the normal view hierarchy and always paints. */}
      {showFullScreenOverlay && (
        <View style={styles.fullScreenOverlay}>
          {showConfirmation && photo ? (
            <KeyboardAvoidingView
              style={styles.confirmationContainer}
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
              <View style={styles.confirmationMedia}>
                {mediaType === 'video' && videoUri ? (
                  <VideoView
                    player={videoPlayer}
                    style={StyleSheet.absoluteFill}
                    contentFit="contain"
                    nativeControls={false}
                  />
                ) : (
                  <Image
                    source={{ uri: photo.uri }}
                    style={StyleSheet.absoluteFill}
                    contentFit="contain"
                  />
                )}
              </View>
              <View style={[styles.confirmationBar, { paddingBottom: Math.max(insets.bottom, 16) }]}>
                <View style={styles.confirmBarRow}>
                  <View style={styles.confirmLeftColumn}>
                    <TouchableOpacity
                      style={styles.confirmPresenceToggle}
                      onPress={() => setIsCompanionInReflection(!isCompanionInReflection)}
                      activeOpacity={0.7}
                    >
                      <FontAwesome
                        name={isCompanionInReflection ? 'check-square-o' : 'square-o'}
                        size={16}
                        color={isCompanionInReflection ? '#4FC3F7' : 'rgba(255,255,255,0.6)'}
                      />
                      <Text style={[
                        styles.confirmPresenceText,
                        isCompanionInReflection && styles.confirmPresenceTextActive,
                      ]}>
                        I'm in this
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.confirmPresenceToggle}
                      onPress={() => setIsExplorerInReflection(!isExplorerInReflection)}
                      activeOpacity={0.7}
                    >
                      <FontAwesome
                        name={isExplorerInReflection ? 'check-square-o' : 'square-o'}
                        size={16}
                        color={isExplorerInReflection ? '#4FC3F7' : 'rgba(255,255,255,0.6)'}
                      />
                      <Text style={[
                        styles.confirmPresenceText,
                        isExplorerInReflection && styles.confirmPresenceTextActive,
                      ]}>
                        {explorerName || 'Explorer'} is in this
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => detailsSheetRef.current?.snapToIndex(0)}
                      style={styles.addDetailsBtn}
                      activeOpacity={0.7}
                    >
                      <FontAwesome
                        name="magic"
                        size={12}
                        color={peopleContext.trim().length > 0 ? '#f39c12' : '#4CAF50'}
                      />
                      <Text style={[
                        styles.addDetailsText,
                        peopleContext.trim().length > 0 && { color: '#f39c12' },
                      ]}>
                        More Details
                      </Text>
                    </TouchableOpacity>
                  </View>
                  <View style={styles.confirmRightColumn}>
                    <TouchableOpacity onPress={handleConfirmChoose} style={styles.confirmChooseBtn}>
                      <Text style={styles.confirmChooseText}>Choose</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={handleConfirmCancel} style={styles.confirmCancelBtn}>
                      <Text style={styles.confirmCancelText}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
              <BottomSheet
                ref={detailsSheetRef}
                index={-1}
                snapPoints={[360]}
                enablePanDownToClose
                backgroundStyle={{ backgroundColor: '#1a1a2e' }}
                handleIndicatorStyle={{ backgroundColor: 'rgba(255,255,255,0.3)' }}
              >
                <BottomSheetView style={styles.detailsSheetContent}>
                  <Text style={styles.detailsSheetTitle}>More Details</Text>
                  <TouchableOpacity
                    style={styles.sheetPresenceToggle}
                    onPress={() => setIsCompanionInReflection(!isCompanionInReflection)}
                    activeOpacity={0.7}
                  >
                    <FontAwesome
                      name={isCompanionInReflection ? 'check-square-o' : 'square-o'}
                      size={16}
                      color={isCompanionInReflection ? '#4FC3F7' : 'rgba(255,255,255,0.6)'}
                    />
                    <Text style={[
                      styles.confirmPresenceText,
                      isCompanionInReflection && styles.confirmPresenceTextActive,
                    ]}>
                      I'm in this
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.sheetPresenceToggle}
                    onPress={() => setIsExplorerInReflection(!isExplorerInReflection)}
                    activeOpacity={0.7}
                  >
                    <FontAwesome
                      name={isExplorerInReflection ? 'check-square-o' : 'square-o'}
                      size={16}
                      color={isExplorerInReflection ? '#4FC3F7' : 'rgba(255,255,255,0.6)'}
                    />
                    <Text style={[
                      styles.confirmPresenceText,
                      isExplorerInReflection && styles.confirmPresenceTextActive,
                    ]}>
                      {explorerName || 'Explorer'} is in this
                    </Text>
                  </TouchableOpacity>
                  <View style={styles.detailsInputRow}>
                    <FontAwesome name="users" size={14} color="rgba(255,255,255,0.4)" style={{ marginTop: 2 }} />
                    <BottomSheetTextInput
                      style={styles.detailsInput}
                      placeholder="e.g. Nona, dog Dalton, baby Dante, at Nona's house"
                      placeholderTextColor="rgba(255,255,255,0.3)"
                      value={peopleContext}
                      onChangeText={setPeopleContext}
                      returnKeyType="done"
                      autoCorrect={false}
                      autoCapitalize="words"
                    />
                  </View>
                  <Text style={styles.detailsHint}>
                    Use commas to separate names, pets, places, or other details
                  </Text>
                  <TouchableOpacity
                    style={styles.detailsDoneBtn}
                    onPress={() => detailsSheetRef.current?.close()}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.detailsDoneText}>Done</Text>
                  </TouchableOpacity>
                </BottomSheetView>
              </BottomSheet>
            </KeyboardAvoidingView>
          ) : showComposer && photo ? (
            <View style={styles.composerContainer}>
              <ReflectionComposer
                mediaUri={photo.uri}
                mediaType={mediaType}
                initialCaption={description}
                audioUri={audioUri}
                aiArtifacts={{
                  caption: shortCaption,
                  deepDive: deepDive,
                  audioUrl: aiAudioUrl || undefined,
                  deepDiveAudioUrl: aiDeepDiveAudioUrl || undefined,
                }}
                isAiThinking={isAiThinking}
                isSending={uploading}
                onCancel={handleClose}
                onReplaceMedia={handleReplaceMedia}
                onTriggerMagic={async (targetCaption?: string) => {
                  const result = await generateDeepDiveBackground({
                    silent: false,
                    targetCaption: targetCaption || description || undefined
                  });
                }}
                onSend={(data) => {
                  uploadEventBundle({
                    caption: data.caption,
                    audioUri: data.audioUri,
                    deepDive: data.deepDive
                  });
                }}
                audioRecorder={audioRecorder}
                onStartRecording={startRecording}
                onStopRecording={stopRecording}
              />
            </View>
          ) : (
            <LinearGradient colors={['#A1C4FD', '#C2E9FB']} style={styles.creatingWaitContainer}>
              <View style={styles.modalCloseBar}>
                <TouchableOpacity onPress={handleClose} style={styles.modalCloseButton}>
                  <FontAwesome name="times" size={24} color="#2C3E50" />
                  <Text style={styles.modalCloseText}>Close</Text>
                </TouchableOpacity>
              </View>
              <View style={styles.creatingWaitContent}>
                <Text style={styles.creatingWaitText}>Opening creation tools...</Text>
              </View>
            </LinearGradient>
          )}
        </View>
      )}

      {/* Name Modal - First Launch Only (simple overlay, OK to use Modal) */}
      <Modal
        visible={showNameModal && !showFullScreenOverlay}
        animationType="fade"
        transparent={true}
        onRequestClose={() => {
          if (companionName) {
            setShowNameModal(false);
          }
        }}
      >
        <View style={styles.nameModalOverlay}>
          <View style={styles.nameModalContent}>
            <Text style={styles.nameModalTitle}>Who is this?</Text>
            <Text style={styles.nameModalDescription}>
              Please set your name in Settings. This name will appear as the sender of your Reflections.
            </Text>
            <TouchableOpacity
              style={styles.nameModalButton}
              onPress={() => {
                setShowNameModal(false);
                router.push('/settings');
              }}
            >
              <Text style={styles.nameModalButtonText}>Go to Settings</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Toast Notification */}
      {toastMessage ? (
        <Animated.View style={[styles.toast, { opacity: toastOpacity }]}>
          <Text style={styles.toastText}>{toastMessage}</Text>
        </Animated.View>
      ) : null}
    </>
  );
}

var styles = StyleSheet.create({
  sheetHandle: {
    backgroundColor: 'rgba(44, 62, 80, 0.35)',
    width: 40,
  },
  sheetBackground: {
    backgroundColor: '#C2E9FB',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  sheetContent: {
    flex: 1,
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  fullScreenOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
    elevation: 9999,
  },
  composerContainer: {
    flex: 1,
    backgroundColor: '#fff',
  },
  creatingWaitContainer: {
    flex: 1,
  },
  creatingWaitContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  creatingWaitText: {
    fontSize: 20,
    fontWeight: '600',
    color: '#2C3E50',
    textAlign: 'center',
  },
  modalCloseBar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 8,
    backgroundColor: 'transparent',
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  modalCloseButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
  },
  modalCloseText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#2C3E50',
  },
  container: {
    flex: 1,
    justifyContent: 'center'
  },
  dashboardContainer: {
    flex: 1,
  },
  dashboardContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 16,
  },
  dashboardTitle: {
    fontSize: 22,
    fontWeight: '600',
    color: '#2C3E50',
    marginBottom: 14,
    textAlign: 'center',
    fontFamily: Platform.select({
      ios: 'System',
      android: 'sans-serif',
      default: 'sans-serif',
    }),
  },
  dashboardButtons: {
    width: '100%',
    gap: 16,
    maxWidth: 400,
  },
  simpleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 10,
  },
  captureButton: {
    backgroundColor: '#2E78B7',
  },
  galleryButton: {
    backgroundColor: '#8E44AD',
  },
  searchButton: {
    backgroundColor: '#E67E22',
  },
  simpleButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  permissionText: {
    textAlign: 'center',
    marginBottom: 20,
    fontSize: 16,
  },
  button: {
    backgroundColor: '#2e78b7',
    padding: 15,
    borderRadius: 8,
    marginTop: 20
  },
  buttonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  previewContainer: {
    flex: 1,
    backgroundColor: '#000',
    padding: 20,
  },
  creationTitle: {
    fontSize: 28,
    fontWeight: '600',
    color: '#fff',
    marginBottom: 20,
    textAlign: 'center',
    fontFamily: Platform.select({
      ios: 'System',
      android: 'Roboto',
      default: 'sans-serif',
    }),
  },
  previewImageContainer: {
    flex: 1,
    backgroundColor: '#333',
    borderRadius: 10,
    overflow: 'hidden',
    marginBottom: 20,
  },
  previewImage: {
    width: '100%',
    height: '100%',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  micButton: {
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 15,
    width: 54,
    height: 54,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#2e78b7',
  },
  audioSection: {
    marginTop: 15,
    marginBottom: 10,
  },
  recordButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#d32f2f',
    padding: 15,
    borderRadius: 8,
    gap: 10,
  },
  recordButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  recordingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#333',
    padding: 15,
    borderRadius: 8,
    gap: 10,
  },
  recordingIndicator: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#d32f2f',
  },
  recordingText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
    flex: 1,
  },
  stopButton: {
    backgroundColor: '#d32f2f',
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 6,
  },
  stopButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 'bold',
  },
  audioPlaybackContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#e3f2fd',
    padding: 15,
    borderRadius: 8,
    gap: 10,
  },
  audioPlaybackText: {
    color: '#2e78b7',
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
  },
  rerecordButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#2e78b7',
  },
  rerecordButtonText: {
    color: '#2e78b7',
    fontSize: 12,
    fontWeight: 'bold',
  },
  actionButtons: {
    flexDirection: 'row',
    gap: 10,
  },
  actionButton: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButton: {
    backgroundColor: '#2e78b7',
  },
  actionButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
    width: '100%',
  },
  aiIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    paddingLeft: 4,
  },
  aiIndicatorText: {
    color: '#9b59b6',
    fontSize: 12,
    fontStyle: 'italic',
  },
  // Intent-based UI styles
  imageTopButtons: {
    position: 'absolute',
    top: 10,
    left: 10,
    right: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  backToActionsButton: {
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  backToActionsButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  cancelButton: {
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  cancelButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  actionButtonsContainer: {
    padding: 20,
    gap: 20,
    marginTop: 10,
  },
  intentButton: {
    borderRadius: 24,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.5)',
  },
  intentButtonBlur: {
    backgroundColor: 'rgba(255, 255, 255, 0.6)',
    paddingVertical: 20,
    paddingHorizontal: 24,
    borderRadius: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    minHeight: 70,
  },
  intentButtonText: {
    color: '#2C3E50',
    fontSize: 18,
    fontWeight: '600',
  },
  voiceIntentContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
    gap: 30,
  },
  recordButtonLarge: {
    backgroundColor: '#e74c3c',
    width: 150,
    height: 150,
    borderRadius: 75,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 10,
  },
  recordButtonTextLarge: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  textIntentContainer: {
    flex: 1,
    padding: 20,
    gap: 15,
  },
  changeMethodLink: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  changeMethodText: {
    color: '#2e78b7',
    fontSize: 14,
    textDecorationLine: 'underline',
  },
  backToActionsLink: {
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 10,
  },
  backToActionsText: {
    color: '#2e78b7',
    fontSize: 16,
    fontWeight: '600',
  },
  videoPreviewContainer: {
    width: '100%',
    height: '100%',
    position: 'relative',
  },
  videoPlayIcon: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: [{ translateX: -30 }, { translateY: -30 }],
    zIndex: 1,
  },
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
  confirmationContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  confirmationMedia: {
    flex: 1,
    margin: 12,
    borderRadius: 12,
    overflow: 'hidden',
  },
  confirmationBar: {
    paddingHorizontal: 20,
    paddingTop: 14,
    backgroundColor: 'rgba(0,0,0,0.85)',
  },
  confirmBarRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  confirmLeftColumn: {
    alignItems: 'flex-start',
    gap: 6,
    flex: 1,
  },
  confirmRightColumn: {
    alignItems: 'center',
    gap: 8,
    marginLeft: 16,
  },
  confirmPresenceToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingVertical: 3,
  },
  confirmPresenceText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 14,
    fontWeight: '500',
  },
  confirmPresenceTextActive: {
    color: '#4FC3F7',
  },
  addDetailsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
    paddingVertical: 4,
  },
  addDetailsText: {
    color: '#4CAF50',
    fontSize: 14,
    fontWeight: '500',
  },
  confirmChooseBtn: {
    backgroundColor: '#2E78B7',
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 20,
    minWidth: 90,
    alignItems: 'center',
  },
  confirmChooseText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  confirmCancelBtn: {
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    minWidth: 90,
    alignItems: 'center',
  },
  confirmCancelText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 16,
    fontWeight: '500',
  },
  detailsSheetContent: {
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 20,
    gap: 10,
  },
  sheetPresenceToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  detailsSheetTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  detailsInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  detailsInput: {
    flex: 1,
    color: '#fff',
    fontSize: 14,
    padding: 0,
  },
  detailsHint: {
    color: 'rgba(255,255,255,0.3)',
    fontSize: 11,
    marginLeft: 2,
  },
  detailsDoneBtn: {
    alignSelf: 'center',
    backgroundColor: '#2E78B7',
    paddingVertical: 10,
    paddingHorizontal: 28,
    borderRadius: 20,
    marginTop: 6,
  },
  detailsDoneText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  companionNameContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 28,
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
  },
  companionNameText: {
    color: '#2C3E50',
    fontSize: 14,
    fontWeight: '500',
  },
  nameModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  nameModalContent: {
    backgroundColor: '#1a1a1a',
    borderRadius: 20,
    padding: 30,
    width: '100%',
    maxWidth: 400,
    alignItems: 'center',
    gap: 20,
  },
  nameModalTitle: {
    fontSize: 24,
    fontWeight: '600',
    color: '#fff',
    textAlign: 'center',
  },
  nameModalDescription: {
    fontSize: 16,
    color: '#999',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 8,
  },
  nameModalButton: {
    width: '100%',
    backgroundColor: '#2e78b7',
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
    alignItems: 'center',
  },
  nameModalButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
