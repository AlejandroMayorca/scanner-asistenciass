import type { Timestamp } from 'firebase/firestore'

export interface Evento {
  id?: string
  nombre: string
  descripcion: string
  fecha: Timestamp | Date
  lugar: string
  activo: boolean
  creadoEn: Timestamp | Date
  creadoPor: string
  tokenAcceso?: string
}

export interface Asistencia {
  id?: string
  cedula: string
  nombres: string
  apellidos: string
  fechaNacimiento?: string // YYYY-MM-DD
  edad?: number
  sexo?: 'M' | 'F'
  rh?: string
  fechaHora: Timestamp | Date
  modo: 'PDF417' | 'MRZ' | 'MANUAL'
  registradoPor?: string  // display name
  operadorUid?: string    // uid for collection-group queries
  ipOperador?: string
}

export interface UserProfile {
  id: string
  email: string
  rol: 'admin' | 'ayudante'
  activo: boolean
  creadoEn: Timestamp | Date
}

export interface OperadorPerfil {
  uid: string
  email: string
  nombre: string
  apellido: string
  rol: 'ayudante'
  activo: boolean
  creadoEn: Timestamp | Date
  creadoPor: string
  ultimoAcceso: Timestamp | Date | null
}

export interface Log {
  id?: string
  tipo: 'REGISTRO' | 'EDICION' | 'ELIMINACION' | 'LOGIN' | 'LOGOUT'
  eventoId: string | null
  eventoNombre: string | null
  asistenciaId: string | null
  cedula: string
  nombreAsistente: string
  operadorUid: string
  operadorNombre: string
  operadorEmail: string
  fecha: Timestamp | Date
  detalles: string
  ip: string
}
