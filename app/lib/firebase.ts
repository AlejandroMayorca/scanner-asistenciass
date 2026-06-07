// firebase config for scan-eventos
import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: "AIzaSyBR888T82fuahshq-YAPn2fj91AjQ_bZmE",
  authDomain: "scan-eventos.firebaseapp.com",
  projectId: "scan-eventos",
  storageBucket: "scan-eventos.firebasestorage.app",
  messagingSenderId: "708612315357",
  appId: "1:708612315357:web:8bb43cad44631c1ad56334",
}

const app: FirebaseApp = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp()

export const auth = getAuth(app)
export const db = getFirestore(app)
export { app, firebaseConfig }
