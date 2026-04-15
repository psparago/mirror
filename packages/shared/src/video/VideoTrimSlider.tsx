import * as Haptics from 'expo-haptics';
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
const ZOOM_WINDOW_MS = 4000;

function formatTime(ms: number): string {
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(1)}s`;
}

export default function VideoTrimSlider({ durationMs, startMs, endMs, currentTimeMs, onChange, onSeek }: VideoTrimSliderProps) {
  const trackWidth = useSharedValue(0);
  const durationSv = useSharedValue(durationMs);

  const startVal = useSharedValue(startMs);
  const endVal = useSharedValue(endMs);
  const playheadMs = useSharedValue(currentTimeMs);

  const originMs = useSharedValue(0);
  const isZoomedStart = useSharedValue(false);
  const isZoomedEnd = useSharedValue(false);
  /** When zoomed, track maps linearly to [zoom*Ws, zoom*We] (±2s around handle, clipped). */
  const zoomStartWs = useSharedValue(0);
  const zoomStartWe = useSharedValue(0);
  const zoomEndWs = useSharedValue(0);
  const zoomEndWe = useSharedValue(0);

  const prevStartClamped = useSharedValue(startMs);
  const prevEndClamped = useSharedValue(endMs);

  useEffect(() => {
    durationSv.value = durationMs;
  }, [durationMs, durationSv]);

  useEffect(() => {
    startVal.value = startMs;
    prevStartClamped.value = startMs;
  }, [startMs, startVal]);
  useEffect(() => {
    endVal.value = endMs;
    prevEndClamped.value = endMs;
  }, [endMs, endVal]);
  useEffect(() => {
    playheadMs.value = currentTimeMs;
  }, [currentTimeMs, playheadMs]);

  const emitChange = useCallback(
    (s: number, e: number) => onChange(Math.round(s), Math.round(e)),
    [onChange],
  );

  const emitSeek = useCallback(
    (ms: number) => onSeek?.(Math.round(ms)),
    [onSeek],
  );

  const hapticLight = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  const startPan = Gesture.Pan()
    .hitSlop({ top: 20, bottom: 20, left: 16, right: 16 })
    .onBegin(() => {
      'worklet';
      originMs.value = startVal.value;
      prevStartClamped.value = startVal.value;
    })
    .onUpdate((e) => {
      'worklet';
      const dur = durationSv.value;
      if (trackWidth.value <= 0 || dur <= 0) return;
      const tw = trackWidth.value;
      const winMs = isZoomedStart.value
        ? Math.max(1, zoomStartWe.value - zoomStartWs.value)
        : dur;
      const pxPerMs = tw / winMs;
      const newStart = originMs.value + e.translationX / pxPerMs;
      const clamped = Math.max(0, Math.min(newStart, endVal.value - MIN_RANGE_MS));

      const hitZero = clamped <= 0.5;
      const hitMinRange = clamped >= endVal.value - MIN_RANGE_MS - 0.5;
      const wasZero = prevStartClamped.value <= 0.5;
      const wasMinRange = prevStartClamped.value >= endVal.value - MIN_RANGE_MS - 0.5;
      if ((hitZero && !wasZero) || (hitMinRange && !wasMinRange)) {
        runOnJS(hapticLight)();
      }
      prevStartClamped.value = clamped;

      startVal.value = clamped;
      runOnJS(emitChange)(clamped, endVal.value);
      runOnJS(emitSeek)(clamped);
    });

  const startLongPress = Gesture.LongPress()
    .minDuration(420)
    .onStart(() => {
      'worklet';
      const d = durationSv.value;
      const c = startVal.value;
      const win = Math.min(ZOOM_WINDOW_MS, d);
      let ws = c - win / 2;
      if (ws < 0) ws = 0;
      if (ws + win > d) ws = Math.max(0, d - win);
      const we = Math.min(d, ws + win);
      zoomStartWs.value = ws;
      zoomStartWe.value = we;
      isZoomedStart.value = true;
    })
    .onFinalize(() => {
      'worklet';
      isZoomedStart.value = false;
    });

  const startGesture = Gesture.Simultaneous(startLongPress, startPan);

  const endPan = Gesture.Pan()
    .hitSlop({ top: 20, bottom: 20, left: 16, right: 16 })
    .onBegin(() => {
      'worklet';
      originMs.value = endVal.value;
      prevEndClamped.value = endVal.value;
    })
    .onUpdate((e) => {
      'worklet';
      const dur = durationSv.value;
      if (trackWidth.value <= 0 || dur <= 0) return;
      const tw = trackWidth.value;
      const winMs = isZoomedEnd.value ? Math.max(1, zoomEndWe.value - zoomEndWs.value) : dur;
      const pxPerMs = tw / winMs;
      const newEnd = originMs.value + e.translationX / pxPerMs;
      const clamped = Math.min(dur, Math.max(newEnd, startVal.value + MIN_RANGE_MS));

      const hitDuration = clamped >= dur - 0.5;
      const hitMinRange = clamped <= startVal.value + MIN_RANGE_MS + 0.5;
      const wasDuration = prevEndClamped.value >= dur - 0.5;
      const wasMinRange = prevEndClamped.value <= startVal.value + MIN_RANGE_MS + 0.5;
      if ((hitDuration && !wasDuration) || (hitMinRange && !wasMinRange)) {
        runOnJS(hapticLight)();
      }
      prevEndClamped.value = clamped;

      endVal.value = clamped;
      runOnJS(emitChange)(startVal.value, clamped);
      runOnJS(emitSeek)(clamped);
    });

  const endLongPress = Gesture.LongPress()
    .minDuration(420)
    .onStart(() => {
      'worklet';
      const d = durationSv.value;
      const c = endVal.value;
      const win = Math.min(ZOOM_WINDOW_MS, d);
      let ws = c - win / 2;
      if (ws < 0) ws = 0;
      if (ws + win > d) ws = Math.max(0, d - win);
      const we = Math.min(d, ws + win);
      zoomEndWs.value = ws;
      zoomEndWe.value = we;
      isZoomedEnd.value = true;
    })
    .onFinalize(() => {
      'worklet';
      isZoomedEnd.value = false;
    });

  const endGesture = Gesture.Simultaneous(endLongPress, endPan);

  const startHandleStyle = useAnimatedStyle(() => {
    const dur = durationSv.value;
    const frac = dur > 0 ? startVal.value / dur : 0;
    return { left: frac * trackWidth.value - HANDLE_WIDTH / 2 };
  });

  const endHandleStyle = useAnimatedStyle(() => {
    const dur = durationSv.value;
    const frac = dur > 0 ? endVal.value / dur : 1;
    return { left: frac * trackWidth.value - HANDLE_WIDTH / 2 };
  });

  const activeRegionStyle = useAnimatedStyle(() => {
    const dur = durationSv.value;
    const sf = dur > 0 ? startVal.value / dur : 0;
    const ef = dur > 0 ? endVal.value / dur : 1;
    return { left: sf * trackWidth.value, width: (ef - sf) * trackWidth.value };
  });

  const leftInactiveStyle = useAnimatedStyle(() => {
    const dur = durationSv.value;
    const sf = dur > 0 ? startVal.value / dur : 0;
    return { width: sf * trackWidth.value };
  });

  const rightInactiveStyle = useAnimatedStyle(() => {
    const dur = durationSv.value;
    const ef = dur > 0 ? endVal.value / dur : 1;
    return { width: (1 - ef) * trackWidth.value };
  });

  const playheadStyle = useAnimatedStyle(() => {
    const dur = durationSv.value;
    const frac = dur > 0 ? playheadMs.value / dur : 0;
    return { left: frac * trackWidth.value - StyleSheet.hairlineWidth / 2 };
  });

  return (
    <View style={styles.container}>
      <View style={styles.labels}>
        <Text style={styles.labelText}>{formatTime(startMs)}</Text>
        <Text style={styles.durationText}>{formatTime(endMs - startMs)}</Text>
        <Text style={styles.labelText}>{formatTime(endMs)}</Text>
      </View>
      <Text style={styles.zoomHint}>Hold a handle — track maps to ±2s around it for fine edits</Text>
      <View
        style={styles.track}
        onLayout={(e) => {
          trackWidth.value = e.nativeEvent.layout.width;
        }}
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
    marginBottom: 4,
  },
  zoomHint: {
    color: 'rgba(255,255,255,0.35)',
    fontSize: 11,
    textAlign: 'center',
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
