import ReactNativeAsyncStorage from '@react-native-async-storage/async-storage';
import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  getAuth,
  initializeAuth,
  onAuthStateChanged,
  signInAnonymously,
} from 'firebase/auth';
import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  disableNetwork,
  doc,
  enableNetwork,
  getDoc,
  getDocs,
  increment,
  initializeFirestore,
  limit,
  limitToLast,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch
} from 'firebase/firestore';
import { Platform } from 'react-native';

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

// ✅ FIXED: Removed localCache setting
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true, 
  // We removed localCache: persistentLocalCache() 
  // This avoids the "Missing IndexedDB" error.
});

export {
  addDoc, arrayRemove, arrayUnion, collection, deleteDoc, disableNetwork, doc, enableNetwork, getDoc,
  getDocs, increment, limit, limitToLast, onSnapshot, orderBy, query, serverTimestamp, setDoc, updateDoc, where, writeBatch
};

  export { onAuthStateChanged, signInAnonymously };

export default app;