import { FontAwesome } from '@expo/vector-icons';
import React from 'react';
import { Pressable, StyleSheet, Text, TouchableOpacity } from 'react-native';
import Animated from 'react-native-reanimated';
import type { AnimatedStyle } from 'react-native-reanimated';
import type { ViewStyle } from 'react-native';

export interface StageLikeRowProps {
  likedByCurrentUser: boolean;
  likeCount: number;
  onLike: () => void;
  onShowLikedBy: () => void;
  heartAnimatedStyle: AnimatedStyle<ViewStyle>;
}

/**
 * Like button + count + hint for the main stage metadata area.
 */
export function StageLikeRow({
  likedByCurrentUser,
  likeCount,
  onLike,
  onShowLikedBy,
  heartAnimatedStyle,
}: StageLikeRowProps) {
  return (
    <Animated.View style={[styles.row, heartAnimatedStyle]}>
      <TouchableOpacity
        style={[styles.likeButton, likedByCurrentUser && styles.likeButtonActive]}
        onPress={onLike}
        onLongPress={likeCount > 0 ? onShowLikedBy : undefined}
        activeOpacity={0.72}
        accessibilityLabel={likedByCurrentUser ? 'Unlike this Reflection' : 'Like this Reflection'}
      >
        <FontAwesome
          name={likeCount > 0 || likedByCurrentUser ? 'heart' : 'heart-o'}
          size={16}
          color={
            likedByCurrentUser
              ? '#FF3040'
              : likeCount > 0
                ? 'rgba(255, 255, 255, 0.78)'
                : 'rgba(255, 255, 255, 0.82)'
          }
        />
      </TouchableOpacity>

      {likeCount > 0 ? (
        <Pressable
          onPress={onShowLikedBy}
          onLongPress={onShowLikedBy}
          hitSlop={12}
          style={({ pressed }) => [styles.countButton, pressed && styles.countButtonPressed]}
          accessibilityRole="button"
          accessibilityLabel="Show who liked this Reflection"
        >
          <Text style={styles.count}>{likeCount}</Text>
        </Pressable>
      ) : null}

      <Text style={styles.hint}>Double tap to like</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  likeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  likeButtonActive: {
    backgroundColor: 'rgba(255, 48, 64, 0.18)',
    borderColor: 'rgba(255, 48, 64, 0.55)',
  },
  countButton: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
  },
  countButtonPressed: {
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  count: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 14,
    fontWeight: '600',
  },
  hint: {
    color: 'rgba(255,255,255,0.35)',
    fontSize: 11,
  },
});
