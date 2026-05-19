import CreationModal from '@/components/CreationModal';
import { useReflectionMedia } from '@/context/ReflectionMediaContext';
import { FontAwesome } from '@expo/vector-icons';
import { Event, ExplorerConfig, useExplorer } from '@projectmirror/shared';
import { db, doc, getDoc } from '@projectmirror/shared/firebase';
import { useNavigation } from '@react-navigation/native';

import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, TouchableOpacity, View } from 'react-native';

import SentTimelineScreen from './timeline';

export default function TimelineHomeScreen() {
  type CreationModalInitialAction = 'camera' | 'gallery' | 'search';
  const [creationModalVisible, setCreationModalVisible] = useState(false);
  const [initialAction, setInitialAction] = useState<CreationModalInitialAction | null>(null);
  const [editingReflection, setEditingReflection] = useState<Event | null>(null);
  const [deepLinkReflectionId, setDeepLinkReflectionId] = useState<string | null>(null);
  const params = useLocalSearchParams<{ action?: string; reflectionId?: string; explorerId?: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const hasHandledActionParamRef = useRef(false);
  const hasHandledNotificationParamRef = useRef(false);
  const { pendingMedia } = useReflectionMedia();
  const { switchExplorer } = useExplorer();

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
      // New camera/gallery/search pick is never an edit session; avoid edit hydration racing consume.
      setEditingReflection(null);
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

  // Deep link: push notification tap → specific reflection or explorer timeline
  useEffect(() => {
    const reflectionId =
      typeof params.reflectionId === 'string' ? params.reflectionId.trim() : '';
    const explorerId =
      typeof params.explorerId === 'string' ? params.explorerId.trim() : '';

    if (!reflectionId && !explorerId) {
      hasHandledNotificationParamRef.current = false;
      return;
    }
    if (hasHandledNotificationParamRef.current) return;

    let cancelled = false;

    (async () => {
      hasHandledNotificationParamRef.current = true;

      let targetExplorerId = explorerId;
      if (reflectionId && !targetExplorerId) {
        try {
          const snap = await getDoc(doc(db, ExplorerConfig.collections.reflections, reflectionId));
          const resolved = snap.data()?.explorerId;
          if (typeof resolved === 'string' && resolved.trim()) {
            targetExplorerId = resolved.trim();
          }
        } catch (error) {
          console.warn('Failed to resolve explorer for reflection deep link:', error);
        }
      }

      if (!cancelled && targetExplorerId) {
        switchExplorer(targetExplorerId);
      }
      if (!cancelled && reflectionId) {
        setDeepLinkReflectionId(reflectionId);
      }

      router.setParams({ reflectionId: undefined, explorerId: undefined });
    })();

    return () => {
      cancelled = true;
    };
  }, [params.explorerId, params.reflectionId, router, switchExplorer]);

  return (
    <View style={styles.container}>
      <SentTimelineScreen
        deepLinkReflectionId={deepLinkReflectionId}
        onDeepLinkHandled={() => setDeepLinkReflectionId(null)}
        onEditReflection={(ev) => {
          setEditingReflection(ev);
          setCreationModalVisible(true);
        }}
      />
      <TouchableOpacity
        style={styles.fab}
        onPress={() => {
          setEditingReflection(null);
          setCreationModalVisible(true);
        }}
        activeOpacity={0.7}
      >
        <FontAwesome name="plus" size={26} color="#fff" />
      </TouchableOpacity>
      <CreationModal
        visible={creationModalVisible}
        editEvent={editingReflection}
        onClose={() => {
          setCreationModalVisible(false);
          setEditingReflection(null);
        }}
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
    bottom: 4,
    right: 8,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#3897f0',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
