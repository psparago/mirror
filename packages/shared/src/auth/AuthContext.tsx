import auth, { FirebaseAuthTypes } from '@react-native-firebase/auth';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import * as AppleAuthentication from 'expo-apple-authentication';
import React, { createContext, useContext, useEffect, useState } from 'react';

const GOOGLE_WEB_CLIENT_ID = '870445864294-0iogp0pvi3gqsobdq1ht4pkid9h1nnv0.apps.googleusercontent.com'; 

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
  const signInWithGoogle = async () => {
    try {
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
      
      // Get the users ID token
      const signInResult = await GoogleSignin.signIn();
      // Try to get the ID token from the result, handling different library versions
      let idToken = signInResult.data?.idToken;
      if (!idToken) {
          // If using older version of library where response is the object itself
          idToken = (signInResult as any).idToken; 
      }
      
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