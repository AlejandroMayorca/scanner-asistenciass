// firebase config for scan-eventos
import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: "AIzaSyAHQjDcPZ4wNvGStxhTEG1UoQ8T4emAvK4",
  authDomain: "scanner-eventos.firebaseapp.com",
  projectId: "scanner-eventos",
  storageBucket: "scanner-eventos.firebasestorage.app",
  messagingSenderId: "121882361856",
  appId: "1:121882361856:web:e08748ae773871368d0c85",
  measurementId: "G-6VDBV61CGC",
}

const app: FirebaseApp = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp()

export const auth = getAuth(app)
export const db = getFirestore(app)
export { app, firebaseConfig }
