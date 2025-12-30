import { FontAwesome } from '@expo/vector-icons';
import { CameraType, CameraView, useCameraPermissions } from 'expo-camera';
import { File } from 'expo-file-system';
import React, { useRef, useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, TouchableOpacity, View, KeyboardAvoidingView, Platform, Image, TouchableWithoutFeedback, Keyboard, ScrollView } from 'react-native';
import { API_ENDPOINTS, uploadPhotoToS3 } from '@projectmirror/shared';

export default function CompanionHomeScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [photo, setPhoto] = useState<any>(null);
  const [uploading, setUploading] = useState(false);
  const [facing, setFacing] = useState<CameraType>('back');
  const [description, setDescription] = useState('');
  const [showDescriptionInput, setShowDescriptionInput] = useState(false);
  const cameraRef = useRef<any>(null);

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

  const uploadEventBundle = async () => {
    if (!photo) return;
    if (!description.trim()) {
      Alert.alert("Description Required", "Please add a description before sending.");
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

      // 2. Create metadata.json
      const metadata = {
        description: description.trim(),
        sender: "Granddad",
        timestamp: timestamp,
        event_id: eventID,
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

      // 4. Cleanup
      Alert.alert("Success!", "Photo and description sent to Cole!");
      setPhoto(null);
      setDescription('');
      setShowDescriptionInput(false);

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
              <TextInput
                style={styles.descriptionInput}
                placeholder="e.g., Look at this blue truck!"
                placeholderTextColor="#999"
                value={description}
                onChangeText={setDescription}
                multiline
                autoFocus
                returnKeyType="done"
                blurOnSubmit={true}
                onSubmitEditing={Keyboard.dismiss}
              />
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
                disabled={uploading || !description.trim()}
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
    alignItems: 'flex-end' 
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
  descriptionInput: {
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 15,
    fontSize: 16,
    minHeight: 100,
    textAlignVertical: 'top',
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
