import { FontAwesome } from '@expo/vector-icons';
import React from 'react';
import { Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Animated from 'react-native-reanimated';
import type { AnimatedStyle } from 'react-native-reanimated';
import type { ViewStyle } from 'react-native';

export interface StageCaptionBarProps {
  captionText: string;
  senderName: string | null | undefined;
  formattedDate: string | null;
  reflectionId: string | null | undefined;
  isAnyAudioPlaying: boolean;
  audioIndicatorAnimatedStyle: AnimatedStyle<ViewStyle>;
  likedByCurrentUser: boolean;
  likeCount: number;
  heartAnimatedStyle: AnimatedStyle<ViewStyle>;
  onLike: () => void;
  onShowLikedBy: () => void;
  onCopyReflectionId: () => void;
}

/**
 * Production-style caption block beneath the Activity Row:
 * title, sender/date, likes, and Reflection ID.
 */
export function StageCaptionBar({
  captionText,
  senderName,
  formattedDate,
  reflectionId,
  isAnyAudioPlaying,
  audioIndicatorAnimatedStyle,
  likedByCurrentUser,
  likeCount,
  heartAnimatedStyle,
  onLike,
  onShowLikedBy,
  onCopyReflectionId,
}: StageCaptionBarProps) {
  return (
    <View style={styles.container}>
      <View style={styles.row}>
        {isAnyAudioPlaying ? (
          <Animated.View style={[audioIndicatorAnimatedStyle, styles.vuMeter]}>
            <FontAwesome name="volume-up" size={20} color="rgba(255, 255, 255, 0.9)" />
          </Animated.View>
        ) : null}

        <View style={styles.body}>
          <Text style={styles.captionText} numberOfLines={2}>
            {captionText}
          </Text>

          {senderName ? (
            <View style={styles.senderRow}>
              <Text style={styles.senderText}>From {senderName}</Text>
              {formattedDate ? (
                <Text style={styles.dateText}>{' • '}{formattedDate}</Text>
              ) : null}
            </View>
          ) : null}

          {reflectionId ? (
            <View style={styles.likeRow}>
              <Animated.View style={heartAnimatedStyle}>
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
              </Animated.View>

              {likeCount > 0 ? (
                <Pressable
                  onPress={onShowLikedBy}
                  onLongPress={onShowLikedBy}
                  hitSlop={12}
                  style={({ pressed }) => [styles.likeCountButton, pressed && styles.likeCountButtonPressed]}
                  accessibilityRole="button"
                  accessibilityLabel="Show who liked this Reflection"
                >
                  <Text style={styles.likeCount}>{likeCount}</Text>
                </Pressable>
              ) : null}

              <Text style={styles.likeHint}>Double tap to like</Text>
            </View>
          ) : null}

          {reflectionId ? (
            <Pressable
              onPress={onCopyReflectionId}
              style={({ pressed }) => [styles.eventIdPressable, pressed && styles.eventIdPressablePressed]}
              accessibilityRole="button"
              accessibilityLabel={`Reflection ID ${reflectionId}`}
              accessibilityHint="Copies the reflection ID to the clipboard"
            >
              <Text style={styles.eventIdLabel}>Reflection ID: </Text>
              <Text style={styles.eventIdText}>{reflectionId}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: 20,
    marginTop: 4,
    padding: 20,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 20,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  vuMeter: {
    marginRight: 12,
    marginTop: 2,
  },
  body: {
    flex: 1,
  },
  captionText: {
    color: '#fff',
    fontSize: 18,
    lineHeight: 24,
    fontWeight: '600',
  },
  senderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    flexWrap: 'wrap',
  },
  senderText: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 14,
    fontWeight: '600',
  },
  dateText: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 14,
  },
  likeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  likeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  likeButtonActive: {
    backgroundColor: 'rgba(255, 48, 64, 0.18)',
    borderColor: 'rgba(255, 48, 64, 0.45)',
  },
  likeHint: {
    flex: 1,
    color: 'rgba(255, 255, 255, 0.72)',
    fontSize: 14,
    fontWeight: '500',
    marginLeft: 2,
  },
  likeCountButton: {
    minWidth: 30,
    height: 30,
    paddingHorizontal: 9,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  likeCountButtonPressed: {
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  likeCount: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
  },
  eventIdPressable: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    paddingVertical: 2,
    paddingRight: 6,
    borderRadius: 4,
  },
  eventIdPressablePressed: {
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  eventIdLabel: {
    fontSize: 11,
    lineHeight: 14,
    color: 'rgba(160, 170, 180, 0.75)',
  },
  eventIdText: {
    fontSize: 11,
    lineHeight: 14,
    color: 'rgba(200, 210, 220, 0.9)',
    fontVariant: ['tabular-nums'],
  },
});
