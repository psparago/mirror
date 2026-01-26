import { FontAwesome } from '@expo/vector-icons';
import BottomSheet, { BottomSheetTextInput, BottomSheetView } from '@gorhom/bottom-sheet';
import { Event } from '@projectmirror/shared';
import { BlurView } from 'expo-blur';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Platform, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { ReplayModal } from './ReplayModal';

// --- TYPES ---
interface ReflectionComposerProps {
  mediaUri: string;
  mediaType: 'photo' | 'video';
  // State from Parent
  initialCaption?: string;
  aiArtifacts?: {
    caption?: string;
    deepDive?: string;
    audioUrl?: string; // The URL of the generated AI audio (if any)
    deepDiveAudioUrl?: string;
  };
  isAiThinking: boolean;
  
  // Actions
  onCancel: () => void;
  onSend: (data: { caption: string; audioUri: string | null; deepDive: string | null }) => void;
  onTriggerMagic: () => Promise<void>; // The function to call API_ENDPOINTS.AI_DESCRIPTION
  isSending: boolean;
  
  // Audio Recorder (passed from parent or hook)
  audioRecorder?: any; 
  onStartRecording?: () => void;
  onStopRecording?: () => void;
}

export default function ReflectionComposer({
  mediaUri,
  mediaType,
  initialCaption = '',
  aiArtifacts,
  isAiThinking,
  onCancel: onRetake,
  onSend,
  onTriggerMagic,
  isSending,
  audioRecorder,
  onStartRecording,
  onStopRecording
}: ReflectionComposerProps) {
  // --- STATE ---
  const sheetRef = useRef<BottomSheet>(null);
  const [caption, setCaption] = useState(initialCaption);
  const [activeTab, setActiveTab] = useState<'main' | 'voice' | 'text'>('main');
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  
  // Preview State
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [previewEvent, setPreviewEvent] = useState<Event | null>(null);

  const [isAiCancelled, setIsAiCancelled] = useState(false);
  const isBlockedByAi = isAiThinking && !isAiCancelled;

  // Get screen dimensions
  const { height: screenHeight } = useWindowDimensions();

  // TRIGGER AI ON MOUNT
  useEffect(() => {
    // Only fire if:
    // 1. We don't have a caption yet.
    // 2. The parent isn't already thinking (prevent double-fire).
    // 3. The user hasn't explicitly cancelled it.
    if (!caption && !isAiThinking && !isAiCancelled) {
      console.log("✨ Auto-triggering AI Magic...");
      // Fire and forget (errors handled in parent)
      onTriggerMagic().catch(() => console.log("Auto-magic failed"));
    }
  }, []);

  // Sync AI Caption if user hasn't typed yet
  useEffect(() => {
    if (aiArtifacts?.caption && !caption) {
      setCaption(aiArtifacts.caption);
    }
  }, [aiArtifacts?.caption]);

  // Track keyboard height
  useEffect(() => {
    const showSubscription = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (e) => {
        setKeyboardHeight(e.endCoordinates.height);
      }
    );
    const hideSubscription = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => {
        setKeyboardHeight(0);
      }
    );

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  // Calculate snap points dynamically based on screen height and keyboard
  const snapPoints = useMemo(() => {
    const mainHeight = screenHeight * 0.18; // 18% for main tab
    const voiceHeight = screenHeight * 0.45; // 45% for voice tab
    
    // For text tab: fill the space above the keyboard
    if (keyboardHeight > 0) {
      // When keyboard is visible: sheet should fill from keyboard to near top of screen
      // Leave small top margin (~60px) for status bar and some breathing room
      const topMargin = 60;
      const textHeight = screenHeight - keyboardHeight - topMargin;
      return [mainHeight, voiceHeight, textHeight];
    } else {
      // When keyboard is not visible: use 92% of screen
      return [mainHeight, voiceHeight, screenHeight * 0.92];
    }
  }, [screenHeight, keyboardHeight]);

  // Ensure sheet snaps to correct position when tab changes or keyboard shows/hides
  useEffect(() => {
    if (!sheetRef.current) return;
    
    // Small delay to ensure the tab content has rendered and snap points are updated
    const timeoutId = setTimeout(() => {
      const targetIndex = activeTab === 'main' ? 0 : activeTab === 'voice' ? 1 : 2;
      sheetRef.current?.snapToIndex(targetIndex);
    }, 100);
    
    return () => clearTimeout(timeoutId);
  }, [activeTab, snapPoints, keyboardHeight]);

  // Video Player
  const player = useVideoPlayer(mediaUri, (p) => {
    p.loop = true;
    p.play();
  });

  // --- HANDLERS ---

  const handleSheetChange = useCallback((index: number) => {
    if (index < 2) Keyboard.dismiss();
  }, []);

  const handlePreview = () => {
    const previewId = 'preview-temp';
    const now = new Date();

    // 1. Construct the Mock Event
    const mockEvent: Event = {
      event_id: previewId,
      image_url: mediaUri,
      video_url: mediaType === 'video' ? mediaUri : undefined,
      
      // PRIORITY: User Voice > AI Voice > None
      audio_url: audioRecorder?.uri || aiArtifacts?.audioUrl,
      
      metadata: {
        description: caption || "No description yet",
        short_caption: caption || "No caption",
        sender: 'You (Preview)',
        
        // --- REQUIRED FIELDS ADDED HERE ---
        event_id: previewId,
        timestamp: now.toISOString(), 
        content_type: mediaType === 'video' ? 'video' : (audioRecorder?.uri ? 'audio' : 'text'),
        image_source: 'camera', // Default for preview
        
        // Include Deep Dive data if available
        deep_dive: aiArtifacts?.deepDive,
      },
      
      // Pass the deep dive audio URL directly if we have it
      deep_dive_audio_url: aiArtifacts?.deepDiveAudioUrl
    };

    setPreviewEvent(mockEvent);
    setIsPreviewOpen(true);
  };

  // --- TABS SWITCHERS ---
  const switchToVoice = () => { 
    setActiveTab('voice'); 
    requestAnimationFrame(() => {
      sheetRef.current?.snapToIndex(1);
    });
  };
  const switchToText = () => { 
    setActiveTab('text'); 
    requestAnimationFrame(() => {
      sheetRef.current?.snapToIndex(2);
    });
  };
  const resetToMain = () => { 
    setActiveTab('main'); 
    requestAnimationFrame(() => {
      sheetRef.current?.snapToIndex(0);
    });
    Keyboard.dismiss(); 
  };

  // --- RENDERERS ---

  const renderBackground = () => (
    <View style={styles.backgroundContainer}>
      {mediaType === 'video' ? (
        <VideoView player={player} style={styles.media} contentFit="cover" nativeControls={false} />
      ) : (
        <Image source={{ uri: mediaUri }} style={styles.media} contentFit="cover" />
      )}
      <LinearGradient colors={['transparent', 'rgba(0,0,0,0.5)']} style={styles.gradientOverlay} />

      {/* TOP CONTROLS */}
      <View style={styles.topControls}>
        <View style={{ flex: 1 }} />

        {/* CIRCLED X CANCEL BUTTON */}
        <TouchableOpacity 
          style={styles.circledCancelButton} 
          onPress={onRetake} 
          disabled={isSending}
        >
          <FontAwesome name="times" size={18} color="#fff" />
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderMainTab = () => (
    <Animated.View entering={FadeIn} exiting={FadeOut} style={styles.tabContainer}>
      <Text style={styles.helperText}>Add context to this Reflection</Text>
      <View style={styles.quickActionsRow}>
        
        {/* VOICE CHIP */}
        <TouchableOpacity style={styles.actionChip} onPress={switchToVoice}>
          {audioRecorder?.uri ? (
             <View style={styles.badge} />
          ) : null}
          <FontAwesome name="microphone" size={20} color={audioRecorder?.uri ? "#27ae60" : "#2e78b7"} />
          <Text style={styles.actionChipText}>Voice</Text>
        </TouchableOpacity>
        
        {/* TEXT CHIP */}
        <TouchableOpacity style={styles.actionChip} onPress={switchToText}>
          {caption ? <View style={styles.badge} /> : null}
          <FontAwesome name="pencil" size={20} color={caption ? "#27ae60" : "#8e44ad"} />
          <Text style={styles.actionChipText}>Text</Text>
        </TouchableOpacity>

        {/* PREVIEW BUTTON */}
        {!isBlockedByAi && (
          <TouchableOpacity 
            style={[
              styles.actionChip,
              styles.previewChip,
              (isSending || isAiThinking) && styles.chipDisabled
            ]} 
            onPress={handlePreview}
            disabled={isSending || isAiThinking}
          >
            <FontAwesome name="eye" size={20} color="#fff" />
            <Text style={styles.actionChipText}>Preview</Text>
          </TouchableOpacity>
        )}

        {/* SEND BUTTON */}
        {!isBlockedByAi && (
          <TouchableOpacity 
            style={[
              styles.actionChip,
              styles.sendChip,
              isSending && styles.chipDisabled,
              (!caption && !audioRecorder?.uri) && styles.chipDisabled
            ]}
            onPress={() => onSend({ caption, audioUri: audioRecorder?.uri || null, deepDive: aiArtifacts?.deepDive || null })}
            disabled={isSending || (!caption && !audioRecorder?.uri)}
          >
            {isSending ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <FontAwesome name="paper-plane" size={20} color="#fff" />
                <Text style={styles.actionChipText}>Send</Text>
              </>
            )}
          </TouchableOpacity>
        )}
      </View>
    </Animated.View>
  );

  const renderVoiceTab = () => (
    <Animated.View entering={FadeIn} exiting={FadeOut} style={styles.tabContainer}>
      <View style={styles.tabHeader}>
        <TouchableOpacity onPress={resetToMain} style={styles.backLink}>
          <FontAwesome name="chevron-left" size={16} color="#666" />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.tabTitle}>Voice Message</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.recorderContainer}>
        {audioRecorder?.uri && !audioRecorder?.isRecording ? (
           <View style={styles.playbackState}>
             <FontAwesome name="check-circle" size={48} color="#27ae60" />
             <Text style={styles.recordingStatus}>Voice Note Recorded</Text>
             <TouchableOpacity onPress={() => { /* Logic to clear audio */ }}>
                <Text style={styles.clearText}>Tap record to overwrite</Text>
             </TouchableOpacity>
           </View>
        ) : null}

        <TouchableOpacity 
          style={[styles.recordButton, audioRecorder?.isRecording && styles.recordingActive]}
          onPress={audioRecorder?.isRecording ? onStopRecording : onStartRecording}
        >
          <FontAwesome 
            name={audioRecorder?.isRecording ? "stop" : "microphone"} 
            size={32} 
            color="#fff" 
          />
        </TouchableOpacity>
        <Text style={styles.recordingStatus}>
          {audioRecorder?.isRecording ? "Recording..." : (audioRecorder?.uri ? "Record New" : "Tap to Record")}
        </Text>
      </View>
    </Animated.View>
  );

  const renderTextTab = () => (
    <Animated.View entering={FadeIn} exiting={FadeOut} style={styles.tabContainer}>
      <View style={styles.tabHeader}>
        <TouchableOpacity onPress={resetToMain} style={styles.backLink}>
          <FontAwesome name="chevron-left" size={16} color="#666" />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.tabTitle}>Description</Text>
        <TouchableOpacity onPress={resetToMain}>
          <Text style={styles.doneText}>Done</Text>
        </TouchableOpacity>
      </View>

      <BottomSheetTextInput
        style={styles.input}
        placeholder="What is happening in this reflection?"
        placeholderTextColor="#666"
        value={caption}
        onChangeText={setCaption}
        multiline
        scrollEnabled
        textAlignVertical="top"
        autoFocus
        onFocus={() => {
          // Snap to highest point when text input is focused
          sheetRef.current?.snapToIndex(2);
        }}
      />
    </Animated.View>
  );

  return (
    <GestureHandlerRootView style={styles.container}>
      {/* 1. IMMERSIVE MEDIA */}
      {renderBackground()}

      {/* 2. BOTTOM SHEET TOOLKIT */}
      <BottomSheet
        ref={sheetRef}
        index={0}
        snapPoints={snapPoints}
        onChange={handleSheetChange}
        backgroundStyle={styles.sheetBackground}
        handleIndicatorStyle={styles.sheetHandle}
        keyboardBehavior="interactive"
        android_keyboardInputMode="adjustResize"
        enablePanDownToClose={false}
        enableOverDrag={false}
      >
        <BottomSheetView style={styles.sheetContent}>
          {activeTab === 'main' && renderMainTab()}
          {activeTab === 'voice' && renderVoiceTab()}
          {activeTab === 'text' && renderTextTab()}

          {/* AI LOCKDOWN OVERLAY */}
          {isBlockedByAi && (
            <View style={[StyleSheet.absoluteFill, styles.lockdownOverlay]}>
              {/* Using tint="dark" to match your dark theme preference */}
              <BlurView intensity={30} tint="dark" style={styles.blurContainer}>
                <ActivityIndicator size="large" color="#f39c12" />
                <Text style={styles.aiOverlayText}>Adding Sparkle to your Reflection!</Text>
                <TouchableOpacity 
                  style={styles.cancelAiButton} 
                  onPress={() => setIsAiCancelled(true)} 
                >
                  <Text style={styles.cancelAiText}>Cancel</Text>
                </TouchableOpacity>
              </BlurView>
            </View>
          )}
        </BottomSheetView>
      </BottomSheet>

      {/* REPLAY PREVIEW MODAL */}
      <ReplayModal 
        visible={isPreviewOpen}
        event={previewEvent}
        onClose={() => {
          setIsPreviewOpen(false);
          setPreviewEvent(null);
        }}
      />
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  backgroundContainer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 0,
  },
  media: {
    width: '100%',
    height: '100%',
  },
  gradientOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 350,
  },
  topControls: {
    position: 'absolute',
    top: 10,
    left: 10,
    right: 5,
    flexDirection: 'row',
    justifyContent: 'space-between',
    zIndex: 10,
  },
  circledCancelButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  previewButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(46, 120, 183, 0.8)', // Branded blue
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    gap: 6,
  },
  cancelText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
  // Sheet
  sheetBackground: {
    backgroundColor: '#1a1a1a', // Dark background
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
    elevation: 5,
  },
  sheetHandle: {
    backgroundColor: '#666', // Lighter gray for dark background
    width: 40,
  },
  sheetContent: {
    flex: 1,
    paddingHorizontal: 20,
  },
  tabContainer: {
    flex: 1,
    paddingTop: 10,
  },
  helperText: {
    color: '#666',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 16,
    textAlign: 'center',
  },
  quickActionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 20,
    gap: 10,
  },
  actionChip: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 12,
    borderRadius: 16,
    backgroundColor: '#2a2a2a', // Dark background for chips
    position: 'relative',
  },
  chipDisabled: {
    opacity: 0.5,
  },
  previewChip: {
    backgroundColor: '#3a3a3a', // Muted gray for preview button
  },
  sendChip: {
    backgroundColor: '#2e78b7', // Bright blue for send button (dominant)
    borderWidth: 2,
    borderColor: '#4a9bd9', // Lighter blue border for emphasis
    shadowColor: "#2e78b7",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 4,
    elevation: 4,
  },
  actionChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#fff', // White text for dark background
  },
  badge: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#27ae60',
  },
  // Header
  tabHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  backLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  backText: {
    color: '#666',
    fontSize: 14,
  },
  tabTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#333',
  },
  doneText: {
    color: '#2e78b7',
    fontWeight: '600',
    fontSize: 16,
  },
  input: {
    fontSize: 18,
    lineHeight: 24,
    color: '#fff', // White text for dark background
    minHeight: 150,
    textAlignVertical: 'top',
  },
  // Voice
  recorderContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
    gap: 20,
  },
  playbackState: {
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  recordButton: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#e74c3c',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: "#e74c3c",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  recordingActive: {
    backgroundColor: '#c0392b',
    transform: [{ scale: 1.1 }],
  },
  recordingStatus: {
    fontSize: 16,
    color: '#999', // Lighter for dark background
    fontWeight: '500',
  },
  clearText: {
    fontSize: 12,
    color: '#666',
    textDecorationLine: 'underline',
  },
  // Footer
  footerContainer: {
    paddingBottom: 40,
    paddingTop: 20,
    borderTopWidth: 1,
    borderTopColor: '#333', // Darker border for dark background
  },
  sendButton: {
    backgroundColor: '#2e78b7',
    borderRadius: 16,
    paddingVertical: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // AI LOCKDOWN OVERLAY
  lockdownOverlay: {
    zIndex: 100,
    borderRadius: 0, // Matches sheet interior
    overflow: 'hidden',
  },
  blurContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: 'rgba(0,0,0,0.6)', // Dark tint for dark mode
  },
  aiOverlayText: {
    color: '#f39c12', // Gold/Orange for visibility on dark
    fontWeight: '700',
    fontSize: 18,
},
cancelAiButton: {
  paddingVertical: 10,
  paddingHorizontal: 24,
  backgroundColor: '#333', // Dark grey button
  borderRadius: 20,
  borderWidth: 1,
  borderColor: '#666',
},
cancelAiText: {
  fontSize: 14,
  fontWeight: '600',
  color: '#fff',
},

// Floating Buttons Column
floatingButtonContainer: {
  position: 'absolute',
  bottom: 30,
  right: 20,
  zIndex: 999,
},
floatingButtonsColumn: {
  flexDirection: 'column',
  gap: 10,
  alignItems: 'flex-end',
},
floatingPreviewButton: {
  backgroundColor: 'rgba(46, 120, 183, 0.8)',
  borderRadius: 25,
  paddingVertical: 10,
  paddingHorizontal: 20,
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 0.3,
  shadowRadius: 8,
  elevation: 8,
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
},
floatingSendButton: {
  backgroundColor: '#2e78b7',
  borderRadius: 25,
  paddingVertical: 10,
  paddingHorizontal: 20,
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 0.3,
  shadowRadius: 8,
  elevation: 8,
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'center',
},
floatingButtonText: {
  color: '#fff',
  fontWeight: '600',
  fontSize: 14,
},
sendingButton: {
  backgroundColor: '#555',
},
disabledSendButton: {
  backgroundColor: '#444',
  opacity: 0.7,
},
emptyStateButton: {
  opacity: 0.9,
},
sendContent: {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 8,
},
sendButtonText: {
  color: '#fff',
  fontSize: 18,
  fontWeight: 'bold',
},
});