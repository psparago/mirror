import { API_ENDPOINTS, getAvatarColor, getAvatarInitial, useAuth, useExplorer, useWaitOverlay } from '@projectmirror/shared';
import { db, doc, serverTimestamp, setDoc } from '@projectmirror/shared/firebase';
import { Camera, CameraType, CameraView } from 'expo-camera';
import * as FileSystem from 'expo-file-system';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import React, { useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Linking,
  Modal,
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
  const [androidCameraVisible, setAndroidCameraVisible] = useState(false);
  const [androidCameraFacing, setAndroidCameraFacing] = useState<CameraType>('front');
  const [androidCameraCapturing, setAndroidCameraCapturing] = useState(false);
  const [androidCameraReady, setAndroidCameraReady] = useState(false);
  // Guards against double-taps stacking picker invocations while one is mid-launch.
  const pickingRef = useRef(false);
  const androidCameraRef = useRef<CameraView>(null);

  const explorerId = activeRelationship?.explorerId || '';
  const displayInitial = getAvatarInitial(name || user?.email || '');
  const avatarColor = getAvatarColor(user?.uid || '');

  // --- AVATAR PICKER ---

  const ensureCameraPermission = async () => {
    const current = await Camera.getCameraPermissionsAsync();
    let granted = current.granted;

    if (!granted && current.canAskAgain) {
      // Do not timeout the native permission prompt. The user may pause on the
      // dialog, and racing it can produce a false timeout while Android still
      // completes the permission grant in the background.
      const requested = await Camera.requestCameraPermissionsAsync();
      granted = requested.granted;
    }

    if (!granted) {
      Alert.alert(
        'Camera Access Needed',
        'To take a selfie, grant camera access in Settings.',
        [
          { text: 'Open Settings', onPress: () => Linking.openSettings() },
          { text: 'Cancel', style: 'cancel' },
        ]
      );
      return false;
    }

    return true;
  };

  const openAndroidCamera = async () => {
    if (pickingRef.current) return;
    pickingRef.current = true;

    try {
      const hadPermission = (await Camera.getCameraPermissionsAsync()).granted;
      const hasPermission = await ensureCameraPermission();
      if (!hasPermission) return;
      if (!hadPermission) {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      setAndroidCameraReady(false);
      setAndroidCameraVisible(true);
    } catch (err) {
      console.error('[OnboardingView] Android camera open failed:', err);
      Alert.alert('Camera Unavailable', 'Could not open the camera. Please try again.');
    } finally {
      pickingRef.current = false;
    }
  };

  const captureAndroidSelfie = async () => {
    if (!androidCameraRef.current || androidCameraCapturing || !androidCameraReady) return;

    try {
      setAndroidCameraCapturing(true);
      const picture = await androidCameraRef.current.takePictureAsync({ quality: 0.8 });
      if (picture?.uri) {
        setLocalAvatarUri(picture.uri);
        setAndroidCameraVisible(false);
      }
    } catch (err) {
      console.error('[OnboardingView] Android selfie capture failed:', err);
      Alert.alert('Error', 'Could not capture your selfie. Please try again.');
    } finally {
      setAndroidCameraCapturing(false);
    }
  };

  const pickAvatar = async (source: 'camera' | 'library') => {
    if (source === 'camera' && Platform.OS === 'android') {
      await openAndroidCamera();
      return;
    }

    // Debounce: ignore taps while a previous pick is still in flight. Without this,
    // repeated taps stack camera/library invocations and the OS surfaces them later
    // (e.g. after a different picker dismisses), causing the "stacked cameras" bug.
    if (pickingRef.current) return;
    pickingRef.current = true;

    try {
      if (source === 'camera') {
        const hadPermission = (await Camera.getCameraPermissionsAsync()).granted;
        const hasPermission = await ensureCameraPermission();
        if (!hasPermission) return;

        // When permission was just granted, the OS is still dismissing the dialog.
        // Wait for that transition before using iOS' picker flow.
        if (!hadPermission) {
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
      }

      // allowsEditing on Android triggers ucrop, whose toolbar is hidden by
      // edgeToEdgeEnabled:true — the user sees no accept button. Disable on Android.
      const allowsEditing = Platform.OS === 'ios';
      const result = source === 'camera'
        ? await ImagePicker.launchCameraAsync({
            allowsEditing,
            aspect: [1, 1],
            quality: 0.8,
            ...(Platform.OS === 'ios' ? { cameraType: ImagePicker.CameraType.front } : {}),
          })
        : await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            allowsEditing,
            aspect: [1, 1],
            quality: 0.8,
          });

      if (!result.canceled && result.assets[0]?.uri) {
        setLocalAvatarUri(result.assets[0].uri);
      }
    } catch (err) {
      console.error('[OnboardingView] pickAvatar error:', err);
      Alert.alert(
        'Camera Unavailable',
        'Could not open the camera. You may need to grant permission in Settings.',
        [
          { text: 'Open Settings', onPress: () => Linking.openSettings() },
          { text: 'Cancel', style: 'cancel' },
        ]
      );
    } finally {
      pickingRef.current = false;
    }
  };

  // showAvatarPicker removed — source buttons are rendered inline to avoid
  // Android's Alert Dialog timing issue where camera/gallery intents
  // fire while the Dialog window token is still attached.

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

  if (androidCameraVisible) {
    return (
      <Modal
        visible
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => {
          setAndroidCameraReady(false);
          setAndroidCameraVisible(false);
        }}
      >
        <View style={styles.androidCameraContainer}>
          <CameraView
            key={androidCameraFacing}
            ref={androidCameraRef}
            style={StyleSheet.absoluteFill}
            facing={androidCameraFacing}
            active={androidCameraVisible}
            onCameraReady={() => setAndroidCameraReady(true)}
            onMountError={(event) => {
              console.warn('[OnboardingView] Android camera mount error:', event.message);
              setAndroidCameraReady(false);
            }}
          />

          <SafeAreaView style={styles.androidCameraOverlay}>
            <View style={styles.androidCameraTopControls}>
              <TouchableOpacity
                style={styles.androidCameraControl}
                onPress={() => {
                  setAndroidCameraReady(false);
                  setAndroidCameraVisible(false);
                }}
                disabled={androidCameraCapturing}
                activeOpacity={0.8}
              >
                <Text style={styles.androidCameraControlText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.androidCameraControl}
                onPress={() => {
                  setAndroidCameraReady(false);
                  setAndroidCameraFacing((current) => current === 'front' ? 'back' : 'front');
                }}
                disabled={androidCameraCapturing}
                activeOpacity={0.8}
              >
                <Text style={styles.androidCameraControlText}>Flip</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.androidCameraBottomControls}>
              <TouchableOpacity
                style={[
                  styles.androidShutterButton,
                  (androidCameraCapturing || !androidCameraReady) && styles.androidShutterButtonDisabled,
                ]}
                onPress={captureAndroidSelfie}
                disabled={androidCameraCapturing || !androidCameraReady}
                activeOpacity={0.85}
              >
                <Text style={styles.androidShutterText}>
                  {androidCameraCapturing ? 'Capturing...' : androidCameraReady ? 'Take Selfie' : 'Starting Camera...'}
                </Text>
              </TouchableOpacity>
            </View>
          </SafeAreaView>
        </View>
      </Modal>
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
            <View style={[styles.avatarCircle, !localAvatarUri && { backgroundColor: avatarColor }]}>
              {localAvatarUri ? (
                <Image source={{ uri: localAvatarUri }} style={styles.avatarImage} contentFit="cover" />
              ) : (
                <Text style={styles.avatarInitial}>{displayInitial}</Text>
              )}
            </View>
            {/* Inline source buttons — avoids Android Alert Dialog timing issues */}
            <View style={styles.avatarActions}>
              <TouchableOpacity
                style={styles.avatarActionBtn}
                onPress={() => pickAvatar('camera')}
                activeOpacity={0.75}
              >
                <Text style={styles.avatarActionText}>📷  Take Selfie</Text>
              </TouchableOpacity>
              <View style={styles.avatarActionDivider} />
              <TouchableOpacity
                style={styles.avatarActionBtn}
                onPress={() => pickAvatar('library')}
                activeOpacity={0.75}
              >
                <Text style={styles.avatarActionText}>🖼  Choose Photo</Text>
              </TouchableOpacity>
            </View>
            {!localAvatarUri && (
              <Text style={styles.avatarEmphasis}>
                A real photo makes a big difference.{'\n'}
                {explorerLabel} will see your face when your Reflection arrives.
              </Text>
            )}
            {localAvatarUri && (
              <Text style={styles.avatarHint}>Tap an option above to change</Text>
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
  avatarActions: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e1e1e',
    borderRadius: 10,
    marginTop: 14,
    marginBottom: 12,
    overflow: 'hidden',
  },
  avatarActionBtn: {
    flex: 1,
    paddingVertical: 11,
    alignItems: 'center',
  },
  avatarActionText: {
    color: '#2e78b7',
    fontSize: 14,
    fontWeight: '600',
  },
  avatarActionDivider: {
    width: 1,
    height: '100%',
    backgroundColor: '#333',
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

  // Android in-app selfie camera
  androidCameraContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  androidCameraOverlay: {
    flex: 1,
    justifyContent: 'space-between',
  },
  androidCameraTopControls: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  androidCameraControl: {
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  androidCameraControlText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  androidCameraBottomControls: {
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingBottom: 36,
  },
  androidShutterButton: {
    backgroundColor: '#fff',
    borderRadius: 28,
    paddingHorizontal: 28,
    paddingVertical: 16,
    minWidth: 170,
    alignItems: 'center',
  },
  androidShutterButtonDisabled: {
    opacity: 0.6,
  },
  androidShutterText: {
    color: '#111',
    fontSize: 16,
    fontWeight: '800',
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
