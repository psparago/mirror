import { Image } from 'expo-image';
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import type { ReactionResponderFace } from '@/utils/reactionPlayback';

export type ReactionRespondentsBarProps = {
  faces: ReactionResponderFace[];
  fetchingFaceKey: string | null;
  /** Responder whose reaction is currently playing (in-player); that avatar is disabled. */
  activeFaceKey?: string | null;
  onPressFace: (face: ReactionResponderFace) => void;
  /** Timeline card, full-width caption strip, or legacy compact overlay. */
  variant?: 'timeline' | 'caption' | 'player';
  style?: StyleProp<ViewStyle>;
};

export function ReactionRespondentsBar({
  faces,
  fetchingFaceKey,
  activeFaceKey = null,
  onPressFace,
  variant = 'timeline',
  style,
}: ReactionRespondentsBarProps) {
  if (faces.length === 0) return null;

  const isCaption = variant === 'caption';
  const isPlayer = variant === 'player';

  return (
    <View
      style={[
        isCaption ? styles.captionBar : isPlayer ? styles.playerBar : styles.timelineBar,
        style,
      ]}
      accessibilityLabel={`${faces.length} Companion reactions`}
    >
      <Text style={isCaption ? styles.captionLabel : isPlayer ? styles.playerLabel : styles.timelineLabel}>
        Responses
      </Text>
      <ScrollView
        horizontal
        nestedScrollEnabled
        showsHorizontalScrollIndicator={false}
        style={isCaption || isPlayer ? styles.captionScroll : styles.scroll}
        contentContainerStyle={styles.cobble}
      >
        {faces.map((face, index) => {
          const isActive = activeFaceKey === face.key;
          const isFetching = fetchingFaceKey === face.key;
          const isDisabled =
            isActive || (fetchingFaceKey !== null && !isFetching);

          return (
          <Pressable
            key={face.key}
            onPress={() => onPressFace(face)}
            disabled={isDisabled}
            style={({ pressed }) => [
              styles.avatarWrap,
              index > 0 && styles.avatarOverlap,
              isActive && styles.avatarActive,
              pressed && !isDisabled && styles.avatarPressed,
              isDisabled && !isActive && !isFetching && styles.avatarDisabled,
            ]}
            accessibilityRole="button"
            accessibilityLabel={
              isActive
                ? `Now playing reaction from ${face.companionName}`
                : `Play reaction from ${face.companionName}`
            }
            accessibilityState={{
              disabled: isDisabled,
              busy: isFetching,
              selected: isActive,
            }}
          >
            {face.avatarUrl ? (
              <Image source={{ uri: face.avatarUrl }} style={styles.avatar} contentFit="cover" />
            ) : (
              <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: face.color }]}>
                <Text style={styles.avatarInitial}>{face.initial}</Text>
              </View>
            )}
            {isFetching ? (
              <View style={styles.avatarLoading}>
                <ActivityIndicator size="small" color="#fff" />
              </View>
            ) : null}
          </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  timelineBar: {
    marginTop: 10,
    marginHorizontal: -12,
    paddingTop: 8,
    paddingBottom: 4,
    paddingHorizontal: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.38)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  captionBar: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingBottom: 12,
    marginBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.14)',
  },
  playerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 20,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.22)',
    alignSelf: 'flex-end',
  },
  captionLabel: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  timelineLabel: {
    color: 'rgba(255, 255, 255, 0.45)',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  playerLabel: {
    color: 'rgba(255, 255, 255, 0.55)',
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.35,
    textTransform: 'uppercase',
  },
  scroll: {
    flex: 1,
    minWidth: 0,
  },
  captionScroll: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  cobble: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 4,
  },
  avatarWrap: {
    borderRadius: 16,
    borderWidth: 2,
    borderColor: 'rgba(18, 18, 18, 0.95)',
    backgroundColor: 'rgba(18, 18, 18, 0.95)',
    position: 'relative',
  },
  avatarActive: {
    borderColor: 'rgba(79, 195, 247, 0.85)',
    opacity: 0.55,
  },
  avatarOverlap: {
    marginLeft: -10,
  },
  avatarPressed: {
    opacity: 0.85,
  },
  avatarDisabled: {
    opacity: 0.5,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
  },
  avatarFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  avatarLoading: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
