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

function parsePdf417Binario(raw: string): Cedula | null {
  if (raw.length < 160) return null
  const clean = (s: string) => s.replace(/\x00/g, '').trim()
  const cedula = clean(raw.substring(48, 58)).replace(/^0+/, '')
  if (!/^\d{5,12}$/.test(cedula)) return null
  const apellido1 = cleanName(clean(raw.substring(58, 80)))
  const apellido2 = cleanName(clean(raw.substring(81, 104)))
  const nombre1   = cleanName(clean(raw.substring(104, 127)))
  const nombre2   = cleanName(clean(raw.substring(127, 150)))
  const sexoChar  = clean(raw.substring(151, 152))
  const anioNac   = clean(raw.substring(152, 156))
  const mesNac    = clean(raw.substring(156, 158))
  const diaNac    = clean(raw.substring(158, 160))
  const rh        = clean(raw.substring(166, 168))
  if (!apellido1 && !nombre1) return null
  return {
    cedula,
    nombres:   [nombre1, nombre2].filter(Boolean).join(' '),
    apellidos: [apellido1, apellido2].filter(Boolean).join(' '),
    sexo:      sexoChar === 'M' || sexoChar === 'F' ? sexoChar as 'M' | 'F' : undefined,
    rh:        rh || undefined,
    modo:      'PDF417',
    ...buildFecha(anioNac, mesNac, diaNac) ?? {},
  }
}

function parsePdf417NullSplit(raw: string): Cedula | null {
  const normalized = raw.replace(/\x00{2,}/g, '\x00')
  const segs = normalized.split('\x00')
  if (segs.length < 6) return null
  for (let i = 0; i <= segs.length - 5; i++) {
    const seg = segs[i]
    if (seg.length < 18) continue
    const rawDoc = seg.substring(10, 18).replace(/\D/g, '').replace(/^0+/, '')
    if (!/^\d{5,12}$/.test(rawDoc)) continue
    const ap1 = cleanName(seg.substring(18).replace(/\x00/g, '').trim())
    const ap2 = cleanName((segs[i + 1] ?? '').replace(/\x00/g, '').trim())
    const nm1 = cleanName((segs[i + 2] ?? '').replace(/\x00/g, '').trim())
    let   nm2 = cleanName((segs[i + 3] ?? '').replace(/\x00/g, '').trim())
    const ds  = segs[i + 4] ?? ''
    if (!ap1 && !nm1) continue
    if (/[-+]$/.test(nm2)) nm2 = ''
    const sexoChar = ds[1]
    const rh       = ds.substring(16, 18).replace(/\x00/g, '').trim()
    return {
      cedula:    rawDoc,
      nombres:   [nm1, nm2].filter(Boolean).join(' '),
      apellidos: [ap1, ap2].filter(Boolean).join(' '),
      sexo:      sexoChar === 'M' || sexoChar === 'F' ? sexoChar as 'M' | 'F' : undefined,
      rh:        rh || undefined,
      modo:      'PDF417',
      ...buildFecha(ds.substring(2, 6), ds.substring(6, 8), ds.substring(8, 10)) ?? {},
    }
  }
  return null
}

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

// Corrige errores típicos de OCR en líneas numéricas MRZ: O→0, I→1
function correctMrzOcr(text: string): string {
  return text.split('\n').map(line => {
    const t = line.trim()
    // Solo corregir en líneas que parecen datos MRZ (muchos dígitos/< y sin espacios interiores)
    if (t.length >= 20 && /[0-9<]{10,}/.test(t) && !/ {2,}/.test(t)) {
      return t.replace(/O/g, '0').replace(/I/g, '1')
    }
    return line
  }).join('\n')
}

function parseMrzLines(_l1: string, l2: string, l3: string): Cedula | null {
  // Corregir OCR en l2 (línea numérica: fechas + COL + cédula)
  const l2c = l2.replace(/O/g, '0').replace(/I/g, '1')
  const colIdx = l2c.indexOf('COL')
  if (colIdx < 0) return null
  // Cédula: dígitos después de COL hasta el primer no-dígito
  const cedula = l2c.slice(colIdx + 3).match(/^(\d{5,12})/)?.[1] ?? ''
  if (cedula.length < 5) return null
  const yy = parseInt(l2c.slice(0, 2))
  const mm = parseInt(l2c.slice(2, 4))
  const dd = parseInt(l2c.slice(4, 6))
  let fechaNacimiento: string | undefined, edad: number | undefined
  if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
    const fullYear = yy > 30 ? 1900 + yy : 2000 + yy
    fechaNacimiento = `${fullYear}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
    edad = calcEdad(fechaNacimiento)
  }
  const sc   = l2c[7]
  const sexo: 'M' | 'F' | undefined = sc === 'M' ? 'M' : sc === 'F' ? 'F' : undefined
  const nameRaw   = l3.replace(/<+$/, '')
  const sepIdx    = nameRaw.indexOf('<<')
  const apellidos = sepIdx >= 0 ? cleanMrzName(nameRaw.slice(0, sepIdx)) : cleanMrzName(nameRaw)
  const nombres   = sepIdx >= 0 ? cleanMrzName(nameRaw.slice(sepIdx + 2)) : ''
  return { cedula, nombres, apellidos, sexo, fechaNacimiento, edad, modo: 'MRZ' }
}

function parseMrzText(raw: string): Cedula | null {
  const corrected = correctMrzOcr(raw)
  const upper = corrected.toUpperCase()
  const lines  = upper.split(/[\n\r]+/).map(l => l.trim().replace(/[^A-Z0-9<]/g, '')).filter(l => l.length >= 10)
  if (lines.length === 0) return null
  for (const pfx of ['ICCOL', 'IDCOL', 'IC<COL', 'ID<COL']) {
    const i = lines.findIndex(l => l.startsWith(pfx))
    if (i >= 0 && i + 2 < lines.length) {
      const r = parseMrzLines(lines[i], lines[i + 1].padEnd(30, '<'), lines[i + 2])
      if (r) return r
    }
  }
  const l2i = lines.findIndex(l => /^\d{7}[MF0]/.test(l))
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
  const corrected = correctMrzOcr(text)
  const up = corrected.toUpperCase().replace(/[^A-Z0-9<\n\r]/g, ' ')
  let cedula = ''
  const m1 = up.match(/COL(\d{6,12})[<0-9 \n\r]/)
  if (m1) cedula = m1[1]
  if (!cedula) {
    const m2 = up.match(/ICCOL(\d{6,12})/)
    if (m2) cedula = m2[1]
  }
  if (cedula.length < 5) return null
  let apellidos = '', nombres = ''
  const m3 = up.match(/([A-Z][A-Z< ]+)<<([A-Z][A-Z< ]*)/)
  if (m3) { apellidos = cleanMrzName(m3[1]); nombres = cleanMrzName(m3[2]) }
  return { cedula, apellidos, nombres, modo: 'MRZ' }
}

export function debugPdf417Positions(raw: string): string {
  const vis = (s: string) => s.replace(/\x00/g, '□')
  return [
    `len=${raw.length}`,
    `p48-58:"${vis(raw.substring(48, 58))}"`,
    `p58-80:"${vis(raw.substring(58, 80))}"`,
    `p104-127:"${vis(raw.substring(104, 127))}"`,
    `nulls=${(raw.match(/\x00/g) ?? []).length}`,
    `segs=${raw.replace(/\x00{2,}/g, '\x00').split('\x00').length}`,
  ].join(' | ')
}

function parseBarcode(raw: string): Cedula | null {
  if (!raw || raw.length < 5) return null
  const up = raw.toUpperCase()
  if (up.includes('ICCOL') || up.includes('IDCOL') || raw.includes('<<')) {
    return parseMrzText(raw) ?? parseMrzRegex(raw)
  }
  return parsePdf417Binario(raw) ?? parsePdf417NullSplit(raw) ?? parsePdf417Legacy(raw)
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ScannerPage() {
  const { id: eventoId } = useParams<{ id: string }>()
  const router = useRouter()

  // Camera
  const videoRef   = useRef<HTMLVideoElement>(null)
  const streamRef  = useRef<MediaStream | null>(null)
  const inputRef   = useRef<HTMLInputElement>(null)

  // OCR
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tWorkerRef  = useRef<any>(null)
  const tReadyRef   = useRef(false)
  const toastTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)

  // UI state
  const [cameraReady,   setCameraReady]   = useState(false)
  const [cameraError,   setCameraError]   = useState(false)
  const [flashAvail,    setFlashAvail]    = useState(false)
  const [flashOn,       setFlashOn]       = useState(false)
  const [tooDark,       setTooDark]       = useState(false)
  const [scanState,     setScanState]     = useState<'idle' | 'processing' | 'success' | 'error'>('idle')
  const [processing,    setProcessing]    = useState(false)
  const [ocrFailCount,  setOcrFailCount]  = useState(0)

  // App state
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

  // ── Debug ──────────────────────────────────────────────────────────────────

  const addLog = useCallback((msg: string) => {
    console.log(msg)
    setDebugLog(prev => [...prev.slice(-9), msg])
  }, [])

  // ── Camera init ────────────────────────────────────────────────────────────

  useEffect(() => {
    let alive = true
    const init = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        })
        if (!alive) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play().catch(() => {})
        }
        const track = stream.getVideoTracks()[0]
        const caps  = track.getCapabilities?.() as Record<string, unknown> | undefined
        if (caps && 'torch' in caps) setFlashAvail(true)
        setCameraReady(true)
      } catch {
        setCameraError(true)
      }
    }
    init()
    return () => {
      alive = false
      streamRef.current?.getTracks().forEach(t => t.stop())
    }
  }, [])

  // ── Ambient light check ────────────────────────────────────────────────────

  useEffect(() => {
    if (!cameraReady) return
    const canvas = document.createElement('canvas')
    canvas.width = 50; canvas.height = 50
    const ctx = canvas.getContext('2d')!
    const check = () => {
      const v = videoRef.current
      if (!v || v.readyState < 2) return
      ctx.drawImage(v, 0, 0, 50, 50)
      const d = ctx.getImageData(0, 0, 50, 50).data
      let sum = 0
      for (let i = 0; i < d.length; i += 4) sum += d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114
      setTooDark(sum / (50 * 50) < 35)
    }
    const id = setInterval(check, 1800)
    return () => clearInterval(id)
  }, [cameraReady])

  // ── Tesseract init ─────────────────────────────────────────────────────────

  useEffect(() => {
    let alive = true
    const init = async () => {
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
    init()
    return () => {
      alive = false
      tWorkerRef.current?.terminate?.()
      if (toastTimer.current) clearTimeout(toastTimer.current)
    }
  }, [])

  // ── Realtime counter ───────────────────────────────────────────────────────

  useEffect(() => {
    if (!eventoId) return
    return onSnapshot(collection(db, 'eventos', eventoId, 'asistencias'), s => setTotal(s.size))
  }, [eventoId])

  useEffect(() => {
    if (!eventoId) return
    getDoc(doc(db, 'eventos', eventoId)).then(s => {
      if (s.exists()) setEvento({ id: s.id, ...s.data() } as Evento)
    })
  }, [eventoId])

  // ── Toast ──────────────────────────────────────────────────────────────────

  const showToast = useCallback((color: 'red' | 'yellow' | 'green', msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ color, msg })
    toastTimer.current = setTimeout(() => setToast(null), 3200)
  }, [])

  // ── Flash toggle ───────────────────────────────────────────────────────────

  const toggleFlash = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    try {
      const next = !flashOn
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] })
      setFlashOn(next)
    } catch { /* torch not supported */ }
  }, [flashOn])

  // ── Core capture + process ─────────────────────────────────────────────────

  const processImage = useCallback(async (imgEl: HTMLImageElement | HTMLCanvasElement, W: number, H: number) => {
    const MAX = 2000
    const scale = Math.min(1, MAX / Math.max(W, H))
    const cW = Math.round(W * scale), cH = Math.round(H * scale)
    const canvas = document.createElement('canvas')
    canvas.width = cW; canvas.height = cH
    canvas.getContext('2d')!.drawImage(imgEl, 0, 0, cW, cH)

    const base64 = canvas.toDataURL('image/jpeg', 0.9).split(',')[1]
    addLog(`[foto] ${W}×${H} → ${cW}×${cH} | ${Math.round(base64.length / 1024)}kb`)

    let detected: Cedula | null = null
    let rawServerText: string | undefined

    try {
      addLog('[api] enviando…')
      const resp = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64 }),
      })
      const data = await resp.json() as {
        success: boolean; text?: string
        parsed?: { cedula: string; apellido1: string; apellido2: string; nombre1: string; nombre2: string; sexo: string; anioNac: string; mesNac: string; diaNac: string; rh: string }
        error?: string; logs?: string[]
      }
      for (const line of data.logs ?? []) addLog(line)

      if (data.success && data.text) {
        rawServerText = data.text
        if (data.parsed?.cedula) {
          const p = data.parsed
          detected = {
            cedula:    p.cedula,
            nombres:   cleanName([p.nombre1, p.nombre2].filter(Boolean).join(' ')),
            apellidos: cleanName([p.apellido1, p.apellido2].filter(Boolean).join(' ')),
            sexo:      p.sexo === 'M' || p.sexo === 'F' ? p.sexo as 'M' | 'F' : undefined,
            rh:        p.rh || undefined,
            modo:      'PDF417',
            ...buildFecha(p.anioNac, p.mesNac, p.diaNac) ?? {},
          }
          addLog(`[srv✓] ${detected.apellidos} | ${p.cedula}`)
        } else {
          addLog(`[txt] ${data.text.replace(/\x00/g, '□')}`)
          addLog(`[pos] ${debugPdf417Positions(data.text)}`)
          const r1 = parsePdf417Binario(data.text)
          const r2 = r1 ? null : parsePdf417NullSplit(data.text)
          const r3 = (r1 || r2) ? null : parsePdf417Legacy(data.text)
          detected = r1 ?? r2 ?? r3 ?? parseMrzText(data.text) ?? parseMrzRegex(data.text)
          addLog(`[parse] bin=${r1?'✓':'✗'} null=${r2?'✓':'✗'} leg=${r3?'✓':'✗'} → ${detected ? `cedula=${detected.cedula}` : 'nada'}`)
        }
      } else {
        addLog(`[api] sin detección: ${data.error ?? ''}`)
      }
    } catch (err) {
      addLog(`[api] error: ${String(err).slice(0, 80)}`)
    }

    // ── Tesseract MRZ fallback ──────────────────────────────────────────────
    if (!detected) {
      if (tReadyRef.current && tWorkerRef.current) {
        try {
          const sy = Math.floor(cH * 0.50), sh = Math.floor(cH * 0.50)
          const ct = document.createElement('canvas')
          ct.width = cW; ct.height = sh
          const cx = ct.getContext('2d')!
          // Alto contraste para mejorar lectura MRZ
          cx.filter = 'contrast(2.5) brightness(1.3) grayscale(1)'
          cx.drawImage(canvas, 0, sy, cW, sh, 0, 0, cW, sh)
          cx.filter = 'none'
          const { data: { text } } = await tWorkerRef.current.recognize(ct)
          addLog(`[ocr] ${text.trim()}`)
          detected = parseMrzText(text) ?? parseMrzRegex(text)
          if (detected) {
            addLog(`[ocr✓] ${detected.modo} cedula=${detected.cedula}`)
            setOcrFailCount(0)
          } else {
            const newFails = ocrFailCount + 1
            setOcrFailCount(newFails)
            addLog(`[ocr] fallo ${newFails}/2`)
            // Después de 2 fallos: abrir modal con lo que tenemos del OCR
            if (newFails >= 2) {
              const partialCedula = text.match(/\d{6,12}/)?.[0] ?? ''
              setOcrFailCount(0)
              setScanState('error')
              setTimeout(() => setScanState('idle'), 800)
              setProcessing(false)
              setConfirmForm({
                cedula: partialCedula, nombres: '', apellidos: '',
                sexo: '', fechaNacimiento: '', rh: '', modo: 'MRZ',
                rawText: text.trim().slice(0, 300),
              })
              return
            }
          }
        } catch (err) {
          addLog(`[ocr] error: ${String(err).slice(0, 60)}`)
        }
      } else {
        addLog(`[ocr] ${tReady ? 'ocupado' : 'iniciando…'}`)
      }
    }

    // ── Result ──────────────────────────────────────────────────────────────
    if (!detected || detected.cedula.length < 5) {
      if (!rawServerText) {
        setScanState('error')
        setTimeout(() => setScanState('idle'), 800)
        showToast('red', '❌ No se detectó. Intenta de nuevo')
      } else {
        // Hay texto raw pero no se parseó: abrir modal para completar
        const rawCedula = rawServerText.match(/\d{6,12}/)?.[0] ?? ''
        setScanState('error')
        setTimeout(() => setScanState('idle'), 800)
        setConfirmForm({
          cedula: rawCedula, nombres: '', apellidos: '',
          sexo: '', fechaNacimiento: '', rh: '', modo: 'PDF417',
          rawText: rawServerText.replace(/\x00/g, '').slice(0, 200),
        })
      }
      setProcessing(false)
      return
    }

    const dup = await checkDuplicado(eventoId, detected.cedula)
    if (dup) {
      setScanState('error')
      setTimeout(() => setScanState('idle'), 800)
      showToast('yellow', `⚠️ Ya registrado: ${detected.apellidos} ${detected.nombres}`)
      setProcessing(false)
      return
    }

    setScanState('success')
    setTimeout(() => setScanState('idle'), 1200)
    setConfirmForm({
      cedula:          detected.cedula,
      nombres:         detected.nombres,
      apellidos:       detected.apellidos,
      sexo:            detected.sexo ?? '',
      fechaNacimiento: detected.fechaNacimiento ?? '',
      rh:              detected.rh ?? '',
      modo:            detected.modo,
    })
    setProcessing(false)
  }, [eventoId, showToast, addLog, ocrFailCount, tReady])

  // ── Capture from live camera ───────────────────────────────────────────────

  const handleCapture = useCallback(async () => {
    if (processing || !cameraReady || !videoRef.current) return
    const v = videoRef.current
    if (!v.videoWidth) return
    setProcessing(true)
    setScanState('processing')
    setDebugLog([])
    await processImage(v, v.videoWidth, v.videoHeight)
  }, [processing, cameraReady, processImage])

  // ── Capture from file input (iOS fallback) ─────────────────────────────────

  const handleFileCapture = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setProcessing(true)
    setScanState('processing')
    setDebugLog([])
    const url = URL.createObjectURL(file)
    const img  = new Image()
    img.src = url
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej() })
    URL.revokeObjectURL(url)
    await processImage(img, img.naturalWidth, img.naturalHeight)
  }, [processImage])

  // ── Confirm save ───────────────────────────────────────────────────────────

  const handleConfirm = async () => {
    if (!confirmForm) return
    setConfirmSaving(true); setConfirmError('')
    try {
      const edad = confirmForm.fechaNacimiento ? calcEdad(confirmForm.fechaNacimiento) : 0
      await registrarAsistencia(eventoId, {
        cedula: confirmForm.cedula, nombres: confirmForm.nombres, apellidos: confirmForm.apellidos,
        fechaNacimiento: confirmForm.fechaNacimiento, edad,
        sexo: (confirmForm.sexo || undefined) as 'M' | 'F' | undefined,
        rh: confirmForm.rh, modo: confirmForm.modo,
      })
      showToast('green', `✅ ${confirmForm.apellidos} ${confirmForm.nombres}`)
      setConfirmForm(null); setDebugLog([])
    } catch (err: unknown) {
      setConfirmError((err as { message?: string }).message ?? 'Error al guardar')
    } finally {
      setConfirmSaving(false)
    }
  }

  // ── Manual registration ────────────────────────────────────────────────────

  const handleManual = async (e: React.FormEvent) => {
    e.preventDefault()
    const { cedula, nombres, apellidos, fechaNacimiento, sexo, rh } = manualForm
    if (!cedula || !nombres || !apellidos || !fechaNacimiento || !sexo) return
    setManualSaving(true); setManualError('')
    try {
      const dup = await checkDuplicado(eventoId, cedula.trim())
      if (dup) { setManualError('Esta cédula ya está registrada'); return }
      await registrarAsistencia(eventoId, {
        cedula: cedula.trim(), nombres: capitalize(nombres.trim()), apellidos: capitalize(apellidos.trim()),
        fechaNacimiento, edad: calcEdad(fechaNacimiento),
        sexo: sexo as 'M' | 'F', rh: rh.trim(), modo: 'MANUAL',
      })
      showToast('green', `✅ ${capitalize(apellidos.trim())} ${capitalize(nombres.trim())}`)
      setShowManual(false)
      setManualForm({ cedula: '', nombres: '', apellidos: '', fechaNacimiento: '', sexo: '', rh: '' })
    } catch (err: unknown) {
      setManualError((err as { message?: string }).message ?? 'Error al guardar')
    } finally {
      setManualSaving(false)
    }
  }

  // ── Corner color ───────────────────────────────────────────────────────────

  const cornerColor = scanState === 'success' ? '#4ade80' : scanState === 'error' ? '#f87171' : '#22c55e'
  const cornerGlow  = scanState === 'success' ? '#4ade8066' : scanState === 'error' ? '#f8717166' : '#22c55e55'

  const FIELD = 'w-full bg-[#111113] border border-[#27272a] rounded-xl px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition'

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 bg-black z-50 overflow-hidden flex flex-col select-none">

      {/* CSS keyframe animations */}
      <style>{`
        @keyframes scanLine {
          0%   { transform: translateY(0%); opacity: 1; }
          85%  { opacity: 1; }
          100% { transform: translateY(calc(100% - 2px)); opacity: 0; }
        }
        @keyframes cornerPulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.55; }
        }
        @keyframes processSweep {
          0%   { transform: translateY(-100%); }
          100% { transform: translateY(100%); }
        }
        @keyframes fadeIn { from { opacity:0 } to { opacity:1 } }
      `}</style>

      {/* ── File input fallback (hidden) ──────────────────────────────────── */}
      <input ref={inputRef} type="file" accept="image/*" capture="environment"
        style={{ display: 'none' }} onChange={handleFileCapture} />

      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center gap-3 px-4 pt-10 pb-4"
        style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.85) 0%, transparent 100%)' }}>
        <button onClick={() => router.back()}
          className="w-9 h-9 rounded-full bg-white/10 flex items-center justify-center text-white text-xl shrink-0">
          ‹
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-white font-semibold text-sm leading-tight truncate">{evento?.nombre ?? '…'}</p>
          <p className="text-emerald-400 font-bold text-base">{total} asistente{total !== 1 ? 's' : ''}</p>
        </div>
        {/* OCR status pill */}
        <div className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${tReady ? 'bg-emerald-900/50 text-emerald-400' : 'bg-zinc-800 text-zinc-500'}`}>
          OCR {tReady ? '✓' : '…'}
        </div>
      </div>

      {/* ── Camera or no-camera background ───────────────────────────────── */}
      {!cameraError ? (
        <video ref={videoRef} autoPlay playsInline muted
          className="absolute inset-0 w-full h-full object-cover" />
      ) : (
        <div className="absolute inset-0 bg-zinc-900 flex items-center justify-center">
          <p className="text-zinc-500 text-sm">Cámara no disponible</p>
        </div>
      )}

      {/* ── Scanner frame ─────────────────────────────────────────────────── */}
      <div className="absolute inset-0 flex items-center justify-center"
        style={{ paddingTop: '80px', paddingBottom: '160px' }}>

        <div className="relative" style={{ width: '88%', aspectRatio: '85/54' }}>

          {/* Dark vignette outside frame */}
          <div className="absolute inset-0 rounded-lg pointer-events-none"
            style={{ boxShadow: '0 0 0 100vmax rgba(0,0,0,0.52)' }} />

          {/* Scan line (only when idle) */}
          {scanState === 'idle' && (
            <div className="absolute inset-0 overflow-hidden rounded-lg">
              <div style={{
                position: 'absolute', left: '4%', right: '4%', height: '2px',
                background: 'linear-gradient(90deg, transparent 0%, #ef4444 30%, #ff6b6b 50%, #ef4444 70%, transparent 100%)',
                boxShadow: '0 0 8px 2px #ef444488',
                animation: 'scanLine 2.2s ease-in-out infinite',
                top: 0,
              }} />
            </div>
          )}

          {/* Processing sweep overlay */}
          {scanState === 'processing' && (
            <div className="absolute inset-0 rounded-lg overflow-hidden flex items-center justify-center"
              style={{ background: 'rgba(0,0,0,0.5)' }}>
              <div style={{
                position: 'absolute', left: 0, right: 0, height: '60%',
                background: 'linear-gradient(180deg, transparent, rgba(34,197,94,0.15), transparent)',
                animation: 'processSweep 1s ease-in-out infinite',
              }} />
              <div className="relative z-10 text-center">
                <div className="w-10 h-10 border-[3px] border-emerald-500/30 border-t-emerald-400 rounded-full animate-spin mx-auto mb-3" />
                <p className="text-emerald-300 text-sm font-semibold tracking-wide">Leyendo cédula…</p>
              </div>
            </div>
          )}

          {/* Corner brackets — top-left */}
          <div className="absolute top-0 left-0"
            style={{ width: 28, height: 28, borderTop: `3px solid ${cornerColor}`, borderLeft: `3px solid ${cornerColor}`, borderRadius: '2px 0 0 0', filter: `drop-shadow(0 0 5px ${cornerGlow})`, animation: 'cornerPulse 2s ease-in-out infinite' }} />
          {/* top-right */}
          <div className="absolute top-0 right-0"
            style={{ width: 28, height: 28, borderTop: `3px solid ${cornerColor}`, borderRight: `3px solid ${cornerColor}`, borderRadius: '0 2px 0 0', filter: `drop-shadow(0 0 5px ${cornerGlow})`, animation: 'cornerPulse 2s ease-in-out infinite 0.5s' }} />
          {/* bottom-left */}
          <div className="absolute bottom-0 left-0"
            style={{ width: 28, height: 28, borderBottom: `3px solid ${cornerColor}`, borderLeft: `3px solid ${cornerColor}`, borderRadius: '0 0 0 2px', filter: `drop-shadow(0 0 5px ${cornerGlow})`, animation: 'cornerPulse 2s ease-in-out infinite 1s' }} />
          {/* bottom-right */}
          <div className="absolute bottom-0 right-0"
            style={{ width: 28, height: 28, borderBottom: `3px solid ${cornerColor}`, borderRight: `3px solid ${cornerColor}`, borderRadius: '0 0 2px 0', filter: `drop-shadow(0 0 5px ${cornerGlow})`, animation: 'cornerPulse 2s ease-in-out infinite 1.5s' }} />
        </div>
      </div>

      {/* ── Bottom UI ─────────────────────────────────────────────────────── */}
      <div className="absolute bottom-0 left-0 right-0 z-20 flex flex-col items-center"
        style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.92) 60%, transparent 100%)', paddingBottom: 'env(safe-area-inset-bottom, 20px)' }}>

        {/* Light warning */}
        {tooDark && (
          <p className="text-amber-400 text-xs font-medium mb-1 animate-pulse">
            💡 Necesitas más luz
          </p>
        )}

        {/* Instruction */}
        <p className="text-zinc-300 text-xs text-center mb-5 px-6">
          {cameraError
            ? 'Toma una foto del reverso de la cédula'
            : 'Coloca el reverso de la cédula dentro del marco'}
        </p>
        <p className="text-zinc-600 text-[10px] mb-5">Mantén la cédula horizontal y plana</p>

        {/* Buttons row */}
        <div className="flex items-center justify-between w-full px-10 mb-8">

          {/* Flash */}
          {flashAvail ? (
            <button onClick={toggleFlash} disabled={processing}
              className={`w-14 h-14 rounded-full flex items-center justify-center text-xl transition active:scale-90 ${flashOn ? 'bg-yellow-400 text-black' : 'bg-white/10 text-white'}`}>
              ⚡
            </button>
          ) : (
            <div className="w-14 h-14" />
          )}

          {/* Main capture */}
          {cameraError ? (
            <button onClick={() => { setDebugLog([]); inputRef.current?.click() }}
              disabled={processing}
              className="w-20 h-20 rounded-full bg-emerald-500 border-4 border-emerald-300/50 flex items-center justify-center text-3xl shadow-lg shadow-emerald-900/50 active:scale-95 transition disabled:opacity-50">
              {processing ? <div className="w-7 h-7 border-[3px] border-white/30 border-t-white rounded-full animate-spin" /> : '📷'}
            </button>
          ) : (
            <button onClick={handleCapture} disabled={processing || !cameraReady}
              className="w-20 h-20 rounded-full bg-emerald-500 border-4 border-emerald-300/50 flex items-center justify-center text-3xl shadow-lg shadow-emerald-900/50 active:scale-95 transition disabled:opacity-50">
              {processing
                ? <div className="w-7 h-7 border-[3px] border-white/30 border-t-white rounded-full animate-spin" />
                : '📸'}
            </button>
          )}

          {/* Manual */}
          <button onClick={() => setShowManual(true)} disabled={!!confirmForm}
            className="w-14 h-14 rounded-full bg-white/10 flex items-center justify-center text-xl text-white active:scale-90 transition disabled:opacity-40">
            ✏️
          </button>
        </div>

        {/* Debug log */}
        {debugLog.length > 0 && (
          <div className="w-full px-4 mb-4 max-h-20 overflow-y-auto">
            {debugLog.map((l, i) => (
              <p key={i} className="text-yellow-300/70 text-[8px] font-mono leading-tight break-all">{l}</p>
            ))}
          </div>
        )}
      </div>

      {/* ── Toast ─────────────────────────────────────────────────────────── */}
      {toast && (
        <div className="absolute inset-x-5 top-24 z-30" style={{ animation: 'fadeIn 0.2s ease' }}>
          <div className={`rounded-2xl px-5 py-4 text-center shadow-2xl font-semibold text-sm ${
            toast.color === 'red'    ? 'bg-red-600 text-white' :
            toast.color === 'yellow' ? 'bg-amber-500 text-white' :
                                       'bg-emerald-600 text-white'
          }`}>{toast.msg}</div>
        </div>
      )}

      {/* ── Confirmation modal ────────────────────────────────────────────── */}
      {confirmForm && (
        <div className="absolute inset-0 z-40 flex items-end sm:items-center justify-center">
          <div className="absolute inset-0 bg-black/80" onClick={() => { setConfirmForm(null); setConfirmError('') }} />
          <div className="relative w-full max-w-md bg-[#111113] border border-[#27272a] rounded-t-3xl sm:rounded-2xl max-h-[92dvh] overflow-y-auto"
            style={{ animation: 'fadeIn 0.2s ease' }}>

            {/* Header */}
            <div className={`px-6 pt-6 pb-4 rounded-t-3xl sm:rounded-t-2xl ${confirmForm.rawText ? 'bg-amber-900/20' : 'bg-emerald-900/20'}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center text-xl ${confirmForm.rawText ? 'bg-amber-500/20' : 'bg-emerald-500/20'}`}>
                    {confirmForm.rawText ? '⚠️' : '✅'}
                  </div>
                  <div>
                    <p className="text-white font-semibold text-base">
                      {confirmForm.rawText ? 'Revisar datos' : 'Cédula detectada'}
                    </p>
                    <p className="text-zinc-400 text-xs">Confirma la información antes de guardar</p>
                  </div>
                </div>
                <span className={`text-xs px-2.5 py-1 rounded-full font-bold ${
                  confirmForm.modo === 'PDF417' ? 'bg-blue-500/20 text-blue-300' :
                  confirmForm.modo === 'MRZ'    ? 'bg-purple-500/20 text-purple-300' :
                                                  'bg-zinc-700 text-zinc-300'
                }`}>{confirmForm.modo}</span>
              </div>
            </div>

            <div className="px-6 py-5 space-y-4">
              {/* Raw text (when parse failed) */}
              {confirmForm.rawText && (
                <div>
                  <p className="text-xs text-zinc-500 mb-1.5 font-medium">Texto detectado — completa los campos manualmente</p>
                  <div className="bg-black/50 border border-amber-500/20 rounded-xl px-3 py-2 text-amber-300/80 text-[9px] font-mono break-all leading-relaxed max-h-20 overflow-y-auto">
                    {confirmForm.rawText}
                  </div>
                </div>
              )}

              {/* Fields */}
              <div>
                <label className="text-[10px] text-zinc-500 uppercase tracking-widest font-semibold mb-1.5 flex items-center gap-1.5"><span>🪪</span> Número de cédula</label>
                <input value={confirmForm.cedula}
                  onChange={e => setConfirmForm(f => f ? { ...f, cedula: e.target.value } : f)}
                  inputMode="numeric" className={FIELD} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-zinc-500 uppercase tracking-widest font-semibold mb-1.5 flex items-center gap-1.5"><span>👤</span> Nombres</label>
                  <input value={confirmForm.nombres}
                    onChange={e => setConfirmForm(f => f ? { ...f, nombres: e.target.value } : f)}
                    className={FIELD} />
                </div>
                <div>
                  <label className="text-[10px] text-zinc-500 uppercase tracking-widest font-semibold mb-1.5 flex items-center gap-1.5"><span>👥</span> Apellidos</label>
                  <input value={confirmForm.apellidos}
                    onChange={e => setConfirmForm(f => f ? { ...f, apellidos: e.target.value } : f)}
                    className={FIELD} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-zinc-500 uppercase tracking-widest font-semibold mb-1.5 flex items-center gap-1.5"><span>📅</span> Nacimiento</label>
                  <input type="date" value={confirmForm.fechaNacimiento}
                    onChange={e => setConfirmForm(f => f ? { ...f, fechaNacimiento: e.target.value } : f)}
                    className={`${FIELD} [color-scheme:dark]`} />
                </div>
                <div>
                  <label className="text-[10px] text-zinc-500 uppercase tracking-widest font-semibold mb-1.5">Edad</label>
                  <div className={`${FIELD} flex items-center`}>
                    {confirmForm.fechaNacimiento ? (
                      <><span className="text-2xl font-bold text-white">{calcEdad(confirmForm.fechaNacimiento)}</span><span className="text-zinc-400 ml-1 text-xs">años</span></>
                    ) : <span className="text-zinc-600">—</span>}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-zinc-500 uppercase tracking-widest font-semibold mb-1.5 flex items-center gap-1.5"><span>⚧</span> Sexo</label>
                  <select value={confirmForm.sexo}
                    onChange={e => setConfirmForm(f => f ? { ...f, sexo: e.target.value as 'M' | 'F' | '' } : f)}
                    className={`${FIELD} [color-scheme:dark]`}>
                    <option value="">—</option>
                    <option value="M">Masculino</option>
                    <option value="F">Femenino</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-zinc-500 uppercase tracking-widest font-semibold mb-1.5 flex items-center gap-1.5"><span>🩸</span> RH</label>
                  <input value={confirmForm.rh}
                    onChange={e => setConfirmForm(f => f ? { ...f, rh: e.target.value } : f)}
                    placeholder="O+" className={FIELD} />
                </div>
              </div>

              {confirmError && (
                <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">{confirmError}</p>
              )}

              <div className="flex gap-3 pt-1 pb-2">
                <button onClick={() => { setConfirmForm(null); setConfirmError('') }}
                  className="flex-1 py-3.5 rounded-xl border border-[#27272a] text-zinc-400 text-sm hover:bg-white/5 transition font-medium">
                  Cancelar
                </button>
                <button onClick={handleConfirm} disabled={confirmSaving}
                  className="flex-1 py-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold disabled:opacity-60 transition flex items-center justify-center gap-2 shadow-lg shadow-emerald-900/40">
                  {confirmSaving
                    ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Guardando…</>
                    : '✅ Confirmar'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Manual modal ──────────────────────────────────────────────────── */}
      {showManual && (
        <div className="absolute inset-0 z-40 flex items-end sm:items-center justify-center">
          <div className="absolute inset-0 bg-black/75" onClick={() => { setShowManual(false); setManualError('') }} />
          <div className="relative w-full max-w-md bg-[#111113] border border-[#27272a] rounded-t-3xl sm:rounded-2xl p-6 max-h-[90dvh] overflow-y-auto"
            style={{ animation: 'fadeIn 0.2s ease' }}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-semibold text-white text-base">✏️ Registrar manualmente</h2>
              <button onClick={() => { setShowManual(false); setManualError('') }}
                className="w-8 h-8 rounded-lg bg-white/10 text-zinc-400 hover:text-white flex items-center justify-center transition">✕</button>
            </div>
            <form onSubmit={handleManual} className="space-y-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">🪪 Número de cédula *</label>
                <input required inputMode="numeric" value={manualForm.cedula}
                  onChange={e => setManualForm(f => ({ ...f, cedula: e.target.value }))}
                  placeholder="1234567890" className={FIELD} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">👤 Nombres *</label>
                  <input required value={manualForm.nombres}
                    onChange={e => setManualForm(f => ({ ...f, nombres: e.target.value }))}
                    placeholder="Juan" className={FIELD} />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">👥 Apellidos *</label>
                  <input required value={manualForm.apellidos}
                    onChange={e => setManualForm(f => ({ ...f, apellidos: e.target.value }))}
                    placeholder="García" className={FIELD} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">📅 Nacimiento *</label>
                  <input required type="date" value={manualForm.fechaNacimiento}
                    onChange={e => setManualForm(f => ({ ...f, fechaNacimiento: e.target.value }))}
                    className={`${FIELD} [color-scheme:dark]`} />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">⚧ Sexo *</label>
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
                <p className="text-zinc-500 text-xs">Edad: <span className="text-white font-semibold">{calcEdad(manualForm.fechaNacimiento)} años</span></p>
              )}
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">🩸 RH (opcional)</label>
                <input value={manualForm.rh} onChange={e => setManualForm(f => ({ ...f, rh: e.target.value }))}
                  placeholder="O+" className={FIELD} />
              </div>
              {manualError && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">{manualError}</p>}
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => { setShowManual(false); setManualError('') }}
                  className="flex-1 py-3 rounded-xl border border-[#27272a] text-zinc-400 text-sm hover:bg-white/5 transition">Cancelar</button>
                <button type="submit" disabled={manualSaving}
                  className="flex-1 py-3 rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-500 disabled:opacity-60 transition flex items-center justify-center gap-2">
                  {manualSaving ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Guardando…</> : 'Registrar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
