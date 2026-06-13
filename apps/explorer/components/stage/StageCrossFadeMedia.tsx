import React, { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

export interface StageCrossFadeMediaProps {
  /** When this changes, trigger a brief fade-out → fade-in transition. */
  activeEventId: string | null | undefined;
  children: React.ReactNode;
}

const FADE_DURATION_MS = 180;

/**
 * Wraps the media frame and plays a quick opacity cross-fade when `chapterKey` changes.
 * This creates the visual transition between documentary chapters.
 */
export function StageCrossFadeMedia({ activeEventId, children }: StageCrossFadeMediaProps) {
  const opacity = useSharedValue(1);
  const prevKeyRef = useRef<string | null | undefined>(activeEventId);

  useEffect(() => {
    if (activeEventId === prevKeyRef.current) return;
    prevKeyRef.current = activeEventId;

    opacity.value = withTiming(0, { duration: FADE_DURATION_MS }, () => {
      opacity.value = withTiming(1, { duration: FADE_DURATION_MS });
    });
  }, [activeEventId, opacity]);

  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View style={[StyleSheet.absoluteFill, animStyle]} pointerEvents="box-none">
        {children}
      </Animated.View>
    </View>
  );
}
