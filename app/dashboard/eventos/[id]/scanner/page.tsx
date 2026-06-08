'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { doc, getDoc, onSnapshot, collection } from 'firebase/firestore'
import { db } from '../../../../lib/firebase'
import { registrarAsistencia, checkDuplicado } from '../../../../lib/firestore'
import type { Evento } from '../../../../lib/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function capitalize(s: string): string {
  if (!s) return ''
  return s.toLowerCase().replace(/\b[a-záéíóúñ]/gi, c => c.toUpperCase())
}

function calcEdad(fechaNacimiento: string): number {
  if (!fechaNacimiento) return 0
  const [y, m, d] = fechaNacimiento.split('-').map(Number)
  const hoy = new Date()
  let edad = hoy.getFullYear() - y
  if (hoy.getMonth() + 1 < m || (hoy.getMonth() + 1 === m && hoy.getDate() < d)) edad--
  return Math.max(0, edad)
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Cedula {
  cedula: string
  nombres: string
  apellidos: string
  sexo?: 'M' | 'F'
  fechaNacimiento?: string
  edad?: number
  rh?: string
  modo: 'PDF417' | 'MRZ'
}

interface ConfirmForm {
  cedula: string
  nombres: string
  apellidos: string
  sexo: 'M' | 'F' | ''
  fechaNacimiento: string
  rh: string
  modo: 'PDF417' | 'MRZ' | 'MANUAL'
  rawText?: string
}

type ToastState = { color: 'red' | 'yellow' | 'green'; msg: string } | null

// ─── PDF417 parsers (cédula vieja) ───────────────────────────────────────────

function cleanName(s: string): string {
  return capitalize(s.replace(/[^A-Za-zÁÉÍÓÚáéíóúÑñ\s]/g, '').trim())
}

function buildFecha(y: string, m: string, d: string): { fechaNacimiento: string; edad: number } | null {
  if (!y || !m || !d) return null
  const yy = parseInt(y)
  if (yy < 1900 || yy > new Date().getFullYear()) return null
  const fn = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  return { fechaNacimiento: fn, edad: calcEdad(fn) }
}

// Parser 1 — posiciones fijas (payload completo ~530 bytes, formato binario DANE)
function parsePdf417Binario(raw: string): Cedula | null {
  if (raw.length < 160) return null
  const clean = (s: string) => s.replace(/\x00/g, '').trim()

  const cedula = clean(raw.substring(48, 58)).replace(/^0+/, '')
  if (!/^\d{5,12}$/.test(cedula)) return null

  const apellido1       = cleanName(clean(raw.substring(58, 80)))
  const apellido2       = cleanName(clean(raw.substring(81, 104)))
  const nombre1         = cleanName(clean(raw.substring(104, 127)))
  const nombre2         = cleanName(clean(raw.substring(127, 150)))
  const sexoChar        = clean(raw.substring(151, 152))
  const anioNac         = clean(raw.substring(152, 156))
  const mesNac          = clean(raw.substring(156, 158))
  const diaNac          = clean(raw.substring(158, 160))
  const rh              = clean(raw.substring(166, 168))

  if (!apellido1 && !nombre1) return null

  const nombres   = [nombre1, nombre2].filter(Boolean).join(' ')
  const apellidos = [apellido1, apellido2].filter(Boolean).join(' ')
  const sexo = sexoChar === 'M' || sexoChar === 'F' ? sexoChar as 'M' | 'F' : undefined

  return {
    cedula,
    nombres,
    apellidos,
    sexo,
    rh: rh || undefined,
    modo: 'PDF417',
    ...buildFecha(anioNac, mesNac, diaNac) ?? {},
  }
}

// Parser 2 — null-byte split (igual que el script Python colombian_pdf417_decoder)
// Estructura: sp[0]=AFIS, sp[1]=?, sp[2]=fingercard+docnum+apellido1,
//             sp[3]=apellido2, sp[4]=nombre1, sp[5]=nombre2,
//             sp[6]=sexo+año+mes+día+municipio+dpto+??+rh
function parsePdf417NullSplit(raw: string): Cedula | null {
  const normalized = raw.replace(/\x00{2,}/g, '\x00')
  const segs = normalized.split('\x00')
  if (segs.length < 6) return null

  for (let i = 0; i <= segs.length - 5; i++) {
    const seg = segs[i]
    if (seg.length < 18) continue
    // docnum en offsets 10-18 del segmento
    const rawDoc = seg.substring(10, 18).replace(/\D/g, '').replace(/^0+/, '')
    if (!/^\d{5,12}$/.test(rawDoc)) continue

    const ap1 = cleanName(seg.substring(18).replace(/\x00/g, '').trim())
    const ap2 = cleanName((segs[i + 1] ?? '').replace(/\x00/g, '').trim())
    const nm1 = cleanName((segs[i + 2] ?? '').replace(/\x00/g, '').trim())
    let   nm2 = cleanName((segs[i + 3] ?? '').replace(/\x00/g, '').trim())
    const ds  = segs[i + 4] ?? ''

    if (!ap1 && !nm1) continue

    // nm2 = segundo nombre; si termina en '-' o '+' es artefacto → vacío
    if (/[-+]$/.test(nm2)) nm2 = ''

    const sexoChar = ds[1]
    const rh       = ds.substring(16, 18).replace(/\x00/g, '').trim()
    const sexo     = sexoChar === 'M' || sexoChar === 'F' ? sexoChar as 'M' | 'F' : undefined

    return {
      cedula:    rawDoc,
      nombres:   [nm1, nm2].filter(Boolean).join(' '),
      apellidos: [ap1, ap2].filter(Boolean).join(' '),
      sexo,
      rh: rh || undefined,
      modo: 'PDF417',
      ...buildFecha(ds.substring(2, 6), ds.substring(6, 8), ds.substring(8, 10)) ?? {},
    }
  }
  return null
}

// Parser 3 — separadores legacy (\x1E, ; | , \n) para formatos más antiguos
const RS = '\x1e'

function parseFechaPdf(raw: string): { fechaNacimiento: string; edad: number } | null {
  const c = raw.replace(/\D/g, '')
  if (c.length !== 8) return null
  return buildFecha(c.slice(0, 4), c.slice(4, 6), c.slice(6, 8))
}

function parsePdf417Legacy(raw: string): Cedula | null {
  if (!raw || raw.length < 10) return null
  if (raw.includes(RS)) {
    const f = raw.split(RS).map(s => s.trim())
    if (f.length >= 4) {
      const cedula = (f[3] ?? '').replace(/\D/g, '').slice(0, 12)
      if (cedula.length < 5) return null
      return {
        cedula,
        apellidos: cleanName(f[0]),
        nombres:   cleanName(f[1]),
        sexo:      /^[MF]$/i.test(f[2] ?? '') ? (f[2].toUpperCase() as 'M' | 'F') : undefined,
        rh:        f[4]?.trim() || undefined,
        modo:      'PDF417',
        ...(f[5] ? parseFechaPdf(f[5]) ?? {} : {}),
      }
    }
  }
  for (const sep of [';', '|', ',', '\n']) {
    if (!raw.includes(sep)) continue
    const fields = raw.split(sep).map(s => s.trim()).filter(Boolean)
    const ci = fields.findIndex(f => /^\d{6,12}$/.test(f))
    if (ci >= 2) {
      const cedula    = fields[ci]
      const apellidos = cleanName(fields[ci - 2])
      const nombres   = cleanName(fields[ci - 1])
      const sexo      = fields.find(f => /^[MF]$/i.test(f))?.toUpperCase() as 'M' | 'F' | undefined
      const rh        = fields.find(f => /^[ABO][+-]$/i.test(f))
      const fnacStr   = fields.find(f => /^\d{8}$/.test(f) && f !== cedula)
      if (apellidos && cedula)
        return { cedula, nombres, apellidos, sexo, rh, modo: 'PDF417', ...(fnacStr ? parseFechaPdf(fnacStr) ?? {} : {}) }
    }
  }
  return null
}

// ─── MRZ parser (cédula nueva) ────────────────────────────────────────────────

function cleanMrzName(s: string): string {
  return capitalize(s.replace(/<+/g, ' ').replace(/[^A-Za-z\s]/g, '').trim())
}

function parseMrzLines(_l1: string, l2: string, l3: string): Cedula | null {
  const colIdx = l2.indexOf('COL')
  if (colIdx < 0) return null
  const cedula = l2.slice(colIdx + 3).match(/^\d+/)?.[0] ?? ''
  if (cedula.length < 5) return null
  const yy = parseInt(l2.slice(0, 2))
  const mm = parseInt(l2.slice(2, 4))
  const dd = parseInt(l2.slice(4, 6))
  let fechaNacimiento: string | undefined, edad: number | undefined
  if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
    const fullYear = yy > 30 ? 1900 + yy : 2000 + yy
    fechaNacimiento = `${fullYear}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
    edad = calcEdad(fechaNacimiento)
  }
  const sc   = l2[7]
  const sexo: 'M' | 'F' | undefined = sc === 'M' ? 'M' : sc === 'F' ? 'F' : undefined
  const nameRaw   = l3.replace(/<+$/, '')
  const sepIdx    = nameRaw.indexOf('<<')
  const apellidos = sepIdx >= 0 ? cleanMrzName(nameRaw.slice(0, sepIdx)) : cleanMrzName(nameRaw)
  const nombres   = sepIdx >= 0 ? cleanMrzName(nameRaw.slice(sepIdx + 2)) : ''
  return { cedula, nombres, apellidos, sexo, fechaNacimiento, edad, modo: 'MRZ' }
}

function parseMrzText(raw: string): Cedula | null {
  const upper = raw.toUpperCase()
  const lines  = upper.split(/[\n\r]+/).map(l => l.trim().replace(/[^A-Z0-9<]/g, '')).filter(l => l.length >= 10)
  if (lines.length === 0) return null
  for (const pfx of ['ICCOL', 'IDCOL', 'IC<COL', 'ID<COL']) {
    const i = lines.findIndex(l => l.startsWith(pfx))
    if (i >= 0 && i + 2 < lines.length) {
      const r = parseMrzLines(lines[i], lines[i + 1].padEnd(30, '<'), lines[i + 2])
      if (r) return r
    }
  }
  const l2i = lines.findIndex(l => /^\d{7}[MF]/.test(l))
  if (l2i > 0 && l2i + 1 < lines.length) {
    const r = parseMrzLines(lines[l2i - 1], lines[l2i].padEnd(30, '<'), lines[l2i + 1])
    if (r) return r
  }
  const l3i = lines.findIndex(l => l.includes('<<'))
  if (l3i >= 2) {
    const r = parseMrzLines(lines[l3i - 2], lines[l3i - 1].padEnd(30, '<'), lines[l3i])
    if (r) return r
  }
  return null
}

function parseMrzRegex(text: string): Cedula | null {
  const up = text.toUpperCase().replace(/[^A-Z0-9<\n\r]/g, ' ')
  let cedula = ''
  const m1 = up.match(/COL(\d{6,12})[< \n\r]/)
  if (m1) cedula = m1[1]
  if (!cedula) {
    const m2 = up.match(/ICCOL(\d{8,12})/)
    if (m2) cedula = m2[1]
  }
  if (cedula.length < 5) return null
  let apellidos = '', nombres = ''
  const m3 = up.match(/([A-Z][A-Z< ]+)<<([A-Z][A-Z< ]*)/)
  if (m3) { apellidos = cleanMrzName(m3[1]); nombres = cleanMrzName(m3[2]) }
  return { cedula, apellidos, nombres, modo: 'MRZ' }
}

// Debug helper: show key positions for diagnostic logging
export function debugPdf417Positions(raw: string): string {
  const vis = (s: string) => s.replace(/\x00/g, '□')
  return [
    `len=${raw.length}`,
    `p48-58:"${vis(raw.substring(48, 58))}"`,
    `p58-80:"${vis(raw.substring(58, 80))}"`,
    `p104-127:"${vis(raw.substring(104, 127))}"`,
    `p127-150:"${vis(raw.substring(127, 150))}"`,
    `p151-160:"${vis(raw.substring(151, 160))}"`,
    `p166-168:"${vis(raw.substring(166, 168))}"`,
    `nulls=${(raw.match(/\x00/g) ?? []).length}`,
    `segs=${raw.replace(/\x00{2,}/g, '\x00').split('\x00').length}`,
  ].join(' | ')
}

function parseBarcode(raw: string): Cedula | null {
  if (!raw || raw.length < 5) return null
  // MRZ first (cédula nueva)
  const up = raw.toUpperCase()
  if (up.includes('ICCOL') || up.includes('IDCOL') || raw.includes('<<')) {
    return parseMrzText(raw) ?? parseMrzRegex(raw)
  }
  // PDF417 binary (cédula vieja) — try all three strategies
  return parsePdf417Binario(raw) ?? parsePdf417NullSplit(raw) ?? parsePdf417Legacy(raw)
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ScannerPage() {
  const { id: eventoId } = useParams<{ id: string }>()
  const router = useRouter()

  const inputRef   = useRef<HTMLInputElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tWorkerRef = useRef<any>(null)
  const tReadyRef  = useRef(false)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [processing,    setProcessing]    = useState(false)
  const [toast,         setToast]         = useState<ToastState>(null)
  const [confirmForm,   setConfirmForm]   = useState<ConfirmForm | null>(null)
  const [confirmSaving, setConfirmSaving] = useState(false)
  const [confirmError,  setConfirmError]  = useState('')
  const [total,         setTotal]         = useState(0)
  const [evento,        setEvento]        = useState<Evento | null>(null)
  const [showManual,    setShowManual]    = useState(false)
  const [manualForm,    setManualForm]    = useState({
    cedula: '', nombres: '', apellidos: '',
    fechaNacimiento: '', sexo: '' as 'M' | 'F' | '', rh: '',
  })
  const [manualSaving, setManualSaving] = useState(false)
  const [manualError,  setManualError]  = useState('')
  const [debugLog,     setDebugLog]     = useState<string[]>([])
  const [tReady,       setTReady]       = useState(false)

  // ── Debug log ─────────────────────────────────────────────────────────────

  const addLog = useCallback((msg: string) => {
    console.log(msg)
    setDebugLog(prev => [...prev.slice(-9), msg])
  }, [])

  // ── Init ZXing + Tesseract ────────────────────────────────────────────────

  useEffect(() => {
    let alive = true

    const initTesseract = async () => {
      try {
        const { createWorker, PSM } = await import('tesseract.js')
        const worker = await createWorker('eng', 1, { logger: () => {} })
        await worker.setParameters({
          tessedit_pageseg_mode:   PSM.SINGLE_BLOCK,
          tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<',
        })
        if (!alive) { await worker.terminate(); return }
        tWorkerRef.current = worker
        tReadyRef.current  = true
        setTReady(true)
      } catch { /* OCR no disponible */ }
    }

    initTesseract()

    return () => {
      alive = false
      tWorkerRef.current?.terminate?.()
      if (toastTimer.current) clearTimeout(toastTimer.current)
    }
  }, [])

  // ── Real-time counter ─────────────────────────────────────────────────────

  useEffect(() => {
    if (!eventoId) return
    return onSnapshot(collection(db, 'eventos', eventoId, 'asistencias'), snap => setTotal(snap.size))
  }, [eventoId])

  // ── Evento name ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!eventoId) return
    getDoc(doc(db, 'eventos', eventoId)).then(snap => {
      if (snap.exists()) setEvento({ id: snap.id, ...snap.data() } as Evento)
    })
  }, [eventoId])

  // ── Toast ──────────────────────────────────────────────────────────────────

  const showToast = useCallback((color: 'red' | 'yellow' | 'green', msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ color, msg })
    toastTimer.current = setTimeout(() => setToast(null), 3000)
  }, [])

  // ── Image processing ───────────────────────────────────────────────────────

  const handleImageCapture = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    setProcessing(true)
    setDebugLog([])

    try {
      // Load image
      const url = URL.createObjectURL(file)
      const img  = new Image()
      img.src    = url
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej() })
      const W = img.naturalWidth, H = img.naturalHeight
      addLog(`[foto] ${W}×${H}px`)

      // Resize to max 2000px to limit payload, keep aspect ratio
      const MAX = 2000
      const scale = Math.min(1, MAX / Math.max(W, H))
      const cW = Math.round(W * scale), cH = Math.round(H * scale)
      const canvas = document.createElement('canvas')
      canvas.width = cW; canvas.height = cH
      canvas.getContext('2d')!.drawImage(img, 0, 0, cW, cH)
      URL.revokeObjectURL(url)

      const base64 = canvas.toDataURL('image/jpeg', 0.9).split(',')[1]
      addLog(`[base64] ${Math.round(base64.length / 1024)}kb`)

      // ── Server-side ZXing ─────────────────────────────────────────────────
      let detected: Cedula | null = null
      let rawServerText: string | undefined

      try {
        addLog('[api] enviando al servidor…')
        const resp = await fetch('/api/scan', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ imageBase64: base64 }),
        })
        const data = await resp.json() as {
          success: boolean
          text?: string
          parsed?: {
            cedula: string; apellido1: string; apellido2: string
            nombre1: string; nombre2: string; sexo: string
            fechaNacimiento: string; rh: string
          }
          error?: string
          logs?: string[]
        }

        for (const line of data.logs ?? []) addLog(line)

        if (data.success && data.text) {
          rawServerText = data.text

          // ── Python parser succeeded (primary path) ──────────────────────
          if (data.parsed && data.parsed.cedula) {
            const p       = data.parsed
            const nombres   = [p.nombre1, p.nombre2].filter(Boolean).join(' ')
            const apellidos = [p.apellido1, p.apellido2].filter(Boolean).join(' ')
            const fnParts   = p.fechaNacimiento?.split('-') ?? []
            detected = {
              cedula:    p.cedula,
              nombres:   cleanName(nombres),
              apellidos: cleanName(apellidos),
              sexo:      p.sexo === 'M' || p.sexo === 'F' ? p.sexo as 'M' | 'F' : undefined,
              rh:        p.rh || undefined,
              modo:      'PDF417',
              ...( fnParts.length === 3 ? buildFecha(fnParts[0], fnParts[1], fnParts[2]) ?? {} : {} ),
            }
            addLog(`[py✓] ${detected.apellidos} ${detected.nombres} | ${p.cedula} | ${p.fechaNacimiento}`)

          // ── TypeScript fallback parsers ──────────────────────────────────
          } else {
            addLog(`[txt] ${data.text.replace(/\x00/g, '□')}`)
            addLog(`[pos] ${debugPdf417Positions(data.text)}`)
            const r1 = parsePdf417Binario(data.text)
            const r2 = r1 ? null : parsePdf417NullSplit(data.text)
            const r3 = (r1 || r2) ? null : parsePdf417Legacy(data.text)
            detected = r1 ?? r2 ?? r3 ?? parseMrzText(data.text) ?? parseMrzRegex(data.text)
            addLog(`[parse] bin=${r1?'✓':'✗'} null=${r2?'✓':'✗'} leg=${r3?'✓':'✗'} → ${detected ? `cedula=${detected.cedula}` : 'sin resultado'}`)
            if (!detected) addLog('[parse] sin resultado — abriendo modal raw')
          }
        } else {
          addLog(`[api] sin detección: ${data.error ?? ''}`)
        }
      } catch (fetchErr) {
        addLog(`[api] error de red: ${String(fetchErr).slice(0, 80)}`)
      }

      // ── Tesseract fallback: bottom 45% for MRZ cédula nueva ──────────────
      if (!detected) {
        if (tReadyRef.current && tWorkerRef.current) {
          try {
            const sy  = Math.floor(cH * 0.55), sh = Math.floor(cH * 0.45)
            const ct  = document.createElement('canvas')
            ct.width  = cW; ct.height = sh
            ct.getContext('2d')!.drawImage(canvas, 0, sy, cW, sh, 0, 0, cW, sh)
            const { data: { text } } = await tWorkerRef.current.recognize(ct)
            addLog(`[ocr] ${text.trim()}`)
            detected = parseMrzText(text) ?? parseMrzRegex(text)
            if (detected) addLog(`[ocr OK] ${detected.modo} cédula=${detected.cedula}`)
            else addLog('[ocr] sin resultado')
          } catch (err) {
            addLog(`[ocr] error: ${String(err).slice(0, 80)}`)
          }
        } else {
          addLog(`[ocr] ${tReady ? 'ocupado' : 'iniciando…'}`)
        }
      }

      // ── If still no parse but server returned raw text → open modal raw ──
      if (!detected && rawServerText) {
        const rawCedula = rawServerText.match(/\d{6,12}/)?.[0] ?? ''
        setConfirmForm({
          cedula:          rawCedula,
          nombres:         '',
          apellidos:       '',
          sexo:            '',
          fechaNacimiento: '',
          rh:              '',
          modo:            'PDF417',
          rawText:         rawServerText,
        })
        setProcessing(false)
        return
      }

      if (!detected || detected.cedula.length < 5) {
        showToast('red', '❌ No se detectó. Intenta de nuevo con mejor luz o ángulo')
        return
      }

      const dup = await checkDuplicado(eventoId, detected.cedula)
      if (dup) {
        showToast('yellow', `⚠️ Ya registrado: ${detected.apellidos} ${detected.nombres}`)
        return
      }

      setConfirmForm({
        cedula:          detected.cedula,
        nombres:         detected.nombres,
        apellidos:       detected.apellidos,
        sexo:            detected.sexo ?? '',
        fechaNacimiento: detected.fechaNacimiento ?? '',
        rh:              detected.rh ?? '',
        modo:            detected.modo,
      })
    } catch {
      showToast('red', '❌ Error al cargar la imagen')
    } finally {
      setProcessing(false)
    }
  }, [eventoId, showToast, addLog, tReady])

  // ── Confirm save ──────────────────────────────────────────────────────────

  const handleConfirm = async () => {
    if (!confirmForm) return
    setConfirmSaving(true)
    setConfirmError('')
    try {
      const edad = confirmForm.fechaNacimiento ? calcEdad(confirmForm.fechaNacimiento) : 0
      await registrarAsistencia(eventoId, {
        cedula:          confirmForm.cedula,
        nombres:         confirmForm.nombres,
        apellidos:       confirmForm.apellidos,
        fechaNacimiento: confirmForm.fechaNacimiento,
        edad,
        sexo:            (confirmForm.sexo || undefined) as 'M' | 'F' | undefined,
        rh:              confirmForm.rh,
        modo:            confirmForm.modo,
      })
      showToast('green', `✅ Registrado: ${confirmForm.apellidos} ${confirmForm.nombres}`)
      setConfirmForm(null)
      setDebugLog([])
    } catch (err: unknown) {
      setConfirmError((err as { message?: string }).message ?? 'Error al guardar')
    } finally {
      setConfirmSaving(false)
    }
  }

  // ── Manual registration ───────────────────────────────────────────────────

  const handleManual = async (e: React.FormEvent) => {
    e.preventDefault()
    const { cedula, nombres, apellidos, fechaNacimiento, sexo, rh } = manualForm
    if (!cedula || !nombres || !apellidos || !fechaNacimiento || !sexo) return
    setManualSaving(true)
    setManualError('')
    try {
      const dup = await checkDuplicado(eventoId, cedula.trim())
      if (dup) { setManualError('Esta cédula ya está registrada en este evento'); return }
      await registrarAsistencia(eventoId, {
        cedula:          cedula.trim(),
        nombres:         capitalize(nombres.trim()),
        apellidos:       capitalize(apellidos.trim()),
        fechaNacimiento,
        edad:            calcEdad(fechaNacimiento),
        sexo:            sexo as 'M' | 'F',
        rh:              rh.trim(),
        modo:            'MANUAL',
      })
      showToast('green', `✅ Registrado: ${capitalize(apellidos.trim())} ${capitalize(nombres.trim())}`)
      setShowManual(false)
      setManualForm({ cedula: '', nombres: '', apellidos: '', fechaNacimiento: '', sexo: '', rh: '' })
    } catch (err: unknown) {
      setManualError((err as { message?: string }).message ?? 'Error al guardar')
    } finally {
      setManualSaving(false)
    }
  }

  const FIELD = 'w-full bg-[#111113] border border-[#27272a] rounded-xl px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition'

  return (
    <div className="fixed inset-0 bg-[#0a0a0a] z-50 overflow-hidden flex flex-col">

      {/* Hidden native file input */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={handleImageCapture}
      />

      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <div className="flex items-start gap-3 px-4 pt-10 pb-4 flex-shrink-0">
        <button
          onClick={() => router.back()}
          className="w-10 h-10 rounded-full bg-white/8 flex items-center justify-center text-white shrink-0 text-lg"
        >‹</button>
        <div className="min-w-0">
          <p className="text-white font-semibold text-base leading-tight truncate">{evento?.nombre ?? '…'}</p>
          <p className="text-zinc-500 text-sm mt-0.5">{total} registrado{total !== 1 ? 's' : ''}</p>
        </div>
      </div>

      {/* ── Main card ───────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 pb-10 gap-6">

        {/* Icon */}
        <div className="w-28 h-28 rounded-3xl bg-white/5 border border-white/10 flex items-center justify-center text-6xl">
          {processing ? (
            <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin" />
          ) : '📷'}
        </div>

        {/* Instructions */}
        <div className="text-center max-w-xs">
          <p className="text-white font-semibold text-lg mb-3">
            {processing ? 'Procesando…' : 'Toma una foto de la cédula'}
          </p>
          {!processing && (
            <>
              <div className="bg-white/5 border border-white/8 rounded-2xl p-4 text-left space-y-2 mb-1">
                <p className="text-zinc-300 text-sm">
                  <span className="font-semibold text-white">Cédula vieja</span>
                  {' '}— apunta al código de barras
                </p>
                <div className="h-px bg-white/8" />
                <p className="text-zinc-300 text-sm">
                  <span className="font-semibold text-white">Cédula nueva</span>
                  {' '}— apunta a las líneas {`<<<`}
                </p>
              </div>
              <p className="text-zinc-600 text-xs mt-2">
                Buena luz · cédula plana · sin reflejo
              </p>
            </>
          )}
        </div>

        {/* CTA buttons */}
        {!processing && (
          <div className="w-full max-w-xs space-y-3">
            <button
              onClick={() => { setDebugLog([]); inputRef.current?.click() }}
              disabled={!!confirmForm}
              className="w-full py-4 rounded-2xl bg-emerald-600 text-white font-bold text-lg active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-3 shadow-lg shadow-emerald-900/40"
            >
              📷 Tomar foto
            </button>
            <button
              onClick={() => setShowManual(true)}
              className="w-full py-3.5 rounded-2xl bg-white/8 border border-white/10 text-white/70 font-semibold text-sm active:scale-95 transition-all flex items-center justify-center gap-2"
            >
              ✏️ Ingresar manualmente
            </button>
          </div>
        )}

        {/* Tesseract status */}
        <p className="text-zinc-700 text-[10px]">
          OCR: {tReady ? '✓ listo' : 'cargando…'}
        </p>

        {/* Debug log */}
        {debugLog.length > 0 && (
          <div className="w-full max-w-xs bg-black/60 border border-white/8 rounded-xl p-3 space-y-1">
            <p className="text-zinc-600 text-[9px] font-mono mb-1">— debug —</p>
            {debugLog.map((line, i) => (
              <p key={i} className="text-yellow-300 text-[9px] font-mono leading-tight break-all">{line}</p>
            ))}
          </div>
        )}
      </div>

      {/* ── Toast ───────────────────────────────────────────────────────── */}
      {toast && (
        <div className="absolute inset-x-5 top-24 z-30">
          <div className={`rounded-2xl px-5 py-4 text-center shadow-2xl font-semibold text-sm ${
            toast.color === 'red'    ? 'bg-red-600 text-white' :
            toast.color === 'yellow' ? 'bg-amber-500 text-white' :
                                       'bg-emerald-600 text-white'
          }`}>
            {toast.msg}
          </div>
        </div>
      )}

      {/* ── Confirmation modal ───────────────────────────────────────────── */}
      {confirmForm && (
        <div className="absolute inset-0 z-40 flex items-end sm:items-center justify-center">
          <div className="absolute inset-0 bg-black/85"
            onClick={() => { setConfirmForm(null); setConfirmError('') }} />
          <div className="relative w-full max-w-md bg-[#18181b] border border-[#27272a] rounded-t-3xl sm:rounded-2xl p-6 max-h-[92dvh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold text-white text-base">Confirmar registro</h2>
              <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                confirmForm.modo === 'PDF417'
                  ? 'bg-blue-500/20 text-blue-400'
                  : 'bg-purple-500/20 text-purple-400'
              }`}>{confirmForm.modo}</span>
            </div>

            <div className="space-y-3">
              {confirmForm.rawText && (
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Texto detectado (completa los campos)</label>
                  <div className="w-full bg-black/60 border border-yellow-500/30 rounded-xl px-3 py-2 text-yellow-300 text-[9px] font-mono break-all leading-relaxed">
                    {confirmForm.rawText}
                  </div>
                </div>
              )}
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Número de cédula</label>
                <input value={confirmForm.cedula}
                  onChange={e => setConfirmForm(f => f ? { ...f, cedula: e.target.value } : f)}
                  className={FIELD} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Nombres</label>
                  <input value={confirmForm.nombres}
                    onChange={e => setConfirmForm(f => f ? { ...f, nombres: e.target.value } : f)}
                    className={FIELD} />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Apellidos</label>
                  <input value={confirmForm.apellidos}
                    onChange={e => setConfirmForm(f => f ? { ...f, apellidos: e.target.value } : f)}
                    className={FIELD} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Fecha nacimiento</label>
                  <input type="date" value={confirmForm.fechaNacimiento}
                    onChange={e => setConfirmForm(f => f ? { ...f, fechaNacimiento: e.target.value } : f)}
                    className={`${FIELD} [color-scheme:dark]`} />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Edad</label>
                  <div className={`${FIELD} text-zinc-400 cursor-default`}>
                    {confirmForm.fechaNacimiento ? `${calcEdad(confirmForm.fechaNacimiento)} años` : '—'}
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Sexo</label>
                  <select value={confirmForm.sexo}
                    onChange={e => setConfirmForm(f => f ? { ...f, sexo: e.target.value as 'M' | 'F' | '' } : f)}
                    className={`${FIELD} [color-scheme:dark]`}>
                    <option value="">—</option>
                    <option value="M">Masculino</option>
                    <option value="F">Femenino</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">RH (opcional)</label>
                  <input value={confirmForm.rh}
                    onChange={e => setConfirmForm(f => f ? { ...f, rh: e.target.value } : f)}
                    placeholder="O+" className={FIELD} />
                </div>
              </div>

              {confirmError && (
                <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">
                  {confirmError}
                </p>
              )}

              <div className="flex gap-3 pt-1">
                <button onClick={() => { setConfirmForm(null); setConfirmError('') }}
                  className="flex-1 py-3 rounded-xl border border-[#27272a] text-zinc-400 text-sm hover:bg-white/5 transition">
                  ❌ Cancelar
                </button>
                <button onClick={handleConfirm} disabled={confirmSaving}
                  className="flex-1 py-3 rounded-xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-500 disabled:opacity-60 transition flex items-center justify-center gap-2">
                  {confirmSaving
                    ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Guardando…</>
                    : '✅ Confirmar'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Manual modal ────────────────────────────────────────────────── */}
      {showManual && (
        <div className="absolute inset-0 z-40 flex items-end sm:items-center justify-center">
          <div className="absolute inset-0 bg-black/70"
            onClick={() => { setShowManual(false); setManualError('') }} />
          <div className="relative w-full max-w-md bg-[#18181b] border border-[#27272a] rounded-t-3xl sm:rounded-2xl p-6 max-h-[90dvh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-semibold text-white text-base">Registrar manualmente</h2>
              <button onClick={() => { setShowManual(false); setManualError('') }}
                className="w-8 h-8 rounded-lg bg-white/10 text-zinc-400 hover:text-white flex items-center justify-center transition">
                ✕
              </button>
            </div>
            <form onSubmit={handleManual} className="space-y-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Número de cédula *</label>
                <input required inputMode="numeric"
                  value={manualForm.cedula}
                  onChange={e => setManualForm(f => ({ ...f, cedula: e.target.value }))}
                  placeholder="1234567890" className={FIELD} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Nombres *</label>
                  <input required value={manualForm.nombres}
                    onChange={e => setManualForm(f => ({ ...f, nombres: e.target.value }))}
                    placeholder="Juan" className={FIELD} />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Apellidos *</label>
                  <input required value={manualForm.apellidos}
                    onChange={e => setManualForm(f => ({ ...f, apellidos: e.target.value }))}
                    placeholder="García" className={FIELD} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Fecha nacimiento *</label>
                  <input required type="date"
                    value={manualForm.fechaNacimiento}
                    onChange={e => setManualForm(f => ({ ...f, fechaNacimiento: e.target.value }))}
                    className={`${FIELD} [color-scheme:dark]`} />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Sexo *</label>
                  <select required value={manualForm.sexo}
                    onChange={e => setManualForm(f => ({ ...f, sexo: e.target.value as 'M' | 'F' | '' }))}
                    className={`${FIELD} [color-scheme:dark]`}>
                    <option value="">—</option>
                    <option value="M">Masculino</option>
                    <option value="F">Femenino</option>
                  </select>
                </div>
              </div>
              {manualForm.fechaNacimiento && (
                <p className="text-zinc-500 text-xs">
                  Edad: <span className="text-white font-semibold">{calcEdad(manualForm.fechaNacimiento)} años</span>
                </p>
              )}
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">RH (opcional)</label>
                <input value={manualForm.rh}
                  onChange={e => setManualForm(f => ({ ...f, rh: e.target.value }))}
                  placeholder="O+" className={FIELD} />
              </div>
              {manualError && (
                <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">
                  {manualError}
                </p>
              )}
              <div className="flex gap-3 pt-1">
                <button type="button"
                  onClick={() => { setShowManual(false); setManualError('') }}
                  className="flex-1 py-3 rounded-xl border border-[#27272a] text-zinc-400 text-sm hover:bg-white/5 transition">
                  Cancelar
                </button>
                <button type="submit" disabled={manualSaving}
                  className="flex-1 py-3 rounded-xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-500 disabled:opacity-60 transition flex items-center justify-center gap-2">
                  {manualSaving
                    ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Guardando…</>
                    : 'Registrar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
