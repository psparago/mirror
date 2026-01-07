import { FontAwesome } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { CameraType, CameraView } from 'expo-camera';
import React from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface CameraModalProps {
  visible: boolean;
  onClose: () => void;
  cameraRef: React.RefObject<CameraView>;
  facing: CameraType;
  onToggleFacing: () => void;
  cameraMode: 'photo' | 'video';
  onSetCameraMode: (mode: 'photo' | 'video') => void;
  isRecordingVideo: boolean;
  recordingDuration: number;
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
  isRecordingVideo,
  recordingDuration,
  onShutterPress,
  uploading,
}: CameraModalProps) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
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
            onPress={onClose}
          >
            <FontAwesome name="times" size={24} color="white" />
          </TouchableOpacity>
          <TouchableOpacity 
            style={styles.flipButton} 
            onPress={onToggleFacing}
            disabled={uploading || isRecordingVideo}
          >
            <FontAwesome name="refresh" size={24} color="white" />
          </TouchableOpacity>
        </View>

        {/* Photo/Video Mode Toggle */}
        <View style={styles.modeToggleContainer}>
          <TouchableOpacity 
            style={[styles.modeButton, cameraMode === 'photo' && styles.modeButtonActive]}
            onPress={() => onSetCameraMode('photo')}
            disabled={isRecordingVideo}
          >
            <FontAwesome name="camera" size={20} color={cameraMode === 'photo' ? '#fff' : '#999'} />
            <Text style={[styles.modeText, cameraMode === 'photo' && styles.modeTextActive]}>Photo</Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={[styles.modeButton, cameraMode === 'video' && styles.modeButtonActive]}
            onPress={() => onSetCameraMode('video')}
            disabled={isRecordingVideo}
          >
            <FontAwesome name="video-camera" size={20} color={cameraMode === 'video' ? '#fff' : '#999'} />
            <Text style={[styles.modeText, cameraMode === 'video' && styles.modeTextActive]}>Video</Text>
          </TouchableOpacity>
        </View>

        {/* Recording Duration Display */}
        {isRecordingVideo && (
          <View style={styles.videoRecordingIndicator}>
            <View style={styles.recordingDot} />
            <Text style={styles.videoRecordingText}>
              {recordingDuration.toFixed(1)}s / 10s
            </Text>
          </View>
        )}

        <View style={styles.buttonContainer}>
          <TouchableOpacity 
            style={[
              styles.captureButton,
              cameraMode === 'video' && isRecordingVideo && styles.captureButtonRecording
            ]} 
            onPress={onShutterPress}
            disabled={uploading}
          >
            <Text style={styles.text}>
              {uploading ? "UPLOADING..." : 
                cameraMode === 'video' ? 
                  (isRecordingVideo ? "STOP RECORDING" : "RECORD VIDEO") :
                  "TAKE PHOTO"}
            </Text>
          </TouchableOpacity>
        </View>
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
    top: 60,
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
  videoRecordingIndicator: {
    position: 'absolute',
    top: 190,
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
  captureButtonRecording: {
    backgroundColor: '#d32f2f',
  },
  text: {
    color: 'white',
    fontSize: 16,
    fontWeight: 'bold',
  },
});

