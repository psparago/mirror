import React from 'react';
import { useThrottledCallback } from '../hooks/useThrottledCallback';
import {
  ActivityIndicator,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { CompanionAvatar } from '../hooks/useCompanionAvatars';

export interface AvatarFilterBarProps {
  companions: CompanionAvatar[];
  selectedId: string | null;
  onSelect: (userId: string | null) => void;
  loading?: boolean;
  currentUserId?: string;
  /** 'standard' (48px, default) for the timeline bar; 'large' (88px) for the grid browse row. */
  size?: 'standard' | 'large';
}

const AVATAR_SIZE_STANDARD = 48;
const AVATAR_SIZE_LARGE = 88;

export function AvatarFilterBar({
  companions,
  selectedId,
  onSelect,
  loading,
  currentUserId,
  size = 'standard',
}: AvatarFilterBarProps) {
  const throttledOnSelect = useThrottledCallback((userId: string | null) => {
    onSelect(userId);
  });

  const isLarge = size === 'large';
  const avatarSize = isLarge ? AVATAR_SIZE_LARGE : AVATAR_SIZE_STANDARD;
  const ringSize = avatarSize + 6;

  if (loading) {
    return (
      <View style={isLarge ? styles.containerLarge : styles.container}>
        <ActivityIndicator size="small" color="#888" />
      </View>
    );
  }

  if (companions.length === 0) return null;

  const isAllSelected = selectedId === null;

  const ringStyle = {
    width: ringSize,
    height: ringSize,
    borderRadius: ringSize / 2,
    borderWidth: isLarge ? 3 : 2,
    borderColor: 'transparent' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  };

  const circleStyle = {
    width: avatarSize,
    height: avatarSize,
    borderRadius: avatarSize / 2,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  };

  const imageStyle = {
    width: avatarSize,
    height: avatarSize,
    borderRadius: avatarSize / 2,
  };

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={isLarge ? styles.scrollContentLarge : styles.scrollContent}
      style={isLarge ? styles.containerLarge : styles.container}
    >
      {/* "All" chip */}
      <TouchableOpacity
        style={[styles.avatarItem, isLarge && styles.avatarItemLarge]}
        onPress={() => throttledOnSelect(null)}
        activeOpacity={0.7}
      >
        <View style={[ringStyle, isAllSelected && (isLarge ? styles.avatarRingActiveLarge : styles.avatarRingActive)]}>
          <View style={[circleStyle, { backgroundColor: '#444' }]}>
            <Text style={isLarge ? styles.allIconLarge : styles.allIcon}>✦</Text>
          </View>
        </View>
        <Text
          style={[
            isLarge ? styles.avatarNameLarge : styles.avatarName,
            isAllSelected && styles.avatarNameActive,
          ]}
          numberOfLines={1}
        >
          All
        </Text>
      </TouchableOpacity>

      {companions.map((c) => {
        const isSelected = selectedId === c.userId;
        const isMe = currentUserId !== undefined && c.userId === currentUserId;
        return (
          <TouchableOpacity
            key={c.userId}
            style={[styles.avatarItem, isLarge && styles.avatarItemLarge]}
            onPress={() => throttledOnSelect(isSelected ? null : c.userId)}
            activeOpacity={0.7}
          >
            <View style={[
              ringStyle,
              isMe && styles.avatarRingMe,
              isSelected && (isLarge ? styles.avatarRingActiveLarge : styles.avatarRingActive),
            ]}>
              {c.avatarUrl ? (
                <Image source={{ uri: c.avatarUrl }} style={imageStyle} />
              ) : (
                <View style={[circleStyle, { backgroundColor: c.color }]}>
                  <Text style={isLarge ? styles.avatarInitialLarge : styles.avatarInitial}>
                    {c.initial}
                  </Text>
                </View>
              )}
            </View>
            <Text
              style={[
                isLarge ? styles.avatarNameLarge : styles.avatarName,
                isSelected && styles.avatarNameActive,
              ]}
              numberOfLines={1}
            >
              {c.companionName}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    maxHeight: 90,
  },
  containerLarge: {
    maxHeight: 140,
  },
  scrollContent: {
    paddingHorizontal: 12,
    paddingTop: 4,
    paddingBottom: 6,
    gap: 14,
  },
  scrollContentLarge: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 10,
    gap: 20,
  },
  avatarItem: {
    alignItems: 'center',
    width: 64,
  },
  avatarItemLarge: {
    width: 104,
  },
  avatarRingActive: {
    borderColor: '#3897f0',
  },
  avatarRingActiveLarge: {
    borderColor: '#3897f0',
  },
  avatarRingMe: {
    borderColor: 'rgba(252, 211, 77, 0.55)',
  },
  avatarInitial: {
    fontSize: 20,
    fontWeight: '600',
    color: '#fff',
  },
  avatarInitialLarge: {
    fontSize: 36,
    fontWeight: '600',
    color: '#fff',
  },
  allIcon: {
    fontSize: 22,
    color: '#fff',
  },
  allIconLarge: {
    fontSize: 38,
    color: '#fff',
  },
  avatarName: {
    marginTop: 4,
    fontSize: 11,
    color: '#888',
    textAlign: 'center',
  },
  avatarNameLarge: {
    marginTop: 6,
    fontSize: 13,
    color: '#888',
    textAlign: 'center',
  },
  avatarNameActive: {
    color: '#fff',
    fontWeight: '600',
  },
});
