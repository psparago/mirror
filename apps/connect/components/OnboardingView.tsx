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
import { TutorialCarousel } from './TutorialCarousel';

const OVERLAY_ID = 'connect-onboarding-wait-overlay';

type OnboardingView = 'identity' | 'tutorial_prompt' | 'carousel';

export function OnboardingView() {
  const { user } = useAuth();
  const { activeRelationship, explorerName } = useExplorer();
  const waitOverlay = useWaitOverlay();

  const explorerLabel = explorerName || 'the Explorer';

  const [view, setView] = useState<OnboardingView>('identity');
  const [name, setName] = useState(activeRelationship?.companionName || '');
  const [localAvatarUri, setLocalAvatarUri] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const explorerId = activeRelationship?.explorerId || '';
  const displayInitial = getAvatarInitial(name || user?.email || '');
  const avatarColor = getAvatarColor(user?.uid || '');

  // --- AVATAR PICKER ---

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

  // --- PHASE A: Save identity, then advance to tutorial prompt ---

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

      // Phase A: save identity only — onboarding_complete stays false
      await setDoc(
        doc(db, 'relationships', activeRelationship.id),
        {
          companionName: trimmedName,
          ...(companionAvatarS3Key ? { companionAvatarS3Key } : {}),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      setView('tutorial_prompt');
    } catch (err: any) {
      console.error('[OnboardingView] Identity save failed:', err);
      Alert.alert('Error', 'Could not save your profile. Please try again.');
    } finally {
      setSubmitting(false);
      waitOverlay.hide(OVERLAY_ID);
    }
  };

  // --- PHASE B: Lift the gate ---

  const completeonboarding = async (tutorialViewed: boolean) => {
    if (!activeRelationship?.id) return;

    waitOverlay.show(
      { title: 'All set!', detail: 'Getting things ready…', tone: 'sparkle' },
      OVERLAY_ID
    );

    try {
      await setDoc(
        doc(db, 'relationships', activeRelationship.id),
        {
          onboarding_complete: true,
          tutorial_asked: true,
          ...(tutorialViewed ? { tutorial_viewed: true } : {}),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      // onSnapshot in useRelationships picks up onboarding_complete: true → gate lifts
    } catch (err: any) {
      console.error('[OnboardingView] Gate lift failed:', err);
      Alert.alert('Error', 'Something went wrong. Please try again.');
    } finally {
      waitOverlay.hide(OVERLAY_ID);
    }
  };

  // --- RENDERS ---

  if (view === 'carousel') {
    return (
      <View style={{ flex: 1, backgroundColor: '#121212' }}>
        <TutorialCarousel onFinish={(didView) => completeonboarding(didView)} />
      </View>
    );
  }

  if (view === 'tutorial_prompt') {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.promptContainer}>
          <View style={styles.promptContent}>
            <View style={styles.promptIconCircle}>
              <Text style={styles.promptIcon}>✦</Text>
            </View>
            <Text style={styles.promptHeadline}>One more thing…</Text>
            <Text style={styles.promptBody}>
              Would you like a 30-second tour of how Reflections works?
            </Text>
          </View>

          <View style={styles.promptActions}>
            <TouchableOpacity
              style={styles.showMeButton}
              onPress={() => setView('carousel')}
              activeOpacity={0.85}
            >
              <Text style={styles.showMeText}>Show Me</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.maybeLaterButton}
              onPress={() => completeonboarding(false)}
              activeOpacity={0.7}
            >
              <Text style={styles.maybeLaterText}>Maybe Later</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // Default: identity view
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

  // Tutorial prompt view
  promptContainer: {
    flex: 1,
    paddingHorizontal: 28,
    paddingBottom: 40,
    justifyContent: 'space-between',
  },
  promptContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
  },
  promptIconCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: 'rgba(252, 211, 77, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  promptIcon: {
    fontSize: 44,
    color: '#fcd34d',
  },
  promptHeadline: {
    fontSize: 26,
    fontWeight: '700',
    color: '#fff',
    textAlign: 'center',
  },
  promptBody: {
    fontSize: 17,
    color: '#aaa',
    lineHeight: 26,
    textAlign: 'center',
    maxWidth: 300,
  },
  promptActions: {
    gap: 12,
  },
  showMeButton: {
    backgroundColor: '#2e78b7',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  showMeText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
  },
  maybeLaterButton: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  maybeLaterText: {
    color: '#666',
    fontSize: 15,
    fontWeight: '500',
  },
});
