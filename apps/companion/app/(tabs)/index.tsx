import { db } from '@/config/firebase';
import { FontAwesome } from '@expo/vector-icons';
import { API_ENDPOINTS, uploadPhotoToS3 } from '@projectmirror/shared';
import { Audio } from 'expo-av';
import { CameraType, CameraView, useCameraPermissions } from 'expo-camera';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { collection, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import React, { useEffect, useRef, useState } from 'react';
import { Alert, Image, Keyboard, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, TouchableWithoutFeedback, View } from 'react-native';

export default function CompanionHomeScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [photo, setPhoto] = useState<any>(null);
  const [uploading, setUploading] = useState(false);
  const [facing, setFacing] = useState<CameraType>('back');
  const [description, setDescription] = useState('');
  const [showDescriptionInput, setShowDescriptionInput] = useState(false);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [audioUri, setAudioUri] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const cameraRef = useRef<any>(null);
  const textInputRef = useRef<TextInput>(null);

  // Request audio permissions on mount
  useEffect(() => {
    (async () => {
      const { status } = await Audio.requestPermissionsAsync();
      if (status !== 'granted') {
        console.warn('Audio recording permission not granted');
      }
    })();
  }, []);

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

  const pickImageFromGallery = async () => {
    try {
      // Request media library permissions
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'We need access to your photos to select an image.');
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
        // Set the selected image as if it was just taken
        setPhoto({ uri: result.assets[0].uri });
        setShowDescriptionInput(true);
      }
    } catch (error: any) {
      console.error("Image picker error:", error);
      Alert.alert("Error", "Failed to pick image from gallery");
    }
  };

  const takePhoto = async () => {
    if (!cameraRef.current) return;

    try {
      const picture = await cameraRef.current.takePictureAsync({ quality: 0.5 });
      console.log("Photo captured:", picture.uri);
      setPhoto(picture);
      setShowDescriptionInput(true);
    } catch (error: any) {
      console.error("Photo capture error:", error);
      Alert.alert("Error", "Failed to capture photo");
    }
  };

  const startRecording = async () => {
    try {
      // Stop any existing recording
      if (recording) {
        await stopRecording();
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const { recording: newRecording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      setRecording(newRecording);
      setIsRecording(true);
      setAudioUri(null); // Clear previous audio
      setDescription(''); // Clear text description when starting audio
    } catch (error: any) {
      console.error("Failed to start recording:", error);
      Alert.alert("Error", "Failed to start audio recording");
    }
  };

  const stopRecording = async () => {
    if (!recording) return;

    try {
      setIsRecording(false);
      await recording.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
      });
      const uri = recording.getURI();
      setAudioUri(uri || null);
      setRecording(null);
      console.log("Recording stopped and stored at", uri);
    } catch (error: any) {
      console.error("Failed to stop recording:", error);
      Alert.alert("Error", "Failed to stop audio recording");
    }
  };

  const uploadEventBundle = async () => {
    if (!photo) return;
    
    // Require either text description OR audio recording
    if (!description.trim() && !audioUri) {
      Alert.alert("Description Required", "Please add a text description or record an audio message before sending.");
      return;
    }

    try {
      setUploading(true);
      
      // Generate unique event_id (timestamp-based)
      const eventID = Date.now().toString();
      const timestamp = new Date().toISOString();

      // 1. Upload image.jpg
      const imageResponse = await fetch(`${API_ENDPOINTS.GET_S3_URL}?path=to&event_id=${eventID}&filename=image.jpg`);
      const { url: imageUrl } = await imageResponse.json();
      console.log("Image upload URL obtained:", imageUrl);

      const imageUploadResponse = await uploadPhotoToS3(photo.uri, imageUrl);
      if (imageUploadResponse.status !== 200) {
        throw new Error(`Image upload failed: ${imageUploadResponse.status}`);
      }
      console.log("Image uploaded successfully");

      // 2. Upload audio if available
      let audioUrl: string | undefined;
      if (audioUri) {
        const audioResponse = await fetch(`${API_ENDPOINTS.GET_S3_URL}?path=to&event_id=${eventID}&filename=audio.m4a`);
        const { url: audioUploadUrl } = await audioResponse.json();
        console.log("Audio upload URL obtained:", audioUploadUrl);

        // Read audio file as blob and upload
        const audioFileResponse = await fetch(audioUri);
        const audioBlob = await audioFileResponse.blob();
        
        const audioUploadResponse = await fetch(audioUploadUrl, {
          method: 'PUT',
          body: audioBlob,
          headers: {
            'Content-Type': 'audio/m4a',
          },
        });

        if (audioUploadResponse.status !== 200) {
          throw new Error(`Audio upload failed: ${audioUploadResponse.status}`);
        }
        console.log("Audio uploaded successfully");
      }

      // 3. Create metadata.json
      // Note: We don't store audio_url in metadata because presigned URLs expire (15 min)
      // The backend ListMirrorEvents generates fresh presigned GET URLs when listing events
      const metadata = {
        description: description.trim() || (audioUri ? "Voice message" : ""),
        sender: "Granddad",
        timestamp: timestamp,
        event_id: eventID,
        // Only store content_type to indicate if audio exists - backend will provide fresh presigned URL
        content_type: audioUri ? 'audio' as const : 'text' as const,
      };

      // 3. Upload metadata.json
      const metadataResponse = await fetch(`${API_ENDPOINTS.GET_S3_URL}?path=to&event_id=${eventID}&filename=metadata.json`);
      const { url: metadataUrl } = await metadataResponse.json();
      console.log("Metadata upload URL obtained:", metadataUrl);

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
      console.log("Metadata uploaded successfully");

      // 4. Cleanup UI first (don't wait for Firestore)
      Alert.alert("Success!", "Photo and description sent to Cole!");
      setPhoto(null);
      setDescription('');
      setShowDescriptionInput(false);
      setAudioUri(null);
      if (recording) {
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
          console.log("Firestore signal written successfully");
        })
        .catch((firestoreError: any) => {
          // Log error but don't block the user
          console.error("Failed to write Firestore signal:", firestoreError);
          console.error("Firestore error code:", firestoreError?.code);
          console.error("Firestore error message:", firestoreError?.message);
          console.error("Full error:", JSON.stringify(firestoreError, null, 2));
        });

      // Delete local file
      try {
        const file = new File(photo.uri);
        await file.delete();
        console.log("Local file deleted:", photo.uri);
      } catch (cleanupError) {
        console.warn("Failed to delete local file:", cleanupError);
      }
    } catch (error: any) {
      console.error("Full Error:", error);
      Alert.alert("Upload Error", error.message);
    } finally {
      setUploading(false);
    }
  };

  const cancelPhoto = () => {
    setPhoto(null);
    setDescription('');
    setShowDescriptionInput(false);
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
            <View style={styles.previewImageContainer}>
              <Image
                source={{ uri: photo.uri }}
                style={styles.previewImage}
                resizeMode="contain"
              />
            </View>
            
            <View style={styles.descriptionContainer}>
              <Text style={styles.descriptionLabel}>Add a description:</Text>
              <View style={styles.inputRow}>
                <TextInput
                  ref={textInputRef}
                  style={styles.descriptionInput}
                  placeholder="e.g., Look at this blue truck! (or record audio below)"
                  placeholderTextColor="#999"
                  value={description}
                  onChangeText={setDescription}
                  multiline
                  autoFocus={!audioUri}
                  spellCheck={true}
                  returnKeyType="done"
                  blurOnSubmit={true}
                  onSubmitEditing={Keyboard.dismiss}
                  editable={!isRecording && !audioUri}
                />
                <TouchableOpacity 
                  style={styles.micButton}
                  onPress={() => {
                    // Focus the TextInput to show keyboard with microphone button
                    textInputRef.current?.focus();
                  }}
                  activeOpacity={0.7}
                >
                  <FontAwesome name="keyboard-o" size={20} color="#2e78b7" />
                </TouchableOpacity>
              </View>
              
              {/* Audio Recording Section */}
              <View style={styles.audioSection}>
                {!audioUri && !isRecording && (
                  <TouchableOpacity 
                    style={styles.recordButton}
                    onPress={startRecording}
                    disabled={uploading}
                  >
                    <FontAwesome name="microphone" size={24} color="#fff" />
                    <Text style={styles.recordButtonText}>Record Voice</Text>
                  </TouchableOpacity>
                )}
                
                {isRecording && (
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
                )}
                
                {audioUri && !isRecording && (
                  <View style={styles.audioPlaybackContainer}>
                    <FontAwesome name="volume-up" size={20} color="#2e78b7" />
                    <Text style={styles.audioPlaybackText}>Voice message recorded</Text>
                    <TouchableOpacity 
                      style={styles.rerecordButton}
                      onPress={() => {
                        setAudioUri(null);
                        setDescription('');
                      }}
                    >
                      <Text style={styles.rerecordButtonText}>Re-record</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
              
              <TouchableOpacity 
                style={styles.dismissKeyboardButton}
                onPress={Keyboard.dismiss}
              >
                <Text style={styles.dismissKeyboardText}>Tap here to dismiss keyboard</Text>
              </TouchableOpacity>
            </View>

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
                onPress={uploadEventBundle}
                disabled={uploading || (!description.trim() && !audioUri)}
              >
                <Text style={styles.actionButtonText}>
                  {uploading ? "SENDING..." : "SEND TO COLE"}
                </Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>
    );
  }

  // Camera view
  return (
    <View style={styles.container}>
      <CameraView 
        style={StyleSheet.absoluteFill} 
        ref={cameraRef}
        facing={facing}
      />

      <View style={styles.topControls}>
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
          style={[styles.galleryButtonBase, styles.galleryButton]} 
          onPress={pickImageFromGallery}
          disabled={uploading}
        >
          <FontAwesome name="photo" size={24} color="white" />
        </TouchableOpacity>
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
  );
}

const styles = StyleSheet.create({
  container: { 
    flex: 1, 
    justifyContent: 'center' 
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
    right: 20,
    zIndex: 1,
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
    padding: 18,
    borderRadius: 10,
    alignItems: 'center',
  },
  cancelButton: {
    backgroundColor: '#666',
  },
  sendButton: {
    backgroundColor: '#2e78b7',
  },
  actionButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
});
