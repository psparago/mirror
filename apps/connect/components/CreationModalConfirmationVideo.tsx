import { FontAwesome } from '@expo/vector-icons';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useEffect } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

type Props = {
  videoUri: string;
  ended: boolean;
  onEndedChange: (ended: boolean) => void;
};

/**
 * Confirmation-step video preview only. Mount this **only** while the user is on the
 * pre-composer confirmation screen so `ReflectionComposer` can be the sole owner of
 * a `VideoPlayer` for the same file on Android.
 */
export function CreationModalConfirmationVideo({ videoUri, ended, onEndedChange }: Props) {
  const videoPlayer = useVideoPlayer(videoUri, (p) => {
    p.loop = false;
  });

  useEffect(() => {
    onEndedChange(false);
    videoPlayer.loop = false;
    try {
      videoPlayer.replace(videoUri);
    } catch {
      /* ignore */
    }
    const raf = requestAnimationFrame(() => {
      try {
        videoPlayer.play();
      } catch {
        /* ignore */
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [videoUri, videoPlayer, onEndedChange]);

  useEffect(() => {
    const subPlayToEnd = videoPlayer.addListener('playToEnd', () => {
      onEndedChange(true);
    });
    const subPlaying = videoPlayer.addListener(
      'playingChange',
      ({ isPlaying }: { isPlaying: boolean }) => {
        if (isPlaying) return;
        const duration = videoPlayer.duration;
        if (!(duration > 0)) return;
        const epsilon = Math.min(0.45, Math.max(0.06, duration * 0.12));
        if (videoPlayer.currentTime >= duration - epsilon) {
          onEndedChange(true);
        }
      },
    );
    return () => {
      subPlayToEnd.remove();
      subPlaying.remove();
    };
  }, [videoPlayer, onEndedChange]);

  const handleReplay = () => {
    onEndedChange(false);
    try {
      videoPlayer.replace(videoUri);
    } catch {
      /* ignore */
    }
    try {
      videoPlayer.currentTime = 0;
      videoPlayer.play();
    } catch {
      /* ignore */
    }
  };

  return (
    <>
      <VideoView
        player={videoPlayer}
        style={StyleSheet.absoluteFill}
        contentFit="contain"
        nativeControls={false}
      />
      <TouchableOpacity
        style={styles.confirmVideoReplayFab}
        onPress={handleReplay}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel="Replay video"
      >
        <FontAwesome name="repeat" size={16} color="#fff" />
        <Text style={styles.confirmVideoReplayFabText}>Replay</Text>
      </TouchableOpacity>
      {ended ? (
        <View style={styles.confirmReplayOverlay} pointerEvents="box-none">
          <TouchableOpacity
            style={styles.confirmReplayButton}
            onPress={handleReplay}
            activeOpacity={0.85}
          >
            <FontAwesome name="repeat" size={28} color="#fff" />
            <Text style={styles.confirmReplayText}>Replay</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  confirmReplayOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 5,
  },
  confirmReplayButton: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.4)',
  },
  confirmReplayText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  confirmVideoReplayFab: {
    position: 'absolute',
    top: 12,
    right: 12,
    zIndex: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  confirmVideoReplayFabText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
});
