import * as Sentry from '@sentry/react-native';
import { getApp } from '@react-native-firebase/app';
import { getAuth, onAuthStateChanged, signInAnonymously } from '@react-native-firebase/auth';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useOTAUpdate } from '../hooks/useOTAUpdate';

Sentry.init({
  dsn: 'https://5510fbc509b29cd3d26ed552dc09ed83@o4507266632581120.ingest.us.sentry.io/4510748953870336',
  debug: false,
});

// 1. Force the splash screen to die immediately upon JS execution
SplashScreen.hideAsync().catch(() => { });

function RootLayout() {
  const [authReady, setAuthReady] = useState(false);

  useOTAUpdate();

  // Explorer must always be authenticated (anonymous) so Firestore rules using request.auth work.
  useEffect(() => {
    const auth = getAuth(getApp());
    let attemptedAnonymousSignIn = false;
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        setAuthReady(true);
        return;
      }

      if (!attemptedAnonymousSignIn) {
        attemptedAnonymousSignIn = true;
        signInAnonymously(auth).catch((e) => {
          console.warn('Anonymous Firebase sign-in failed:', e);
        });
      }
    });

    return unsubscribe;
  }, []);

  if (!authReady) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color="#000" />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="modal" options={{ presentation: 'modal' }} />
      </Stack>
    </GestureHandlerRootView>
  );
}

export default Sentry.wrap(RootLayout);