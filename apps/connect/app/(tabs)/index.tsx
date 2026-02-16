import ReflectionComposer from '@/components/ReflectionComposer';
import { useReflectionMedia } from '@/context/ReflectionMediaContext';
import { prepareImageForUpload } from '@/utils/mediaProcessor';
import { FontAwesome } from '@expo/vector-icons';
import { API_ENDPOINTS, ExplorerConfig, useAuth, useExplorer } from '@projectmirror/shared';
import { collection, db, doc, serverTimestamp, setDoc } from '@projectmirror/shared/firebase';
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import { BlurView } from 'expo-blur';
import * as FileSystem from 'expo-file-system';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useVideoPlayer } from 'expo-video';
import * as VideoThumbnails from 'expo-video-thumbnails';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Animated, AppState, AppStateStatus, Modal, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

// Keep debug logging opt-in (Metro logs are noisy and can affect perf during testing).
const DEBUG_LOGS = __DEV__ && false;
const debugLog = (...args: any[]) => {
  if (DEBUG_LOGS) console.log(...args);
};

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

export default function CompanionHomeScreen() {
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
  const [pressedButton, setPressedButton] = useState<string | null>(null);
  const { currentExplorerId, explorerName, activeRelationship } = useExplorer();
  const { consumePendingMedia } = useReflectionMedia();

  // Toast state
  const [toastMessage, setToastMessage] = useState<string>('');
  const toastOpacity = useRef(new Animated.Value(0)).current;

  // Video support state
  const [mediaType, setMediaType] = useState<'photo' | 'video'>('photo');
  const [videoUri, setVideoUri] = useState<string | null>(null);
  const [imageSourceType, setImageSourceType] = useState<'camera' | 'search'>('camera');
  const [showNameModal, setShowNameModal] = useState(false);
  const router = useRouter();

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

  // Consume pending media from camera/gallery/search screens
  useEffect(() => {
    const media = consumePendingMedia();
    if (media) {
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
      setShowDescriptionInput(true);
      setDescription('');
      setIsAiGenerated(false);
      setShortCaption('');
      setDeepDive('');
      setIntent('none');
      setAudioUri(null);
      setStagingEventId(null);
      stagingEventIdRef.current = null;
      // Prevent stale recorder URI from being re-applied as "new" audio.
      lastProcessedUriRef.current = audioRecorder.uri ?? lastProcessedUriRef.current;
    }
  });

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

      let fetchUrl = `${API_ENDPOINTS.AI_DESCRIPTION}?image_url=${encodeURIComponent(imageUrl)}&explorer_id=${currentExplorerId}`;
      if (options.targetCaption) fetchUrl += `&target_caption=${encodeURIComponent(options.targetCaption)}`;
      if (options.targetDeepDive) fetchUrl += `&target_deep_dive=${encodeURIComponent(options.targetDeepDive)}`;
      if (options.skipTts) fetchUrl += `&skip_tts=true`;

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

      // 7. Queue Metadata Upload
      const metadata: any = {
        description: finalCaption || (hasAudio ? "Voice message" : (mediaType === 'video' ? "Video message" : "")),
        sender: companionName || "Companion",
        timestamp: timestamp,
        event_id: eventID,
        content_type: mediaType === 'video' ? 'video' : (hasAudio ? 'audio' : 'text'),
        short_caption: finalCaption,
        deep_dive: finalDeepDive,
        image_source: imageSourceType,
      };

      debugLog('📄 Final Metadata to upload:', JSON.stringify(metadata, null, 2));

      if (urls['metadata.json']) {
        debugLog('📤 uploadEventBundle: Queuing metadata upload...');
        uploadPromises.push(
          fetch(urls['metadata.json'], {
            method: 'PUT',
            body: JSON.stringify(metadata, null, 2),
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

      // 10. Reset State
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
      if (audioRecorder.isRecording) {
        await stopRecording();
      }

      // 11. Write Signal to Firestore
      setDoc(doc(collection(db, ExplorerConfig.collections.reflections), eventID), {
        explorerId: currentExplorerId,
        event_id: eventID,
        sender: companionName || "Companion",
        status: "ready",
        timestamp: serverTimestamp(),
        type: "mirror_event",
        engagement_count: 0,
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

    // Best-effort cleanup of any cache-based temp media
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
  };

  const retakePhoto = async () => {
    const photoUriToClean = photo?.uri ?? null;
    const videoUriToClean = videoUri;
    await deleteStagingArtifacts();

    // Best-effort cleanup of any cache-based temp media
    await safeDeleteCacheFile(photoUriToClean);
    await safeDeleteCacheFile(videoUriToClean);

    // Clear all state and return to camera
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

  // Show description input overlay if photo is captured
  if (showDescriptionInput && photo) {
    return (
      <ReflectionComposer
        mediaUri={photo.uri}
        mediaType={mediaType}
        // State Props
        initialCaption={description} // Pass current state if any
        audioUri={audioUri}
        aiArtifacts={{
          caption: shortCaption,
          deepDive: deepDive,
          audioUrl: aiAudioUrl || undefined,
          deepDiveAudioUrl: aiDeepDiveAudioUrl || undefined,
        }}
        isAiThinking={isAiThinking}
        isSending={uploading}

        // Actions
        onCancel={cancelPhoto}
        onTriggerMagic={async (targetCaption?: string) => {
          // Wrap your existing generator, passing edited caption if provided
          const result = await generateDeepDiveBackground({
            silent: false,
            targetCaption: targetCaption || description || undefined
          });
          // If result exists, the composer handles the UI update via props
        }}
        onSend={(data) => {
          // Pass data directly to the updated upload function
          uploadEventBundle({
            caption: data.caption,
            audioUri: data.audioUri,
            deepDive: data.deepDive
          });
        }}

        // Audio Props
        audioRecorder={audioRecorder}
        onStartRecording={startRecording}
        onStopRecording={stopRecording}
      />
    );
  }

  // Dashboard view
  return (
    <LinearGradient
      colors={['#A1C4FD', '#C2E9FB']}
      style={styles.dashboardContainer}
    >
      <View style={styles.dashboardContent}>
        <Text style={styles.dashboardTitle}>
          {explorerName ? `Reflection for ${explorerName}` : 'Create a Reflection'}
        </Text>

        {/* Companion Name Display */}
        {companionName && (
          <View style={styles.companionNameContainer}>
            <Text style={styles.companionNameText}>Posting as {companionName}</Text>
          </View>
        )}

        <View style={styles.dashboardButtons}>
          <TouchableOpacity
            style={[
              styles.dashboardButton,
              pressedButton === 'capture' && styles.dashboardButtonPressed
            ]}
            onPress={() => router.push('/camera')}
            onPressIn={() => setPressedButton('capture')}
            onPressOut={() => setPressedButton(null)}
            disabled={uploading}
            activeOpacity={1}
          >
            <BlurView intensity={50} style={[
              styles.dashboardButtonBlur,
              styles.captureButtonBlur,
              pressedButton === 'capture' && styles.buttonBlurPressed
            ]}>
              <LinearGradient
                colors={['rgba(255, 255, 255, 0.4)', 'rgba(255, 255, 255, 0)']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.innerGlow}
              />
              <View style={styles.iconContainer}>
                <FontAwesome name="camera" size={53} color="#2E78B7" />
              </View>
              <Text style={styles.captureButtonText}>Capture Photo or Video</Text>
            </BlurView>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.dashboardButton,
              pressedButton === 'gallery' && styles.dashboardButtonPressed
            ]}
            onPress={() => router.push('/gallery')}
            onPressIn={() => setPressedButton('gallery')}
            onPressOut={() => setPressedButton(null)}
            disabled={uploading}
            activeOpacity={1}
          >
            <BlurView intensity={50} style={[
              styles.dashboardButtonBlur,
              styles.galleryButtonBlur,
              pressedButton === 'gallery' && styles.buttonBlurPressed
            ]}>
              <LinearGradient
                colors={['rgba(255, 255, 255, 0.4)', 'rgba(255, 255, 255, 0)']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.innerGlow}
              />
              <View style={styles.iconContainer}>
                <FontAwesome name="photo" size={53} color="#8E44AD" />
              </View>
              <Text style={styles.galleryButtonText}>Pick from Gallery</Text>
            </BlurView>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.dashboardButton,
              pressedButton === 'search' && styles.dashboardButtonPressed
            ]}
            onPress={() => router.push('/search')}
            onPressIn={() => setPressedButton('search')}
            onPressOut={() => setPressedButton(null)}
            disabled={uploading}
            activeOpacity={1}
          >
            <BlurView intensity={50} style={[
              styles.dashboardButtonBlur,
              styles.searchButtonBlur,
              pressedButton === 'search' && styles.buttonBlurPressed
            ]}>
              <LinearGradient
                colors={['rgba(255, 255, 255, 0.4)', 'rgba(255, 255, 255, 0)']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.innerGlow}
              />
              <View style={styles.iconContainer}>
                <FontAwesome name="search" size={53} color="#16A085" />
              </View>
              <Text style={styles.searchButtonText}>Search Images</Text>
            </BlurView>
          </TouchableOpacity>
        </View>
      </View>

      {/* Name Modal - First Launch Only */}
      <Modal
        visible={showNameModal}
        animationType="fade"
        transparent={true}
        onRequestClose={() => {
          // Don't allow closing without setting a name on first launch
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
    </LinearGradient>
  );
}

var styles = StyleSheet.create({
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
    padding: 40,
  },
  dashboardTitle: {
    fontSize: 32,
    fontWeight: '600',
    color: '#2C3E50',
    marginBottom: 60,
    textAlign: 'center',
    fontFamily: Platform.select({
      ios: 'System',
      android: 'sans-serif',
      default: 'sans-serif',
    }),
  },
  dashboardButtons: {
    width: '100%',
    gap: 28,
    maxWidth: 400,
  },
  dashboardButton: {
    borderRadius: 24,
    overflow: 'hidden',
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.9)',
    backgroundColor: 'transparent', // Required for efficient shadow rendering
    ...Platform.select({
      ios: {
        shadowColor: '#fff',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.5,
        shadowRadius: 4,
      },
      android: {
        elevation: 4,
      },
      default: {
        shadowColor: '#fff',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.5,
        shadowRadius: 4,
      },
    }),
  },
  dashboardButtonPressed: {
    transform: [{ scale: 0.98 }],
  },
  dashboardButtonBlur: {
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
    paddingVertical: 30,
    paddingHorizontal: 40,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    minHeight: 120,
    width: '100%',
    position: 'relative',
  },
  captureButtonBlur: {
    backgroundColor: 'rgba(180, 215, 255, 0.4)',
    ...Platform.select({
      ios: {
        shadowColor: '#2E78B7',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.15,
        shadowRadius: 12,
      },
      android: {
        elevation: 8,
      },
      default: {
        shadowColor: '#2E78B7',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.15,
        shadowRadius: 12,
      },
    }),
  },
  galleryButtonBlur: {
    backgroundColor: 'rgba(220, 190, 255, 0.4)',
    ...Platform.select({
      ios: {
        shadowColor: '#8E44AD',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.15,
        shadowRadius: 12,
      },
      android: {
        elevation: 8,
      },
      default: {
        shadowColor: '#8E44AD',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.15,
        shadowRadius: 12,
      },
    }),
  },
  searchButtonBlur: {
    backgroundColor: 'rgba(180, 255, 220, 0.4)',
    ...Platform.select({
      ios: {
        shadowColor: '#16A085',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.15,
        shadowRadius: 12,
      },
      android: {
        elevation: 8,
      },
      default: {
        shadowColor: '#16A085',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.15,
        shadowRadius: 12,
      },
    }),
  },
  buttonBlurPressed: {
    opacity: 0.9,
  },
  innerGlow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 24,
  },
  iconContainer: {
    padding: 4,
    zIndex: 1,
  },
  captureButtonText: {
    color: '#2E78B7',
    fontSize: 20,
    fontWeight: '600',
    fontFamily: Platform.select({
      ios: 'System',
      android: 'sans-serif',
      default: 'sans-serif',
    }),
    zIndex: 1,
  },
  galleryButtonText: {
    color: '#8E44AD',
    fontSize: 20,
    fontWeight: '600',
    fontFamily: Platform.select({
      ios: 'System',
      android: 'sans-serif',
      default: 'sans-serif',
    }),
    zIndex: 1,
  },
  searchButtonText: {
    color: '#16A085',
    fontSize: 20,
    fontWeight: '600',
    fontFamily: Platform.select({
      ios: 'System',
      android: 'sans-serif',
      default: 'sans-serif',
    }),
    zIndex: 1,
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
  searchButton: {
    // Same as galleryButton
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
  companionNameContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -40,
    marginBottom: 20,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 20,
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
