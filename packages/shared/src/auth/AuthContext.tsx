import firebase from '@react-native-firebase/app';
import auth, { FirebaseAuthTypes } from '@react-native-firebase/auth';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Application from 'expo-application';
import React, { createContext, useContext, useEffect, useState } from 'react';

// From GoogleService-Info.plist (Connect) and Google Cloud OAuth 2.0 Web client for reflections-1200b
const GOOGLE_WEB_CLIENT_ID = '759023712124-7cghtfpg52lqthilcm82k1qbjfbf68ra.apps.googleusercontent.com';

// Connect app iOS app IDs from GoogleService-Info.plist (Connect = prod; dev uses same unless you add a separate Firebase iOS app for connect.dev)
const CONNECT_PROD_APP_ID = '1:759023712124:ios:c241b3a0612ad51a0a96f9';
const CONNECT_DEV_APP_ID = '1:759023712124:ios:1c591950a74fc3ff0a96f9';

const EXPLORER_PROD_APP_ID = '1:759023712124:ios:88fa846cef16f7c20a96f9';
const EXPLORER_DEV_APP_ID = '1:759023712124:ios:b3622cc10ef04d4f0a96f9';

const bundleId = Application.applicationId;
let activeAppId = CONNECT_PROD_APP_ID; // Default safety net

if (bundleId === 'com.psparago.reflections.connect.dev') {
  activeAppId = CONNECT_DEV_APP_ID;
} else if (bundleId === 'com.psparago.reflections.explorer') {
  activeAppId = EXPLORER_PROD_APP_ID;
} else if (bundleId === 'com.psparago.reflections.explorer.dev') {
  activeAppId = EXPLORER_DEV_APP_ID;
}

const firebaseConfig = {
  apiKey: "AIzaSyBDaniN4IpEu1frspmR0U5MeU-H0DB1wPM",
  appId: activeAppId,
  projectId: "reflections-1200b",
  storageBucket: "reflections-1200b.firebasestorage.app",
  messagingSenderId: "759023712124",
  authDomain: "reflections-1200b.firebaseapp.com",
  databaseURL: "https://reflections-1200b.firebaseio.com"
};

if (firebase.apps.length === 0) {
  try {
    firebase.initializeApp(firebaseConfig);
    console.log(`[AuthContext] Initialized Firebase for: ${bundleId}`);
  } catch (e) {
    console.error("[AuthContext] Firebase init failed", e);
  }
}

interface AuthContextType {
  user: FirebaseAuthTypes.User | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signInWithApple: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({} as AuthContextType);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<FirebaseAuthTypes.User | null>(null);
  const [loading, setLoading] = useState(true);

  // 1. Initialize Google SDK
  useEffect(() => {
    GoogleSignin.configure({
      webClientId: GOOGLE_WEB_CLIENT_ID,
    });
  }, []);

  // 2. Listen for Firebase Auth State Changes
  useEffect(() => {
    const subscriber = auth().onAuthStateChanged((currentUser) => {
      setUser(currentUser);
      if (loading) setLoading(false);
    });
    return subscriber; // unsubscribe on unmount
  }, []);

  // --- GOOGLE SIGN IN ---
  // --- GOOGLE SIGN IN (Universal Fix) ---
  const signInWithGoogle = async () => {
    try {
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
      
      // CAST AS ANY: Tells TypeScript "I know what I'm doing, relax."
      const response = await GoogleSignin.signIn() as any;
      
      // FALLBACK EXTRACTION:
      // Checks both places: 
      // 1. response.idToken (v13 style)
      // 2. response.data.idToken (v16 style)
      const idToken = response.idToken || response.data?.idToken;

      if (!idToken) throw new Error('No ID token found');

      // Create a Google credential with the token
      const googleCredential = auth.GoogleAuthProvider.credential(idToken);

      // Sign-in the user with the credential
      await auth().signInWithCredential(googleCredential);
    } catch (error) {
      console.error('Google Sign-In Error:', error);
      throw error;
    }
  };
  
  // --- APPLE SIGN IN ---
  const signInWithApple = async () => {
    try {
      // 1. Start the native Apple Sign-In flow
      const appleCredential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });

      // 2. Extract the token (Remove 'nonce' from here)
      const { identityToken, authorizationCode } = appleCredential;

      if (!identityToken) {
        throw new Error('Apple Sign-In failed - no identity token');
      }

      // 3. Create the Credential (FIXED: Use static method, not 'new')
      // Note: We pass 'rawNonce' as the second argument. 
      // Since we didn't send a nonce to Apple, we pass null or empty string.
      const credential = auth.AppleAuthProvider.credential(identityToken, '');

      // 4. Sign in to Firebase
      await auth().signInWithCredential(credential);

    } catch (error: any) {
      // Ignore "User canceled" error (ERR_CANCELED is the standard code)
      if (error.code !== 'ERR_CANCELED') {
        console.error('Apple Sign-In Error:', error);
        throw error;
      }
    }
  };

  const signOut = async () => {
    try {
      await GoogleSignin.signOut(); // Clean up Google session
    } catch (e) { /* Ignore if not signed in to Google */ }

    await auth().signOut();
  };

  return (
    <AuthContext.Provider value={{ user, loading, signInWithGoogle, signInWithApple, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);