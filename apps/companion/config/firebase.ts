import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
    apiKey: "AIzaSyCIl99WbAQGu1CRSAOVAln-_VJJ74tK60Y",
    authDomain: "project-mirror-23168.firebaseapp.com",
    projectId: "project-mirror-23168",
    storageBucket: "project-mirror-23168.firebasestorage.app",
    messagingSenderId: "870445864294",
    appId: "1:870445864294:web:9eef577d81d9d33ea664a7",
    measurementId: "G-LYSQPE4WTH"
  };
  
// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Services
export const auth = getAuth(app);
export const db = getFirestore(app);

export default app;

