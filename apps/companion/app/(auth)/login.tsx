import { useAuth } from '@projectmirror/shared';
import { GoogleSigninButton } from '@react-native-google-signin/google-signin';
import { AppleAuthenticationButton, AppleAuthenticationButtonStyle, AppleAuthenticationButtonType } from 'expo-apple-authentication';
import React from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';

export default function LoginScreen() {
  const { signInWithGoogle, signInWithApple, loading } = useAuth();

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
    maxWidth: 400, // Keeps it looking nice on iPad/Tablets too
    paddingHorizontal: 30,
    alignItems: 'center',
  },
  header: {
    marginBottom: 60,
    alignItems: 'center',
  },
  title: {
    fontSize: 36,
    fontWeight: '800', // Extra Bold
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
    gap: 16, // Adds space between buttons
    alignItems: 'center',
  },
  appleButton: {
    width: '100%', 
    height: 50, // Matches Google's standard height
  }
});