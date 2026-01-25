import { FontAwesome } from '@expo/vector-icons';
import { Event, EventMetadata, playerMachine } from '@projectmirror/shared';
import { useMachine } from '@xstate/react';
import { Audio } from 'expo-av';
import { BlurView } from 'expo-blur';
import { Image } from 'expo-image'; // leveraging your new build!
import * as Speech from 'expo-speech';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useEffect, useMemo, useRef } from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface ReplayModalProps {
  visible: boolean;
  event: Event | null;
  onClose: () => void;
}

export function ReplayModal({ visible, event, onClose }: ReplayModalProps) {
  // 1. Audio Player Ref (for voice notes)
  const soundRef = useRef<Audio.Sound | null>(null);

  // 2. Video Player Setup
  const videoPlayer = useVideoPlayer(event?.video_url || '', player => {
    player.loop = false;
  });

  // 3. The State Machine
  const sendRef = useRef<any>(() => {});
  const machine = useMemo(() => playerMachine.provide({
    actions: {
      // --- MEDIA CONTROL ---
      stopAllMedia: async () => {
        Speech.stop();
        if (soundRef.current) {
          await soundRef.current.stopAsync();
          await soundRef.current.unloadAsync();
          soundRef.current = null;
        }
        videoPlayer.pause();
        videoPlayer.currentTime = 0;
      },
      speakCaption: () => {
        // Only speak if there's no audio recording attached (Machine logic handles this guard usually, 
        // but safe to check metadata).
        if (event?.metadata?.short_caption) {
           Speech.speak(event.metadata.short_caption, {
             onDone: () => sendRef.current({ type: 'NARRATION_FINISHED' }),
             // If speech fails/interrupted, we must fail forward or the machine gets stuck
             onStopped: () => sendRef.current({ type: 'NARRATION_FINISHED' }), 
           });
        } else {
           // No caption? Skip step.
           sendRef.current({ type: 'NARRATION_FINISHED' });
        }
      },
      playVideo: () => {
        videoPlayer.play();
      },
      playAudio: async () => {
        if (event?.audio_url) {
          const { sound } = await Audio.Sound.createAsync(
            { uri: event.audio_url },
            { shouldPlay: true }
          );
          soundRef.current = sound;
          sound.setOnPlaybackStatusUpdate((status) => {
            if (status.isLoaded && status.didJustFinish) {
               sendRef.current({ type: 'AUDIO_FINISHED' });
            }
          });
        } else {
          sendRef.current({ type: 'AUDIO_FINISHED' });
        }
      },
      pauseMedia: () => {
        videoPlayer.pause();
        if (soundRef.current) soundRef.current.pauseAsync();
        Speech.stop();
      },
      resumeMedia: () => {
        // This is complex, simplified for Replay: just replay
        videoPlayer.play();
        if (soundRef.current) soundRef.current.playAsync();
      },

      // --- SELFIE ACTIONS (DISABLE FOR COMPANION) ---
      triggerSelfie: () => {
        console.log("📸 [Replay] Selfie trigger ignored in Companion mode");
        // We pretend we took it so the machine moves to 'done'
        // But in 'Replay', we likely won't even reach this state if we don't start the camera
      },
      showSelfieBubble: () => {}, 
      playDeepDive: () => {}, // Implement if you want Emily to hear the AI explanation
    }
  }), [event, videoPlayer]);

  // 4. Initialize the Hook
  const [state, send] = useMachine(machine);

  // 5. Update the Send Function
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  // 6. Drive the Machine
  useEffect(() => {
    if (visible && event) {
      // Initialize machine with this event
      sendRef.current({ 
        type: 'SELECT_EVENT_INSTANT', 
        event: event, 
        metadata: event.metadata || ({} as EventMetadata)
      });
    } else {
      sendRef.current({ type: 'CLOSE' });
    }
    
    // Cleanup on unmount/close
    return () => {
      sendRef.current({ type: 'CLOSE' });
    };
  }, [visible, event, send]);

  // Video Player Event Listener (to notify machine)
  useEffect(() => {
    const subscription = videoPlayer.addListener('playToEnd', () => {
       send({ type: 'VIDEO_FINISHED' });
    });
    return () => subscription.remove();
  }, [videoPlayer, send]);


  if (!visible || !event) return null;

  // --- RENDER ---
  const isVideo = state.hasTag('video_mode');
  const isAudio = state.hasTag('audio_mode');
  const isSpeaking = state.hasTag('speaking');

  return (
    <Modal visible={visible} animationType="slide" transparent={false}>
      <View style={styles.container}>
        
        {/* Header / Close Button */}
        <TouchableOpacity style={styles.closeButton} onPress={onClose}>
           <FontAwesome name="times" size={24} color="#fff" />
        </TouchableOpacity>

        {/* --- MAIN STAGE CONTENT --- */}
        
        {/* 1. VIDEO VIEW */}
        {isVideo ? (
           <VideoView 
             player={videoPlayer} 
             style={styles.fullscreenMedia} 
             contentFit="contain"
           />
        ) : (
           /* 2. IMAGE VIEW (For Audio or Photo events) */
           <Image
             source={{ uri: event.image_url }}
             style={styles.fullscreenMedia}
             contentFit="contain" // "contain" lets us see the whole polaroid framing if image is weird
           />
        )}

        {/* 3. AUDIO VISUALIZER (Simple placeholder) */}
        {isAudio && (
           <BlurView intensity={30} style={styles.audioOverlay}>
             <FontAwesome name="volume-up" size={48} color="#fff" />
             <Text style={styles.audioText}>Playing Audio Message...</Text>
           </BlurView>
        )}

        {/* 4. CAPTION OVERLAY (Mimics Cole's Bottom Bar) */}
        <View style={styles.captionBar}>
           <Text style={styles.captionText}>
             {event.metadata?.short_caption || event.metadata?.description || "No caption"}
           </Text>
           {isSpeaking && (
              <ActivityIndicator size="small" color="#fff" style={{marginLeft: 10}}/>
           )}
        </View>

      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeButton: {
    position: 'absolute',
    top: 50,
    right: 20,
    zIndex: 100,
    padding: 10,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 20,
  },
  fullscreenMedia: {
    width: '100%',
    height: '80%',
  },
  audioOverlay: {
    position: 'absolute',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
    borderRadius: 20,
    overflow: 'hidden',
  },
  audioText: {
    color: '#fff',
    marginTop: 20,
    fontSize: 18,
    fontWeight: '600',
  },
  captionBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingBottom: 40, // Safe area
    paddingTop: 20,
    paddingHorizontal: 20,
    backgroundColor: 'rgba(0,0,0,0.7)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  captionText: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '600',
    textAlign: 'center',
  }
});