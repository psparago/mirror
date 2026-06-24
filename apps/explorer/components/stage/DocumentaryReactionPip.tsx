import type { DocumentaryChapter } from '@projectmirror/shared';
import { ExplorerCachedImage } from '@/components/ExplorerCachedImage';
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
function getVideoPlayerId(player: DocumentaryReactionPipProps['reactionPlayer']): string | number | undefined {
  const id = (player as { id?: unknown } | null)?.id;
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

function DocumentaryReactionPipInner({
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
    <ExplorerCachedImage
      uri={chapter.speakerAvatarUrl}
      style={styles.media}
      contentFit="cover"
      recyclingKey={`doc-reaction-pip-${chapter.index}`}
      cachePolicy="memory-disk"
      priority="low"
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

export const DocumentaryReactionPip = React.memo(DocumentaryReactionPipInner, (prev, next) => {
  const prevId = getVideoPlayerId(prev.reactionPlayer);
  const nextId = getVideoPlayerId(next.reactionPlayer);
  const samePlayer = prevId !== undefined || nextId !== undefined
    ? prevId === nextId
    : prev.reactionPlayer === next.reactionPlayer;

  return (
    prev.visible === next.visible &&
    prev.mode === next.mode &&
    prev.videoReady === next.videoReady &&
    prev.chapter?.event.event_id === next.chapter?.event.event_id &&
    prev.chapter?.index === next.chapter?.index &&
    samePlayer
  );
});

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
