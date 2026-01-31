import firebase from '@react-native-firebase/app';
import auth, { FirebaseAuthTypes } from '@react-native-firebase/auth';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import * as AppleAuthentication from 'expo-apple-authentication';
import React, { createContext, useContext, useEffect, useState } from 'react';

const GOOGLE_WEB_CLIENT_ID = '870445864294-0iogp0pvi3gqsobdq1ht4pkid9h1nnv0.apps.googleusercontent.com';
const AuthContext = createContext<AuthContextType>({} as AuthContextType);

const firebaseConfig = {
  apiKey: "AIzaSyDB4Px0_YfAl29MLB_LByrd_6v1jFh1VHk",
  appId: "1:870445864294:ios:e9d73abd72299974a664a7",
  projectId: "project-mirror-23168",
  storageBucket: "project-mirror-23168.firebasestorage.app",
  messagingSenderId: "870445864294",
  authDomain: "project-mirror-23168.firebaseapp.com",
  databaseURL: "https://project-mirror-23168.firebaseio.com"
};

interface AuthContextType {
  user: FirebaseAuthTypes.User | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signInWithApple: () => Promise<void>;
  signOut: () => Promise<void>;
}

if (firebase.apps.length === 0) {
  try {
    firebase.initializeApp(firebaseConfig);
    console.log("Firebase initialized manually via JS");
  } catch (e) {
    console.error("Firebase init failed", e);
  }
}

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