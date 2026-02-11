import { useAuth } from '@projectmirror/shared';
import { GoogleSigninButton } from '@react-native-google-signin/google-signin';
import { AppleAuthenticationButton, AppleAuthenticationButtonStyle, AppleAuthenticationButtonType } from 'expo-apple-authentication';
import { useRouter } from 'expo-router';
import React, { useEffect } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';

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
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color="#000" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.contentContainer}>
        {/* BRANDING */}
        <View style={styles.header}>
          <Text style={styles.title}>Reflections</Text>
          <Text style={styles.subtitle}>Connect with your Explorer</Text>
        </View>

        {/* ACTIONS */}
        <View style={styles.buttonContainer}>
          {loading ? (
            <ActivityIndicator size="large" color="#000" />
          ) : (
            <>
              {/* Apple Sign In - Available on iOS */}
              {Platform.OS === 'ios' && (
                <AppleAuthenticationButton
                  buttonType={AppleAuthenticationButtonType.CONTINUE}
                  buttonStyle={AppleAuthenticationButtonStyle.BLACK}
                  cornerRadius={8}
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

              {/* Google Sign In */}
              <GoogleSigninButton
                size={GoogleSigninButton.Size.Wide}
                color={GoogleSigninButton.Color.Light}
                onPress={async () => {
                  try {
                    await signInWithGoogle();
                  } catch (e) {
                    console.log('Google Login failed', e);
                  }
                }}
                disabled={loading}
              />
            </>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    justifyContent: 'center', 
    alignItems: 'center',
  },
  contentContainer: {
    width: '100%',
    maxWidth: 400,
    paddingHorizontal: 30,
    alignItems: 'center',
  },
  header: {
    marginBottom: 60,
    alignItems: 'center',
  },
  title: {
    fontSize: 36,
    fontWeight: '800',
    color: '#1a1a1a',
    letterSpacing: -1,
  },
  subtitle: {
    fontSize: 18,
    color: '#666',
    marginTop: 8,
    fontWeight: '500',
  },
  buttonContainer: {
    width: '100%',
    gap: 16,
    alignItems: 'center',
  },
  appleButton: {
    width: '100%', 
    height: 50,
  }
});
