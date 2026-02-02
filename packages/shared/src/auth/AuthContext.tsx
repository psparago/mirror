import {
  onAuthStateChanged,
  signInWithCredential,
  signOut as firebaseSignOut,
  GoogleAuthProvider,
  OAuthProvider,
  User,
} from 'firebase/auth';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import * as AppleAuthentication from 'expo-apple-authentication';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { auth } from '../firebase';

// From Google Cloud OAuth 2.0 Web client for reflections-1200b (used by Google Sign-In native SDK)
const GOOGLE_WEB_CLIENT_ID = '759023712124-7cghtfpg52lqthilcm82k1qbjfbf68ra.apps.googleusercontent.com';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signInWithApple: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({} as AuthContextType);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // 1. Initialize Google SDK
  useEffect(() => {
    GoogleSignin.configure({
      webClientId: GOOGLE_WEB_CLIENT_ID,
    });
  }, []);

  // 2. Listen for Firebase Auth State Changes
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (loading) setLoading(false);
    });
    return unsubscribe;
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

      const googleCredential = GoogleAuthProvider.credential(idToken);
      await signInWithCredential(auth, googleCredential);
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

      const provider = new OAuthProvider('apple.com');
      const credential = provider.credential({
        idToken: identityToken,
        rawNonce: undefined,
      });

      await signInWithCredential(auth, credential);

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

    await firebaseSignOut(auth);
  };

  return (
    <AuthContext.Provider value={{ user, loading, signInWithGoogle, signInWithApple, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);