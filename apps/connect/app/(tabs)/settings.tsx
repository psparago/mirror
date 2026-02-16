import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { VersionDisplay, useAuth, useExplorer } from '@projectmirror/shared';
import { db, doc, serverTimestamp, setDoc } from '@projectmirror/shared/firebase';
import { useRelationships } from '@projectmirror/shared/src/hooks/useRelationships';
import AsyncStorage from '@react-native-async-storage/async-storage';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Stack } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native';

import { formatTime, useDailyReminder } from '../../hooks/useDailyReminder';

export default function SettingsScreen() {
  const colorScheme = useColorScheme();
  const tintColor = Colors[colorScheme ?? 'light'].tint;

  // AUTH & CONTEXT
  const { user, signOut } = useAuth();
  const { activeRelationship, explorerName, loading: explorerLoading } = useExplorer();
  const { relationships, loading: relationshipsLoading } = useRelationships(user?.uid);

  // 👇 INITIALIZE THE HOOK
  // We pass the explorerName so the "First Time Alert" can use it
  const { reminder, schedule, cancel, updateSettings, loading: reminderLoading } =
    useDailyReminder(explorerName, { promptOnFirstRun: false });

  // LOCAL STATE
  const [nameInput, setNameInput] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [lastOtaLabel, setLastOtaLabel] = useState<string | null>(null);

  // STATE FOR ANDROID TIME PICKER (iOS doesn't need this)
  const [showTimePicker, setShowTimePicker] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem('last_ota_label').then(setLastOtaLabel).catch(() => { });
  }, []);

  useEffect(() => {
    if (activeRelationship) {
      setNameInput(activeRelationship.companionName || '');
    } else {
      setNameInput('');
    }
  }, [activeRelationship?.id, activeRelationship?.companionName]);

  // --- HANDLERS ---

  // Handle Time Picker Selection
  const onTimeChange = (event: any, selectedDate?: Date) => {
    // Android closes the picker automatically
    if (Platform.OS === 'android') setShowTimePicker(false);

    if (selectedDate && event.type !== 'dismissed') {
      const h = selectedDate.getHours();
      const m = selectedDate.getMinutes();
      // Preserve the currently selected reminder action (camera/gallery/home)
      schedule(h, m, reminder.action);
    }
  };

  const saveCompanionName = async () => {
    const trimmedName = nameInput.trim();
    if (!trimmedName) {
      Alert.alert('Name Required', 'Please enter a name');
      return;
    }

    if (!activeRelationship?.id) {
      Alert.alert('Error', 'No active explorer relationship found.');
      return;
    }

    setSaving(true);
    try {
      await setDoc(doc(db, 'relationships', activeRelationship.id), {
        companionName: trimmedName,
        updatedAt: serverTimestamp(),
      }, { merge: true });

      Alert.alert('Success', `Name updated for ${explorerName || activeRelationship.explorerId}`);
    } catch (error) {
      console.error('Error saving:', error);
      Alert.alert('Error', 'Failed to save name');
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut();
    } catch (error) {
      Alert.alert('Error', 'Failed to log out');
    }
  };

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: 'Settings',
          headerBackTitle: 'Back',
        }}
      />

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={styles.scrollContent}>

          {/* --------------------------------------------------------- */}
          {/* SECTION: NOTIFICATIONS (NEW)                              */}
          {/* --------------------------------------------------------- */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: tintColor }]}>Notifications</Text>
            <View style={styles.card}>
              <View style={[styles.row, { marginBottom: 0 }]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowLabel}>Daily Reminder</Text>
                  <Text style={styles.description}>
                    Get a daily nudge to send a Reflection.
                  </Text>
                </View>
                {reminderLoading ? (
                  <ActivityIndicator size="small" />
                ) : (
                  <Switch
                    value={reminder.enabled}
                    onValueChange={(val) => {
                      if (val) schedule(19, 0, 'camera'); // Default to 7 PM on enable
                      else cancel();
                    }}
                    trackColor={{ false: '#333', true: '#2e78b7' }}
                    thumbColor={Platform.OS === 'ios' ? '#fff' : '#f4f3f4'}
                  />
                )}
              </View>

              {/* Show Time Picker ONLY if enabled */}
              {reminder.enabled && (
                <>
                  <View style={styles.divider} />
                  <View style={styles.row}>
                    <Text style={styles.rowLabel}>Time</Text>

                    {Platform.OS === 'ios' ? (
                      // iOS: Inline Picker
                      <DateTimePicker
                        value={new Date(new Date().setHours(reminder.hour, reminder.minute))}
                        mode="time"
                        display="compact"
                        themeVariant="dark"
                        onChange={onTimeChange}
                        style={{ width: 100 }}
                      />
                    ) : (
                      // Android: Touchable Text -> Opens Modal
                      <TouchableOpacity onPress={() => setShowTimePicker(true)}>
                        <Text style={styles.linkText}>
                          {formatTime(reminder.hour, reminder.minute)}
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>

                  <View style={styles.divider} />
                  <View style={{ marginBottom: 10 }}>
                    <Text style={styles.rowLabel}>On Tap, Open:</Text>
                    <View style={styles.actionRow}>
                      {/* OPTION 1: NONE */}
                      <TouchableOpacity
                        style={[styles.actionBtn, reminder.action === 'none' && styles.actionBtnActive]}
                        onPress={() => updateSettings({ action: 'none' })}
                      >
                        <Text style={[styles.actionText, reminder.action === 'none' && styles.actionTextActive]}>
                          Home
                        </Text>
                      </TouchableOpacity>

                      {/* OPTION 2: CAMERA */}
                      <TouchableOpacity
                        style={[styles.actionBtn, reminder.action === 'camera' && styles.actionBtnActive]}
                        onPress={() => updateSettings({ action: 'camera' })}
                      >
                        <Text style={[styles.actionText, reminder.action === 'camera' && styles.actionTextActive]}>
                          Camera
                        </Text>
                      </TouchableOpacity>

                      {/* OPTION 3: GALLERY */}
                      <TouchableOpacity
                        style={[styles.actionBtn, reminder.action === 'gallery' && styles.actionBtnActive]}
                        onPress={() => updateSettings({ action: 'gallery' })}
                      >
                        <Text style={[styles.actionText, reminder.action === 'gallery' && styles.actionTextActive]}>
                          Gallery
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>

                  <Text style={[styles.helperText, { marginTop: -10, marginBottom: 10 }]}>
                    We'll remind you every day at {formatTime(reminder.hour, reminder.minute)}.
                  </Text>
                </>
              )}

              {/* Android Modal Picker (Hidden by default) */}
              {showTimePicker && Platform.OS === 'android' && (
                <DateTimePicker
                  value={new Date(new Date().setHours(reminder.hour, reminder.minute))}
                  mode="time"
                  display="default"
                  onChange={onTimeChange}
                />
              )}
            </View>
          </View>

          {/* SECTION: IDENTITY */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: tintColor }]}>Identity</Text>
            <View style={styles.card}>
              {activeRelationship ? (
                <>
                  <Text style={styles.label}>
                    My Name for <Text style={{ color: '#2e78b7' }}>{explorerName || activeRelationship.explorerId}</Text>
                  </Text>
                  <Text style={styles.description}>
                    This is how you will appear to this specific Explorer.
                  </Text>

                  <TextInput
                    style={styles.input}
                    placeholder="Enter your name (e.g., Dad, Uncle Mike)"
                    placeholderTextColor="#666"
                    value={nameInput}
                    onChangeText={setNameInput}
                    autoCapitalize="words"
                    editable={!saving}
                  />
                  <TouchableOpacity
                    style={[
                      styles.saveButton,
                      (!nameInput.trim() || saving) && styles.saveButtonDisabled
                    ]}
                    onPress={saveCompanionName}
                    disabled={!nameInput.trim() || saving}
                  >
                    {saving ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={styles.saveButtonText}>Save Name</Text>
                    )}
                  </TouchableOpacity>
                </>
              ) : (
                <View style={{ padding: 10, alignItems: 'center' }}>
                  <Text style={{ color: '#888', fontStyle: 'italic' }}>
                    {explorerLoading ? "Loading explorer..." : "Link an Explorer to set your identity."}
                  </Text>
                </View>
              )}
            </View>
          </View>

          {/* SECTION: MY EXPLORERS */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: tintColor }]}>My Explorers</Text>
            {relationshipsLoading ? (
              <ActivityIndicator />
            ) : relationships.length === 0 ? (
              <Text style={styles.helperText}>No explorers linked yet.</Text>
            ) : (
              relationships.map((rel) => (
                <View key={rel.id} style={styles.explorerCard}>
                  <View style={styles.explorerCardRow}>
                    <Text style={styles.explorerCardLabel}>ID:</Text>
                    <Text style={styles.explorerCardValue}>{rel.explorerId}</Text>
                  </View>
                  <View style={styles.explorerCardRow}>
                    <Text style={styles.explorerCardLabel}>My Name:</Text>
                    <Text style={styles.explorerCardValue}>{rel.companionName}</Text>
                  </View>
                  <View style={styles.explorerCardRow}>
                    <Text style={styles.explorerCardLabel}>Role:</Text>
                    <Text style={styles.explorerCardValue}>{rel.role}</Text>
                  </View>
                  {activeRelationship?.id === rel.id && (
                    <View style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#333' }}>
                      <Text style={{ color: '#2e78b7', fontSize: 12, fontWeight: 'bold' }}>CURRENTLY SELECTED</Text>
                    </View>
                  )}
                </View>
              ))
            )}
          </View>

          {/* SECTION: ACCOUNT */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: tintColor }]}>Account</Text>
            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Signed in as</Text>
                <Text
                  style={[styles.rowValue, { flex: 1, textAlign: 'right', marginLeft: 16 }]}
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {user?.email || 'Unknown'}
                </Text>
              </View>

              <View style={styles.row}>
                <Text style={styles.rowLabel}>Provider</Text>
                <Text style={styles.rowValue}>
                  {user?.providerData[0]?.providerId || 'Unknown'}
                </Text>
              </View>

              <View style={styles.row}>
                <Text style={styles.rowLabel}>User ID</Text>
                <Text style={[styles.rowValue, { fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }]}>
                  {user?.uid}
                </Text>
              </View>

              <View style={styles.divider} />

              <TouchableOpacity
                style={styles.logoutButton}
                onPress={handleLogout}
              >
                <Text style={styles.logoutText}>Log Out</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* SECTION: INFO */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: tintColor }]}>App Information</Text>
            <View style={styles.card}>
              <VersionDisplay />
              {lastOtaLabel != null ? (
                <View style={[styles.row, { marginTop: 12 }]}>
                  <Text style={styles.rowLabel}>Last OTA</Text>
                  <Text style={[styles.rowValue, { fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }]} numberOfLines={1}>
                    {lastOtaLabel}
                  </Text>
                </View>
              ) : null}
            </View>
          </View>

          <View style={styles.footer}>
            <Text style={styles.footerText}>Reflections Companion</Text>
            <Text style={styles.footerSubtext}>by Angelware</Text>
          </View>

        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#121212',
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 8,
    marginLeft: 4,
    textTransform: 'uppercase',
    opacity: 0.7,
    letterSpacing: 0.5,
  },
  card: {
    backgroundColor: '#1e1e1e',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#333',
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
    marginBottom: 6,
  },
  description: {
    fontSize: 14,
    color: '#aaa',
    marginBottom: 16,
    lineHeight: 20,
  },
  input: {
    backgroundColor: '#2c2c2c',
    borderRadius: 8,
    padding: 14,
    fontSize: 16,
    color: '#fff',
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#333',
  },
  saveButton: {
    backgroundColor: '#2e78b7',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  saveButtonDisabled: {
    backgroundColor: '#333',
    opacity: 0.7,
  },
  saveButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  rowLabel: {
    fontSize: 16,
    color: '#fff',
  },
  rowValue: {
    fontSize: 16,
    color: '#aaa',
  },
  divider: {
    height: 1,
    backgroundColor: '#333',
    marginBottom: 16,
  },
  logoutButton: {
    alignItems: 'center',
    paddingVertical: 4,
  },
  logoutText: {
    color: '#ff4d4d',
    fontSize: 16,
    fontWeight: '600',
  },
  footer: {
    marginTop: 20,
    alignItems: 'center',
    opacity: 0.4,
  },
  footerText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
  },
  footerSubtext: {
    fontSize: 12,
    color: '#fff',
    marginTop: 4,
  },
  explorerCard: {
    backgroundColor: '#1e1e1e',
    padding: 16,
    borderRadius: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#333',
  },
  explorerCardRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  explorerCardLabel: {
    color: '#fff',
    fontWeight: '500',
  },
  explorerCardValue: {
    fontWeight: '600',
    color: '#aaa',
  },
  helperText: {
    color: '#888',
    fontStyle: 'italic',
    fontSize: 12
  },
  linkText: {
    color: '#2e78b7',
    fontSize: 16,
    fontWeight: '600'
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
    marginBottom: 10,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#333',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333',
  },
  actionBtnActive: {
    backgroundColor: '#2e78b7', // Active Blue
    borderColor: '#2e78b7',
  },
  actionText: {
    color: '#aaa',
    fontSize: 14,
    fontWeight: '500',
  },
  actionTextActive: {
    color: '#fff',
    fontWeight: '600',
  }
});