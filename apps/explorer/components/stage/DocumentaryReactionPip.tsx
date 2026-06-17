import type { DocumentaryChapter } from '@projectmirror/shared';
import { Image } from 'expo-image';
import { VideoView } from 'expo-video';
import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

export interface DocumentaryReactionPipProps {
  visible: boolean;
  mode: 'selfie-video' | 'companion-avatar';
  chapter: DocumentaryChapter | null;
  /** expo-video player for selfie reaction clips */
  reactionPlayer: ReturnType<typeof import('expo-video').useVideoPlayer> | null;
  /** True once the PiP video source is loaded and ready to display. */
  videoReady?: boolean;
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
  videoReady = false,
}: DocumentaryReactionPipProps) {
  const enter = useSharedValue(0);
  const chapterIndex = chapter?.index ?? -1;

  // Pop the PiP in whenever the chapter changes — this is the visible
  // transition between documentary chapters (the main stage stays on the parent).
  useEffect(() => {
    enter.value = 0;
    enter.value = withTiming(1, {
      duration: 320,
      easing: Easing.out(Easing.back(1.6)),
    });
  }, [chapterIndex, enter]);

  const animStyle = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [
      { scale: 0.6 + 0.4 * enter.value },
      { translateY: (1 - enter.value) * 16 },
    ],
  }));

  if (!visible || !chapter) return null;

  const showSelfieVideo =
    mode === 'selfie-video' && !!reactionPlayer && videoReady;

  const avatarFallback = chapter.speakerAvatarUrl ? (
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
  );

  return (
    <Animated.View style={[styles.frame, animStyle]} pointerEvents="none">
      {showSelfieVideo ? (
        <VideoView
          player={reactionPlayer}
          style={styles.media}
          contentFit="contain"
          nativeControls={false}
          allowsFullscreen={false}
        />
      ) : (
        avatarFallback
      )}
    </Animated.View>
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
