import { FontAwesome } from '@expo/vector-icons';
import React from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { TipContent } from '@/utils/tips';

export type TipModalVariant = 'tip' | 'whats_new' | 'system';

type TipModalProps = {
  visible: boolean;
  content: TipContent;
  onDismiss: () => void;
  /** Visual cue: tip/whats_new = lightbulb gold; system = bullhorn coral. */
  variant?: TipModalVariant;
};

const VARIANT_THEME: Record<
  TipModalVariant,
  { icon: React.ComponentProps<typeof FontAwesome>['name']; accent: string; accentSoft: string; title: string; button: string }
> = {
  tip: {
    icon: 'lightbulb-o',
    accent: '#f5c842',
    accentSoft: 'rgba(245, 200, 66, 0.15)',
    title: '#f5d670',
    button: '#f39c12',
  },
  whats_new: {
    icon: 'lightbulb-o',
    accent: '#f5c842',
    accentSoft: 'rgba(245, 200, 66, 0.15)',
    title: '#f5d670',
    button: '#f39c12',
  },
  system: {
    icon: 'bullhorn',
    accent: '#fb923c',
    accentSoft: 'rgba(251, 146, 60, 0.18)',
    title: '#fdba74',
    button: '#ea580c',
  },
};

/**
 * Lightweight tip / announcement sheet for Connect.
 * Uses an absolute View overlay (not RN Modal) so navigation / ImagePicker
 * cannot hang when a tip is mid-present or the host unmounts.
 */
export function TipModal({
  visible,
  content,
  onDismiss,
  variant = 'tip',
}: TipModalProps) {
  const insets = useSafeAreaInsets();
  const theme = VARIANT_THEME[variant];

  if (!visible) return null;

  return (
    <View style={styles.root} pointerEvents="box-none">
      <Pressable style={styles.backdrop} onPress={onDismiss} accessibilityRole="button" />
      <View
        style={[
          styles.card,
          { borderColor: theme.accent + '59', marginBottom: Math.max(insets.bottom, 16) + 8 },
        ]}
      >
        <View style={styles.header}>
          <View style={[styles.iconWrap, { backgroundColor: theme.accentSoft }]}>
            <FontAwesome name={theme.icon} size={16} color={theme.accent} />
          </View>
          <Text style={[styles.title, { color: theme.title }]}>{content.title}</Text>
          <TouchableOpacity
            onPress={onDismiss}
            style={styles.closeBtn}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <FontAwesome name="close" size={16} color="rgba(255,255,255,0.7)" />
          </TouchableOpacity>
        </View>
        <ScrollView style={styles.bodyScroll} showsVerticalScrollIndicator={false}>
          <Text style={styles.body}>{content.body}</Text>
        </ScrollView>
        <TouchableOpacity
          style={[styles.gotItBtn, { backgroundColor: theme.button }]}
          onPress={onDismiss}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Got it"
        >
          <Text style={styles.gotItText}>Got it</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1000,
    elevation: 1000,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  card: {
    backgroundColor: '#1a2332',
    borderRadius: 16,
    borderWidth: 1,
    padding: 18,
    gap: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    flex: 1,
    fontSize: 17,
    fontWeight: '700',
  },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bodyScroll: {
    maxHeight: 280,
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    color: 'rgba(255,255,255,0.82)',
  },
  gotItBtn: {
    marginTop: 4,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  gotItText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
});
