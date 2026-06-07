import type { CedulaData } from './types'

const MRZ_RE = /^[A-Z0-9<]{28,36}$/

function normalize(raw: string): string {
  return raw.toUpperCase().replace(/\s+/g, '<').replace(/[^A-Z0-9<]/g, '').slice(0, 36)
}

function splitNames(field: string): [string, string] {
  const t = field.replace(/<+$/, '')
  const i = t.indexOf('<<')
  if (i < 0) return [t.replace(/</g, ' ').trim(), '']
  return [t.slice(0, i).replace(/</g, ' ').trim(), t.slice(i + 2).replace(/</g, ' ').trim()]
}

function parseDob(yymmdd: string): { fechaNacimiento: string; edad: number } | null {
  if (!/^\d{6}$/.test(yymmdd)) return null
  const yy = parseInt(yymmdd.slice(0, 2))
  const mm = parseInt(yymmdd.slice(2, 4))
  const dd = parseInt(yymmdd.slice(4, 6))
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null
  const now = new Date()
  const fullYear = 2000 + yy > now.getFullYear() ? 1900 + yy : 2000 + yy
  let edad = now.getFullYear() - fullYear
  if (now.getMonth() + 1 < mm || (now.getMonth() + 1 === mm && now.getDate() < dd)) edad--
  const fechaNacimiento = `${fullYear}${String(mm).padStart(2, '0')}${String(dd).padStart(2, '0')}`
  return { fechaNacimiento, edad: Math.max(0, edad) }
}

function parseTD1(l1: string, l2: string): CedulaData | null {
  if (l1.length < 30 || l2.length < 30) return null
  const [apellidos, nombres] = splitNames(l1.slice(5, 30))
  const numeroCedula = l2.slice(0, 9).replace(/</g, '').trim()
  if (numeroCedula.length < 6 || !apellidos) return null

  const dobRaw = l2.slice(13, 19)
  const sexChar = l2[20]
  const sexo = sexChar === 'M' ? 'M' : sexChar === 'F' ? 'F' : undefined
  const dobInfo = parseDob(dobRaw)

  return { nombres, apellidos, numeroCedula, tipo: 'nueva', sexo, ...(dobInfo ?? {}) }
}

export function parseMrz(textLines: string[]): CedulaData | null {
  const cands = textLines.map(normalize).filter(l => MRZ_RE.test(l))
  for (let i = 0; i < cands.length; i++) {
    if (cands[i].startsWith('IC') && cands[i].length >= 30 && cands[i + 1]?.length >= 30) {
      const r = parseTD1(cands[i].slice(0, 30), cands[i + 1].slice(0, 30))
      if (r) return r
    }
  }
  return null
}
