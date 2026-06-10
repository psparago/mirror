import { FontAwesome } from '@expo/vector-icons';
import React from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

export const TYPED_MESSAGE_MAX_LENGTH = 120;

export type TypedComposePaneProps = {
  typedMessage: string;
  onChangeTypedMessage: (text: string) => void;
  onCommit: () => void;
  isUploading: boolean;
  isTakeComplete: boolean;
  isKeyboardVisible: boolean;
};

/**
 * Typed-reaction compose pane. Self-contained layout: content flows normally
 * (no absolute fill) so the pane always has intrinsic height, with a fixed-height
 * input that cannot collapse regardless of what the surrounding flex chain does.
 */
export function TypedComposePane({
  typedMessage,
  onChangeTypedMessage,
  onCommit,
  isUploading,
  isTakeComplete,
  isKeyboardVisible,
}: TypedComposePaneProps) {
  if (isTakeComplete) {
    return (
      <View style={[styles.card, styles.completePane]}>
        <FontAwesome name="check-circle" size={42} color="#7dd3a8" />
        <Text style={styles.completeTitle}>Message ready</Text>
        <Text style={styles.completeHint}>
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
        <Text style={styles.title}>Type your reaction</Text>
        <TextInput
          style={styles.input}
          placeholder="Say something warm and short…"
          placeholderTextColor="rgba(255,255,255,0.4)"
          value={typedMessage}
          onChangeText={onChangeTypedMessage}
          maxLength={TYPED_MESSAGE_MAX_LENGTH}
          multiline
          textAlignVertical="top"
          editable={!isUploading}
          returnKeyType="done"
          blurOnSubmit
          onSubmitEditing={onCommit}
          scrollEnabled
        />
        <View style={styles.meta}>
          <Text style={styles.counter}>
            {typedMessage.length}/{TYPED_MESSAGE_MAX_LENGTH}
          </Text>
          {typedMessage.trim() ? (
            <Pressable
              style={styles.doneButton}
              onPress={onCommit}
              accessibilityRole="button"
              accessibilityLabel="Done typing"
            >
              <Text style={styles.doneButtonText}>
                {isKeyboardVisible ? 'Done typing' : 'Message ready'}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    // Floor so the pane stays visible even if the parent flex chain misbehaves.
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
    padding: 16,
    gap: 10,
  },
  title: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
  },
  input: {
    // Fixed height: never depends on flex distribution, so it cannot collapse.
    height: 112,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(0,0,0,0.35)',
    color: '#fff',
    fontSize: 16,
    lineHeight: 22,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  counter: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 12,
  },
  doneButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  doneButtonText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 14,
    fontWeight: '600',
  },
  completePane: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 20,
  },
  completeTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  completeHint: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
});
