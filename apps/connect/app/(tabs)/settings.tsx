import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { FontAwesome } from '@expo/vector-icons';
import { API_ENDPOINTS, VersionDisplay, getAvatarColor, getAvatarInitial, useAuth, useExplorer } from '@projectmirror/shared';
import { db, doc, onSnapshot, serverTimestamp, setDoc } from '@projectmirror/shared/firebase';
import { useRelationships } from '@projectmirror/shared/src/hooks/useRelationships';
import AsyncStorage from '@react-native-async-storage/async-storage';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
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

const CAPTION_VOICE_STORAGE_KEY = 'tts_voice_caption';
const DEEP_DIVE_VOICE_STORAGE_KEY = 'tts_voice_deep_dive';
const VOICE_OPTIONS = [
  {
    label: 'Journey O',
    value: 'en-US-Journey-O',
    description: 'Softer, lower-pitch, more mature sister voice to Journey-F.'
  },
  {
    label: 'Studio O',
    value: 'en-US-Studio-O',
    description: 'Warm, highly produced long-form female studio voice.'
  },
  {
    label: 'Neural2 C',
    value: 'en-US-Neural2-C',
    description: 'Calm, soothing female voice on Neural2.'
  },
  {
    label: 'Journey D',
    value: 'en-US-Journey-D',
    description: 'Deep, resonant, comforting male voice.'
  },
  {
    label: 'Studio Q',
    value: 'en-US-Studio-Q',
    description: 'Polished, soft-spoken male studio voice.'
  },
  {
    label: 'Casual K',
    value: 'en-US-Casual-K',
    description: 'Conversational, imperfect, casual male style.'
  },
  {
    label: 'Chirp3 Sulafat',
    value: 'en-US-Chirp3-HD-Sulafat',
    description: 'Google-classified warm female voice.'
  },
  {
    label: 'Chirp3 Achernar',
    value: 'en-US-Chirp3-HD-Achernar',
    description: 'Google-classified soft female voice.'
  },
  {
    label: 'Chirp3 Despina',
    value: 'en-US-Chirp3-HD-Despina',
    description: 'Google-classified smooth female voice.'
  },
] as const;
const DEFAULT_TTS_VOICE = 'en-US-Journey-O';

type SettingsTab = 'identity' | 'preferences' | 'account';

export default function SettingsScreen() {
  const colorScheme = useColorScheme();
  const tintColor = Colors[colorScheme ?? 'light'].tint;
  const router = useRouter();

  // AUTH & CONTEXT
  const { user, signOut } = useAuth();
  const { activeRelationship, explorerName, loading: explorerLoading } = useExplorer();
  const { relationships, loading: relationshipsLoading } = useRelationships(user?.uid);

  const { reminder, schedule, cancel, updateSettings, loading: reminderLoading } =
    useDailyReminder(explorerName, { promptOnFirstRun: false });

  // TAB STATE
  const [activeTab, setActiveTab] = useState<SettingsTab>('identity');

  // LOCAL STATE
  const [nameInput, setNameInput] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [lastOtaLabel, setLastOtaLabel] = useState<string | null>(null);
  const [captionVoice, setCaptionVoice] = useState<string>(DEFAULT_TTS_VOICE);
  const [deepDiveVoice, setDeepDiveVoice] = useState<string>(DEFAULT_TTS_VOICE);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  const avatarInitial = getAvatarInitial(activeRelationship?.companionName || '');
  const avatarColor = getAvatarColor(user?.uid || '');

  // VOICE PICKER MODAL STATE
  const [voicePickerTarget, setVoicePickerTarget] = useState<'caption' | 'deep_dive' | null>(null);
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);

  const stopSample = useCallback(async () => {
    if (soundRef.current) {
      try { await soundRef.current.unloadAsync(); } catch { /* ignore */ }
      soundRef.current = null;
    }
    setPlayingVoice(null);
  }, []);

  const playVoiceSample = useCallback(async (voiceValue: string) => {
    if (playingVoice === voiceValue) {
      await stopSample();
      return;
    }
    await stopSample();
    setPlayingVoice(voiceValue);
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: false,
        playThroughEarpieceAndroid: false,
      });
      const res = await fetch(`${API_ENDPOINTS.GET_VOICE_SAMPLE}?voice=${encodeURIComponent(voiceValue)}`);
      if (!res.ok) throw new Error('Failed to fetch sample URL');
      const { url } = await res.json();
      const { sound } = await Audio.Sound.createAsync(
        { uri: url },
        { shouldPlay: true, volume: 1.0 }
      );
      soundRef.current = sound;
      await sound.setVolumeAsync(1.0);
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          stopSample();
        }
      });
    } catch {
      setPlayingVoice(null);
    }
  }, [playingVoice, stopSample]);

  useEffect(() => {
    return () => { stopSample(); };
  }, [stopSample]);

  // STATE FOR ANDROID TIME PICKER (iOS doesn't need this)
  const [showTimePicker, setShowTimePicker] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem('last_ota_label').then(setLastOtaLabel).catch(() => { });
  }, []);

  useEffect(() => {
    const loadVoicePrefs = async () => {
      try {
        const [savedCaption, savedDeepDive] = await Promise.all([
          AsyncStorage.getItem(CAPTION_VOICE_STORAGE_KEY),
          AsyncStorage.getItem(DEEP_DIVE_VOICE_STORAGE_KEY),
        ]);
        if (savedCaption) {
          setCaptionVoice(savedCaption);
        } else {
          await AsyncStorage.setItem(CAPTION_VOICE_STORAGE_KEY, DEFAULT_TTS_VOICE);
        }
        if (savedDeepDive) {
          setDeepDiveVoice(savedDeepDive);
        } else {
          await AsyncStorage.setItem(DEEP_DIVE_VOICE_STORAGE_KEY, DEFAULT_TTS_VOICE);
        }
      } catch {
        // keep defaults
      }
    };
    loadVoicePrefs();
  }, []);

  useEffect(() => {
    if (activeRelationship) {
      setNameInput(activeRelationship.companionName || '');
    } else {
      setNameInput('');
    }
  }, [activeRelationship?.id, activeRelationship?.companionName]);

  useEffect(() => {
    if (!activeRelationship?.id) { setAvatarUrl(null); return; }
    const unsub = onSnapshot(
      doc(db, 'relationships', activeRelationship.id),
      async (snap: any) => {
        const data = snap.data();
        const s3Key = data?.companionAvatarS3Key;
        if (!s3Key) { setAvatarUrl(null); return; }
        try {
          const explorerId = activeRelationship.explorerId;
          const res = await fetch(
            `${API_ENDPOINTS.GET_S3_URL}?explorer_id=${explorerId}&event_id=${user?.uid}&filename=avatar.jpg&path=avatars&method=GET`
          );
          if (res.ok) {
            const { url } = await res.json();
            setAvatarUrl(url);
          }
        } catch {
          setAvatarUrl(null);
        }
      }
    );
    return () => unsub();
  }, [activeRelationship?.id, activeRelationship?.explorerId, user?.uid]);

  const pickAvatar = useCallback(async (source: 'camera' | 'library') => {
    if (!activeRelationship?.id || !user?.uid) return;

    let result: ImagePicker.ImagePickerResult;
    if (source === 'camera') {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) { Alert.alert('Permission Required', 'Camera access is needed to take a photo.'); return; }
      result = await ImagePicker.launchCameraAsync({ allowsEditing: true, aspect: [1, 1], quality: 0.7, cameraType: ImagePicker.CameraType.front });
    } else {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) { Alert.alert('Permission Required', 'Photo library access is needed.'); return; }
      result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.7 });
    }

    if (result.canceled || !result.assets?.[0]) return;
    const localUri = result.assets[0].uri;

    setUploadingAvatar(true);
    try {
      const explorerId = activeRelationship.explorerId;

      const presignRes = await fetch(
        `${API_ENDPOINTS.GET_S3_URL}?explorer_id=${explorerId}&event_id=${user.uid}&filename=avatar.jpg&path=avatars`
      );
      if (!presignRes.ok) throw new Error('Failed to get upload URL');
      const { url: presignedUrl } = await presignRes.json();

      const uploadRes = await FileSystem.uploadAsync(presignedUrl, localUri, {
        httpMethod: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
      });
      if (uploadRes.status !== 200) throw new Error(`Upload failed: ${uploadRes.status}`);

      const s3Key = `${explorerId}/avatars/${user.uid}/avatar.jpg`;
      await setDoc(doc(db, 'relationships', activeRelationship.id), {
        companionAvatarS3Key: s3Key,
        updatedAt: serverTimestamp(),
      }, { merge: true });
    } catch (err: any) {
      console.error('Avatar upload failed:', err);
      Alert.alert('Upload Failed', 'Could not save your photo. Please try again.');
    } finally {
      setUploadingAvatar(false);
    }
  }, [activeRelationship?.id, activeRelationship?.explorerId, user?.uid]);

  const showAvatarPicker = useCallback(() => {
    Alert.alert('Profile Photo', 'Choose a photo that represents you.', [
      { text: 'Take a Selfie', onPress: () => pickAvatar('camera') },
      { text: 'Choose from Library', onPress: () => pickAvatar('library') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [pickAvatar]);

  // --- HANDLERS ---

  const onTimeChange = (event: any, selectedDate?: Date) => {
    if (Platform.OS === 'android') setShowTimePicker(false);
    if (selectedDate && event.type !== 'dismissed') {
      const h = selectedDate.getHours();
      const m = selectedDate.getMinutes();
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

  const saveVoicePreference = async (
    key: typeof CAPTION_VOICE_STORAGE_KEY | typeof DEEP_DIVE_VOICE_STORAGE_KEY,
    value: string,
    setter: (v: string) => void
  ) => {
    setter(value);
    try {
      await AsyncStorage.setItem(key, value);
    } catch {
      Alert.alert('Error', 'Failed to save voice preference.');
    }
  };

  const getVoiceLabel = (value: string) =>
    VOICE_OPTIONS.find((v) => v.value === value)?.label ?? value;

  const handleVoicePick = (voice: typeof VOICE_OPTIONS[number]) => {
    if (voicePickerTarget === 'caption') {
      saveVoicePreference(CAPTION_VOICE_STORAGE_KEY, voice.value, setCaptionVoice);
    } else if (voicePickerTarget === 'deep_dive') {
      saveVoicePreference(DEEP_DIVE_VOICE_STORAGE_KEY, voice.value, setDeepDiveVoice);
    }
    stopSample();
    setVoicePickerTarget(null);
  };

  const closeVoicePicker = () => {
    stopSample();
    setVoicePickerTarget(null);
  };

  // --- TAB CONTENT ---

  const renderIdentityTab = () => (
    <>
      <View style={styles.section}>
        <View style={styles.card}>
          {activeRelationship ? (
            <>
              <View style={styles.avatarRow}>
                <TouchableOpacity onPress={showAvatarPicker} disabled={uploadingAvatar} activeOpacity={0.7} style={styles.avatarTouchable}>
                  <View style={[styles.avatarCircle, !avatarUrl && !uploadingAvatar && { backgroundColor: avatarColor }]}>
                    {uploadingAvatar ? (
                      <ActivityIndicator color="#fff" />
                    ) : avatarUrl ? (
                      <Image source={{ uri: avatarUrl }} style={styles.avatarImage} contentFit="cover" />
                    ) : (
                      <Text style={styles.avatarInitial}>{avatarInitial}</Text>
                    )}
                  </View>
                  <View style={styles.avatarBadge}>
                    <FontAwesome name="camera" size={10} color="#fff" />
                  </View>
                </TouchableOpacity>
                <View style={styles.avatarTextCol}>
                  <Text style={styles.label}>
                    My Name for Explorer <Text style={{ color: '#2e78b7' }}>{explorerName || activeRelationship.explorerId}</Text>
                  </Text>
                  <Text style={styles.description}>
                    Tap the photo to set how you appear to this Explorer.
                  </Text>
                </View>
              </View>

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
    </>
  );

  const renderPreferencesTab = () => (
    <>
      {/* Notifications */}
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
                  if (val) schedule(19, 0, 'camera');
                  else cancel();
                }}
                trackColor={{ false: '#333', true: '#2e78b7' }}
                thumbColor={Platform.OS === 'ios' ? '#fff' : '#f4f3f4'}
              />
            )}
          </View>

          {reminder.enabled && (
            <>
              <View style={styles.divider} />
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Time</Text>

                {Platform.OS === 'ios' ? (
                  <DateTimePicker
                    value={new Date(new Date().setHours(reminder.hour, reminder.minute))}
                    mode="time"
                    display="compact"
                    themeVariant="dark"
                    onChange={onTimeChange}
                    style={{ width: 100 }}
                  />
                ) : (
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
                  <TouchableOpacity
                    style={[styles.actionBtn, reminder.action === 'none' && styles.actionBtnActive]}
                    onPress={() => updateSettings({ action: 'none' })}
                  >
                    <Text style={[styles.actionText, reminder.action === 'none' && styles.actionTextActive]}>
                      Home
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.actionBtn, reminder.action === 'camera' && styles.actionBtnActive]}
                    onPress={() => updateSettings({ action: 'camera' })}
                  >
                    <Text style={[styles.actionText, reminder.action === 'camera' && styles.actionTextActive]}>
                      Camera
                    </Text>
                  </TouchableOpacity>

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

      {/* Voice Preferences */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: tintColor }]}>Voice</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Caption Voice</Text>
            <TouchableOpacity onPress={() => setVoicePickerTarget('caption')}>
              <Text style={styles.linkText}>{getVoiceLabel(captionVoice)}</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.divider} />

          <View style={[styles.row, { marginBottom: 0 }]}>
            <Text style={styles.rowLabel}>Deep Dive Voice</Text>
            <TouchableOpacity onPress={() => setVoicePickerTarget('deep_dive')}>
              <Text style={styles.linkText}>{getVoiceLabel(deepDiveVoice)}</Text>
            </TouchableOpacity>
          </View>

          <Text style={[styles.helperText, { marginTop: 12 }]}>
            Your selected voice is used when AI generates caption and deep dive audio.
          </Text>
        </View>
      </View>
    </>
  );

  const renderAccountTab = () => (
    <>
      {/* My Explorers */}
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

      {/* Account */}
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

      {/* App Information */}
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
    </>
  );

  const TABS: { key: SettingsTab; label: string; icon: React.ComponentProps<typeof FontAwesome>['name'] }[] = [
    { key: 'identity', label: 'Identity', icon: 'user-circle' },
    { key: 'preferences', label: 'Preferences', icon: 'sliders' },
    { key: 'account', label: 'Account', icon: 'cog' },
  ];

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: 'Settings',
          headerBackTitle: 'Back',
          headerLeft: () => (
            <TouchableOpacity
              onPress={() => router.back()}
              style={styles.headerBackTouch}
              activeOpacity={0.6}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <FontAwesome name="chevron-left" size={20} color={tintColor} />
              <Text style={[styles.headerBackLabel, { color: tintColor }]}>Back</Text>
            </TouchableOpacity>
          ),
        }}
      />

      {/* Explorer Context Banner */}
      <View style={styles.explorerBanner}>
        {explorerLoading ? (
          <ActivityIndicator size="small" color="#aaa" />
        ) : activeRelationship ? (
          <Text style={styles.explorerBannerText}>
            <FontAwesome name="heart" size={13} color="#E57373" />{' '}
            Settings for Explorer <Text style={styles.explorerBannerName}>{explorerName || activeRelationship.explorerId}</Text>
          </Text>
        ) : (
          <Text style={styles.explorerBannerText}>No Explorer linked</Text>
        )}
      </View>

      {/* Tab Bar */}
      <View style={styles.tabBar}>
        {TABS.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tab, isActive && styles.tabActive]}
              onPress={() => setActiveTab(tab.key)}
              activeOpacity={0.7}
            >
              <FontAwesome name={tab.icon} size={14} color={isActive ? '#fff' : '#888'} />
              <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>{tab.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={styles.scrollContent}>
          {activeTab === 'identity' && renderIdentityTab()}
          {activeTab === 'preferences' && renderPreferencesTab()}
          {activeTab === 'account' && renderAccountTab()}

          <View style={styles.footer}>
            <Text style={styles.footerText}>Reflections Connect</Text>
            <Text style={styles.footerSubtext}>by Angelware</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Voice Picker Modal */}
      <Modal
        visible={voicePickerTarget !== null}
        transparent
        animationType="slide"
        onRequestClose={closeVoicePicker}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>
              {voicePickerTarget === 'caption' ? 'Caption Voice' : 'Deep Dive Voice'}
            </Text>

            <ScrollView style={styles.modalList} showsVerticalScrollIndicator={false}>
              {VOICE_OPTIONS.map((voice) => {
                const isSelected =
                  voicePickerTarget === 'caption'
                    ? captionVoice === voice.value
                    : deepDiveVoice === voice.value;
                const isPlaying = playingVoice === voice.value;
                return (
                  <TouchableOpacity
                    key={voice.value}
                    style={[styles.modalOption, isSelected && styles.modalOptionActive]}
                    onPress={() => handleVoicePick(voice)}
                    activeOpacity={0.7}
                  >
                    <View style={styles.modalOptionHeader}>
                      <Text style={[styles.modalOptionLabel, isSelected && styles.modalOptionLabelActive]}>
                        {voice.label}
                      </Text>
                      <View style={styles.modalOptionActions}>
                        <TouchableOpacity
                          onPress={(e) => {
                            e.stopPropagation();
                            playVoiceSample(voice.value);
                          }}
                          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                          style={styles.sampleBtn}
                        >
                          <FontAwesome
                            name={isPlaying ? 'stop-circle' : 'volume-up'}
                            size={18}
                            color={isPlaying ? '#ff6b6b' : '#5aadde'}
                          />
                        </TouchableOpacity>
                        {isSelected && <Text style={styles.modalCheckmark}>✓</Text>}
                      </View>
                    </View>
                    <Text style={styles.modalOptionDesc}>{voice.description}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <TouchableOpacity
              style={styles.modalCloseBtn}
              onPress={closeVoicePicker}
            >
              <Text style={styles.modalCloseBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#121212',
  },
  headerBackTouch: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    minWidth: 44,
    paddingLeft: 8,
    paddingRight: 16,
    gap: 2,
  },
  headerBackLabel: {
    fontSize: 17,
    fontWeight: '400',
  },

  // Explorer Context Banner
  explorerBanner: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    backgroundColor: '#1a1a1a',
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a2a',
    alignItems: 'center',
  },
  explorerBannerText: {
    color: '#aaa',
    fontSize: 14,
  },
  explorerBannerName: {
    color: '#2e78b7',
    fontWeight: '700',
  },

  // Tab Bar
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#1a1a1a',
    paddingHorizontal: 12,
    paddingTop: 4,
    paddingBottom: 8,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a2a',
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: 'transparent',
  },
  tabActive: {
    backgroundColor: '#2e78b7',
  },
  tabLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: '#888',
  },
  tabLabelActive: {
    color: '#fff',
    fontWeight: '600',
  },

  // Content
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

  // Avatar
  avatarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
    gap: 14,
  },
  avatarCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#2a2a2a',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImage: {
    width: 72,
    height: 72,
    borderRadius: 36,
  },
  avatarInitial: {
    fontSize: 30,
    fontWeight: '600',
    color: '#fff',
  },
  avatarTouchable: {
    width: 72,
    height: 72,
  },
  avatarBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#3897f0',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#1e1e1e',
    zIndex: 10,
  },
  avatarTextCol: {
    flex: 1,
  },

  // Cards
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

  // Explorer Cards
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
    backgroundColor: '#2e78b7',
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
  },

  // Voice Picker Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: '#1e1e1e',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 20,
    paddingHorizontal: 16,
    paddingBottom: Platform.OS === 'ios' ? 40 : 24,
    maxHeight: '75%',
  },
  modalTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 16,
  },
  modalList: {
    marginBottom: 12,
  },
  modalOption: {
    backgroundColor: '#2c2c2c',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#333',
  },
  modalOptionActive: {
    backgroundColor: 'rgba(46,120,183,0.2)',
    borderColor: '#2e78b7',
  },
  modalOptionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  modalOptionActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  sampleBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalOptionLabel: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  modalOptionLabelActive: {
    color: '#5aadde',
  },
  modalCheckmark: {
    color: '#2e78b7',
    fontSize: 18,
    fontWeight: '700',
  },
  modalOptionDesc: {
    color: '#aaa',
    fontSize: 13,
    lineHeight: 18,
  },
  modalCloseBtn: {
    alignItems: 'center',
    paddingVertical: 14,
    backgroundColor: '#333',
    borderRadius: 12,
  },
  modalCloseBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
