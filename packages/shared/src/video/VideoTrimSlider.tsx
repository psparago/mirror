import React, { useCallback, useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';

export interface VideoTrimSliderProps {
  durationMs: number;
  startMs: number;
  endMs: number;
  /** Current playback position in ms — drives the playhead needle. */
  currentTimeMs: number;
  onChange: (start: number, end: number) => void;
  /** Called continuously while dragging so the parent can seek the video. */
  onSeek?: (ms: number) => void;
}

const HANDLE_WIDTH = 24;
const MIN_RANGE_MS = 500;
const TRACK_HEIGHT = 44;

function formatTime(ms: number): string {
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(1)}s`;
}

export default function VideoTrimSlider({ durationMs, startMs, endMs, currentTimeMs, onChange, onSeek }: VideoTrimSliderProps) {
  const trackWidth = useSharedValue(0);

  // Shared values that drive all visuals on the UI thread
  const startVal = useSharedValue(startMs);
  const endVal = useSharedValue(endMs);
  const playheadMs = useSharedValue(currentTimeMs);

  // Keep shared values in sync with props (for external changes)
  useEffect(() => { startVal.value = startMs; }, [startMs]);
  useEffect(() => { endVal.value = endMs; }, [endMs]);
  useEffect(() => { playheadMs.value = currentTimeMs; }, [currentTimeMs]);

  // Captured at gesture begin so translationX math is always relative to the origin
  const originMs = useSharedValue(0);

  const emitChange = useCallback(
    (s: number, e: number) => onChange(Math.round(s), Math.round(e)),
    [onChange],
  );

  const emitSeek = useCallback(
    (ms: number) => onSeek?.(Math.round(ms)),
    [onSeek],
  );

  const startGesture = Gesture.Pan()
    .hitSlop({ top: 20, bottom: 20, left: 16, right: 16 })
    .onBegin(() => {
      'worklet';
      originMs.value = startVal.value;
    })
    .onUpdate((e) => {
      'worklet';
      if (trackWidth.value <= 0 || durationMs <= 0) return;
      const pxPerMs = trackWidth.value / durationMs;
      const newStart = originMs.value + e.translationX / pxPerMs;
      const clamped = Math.max(0, Math.min(newStart, endVal.value - MIN_RANGE_MS));
      startVal.value = clamped;
      runOnJS(emitChange)(clamped, endVal.value);
      runOnJS(emitSeek)(clamped);
    });

  const endGesture = Gesture.Pan()
    .hitSlop({ top: 20, bottom: 20, left: 16, right: 16 })
    .onBegin(() => {
      'worklet';
      originMs.value = endVal.value;
    })
    .onUpdate((e) => {
      'worklet';
      if (trackWidth.value <= 0 || durationMs <= 0) return;
      const pxPerMs = trackWidth.value / durationMs;
      const newEnd = originMs.value + e.translationX / pxPerMs;
      const clamped = Math.min(durationMs, Math.max(newEnd, startVal.value + MIN_RANGE_MS));
      endVal.value = clamped;
      runOnJS(emitChange)(startVal.value, clamped);
      runOnJS(emitSeek)(clamped);
    });

  // Animated styles driven by shared values for smooth 60fps updates
  const startHandleStyle = useAnimatedStyle(() => {
    const frac = durationMs > 0 ? startVal.value / durationMs : 0;
    return { left: frac * trackWidth.value - HANDLE_WIDTH / 2 };
  });

  const endHandleStyle = useAnimatedStyle(() => {
    const frac = durationMs > 0 ? endVal.value / durationMs : 1;
    return { left: frac * trackWidth.value - HANDLE_WIDTH / 2 };
  });

  const activeRegionStyle = useAnimatedStyle(() => {
    const sf = durationMs > 0 ? startVal.value / durationMs : 0;
    const ef = durationMs > 0 ? endVal.value / durationMs : 1;
    return { left: sf * trackWidth.value, width: (ef - sf) * trackWidth.value };
  });

  const leftInactiveStyle = useAnimatedStyle(() => {
    const sf = durationMs > 0 ? startVal.value / durationMs : 0;
    return { width: sf * trackWidth.value };
  });

  const rightInactiveStyle = useAnimatedStyle(() => {
    const ef = durationMs > 0 ? endVal.value / durationMs : 1;
    return { width: (1 - ef) * trackWidth.value };
  });

  const playheadStyle = useAnimatedStyle(() => {
    const frac = durationMs > 0 ? playheadMs.value / durationMs : 0;
    return { left: frac * trackWidth.value - StyleSheet.hairlineWidth / 2 };
  });

  return (
    <View style={styles.container}>
      <View style={styles.labels}>
        <Text style={styles.labelText}>{formatTime(startMs)}</Text>
        <Text style={styles.durationText}>{formatTime(endMs - startMs)}</Text>
        <Text style={styles.labelText}>{formatTime(endMs)}</Text>
      </View>
      <View
        style={styles.track}
        onLayout={(e) => { trackWidth.value = e.nativeEvent.layout.width; }}
      >
        <Animated.View style={[styles.inactive, styles.inactiveLeft, leftInactiveStyle]} />
        <Animated.View style={[styles.active, activeRegionStyle]} />
        <Animated.View style={[styles.inactive, styles.inactiveRight, rightInactiveStyle]} />

        <GestureDetector gesture={startGesture}>
          <Animated.View style={[styles.handle, startHandleStyle]}>
            <View style={styles.handleGrip}>
              <View style={styles.gripLine} />
              <View style={styles.gripLine} />
            </View>
          </Animated.View>
        </GestureDetector>

        <GestureDetector gesture={endGesture}>
          <Animated.View style={[styles.handle, endHandleStyle]}>
            <View style={styles.handleGrip}>
              <View style={styles.gripLine} />
              <View style={styles.gripLine} />
            </View>
          </Animated.View>
        </GestureDetector>

        <Animated.View style={[styles.playhead, playheadStyle]} pointerEvents="none" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  labels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  labelText: {
    color: '#ccc',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  durationText: {
    color: '#4FC3F7',
    fontSize: 13,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  track: {
    height: TRACK_HEIGHT,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.12)',
    position: 'relative',
    overflow: 'visible',
  },
  inactive: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  inactiveLeft: {
    left: 0,
    borderTopLeftRadius: 6,
    borderBottomLeftRadius: 6,
  },
  inactiveRight: {
    right: 0,
    borderTopRightRadius: 6,
    borderBottomRightRadius: 6,
  },
  active: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(46, 120, 183, 0.35)',
    borderTopWidth: 2,
    borderBottomWidth: 2,
    borderColor: '#4FC3F7',
  },
  handle: {
    position: 'absolute',
    top: -6,
    width: HANDLE_WIDTH,
    height: TRACK_HEIGHT + 12,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  handleGrip: {
    width: 16,
    height: 34,
    borderRadius: 5,
    backgroundColor: '#4FC3F7',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 3,
    elevation: 4,
  },
  gripLine: {
    width: 8,
    height: 2,
    borderRadius: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  playhead: {
    position: 'absolute',
    top: -2,
    bottom: -2,
    width: StyleSheet.hairlineWidth * 2,
    backgroundColor: '#fff',
    zIndex: 5,
  },
});
