import { FontAwesome } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useEffect } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';

interface MediaPreviewProps {
  photo: { uri: string } | null;
  videoUri: string | null;
  mediaType: 'photo' | 'video';
  isLoadingImage: boolean;
  description: string;
  onDescriptionChange: (text: string) => void;
  intent: 'none' | 'voice' | 'ai' | 'note';
  onIntentSelect: (intent: 'voice' | 'ai' | 'note') => void;
  onRetake: () => void;
  onBack: () => void;
  onSend: () => void;
  uploading: boolean;
  isAiThinking: boolean;
  isAiGenerated: boolean;
  audioRecorderIsRecording: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
  audioUri: string | null;
  onRerecord: () => void;
  textInputRef: React.RefObject<TextInput>;
}

export default function MediaPreview({
  photo,
  videoUri,
  mediaType,
  isLoadingImage,
  description,
  onDescriptionChange,
  intent,
  onIntentSelect,
  onRetake,
  onBack,
  onSend,
  uploading,
  isAiThinking,
  isAiGenerated,
  audioRecorderIsRecording,
  onStartRecording,
  onStopRecording,
  audioUri,
  onRerecord,
  textInputRef,
}: MediaPreviewProps) {
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
  
  return (
    <ScrollView 
      contentContainerStyle={styles.previewContainer}
      keyboardShouldPersistTaps="handled"
    >
      {/* Title */}
      <Text style={styles.creationTitle}>Reflection Station</Text>
      
      {/* Media Preview with Retake Button */}
      <View style={styles.previewImageContainer}>
        {isLoadingImage ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#2e78b7" />
          </View>
        ) : (
          <>
            {mediaType === 'video' && videoUri ? (
              <View style={styles.videoPreviewContainer}>
                <VideoView
                  player={videoPlayer}
                  style={styles.previewImage}
                  contentFit="contain"
                  nativeControls
                />
                <View style={styles.videoPlayIcon}>
                  <FontAwesome name="play-circle" size={60} color="rgba(255, 255, 255, 0.8)" />
                </View>
              </View>
            ) : (
              <Image
                source={{ uri: photo?.uri }}
                style={styles.previewImage}
                contentFit="contain"
                cachePolicy="memory-disk"
              />
            )}
            <View style={styles.imageTopButtons}>
              {intent !== 'none' && (
                <TouchableOpacity 
                  style={styles.backToActionsButton}
                  onPress={onBack}
                >
                  <FontAwesome name="arrow-left" size={16} color="#fff" />
                  <Text style={styles.backToActionsButtonText}>Back</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity 
                style={styles.retakeButton}
                onPress={onRetake}
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
            onPress={() => onIntentSelect('voice')}
            disabled={uploading}
            activeOpacity={0.8}
          >
            <BlurView intensity={50} style={styles.intentButtonBlur}>
              <FontAwesome name="microphone" size={28} color="#2C3E50" />
              <Text style={styles.intentButtonText}>Voice Message</Text>
            </BlurView>
          </TouchableOpacity>

          <TouchableOpacity 
            style={styles.intentButton}
            onPress={() => onIntentSelect('ai')}
            disabled={uploading}
            activeOpacity={0.8}
          >
            <BlurView intensity={50} style={styles.intentButtonBlur}>
              {isAiThinking ? (
                <ActivityIndicator size="small" color="#2C3E50" />
              ) : (
                <Text style={{ fontSize: 28 }}>✨</Text>
              )}
              <Text style={styles.intentButtonText}>
                {isAiThinking ? 'Thinking...' : isAiGenerated ? 'AI Description' : 'Add AI Description'}
              </Text>
            </BlurView>
          </TouchableOpacity>

          <TouchableOpacity 
            style={styles.intentButton}
            onPress={() => onIntentSelect('note')}
            disabled={uploading}
            activeOpacity={0.8}
          >
            <BlurView intensity={50} style={styles.intentButtonBlur}>
              <FontAwesome name="pencil" size={28} color="#2C3E50" />
              <Text style={styles.intentButtonText}>Text Note</Text>
            </BlurView>
          </TouchableOpacity>
        </View>
      )}

      {/* Voice Intent UI */}
      {intent === 'voice' && (
        <View style={styles.voiceIntentContainer}>
          {!audioUri ? (
            <>
              <Text style={styles.intentButtonText}>
                {audioRecorderIsRecording ? 'Recording...' : 'Tap to record your voice message'}
              </Text>
              <TouchableOpacity 
                style={styles.recordButtonLarge}
                onPress={audioRecorderIsRecording ? onStopRecording : onStartRecording}
                disabled={uploading}
              >
                <FontAwesome 
                  name={audioRecorderIsRecording ? "stop-circle" : "microphone"} 
                  size={48} 
                  color="white" 
                />
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.intentButtonText}>Voice message recorded!</Text>
              <TouchableOpacity 
                style={styles.rerecordButton}
                onPress={onRerecord}
              >
                <Text style={styles.rerecordButtonText}>Re-record</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.recordButtonLarge, { backgroundColor: '#27ae60' }]}
                onPress={onSend}
                disabled={uploading}
              >
                <Text style={styles.recordButtonTextLarge}>
                  {uploading ? 'Sending...' : 'Send Reflection'}
                </Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      )}

      {/* Text Intent UI */}
      {intent === 'note' && (
        <View style={styles.textIntentContainer}>
          <TextInput
            ref={textInputRef}
            style={styles.descriptionInputLarge}
            placeholder="Write your note here..."
            value={description}
            onChangeText={onDescriptionChange}
            multiline
            numberOfLines={6}
            textAlignVertical="top"
            autoFocus
          />
          <TouchableOpacity 
            style={[styles.recordButtonLarge, { backgroundColor: '#27ae60' }]}
            onPress={onSend}
            disabled={uploading || !description.trim()}
          >
            <Text style={styles.recordButtonTextLarge}>
              {uploading ? 'Sending...' : 'Send Reflection'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* AI Intent UI */}
      {intent === 'ai' && (
        <View style={styles.textIntentContainer}>
          {isAiGenerated && (
            <View style={styles.aiIndicator}>
              <Text style={styles.aiIndicatorText}>✨ AI Generated</Text>
            </View>
          )}
          <TextInput
            ref={textInputRef}
            style={styles.descriptionInputLarge}
            placeholder="AI description will appear here..."
            value={description}
            onChangeText={onDescriptionChange}
            multiline
            numberOfLines={6}
            textAlignVertical="top"
            editable={!isAiThinking}
          />
          <TouchableOpacity 
            style={[styles.recordButtonLarge, { backgroundColor: '#27ae60' }]}
            onPress={onSend}
            disabled={uploading || !description.trim() || isAiThinking}
          >
            <Text style={styles.recordButtonTextLarge}>
              {uploading ? 'Sending...' : 'Send Reflection'}
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  previewContainer: {
    padding: 20,
    paddingTop: Platform.OS === 'ios' ? 60 : 20,
  },
  creationTitle: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#2C3E50',
    textAlign: 'center',
    marginBottom: 20,
    fontFamily: Platform.OS === 'ios' ? 'System' : 'Roboto',
    letterSpacing: 0.5,
  },
  previewImageContainer: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 20,
  },
  previewImage: {
    width: '100%',
    height: '100%',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f0f0f0',
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
  imageTopButtons: {
    position: 'absolute',
    top: 12,
    right: 12,
    flexDirection: 'row',
    gap: 8,
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
    width: 120,
    height: 120,
    borderRadius: 60,
    justifyContent: 'center',
    alignItems: 'center',
  },
  recordButtonTextLarge: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  textIntentContainer: {
    padding: 20,
    gap: 20,
  },
  descriptionInputLarge: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    minHeight: 150,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  rerecordButton: {
    backgroundColor: '#95a5a6',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
  },
  rerecordButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  aiIndicator: {
    backgroundColor: 'rgba(155, 89, 182, 0.1)',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
  },
  aiIndicatorText: {
    color: '#8e44ad',
    fontSize: 14,
    fontWeight: '600',
  },
});

