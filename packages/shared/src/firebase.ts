import ReactNativeAsyncStorage from '@react-native-async-storage/async-storage';
import { getApp, getApps, initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { Platform } from 'react-native';

const firebaseConfig = {
  apiKey: "AIzaSyCIl99WbAQGu1CRSAOVAln-_VJJ74tK60Y",
  authDomain: "project-mirror-23168.firebaseapp.com",
  projectId: "project-mirror-23168",
  storageBucket: "project-mirror-23168.firebasestorage.app",
  messagingSenderId: "870445864294",
  appId: "1:870445864294:web:9eef577d81d9d33ea664a7",
  measurementId: "G-LYSQPE4WTH"
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