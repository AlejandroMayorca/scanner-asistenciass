import type { CedulaData } from './types'

const CEDULA_RE = /^\d{6,12}$/
const DATE_RE = /^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/

function cleanName(s: string) {
  return s.replace(/[^A-Za-zÁÉÍÓÚáéíóúÑñ\s]/g, '').trim()
}

function parseDateField(s: string): string | undefined {
  const m = DATE_RE.exec(s.trim())
  if (!m) return undefined
  // DD/MM/YYYY → YYYYMMDD
  return `${m[3]}${m[2]}${m[1]}`
}

function calcEdadFromYYYYMMDD(fechaNacimiento: string): number | undefined {
  const y = parseInt(fechaNacimiento.slice(0, 4))
  const mo = parseInt(fechaNacimiento.slice(4, 6))
  const d = parseInt(fechaNacimiento.slice(6, 8))
  const now = new Date()
  let edad = now.getFullYear() - y
  if (now.getMonth() + 1 < mo || (now.getMonth() + 1 === mo && now.getDate() < d)) edad--
  return edad >= 0 ? edad : undefined
}

function tryExtract(fields: string[]): CedulaData | null {
  const idx = fields.findIndex(f => CEDULA_RE.test(f))
  if (idx < 0) return null
  const numeroCedula = fields[idx]

  let apellidos = ''
  let nombres = ''

  if (idx === 0 && fields.length >= 3) {
    apellidos = cleanName(fields[1])
    nombres = cleanName(fields[2])
  } else if (idx >= 2) {
    apellidos = cleanName(fields[idx - 2])
    nombres = cleanName(fields[idx - 1])
  } else if (idx === 1 && fields.length >= 3) {
    apellidos = cleanName(fields[0])
    nombres = cleanName(fields[2])
  }

  if (!apellidos && !nombres) return null

  // Try to find date of birth in remaining fields
  let fechaNacimiento: string | undefined
  let edad: number | undefined
  let sexo: 'M' | 'F' | undefined

  for (const f of fields) {
    if (!fechaNacimiento) {
      const d = parseDateField(f)
      if (d) { fechaNacimiento = d; edad = calcEdadFromYYYYMMDD(d) }
    }
    if (!sexo && /^[MF]$/.test(f.trim())) sexo = f.trim() as 'M' | 'F'
  }

  return { nombres, apellidos, numeroCedula, tipo: 'vieja', sexo, fechaNacimiento, edad }
}

export function parsePdf417(rawText: string): CedulaData | null {
  for (const delim of [';', '\n', '|', ',', '\r\n']) {
    const fields = rawText.split(delim).map(f => f.trim()).filter(Boolean)
    if (fields.length >= 3) {
      const r = tryExtract(fields)
      if (r) return r
    }
  }
  return null
}
