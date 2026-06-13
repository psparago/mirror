import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

export interface SubtitleRibbonProps {
  /** Pre-resolved subtitle string. Null/empty → nothing rendered. */
  text: string | null;
}

/**
 * A slim, semi-transparent subtitle ribbon beneath the Activity Row.
 * Shows dynamically updated subtitle for the current chapter speaker.
 */
export function SubtitleRibbon({ text }: SubtitleRibbonProps) {
  if (!text) return null;

  return (
    <View style={styles.ribbon}>
      <Text style={styles.text} numberOfLines={2}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  ribbon: {
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  text: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.82)',
    lineHeight: 19,
  },
});
