import { FontAwesome } from '@expo/vector-icons';
import { AvatarFilterBar } from '@projectmirror/shared';
import type { CompanionAvatar } from '@projectmirror/shared';
import { BlurView } from 'expo-blur';
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { EdgeInsets } from 'react-native-safe-area-context';

const STATIC_BLUR_INTENSITY = 20;

interface GridBrowseChromeProps {
  insets: EdgeInsets;
  newArrivalIds: string[];
  isRefreshing: boolean;
  onSettingsPress: () => void;
  onNewArrivalPress: () => void;
  companions: CompanionAvatar[];
  selectedCompanionId: string | null;
  onSelectCompanion: (id: string | null) => void;
  companionsLoading: boolean;
}

/**
 * Header + large companion filter bar for the grid browse view.
 * The large avatars provide massive, tactile touch targets for quick filtering.
 */
export function GridBrowseChrome({
  insets,
  newArrivalIds,
  isRefreshing,
  onSettingsPress,
  onNewArrivalPress,
  companions,
  selectedCompanionId,
  onSelectCompanion,
  companionsLoading,
}: GridBrowseChromeProps) {
  return (
    <>
      {/* Header Row */}
      <View style={[styles.gridHeader, { paddingTop: insets.top + 12 }]}>
        <View style={styles.gridHeaderLeft}>
          {newArrivalIds.length > 0 ? (
            <TouchableOpacity
              onPress={onNewArrivalPress}
              style={styles.newArrivalPill}
              activeOpacity={0.7}
            >
              <BlurView intensity={STATIC_BLUR_INTENSITY} style={styles.newArrivalPillBlur}>
                <Text style={styles.newArrivalPillText}>
                  ✨ {newArrivalIds.length} New Reflection{newArrivalIds.length > 1 ? 's' : ''}
                </Text>
              </BlurView>
            </TouchableOpacity>
          ) : (
            <Text style={styles.gridHeaderTitle}>Reflections</Text>
          )}
        </View>
        <View style={styles.gridHeaderActions}>
          {isRefreshing && (
            <ActivityIndicator size="small" color="rgba(255, 255, 255, 0.6)" />
          )}
          <TouchableOpacity
            onPress={onSettingsPress}
            style={styles.gridHeaderButton}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <FontAwesome name="info-circle" size={20} color="rgba(255, 255, 255, 0.6)" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Large filter avatars — full-width tactile touch targets */}
      {companions.length > 0 && (
        <AvatarFilterBar
          companions={companions}
          selectedId={selectedCompanionId}
          onSelect={onSelectCompanion}
          loading={companionsLoading}
          size="large"
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  gridHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    backgroundColor: 'transparent',
  },
  gridHeaderLeft: {
    flex: 1,
  },
  gridHeaderTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: -0.5,
  },
  gridHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  gridHeaderButton: {
    padding: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  newArrivalPill: {
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: 'rgba(255, 215, 0, 0.2)',
    alignSelf: 'flex-start',
  },
  newArrivalPillBlur: {
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  newArrivalPillText: {
    color: '#FFD700',
    fontWeight: 'bold',
    fontSize: 16,
    textShadowColor: 'rgba(0, 0, 0, 0.75)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
});
