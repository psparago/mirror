import { FontAwesome } from '@expo/vector-icons';
import { CameraType, CameraView, useCameraPermissions } from 'expo-camera';
import { File } from 'expo-file-system';
import React, { useRef, useState } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const [photo, setPhoto] = useState<any>(null);
  const [uploading, setUploading] = useState(false);
  const [facing, setFacing] = useState<CameraType>('back');
  const cameraRef = useRef<any>(null);

  if (!permission) return <View />;
  if (!permission.granted) {
    return (
      <View style={styles.container}>
        <Text style={{ textAlign: 'center' }}>We need your permission to show the camera</Text>
        <TouchableOpacity onPress={requestPermission} style={styles.button}>
          <Text style={styles.text}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const toggleCameraFacing = () => {
    setFacing(current => (current === 'back' ? 'front' : 'back'));
  };

  const takeAndUploadPhoto = async () => {
    if (!cameraRef.current) return;

    try {
      setUploading(true);
      
      // 1. Capture the photo
      const picture = await cameraRef.current.takePictureAsync({ quality: 0.5 });
      console.log("Photo captured:", picture.uri);

      // 2. Get the signed URL
      const response = await fetch('https://us-central1-project-mirror-23168.cloudfunctions.net/get-s3-url');
      const { url } = await response.json();
      console.log("Upload URL obtained:", url);
      // Extract the S3 key from the URL for logging
      try {
        const urlObj = new URL(url);
        const s3Key = urlObj.pathname.substring(1); // Remove leading slash
        console.log("Uploading to S3 key:", s3Key);
      } catch (e) {
        console.log("Could not parse URL for logging");
      }

      // 3. Modern Fetch Upload (The "2025" way)
      // We convert the URI to a blob so fetch treats it as a binary file
      const blobResponse = await fetch(picture.uri);
      const blob = await blobResponse.blob();

      const uploadResponse = await fetch(url, {
        method: 'PUT',
        body: blob,
        headers: {
          'Content-Type': 'image/jpeg',
        },
      });

      console.log("S3 Response Status:", uploadResponse.status);

      if (uploadResponse.status === 200) {
        Alert.alert("Success!", "Photo is in S3.");
        setPhoto(null); // Clear preview
        
        // Delete local file after successful upload using new File API
        try {
          const file = new File(picture.uri);
          await file.delete();
          console.log("Local file deleted:", picture.uri);
        } catch (cleanupError) {
          // Don't fail the upload if cleanup fails
          console.warn("Failed to delete local file:", cleanupError);
        }
      } else {
        const errorText = await uploadResponse.text();
        console.error("S3 Error Body:", errorText);
        throw new Error(`S3 returned ${uploadResponse.status}`);
      }
    } catch (error: any) {
      console.error("Full Error:", error);
      Alert.alert("Upload Error", error.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <View style={styles.container}>
      {/* Camera is the base layer */}
      {/* CameraView automatically handles aspect ratio and orientation for iPad/iPhone */}
      <CameraView 
        style={StyleSheet.absoluteFill} 
        ref={cameraRef}
        facing={facing}
      />

      {/* UI is the overlay layer */}
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
          onPress={takeAndUploadPhoto} 
          disabled={uploading}
        >
          <Text style={styles.text}>
            {uploading ? "UPLOADING..." : "SNAP & MIRROR"}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center' },
  camera: { flex: 1 },
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
  button: { backgroundColor: '#2e78b7', padding: 15, borderRadius: 8, marginTop: 20 },
  captureButton: { backgroundColor: 'rgba(255,255,255,0.3)', padding: 20, borderRadius: 50, borderWidth: 2, borderColor: 'white' },
  text: { fontSize: 18, fontWeight: 'bold', color: 'white' },
});