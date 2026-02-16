import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { useEffect, useState } from 'react';
import { Alert } from 'react-native';

const STORAGE_KEY = 'daily_reminder_settings';

interface ReminderState {
  enabled: boolean;
  hour: number;
  minute: number;
}

export function useDailyReminder(explorerName?: string | null) {
  const [loading, setLoading] = useState(true);
  const [reminder, setReminder] = useState<ReminderState>({
    enabled: false,
    hour: 19, // Default 7 PM
    minute: 0,
  });

  useEffect(() => {
    loadSettings(explorerName);
  }, [explorerName]);

  const loadSettings = async (name?: string | null) => {
    try {
      const saved = await AsyncStorage.getItem(STORAGE_KEY);
      if (saved) {
        setReminder(JSON.parse(saved));
      } else {
        // Only prompt if we have a name
        if (!name) return;

        // Give the UI a moment to settle before popping the alert
        setTimeout(() => {
          Alert.alert(
            "Daily Reflection",
            `Make it a habit. Set a daily reminder to send a Reflection to ${name}?`,
            [
              { 
                text: "No", 
                style: "cancel", 
                onPress: () => saveState({ enabled: false, hour: 19, minute: 0 }) 
              },
              { 
                text: "Yes, 7 PM", 
                onPress: () => schedule(19, 0, name) 
              },
              { 
                text: "Custom Time", 
                onPress: () => {
                  // Enable it immediately (showing the UI controls)
                  // Default to 7 PM so something is set, but user can now edit it
                  schedule(19, 0, name);
                }
              }
            ]
          );
        }, 1500);
      }
    } catch (e) {
      console.warn('Failed to load reminder settings', e);
    } finally {
      setLoading(false);
    }
  };

  const saveState = async (newState: ReminderState) => {
    setReminder(newState);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(newState));
  };

  const schedule = async (hour: number, minute: number, name?: string | null) => {
    try {
      const { status } = await Notifications.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Denied', 'Enable notifications in system settings to use reminders.');
        return;
      }

      await Notifications.cancelAllScheduledNotificationsAsync();

      await Notifications.scheduleNotificationAsync({
        content: {
          title: "Send a Reflection",
          body: name ? `It's time to send a new Reflection to ${name}.` : "It's time to send a new Reflection.",
          sound: true,
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.CALENDAR,
          hour,
          minute,
          repeats: true,
        },
      });

      await saveState({ enabled: true, hour, minute });
      
    } catch (e) {
      console.error("Scheduling failed", e);
      Alert.alert("Error", "Could not schedule reminder.");
    }
  };

  const cancel = async () => {
    await Notifications.cancelAllScheduledNotificationsAsync();
    await saveState({ ...reminder, enabled: false });
  };

  return {
    reminder,
    loading,
    schedule: (h: number, m: number) => schedule(h, m, explorerName),
    cancel,
  };
}

export const formatTime = (h: number, m: number) => {
  const date = new Date();
  date.setHours(h);
  date.setMinutes(m);
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};