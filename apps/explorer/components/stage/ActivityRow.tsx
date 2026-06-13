import type { DocumentaryChapter } from '@projectmirror/shared';
import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { ActivityAvatar } from './ActivityAvatar';

export interface ActivityRowProps {
  chapters: DocumentaryChapter[];
  activeIndex: number;
  /** When true, inactive avatars blur. When false (idle/complete), all avatars are crisp. */
  isPlayingSequence: boolean;
  onAvatarPress: (index: number) => void;
}

/**
 * Horizontal row of speaker avatars beneath the main stage.
 * Chapter 0 = base Reflection author; 1…n = Companion reactions.
 * Only renders when there are 2+ chapters (base + at least one reaction).
 */
export function ActivityRow({ chapters, activeIndex, isPlayingSequence, onAvatarPress }: ActivityRowProps) {
  if (chapters.length < 2) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.content}
      style={styles.container}
    >
      {chapters.map((chapter) => (
        <ActivityAvatar
          key={chapter.index}
          chapter={chapter}
          isActive={chapter.index === activeIndex}
          isPlaying={isPlayingSequence}
          onPress={() => onAvatarPress(chapter.index)}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    maxHeight: 96,
  },
  content: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
});
