import { StyleSheet } from 'react-native';

/**
 * Shared picture-in-picture frame for the Companion selfie bubble.
 * Used by both the compose stage (live CameraView in ReactionSheet) and the
 * CompanionPreviewOverlay (recorded playback) so the two stay visually identical.
 */
export const reactionPipStyles = StyleSheet.create({
  pipFrame: {
    position: 'absolute',
    top: 14,
    right: 14,
    width: 90,
    height: 120,
    borderRadius: 11,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.4)',
    backgroundColor: '#000',
    zIndex: 5,
  },
});
