import { useAuth } from '@projectmirror/shared';
import { FontAwesome } from '@expo/vector-icons';
import {
  AppleAuthenticationButton,
  AppleAuthenticationButtonStyle,
  AppleAuthenticationButtonType,
} from 'expo-apple-authentication';
import { useRouter } from 'expo-router';
import React, { useEffect } from 'react';
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

export default function LoginScreen() {
  const { user, signInWithGoogle, signInWithApple, loading } = useAuth();
  const router = useRouter();

  // After successful sign-in, navigate to BootScreen which decides where to go.
  // Deferred to next tick because the ExplorerProvider key remounts the tree
  // when user changes — navigating during remount causes a crash.
  useEffect(() => {
    if (!user) return;
    const timer = setTimeout(() => {
      router.replace('/');
    }, 0);
    return () => clearTimeout(timer);
  }, [user]);

  // Show spinner while redirect is in progress after sign-in
  if (user) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#fff" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.contentContainer}>
        {/* BRANDING */}
        <View style={styles.header}>
          <Text style={styles.appIcon}>✨</Text>
          <Text style={styles.title}>Reflections</Text>
          <Text style={styles.subtitle}>Connect with your Explorer</Text>
        </View>

        {/* ACTIONS */}
        <View style={styles.buttonContainer}>
          {loading ? (
            <ActivityIndicator size="large" color="#fff" />
          ) : (
            <>
              {/* Apple Sign In */}
              {Platform.OS === 'ios' && (
                <AppleAuthenticationButton
                  buttonType={AppleAuthenticationButtonType.CONTINUE}
                  buttonStyle={AppleAuthenticationButtonStyle.WHITE}
                  cornerRadius={12}
                  style={styles.appleButton}
                  onPress={async () => {
                    try {
                      await signInWithApple();
                    } catch (e) {
                      console.log('Apple Login failed', e);
                    }
                  }}
                />
              )}

              {/* Google Sign In — custom styled button */}
              <TouchableOpacity
                style={styles.googleButton}
                onPress={async () => {
                  try {
                    await signInWithGoogle();
                  } catch (e) {
                    console.log('Google Login failed', e);
                  }
                }}
                disabled={loading}
                activeOpacity={0.8}
              >
                <FontAwesome name="google" size={18} color="#fff" style={{ marginRight: 10 }} />
                <Text style={styles.googleButtonText}>Continue with Google</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* FOOTER */}
        <Text style={styles.footer}>
          Sign in to send Reflections to your loved ones
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f1a20',
    justifyContent: 'center',
    alignItems: 'center',
  },
  contentContainer: {
    width: '100%',
    maxWidth: 380,
    paddingHorizontal: 30,
    alignItems: 'center',
  },
  header: {
    marginBottom: 50,
    alignItems: 'center',
  },
  appIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  title: {
    fontSize: 34,
    fontWeight: '800',
    color: '#fff',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 17,
    color: 'rgba(255, 255, 255, 0.6)',
    marginTop: 8,
    fontWeight: '500',
  },
  buttonContainer: {
    width: '100%',
    gap: 14,
    alignItems: 'center',
  },
  appleButton: {
    width: '100%',
    height: 52,
  },
  googleButton: {
    width: '100%',
    height: 52,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
  },
  googleButtonText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
  footer: {
    marginTop: 40,
    fontSize: 13,
    color: 'rgba(255, 255, 255, 0.35)',
    textAlign: 'center',
  },
});
