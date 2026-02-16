import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';

const STORAGE_KEY = 'daily_reminder_settings';
export type ReminderAction = 'camera' | 'gallery' | 'none';

interface ReminderState {
    enabled: boolean;
    hour: number;
    minute: number;
    action: ReminderAction;
}

interface UseDailyReminderOptions {
    promptOnFirstRun?: boolean;
    onCustomTimeSelected?: () => void;
}

export function useDailyReminder(explorerName?: string | null, options: UseDailyReminderOptions = {}) {
    const { promptOnFirstRun = true, onCustomTimeSelected } = options;
    const [loading, setLoading] = useState(true);
    const hasPromptedThisSessionRef = useRef(false);
    const [reminder, setReminder] = useState<ReminderState>({
        enabled: false,
        hour: 19, // Default 7 PM
        minute: 0,
        action: 'none',
    });

    useEffect(() => {
        loadSettings(explorerName);
    }, [explorerName, promptOnFirstRun]);

    const loadSettings = async (name?: string | null) => {
        try {
            const saved = await AsyncStorage.getItem(STORAGE_KEY);
            if (saved) {
                setReminder(JSON.parse(saved));
            } else {
                // Only prompt if we have a name
                if (!name) return;
                if (!promptOnFirstRun) return;
                if (hasPromptedThisSessionRef.current) return;
                hasPromptedThisSessionRef.current = true;

                // Give the UI a moment to settle before popping the alert
                setTimeout(() => {
                    Alert.alert(
                        "Daily Reflection",
                        `Make it a habit. Set a daily reminder to send a Reflection to ${name}?`,
                        [
                            {
                                text: "No",
                                style: "cancel",
                                onPress: () => saveState({ enabled: false, hour: 19, minute: 0, action: 'none' })
                            },
                            {
                                text: "Yes, selfie at 7 PM",
                                onPress: () => schedule(19, 0, 'camera', name)
                            },
                            {
                                text: "Custom Time",
                                onPress: () => {
                                    // Enable it immediately (showing the UI controls)
                                    // Default to 7 PM so something is set, but user can now edit it
                                    schedule(19, 0, 'camera', name);
                                    onCustomTimeSelected?.();
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

    const schedule = async (hour: number, minute: number, action: ReminderAction, name?: string | null) => {
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
                    data: {
                        action: action,
                        targetScreen: action,
                    },
                },
                trigger: {
                    type: Notifications.SchedulableTriggerInputTypes.CALENDAR,
                    hour,
                    minute,
                    repeats: true,
                },
            });

            await saveState({ enabled: true, hour, minute, action });

        } catch (e) {
            console.error("Scheduling failed", e);
            Alert.alert("Error", "Could not schedule reminder.");
        }
    };

    const cancel = async () => {
        await Notifications.cancelAllScheduledNotificationsAsync();
        await saveState({ ...reminder, enabled: false });
    };

    // Wrapper to make UI updates easier
    const updateSettings = (updates: Partial<ReminderState>) => {
        const newState = { ...reminder, ...updates };
        if (newState.enabled) {
            schedule(newState.hour, newState.minute, newState.action);
        } else {
            saveState(newState);
        }
    };

    return {
        reminder,
        loading,
        updateSettings,
        schedule: (h: number, m: number, a: ReminderAction) => schedule(h, m, a, explorerName),
        cancel,
    };
}

export const formatTime = (h: number, m: number) => {
    const date = new Date();
    date.setHours(h);
    date.setMinutes(m);
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};