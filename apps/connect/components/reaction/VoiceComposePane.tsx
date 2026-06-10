import { FontAwesome } from '@expo/vector-icons';
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

export type VoiceComposePaneProps = {
  isProcessing: boolean;
  isTakeComplete: boolean;
  isRecording: boolean;
  isStarting: boolean;
  isUploading: boolean;
  hint: string;
  onStartRecording: () => void;
  onStopRecording: () => void;
};

/**
 * Voice-reaction compose pane. Self-contained layout: content flows normally
 * (no absolute fill) with a minHeight floor so the recorder can never collapse
 * out of view regardless of the surrounding flex chain.
 */
export function VoiceComposePane({
  isProcessing,
  isTakeComplete,
  isRecording,
  isStarting,
  isUploading,
  hint,
  onStartRecording,
  onStopRecording,
}: VoiceComposePaneProps) {
  if (isProcessing) {
    return (
      <View style={[styles.card, styles.statusPane]}>
        <ActivityIndicator color="#fff" size="large" />
        <Text style={styles.statusTitle}>Saving voice message…</Text>
        <Text style={styles.statusHint}>Processing your recording.</Text>
      </View>
    );
  }

  if (isTakeComplete) {
    return (
      <View style={[styles.card, styles.statusPane]}>
        <FontAwesome name="check-circle" size={42} color="#7dd3a8" />
        <Text style={styles.statusTitle}>Voice message ready</Text>
        <Text style={styles.statusHint}>
          Tap Preview below to see how Companions will view your reaction.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        bounces={false}
        keyboardShouldPersistTaps="handled"
      >
        <FontAwesome name="microphone" size={28} color="#fff" />
        <Text style={styles.title}>
          {isRecording ? 'Recording…' : 'Record a voice message'}
        </Text>
        <Text style={styles.hint}>{hint}</Text>
        <Pressable
          style={[styles.recordButton, isRecording && styles.recordButtonActive]}
          onPress={() => {
            if (isRecording) {
              onStopRecording();
            } else {
              onStartRecording();
            }
          }}
          disabled={isUploading || isStarting || isProcessing}
        >
          <FontAwesome name={isRecording ? 'stop' : 'microphone'} size={16} color="#fff" />
          <Text style={styles.recordButtonText}>
            {isStarting ? 'Starting…' : isRecording ? 'Stop recording' : 'Start recording'}
          </Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    // Floor so the recorder stays visible even if the parent flex chain misbehaves.
    minHeight: 180,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#101820',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    gap: 10,
  },
  title: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
  },
  hint: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: 4,
    maxWidth: '100%',
  },
  recordButton: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: 'rgba(46, 120, 183, 0.92)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  recordButtonActive: {
    backgroundColor: 'rgba(176, 32, 32, 0.95)',
    borderColor: 'rgba(255, 120, 120, 0.65)',
  },
  recordButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  statusPane: {
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
});
