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
}

const AVATAR_SIZE = 48;
const RING_SIZE = AVATAR_SIZE + 6;

export function AvatarFilterBar({ companions, selectedId, onSelect, loading }: AvatarFilterBarProps) {
  const throttledOnSelect = useThrottledCallback((userId: string | null) => {
    onSelect(userId);
  });

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="small" color="#888" />
      </View>
    );
  }

  if (companions.length === 0) return null;

  const isAllSelected = selectedId === null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.scrollContent}
      style={styles.container}
    >
      {/* "All" chip */}
      <TouchableOpacity
        style={styles.avatarItem}
        onPress={() => throttledOnSelect(null)}
        activeOpacity={0.7}
      >
        <View style={[styles.avatarRing, isAllSelected && styles.avatarRingActive]}>
          <View style={[styles.avatarCircle, { backgroundColor: '#444' }]}>
            <Text style={styles.allIcon}>✦</Text>
          </View>
        </View>
        <Text style={[styles.avatarName, isAllSelected && styles.avatarNameActive]} numberOfLines={1}>
          All
        </Text>
      </TouchableOpacity>

      {companions.map((c) => {
        const isSelected = selectedId === c.userId;
        return (
          <TouchableOpacity
            key={c.userId}
            style={styles.avatarItem}
            onPress={() => throttledOnSelect(isSelected ? null : c.userId)}
            activeOpacity={0.7}
          >
            <View style={[styles.avatarRing, isSelected && styles.avatarRingActive]}>
              {c.avatarUrl ? (
                <Image source={{ uri: c.avatarUrl }} style={styles.avatarImage} />
              ) : (
                <View style={[styles.avatarCircle, { backgroundColor: c.color }]}>
                  <Text style={styles.avatarInitial}>{c.initial}</Text>
                </View>
              )}
            </View>
            <Text style={[styles.avatarName, isSelected && styles.avatarNameActive]} numberOfLines={1}>
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
  scrollContent: {
    paddingHorizontal: 12,
    paddingTop: 4,
    paddingBottom: 6,
    gap: 14,
  },
  avatarItem: {
    alignItems: 'center',
    width: 64,
  },
  avatarRing: {
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: RING_SIZE / 2,
    borderWidth: 2,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarRingActive: {
    borderColor: '#3897f0',
  },
  avatarCircle: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarImage: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
  },
  avatarInitial: {
    fontSize: 20,
    fontWeight: '600',
    color: '#fff',
  },
  allIcon: {
    fontSize: 22,
    color: '#fff',
  },
  avatarName: {
    marginTop: 4,
    fontSize: 11,
    color: '#888',
    textAlign: 'center',
  },
  avatarNameActive: {
    color: '#fff',
    fontWeight: '600',
  },
});
