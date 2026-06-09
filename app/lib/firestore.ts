import {
  collection, collectionGroup, doc, addDoc, updateDoc, deleteDoc, setDoc, getDoc, getDocs,
  query, where, orderBy, limit, Timestamp, serverTimestamp, writeBatch,
} from 'firebase/firestore'
import { db } from './firebase'
import type { Evento, Asistencia, UserProfile, OperadorPerfil, Log } from './types'

// ── Helpers ───────────────────────────────────────────────────────────────────

export function toDate(v: unknown): Date {
  if (v instanceof Timestamp) return v.toDate()
  if (v instanceof Date) return v
  if (v && typeof v === 'object' && 'seconds' in v)
    return new Date((v as { seconds: number }).seconds * 1000)
  return new Date()
}

// ── Eventos ───────────────────────────────────────────────────────────────────

export async function getEventos(): Promise<Evento[]> {
  const snap = await getDocs(query(collection(db, 'eventos'), orderBy('fecha', 'desc')))
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Evento))
}

export async function getEvento(id: string): Promise<Evento | null> {
  const snap = await getDoc(doc(db, 'eventos', id))
  return snap.exists() ? ({ id: snap.id, ...snap.data() } as Evento) : null
}

export async function crearEvento(
  data: { nombre: string; descripcion: string; lugar: string; fecha: Date },
  uid: string,
): Promise<string> {
  const ref = await addDoc(collection(db, 'eventos'), {
    nombre: data.nombre.trim(),
    descripcion: data.descripcion.trim(),
    lugar: data.lugar.trim(),
    fecha: Timestamp.fromDate(data.fecha),
    creadoPor: uid,
    activo: true,
    creadoEn: serverTimestamp(),
    tokenAcceso: crypto.randomUUID(),
  })
  return ref.id
}

export async function getEventoByToken(token: string): Promise<Evento | null> {
  const snap = await getDocs(
    query(collection(db, 'eventos'), where('tokenAcceso', '==', token), limit(1)),
  )
  if (snap.empty) return null
  const d = snap.docs[0]
  return { id: d.id, ...d.data() } as Evento
}

export async function generarTokenAcceso(eventoId: string): Promise<string> {
  const token = crypto.randomUUID()
  await updateDoc(doc(db, 'eventos', eventoId), { tokenAcceso: token })
  return token
}

export async function eliminarEvento(eventoId: string): Promise<void> {
  const asisSnap = await getDocs(collection(db, 'eventos', eventoId, 'asistencias'))
  const batch = writeBatch(db)
  asisSnap.docs.forEach(d => batch.delete(d.ref))
  batch.delete(doc(db, 'eventos', eventoId))
  await batch.commit()
}

// ── Asistencias (subcollection) ───────────────────────────────────────────────

export async function getAsistencias(eventoId: string): Promise<Asistencia[]> {
  const snap = await getDocs(
    query(
      collection(db, 'eventos', eventoId, 'asistencias'),
      orderBy('fechaHora', 'asc'),
    ),
  )
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Asistencia))
}

export async function getTotalAsistencias(eventoId: string): Promise<number> {
  const snap = await getDocs(collection(db, 'eventos', eventoId, 'asistencias'))
  return snap.size
}

export async function checkDuplicado(eventoId: string, cedula: string): Promise<boolean> {
  const snap = await getDocs(
    query(
      collection(db, 'eventos', eventoId, 'asistencias'),
      where('cedula', '==', cedula),
    ),
  )
  return !snap.empty
}

export async function eliminarAsistencia(eventoId: string, asistenciaId: string): Promise<void> {
  await deleteDoc(doc(db, 'eventos', eventoId, 'asistencias', asistenciaId))
}

export async function registrarAsistencia(
  eventoId: string,
  data: Omit<Asistencia, 'id' | 'fechaHora'>,
): Promise<string> {
  const ref = await addDoc(collection(db, 'eventos', eventoId, 'asistencias'), {
    cedula:          data.cedula          || '',
    nombres:         data.nombres         || '',
    apellidos:       data.apellidos       || '',
    fechaNacimiento: data.fechaNacimiento || '',
    edad:            data.edad            || 0,
    sexo:            data.sexo            || '',
    rh:              data.rh              || '',
    modo:            data.modo            || 'MANUAL',
    registradoPor:   data.registradoPor   || '',
    operadorUid:     data.operadorUid     || '',
    ipOperador:      data.ipOperador      || '',
    eventoId,
    fechaHora:       serverTimestamp(),
  })
  return ref.id
}

export async function editarAsistencia(
  eventoId: string,
  asistenciaId: string,
  data: Partial<Omit<Asistencia, 'id' | 'fechaHora'>>,
): Promise<void> {
  await updateDoc(doc(db, 'eventos', eventoId, 'asistencias', asistenciaId), data as Record<string, unknown>)
}

// ── Usuarios ──────────────────────────────────────────────────────────────────

export async function getUsuarioPerfil(uid: string): Promise<UserProfile | null> {
  const snap = await getDoc(doc(db, 'usuarios', uid))
  return snap.exists() ? ({ id: snap.id, ...snap.data() } as UserProfile) : null
}

export async function setUsuarioPerfil(
  uid: string,
  data: { email: string; rol: 'admin' | 'ayudante'; activo?: boolean },
): Promise<void> {
  await setDoc(doc(db, 'usuarios', uid), {
    email: data.email,
    rol: data.rol,
    activo: data.activo ?? true,
    creadoEn: serverTimestamp(),
  })
}

export async function getUsuarios(): Promise<UserProfile[]> {
  const snap = await getDocs(query(collection(db, 'usuarios'), orderBy('creadoEn', 'desc')))
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as UserProfile))
}

export async function updateUsuario(uid: string, data: Partial<UserProfile>): Promise<void> {
  await updateDoc(doc(db, 'usuarios', uid), data as Record<string, unknown>)
}

// ── Operadores ────────────────────────────────────────────────────────────────

export async function getOperadorPerfil(uid: string): Promise<OperadorPerfil | null> {
  const snap = await getDoc(doc(db, 'operadores', uid))
  return snap.exists() ? ({ uid: snap.id, ...snap.data() } as OperadorPerfil) : null
}

export async function setOperador(
  uid: string,
  data: { email: string; nombre: string; apellido: string; activo: boolean; creadoPor: string },
): Promise<void> {
  await setDoc(doc(db, 'operadores', uid), {
    uid,
    ...data,
    rol: 'ayudante' as const,
    creadoEn: serverTimestamp(),
    ultimoAcceso: null,
  })
}

export async function updateOperador(uid: string, data: Partial<OperadorPerfil>): Promise<void> {
  await updateDoc(doc(db, 'operadores', uid), data as Record<string, unknown>)
}

export async function getOperadores(): Promise<OperadorPerfil[]> {
  const snap = await getDocs(query(collection(db, 'operadores'), orderBy('creadoEn', 'desc')))
  return snap.docs.map(d => ({ uid: d.id, ...d.data() } as OperadorPerfil))
}

export async function getAsistenciasByOperador(
  operadorUid: string,
): Promise<(Asistencia & { eventoId: string })[]> {
  const snap = await getDocs(
    query(collectionGroup(db, 'asistencias'), where('operadorUid', '==', operadorUid)),
  )
  return snap.docs.map(d => {
    const data = d.data() as Asistencia & { eventoId: string }
    return { id: d.id, ...data, eventoId: data.eventoId ?? d.ref.parent.parent?.id ?? '' }
  })
}

// ── Logs ─────────────────────────────────────────────────────────────────────

export async function registrarLog(data: Omit<Log, 'id' | 'fecha'>): Promise<void> {
  try {
    await addDoc(collection(db, 'logs'), { ...data, fecha: serverTimestamp() })
  } catch { /* non-fatal */ }
}

export async function getLogs(limitN = 1000): Promise<Log[]> {
  const snap = await getDocs(
    query(collection(db, 'logs'), orderBy('fecha', 'desc'), limit(limitN)),
  )
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Log))
}

// ── Backup ────────────────────────────────────────────────────────────────────

export async function getFullBackup(): Promise<{
  eventos: (Evento & { asistencias: Asistencia[] })[]
}> {
  const eventos = await getEventos()
  const full = await Promise.all(
    eventos.map(async ev => ({
      ...ev,
      asistencias: await getAsistencias(ev.id!),
    })),
  )
  return { eventos: full }
}

// ── Restore ───────────────────────────────────────────────────────────────────

type BackupAsistencia = Record<string, unknown> & { id?: string }
type BackupEvento     = Record<string, unknown> & { id?: string; asistencias?: BackupAsistencia[] }
export type BackupData = { eventos: BackupEvento[] }

function backupToTimestamp(v: unknown): Timestamp {
  if (v instanceof Timestamp) return v
  if (typeof v === 'string') {
    const d = new Date(v)
    if (!isNaN(d.getTime())) return Timestamp.fromDate(d)
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, number>
    if (typeof o.seconds === 'number') return new Timestamp(o.seconds, o.nanoseconds ?? 0)
  }
  return Timestamp.now()
}

export async function restaurarBackup(
  backup: BackupData,
  onProgress: (msg: string) => void,
): Promise<{ eventos: number; asistencias: number }> {
  const list = backup.eventos ?? []
  let totalEventos = 0, totalAsistencias = 0

  for (let i = 0; i < list.length; i++) {
    const ev = list[i]
    if (!ev.id) continue
    const { id: evId, asistencias, ...evData } = ev
    await setDoc(
      doc(db, 'eventos', evId as string),
      { ...evData, fecha: backupToTimestamp(evData.fecha), creadoEn: backupToTimestamp(evData.creadoEn) },
      { merge: true },
    )
    totalEventos++
    onProgress(`Importando evento ${i + 1}/${list.length}: ${evData.nombre ?? evId}`)

    for (const asis of asistencias ?? []) {
      if (!asis.id) continue
      const { id: asisId, ...asisData } = asis
      await setDoc(
        doc(db, 'eventos', evId as string, 'asistencias', asisId as string),
        { ...asisData, fechaHora: backupToTimestamp(asisData.fechaHora), eventoId: evId },
        { merge: true },
      )
      totalAsistencias++
    }
  }

  return { eventos: totalEventos, asistencias: totalAsistencias }
}
