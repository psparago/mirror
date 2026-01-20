import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Tabs } from 'expo-router';
import React from 'react';

import { useClientOnlyValue } from '@/components/useClientOnlyValue';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';

// You can explore the built-in icon families and icons on the web at https://icons.expo.fyi/
function TabBarIcon(props: {
  name: React.ComponentProps<typeof FontAwesome>['name'];
  color: string;
}) {
  return <FontAwesome size={28} style={{ marginBottom: -3 }} {...props} />;
}

export default function TabLayout() {
  const colorScheme = useColorScheme();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: Colors[colorScheme ?? 'light'].tint,
        headerShown: useClientOnlyValue(false, true),
        headerStyle: {
          backgroundColor: '#0f2027',
        },
        headerTitleStyle: {
          fontWeight: 'bold',
        },
        headerTintColor: '#fff',
        tabBarStyle: { display: 'none' }, // Hide tab bar completely
      }}>

      <Tabs.Screen
        name="index"
        options={{
          title: "Cole's Inbox",
          headerShown: false,
        }}
      />
      <Tabs.Screen
        name="two"
        options={{
          href: null, // Hide from tab bar
        }}
      />
    </Tabs>
  );
}
