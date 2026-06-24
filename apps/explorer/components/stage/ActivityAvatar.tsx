import type { DocumentaryChapter } from '@projectmirror/shared';
import { ExplorerCachedImage } from '@/components/ExplorerCachedImage';
import React, { useEffect, useRef } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

const AVATAR_SIZE = 58;
const RING_SIZE = AVATAR_SIZE + 6;
const BOUNCE_UP_MS = 240;
const BOUNCE_DOWN_MS = 620;
const BOUNCE_HEIGHT = 22;
const INACTIVE_SCALE = 0.82;
const INACTIVE_OPACITY = 0.3;

export interface ActivityAvatarProps {
  chapter: DocumentaryChapter;
  isActive: boolean;
  /** When true, inactive avatars are blurred. When false/idle, all are crisp. */
  isPlaying: boolean;
  onPress: () => void;
  /** Bumps when this chapter's media starts — triggers a short bounce. */
  playbackPulseKey?: number;
  /** Defer avatar decode until main stage media is ready. */
  deferLoad?: boolean;
}

function ActivityAvatarInner({
  chapter,
  isActive,
  isPlaying,
  onPress,
  playbackPulseKey = 0,
  deferLoad = false,
}: ActivityAvatarProps) {
  const focusScale = useSharedValue(1);
  const translateY = useSharedValue(0);
  const opacityAnim = useSharedValue(1);
  const lastPulseKeyRef = useRef(0);

  // The base Reflection author (chapter 0) is never a "reaction" and must never bounce.
  const isReactionChapter = chapter.isReaction;

  const bounce = () => {
    translateY.value = withSequence(
      withTiming(-BOUNCE_HEIGHT, { duration: BOUNCE_UP_MS, easing: Easing.out(Easing.cubic) }),
      withTiming(0, { duration: BOUNCE_DOWN_MS, easing: Easing.bounce }),
    );
  };

  useEffect(() => {
    const pulseChanged =
      playbackPulseKey > 0 && playbackPulseKey !== lastPulseKeyRef.current;
    if (pulseChanged) lastPulseKeyRef.current = playbackPulseKey;

    if (pulseChanged && isReactionChapter) bounce();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackPulseKey, isReactionChapter]);

  useEffect(() => {
    const isReflectionCreator = chapter.index === 0;
    const dim = isPlaying && !isActive && !isReflectionCreator;
    focusScale.value = withTiming(dim ? INACTIVE_SCALE : 1, { duration: 200 });
    opacityAnim.value = withTiming(dim ? INACTIVE_OPACITY : 1, { duration: 200 });
  }, [isActive, isPlaying, chapter.index, focusScale, opacityAnim]);

  const containerStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }, { scale: focusScale.value }],
    opacity: opacityAnim.value,
  }));

  const ringColor = isActive ? '#3897f0' : 'transparent';

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.72} style={styles.item}>
      <Animated.View style={containerStyle}>
        <View style={[styles.ring, { borderColor: ringColor }]}>
          {chapter.speakerAvatarUrl ? (
            <ExplorerCachedImage
              uri={chapter.speakerAvatarUrl}
              width={AVATAR_SIZE}
              height={AVATAR_SIZE}
              style={styles.image}
              contentFit="cover"
              recyclingKey={`activity-avatar-${chapter.index}`}
              cachePolicy="memory-disk"
              priority="low"
              deferLoad={deferLoad}
            />
          ) : (
            <View style={[styles.fallback, { backgroundColor: chapter.speakerColor }]}>
              <Text style={styles.initial}>{chapter.speakerInitial}</Text>
            </View>
          )}
        </View>
      </Animated.View>
      <Text style={[styles.name, isActive && styles.nameActive]} numberOfLines={1}>
        {chapter.speakerName}
      </Text>
    </TouchableOpacity>
  );
}

export const ActivityAvatar = React.memo(ActivityAvatarInner);

const styles = StyleSheet.create({
  item: {
    alignItems: 'center',
    width: 72,
  },
  ring: {
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: RING_SIZE / 2,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
  },
  fallback: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initial: {
    fontSize: 22,
    fontWeight: '700',
    color: '#fff',
  },
  name: {
    marginTop: 4,
    fontSize: 11,
    color: 'rgba(255,255,255,0.55)',
    textAlign: 'center',
  },
  nameActive: {
    color: '#fff',
    fontWeight: '600',
  },
});
