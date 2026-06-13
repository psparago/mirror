import { BlurView } from 'expo-blur';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import Animated from 'react-native-reanimated';
import type { AnimatedStyle } from 'react-native-reanimated';
import type { ViewStyle } from 'react-native';

const STATIC_BLUR_INTENSITY = 20;

interface TellMeMoreButtonProps {
  onPress: () => void;
  disabled: boolean;
  isNarrating: boolean;
  /** When true, this button is fully hidden (reactions present; deep dive bypassed). */
  bypassed: boolean;
  containerStyle?: AnimatedStyle<ViewStyle>;
  blurOpacityStyle?: AnimatedStyle<ViewStyle>;
}

/**
 * The "Tell Me More" sparkle FAB. Positioned absolute top-left of the media area.
 * Hidden when `bypassed` is true (parent has Companion reactions).
 */
export function TellMeMoreButton({
  onPress,
  disabled,
  isNarrating,
  bypassed,
  containerStyle,
  blurOpacityStyle,
}: TellMeMoreButtonProps) {
  if (bypassed) return null;

  return (
    <Animated.View
      style={[styles.fab, containerStyle, isNarrating && styles.fabNarration]}
      pointerEvents={disabled ? 'none' : 'auto'}
    >
      <TouchableOpacity
        onPress={onPress}
        style={[styles.touch, { opacity: disabled ? 0.32 : 1 }]}
        disabled={disabled}
        activeOpacity={disabled ? 1 : 0.7}
        accessibilityLabel="Tell me more"
        accessibilityRole="button"
      >
        <Animated.View style={[styles.blurOpacity, blurOpacityStyle]}>
          <BlurView
            intensity={STATIC_BLUR_INTENSITY}
            style={[styles.blur, isNarrating && styles.blurDimmed]}
          >
            <Text style={{ fontSize: 22, opacity: isNarrating ? 0.5 : 1 }}>✨</Text>
          </BlurView>
        </Animated.View>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    top: 12,
    left: 12,
    width: 44,
    height: 44,
    borderRadius: 22,
    overflow: 'hidden',
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    zIndex: 20,
  },
  fabNarration: {
    opacity: 0.88,
  },
  touch: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  blurOpacity: {
    flex: 1,
    width: '100%',
  },
  blur: {
    flex: 1,
    width: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  blurDimmed: {
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
});
