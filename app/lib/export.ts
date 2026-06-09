import type { Asistencia, Evento, Log } from './types'
import { toDate } from './firestore'

function fmtDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export async function exportarExcel(asistencias: Asistencia[], evento: Evento): Promise<void> {
  const XLSX = await import('xlsx')

  const rows = asistencias.map((a, i) => ({
    '#': i + 1,
    'Cédula': a.cedula,
    'Apellidos': a.apellidos,
    'Nombres': a.nombres,
    'Sexo': a.sexo === 'M' ? 'Masculino' : a.sexo === 'F' ? 'Femenino' : 'N/A',
    'Fecha Nacimiento': a.fechaNacimiento
      ? `${a.fechaNacimiento.slice(8, 10)}/${a.fechaNacimiento.slice(5, 7)}/${a.fechaNacimiento.slice(0, 4)}`
      : 'N/A',
    'Edad': a.edad ?? 'N/A',
    'RH': a.rh ?? 'N/A',
    'Hora Ingreso': toDate(a.fechaHora).toLocaleString('es-CO', { hour12: true }),
    'Modo': a.modo,
  }))

  const ws = XLSX.utils.json_to_sheet(rows)
  ws['!cols'] = [4, 14, 24, 24, 10, 16, 6, 6, 22, 8].map(wch => ({ wch }))

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Asistencias')

  const fecha = toDate(evento.fecha).toLocaleDateString('es-CO').replace(/\//g, '-')
  XLSX.writeFile(wb, `asistencias_${evento.nombre.replace(/\s+/g, '_')}_${fecha}.xlsx`)
}

export async function exportarLogsExcel(logs: Log[]): Promise<void> {
  const XLSX = await import('xlsx')
  const TIPO_ES: Record<string, string> = {
    REGISTRO: 'Registro', EDICION: 'Edición', ELIMINACION: 'Eliminación',
    LOGIN: 'Login', LOGOUT: 'Logout',
  }
  const rows = logs.map(l => ({
    'Fecha/Hora':      fmtDate(toDate(l.fecha)),
    'Tipo':            TIPO_ES[l.tipo] ?? l.tipo,
    'Operador':        l.operadorNombre,
    'Email operador':  l.operadorEmail,
    'Evento':          l.eventoNombre ?? '',
    'Asistente':       l.nombreAsistente,
    'Cédula':          l.cedula,
    'Detalles':        l.detalles,
    'IP':              l.ip,
  }))
  const ws = XLSX.utils.json_to_sheet(rows)
  ws['!cols'] = [20, 12, 22, 28, 28, 28, 14, 50, 14].map(wch => ({ wch }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Logs')
  XLSX.writeFile(wb, `logs_cedulascan_${new Date().toISOString().slice(0, 10)}.xlsx`)
}

export function exportarJson(
  data: { eventos: (Evento & { asistencias: Asistencia[] })[] },
): void {
  const payload = {
    exportadoEn: new Date().toISOString(),
    eventos: data.eventos.map(ev => ({
      id: ev.id,
      nombre: ev.nombre,
      descripcion: ev.descripcion,
      lugar: ev.lugar,
      fecha: toDate(ev.fecha).toISOString(),
      activo: ev.activo,
      totalAsistencias: ev.asistencias.length,
      asistencias: ev.asistencias.map(a => ({
        ...a,
        fechaHora: toDate(a.fechaHora).toISOString(),
      })),
    })),
  }

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const el = document.createElement('a')
  el.href = url
  el.download = `backup_cedulascan_${new Date().toISOString().slice(0, 10)}.json`
  el.click()
  URL.revokeObjectURL(url)
}
