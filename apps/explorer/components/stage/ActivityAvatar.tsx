import type { DocumentaryChapter } from '@projectmirror/shared';
import { Image } from 'expo-image';
import React, { useEffect } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

const AVATAR_SIZE = 58;
const RING_SIZE = AVATAR_SIZE + 6;
const PULSE_MS = 500;

export interface ActivityAvatarProps {
  chapter: DocumentaryChapter;
  isActive: boolean;
  /** When true, inactive avatars are blurred. When false/idle, all are crisp. */
  isPlaying: boolean;
  onPress: () => void;
}

/**
 * A single avatar in the Activity Row.
 * Blurs when inactive during playback; pulses briefly when it becomes active.
 */
export function ActivityAvatar({ chapter, isActive, isPlaying, onPress }: ActivityAvatarProps) {
  const scaleAnim = useSharedValue(1);
  const opacityAnim = useSharedValue(1);

  // Scale pulse when this avatar becomes active
  useEffect(() => {
    if (isActive) {
      scaleAnim.value = withSequence(
        withTiming(1.18, { duration: PULSE_MS / 2 }),
        withTiming(1.0, { duration: PULSE_MS / 2 }),
      );
    }
  }, [isActive, scaleAnim]);

  // Blur inactive avatars during playback (phase 4)
  useEffect(() => {
    opacityAnim.value = withTiming(!isPlaying || isActive ? 1 : 0.28, { duration: 180 });
  }, [isActive, isPlaying, opacityAnim]);

  const containerStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scaleAnim.value }],
    opacity: opacityAnim.value,
  }));

  const ringColor = isActive ? '#3897f0' : 'transparent';

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.72} style={styles.item}>
      <Animated.View style={containerStyle}>
        <View style={[styles.ring, { borderColor: ringColor }]}>
          {chapter.speakerAvatarUrl ? (
            <Image
              source={{ uri: chapter.speakerAvatarUrl }}
              style={styles.image}
              contentFit="cover"
              recyclingKey={`activity-avatar-${chapter.index}`}
              cachePolicy="memory-disk"
            />
          ) : (
            <View style={[styles.fallback, { backgroundColor: chapter.speakerColor }]}>
              <Text style={styles.initial}>{chapter.speakerInitial}</Text>
            </View>
          )}
        </View>
      </Animated.View>
      <Text style={[styles.name, isActive && styles.nameActive]} numberOfLines={1}>
        {chapter.isReaction ? chapter.speakerName : 'Author'}
      </Text>
    </TouchableOpacity>
  );
}

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
