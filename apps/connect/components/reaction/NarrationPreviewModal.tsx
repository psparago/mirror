import { configureConnectPlaybackAudioSessionAsync } from '@/utils/audioSession';
import { FontAwesome } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { reactionPipStyles } from './reactionPipStyles';

export type NarrationPreviewModalProps = {
  visible: boolean;
  /** Local photo being brought to life. */
  imageUri: string;
  /** Local selfie narration video. */
  narrationUri: string;
  onClose: () => void;
};

/**
 * Replays a recorded Bring-It-to-Life narration exactly as it will play back:
 * photo full screen, selfie video in the corner. Self-contained — owns its own
 * player and styles.
 */
export function NarrationPreviewModal({
  visible,
  imageUri,
  narrationUri,
  onClose,
}: NarrationPreviewModalProps) {
  const insets = useSafeAreaInsets();
  const [showReplay, setShowReplay] = useState(false);

  const player = useVideoPlayer(narrationUri, (p) => {
    p.loop = false;
  });

  useEffect(() => {
    if (!visible) return;
    setShowReplay(false);
    void configureConnectPlaybackAudioSessionAsync().catch(() => {});
    try {
      player.currentTime = 0;
      player.play();
    } catch {
      /* player may still be loading */
    }
    const sub = player.addListener('playToEnd', () => setShowReplay(true));
    return () => {
      sub.remove();
      try {
        player.pause();
      } catch {
        /* player may be tearing down */
      }
    };
  }, [visible, player]);

  const handleReplay = useCallback(() => {
    setShowReplay(false);
    try {
      player.currentTime = 0;
      player.play();
    } catch {
      /* ignore */
    }
  }, [player]);

  return (
    <Modal
      visible={visible}
      animationType="fade"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
        <View style={styles.topBar}>
          <Text style={styles.title}>Brought to Life</Text>
          <Pressable
            style={styles.closeButton}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close narration preview"
          >
            <FontAwesome name="times" size={18} color="#fff" />
          </Pressable>
        </View>

        <View style={styles.stage}>
          <View style={styles.frame}>
            <Image source={{ uri: imageUri }} style={styles.mainMedia} contentFit="contain" />
            <VideoView
              player={player}
              style={reactionPipStyles.pipFrame}
              contentFit="contain"
              nativeControls={false}
              allowsFullscreen={false}
              pointerEvents="none"
            />
            {showReplay ? (
              <View style={styles.replayOverlay}>
                <Pressable
                  style={styles.replayButton}
                  onPress={handleReplay}
                  accessibilityRole="button"
                  accessibilityLabel="Replay narration"
                >
                  <FontAwesome name="repeat" size={22} color="#fff" />
                  <Text style={styles.replayText}>Replay</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
          <Text style={styles.hintText}>
            This is how your photo comes to life — it stays full screen while your selfie plays in
            the corner.
          </Text>
        </View>

        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) + 8 }]}>
          <Pressable
            style={styles.doneButton}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Done previewing narration"
          >
            <FontAwesome name="check" size={15} color="#fff" />
            <Text style={styles.doneButtonText}>Done</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  title: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  closeButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stage: {
    flex: 1,
    minHeight: 0,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  frame: {
    flex: 1,
    minHeight: 0,
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: '#101820',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  mainMedia: {
    width: '100%',
    height: '100%',
    backgroundColor: '#101820',
  },
  replayOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  replayButton: {
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 22,
    paddingVertical: 14,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  replayText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  hintText: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 12,
    textAlign: 'center',
    paddingHorizontal: 12,
    paddingTop: 10,
  },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  doneButton: {
    height: 48,
    borderRadius: 24,
    backgroundColor: '#2e78b7',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  doneButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
});
