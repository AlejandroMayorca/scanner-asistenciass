'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { onAuthStateChanged, signInWithEmailAndPassword, signOut as fbSignOut } from 'firebase/auth'
import type { User } from 'firebase/auth'
import { auth } from '../lib/firebase'
import {
  getUsuarioPerfil, setUsuarioPerfil,
  getOperadorPerfil, updateOperador, registrarLog,
} from '../lib/firestore'
import type { UserProfile, OperadorPerfil } from '../lib/types'

const ADMIN_EMAIL = 'admin@cedulascan.com'

interface AuthCtx {
  user: User | null
  profile: UserProfile | null
  operadorPerfil: OperadorPerfil | null
  displayName: string
  loading: boolean
  signIn: (email: string, password: string) => Promise<UserProfile>
  signOut: () => Promise<void>
}

const Ctx = createContext<AuthCtx | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user,          setUser]          = useState<User | null>(null)
  const [profile,       setProfile]       = useState<UserProfile | null>(null)
  const [opPerfil,      setOpPerfil]      = useState<OperadorPerfil | null>(null)
  const [loading,       setLoading]       = useState(true)

  const displayName = opPerfil
    ? `${opPerfil.nombre} ${opPerfil.apellido}`.trim()
    : (profile?.email ?? user?.email ?? '')

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async fbUser => {
      setUser(fbUser)
      if (fbUser) {
        const [p, op] = await Promise.all([
          getUsuarioPerfil(fbUser.uid).catch(() => null),
          getOperadorPerfil(fbUser.uid).catch(() => null),
        ])

        // Deactivated operator — force sign-out
        if (op && !op.activo) {
          await fbSignOut(auth)
          return
        }

        if (op) setOpPerfil(op)

        if (!p && fbUser.email === ADMIN_EMAIL) {
          await setUsuarioPerfil(fbUser.uid, { email: ADMIN_EMAIL, rol: 'admin', activo: true }).catch(() => {})
          const freshP = await getUsuarioPerfil(fbUser.uid).catch(() => null)
          setProfile(freshP)
        } else if (!p && op) {
          // Operator exists in operadores/ but not in usuarios/ — synthetic profile
          setProfile({ id: fbUser.uid, email: op.email, rol: 'ayudante', activo: true, creadoEn: op.creadoEn })
        } else {
          setProfile(p)
        }
      } else {
        setProfile(null)
        setOpPerfil(null)
      }
      setLoading(false)
    })
    return unsub
  }, [])

  const signIn = async (email: string, password: string): Promise<UserProfile> => {
    const cred = await signInWithEmailAndPassword(auth, email, password)
    const uid  = cred.user.uid

    // Check operadores/ first (new operator system)
    const op = await getOperadorPerfil(uid).catch(() => null)
    if (op) {
      if (!op.activo) {
        await fbSignOut(auth)
        throw new Error('Tu cuenta ha sido desactivada. Contacta al administrador.')
      }
      updateOperador(uid, { ultimoAcceso: new Date() }).catch(() => {})
      setOpPerfil(op)
      const synthetic: UserProfile = { id: uid, email: op.email, rol: 'ayudante', activo: true, creadoEn: op.creadoEn }
      setProfile(synthetic)
      const opNombre = `${op.nombre} ${op.apellido}`.trim()
      registrarLog({ tipo: 'LOGIN', eventoId: null, eventoNombre: null, asistenciaId: null, cedula: '', nombreAsistente: '', operadorUid: uid, operadorNombre: opNombre, operadorEmail: op.email, detalles: 'Inicio de sesión', ip: '' })
      return synthetic
    }

    // Fallback: usuarios/ (admin + legacy ayudantes)
    let p = await getUsuarioPerfil(uid).catch(() => null)

    if (!p && email === ADMIN_EMAIL) {
      await setUsuarioPerfil(uid, { email: ADMIN_EMAIL, rol: 'admin', activo: true })
      p = await getUsuarioPerfil(uid).catch(() => null)
    }

    if (!p) {
      if (email === ADMIN_EMAIL) {
        const fallback: UserProfile = { id: uid, email: ADMIN_EMAIL, rol: 'admin', activo: true, creadoEn: new Date() }
        setProfile(fallback)
        registrarLog({ tipo: 'LOGIN', eventoId: null, eventoNombre: null, asistenciaId: null, cedula: '', nombreAsistente: '', operadorUid: uid, operadorNombre: ADMIN_EMAIL, operadorEmail: ADMIN_EMAIL, detalles: 'Inicio de sesión', ip: '' })
        return fallback
      }
      throw new Error('Usuario no registrado en el sistema. Contacta al administrador.')
    }

    if (!p.activo) throw new Error('Tu cuenta está desactivada. Contacta al administrador.')
    setProfile(p)
    registrarLog({ tipo: 'LOGIN', eventoId: null, eventoNombre: null, asistenciaId: null, cedula: '', nombreAsistente: '', operadorUid: uid, operadorNombre: p.email, operadorEmail: p.email, detalles: 'Inicio de sesión', ip: '' })
    return p
  }

  const signOut = async () => {
    if (user) {
      const nombre = opPerfil
        ? `${opPerfil.nombre} ${opPerfil.apellido}`.trim()
        : (profile?.email ?? user.email ?? '')
      registrarLog({ tipo: 'LOGOUT', eventoId: null, eventoNombre: null, asistenciaId: null, cedula: '', nombreAsistente: '', operadorUid: user.uid, operadorNombre: nombre, operadorEmail: user.email ?? '', detalles: 'Cierre de sesión', ip: '' })
    }
    await fbSignOut(auth)
    setProfile(null)
    setOpPerfil(null)
    setUser(null)
  }

  return (
    <Ctx.Provider value={{ user, profile, operadorPerfil: opPerfil, displayName, loading, signIn, signOut }}>
      {children}
    </Ctx.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
