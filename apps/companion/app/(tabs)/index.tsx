import { db } from '@/config/firebase';
import { FontAwesome } from '@expo/vector-icons';
import { API_ENDPOINTS, uploadPhotoToS3 } from '@projectmirror/shared';
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import { BlurView } from 'expo-blur';
import { CameraType, CameraView, useCameraPermissions } from 'expo-camera';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { collection, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Keyboard, KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, TouchableWithoutFeedback, View } from 'react-native';

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
  const [stagingEventId, setStagingEventId] = useState<string | null>(null);
  const [intent, setIntent] = useState<'none' | 'voice' | 'ai' | 'note'>('none');
  const [showCameraModal, setShowCameraModal] = useState(false);
  const [pressedButton, setPressedButton] = useState<string | null>(null);
  const cameraRef = useRef<any>(null);
  const textInputRef = useRef<TextInput>(null);
  const lastProcessedUriRef = useRef<string | null>(null);

  // Request audio permissions on mount
  useEffect(() => {
    (async () => {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        console.warn('Audio recording permission not granted');
      }
    })();
  }, []);

  // Simple: only update audioUri if we have a NEW URI and we're not recording
  // This prevents stale URIs from being set when selecting new photos
  useEffect(() => {
    const currentUri = audioRecorder.uri;
    const isNewUri = currentUri && currentUri !== lastProcessedUriRef.current;
    
    // Only set audioUri if we have a NEW URI, we're not recording, and audioUri is currently null
    // Don't include audioUri in dependencies to prevent infinite loops
    if (isNewUri && !audioRecorder.isRecording) {
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

  const getAIDescription = async (imageUrl: string) => {
    try {
      setIsAiThinking(true);
      setIsAiGenerated(false);
      
      const response = await fetch(
        `${API_ENDPOINTS.AI_DESCRIPTION}?image_url=${encodeURIComponent(imageUrl)}`
      );
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`AI description failed: ${response.status} - ${errorText}`);
        throw new Error(`AI description failed: ${response.status} - ${errorText}`);
      }
      
      const aiDescription = await response.text();
      
      if (aiDescription && aiDescription.trim()) {
        setDescription(aiDescription.trim());
        setIsAiGenerated(true);
      }
    } catch (error: any) {
      console.error("Error getting AI description:", error);
      // Don't show error to user - just let them type manually
    } finally {
      setIsAiThinking(false);
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
    setPhoto({ uri: imageUrl });
    setIsSearchModalVisible(false);
    setShowDescriptionInput(true);
    setSearchQuery('');
    setDescription(''); // Clear previous description
    setIsAiGenerated(false);
    setIntent('none'); // Reset intent - show action buttons
    setAudioUri(null); // Clear any previous audio
    setStagingEventId(null); // Don't upload to staging until user chooses intent
    setSearchResults([]);
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

      // Launch image picker
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: 'images', // Using string format as MediaTypeOptions is deprecated
        allowsEditing: true,
        aspect: [4, 3],
        quality: 0.5,
      });

      if (!result.canceled && result.assets[0]) {
        setIsLoadingImage(true);
        // Set the selected image as if it was just taken
        setPhoto({ uri: result.assets[0].uri });
        setShowDescriptionInput(true);
        // Clear any previous audio recording when selecting a new photo
        setAudioUri(null);
        setDescription('');
        setIsAiGenerated(false);
        
        setIntent('none'); // Reset intent - show action buttons
        setAudioUri(null); // Clear any previous audio
        setStagingEventId(null); // Don't upload to staging until user chooses intent
        
        // Reset the last processed URI to prevent stale URIs from being set
        lastProcessedUriRef.current = null;
        
        // Small delay to ensure image loads
        setTimeout(() => setIsLoadingImage(false), 300);
      }
      setIsLoadingGallery(false);
    } catch (error: any) {
      console.error("Image picker error:", error);
      Alert.alert("Error", "Failed to pick image from gallery");
      setIsLoadingGallery(false);
      setIsLoadingImage(false);
    }
  };

  const takePhoto = async () => {
    if (!cameraRef.current) return;

    try {
      const picture = await cameraRef.current.takePictureAsync({ quality: 0.5 });
      setPhoto(picture);
      setShowDescriptionInput(true);
      setShowCameraModal(false); // Close camera modal after taking photo
      // Clear any previous audio recording when taking a new photo
      setAudioUri(null);
      setDescription('');
      setIsAiGenerated(false);
      
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
      await setAudioModeAsync({
        allowsRecording: false,
      });
      
      // Wait a bit for URI to be available, then set it directly
      // The useEffect will also catch it, but setting it here ensures it happens
      setTimeout(() => {
        if (audioRecorder.uri && audioRecorder.uri !== lastProcessedUriRef.current) {
          setAudioUri(audioRecorder.uri);
          lastProcessedUriRef.current = audioRecorder.uri;
        }
      }, 150);
    } catch (error: any) {
      console.error("Failed to stop recording:", error);
      Alert.alert("Error", "Failed to stop audio recording");
    }
  };

  const uploadEventBundle = async () => {
    if (!photo) return;
    
    // Require either text description OR audio recording
    if (!description.trim() && !audioUri) {
      Alert.alert("Description Required", "Please add a text description or record an audio message before sending this Reflection.");
      return;
    }

    try {
      setUploading(true);
      
      // Generate unique event_id (timestamp-based)
      const eventID = Date.now().toString();
      const timestamp = new Date().toISOString();

      // 1. Upload image.jpg to final location
      const imageResponse = await fetch(`${API_ENDPOINTS.GET_S3_URL}?path=to&event_id=${eventID}&filename=image.jpg`);
      const { url: imageUrl } = await imageResponse.json();

      // Upload image to final location
      // If staging exists (user triggered AI), copy from staging. Otherwise upload directly.
      if (stagingEventId) {
        // Copy from staging to final location
        const stagingGetResponse = await fetch(`${API_ENDPOINTS.GET_S3_URL}?path=staging&event_id=${stagingEventId}&filename=image.jpg&method=GET`);
        if (stagingGetResponse.ok) {
          const { url: stagingImageUrl } = await stagingGetResponse.json();
          // Download staging image and upload to final location
          const stagingImageBlob = await fetch(stagingImageUrl).then(r => r.blob());
          const imageUploadResponse = await fetch(imageUrl, {
            method: 'PUT',
            body: stagingImageBlob,
            headers: { 'Content-Type': 'image/jpeg' },
          });
          if (imageUploadResponse.status !== 200) {
            throw new Error(`Image upload failed: ${imageUploadResponse.status}`);
          }
        } else {
          // Fallback to original upload if staging fetch fails
          const imageUploadResponse = await uploadPhotoToS3(photo.uri, imageUrl);
          if (imageUploadResponse.status !== 200) {
            throw new Error(`Image upload failed: ${imageUploadResponse.status}`);
          }
        }
      } else {
        // No staging - upload directly (user chose voice or note without AI)
        const imageUploadResponse = await uploadPhotoToS3(photo.uri, imageUrl);
        if (imageUploadResponse.status !== 200) {
          throw new Error(`Image upload failed: ${imageUploadResponse.status}`);
        }
      }

      // Clean up staging image after successful upload to final location
      if (stagingEventId) {
        try {
          await fetch(`${API_ENDPOINTS.DELETE_MIRROR_EVENT}?event_id=${stagingEventId}&path=staging`);
        } catch (error: any) {
          console.error("Error deleting staging image:", error);
          // Continue anyway - staging cleanup is not critical
        }
      }

      // 2. Upload audio if available
      let audioUrl: string | undefined;
      let audioUploaded = false;
      if (audioUri) {
        // Check if audio file exists before attempting upload
        try {
          const fileInfo = await FileSystem.getInfoAsync(audioUri);
          if (!fileInfo.exists) {
            // File doesn't exist - silently clear audioUri and continue without audio
            setAudioUri(null);
          } else {
            // File exists - proceed with upload
            const audioResponse = await fetch(`${API_ENDPOINTS.GET_S3_URL}?path=to&event_id=${eventID}&filename=audio.m4a`);
            const { url: audioUploadUrl } = await audioResponse.json();
            // Upload audio file directly using FileSystem.uploadAsync
            
            // FileSystem.uploadAsync defaults to binary upload, so we don't need to specify uploadType
            const audioUploadResponse = await FileSystem.uploadAsync(audioUploadUrl, audioUri, {
              httpMethod: 'PUT',
              headers: {
                'Content-Type': 'audio/m4a',
              },
            });

            if (audioUploadResponse.status !== 200) {
              throw new Error(`Audio upload failed: ${audioUploadResponse.status}`);
            }
            audioUploaded = true;
          }
        } catch (error: any) {
          // Only log actual errors (not missing files)
          if (error.message && !error.message.includes('does not exist')) {
            console.error("Error uploading audio file:", error);
          }
          // Clear audioUri and continue without audio
          setAudioUri(null);
          // Don't throw - allow upload to continue without audio
        }
      }

      // 3. Create metadata.json
      // Note: We don't store audio_url in metadata because presigned URLs expire (15 min)
      // The backend ListMirrorEvents generates fresh presigned GET URLs when listing events
      const metadata = {
        description: description.trim() || (audioUploaded ? "Voice message" : ""),
        sender: "Granddad",
        timestamp: timestamp,
        event_id: eventID,
        // Only store content_type to indicate if audio exists - backend will provide fresh presigned URL
        content_type: audioUploaded ? 'audio' as const : 'text' as const,
      };

      // 3. Upload metadata.json
      const metadataResponse = await fetch(`${API_ENDPOINTS.GET_S3_URL}?path=to&event_id=${eventID}&filename=metadata.json`);
      const { url: metadataUrl } = await metadataResponse.json();

      // Convert metadata to blob
      const metadataBlob = new Blob([JSON.stringify(metadata, null, 2)], { type: 'application/json' });
      const metadataUploadResponse = await fetch(metadataUrl, {
        method: 'PUT',
        body: metadataBlob,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (metadataUploadResponse.status !== 200) {
        throw new Error(`Metadata upload failed: ${metadataUploadResponse.status}`);
      }

      // 4. Cleanup UI first (don't wait for Firestore)
      Alert.alert("Success!", "Reflection sent!");
      setPhoto(null);
      setDescription('');
      setShowDescriptionInput(false);
      setIsAiGenerated(false);
      setStagingEventId(null);
      setAudioUri(null);
      if (audioRecorder.isRecording) {
        await stopRecording();
      }

      // 5. Write signal to Firestore in background (non-blocking)
      // This won't block the UI even if Firestore fails
      setDoc(doc(collection(db, 'signals'), eventID), {
        event_id: eventID,
        sender: "Granddad",
        status: "ready",
        timestamp: serverTimestamp(),
        type: "mirror_event",
      })
        .then(() => {
        })
        .catch((firestoreError: any) => {
          // Log error but don't block the user
          console.error("Failed to write Firestore signal:", firestoreError);
          console.error("Firestore error code:", firestoreError?.code);
          console.error("Firestore error message:", firestoreError?.message);
          console.error("Full error:", JSON.stringify(firestoreError, null, 2));
        });

      // Delete local file (only if it's a local file, not a remote URL)
      if (photo.uri && !photo.uri.startsWith('http://') && !photo.uri.startsWith('https://')) {
        try {
          // Use FileSystem.deleteAsync to delete the local file
          await FileSystem.deleteAsync(photo.uri, { idempotent: true });
        } catch (cleanupError) {
          console.warn("Failed to delete local file:", cleanupError);
        }
      }
    } catch (error: any) {
      console.error("Full Error:", error);
      Alert.alert("Upload Error", error.message);
    } finally {
      setUploading(false);
    }
  };

  const cancelPhoto = async () => {
    // Clean up staging image if it exists
    if (stagingEventId) {
      try {
        await fetch(`${API_ENDPOINTS.DELETE_MIRROR_EVENT}?event_id=${stagingEventId}&path=staging`);
      } catch (error: any) {
        console.error("Error deleting staging image:", error);
        // Continue with cleanup anyway
      }
    }
    
    setPhoto(null);
    setDescription('');
    setShowDescriptionInput(false);
    setIsAiGenerated(false);
    setIsAiThinking(false);
    setStagingEventId(null);
    setIntent('none');
    setAudioUri(null);
  };

  const retakePhoto = async () => {
    // Clean up staging image
    if (stagingEventId) {
      try {
        await fetch(`${API_ENDPOINTS.DELETE_MIRROR_EVENT}?event_id=${stagingEventId}&path=staging`);
      } catch (error: any) {
        console.error("Error deleting staging image:", error);
      }
    }
    
    // Clear all state and return to camera
    setPhoto(null);
    setDescription('');
    setShowDescriptionInput(false);
    setIsAiGenerated(false);
    setIsAiThinking(false);
    setStagingEventId(null);
    setIntent('none');
    setAudioUri(null);
    lastProcessedUriRef.current = null;
  };

  const triggerAI = async () => {
    if (!photo) return;
    
    setIntent('ai');
    setIsAiThinking(true);
    setIsAiGenerated(false);
    
    try {
      // Generate staging event_id and upload image if not already uploaded
      let stagingId = stagingEventId;
      if (!stagingId) {
        stagingId = Date.now().toString();
        setStagingEventId(stagingId);
        
        // Upload to staging first
        const stagingResponse = await fetch(`${API_ENDPOINTS.GET_S3_URL}?path=staging&event_id=${stagingId}&filename=image.jpg`);
        const { url: stagingUrl } = await stagingResponse.json();
        await uploadPhotoToS3(photo.uri, stagingUrl);
      }
      
      // Get presigned GET URL for staging image
      const getStagingUrlResponse = await fetch(`${API_ENDPOINTS.GET_S3_URL}?path=staging&event_id=${stagingId}&filename=image.jpg&method=GET`);
      if (getStagingUrlResponse.ok) {
        const { url: getStagingUrl } = await getStagingUrlResponse.json();
        await getAIDescription(getStagingUrl);
      }
    } catch (error: any) {
      console.error("Error uploading to staging or getting AI description:", error);
      setIsAiThinking(false);
    }
  };

  const changeMethod = () => {
    // Clear description and audio, return to action buttons
    setDescription('');
    setAudioUri(null);
    setIntent('none');
    setIsAiGenerated(false);
    setIsAiThinking(false);
    lastProcessedUriRef.current = null;
  };

  // Show description input overlay if photo is captured
  if (showDescriptionInput && photo) {
    return (
      <KeyboardAvoidingView 
        style={styles.container} 
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
      >
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <ScrollView 
            contentContainerStyle={styles.previewContainer}
            keyboardShouldPersistTaps="handled"
          >
            {/* Title */}
            <Text style={styles.creationTitle}>Reflection Station</Text>
            
            {/* Image Preview with Retake Button */}
            <View style={styles.previewImageContainer}>
              {isLoadingImage ? (
                <View style={styles.loadingContainer}>
                  <ActivityIndicator size="large" color="#2e78b7" />
                </View>
              ) : (
                <>
                  <Image
                    source={{ uri: photo.uri }}
                    style={styles.previewImage}
                    resizeMode="contain"
                  />
                  <View style={styles.imageTopButtons}>
                    {intent !== 'none' && (
                      <TouchableOpacity 
                        style={styles.backToActionsButton}
                        onPress={changeMethod}
                      >
                        <FontAwesome name="arrow-left" size={16} color="#fff" />
                        <Text style={styles.backToActionsButtonText}>Back</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity 
                      style={styles.retakeButton}
                      onPress={retakePhoto}
                    >
                      <FontAwesome name="times" size={20} color="#fff" />
                      <Text style={styles.retakeButtonText}>Retake</Text>
                    </TouchableOpacity>
                  </View>
                </>
              )}
            </View>

            {/* Action Buttons - Show when intent is 'none' */}
            {intent === 'none' && (
              <View style={styles.actionButtonsContainer}>
                <TouchableOpacity 
                  style={styles.intentButton}
                  onPress={() => {
                    setIntent('voice');
                  }}
                  disabled={uploading}
                  activeOpacity={0.8}
                >
                  <BlurView intensity={30} tint="light" style={styles.intentButtonBlur}>
                    <FontAwesome name="microphone" size={32} color="#2C3E50" />
                    <Text style={styles.intentButtonText}>🎤 Add My Voice</Text>
                  </BlurView>
                </TouchableOpacity>

                <TouchableOpacity 
                  style={styles.intentButton}
                  onPress={triggerAI}
                  disabled={uploading || isAiThinking}
                  activeOpacity={0.8}
                >
                  <BlurView intensity={30} tint="light" style={styles.intentButtonBlur}>
                    <FontAwesome name="magic" size={32} color="#2C3E50" />
                    <Text style={styles.intentButtonText}>✨ Ask AI to Describe</Text>
                  </BlurView>
                </TouchableOpacity>

                <TouchableOpacity 
                  style={styles.intentButton}
                  onPress={() => {
                    setIntent('note');
                    setTimeout(() => textInputRef.current?.focus(), 100);
                  }}
                  disabled={uploading}
                  activeOpacity={0.8}
                >
                  <BlurView intensity={30} tint="light" style={styles.intentButtonBlur}>
                    <FontAwesome name="keyboard-o" size={32} color="#2C3E50" />
                    <Text style={styles.intentButtonText}>⌨️ Write a Note</Text>
                  </BlurView>
                </TouchableOpacity>
              </View>
            )}

            {/* Voice Intent - Dominated by Mic */}
            {intent === 'voice' && (
              <View style={styles.voiceIntentContainer}>
                {audioRecorder.isRecording ? (
                  <View style={styles.recordingContainer}>
                    <View style={styles.recordingIndicator} />
                    <Text style={styles.recordingText}>Recording...</Text>
                    <TouchableOpacity 
                      style={styles.stopButton}
                      onPress={stopRecording}
                    >
                      <Text style={styles.stopButtonText}>Stop</Text>
                    </TouchableOpacity>
                  </View>
                ) : audioUri ? (
                  <View style={styles.audioPlaybackContainer}>
                    <FontAwesome name="volume-up" size={40} color="#2e78b7" />
                    <Text style={styles.audioPlaybackText}>Voice message recorded</Text>
                    <TouchableOpacity 
                      style={styles.rerecordButton}
                      onPress={() => {
                        setAudioUri(null);
                        lastProcessedUriRef.current = null;
                      }}
                    >
                      <Text style={styles.rerecordButtonText}>Re-record</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity 
                    style={styles.recordButtonLarge}
                    onPress={startRecording}
                    disabled={uploading || isStartingRecording}
                  >
                    <FontAwesome name="microphone" size={48} color="#fff" />
                    <Text style={styles.recordButtonTextLarge}>
                      {isStartingRecording ? "Starting..." : "Tap to Record"}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {/* AI or Note Intent - Dominated by Text Input */}
            {(intent === 'ai' || intent === 'note') && (
              <View style={styles.textIntentContainer}>
                <View style={styles.inputRow}>
                  <TextInput
                    ref={textInputRef}
                    style={styles.descriptionInputLarge}
                    placeholder={isAiThinking ? "✨ Gemini is thinking..." : "Write your description here..."}
                    placeholderTextColor="#999"
                    value={description}
                    onChangeText={(text) => {
                      setDescription(text);
                      // If user edits, mark as not AI-generated
                      if (text !== description && isAiGenerated) {
                        setIsAiGenerated(false);
                      }
                    }}
                    multiline
                    autoFocus={!isAiThinking}
                    spellCheck={true}
                    returnKeyType="done"
                    blurOnSubmit={true}
                    onSubmitEditing={Keyboard.dismiss}
                    editable={!isAiThinking}
                  />
                </View>
                
                {isAiThinking && (
                  <View style={styles.aiIndicator}>
                    <ActivityIndicator size="small" color="#9b59b6" style={{ marginRight: 6 }} />
                    <Text style={styles.aiIndicatorText}>✨ Gemini is thinking...</Text>
                  </View>
                )}
                
                {isAiGenerated && !isAiThinking && (
                  <View style={styles.aiIndicator}>
                    <Text style={styles.aiIndicatorText}>✨ Generated by AI</Text>
                  </View>
                )}
                
                {/* Dismiss Keyboard */}
                <TouchableOpacity 
                  style={styles.dismissKeyboardButton}
                  onPress={Keyboard.dismiss}
                >
                  <Text style={styles.dismissKeyboardText}>Tap here to dismiss keyboard</Text>
                </TouchableOpacity>
              </View>
            )}

            <View style={styles.actionButtons}>
              <TouchableOpacity 
                style={[styles.actionButton, styles.cancelButton]} 
                onPress={cancelPhoto}
                disabled={uploading}
              >
                <Text style={styles.actionButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.actionButton, styles.sendButton]} 
                onPress={() => {
                  if (!uploading && (description.trim() || audioUri)) {
                    uploadEventBundle();
                  } else {
                    Alert.alert("Description Required", "Please add a text description or record an audio message before sending this Reflection.");
                  }
                }}
                disabled={uploading}
              >
                <Text style={styles.actionButtonText}>
                  {uploading ? "SENDING..." : "SEND REFLECTION"}
                </Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>
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
        
        <View style={styles.dashboardButtons}>
          <TouchableOpacity 
            style={[
              styles.dashboardButton,
              pressedButton === 'capture' && styles.dashboardButtonPressed
            ]}
            onPress={() => setShowCameraModal(true)}
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
              <Text style={styles.captureButtonText}>Capture Photo</Text>
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
      <Modal
        visible={showCameraModal}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setShowCameraModal(false)}
      >
        <View style={styles.container}>
          <CameraView 
            style={StyleSheet.absoluteFill} 
            ref={cameraRef}
            facing={facing}
          />

          <View style={styles.topControls}>
            <TouchableOpacity 
              style={styles.closeCameraButton}
              onPress={() => setShowCameraModal(false)}
            >
              <FontAwesome name="times" size={24} color="white" />
            </TouchableOpacity>
            <TouchableOpacity 
              style={styles.flipButton} 
              onPress={toggleCameraFacing}
              disabled={uploading}
            >
              <FontAwesome name="refresh" size={24} color="white" />
            </TouchableOpacity>
          </View>

          <View style={styles.buttonContainer}>
            <TouchableOpacity 
              style={styles.captureButton} 
              onPress={takePhoto}
              disabled={uploading}
            >
              <Text style={styles.text}>
                {uploading ? "UPLOADING..." : "TAKE PHOTO"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

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
                      resizeMode="cover"
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
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
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
  descriptionContainer: {
    marginBottom: 20,
  },
  descriptionLabel: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 10,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  descriptionInput: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 15,
    fontSize: 16,
    minHeight: 100,
    textAlignVertical: 'top',
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
  dismissKeyboardButton: {
    marginTop: 8,
    padding: 8,
    alignItems: 'center',
  },
  dismissKeyboardText: {
    color: '#999',
    fontSize: 12,
    fontStyle: 'italic',
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
  cancelButton: {
    backgroundColor: '#666',
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
  retakeButton: {
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  retakeButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  actionButtonsContainer: {
    padding: 20,
    gap: 28,
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
  descriptionInputLarge: {
    backgroundColor: '#333',
    color: '#fff',
    padding: 16,
    borderRadius: 12,
    fontSize: 18,
    minHeight: 200,
    textAlignVertical: 'top',
    borderWidth: 2,
    borderColor: '#2e78b7',
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
});
