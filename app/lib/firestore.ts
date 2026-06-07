import {
  collection, doc, addDoc, updateDoc, deleteDoc,
  getDocs, getDoc, query, where, orderBy, Timestamp, serverTimestamp,
} from 'firebase/firestore'
import { db } from './firebase'
import type { Evento, Asistente, UserProfile } from './types'

// ─── Eventos ────────────────────────────────────────────────────────────────

export async function crearEvento(
  data: { nombre: string; descripcion: string; lugar?: string; fecha: Date },
  uid: string,
): Promise<string> {
  const ref = await addDoc(collection(db, 'eventos'), {
    ...data,
    fecha: Timestamp.fromDate(data.fecha),
    creadoPor: uid,
    activo: true,
    createdAt: serverTimestamp(),
  })
  return ref.id
}

export async function getEventos(): Promise<Evento[]> {
  const snap = await getDocs(query(collection(db, 'eventos'), orderBy('fecha', 'desc')))
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Evento))
}

export async function getEvento(id: string): Promise<Evento | null> {
  const snap = await getDoc(doc(db, 'eventos', id))
  return snap.exists() ? ({ id: snap.id, ...snap.data() } as Evento) : null
}

export async function updateEvento(id: string, data: Partial<Evento>) {
  await updateDoc(doc(db, 'eventos', id), data)
}

export async function deleteEvento(id: string) {
  await deleteDoc(doc(db, 'eventos', id))
}

// ─── Asistentes ─────────────────────────────────────────────────────────────

export async function registrarAsistente(data: Omit<Asistente, 'id'>): Promise<string> {
  const ref = await addDoc(collection(db, 'asistentes'), {
    ...data,
    horaIngreso: serverTimestamp(),
  })
  return ref.id
}

export async function getAsistentes(eventId: string): Promise<Asistente[]> {
  const snap = await getDocs(
    query(collection(db, 'asistentes'), where('eventId', '==', eventId), orderBy('horaIngreso', 'asc')),
  )
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Asistente))
}

export async function checkYaRegistrado(eventId: string, numeroCedula: string): Promise<boolean> {
  const snap = await getDocs(
    query(
      collection(db, 'asistentes'),
      where('eventId', '==', eventId),
      where('numeroCedula', '==', numeroCedula),
    ),
  )
  return !snap.empty
}

export async function getTotalAsistentes(eventId: string): Promise<number> {
  const snap = await getDocs(
    query(collection(db, 'asistentes'), where('eventId', '==', eventId)),
  )
  return snap.size
}

// ─── Usuarios ────────────────────────────────────────────────────────────────

export async function getUsuarioPerfil(uid: string): Promise<UserProfile | null> {
  const snap = await getDoc(doc(db, 'usuarios', uid))
  return snap.exists() ? ({ id: snap.id, ...snap.data() } as UserProfile) : null
}

export async function crearUsuarioPerfil(
  uid: string,
  data: { email: string; nombre: string; rol: 'admin' | 'ayudante' },
) {
  await updateDoc(doc(db, 'usuarios', uid), {
    ...data,
    activo: true,
    createdAt: serverTimestamp(),
  }).catch(() =>
    addDoc(collection(db, 'usuarios'), { id: uid, ...data, activo: true, createdAt: serverTimestamp() }),
  )
}

export async function setUsuarioPerfil(
  uid: string,
  data: { email: string; nombre: string; rol: 'admin' | 'ayudante'; activo: boolean },
) {
  const ref = doc(db, 'usuarios', uid)
  const snap = await getDoc(ref)
  if (snap.exists()) {
    await updateDoc(ref, data)
  } else {
    const { setDoc } = await import('firebase/firestore')
    await setDoc(ref, { ...data, createdAt: serverTimestamp() })
  }
}

export async function getUsuarios(): Promise<UserProfile[]> {
  const snap = await getDocs(query(collection(db, 'usuarios'), orderBy('createdAt', 'desc')))
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as UserProfile))
}

export async function updateUsuario(id: string, data: Partial<UserProfile>) {
  await updateDoc(doc(db, 'usuarios', id), data as Record<string, unknown>)
}
