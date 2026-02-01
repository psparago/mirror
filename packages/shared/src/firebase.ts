import ReactNativeAsyncStorage from '@react-native-async-storage/async-storage';
import { getApp, getApps, initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { Platform } from 'react-native';

// From GoogleService-Info.plist (reflections-1200b). appId/measurementId: not in plist — add a Web app in Firebase (reflections-1200b) and paste its appId and measurementId here if the web SDK is used (e.g. db in Connect).
const firebaseConfig = {
  apiKey: "AIzaSyBDaniN4IpEu1frspmR0U5MeU-H0DB1wPM",
  authDomain: "reflections-1200b.firebaseapp.com",
  projectId: "reflections-1200b",
  storageBucket: "reflections-1200b.firebasestorage.app",
  messagingSenderId: "759023712124",
  appId: "1:759023712124:web:000000000000000000000",
  measurementId: "G-XXXXXXXXXX"
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// Safe import for React Native environment
import { browserPersistence, getReactNativePersistence, initializeAuth } from 'firebase/auth';

export const auth = initializeAuth(app, {
  persistence: Platform.OS === 'web'
    ? browserPersistence
    : getReactNativePersistence(ReactNativeAsyncStorage)
});


export const db = getFirestore(app);
export default app;