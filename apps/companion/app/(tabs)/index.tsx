import CameraModal from '@/components/CameraModal';
import ReflectionComposer from '@/components/ReflectionComposer';
import { prepareImageForUpload, prepareVideoForUpload } from '@/utils/mediaProcessor';
import { FontAwesome } from '@expo/vector-icons';
import { API_ENDPOINTS, ExplorerIdentity } from '@projectmirror/shared';
import { db } from '@projectmirror/shared/firebase';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import { BlurView } from 'expo-blur';
import { CameraType, useCameraPermissions } from 'expo-camera';
import * as FileSystem from 'expo-file-system';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useRouter } from 'expo-router';
import { useVideoPlayer } from 'expo-video';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { collection, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, AppState, AppStateStatus, FlatList, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

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
  const [permission, requestPermission] = useCameraPermissions();
  const [photo, setPhoto] = useState<any>(null);
  const [uploading, setUploading] = useState(false);
  const [facing, setFacing] = useState<CameraType>('front');
  const [description, setDescription] = useState('');
  const [showDescriptionInput, setShowDescriptionInput] = useState(false);
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [audioUri, setAudioUri] = useState<string | null>(null);
  const [isSearchModalVisible, setIsSearchModalVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isStartingRecording, setIsStartingRecording] = useState(false);
  const [isLoadingGallery, setIsLoadingGallery] = useState(false);
  const [isLoadingImage, setIsLoadingImage] = useState(false);
  const [isAiThinking, setIsAiThinking] = useState(false);
  const [isAiGenerated, setIsAiGenerated] = useState(false);
  const [shortCaption, setShortCaption] = useState<string>('');
  const [deepDive, setDeepDive] = useState<string>('');
  const [stagingEventId, setStagingEventId] = useState<string | null>(null);
  const [aiAudioUrl, setAiAudioUrl] = useState<string | null>(null);
  const [aiDeepDiveAudioUrl, setAiDeepDiveAudioUrl] = useState<string | null>(null);
  const [intent, setIntent] = useState<'none' | 'voice' | 'ai' | 'note'>('none');
  const [showCameraModal, setShowCameraModal] = useState(false);
  const [pressedButton, setPressedButton] = useState<string | null>(null);

  // Toast state
  const [toastMessage, setToastMessage] = useState<string>('');
  const toastOpacity = useRef(new Animated.Value(0)).current;

  // Video support state
  const [mediaType, setMediaType] = useState<'photo' | 'video'>('photo');
  const [cameraMode, setCameraMode] = useState<'photo' | 'video'>('photo');
  const [videoUri, setVideoUri] = useState<string | null>(null);
  const [imageSourceType, setImageSourceType] = useState<'camera' | 'search'>('camera');
  const [companionName, setCompanionName] = useState<string>('');
  const [showNameModal, setShowNameModal] = useState(false);
  const router = useRouter();

  // Video player for preview
  const videoPlayer = useVideoPlayer(videoUri || '', (player) => {
    // Optional: handle status updates
  });

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

  const cameraRef = useRef<any>(null);
  const lastProcessedUriRef = useRef<string | null>(null);
  
  // Timeout refs for cleanup
  const cameraModalTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      if (cameraModalTimeoutRef.current) clearTimeout(cameraModalTimeoutRef.current);
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

  // Check for companion name on mount and when screen comes into focus
  const loadCompanionName = useCallback(async () => {
    try {
      const storedName = await AsyncStorage.getItem('companion_name');
      if (storedName) {
        setCompanionName(storedName);
        setShowNameModal(false);
      } else {
        setShowNameModal(true);
      }
    } catch (error) {
      console.error('Error reading companion name:', error);
      setShowNameModal(true);
    }
  }, []);

  // Load name on mount
  useEffect(() => {
    loadCompanionName();
  }, [loadCompanionName]);

  // Reload name when screen comes into focus (e.g., returning from settings)
  useFocusEffect(
    useCallback(() => {
      loadCompanionName();
    }, [loadCompanionName])
  );

  // Request audio permissions on mount
  useEffect(() => {
    (async () => {
      // Request microphone for audio recording
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        console.warn('🎤 Microphone permission denied');
      } else {
        debugLog('✅ Microphone permission granted');
      }

      // Request camera permission
      if (!permission) {
      debugLog('📸 Requesting camera permission...');
        const cameraResult = await requestPermission();
        if (cameraResult.granted) {
          debugLog('✅ Camera permission granted');
        } else {
          console.warn('❌ Camera permission denied');
        }
      }

      // Request photo library permission
      debugLog('📷 Requesting photo library permission...');
      const libraryResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (libraryResult.granted) {
        debugLog('✅ Photo library permission granted');
      } else {
        console.warn('❌ Photo library permission denied');
      }
    })();
  }, []);

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

  if (!permission) return <View />;
  if (!permission.granted) {
    return (
      <View style={styles.container}>
        <Text style={styles.permissionText}>We need your permission to show the camera</Text>
        <TouchableOpacity onPress={requestPermission} style={styles.button}>
          <Text style={styles.buttonText}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const toggleCameraFacing = () => {
    setFacing(current => (current === 'back' ? 'front' : 'back'));
  };

  const openCameraModal = () => {
    setCameraMode('photo');
    setFacing('front');
    // Small delay to ensure facing state is updated before modal renders
    if (cameraModalTimeoutRef.current) clearTimeout(cameraModalTimeoutRef.current);
    cameraModalTimeoutRef.current = setTimeout(() => {
      setShowCameraModal(true);
    }, 50);
  };

  const closeCameraModal = () => {
    setShowCameraModal(false);
  };

  const getAIDescription = async (imageUrl: string, options: { silent?: boolean, targetCaption?: string, targetDeepDive?: string, skipTts?: boolean } = {}) => {
    try {
      if (!options.silent) {
        setIsAiThinking(true);
        setIsAiGenerated(false);
      }

      let fetchUrl = `${API_ENDPOINTS.AI_DESCRIPTION}?image_url=${encodeURIComponent(imageUrl)}&explorer_id=${ExplorerIdentity.currentExplorerId}`;
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

  const searchUnsplash = async (query: string) => {
    if (!query.trim()) return;

    setIsSearching(true);
    setSearchResults([]); // Clear previous results

    try {
      const response = await fetch(`${API_ENDPOINTS.UNSPLASH_SEARCH}?query=${encodeURIComponent(query)}`);

      if (!response.ok) {
        // Just set empty results - the empty state UI will handle the message
        setSearchResults([]);
        return;
      }

      const data = await response.json();

      // Check if we have results
      if (!data.results || data.results.length === 0) {
        // No results found - empty state UI will show the message
        setSearchResults([]);
        return;
      }

      // Unsplash API returns { results: [...] }
      setSearchResults(data.results || []);
    } catch (error: any) {
      console.error("Unsplash search error:", error);
      // Just set empty results - the empty state UI will handle the message
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  const handleQuickPick = (term: string) => {
    setSearchQuery(term);
    searchUnsplash(term);
  };

  const handleImageSelect = async (imageUrl: string) => {
    try {
      setIsLoadingImage(true);
      const optimizedUri = await prepareImageForUpload(imageUrl);

      setPhoto({ uri: optimizedUri });
      setImageSourceType('search');
      setIsSearchModalVisible(false);
      setShowDescriptionInput(true);
      setSearchQuery('');
      setDescription(''); // Clear previous description
      setIsAiGenerated(false);
      setShortCaption('');
      setDeepDive('');
      setIntent('none'); // Reset intent - show action buttons
      setAudioUri(null); // Clear any previous audio
      setStagingEventId(null); // Don't upload to staging until user chooses intent
      setSearchResults([]);
    } catch (error: any) {
      console.error('handleImageSelect error:', error);
      Alert.alert('Error', 'Failed to prepare selected image for upload.');
    } finally {
      setIsLoadingImage(false);
    }
  };

  const pickImageFromGallery = async () => {
    try {
      setIsLoadingGallery(true);
      // Request media library permissions
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'We need access to your photos to select an image.');
        setIsLoadingGallery(false);
        return;
      }

      // Launch media picker (supports both images and videos)
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'], // Support both images and videos
        allowsEditing: true,
        aspect: [4, 3],
        quality: 0.5,
        videoMaxDuration: 30, // Allow up to 30 seconds for selection (we'll warn if too long)
      });

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];

        // Check if it's a video
        if (asset.type === 'video') {
          // Check duration
          if (asset.duration && asset.duration > 30000) { // duration is in milliseconds
            Alert.alert(
              'Video Too Long',
              `The selected video is ${Math.round(asset.duration / 1000)} seconds. Please select a video shorter than 30 seconds.`,
              [{ text: 'OK' }]
            );
            setIsLoadingGallery(false);
            return;
          }

          setIsLoadingImage(true); // Show spinner
          const compressedUri = await prepareVideoForUpload(asset.uri);

          setMediaType('video');
          setVideoUri(compressedUri);
          setPhoto({ uri: compressedUri });
          setIsLoadingImage(false); // Hide spinner
        } else {
          const optimizedUri = await prepareImageForUpload(asset.uri);
          setMediaType('photo');
          setVideoUri(null);
          setPhoto({ uri: optimizedUri });
          setImageSourceType('camera');
          setIsLoadingImage(false); // Hide spinner
        }

        setIsLoadingImage(true);
        setShowDescriptionInput(true);
        // Clear any previous audio recording when selecting new media
        setAudioUri(null);
        setDescription('');
        setIsAiGenerated(false);
        setShortCaption('');
        setDeepDive('');

        setIntent('none'); // Reset intent - show action buttons
        setAudioUri(null); // Clear any previous audio
        setStagingEventId(null); // Don't upload to staging until user chooses intent

        // Reset the last processed URI to prevent stale URIs from being set
        lastProcessedUriRef.current = null;

        // Small delay to ensure media loads
        if (loadingImageTimeoutRef.current) clearTimeout(loadingImageTimeoutRef.current);
        loadingImageTimeoutRef.current = setTimeout(() => setIsLoadingImage(false), 300);
      }
      setIsLoadingGallery(false);
    } catch (error: any) {
      console.error("Media picker error:", error);
      Alert.alert("Error", "Failed to pick media from gallery");
      setIsLoadingGallery(false);
      setIsLoadingImage(false);
    }
  };

  const takePhoto = async () => {
    if (!cameraRef.current) return;

    try {
      const picture = await cameraRef.current.takePictureAsync({ quality: 0.5 });
      const optimizedUri = await prepareImageForUpload(picture.uri);
      // Best-effort cleanup of original capture if it lives in cache
      if (picture.uri !== optimizedUri) {
        await safeDeleteCacheFile(picture.uri);
      }
      setPhoto({ uri: optimizedUri });
      setMediaType('photo');
      setImageSourceType('camera');
      setShowDescriptionInput(true);
      setShowCameraModal(false); // Close camera modal after taking photo
      // Clear any previous audio recording when taking a new photo
      setAudioUri(null);
      setVideoUri(null);
      setDescription('');
      setIsAiGenerated(false);
      setShortCaption('');
      setDeepDive('');

      setIntent('none'); // Reset intent - show action buttons
      setAudioUri(null); // Clear any previous audio
      setStagingEventId(null); // Don't upload to staging until user chooses intent

      // Reset the last processed URI to prevent stale URIs from being set
      lastProcessedUriRef.current = null;
    } catch (error: any) {
      console.error("Photo capture error:", error);
      Alert.alert("Error", "Failed to capture photo");
    }
  };

  const recordVideoWithNativeCamera = async () => {
    try {
      debugLog('📹 Launching native camera for video recording...');

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Videos,
        allowsEditing: false,
        quality: 0.8,
        videoMaxDuration: 30, // 30 second limit
        cameraType: ImagePicker.CameraType.front, // Open in selfie mode
      });

      debugLog('📹 Camera result:', { cancelled: result.canceled, hasAssets: result.assets?.length });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const video = result.assets[0];
        debugLog('✅ Video recorded:', { uri: video.uri, duration: video.duration });

        // Check duration (duration is in milliseconds)
        if (video.duration && video.duration > 30000) {
          Alert.alert(
            "Video Too Long",
            "Please record a video that's 30 seconds or less.",
            [{ text: "OK" }]
          );
          return;
        }
        
        setIsLoadingImage(true); // Show spinner
        const compressedUri = await prepareVideoForUpload(video.uri);

        // Best-effort cleanup of original recording if it lives in cache
        if (video.uri !== compressedUri) {
          await safeDeleteCacheFile(video.uri);
        }

        setVideoUri(compressedUri);
        setPhoto({ uri: compressedUri });
        setMediaType('video');
        setShowDescriptionInput(true);
        closeCameraModal();
        setAudioUri(null);
        setDescription('');
        setIsAiGenerated(false);
        setShortCaption('');
        setDeepDive('');
        setIntent('none');
        setStagingEventId(null);
        lastProcessedUriRef.current = null;
        setIsLoadingImage(false); // Hide spinner
      }
    } catch (error: any) {
      console.error("❌ Video recording error:", error);
      Alert.alert("Error", `Failed to record video: ${error.message || 'Unknown error'}`);
    }
  };

  const handleCameraShutterPress = () => {
    debugLog('🎬 Shutter button pressed', { cameraMode });

    if (cameraMode === 'photo') {
      debugLog('📸 Taking photo...');
      takePhoto();
    } else {
      debugLog('📹 Launching native camera for video...');
      recordVideoWithNativeCamera();
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
    
    try {
      setUploading(true);

      // ALWAYS ensure we have a Deep Dive and correct TTS before proceeding
      // If we are missing deep dive, or if the caption text has changed from the original AI caption (meaning it was edited or manually typed)
      // and we don't have human audio, we should refresh the TTS.

      const needsDeepDive = !finalDeepDive;
      const needsCaptionAudio = !audioUri && (!finalCaptionAudio || finalCaption !== (shortCaption || ""));

      debugLog(`🔍 Enhancement Check: needsDeepDive=${needsDeepDive}, needsCaptionAudio=${needsCaptionAudio}, existingDeepDive="${finalDeepDive?.substring(0, 20)}..."`);

      if (needsDeepDive || needsCaptionAudio) {
        debugLog("🛠️ Reflection needs enhancement (Deep Dive or TTS), calling AI backend...");

        // Use our robust background generator which handles staging uploads and thumbnails correctly
        const aiResult = await generateDeepDiveBackground({
          silent: true,
          targetCaption: finalCaption,
          targetDeepDive: finalDeepDive || undefined,
          skipTts: !!audioUri
        });

        if (aiResult) {
          debugLog(`✅ AI Enhancement Success: Caption="${aiResult.short_caption?.substring(0, 30)}...", DeepDive="${aiResult.deep_dive?.substring(0, 30)}..."`);
          // PROTECTION: Never overwrite the user's manual caption during this final polish phase
          // if it doesn't match the AI's returned version. We favor what the user sees on screen.
          if (!finalCaption && aiResult.short_caption) {
            finalCaption = aiResult.short_caption;
          }

          finalDeepDive = aiResult.deep_dive;
          finalCaptionAudio = audioUri || aiResult.audio_url; // Keep human audio as absolute priority
          finalDeepDiveAudio = aiResult.deep_dive_audio_url;
          debugLog(`✨ Final Enhancement State: AudioURL=${finalCaptionAudio ? 'YES' : 'NO'}, DeepDiveAudioURL=${finalDeepDiveAudio ? 'YES' : 'NO'}`);
        } else {
          console.warn("⚠️ AI enhancement failed, proceeding with available content.");
        }
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
      if (audioUri) {
        const fileInfo = await FileSystem.getInfoAsync(audioUri);
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
          explorer_id: ExplorerIdentity.currentExplorerId,
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
        const stagingRes = await fetch(`${API_ENDPOINTS.GET_S3_URL}?path=staging&event_id=${stagingEventId}&filename=image.jpg&method=GET&explorer_id=${ExplorerIdentity.currentExplorerId}`);
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
        const audioSource = audioUri || finalCaptionAudio;
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

      // 9. Cleanup Staging & Local
      showToast('✅ Reflection sent!');

      if (stagingEventId) {
        fetch(`${API_ENDPOINTS.DELETE_MIRROR_EVENT}?event_id=${stagingEventId}&path=staging&explorer_id=${ExplorerIdentity.currentExplorerId}`).catch(() => { });
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
      setAudioUri(null);
      if (audioRecorder.isRecording) {
        await stopRecording();
      }

      // 11. Write Signal to Firestore
      setDoc(doc(collection(db, ExplorerIdentity.collections.reflections), eventID), {
        explorerId: ExplorerIdentity.currentExplorerId,
        event_id: eventID,
        sender: companionName || "Companion",
        status: "ready",
        timestamp: serverTimestamp(),
        type: "mirror_event",
        engagement_count: 0,
        // Explicitly include paths so Mirror knows exactly what files are available
        audio_url: hasAudio ? `https://mirror-uploads-sparago-2026.s3.us-east-1.amazonaws.com/${ExplorerIdentity.currentExplorerId}/to/${eventID}/audio.m4a` : null,
        deep_dive_audio_url: hasDeepDiveAudio ? `https://mirror-uploads-sparago-2026.s3.us-east-1.amazonaws.com/${ExplorerIdentity.currentExplorerId}/to/${eventID}/deep_dive.m4a` : null,
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

  const cancelPhoto = async () => {
    const photoUriToClean = photo?.uri ?? null;
    const videoUriToClean = videoUri;
    // Clean up staging image if it exists
    if (stagingEventId) {
      try {
        await fetch(`${API_ENDPOINTS.DELETE_MIRROR_EVENT}?event_id=${stagingEventId}&path=staging&explorer_id=${ExplorerIdentity.currentExplorerId}`);
      } catch (error: any) {
        console.error("Error deleting staging image:", error);
        // Continue with cleanup anyway
      }
    }

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
    setIntent('none');
    setAudioUri(null);
  };

  const retakePhoto = async () => {
    const photoUriToClean = photo?.uri ?? null;
    const videoUriToClean = videoUri;
    // Clean up staging image
    if (stagingEventId) {
      try {
        await fetch(`${API_ENDPOINTS.DELETE_MIRROR_EVENT}?event_id=${stagingEventId}&path=staging&explorer_id=${ExplorerIdentity.currentExplorerId}`);
      } catch (error: any) {
        console.error("Error deleting staging image:", error);
      }
    }

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
    setIntent('none');
    setAudioUri(null);
    lastProcessedUriRef.current = null;
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
        const stagingResponse = await fetch(`${API_ENDPOINTS.GET_S3_URL}?path=staging&event_id=${stagingId}&filename=image.jpg&explorer_id=${ExplorerIdentity.currentExplorerId}`);
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
      const getStagingUrlResponse = await fetch(`${API_ENDPOINTS.GET_S3_URL}?path=staging&event_id=${stagingId}&filename=image.jpg&method=GET&explorer_id=${ExplorerIdentity.currentExplorerId}`);
      if (getStagingUrlResponse.ok) {
        const { url: getStagingUrl } = await getStagingUrlResponse.json();
        return await getAIDescription(getStagingUrl, options);
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
    lastProcessedUriRef.current = null;
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
        <Text style={styles.dashboardTitle}>Create a Reflection</Text>
        
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
            onPress={openCameraModal}
            onPressIn={() => setPressedButton('capture')}
            onPressOut={() => setPressedButton(null)}
            disabled={uploading || !permission?.granted}
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
            onPress={pickImageFromGallery}
            onPressIn={() => setPressedButton('gallery')}
            onPressOut={() => setPressedButton(null)}
            disabled={uploading || isLoadingGallery}
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
              {isLoadingGallery ? (
                <ActivityIndicator size="large" color="#8E44AD" />
              ) : (
                <View style={styles.iconContainer}>
                  <FontAwesome name="photo" size={53} color="#8E44AD" />
                </View>
              )}
              <Text style={styles.galleryButtonText}>Pick from Gallery</Text>
            </BlurView>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.dashboardButton,
              pressedButton === 'search' && styles.dashboardButtonPressed
            ]}
            onPress={() => setIsSearchModalVisible(true)}
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

      {/* Camera Modal */}
      <CameraModal
        key={showCameraModal ? 'open' : 'closed'}
        visible={showCameraModal}
        onClose={closeCameraModal}
        cameraRef={cameraRef}
        facing={facing}
        onToggleFacing={toggleCameraFacing}
        cameraMode={cameraMode}
        onSetCameraMode={setCameraMode}
        onShutterPress={handleCameraShutterPress}
        uploading={uploading}
      />

      {/* Search Modal */}
      <Modal
        visible={isSearchModalVisible}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setIsSearchModalVisible(false)}
      >
        <View style={styles.searchModalContainer}>
          {/* Fixed Header Section */}
          <View style={styles.searchFixedHeader}>
            {/* Header */}
            <View style={styles.searchHeader}>
              <TouchableOpacity
                style={styles.closeButton}
                onPress={() => {
                  setIsSearchModalVisible(false);
                  setSearchQuery('');
                  setSearchResults([]);
                }}
              >
                <FontAwesome name="times" size={24} color="white" />
              </TouchableOpacity>
              <Text style={styles.searchTitle}>Search Images</Text>
              <View style={styles.closeButtonPlaceholder} />
            </View>

            {/* Search Bar */}
            <View style={styles.searchBarContainer}>
              <TextInput
                style={styles.searchInput}
                placeholder="Search for images..."
                placeholderTextColor="#999"
                value={searchQuery}
                onChangeText={setSearchQuery}
                onSubmitEditing={() => searchUnsplash(searchQuery)}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity
                style={styles.searchSubmitButton}
                onPress={() => searchUnsplash(searchQuery)}
                disabled={isSearching || !searchQuery.trim()}
              >
                {isSearching ? (
                  <ActivityIndicator size="small" color="white" />
                ) : (
                  <FontAwesome name="search" size={20} color="white" />
                )}
              </TouchableOpacity>
            </View>

            {/* Quick-Pick Chips */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.chipsContainer}
              contentContainerStyle={styles.chipsContent}
            >
              {["Sushi", "Ice Cream Truck", "Trains", "mac and cheese"].map((term) => (
                <TouchableOpacity
                  key={term}
                  style={styles.chip}
                  onPress={() => handleQuickPick(term)}
                >
                  <Text style={styles.chipText}>{term}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>

          {/* Results Area - Takes remaining space */}
          <View style={styles.resultsArea}>
            {isSearching && searchResults.length === 0 ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color="#2e78b7" />
                <Text style={styles.loadingText}>Searching...</Text>
              </View>
            ) : searchResults.length > 0 ? (
              <FlatList
                data={searchResults}
                numColumns={2}
                keyExtractor={(item) => item.id}
                contentContainerStyle={styles.resultsGrid}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={styles.resultItem}
                    onPress={() => handleImageSelect(item.urls.regular || item.urls.small)}
                    activeOpacity={0.8}
                  >
                    <Image
                      source={{ uri: item.urls.small || item.urls.regular }}
                      style={styles.resultImage}
                      contentFit="cover"
                      recyclingKey={item.id}
                      cachePolicy="memory-disk"
                    />
                  </TouchableOpacity>
                )}
              />
            ) : searchQuery.trim() ? (
              <View style={styles.emptyContainer}>
                <FontAwesome name="image" size={48} color="#666" />
                <Text style={styles.emptyText}>No images found for "{searchQuery}"</Text>
                <Text style={styles.emptySubtext}>Try a different search term</Text>
              </View>
            ) : (
              <View style={styles.emptyContainer}>
                <FontAwesome name="search" size={48} color="#666" />
                <Text style={styles.emptyText}>Search for images to get started</Text>
              </View>
            )}
          </View>
        </View>
      </Modal>

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
  topControls: {
    position: 'absolute',
    top: 60,
    left: 20,
    right: 20,
    zIndex: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  closeCameraButton: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    padding: 12,
    borderRadius: 30,
    width: 50,
    height: 50,
    justifyContent: 'center',
    alignItems: 'center',
  },
  flipButton: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    padding: 12,
    borderRadius: 30,
    width: 50,
    height: 50,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flex: 1,
    backgroundColor: 'transparent',
    flexDirection: 'row',
    marginBottom: 60,
    justifyContent: 'center',
    alignItems: 'flex-end',
    gap: 20,
  },
  galleryButtonBase: {
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    padding: 16,
    borderRadius: 50,
    width: 60,
    height: 60,
    justifyContent: 'center',
    alignItems: 'center',
  },
  galleryButton: {
    backgroundColor: 'rgba(46, 120, 183, 0.8)',
  },
  captureButton: {
    backgroundColor: 'rgba(46, 120, 183, 0.8)',
    padding: 20,
    borderRadius: 50,
    borderWidth: 2,
    borderColor: 'white'
  },
  text: {
    fontSize: 18,
    fontWeight: 'bold',
    color: 'white'
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
  // Search Modal Styles
  searchModalContainer: {
    flex: 1,
    backgroundColor: '#1a1a1a',
  },
  searchFixedHeader: {
    backgroundColor: '#1a1a1a',
    zIndex: 10,
  },
  resultsArea: {
    flex: 1,
  },
  searchHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 60,
    paddingBottom: 20,
    paddingHorizontal: 20,
    backgroundColor: '#1a1a1a',
  },
  closeButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeButtonPlaceholder: {
    width: 40,
  },
  searchTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: 'white',
  },
  searchBarContainer: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingBottom: 15,
    gap: 10,
  },
  searchInput: {
    flex: 1,
    backgroundColor: '#333',
    color: 'white',
    paddingHorizontal: 15,
    paddingVertical: 12,
    borderRadius: 8,
    fontSize: 16,
  },
  searchSubmitButton: {
    backgroundColor: '#2e78b7',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 50,
  },
  chipsContainer: {
    marginBottom: 15,
  },
  chipsContent: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    gap: 10,
    alignItems: 'center',
  },
  chip: {
    backgroundColor: '#2e78b7',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    minHeight: 40,
    justifyContent: 'center',
  },
  chipText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '500',
  },
  resultsGrid: {
    padding: 10,
  },
  resultItem: {
    flex: 1,
    margin: 5,
    aspectRatio: 1,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#333',
  },
  resultImage: {
    width: '100%',
    height: '100%',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 15,
  },
  loadingText: {
    color: 'white',
    fontSize: 16,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    color: '#999',
    fontSize: 16,
    marginTop: 15,
    textAlign: 'center',
  },
  emptySubtext: {
    color: '#666',
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
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
  // Video-specific styles
  modeToggleContainer: {
    position: 'absolute',
    top: 100,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 20,
    paddingHorizontal: 20,
    zIndex: 10,
  },
  modeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  modeButtonActive: {
    backgroundColor: 'rgba(46, 120, 183, 0.8)',
    borderColor: '#fff',
  },
  modeText: {
    color: '#999',
    fontSize: 14,
    fontWeight: '600',
  },
  modeTextActive: {
    color: '#fff',
  },
  videoRecordingIndicator: {
    position: 'absolute',
    top: 160,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: 'rgba(255, 0, 0, 0.8)',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 25,
    alignSelf: 'center',
    zIndex: 10,
  },
  recordingDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#fff',
  },
  videoRecordingText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  captureButtonRecording: {
    backgroundColor: '#d32f2f',
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
