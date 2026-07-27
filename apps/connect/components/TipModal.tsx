import { FontAwesome } from '@expo/vector-icons';
import React from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { TipContent } from '@/utils/tips';

type TipModalProps = {
  visible: boolean;
  content: TipContent;
  onDismiss: () => void;
};

/**
 * Lightweight tip sheet for the Connect tips system.
 * First visit auto-shows; Companions can reopen via a tip button on the screen.
 */
export function TipModal({ visible, content, onDismiss }: TipModalProps) {
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      onRequestClose={onDismiss}
      statusBarTranslucent
    >
      <View style={styles.root}>
        <Pressable style={styles.backdrop} onPress={onDismiss} accessibilityRole="button" />
        <View style={[styles.card, { marginBottom: Math.max(insets.bottom, 16) + 8 }]}>
          <View style={styles.header}>
            <View style={styles.iconWrap}>
              <FontAwesome name="lightbulb-o" size={16} color="#f5c842" />
            </View>
            <Text style={styles.title}>{content.title}</Text>
            <TouchableOpacity
              onPress={onDismiss}
              style={styles.closeBtn}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              accessibilityRole="button"
              accessibilityLabel="Close tip"
            >
              <FontAwesome name="close" size={16} color="rgba(255,255,255,0.7)" />
            </TouchableOpacity>
          </View>
          <Text style={styles.body}>{content.body}</Text>
          <TouchableOpacity
            style={styles.gotItBtn}
            onPress={onDismiss}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Got it"
          >
            <Text style={styles.gotItText}>Got it</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
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
    borderColor: 'rgba(245, 200, 66, 0.35)',
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
    backgroundColor: 'rgba(245, 200, 66, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    flex: 1,
    fontSize: 17,
    fontWeight: '700',
    color: '#f5d670',
  },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    color: 'rgba(255,255,255,0.82)',
  },
  gotItBtn: {
    marginTop: 4,
    backgroundColor: '#f39c12',
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
