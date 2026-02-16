import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

// Configure how notifications behave when the app is OPEN
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export function usePushToken() {
  const [token, setToken] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    registerForPushNotificationsAsync().then(
      (t) => setToken(t),
      (e) => setError(e.message)
    );
  }, []);

  return { token, error };
}

async function registerForPushNotificationsAsync() {
  let token;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FF231F7C',
    });
  }

  if (Device.isDevice) {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    
    if (finalStatus !== 'granted') {
      throw new Error('Permission not granted');
    }

    // Get the token (Project ID is needed for Expo Push)
    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) {
       throw new Error('Project ID not found in app.json/app.config.ts');
    }

    token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  } else {
    // Simulator
    console.log('Must use physical device for Push Notifications');
  }

  return token;
}