import ReactNativeAsyncStorage from '@react-native-async-storage/async-storage';
import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  collection,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  limitToLast,
  serverTimestamp,
  increment,
  writeBatch,
  enableNetwork,
  disableNetwork,
} from 'firebase/firestore';
import {
  getAuth,
  initializeAuth,
  browserLocalPersistence,
  onAuthStateChanged,
  signInAnonymously,
} from 'firebase/auth';
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

// Auth: use initializeAuth with browserLocalPersistence on web; on React Native use getAuth (default persistence) unless getReactNativePersistence is available
export const auth = (() => {
  if (Platform.OS === 'web') {
    return initializeAuth(app, { persistence: browserLocalPersistence });
  }
  try {
    const { getReactNativePersistence } = require('firebase/auth');
    return initializeAuth(app, {
      persistence: getReactNativePersistence(ReactNativeAsyncStorage)
    });
  } catch {
    return getAuth(app);
  }
})();

export const db = getFirestore(app);

// Re-export modular Firestore functions so consumers use functional syntax: doc(db, 'col', id), getDoc(ref), etc.
export {
  doc,
  collection,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  limitToLast,
  serverTimestamp,
  increment,
  writeBatch,
  enableNetwork,
  disableNetwork,
};

export { onAuthStateChanged, signInAnonymously };

export default app;
