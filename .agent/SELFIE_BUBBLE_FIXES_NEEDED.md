# Selfie Bubble & Playback Control Issues

## Current Problems
1. **Play button shows at start** - Should ONLY appear after content finishes (replay only)
2. **Video replay broken** - Tapping replay flashes pause icon then back to play, doesn't restart video
3. **Unwanted pause on video** - Tapping playing video pauses it (user doesn't want this)

## Root Causes

### Issue 1: Play Button Visibility
- `controlsOpacity` is being reset or `showControls()` is being called too early
- Excessive re-renders (see `🚀 ReflectedWatchView MOUNTED` spam in logs) may be resetting state

### Issue 2: Video Replay Race Condition  
- When `player.replay()` is called, the player status callback fires multiple times:
  1. First with `player.playing = false` → sets pause icon
  2. Then with `player.playing = true` → should start playing
- But the state updates are racing and the UI shows the wrong state

### Issue 3: Pause Functionality Not Wanted
- Main media container has `onPress={playDescription}` which calls `toggleVideo()`
- `toggleVideo()` has pause logic that user doesn't want

## Solutions Needed

### Fix 1: Ensure Controls Start Hidden
**File**: `/Users/petersparago/code/ProjectMirror/apps/cole/components/ReflectedWatchView.tsx`
**Line**: ~118

Change:
```typescript
const controlsOpacity = useRef(new Animated.Value(1)).current;
```

To:
```typescript
const controlsOpacity = useRef(new Animated.Value(0)).current; // Hidden on load
```

### Fix 2: Prevent Early showControls() Calls
Add logging to track when `showControls()` is being called during initial load:
```typescript
const showControls = useCallback(() => {
  console.log('🎮 showControls called', new Error().stack);
  Animated.timing(controlsOpacity, {
    toValue: 1,
    duration: 200,
    useNativeDriver: true,
  }).start();
}, [controlsOpacity]);
```

### Fix 3: Fix Video Replay - Update Player Callback
**File**: `/Users/petersparago/code/ProjectMirror/apps/cole/components/ReflectedWatchView.tsx`
**Line**: ~87-101

Current callback updates `isVideoPlaying` immediately on every status change. Need to add logic:

```typescript
const player = useVideoPlayer(videoSource || '', (player) => {
  // Status update callback
  setIsVideoPlaying(player.playing);
  
  // Hide controls when playing starts
  if (player.playing) {
    isReplayingRef.current = false;
    hideControls(); // ADD THIS
  }

  // Show controls when paused (but not during replay transition)
  if (!player.playing && player.status !== 'idle' && !isReplayingRef.current) {
    showControls(); // ADD THIS
  }

  // Check if video finished
  if (player.status === 'idle' && player.currentTime > 0 && !videoFinishedRef.current && !isReplayingRef.current) {
    console.log('🛑 Video Finished detected in player callback');
    handleVideoFinished();
  }
});
```

### Fix 4: Remove Pause Functionality from Main Touch Area
**File**: `/Users/petersparago/code/ProjectMirror/apps/cole/components/ReflectedWatchView.tsx`
**Line**: ~920-964

Change the main `TouchableOpacity` (Media Container) to only handle replay, not pause:

```typescript
<TouchableOpacity
  style={styles.mediaContainer}
  activeOpacity={1}
  onPress={() => {
    // Only allow interaction for REPLAY when video is finished
    if (selectedMetadata?.content_type === 'video') {
      if (videoFinished) {
        playDescription(); // This will call toggleVideo which handles replay
      }
      // Do nothing if video is playing - no pause
    } else {
      playDescription(); // Photos/Audio can always replay
    }
  }}
>
```

### Fix 5: Simplify toggleVideo - Remove Pause Logic
**File**: `/Users/petersparago/code/ProjectMirror/apps/cole/components/ReflectedWatchView.tsx`
**Line**: ~648-673

```typescript
const toggleVideo = useCallback(async () => {
  if (!player) return;
  
  // Only handle replay of finished videos
  if (videoFinished) {
    console.log('🔄 Replaying Video');
    isReplayingRef.current = true;
    videoFinishedRef.current = false;
    setVideoFinished(false);
    player.replay();
    // Player callback will handle hiding controls when playing starts
    return;
  }
  
  // Remove pause logic entirely - videos just play
  if (!isVideoPlaying) {
    player.play();
  }
}, [player, isVideoPlaying, videoFinished]);
```

### Fix 6: Debug Excessive Re-renders
The logs show constant `🚀 ReflectedWatchView MOUNTED` messages. This suggests the component is unmounting/remounting repeatedly, which would reset all state including `controlsOpacity`.

Check the parent component (`apps/cole/app/(tabs)/index.tsx`) for:
- Conditional rendering of `ReflectedWatchView`
- Props that change too frequently
- Missing `useMemo` or `useCallback` on passed functions

## Testing Checklist
- [ ] Play button is hidden on initial load (2s delay, then auto-play)
- [ ] Play button appears ONLY after content finishes (photo sequence or video end)
- [ ] Tapping replay button on finished video restarts it
- [ ] Tapping anywhere on a PLAYING video does nothing (no pause)
- [ ] Photo replay works correctly
- [ ] Selfie bubble appears and persists correctly for videos
- [ ] No excessive re-renders in logs

## Priority
**HIGH** - This is blocking user workflow and has been an issue for over an hour.

## Notes
- Consider killing Metro bundler and clearing all caches: `./scripts/run-lg.sh` after `npx expo start -c`
- The version tag `v678` never incremented, suggesting hot reload might not be working
- May need full app restart on device, not just reload
