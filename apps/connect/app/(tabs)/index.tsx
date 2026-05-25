import CreationModal from '@/components/CreationModal';
import { useReflectionMedia } from '@/context/ReflectionMediaContext';
import { useNotificationDeepLink } from '@/hooks/useNotificationDeepLink';
import { FontAwesome } from '@expo/vector-icons';
import { Event } from '@projectmirror/shared';
import { useNavigation } from '@react-navigation/native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';

import SentTimelineScreen from './timeline';

export default function TimelineHomeScreen() {
  type CreationModalInitialAction = 'camera' | 'gallery' | 'search';
  const [creationModalVisible, setCreationModalVisible] = useState(false);
  const [initialAction, setInitialAction] = useState<CreationModalInitialAction | null>(null);
  const [editingReflection, setEditingReflection] = useState<Event | null>(null);
  const params = useLocalSearchParams<{ action?: string; isReaction?: string; parentId?: string }>();
  const [isReactionSession, setIsReactionSession] = useState(false);
  const [reactionParentId, setReactionParentId] = useState<string | null>(null);
  const router = useRouter();
  const navigation = useNavigation();
  const hasHandledActionParamRef = useRef(false);
  const { pendingMedia } = useReflectionMedia();
  const {
    deepLinkReflectionId,
    deepLinkExplorerId,
    timelineRefreshNonce,
    deepLinkOpenCreationModal,
    deepLinkAction,
    completeDeepLink,
  } = useNotificationDeepLink();

  useEffect(() => {
    if (creationModalVisible) {
      navigation.setOptions({ headerShown: false });
      navigation.getParent()?.setOptions({ tabBarStyle: { display: 'none' } });
    } else {
      navigation.setOptions({ headerShown: true });
      navigation.getParent()?.setOptions({ tabBarStyle: undefined });
    }
  }, [creationModalVisible, navigation]);

  useEffect(() => {
    if (pendingMedia && !creationModalVisible) {
      setEditingReflection(null);
      setCreationModalVisible(true);
    }
  }, [pendingMedia, creationModalVisible]);

  useEffect(() => {
    const action = params.action;
    if (action !== 'camera' && action !== 'gallery' && action !== 'search') {
      hasHandledActionParamRef.current = false;
      return;
    }
    if (hasHandledActionParamRef.current) return;
    hasHandledActionParamRef.current = true;
    setIsReactionSession(false);
    setReactionParentId(null);
    setCreationModalVisible(true);
    setInitialAction(action);
    router.setParams({ action: undefined });
  }, [params.action, router]);

  useEffect(() => {
    const parentId = typeof params.parentId === 'string' ? params.parentId : undefined;
    if (params.isReaction !== 'true' || !parentId) return;
    setEditingReflection(null);
    setInitialAction(null);
    setIsReactionSession(true);
    setReactionParentId(parentId);
    setCreationModalVisible(true);
    router.setParams({ isReaction: undefined, parentId: undefined });
  }, [params.isReaction, params.parentId, router]);

  useEffect(() => {
    if (!deepLinkOpenCreationModal) return;
    setEditingReflection(null);
    setInitialAction(deepLinkAction);
    setCreationModalVisible(true);
    completeDeepLink();
  }, [deepLinkOpenCreationModal, deepLinkAction, completeDeepLink]);

  return (
    <View style={styles.container}>
      <SentTimelineScreen
        deepLinkReflectionId={deepLinkReflectionId}
        deepLinkExplorerId={deepLinkExplorerId}
        timelineRefreshNonce={timelineRefreshNonce}
        onDeepLinkHandled={completeDeepLink}
        onEditReflection={(ev) => {
          setEditingReflection(ev);
          setCreationModalVisible(true);
        }}
      />
      <TouchableOpacity
        style={styles.fab}
        onPress={() => {
          setEditingReflection(null);
          setIsReactionSession(false);
          setReactionParentId(null);
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
          setIsReactionSession(false);
          setReactionParentId(null);
        }}
        initialAction={initialAction}
        onActionTriggered={() => setInitialAction(null)}
        isReaction={isReactionSession}
        parentReflectionId={reactionParentId}
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
