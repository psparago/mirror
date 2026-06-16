import type { DocumentaryChapter } from '@projectmirror/shared';
import { Image } from 'expo-image';
import { VideoView } from 'expo-video';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

export interface DocumentaryReactionPipProps {
  visible: boolean;
  mode: 'selfie-video' | 'companion-avatar';
  chapter: DocumentaryChapter | null;
  /** expo-video player for selfie reaction clips */
  reactionPlayer: ReturnType<typeof import('expo-video').useVideoPlayer> | null;
}

/**
 * Picture-in-picture overlay for documentary reaction chapters.
 * Parent Reflection stays full-screen; the reaction plays in the corner.
 */
export function DocumentaryReactionPip({
  visible,
  mode,
  chapter,
  reactionPlayer,
}: DocumentaryReactionPipProps) {
  if (!visible || !chapter) return null;

  return (
    <View style={styles.frame} pointerEvents="none">
      {mode === 'selfie-video' && reactionPlayer ? (
        <VideoView
          player={reactionPlayer}
          style={styles.media}
          contentFit="cover"
          nativeControls={false}
          allowsFullscreen={false}
        />
      ) : (
        <>
          {chapter.speakerAvatarUrl ? (
            <Image
              source={{ uri: chapter.speakerAvatarUrl }}
              style={styles.media}
              contentFit="cover"
              recyclingKey={`doc-reaction-pip-${chapter.index}`}
              cachePolicy="memory-disk"
            />
          ) : (
            <View style={[styles.fallback, { backgroundColor: chapter.speakerColor }]}>
              <Text style={styles.initial}>{chapter.speakerInitial}</Text>
            </View>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    position: 'absolute',
    top: 18,
    right: 18,
    width: 132,
    height: 176,
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.45)',
    backgroundColor: '#000',
    zIndex: 42,
    elevation: 42,
  },
  media: {
    width: '100%',
    height: '100%',
  },
  fallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initial: {
    color: '#fff',
    fontSize: 36,
    fontWeight: '700',
  },
});
