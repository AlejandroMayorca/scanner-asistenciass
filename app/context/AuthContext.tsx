'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { onAuthStateChanged, signInWithEmailAndPassword, signOut as fbSignOut } from 'firebase/auth'
import type { User } from 'firebase/auth'
import { auth } from '../lib/firebase'
import { getUsuarioPerfil, setUsuarioPerfil } from '../lib/firestore'
import type { UserProfile } from '../lib/types'

const ADMIN_EMAIL = 'admin@cedulascan.com'

interface AuthCtx {
  user: User | null
  profile: UserProfile | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<UserProfile>
  signOut: () => Promise<void>
}

const Ctx = createContext<AuthCtx | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async fbUser => {
      setUser(fbUser)
      if (fbUser) {
        let p = await getUsuarioPerfil(fbUser.uid).catch(() => null)
        // Auto-seed admin document if missing
        if (!p && fbUser.email === ADMIN_EMAIL) {
          await setUsuarioPerfil(fbUser.uid, { email: ADMIN_EMAIL, rol: 'admin', activo: true }).catch(() => {})
          p = await getUsuarioPerfil(fbUser.uid).catch(() => null)
        }
        setProfile(p)
      } else {
        setProfile(null)
      }
      setLoading(false)
    })
    return unsub
  }, [])

  const signIn = async (email: string, password: string): Promise<UserProfile> => {
    const cred = await signInWithEmailAndPassword(auth, email, password)

    let p = await getUsuarioPerfil(cred.user.uid).catch(() => null)

    // Auto-seed admin document on first sign-in
    if (!p && email === ADMIN_EMAIL) {
      await setUsuarioPerfil(cred.user.uid, { email: ADMIN_EMAIL, rol: 'admin', activo: true })
      p = await getUsuarioPerfil(cred.user.uid).catch(() => null)
    }

    if (!p) {
      // Allow admin@cedulascan.com even without a Firestore doc (fallback)
      if (email === ADMIN_EMAIL) {
        const fallback: UserProfile = {
          id: cred.user.uid,
          email: ADMIN_EMAIL,
          rol: 'admin',
          activo: true,
          creadoEn: new Date(),
        }
        setProfile(fallback)
        return fallback
      }
      throw new Error('Usuario no registrado en el sistema. Contacta al administrador.')
    }

    if (!p.activo) throw new Error('Tu cuenta está desactivada. Contacta al administrador.')
    setProfile(p)
    return p
  }

  const signOut = async () => {
    await fbSignOut(auth)
    setProfile(null)
    setUser(null)
  }

  return <Ctx.Provider value={{ user, profile, loading, signIn, signOut }}>{children}</Ctx.Provider>
}

export function useAuth() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
