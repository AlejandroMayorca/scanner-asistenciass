'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { onAuthStateChanged, signInWithEmailAndPassword, signOut as fbSignOut } from 'firebase/auth'
import type { User } from 'firebase/auth'
import { auth } from '../lib/firebase'
import { getUsuarioPerfil } from '../lib/firestore'
import type { UserProfile } from '../lib/types'

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
        const p = await getUsuarioPerfil(fbUser.uid)
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
    const p = await getUsuarioPerfil(cred.user.uid)
    if (!p) throw new Error('Usuario no registrado en el sistema. Contacta al administrador.')
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
