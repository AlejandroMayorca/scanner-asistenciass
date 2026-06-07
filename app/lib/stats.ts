import { Timestamp } from 'firebase/firestore'
import type { Asistente, Stats } from './types'

export function calcStats(asistentes: Asistente[]): Stats {
  const total = asistentes.length
  const conSexo = asistentes.filter(a => a.sexo === 'M' || a.sexo === 'F')
  const masculinos = conSexo.filter(a => a.sexo === 'M').length
  const femeninos = conSexo.filter(a => a.sexo === 'F').length
  const sinSexo = total - conSexo.length

  const conEdad = asistentes.filter(a => typeof a.edad === 'number')
  const edadPromedio =
    conEdad.length > 0
      ? Math.round(conEdad.reduce((acc, a) => acc + (a.edad ?? 0), 0) / conEdad.length)
      : null

  const gruposEdad: Record<string, number> = {
    '14-17': 0, '18-25': 0, '26-35': 0, '36-50': 0, '51+': 0, 'N/A': 0,
  }
  for (const a of asistentes) {
    const e = a.edad ?? null
    if (e === null) gruposEdad['N/A']++
    else if (e <= 17) gruposEdad['14-17']++
    else if (e <= 25) gruposEdad['18-25']++
    else if (e <= 35) gruposEdad['26-35']++
    else if (e <= 50) gruposEdad['36-50']++
    else gruposEdad['51+']++
  }

  const hourly = Array<number>(24).fill(0)
  for (const a of asistentes) {
    const d =
      a.horaIngreso instanceof Timestamp
        ? a.horaIngreso.toDate()
        : a.horaIngreso instanceof Date
          ? a.horaIngreso
          : new Date((a.horaIngreso as { seconds: number }).seconds * 1000)
    hourly[d.getHours()]++
  }

  const maxH = Math.max(...hourly)
  const horaPico = maxH > 0 ? hourly.indexOf(maxH) : 0

  return {
    total,
    masculinos,
    femeninos,
    sinSexo,
    pctMasculino: conSexo.length ? Math.round((masculinos / conSexo.length) * 100) : 0,
    pctFemenino: conSexo.length ? Math.round((femeninos / conSexo.length) * 100) : 0,
    edadPromedio,
    gruposEdad,
    hourly,
    horaPico,
  }
}

export function formatHora(h: number): string {
  const ampm = h < 12 ? 'AM' : 'PM'
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
  return `${h12}:00 ${ampm}`
}
