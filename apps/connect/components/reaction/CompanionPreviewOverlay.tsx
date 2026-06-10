import { formatTypedReactionSpeechText } from '@/utils/reactionPlayback';
import type { ReactionType } from '@projectmirror/shared';
import { ResizeMode, Video, type AVPlaybackStatus } from 'expo-av';
import { Image } from 'expo-image';
import { VideoView, type VideoPlayer } from 'expo-video';
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { reactionPipStyles } from './reactionPipStyles';

type CompanionAvatarInfo = {
  avatarUrl?: string | null;
  color?: string | null;
  initial?: string | null;
  companionName?: string | null;
};

export type CompanionPreviewOverlayProps = {
  reactionMode: ReactionType;
  isVideoParent: boolean;
  isImageParent: boolean;
  parentVideoUrl: string;
  parentImageUrl: string;
  /** Owned by ReactionSheet — playback is driven by the preview pipeline there. */
  parentRef: React.RefObject<Video>;
  parentMuted: boolean;
  parentVolume: number;
  onParentStatusUpdate: (status: AVPlaybackStatus) => void;
  recordedUri: string | null;
  /** Owned by ReactionSheet (useVideoPlayer) — rendering only here. */
  selfiePlayer: VideoPlayer;
  companionAvatar: CompanionAvatarInfo | null | undefined;
  typedMessage: string;
  typedPreviewLoading: boolean;
  sendHint: boolean;
};

/**
 * Full-screen "how Companions will see it" preview stage. Pure render layer:
 * all playback state machines stay in ReactionSheet and are passed in as props.
 */
export function CompanionPreviewOverlay({
  reactionMode,
  isVideoParent,
  isImageParent,
  parentVideoUrl,
  parentImageUrl,
  parentRef,
  parentMuted,
  parentVolume,
  onParentStatusUpdate,
  recordedUri,
  selfiePlayer,
  companionAvatar,
  typedMessage,
  typedPreviewLoading,
  sendHint,
}: CompanionPreviewOverlayProps) {
  const hintText = sendHint
    ? 'Preview could not play, but your recording is saved. Tap Send to share it, or Replay to try again.'
    : reactionMode === 'voice'
      ? isVideoParent
        ? 'Your voice and the Reflection play together and stop when your message ends.'
        : 'This is how your reaction will look. Your voice plays while the Reflection runs softly in the background.'
      : reactionMode === 'typed'
        ? 'This is how your reaction will look. Your message is read in your AI voice while the Reflection plays softly in the background.'
        : reactionMode === 'selfie' && (isVideoParent || isImageParent)
          ? 'This is how your Companions will see your reaction. The Reflection fills the screen; your selfie plays in the corner.'
          : 'This is how your Companions will see your reaction on this photo.';

  const renderAvatarPip = () => (
    <View style={[reactionPipStyles.pipFrame, styles.avatarPip]}>
      {companionAvatar?.avatarUrl ? (
        <Image
          source={{ uri: companionAvatar.avatarUrl }}
          style={styles.avatarImage}
          contentFit="cover"
        />
      ) : (
        <View
          style={[
            styles.avatarFallback,
            { backgroundColor: companionAvatar?.color ?? '#4FC3F7' },
          ]}
        >
          <Text style={styles.avatarInitial}>{companionAvatar?.initial ?? '?'}</Text>
        </View>
      )}
    </View>
  );

  return (
    <View style={[styles.stage, styles.overlay]}>
      <View style={styles.frame}>
        {isVideoParent ? (
          <Video
            ref={parentRef}
            source={{ uri: parentVideoUrl }}
            style={styles.mainMedia}
            resizeMode={ResizeMode.CONTAIN}
            shouldPlay={false}
            isLooping={false}
            isMuted={parentMuted}
            volume={parentVolume}
            progressUpdateIntervalMillis={100}
            onPlaybackStatusUpdate={onParentStatusUpdate}
          />
        ) : (
          <Image source={{ uri: parentImageUrl }} style={styles.mainMedia} contentFit="contain" />
        )}
        {reactionMode === 'selfie' && recordedUri ? (
          <VideoView
            player={selfiePlayer}
            style={reactionPipStyles.pipFrame}
            contentFit="cover"
            nativeControls={false}
            allowsFullscreen={false}
            pointerEvents="none"
          />
        ) : (
          renderAvatarPip()
        )}
        {reactionMode === 'typed' && typedMessage.trim() ? (
          <View style={styles.captionBar}>
            <Text style={styles.captionText} numberOfLines={4}>
              {formatTypedReactionSpeechText(
                companionAvatar?.companionName || 'Companion',
                typedMessage.trim(),
              )}
            </Text>
          </View>
        ) : null}
        {typedPreviewLoading ? (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator color="#fff" size="large" />
            <Text style={styles.loadingText}>Generating AI voice…</Text>
          </View>
        ) : null}
      </View>
      <Text style={sendHint ? styles.sendHintText : styles.hintText}>{hintText}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
    zIndex: 30,
  },
  stage: {
    flex: 1,
    minHeight: 0,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  frame: {
    flex: 1,
    minHeight: 0,
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: '#1a3a44',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  mainMedia: {
    width: '100%',
    height: '100%',
    backgroundColor: '#101820',
  },
  avatarPip: {
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarImage: {
    width: '100%',
    height: '100%',
  },
  avatarFallback: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    color: '#fff',
    fontSize: 36,
    fontWeight: '700',
  },
  captionBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: 'rgba(0,0,0,0.62)',
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
  },
  captionText: {
    color: '#fff',
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  loadingText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 14,
    fontWeight: '600',
    marginTop: 10,
  },
  hintText: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 12,
    textAlign: 'center',
    paddingHorizontal: 12,
    paddingTop: 10,
  },
  sendHintText: {
    color: 'rgba(255, 214, 120, 0.95)',
    fontSize: 13,
    textAlign: 'center',
    paddingHorizontal: 16,
    paddingTop: 10,
    lineHeight: 18,
    fontWeight: '500',
  },
});
