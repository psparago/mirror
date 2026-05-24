import { FontAwesome } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

const BURST_DURATION_MS = 420;
const MAX_CONCURRENT_BURSTS = 3;

export type LikeHeartBurstPoint = {
  id: string;
  x: number;
  y: number;
};

type BurstItemProps = {
  burst: LikeHeartBurstPoint;
  onComplete: (id: string) => void;
};

function BurstItem({ burst, onComplete }: BurstItemProps) {
  const scale = useSharedValue(0.3);
  const opacity = useSharedValue(1);
  const translateY = useSharedValue(0);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const finishBurst = useCallback((id: string) => {
    onCompleteRef.current(id);
  }, []);

  useEffect(() => {
    scale.value = withTiming(1.45, {
      duration: BURST_DURATION_MS,
      easing: Easing.out(Easing.cubic),
    });
    opacity.value = withTiming(0, {
      duration: BURST_DURATION_MS,
      easing: Easing.out(Easing.quad),
    });
    translateY.value = withTiming(-28, {
      duration: BURST_DURATION_MS,
      easing: Easing.out(Easing.cubic),
    }, (finished) => {
      if (finished) {
        runOnJS(finishBurst)(burst.id);
      }
    });
  }, [burst.id, finishBurst, opacity, scale, translateY]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [
      { translateX: burst.x - 28 },
      { translateY: burst.y - 28 + translateY.value },
      { scale: scale.value },
    ],
  }));

  return (
    <Animated.View pointerEvents="none" style={[styles.burst, animatedStyle]}>
      <FontAwesome name="heart" size={56} color="#4FC3F7" />
    </Animated.View>
  );
}

type LikeHeartBurstOverlayProps = {
  bursts: LikeHeartBurstPoint[];
  onBurstComplete: (id: string) => void;
};

export function LikeHeartBurstOverlay({ bursts, onBurstComplete }: LikeHeartBurstOverlayProps) {
  if (bursts.length === 0) return null;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {bursts.map((burst) => (
        <BurstItem key={burst.id} burst={burst} onComplete={onBurstComplete} />
      ))}
    </View>
  );
}

export function useLikeHeartBursts() {
  const [bursts, setBursts] = useState<LikeHeartBurstPoint[]>([]);

  const spawnBurst = useCallback((x: number, y: number) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setBursts((prev) => {
      const next = [...prev, { id, x, y }];
      return next.length > MAX_CONCURRENT_BURSTS ? next.slice(-MAX_CONCURRENT_BURSTS) : next;
    });
  }, []);

  const clearBursts = useCallback(() => {
    setBursts([]);
  }, []);

  const removeBurst = useCallback((id: string) => {
    setBursts((prev) => prev.filter((burst) => burst.id !== id));
  }, []);

  return { bursts, spawnBurst, clearBursts, removeBurst };
}

const styles = StyleSheet.create({
  burst: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: 56,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
