import { useClientOnlyValue } from '@/components/useClientOnlyValue';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Tabs } from 'expo-router';
import React from 'react';

function TabBarIcon(props: {
  name: React.ComponentProps<typeof FontAwesome>['name'];
  color: string;
}) {
  return <FontAwesome size={28} style={{ marginBottom: -3 }} {...props} />;
}

export default function TabLayout() {
  const colorScheme = useColorScheme();

  /*
  // Global AppState listener for Firestore network
  useEffect(() => {
    const subscription = AppState.addEventListener('change', async (nextAppState: AppStateStatus) => {
      console.log(`📱 [Companion] AppState: ${nextAppState}`);
      if (nextAppState === 'active') {
        try {
          await enableNetwork(db);
          console.log('✅ [Companion] Firestore network resumed');
        } catch (e) {
          console.warn('Error resuming Firestore network:', e);
        }
      } else if (nextAppState === 'background' || nextAppState === 'inactive') {
        try {
          await disableNetwork(db);
          console.log(`⏸️ [Companion] Firestore network paused (${nextAppState})`);
        } catch (e) {
          console.warn('Error pausing Firestore network:', e);
        }
      }
    });

    return () => {
      subscription.remove();
    };
  }, []);
*/

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
          title: 'Reflections',
          tabBarIcon: ({ color }) => <TabBarIcon name="clone" color={color} />,
        }}
      />

      <Tabs.Screen
        name="timeline"
        options={{
          title: 'Timeline',
          tabBarIcon: ({ color }) => <TabBarIcon name="clock-o" color={color} />,
        }}
      />

      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => <TabBarIcon name="cog" color={color} />,
        }}
      />
    </Tabs>
  );
}

