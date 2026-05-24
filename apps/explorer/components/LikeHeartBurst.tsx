import { FontAwesome } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

const HEART_SIZE = 84;
const BURST_DURATION_MS = 820;
const MAX_CONCURRENT_BURSTS = 3;
/** Instagram-style like burst red */
const LIKE_HEART_COLOR = '#FF3040';

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
  const scale = useSharedValue(0.15);
  const opacity = useSharedValue(1);
  const translateY = useSharedValue(0);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const finishBurst = useCallback((id: string) => {
    onCompleteRef.current(id);
  }, []);

  useEffect(() => {
    scale.value = withSpring(1.75, {
      damping: 8,
      stiffness: 260,
      mass: 0.55,
    });
    opacity.value = withTiming(0, {
      duration: BURST_DURATION_MS,
      easing: Easing.out(Easing.quad),
    });
    translateY.value = withTiming(-64, {
      duration: BURST_DURATION_MS,
      easing: Easing.out(Easing.cubic),
    }, (finished) => {
      if (finished) {
        runOnJS(finishBurst)(burst.id);
      }
    });
  }, [burst.id, finishBurst, opacity, scale, translateY]);

  const half = HEART_SIZE / 2;
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [
      { translateX: burst.x - half },
      { translateY: burst.y - half + translateY.value },
      { scale: scale.value },
    ],
  }));

  return (
    <Animated.View pointerEvents="none" style={[styles.burst, animatedStyle]}>
      <FontAwesome name="heart" size={HEART_SIZE} color={LIKE_HEART_COLOR} />
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
    <View pointerEvents="none" style={styles.overlay}>
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
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 50,
    elevation: 50,
  },
  burst: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: HEART_SIZE,
    height: HEART_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.55,
    shadowRadius: 8,
    elevation: 12,
  },
});
