import type { Timestamp } from 'firebase/firestore'

export interface CedulaData {
  nombres: string
  apellidos: string
  numeroCedula: string
  tipo: 'nueva' | 'vieja'
  sexo?: 'M' | 'F'
  fechaNacimiento?: string // YYYYMMDD
  edad?: number
}

export interface UserProfile {
  id: string
  email: string
  nombre: string
  rol: 'admin' | 'ayudante'
  activo: boolean
  createdAt: Timestamp
}

export interface Evento {
  id?: string
  nombre: string
  descripcion: string
  lugar?: string
  fecha: Timestamp | Date
  creadoPor: string
  activo: boolean
  totalAsistentes?: number
  createdAt: Timestamp | Date
}

export interface Asistente {
  id?: string
  eventId: string
  numeroCedula: string
  nombres: string
  apellidos: string
  sexo?: string
  edad?: number
  fechaNacimiento?: string
  horaIngreso: Timestamp | Date
  tipoCedula: 'nueva' | 'vieja'
}

export interface Stats {
  total: number
  masculinos: number
  femeninos: number
  sinSexo: number
  pctMasculino: number
  pctFemenino: number
  edadPromedio: number | null
  gruposEdad: Record<string, number>
  hourly: number[]
  horaPico: number
}
