import * as Haptics from 'expo-haptics';
import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS, useSharedValue } from 'react-native-reanimated';

export interface VideoTrimSliderProps {
  durationMs: number;
  startMs: number;
  endMs: number;
  /** Current playback position in ms — drives the playhead needle. */
  currentTimeMs: number;
  onChange: (start: number, end: number) => void;
  /** Called continuously while dragging so the parent can seek the video. */
  onSeek?: (ms: number) => void;
  /** Called when the user begins dragging a trim handle. */
  onScrubStart?: () => void;
  /** Called when the user releases a trim handle. */
  onScrubEnd?: () => void;
  /** When set, (end − start) cannot exceed this many milliseconds. */
  maxRangeMs?: number;
}

const HANDLE_WIDTH = 18;
const MIN_RANGE_MS = 500;
const TRACK_HEIGHT = 28;
const ZOOM_WINDOW_MS = 4000;

function formatTime(ms: number): string {
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(1)}s`;
}

export default function VideoTrimSlider({
  durationMs,
  startMs,
  endMs,
  currentTimeMs,
  onChange,
  onSeek,
  onScrubStart,
  onScrubEnd,
  maxRangeMs,
}: VideoTrimSliderProps) {
  // `trackWidth` (shared value) drives the UI-thread gesture math during a drag.
  // `measuredWidth` (React state) drives the static handle/region positions. On Android the
  // onLayout write to a shared value does not reliably re-run the animated-style worklets, so we
  // mirror the width into React state: a re-render re-creates the worklets with the real width and
  // the handles snap to the correct positions instead of collapsing to the left.
  const trackWidth = useSharedValue(0);
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const durationSv = useSharedValue(durationMs);
  const maxRangeSv = useSharedValue(typeof maxRangeMs === 'number' && maxRangeMs > 0 ? maxRangeMs : 1e15);

  const startVal = useSharedValue(startMs);
  const endVal = useSharedValue(endMs);

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
    maxRangeSv.value = typeof maxRangeMs === 'number' && maxRangeMs > 0 ? maxRangeMs : 1e15;
  }, [maxRangeMs, maxRangeSv]);

  useEffect(() => {
    startVal.value = startMs;
    prevStartClamped.value = startMs;
  }, [startMs, startVal]);
  useEffect(() => {
    endVal.value = endMs;
    prevEndClamped.value = endMs;
  }, [endMs, endVal]);

  const emitChange = useCallback(
    (s: number, e: number) => onChange(Math.round(s), Math.round(e)),
    [onChange],
  );

  const emitSeek = useCallback(
    (ms: number) => onSeek?.(Math.round(ms)),
    [onSeek],
  );

  const emitScrubStart = useCallback(() => {
    onScrubStart?.();
  }, [onScrubStart]);

  const emitScrubEnd = useCallback(() => {
    onScrubEnd?.();
  }, [onScrubEnd]);

  const hapticLight = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  const startPan = Gesture.Pan()
    .hitSlop({ top: 20, bottom: 20, left: 16, right: 16 })
    .onBegin(() => {
      'worklet';
      runOnJS(emitScrubStart)();
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
    })
    .onFinalize(() => {
      'worklet';
      runOnJS(emitScrubEnd)();
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
      runOnJS(emitScrubStart)();
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
      let clamped = Math.min(dur, Math.max(newEnd, startVal.value + MIN_RANGE_MS));
      const maxR = maxRangeSv.value;
      if (clamped - startVal.value > maxR) {
        clamped = Math.min(dur, startVal.value + maxR);
      }

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
    })
    .onFinalize(() => {
      'worklet';
      runOnJS(emitScrubEnd)();
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

  // Positions are derived as plain numbers from props + the measured width and applied as regular
  // inline styles (not reanimated animated styles). Reanimated reliably animates layout props like
  // `left`/`width` on iOS, but on Android those writes can fail to commit — the handles get stuck at
  // width 0 and the whole selection collapses to the left even though the track measured correctly.
  // The gesture already round-trips to the JS thread every frame (runOnJS(emitChange) -> parent
  // state -> re-render), so driving the visuals from React state is both deterministic and in sync
  // with the drag. The shared values above are kept solely for the UI-thread clamping math.
  const dur = durationMs > 0 ? durationMs : 1;
  const clampFrac = (n: number) => Math.min(1, Math.max(0, n));
  const startFrac = clampFrac(startMs / dur);
  const endFrac = clampFrac(endMs / dur);
  const playFrac = clampFrac(currentTimeMs / dur);
  const w = measuredWidth;
  const startHandleStyle = { left: startFrac * w - HANDLE_WIDTH / 2 };
  const endHandleStyle = { left: endFrac * w - HANDLE_WIDTH / 2 };
  const activeRegionStyle = { left: startFrac * w, width: Math.max(0, (endFrac - startFrac) * w) };
  const leftInactiveStyle = { width: startFrac * w };
  const rightInactiveStyle = { width: Math.max(0, (1 - endFrac) * w) };
  const playheadStyle = { left: playFrac * w - StyleSheet.hairlineWidth / 2 };

  const selectedDuration = formatTime(endMs - startMs);

  return (
    <View style={styles.container}>
      <View
        style={styles.track}
        // collapsable=false stops Android from flattening this view, which can otherwise suppress
        // the onLayout callback and leave trackWidth at 0 (handles collapse to the left until a
        // later re-layout snaps them into place). Ignore 0-width events so a transient measurement
        // never clobbers a good width.
        collapsable={false}
        onLayout={(e) => {
          const w = e.nativeEvent.layout.width;
          if (w > 0) {
            trackWidth.value = w;
            setMeasuredWidth((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
          }
        }}
      >
        <View style={[styles.inactive, styles.inactiveLeft, leftInactiveStyle]} />
        <View style={[styles.active, activeRegionStyle]}>
          <Text style={styles.durationBadge}>{selectedDuration}</Text>
        </View>
        <View style={[styles.inactive, styles.inactiveRight, rightInactiveStyle]} />

        <GestureDetector gesture={startGesture}>
          <View style={[styles.handle, startHandleStyle]}>
            <View style={styles.handleGrip}>
              <View style={styles.gripLine} />
              <View style={styles.gripLine} />
            </View>
          </View>
        </GestureDetector>

        <GestureDetector gesture={endGesture}>
          <View style={[styles.handle, endHandleStyle]}>
            <View style={styles.handleGrip}>
              <View style={styles.gripLine} />
              <View style={styles.gripLine} />
            </View>
          </View>
        </GestureDetector>

        <View style={[styles.playhead, playheadStyle]} pointerEvents="none" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 12,
    paddingVertical: 2,
  },
  track: {
    height: TRACK_HEIGHT,
    borderRadius: 5,
    backgroundColor: 'rgba(255,255,255,0.15)',
    position: 'relative',
    overflow: 'visible',
  },
  inactive: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  inactiveLeft: {
    left: 0,
    borderTopLeftRadius: 5,
    borderBottomLeftRadius: 5,
  },
  inactiveRight: {
    right: 0,
    borderTopRightRadius: 5,
    borderBottomRightRadius: 5,
  },
  active: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(255, 214, 10, 0.15)',
    borderTopWidth: 2,
    borderBottomWidth: 2,
    borderColor: '#FFD60A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  durationBadge: {
    color: '#FFD60A',
    fontSize: 10,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    opacity: 0.9,
  },
  handle: {
    position: 'absolute',
    top: -3,
    width: HANDLE_WIDTH,
    height: TRACK_HEIGHT + 6,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  handleGrip: {
    width: 10,
    height: TRACK_HEIGHT + 2,
    borderRadius: 3,
    backgroundColor: '#FFD60A',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  gripLine: {
    width: 5,
    height: 1.5,
    borderRadius: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  playhead: {
    position: 'absolute',
    top: -1,
    bottom: -1,
    width: StyleSheet.hairlineWidth * 2,
    backgroundColor: '#fff',
    zIndex: 5,
  },
});
