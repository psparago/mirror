import { GoogleSignin } from '@react-native-google-signin/google-signin';
import * as AppleAuthentication from 'expo-apple-authentication';
import {
  signOut as firebaseSignOut,
  GoogleAuthProvider,
  OAuthProvider,
  onAuthStateChanged,
  signInWithCredential,
  User,
} from 'firebase/auth';
import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  auth,
  db,
  doc,
  getDoc,
  serverTimestamp,
  setDoc
} from '../firebase';

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

      const response = await GoogleSignin.signIn() as any;
      const idToken = response?.idToken ?? response?.data?.idToken;

      // User cancelled or dismissed sign-in — no token, no error
      if (!idToken) return;

      const googleCredential = GoogleAuthProvider.credential(idToken);
      const userCredential = await signInWithCredential(auth, googleCredential);
      const u = userCredential.user;

      // Sync User Data to Firestore immediately
      // We use the fresh user object from the credential
      const userRef = doc(db, 'users', u.uid);
      const userSnap = await getDoc(userRef);
      const userData: any = {
        email: u.email,
        provider: 'google.com',
        lastLogin: serverTimestamp(),
      };

      // Only set Name if missing in DB
      if (!userSnap.exists() || !userSnap.data()?.companionName) {
        if (u.displayName) {
          userData.companionName = u.displayName;
        }
      }

      // Safe Write
      await setDoc(userRef, userData, { merge: true });
    } catch (error) {
      console.error('Google Sign-In Error:', error);
      throw error;
    }
  };

  // --- APPLE SIGN IN ---
  const signInWithApple = async () => {
    try {
      // Start the native Apple Sign-In flow
      const appleCredential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });

      // Extract the token (Remove 'nonce' from here)
      const { identityToken, authorizationCode } = appleCredential;

      if (!identityToken) {
        throw new Error('Apple Sign-In failed - no identity token');
      }

      const provider = new OAuthProvider('apple.com');
      const credential = provider.credential({
        idToken: identityToken,
        rawNonce: undefined,
      });

      const userCredential = await signInWithCredential(auth, credential);
      const u = userCredential.user;

      // Check existing profile
      const userRef = doc(db, 'users', u.uid);
      const userSnap = await getDoc(userRef);
      
      // Prepare User Data
      const userData: any = {
        email: u.email,
        provider: 'apple.com',
        lastLogin: serverTimestamp(),
      };

      let candidateName = '';
      if (appleCredential.fullName) {
        const given = appleCredential.fullName.givenName || '';
        const family = appleCredential.fullName.familyName || '';
        candidateName = `${given} ${family}`.trim();  
      }

      // Only set Name if we have one AND it's missing in DB
      if (candidateName && (!userSnap.exists() || !userSnap.data()?.companionName)) {
         userData.companionName = candidateName;
      }

      // Safe Write
      await setDoc(userRef, userData, { merge: true });
      
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