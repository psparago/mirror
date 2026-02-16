import { useReflectionMedia } from '@/context/ReflectionMediaContext';
import { prepareImageForUpload, prepareVideoForUpload } from '@/utils/mediaProcessor';
import { FontAwesome } from '@expo/vector-icons';
import { CameraType, CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import React, { useRef, useState } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

const MAX_VIDEO_DURATION_SECONDS = 60;
const MAX_VIDEO_DURATION_MS = MAX_VIDEO_DURATION_SECONDS * 1000;

export default function CameraScreen() {
  const router = useRouter();
  const { setPendingMedia } = useReflectionMedia();
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<CameraType>('front');
  const [cameraMode, setCameraMode] = useState<'photo' | 'video'>('photo');
  const [capturing, setCapturing] = useState(false);
  const cameraRef = useRef<CameraView>(null);

  const toggleCameraFacing = () => {
    setFacing(current => (current === 'back' ? 'front' : 'back'));
  };

  const takePhoto = async () => {
    if (!cameraRef.current || capturing) return;
    try {
      setCapturing(true);
      const picture = await cameraRef.current.takePictureAsync({ quality: 0.5 });
      if (!picture) return;
      const optimizedUri = await prepareImageForUpload(picture.uri);
      setPendingMedia({ uri: optimizedUri, type: 'photo', source: 'camera' });
      router.back();
    } catch (error: any) {
      console.error('Photo capture error:', error);
      Alert.alert('Error', 'Failed to capture photo');
    } finally {
      setCapturing(false);
    }
  };

  const recordVideo = async () => {
    try {
      setCapturing(true);
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Videos,
        allowsEditing: false,
        quality: 0.8,
        videoMaxDuration: MAX_VIDEO_DURATION_SECONDS,
        cameraType: ImagePicker.CameraType.front,
      });

      if (!result.canceled && result.assets?.length) {
        const video = result.assets[0];
        if (video.duration && video.duration > MAX_VIDEO_DURATION_MS) {
          Alert.alert('Video Too Long', `Please record a video that's ${MAX_VIDEO_DURATION_SECONDS} seconds or less.`);
          return;
        }
        const compressedUri = await prepareVideoForUpload(video.uri);
        setPendingMedia({ uri: compressedUri, type: 'video', source: 'camera' });
        router.back();
      }
    } catch (error: any) {
      console.error('Video recording error:', error);
      Alert.alert('Error', `Failed to record video: ${error.message || 'Unknown error'}`);
    } finally {
      setCapturing(false);
    }
  };

  const handleShutterPress = () => {
    if (cameraMode === 'photo') {
      takePhoto();
    } else {
      recordVideo();
    }
  };

  if (!permission) return <View style={styles.container} />;

  if (!permission.granted) {
    return (
      <View style={styles.permissionContainer}>
        <Text style={styles.permissionText}>We need your permission to use the camera</Text>
        <TouchableOpacity onPress={requestPermission} style={styles.permissionButton}>
          <Text style={styles.permissionButtonText}>Grant Permission</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => router.back()} style={[styles.permissionButton, { marginTop: 12, backgroundColor: '#555' }]}>
          <Text style={styles.permissionButtonText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        key={facing}
        style={StyleSheet.absoluteFill}
        ref={cameraRef}
        facing={facing}
      />

      <View style={styles.topControls}>
        <TouchableOpacity style={styles.controlButton} onPress={() => router.back()}>
          <FontAwesome name="times" size={24} color="white" />
        </TouchableOpacity>
        <TouchableOpacity style={styles.controlButton} onPress={toggleCameraFacing} disabled={capturing}>
          <FontAwesome name="refresh" size={24} color="white" />
        </TouchableOpacity>
      </View>

      <View style={styles.modeToggleContainer}>
        <TouchableOpacity
          style={[styles.modeButton, cameraMode === 'photo' && styles.modeButtonActive]}
          onPress={() => setCameraMode('photo')}
        >
          <FontAwesome name="camera" size={20} color={cameraMode === 'photo' ? '#fff' : '#999'} />
          <Text style={[styles.modeText, cameraMode === 'photo' && styles.modeTextActive]}>Photo</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.modeButton, cameraMode === 'video' && styles.modeButtonActive]}
          onPress={() => setCameraMode('video')}
        >
          <FontAwesome name="video-camera" size={20} color={cameraMode === 'video' ? '#fff' : '#999'} />
          <Text style={[styles.modeText, cameraMode === 'video' && styles.modeTextActive]}>Video</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.buttonContainer}>
        <TouchableOpacity style={styles.captureButton} onPress={handleShutterPress} disabled={capturing}>
          <Text style={styles.captureText}>
            {capturing ? 'CAPTURING...' : cameraMode === 'video' ? 'RECORD VIDEO' : 'TAKE PHOTO'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    backgroundColor: '#000',
  },
  permissionContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000',
    padding: 20,
  },
  permissionText: {
    color: '#fff',
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 20,
  },
  permissionButton: {
    backgroundColor: '#2e78b7',
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 30,
  },
  permissionButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  topControls: {
    position: 'absolute',
    top: 60,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    zIndex: 10,
  },
  controlButton: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    padding: 12,
    borderRadius: 30,
    width: 50,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeToggleContainer: {
    position: 'absolute',
    top: 130,
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
  buttonContainer: {
    position: 'absolute',
    bottom: 40,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  captureButton: {
    backgroundColor: '#2e78b7',
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 30,
    minWidth: 200,
    alignItems: 'center',
  },
  captureText: {
    color: 'white',
    fontSize: 16,
    fontWeight: 'bold',
  },
});
