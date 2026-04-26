import { FontAwesome } from '@expo/vector-icons';
import { CameraType, CameraView } from 'expo-camera';
import React from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface CameraModalProps {
  visible: boolean;
  onClose: () => void;
  cameraRef: React.RefObject<CameraView>;
  facing: CameraType;
  onToggleFacing: () => void;
  cameraMode: 'photo' | 'video';
  onSetCameraMode: (mode: 'photo' | 'video') => void;
  onShutterPress: () => void;
  uploading: boolean;
}

export default function CameraModal({
  visible,
  onClose,
  cameraRef,
  facing,
  onToggleFacing,
  cameraMode,
  onSetCameraMode,
  onShutterPress,
  uploading,
}: CameraModalProps) {
  const insets = useSafeAreaInsets();
  const topBarTop = insets.top + 8;
  const modeBarTop = topBarTop + 50 + 12;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        <CameraView
          key={facing}
          style={StyleSheet.absoluteFill}
          ref={cameraRef}
          facing={facing}
        />

        <View style={[styles.topControls, { top: topBarTop }]}>
          <TouchableOpacity
            style={styles.closeCameraButton}
            onPress={onClose}
          >
            <FontAwesome name="times" size={24} color="white" />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.flipButton}
            onPress={onToggleFacing}
            disabled={uploading}
          >
            <FontAwesome name="refresh" size={24} color="white" />
          </TouchableOpacity>
        </View>

        {/* Photo/Video Mode Toggle */}
        <View style={[styles.modeToggleContainer, { top: modeBarTop }]}>
          <TouchableOpacity
            style={[styles.modeButton, cameraMode === 'photo' && styles.modeButtonActive]}
            onPress={() => onSetCameraMode('photo')}
          >
            <FontAwesome name="camera" size={20} color={cameraMode === 'photo' ? '#fff' : '#999'} />
            <Text style={[styles.modeText, cameraMode === 'photo' && styles.modeTextActive]}>Photo</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.modeButton, cameraMode === 'video' && styles.modeButtonActive]}
            onPress={() => onSetCameraMode('video')}
          >
            <FontAwesome name="video-camera" size={20} color={cameraMode === 'video' ? '#fff' : '#999'} />
            <Text style={[styles.modeText, cameraMode === 'video' && styles.modeTextActive]}>Video</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.buttonContainer}>
          <TouchableOpacity
            style={styles.captureButton}
            onPress={onShutterPress}
            disabled={uploading}
          >
            <Text style={styles.text}>
              {uploading ? "UPLOADING..." :
                cameraMode === 'video' ? "RECORD VIDEO" : "TAKE PHOTO"}
            </Text>
          </TouchableOpacity>
        </View>

        {uploading ? (
          <View style={styles.waitOverlay}>
            <View style={styles.waitCard}>
              <View style={styles.waitIconWrap}>
                <FontAwesome name="cloud-upload" size={20} color="#dbeafe" />
              </View>
              <ActivityIndicator size="large" color="#f39c12" />
              <Text style={styles.waitTitle}>Sending to the Cloud...</Text>
              <Text style={styles.waitSubText}>
                Please keep the app open and stay on WiFi for a fast delivery!
              </Text>
            </View>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center'
  },
  topControls: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    zIndex: 10,
  },
  closeCameraButton: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    padding: 12,
    borderRadius: 30,
    width: 50,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flipButton: {
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
  text: {
    color: 'white',
    fontSize: 16,
    fontWeight: 'bold',
  },
  waitOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 20,
  },
  waitCard: {
    width: '86%',
    maxWidth: 360,
    alignItems: 'center',
    borderRadius: 24,
    paddingVertical: 28,
    paddingHorizontal: 24,
    backgroundColor: 'rgba(15, 23, 42, 0.96)',
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.45)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.26,
    shadowRadius: 18,
    elevation: 10,
    gap: 12,
  },
  waitIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(59, 130, 246, 0.22)',
    borderWidth: 1,
    borderColor: 'rgba(191, 219, 254, 0.45)',
  },
  waitTitle: {
    color: '#f39c12',
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  waitSubText: {
    color: 'rgba(255,255,255,0.82)',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
});

