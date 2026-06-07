import { Timestamp } from 'firebase/firestore'
import type { Asistente, Evento } from './types'

function toDate(val: unknown): Date {
  if (val instanceof Timestamp) return val.toDate()
  if (val instanceof Date) return val
  if (val && typeof val === 'object' && 'seconds' in val) {
    return new Date((val as { seconds: number }).seconds * 1000)
  }
  return new Date()
}

function fmtFecha(date: Date): string {
  return date.toLocaleString('es-CO', { hour12: true })
}

export async function exportToExcel(asistentes: Asistente[], nombreEvento: string) {
  const XLSX = await import('xlsx')
  const rows = asistentes.map((a, i) => ({
    '#': i + 1,
    'Cédula': a.numeroCedula,
    'Apellidos': a.apellidos,
    'Nombres': a.nombres,
    'Sexo': a.sexo ?? 'N/A',
    'Edad': a.edad ?? 'N/A',
    'F. Nacimiento': a.fechaNacimiento
      ? `${a.fechaNacimiento.slice(6)}/${a.fechaNacimiento.slice(4, 6)}/${a.fechaNacimiento.slice(0, 4)}`
      : 'N/A',
    'Hora Ingreso': fmtFecha(toDate(a.horaIngreso)),
    'Tipo': a.tipoCedula === 'nueva' ? 'Nueva' : 'Antigua',
  }))
  const ws = XLSX.utils.json_to_sheet(rows)
  ws['!cols'] = [4, 16, 26, 26, 6, 6, 14, 22, 8].map(wch => ({ wch }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Asistentes')
  XLSX.writeFile(wb, `${nombreEvento.replace(/\s+/g, '_')}_asistentes.xlsx`)
}

export function exportToJson(asistentes: Asistente[], evento: Evento) {
  const payload = {
    evento: {
      id: evento.id,
      nombre: evento.nombre,
      descripcion: evento.descripcion,
      fecha: toDate(evento.fecha as unknown).toISOString(),
    },
    exportedAt: new Date().toISOString(),
    total: asistentes.length,
    asistentes: asistentes.map(a => ({
      ...a,
      horaIngreso: toDate(a.horaIngreso).toISOString(),
    })),
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const el = document.createElement('a')
  el.href = url
  el.download = `backup_${evento.nombre.replace(/\s+/g, '_')}.json`
  el.click()
  URL.revokeObjectURL(url)
}
