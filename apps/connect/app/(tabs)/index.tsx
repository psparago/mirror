import CreationModal from '@/components/CreationModal';
import { useReflectionMedia } from '@/context/ReflectionMediaContext';
import { FontAwesome } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, TouchableOpacity, View } from 'react-native';

import SentTimelineScreen from './timeline';

export default function TimelineHomeScreen() {
  type CreationModalInitialAction = 'camera' | 'gallery' | 'search';
  const [creationModalVisible, setCreationModalVisible] = useState(false);
  const [initialAction, setInitialAction] = useState<CreationModalInitialAction | null>(null);
  const params = useLocalSearchParams<{ action?: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const hasHandledActionParamRef = useRef(false);
  const { pendingMedia } = useReflectionMedia();

  // Hide header and tab bar during creation flow so the overlay is truly full-screen
  useEffect(() => {
    if (creationModalVisible) {
      navigation.setOptions({ headerShown: false });
      navigation.getParent()?.setOptions({ tabBarStyle: { display: 'none' } });
    } else {
      navigation.setOptions({ headerShown: true });
      navigation.getParent()?.setOptions({ tabBarStyle: undefined });
    }
  }, [creationModalVisible, navigation]);

  // Auto-open CreationModal when media is pending (e.g., returning from camera).
  // This ensures the modal opens even if the screen remounts.
  useEffect(() => {
    if (pendingMedia && !creationModalVisible) {
      setCreationModalVisible(true);
    }
  }, [pendingMedia, creationModalVisible]);

  // Deep link: open CreationModal and trigger action when ?action=camera|gallery|search
  useEffect(() => {
    const action = params.action;
    if (action !== 'camera' && action !== 'gallery' && action !== 'search') {
      hasHandledActionParamRef.current = false;
      return;
    }
    if (hasHandledActionParamRef.current) return;
    hasHandledActionParamRef.current = true;
    setCreationModalVisible(true);
    setInitialAction(action);
    router.setParams({ action: undefined });
  }, [params.action, router]);

  return (
    <View style={styles.container}>
      <SentTimelineScreen />
      <TouchableOpacity
        style={styles.fab}
        onPress={() => setCreationModalVisible(true)}
        activeOpacity={0.85}
      >
        <LinearGradient
          colors={['#C2E9FB', '#A1C4FD', '#2E78B7']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.fabGradient}
        >
          <FontAwesome name="plus" size={36} color="#fff" />
        </LinearGradient>
      </TouchableOpacity>
      <CreationModal
        visible={creationModalVisible}
        onClose={() => setCreationModalVisible(false)}
        initialAction={initialAction}
        onActionTriggered={() => setInitialAction(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  fab: {
    position: 'absolute',
    bottom: 2,
    right: 24,
    width: 80,
    height: 80,
    borderRadius: 40,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.35,
        shadowRadius: 8,
      },
      android: {
        elevation: 12,
      },
      default: {},
    }),
  },
  fabGradient: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
