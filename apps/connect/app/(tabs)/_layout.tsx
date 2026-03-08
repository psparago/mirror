import { useClientOnlyValue } from '@/components/useClientOnlyValue';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { API_ENDPOINTS, getAvatarColor, getAvatarInitial, useAuth, useExplorer } from '@projectmirror/shared';
import { db, doc, onSnapshot } from '@projectmirror/shared/firebase';
import { Image } from 'expo-image';
import { Tabs, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { AppState, AppStateStatus, StyleSheet, Text, View } from 'react-native';
import { useDailyReminder } from '../../hooks/useDailyReminder';

function TabBarIcon(props: {
  name: React.ComponentProps<typeof FontAwesome>['name'];
  color: string;
}) {
  return <FontAwesome size={28} style={{ marginBottom: -3 }} {...props} />;
}

export default function TabLayout() {
  const colorScheme = useColorScheme();
  const { explorerName, activeRelationship } = useExplorer();
  const { user } = useAuth();
  const router = useRouter();

  const [explorerAvatarUrl, setExplorerAvatarUrl] = useState<string | null>(null);
  const explorerId = activeRelationship?.explorerId;

  useEffect(() => {
    if (!explorerId) { setExplorerAvatarUrl(null); return; }
    const unsub = onSnapshot(
      doc(db, 'explorers', explorerId),
      async (snap: any) => {
        const data = snap.data();
        if (!data?.explorerAvatarS3Key) { setExplorerAvatarUrl(null); return; }
        try {
          const res = await fetch(
            `${API_ENDPOINTS.GET_S3_URL}?explorer_id=${explorerId}&event_id=explorer&filename=avatar.jpg&path=avatars&method=GET`
          );
          if (res.ok) {
            const { url } = await res.json();
            setExplorerAvatarUrl(url);
          }
        } catch {
          setExplorerAvatarUrl(null);
        }
      }
    );
    return () => unsub();
  }, [explorerId]);

  const explorerInitial = getAvatarInitial(explorerName || explorerId || '');
  const explorerColor = getAvatarColor(explorerId || '');

  // Run first-time daily reminder onboarding in the authenticated app shell,
  // so users don't have to visit Settings to be prompted.
  useDailyReminder(explorerName, {
    promptOnFirstRun: true,
    onCustomTimeSelected: () => {
      router.push('/settings');
    },
  });

  
  // Global AppState listener for Firestore network
  useEffect(() => {
    const subscription = AppState.addEventListener('change', async (nextAppState: AppStateStatus) => {
      console.log(`📱 [Connect] AppState: ${nextAppState}`);
      if (nextAppState === 'active') {
        // try {
        //   await enableNetwork(db);
        //   console.log('✅ [Companion] Firestore network resumed');
        // } catch (e) {
        //   console.warn('Error resuming Firestore network:', e);
        // }
      } else if (nextAppState === 'background' || nextAppState === 'inactive') {
        // try {
        //   await disableNetwork(db);
        //   console.log(`⏸️ [Companion] Firestore network paused (${nextAppState})`);
        // } catch (e) {
        //   console.warn('Error pausing Firestore network:', e);
        // }
      }
    });

    return () => {
      subscription.remove();
    };
  }, []);


  return (
    <Tabs
      initialRouteName="index"
      screenOptions={{
        tabBarActiveTintColor: Colors[colorScheme ?? 'light'].tint,
        headerShown: useClientOnlyValue(false, true),
      }}>
      <Tabs.Screen
        name="index"
        options={{
          tabBarLabel: 'Reflections',
          tabBarIcon: ({ color }) => <TabBarIcon name="list" color={color} />,
          headerTitle: () => (
            <View style={layoutStyles.headerTitleRow}>
              <View style={[layoutStyles.headerAvatar, !explorerAvatarUrl && { backgroundColor: explorerColor }]}>
                {explorerAvatarUrl ? (
                  <Image source={{ uri: explorerAvatarUrl }} style={layoutStyles.headerAvatarImage} contentFit="cover" />
                ) : (
                  <Text style={layoutStyles.headerAvatarInitial}>{explorerInitial}</Text>
                )}
              </View>
              <Text style={layoutStyles.headerTitleText} numberOfLines={1}>
                {explorerName ? `${explorerName}'s Reflections` : 'Reflections'}
              </Text>
            </View>
          ),
          headerTitleAlign: 'left',
        }}
      />

      <Tabs.Screen
        name="timeline"
        options={{
          href: null,
        }}
      />

      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarLabel: 'Settings',
          tabBarIcon: ({ color }) => <TabBarIcon name="cog" color={color} />,
        }}
      />
    </Tabs>
  );
}

const layoutStyles = StyleSheet.create({
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerAvatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#2a2a2a',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  headerAvatarImage: {
    width: 30,
    height: 30,
    borderRadius: 15,
  },
  headerAvatarInitial: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
  },
  headerTitleText: {
    fontSize: 17,
    fontWeight: '600',
    color: '#fff',
    flexShrink: 1,
  },
});

