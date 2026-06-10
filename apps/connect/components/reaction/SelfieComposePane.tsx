import { FontAwesome } from '@expo/vector-icons';
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

export type SelfieComposePaneProps = {
  isSaving: boolean;
  isTakeComplete: boolean;
  isCameraDenied: boolean;
  canAskAgain: boolean | undefined;
  isImageParent: boolean;
  onGrantCameraAccess: () => void;
};

/**
 * Selfie-mode hint/status pane (the strip under the parent Reflection).
 * The persistent CameraView PIP itself stays in ReactionSheet, rendered over the
 * parent media surface, so it is never remounted by mode or stage changes.
 */
export function SelfieComposePane({
  isSaving,
  isTakeComplete,
  isCameraDenied,
  canAskAgain,
  isImageParent,
  onGrantCameraAccess,
}: SelfieComposePaneProps) {
  return (
    <View style={styles.card}>
      {isSaving ? (
        <View style={styles.statusPane}>
          <ActivityIndicator color="#fff" size="large" />
          <Text style={styles.statusTitle}>Saving reaction…</Text>
          <Text style={styles.statusHint}>Hang tight while we finish your recording.</Text>
        </View>
      ) : isTakeComplete ? (
        <View style={styles.statusPane}>
          <FontAwesome name="check-circle" size={42} color="#7dd3a8" />
          <Text style={styles.statusTitle}>Reaction recorded</Text>
          <Text style={styles.statusHint}>
            Preview how Companions will see it, or retake if you want another try.
          </Text>
        </View>
      ) : isCameraDenied ? (
        <View style={styles.permissionPane}>
          <Text style={styles.permissionText}>
            Camera access is required to record a selfie reaction.
          </Text>
          <Pressable style={styles.permissionButton} onPress={onGrantCameraAccess}>
            <Text style={styles.permissionButtonText}>
              {canAskAgain === false ? 'Open Settings' : 'Grant Camera Access'}
            </Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.hintContent}>
          <FontAwesome name="video-camera" size={28} color="#fff" />
          <Text style={styles.hintTitle}>Hold to react</Text>
          <Text style={styles.hintText}>
            {isImageParent
              ? 'While you hold the button, your selfie appears in the corner — just like Companions will see it.'
              : 'While you hold the button, the Reflection plays and your selfie appears in the corner.'}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    minHeight: 120,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#101820',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  hintContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    gap: 8,
  },
  hintTitle: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
  },
  hintText: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: 4,
    maxWidth: '100%',
  },
  statusPane: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 20,
  },
  statusTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  statusHint: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
  permissionPane: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 16,
  },
  permissionText: {
    color: '#fff',
    fontSize: 15,
    textAlign: 'center',
  },
  permissionButton: {
    backgroundColor: '#2e78b7',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 24,
  },
  permissionButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
});
