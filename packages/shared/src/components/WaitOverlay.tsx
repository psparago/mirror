import React from 'react';
import {
  ActivityIndicator,
  StyleProp,
  StyleSheet,
  Text,
  TextStyle,
  TouchableOpacity,
  View,
  ViewStyle,
} from 'react-native';

type WaitOverlayTone = 'default' | 'sparkle' | 'upload' | 'media';

export type WaitOverlayProps = {
  title: string;
  detail?: string;
  icon?: React.ReactNode;
  progress?: number | null;
  hint?: string;
  isLoading?: boolean;
  actionLabel?: string;
  onAction?: () => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
  tone?: WaitOverlayTone;
  containerStyle?: StyleProp<ViewStyle>;
  cardStyle?: StyleProp<ViewStyle>;
  titleStyle?: StyleProp<TextStyle>;
};

const toneColors: Record<WaitOverlayTone, { accent: string; iconBg: string; iconBorder: string }> = {
  default: {
    accent: '#f39c12',
    iconBg: 'rgba(59, 130, 246, 0.22)',
    iconBorder: 'rgba(191, 219, 254, 0.45)',
  },
  sparkle: {
    accent: '#f39c12',
    iconBg: 'rgba(245, 200, 66, 0.18)',
    iconBorder: 'rgba(245, 200, 66, 0.42)',
  },
  upload: {
    accent: '#f39c12',
    iconBg: 'rgba(59, 130, 246, 0.22)',
    iconBorder: 'rgba(191, 219, 254, 0.45)',
  },
  media: {
    accent: '#4FC3F7',
    iconBg: 'rgba(79, 195, 247, 0.18)',
    iconBorder: 'rgba(79, 195, 247, 0.42)',
  },
};

export function WaitOverlay({
  title,
  detail,
  icon,
  progress,
  hint,
  isLoading = true,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
  tone = 'default',
  containerStyle,
  cardStyle,
  titleStyle,
}: WaitOverlayProps) {
  const colors = toneColors[tone];
  const normalizedProgress =
    typeof progress === 'number' && Number.isFinite(progress)
      ? Math.max(0, Math.min(1, progress))
      : null;

  return (
    <View style={[styles.container, containerStyle]}>
      <View style={[styles.card, cardStyle]}>
        {icon ? (
          <View
            style={[
              styles.iconWrap,
              { backgroundColor: colors.iconBg, borderColor: colors.iconBorder },
            ]}
          >
            {icon}
          </View>
        ) : null}
        {isLoading ? <ActivityIndicator color={colors.accent} size="large" /> : null}
        <Text style={[styles.title, { color: colors.accent }, titleStyle]}>{title}</Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
        {normalizedProgress !== null ? (
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                {
                  backgroundColor: colors.accent,
                  width: `${Math.max(10, Math.round(normalizedProgress * 100))}%`,
                },
              ]}
            />
          </View>
        ) : null}
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
        {(actionLabel && onAction) || (secondaryActionLabel && onSecondaryAction) ? (
          <View style={styles.actionRow}>
            {secondaryActionLabel && onSecondaryAction ? (
              <TouchableOpacity
                style={[styles.actionButton, styles.secondaryActionButton]}
                onPress={onSecondaryAction}
                activeOpacity={0.8}
              >
                <Text style={styles.secondaryActionText}>{secondaryActionLabel}</Text>
              </TouchableOpacity>
            ) : null}
            {actionLabel && onAction ? (
              <TouchableOpacity style={styles.actionButton} onPress={onAction} activeOpacity={0.8}>
                <Text style={styles.actionText}>{actionLabel}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 20,
  },
  card: {
    width: '86%',
    maxWidth: 360,
    alignItems: 'center',
    borderRadius: 24,
    paddingVertical: 28,
    paddingHorizontal: 24,
    backgroundColor: 'rgba(15, 23, 42, 0.96)',
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.45)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.26,
    shadowRadius: 18,
    elevation: 10,
    gap: 12,
  },
  iconWrap: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  detail: {
    color: '#cbd5e1',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
  progressTrack: {
    width: '100%',
    height: 5,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: 'rgba(148, 163, 184, 0.22)',
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
  },
  hint: {
    color: 'rgba(255,255,255,0.82)',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
  actionRow: {
    marginTop: 8,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10,
    flexWrap: 'wrap',
  },
  actionButton: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(191, 219, 254, 0.6)',
    backgroundColor: 'rgba(59, 130, 246, 0.18)',
  },
  actionText: {
    color: '#e2e8f0',
    fontSize: 14,
    fontWeight: '700',
  },
  secondaryActionButton: {
    backgroundColor: 'rgba(15, 23, 42, 0.64)',
    borderColor: 'rgba(148, 163, 184, 0.45)',
  },
  secondaryActionText: {
    color: '#cbd5e1',
    fontSize: 14,
    fontWeight: '700',
  },
});
