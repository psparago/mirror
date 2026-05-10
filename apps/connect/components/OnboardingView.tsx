import { API_ENDPOINTS, getAvatarColor, getAvatarInitial, useAuth, useExplorer, useWaitOverlay } from '@projectmirror/shared';
import { db, doc, serverTimestamp, setDoc } from '@projectmirror/shared/firebase';
import * as FileSystem from 'expo-file-system';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import React, { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

const OVERLAY_ID = 'connect-onboarding-wait-overlay';

export function OnboardingView() {
  const { user } = useAuth();
  const { activeRelationship, explorerName } = useExplorer();
  const waitOverlay = useWaitOverlay();

  const explorerLabel = explorerName || 'the Explorer';

  const [name, setName] = useState(activeRelationship?.companionName || '');
  const [localAvatarUri, setLocalAvatarUri] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const explorerId = activeRelationship?.explorerId || '';
  const displayInitial = getAvatarInitial(name || user?.email || '');
  const avatarColor = getAvatarColor(user?.uid || '');

  const pickAvatar = async (source: 'camera' | 'library') => {
    const result = source === 'camera'
      ? await ImagePicker.launchCameraAsync({
          allowsEditing: true,
          aspect: [1, 1],
          quality: 0.8,
          cameraType: ImagePicker.CameraType.front,
        })
      : await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          allowsEditing: true,
          aspect: [1, 1],
          quality: 0.8,
        });

    if (!result.canceled && result.assets[0]?.uri) {
      setLocalAvatarUri(result.assets[0].uri);
    }
  };

  const showAvatarPicker = () => {
    Alert.alert('Add a Photo', 'Choose how to add your profile photo.', [
      { text: 'Take a Selfie', onPress: () => pickAvatar('camera') },
      { text: 'Choose from Library', onPress: () => pickAvatar('library') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const handleFinish = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      Alert.alert('Name Required', `Please enter how you want to appear to ${explorerLabel}.`);
      return;
    }

    if (!activeRelationship?.id || !user) return;

    setSubmitting(true);
    waitOverlay.show(
      { title: 'Setting up your profile...', detail: 'Just a moment.', tone: 'sparkle' },
      OVERLAY_ID
    );

    try {
      let companionAvatarS3Key: string | undefined;

      if (localAvatarUri) {
        const presignRes = await fetch(
          `${API_ENDPOINTS.GET_S3_URL}?explorer_id=${explorerId}&event_id=${user.uid}&filename=avatar.jpg&path=avatars`
        );
        if (!presignRes.ok) throw new Error('Failed to get upload URL');
        const { url: presignedUrl } = await presignRes.json();

        const uploadRes = await FileSystem.uploadAsync(presignedUrl, localAvatarUri, {
          httpMethod: 'PUT',
          headers: { 'Content-Type': 'image/jpeg' },
        });
        if (uploadRes.status !== 200) throw new Error(`Upload failed: ${uploadRes.status}`);

        companionAvatarS3Key = `${explorerId}/avatars/${user.uid}/avatar.jpg`;
      }

      await setDoc(
        doc(db, 'relationships', activeRelationship.id),
        {
          companionName: trimmedName,
          ...(companionAvatarS3Key ? { companionAvatarS3Key } : {}),
          onboarding_complete: true,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      // The onSnapshot in useRelationships picks up onboarding_complete: true
      // and the gate in (tabs)/_layout.tsx reactively shows <Tabs />.
    } catch (err: any) {
      console.error('[OnboardingView] Save failed:', err);
      Alert.alert('Error', 'Could not save your profile. Please try again.');
    } finally {
      setSubmitting(false);
      waitOverlay.hide(OVERLAY_ID);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <Text style={styles.headline}>Welcome to Reflections</Text>
            <Text style={styles.subhead}>
              Tell {explorerLabel} who you are. This is how you'll appear on their screen when you send a Reflection.
            </Text>
          </View>

          {/* Avatar picker */}
          <View style={styles.avatarSection}>
            <TouchableOpacity onPress={showAvatarPicker} style={styles.avatarTouch} activeOpacity={0.8}>
              <View style={[styles.avatarCircle, !localAvatarUri && { backgroundColor: avatarColor }]}>
                {localAvatarUri ? (
                  <Image source={{ uri: localAvatarUri }} style={styles.avatarImage} contentFit="cover" />
                ) : (
                  <Text style={styles.avatarInitial}>{displayInitial}</Text>
                )}
              </View>
              <View style={styles.avatarBadge}>
                <Text style={styles.avatarBadgeText}>+</Text>
              </View>
            </TouchableOpacity>
            <Text style={styles.avatarHint}>{localAvatarUri ? 'Tap to change' : 'Tap to add a photo'}</Text>
            {!localAvatarUri && (
              <Text style={styles.avatarEmphasis}>
                A real photo makes a big difference.{'\n'}
                {explorerLabel} will see your face when your Reflection arrives.
              </Text>
            )}
          </View>

          {/* Name field */}
          <View style={styles.fieldSection}>
            <Text style={styles.fieldLabel}>Your Name</Text>
            <Text style={styles.fieldDescription}>
              This is how you'll be introduced to {explorerLabel} when you send a Reflection — for example, "Mom" or "Uncle Pete."
            </Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="e.g. Mom, Uncle Pete…"
              placeholderTextColor="#555"
              autoCapitalize="words"
              returnKeyType="done"
              onSubmitEditing={handleFinish}
            />
          </View>

          <TouchableOpacity
            style={[styles.finishButton, submitting && styles.finishButtonDisabled]}
            onPress={handleFinish}
            disabled={submitting}
            activeOpacity={0.85}
          >
            <Text style={styles.finishButtonText}>Get Started</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#121212',
  },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 48,
    paddingBottom: 40,
  },
  header: {
    marginBottom: 40,
  },
  headline: {
    fontSize: 28,
    fontWeight: '700',
    color: '#fff',
    marginBottom: 12,
  },
  subhead: {
    fontSize: 16,
    color: '#aaa',
    lineHeight: 24,
  },
  avatarSection: {
    alignItems: 'center',
    marginBottom: 40,
  },
  avatarTouch: {
    position: 'relative',
    marginBottom: 10,
  },
  avatarCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#2a2a2a',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImage: {
    width: 100,
    height: 100,
    borderRadius: 50,
  },
  avatarInitial: {
    fontSize: 42,
    fontWeight: '600',
    color: '#fff',
  },
  avatarBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#2e78b7',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#121212',
  },
  avatarBadgeText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 22,
  },
  avatarHint: {
    color: '#666',
    fontSize: 13,
    marginBottom: 10,
  },
  avatarEmphasis: {
    color: '#aaa',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    maxWidth: 260,
  },
  fieldSection: {
    marginBottom: 32,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#aaa',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  fieldDescription: {
    fontSize: 14,
    color: '#666',
    lineHeight: 20,
    marginBottom: 12,
  },
  input: {
    backgroundColor: '#1e1e1e',
    borderRadius: 10,
    padding: 14,
    fontSize: 18,
    color: '#fff',
    borderWidth: 1,
    borderColor: '#333',
  },
  finishButton: {
    backgroundColor: '#2e78b7',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  finishButtonDisabled: {
    opacity: 0.5,
  },
  finishButtonText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
  },
});
