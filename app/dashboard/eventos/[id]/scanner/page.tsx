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

function calcEdad(fn: string): number {
  if (!fn) return 0
  const [y, m, d] = fn.split('-').map(Number)
  const hoy = new Date()
  let e = hoy.getFullYear() - y
  if (hoy.getMonth() + 1 < m || (hoy.getMonth() + 1 === m && hoy.getDate() < d)) e--
  return Math.max(0, e)
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

// ─── PDF417 parsers ───────────────────────────────────────────────────────────

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

// ─── MRZ parser ───────────────────────────────────────────────────────────────

function cleanMrzName(s: string): string {
  return capitalize(s.replace(/<+/g, ' ').replace(/[^A-Za-z\s]/g, '').trim())
}

function correctMrzOcr(text: string): string {
  // Fix Colombian country code OCR error: "C0L" (zero) → "COL" (letter O)
  const fixed = text.replace(/C0L/g, 'COL')
  return fixed.split('\n').map(line => {
    const t = line.trim()
    // Only apply O→0 / I→1 to lines that look like purely numeric MRZ data.
    // Lines with 4+ consecutive letters are name lines — don't corrupt them.
    if (
      t.length >= 20 &&
      /[0-9<]{8,}/.test(t) &&
      !/ {2,}/.test(t) &&
      !/[A-Z]{4,}/.test(t.replace(/COL/g, ''))
    ) return t.replace(/O/g, '0').replace(/I/g, '1')
    return line
  }).join('\n')
}

function parseMrzLines(_l1: string, l2: string, l3: string): Cedula | null {
  // Fix C0L → COL before anything else (Tesseract reads zero instead of letter O)
  const l2up = l2.toUpperCase().replace(/C0L/g, 'COL')
  const colIdx = l2up.indexOf('COL')
  if (colIdx < 0) return null

  // Apply O→0 / I→1 ONLY to the numeric sections, never to "COL" itself
  const numBefore = l2up.slice(0, colIdx).replace(/O/g, '0').replace(/I/g, '1')
  const numAfter  = l2up.slice(colIdx + 3).replace(/O/g, '0').replace(/I/g, '1')

  // Birth date: first 6 chars of l2 (YYMMDD)
  const yy = parseInt(numBefore.slice(0, 2))
  const mm = parseInt(numBefore.slice(2, 4))
  const dd = parseInt(numBefore.slice(4, 6))
  // Sex: position 7 (after 6-digit date + 1 check digit)
  const sc   = numBefore[7]
  const sexo: 'M' | 'F' | undefined = sc === 'M' ? 'M' : sc === 'F' ? 'F' : undefined

  // Cedula: leading digits right after COL
  const cedula = numAfter.match(/^(\d{5,12})/)?.[1] ?? ''
  if (cedula.length < 5) return null

  let fechaNacimiento: string | undefined, edad: number | undefined
  if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
    const fullYear = yy > 30 ? 1900 + yy : 2000 + yy
    fechaNacimiento = `${fullYear}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
    edad = calcEdad(fechaNacimiento)
  }

  // Names from l3: split on '<<', replace remaining '<' with spaces
  const nameRaw   = l3.toUpperCase().replace(/<+$/, '')
  const dblIdx    = nameRaw.indexOf('<<')
  const apellidos = dblIdx >= 0 ? cleanMrzName(nameRaw.slice(0, dblIdx)) : cleanMrzName(nameRaw)
  const nombres   = dblIdx >= 0 ? cleanMrzName(nameRaw.slice(dblIdx + 2)) : ''
  return { cedula, nombres, apellidos, sexo, fechaNacimiento, edad, modo: 'MRZ' }
}

function parseMrzText(raw: string): Cedula | null {
  // Fix C0L → COL before anything, then standard OCR corrections
  const corrected = correctMrzOcr(raw.replace(/C0L/g, 'COL'))
  const upper = corrected.toUpperCase()

  // Try newline split first; if that yields fewer lines than space split, use space split.
  // Tesseract sometimes outputs all MRZ lines on one "line" separated by a space.
  const byNL    = upper.split(/[\n\r]+/).map(l => l.trim().replace(/[^A-Z0-9<]/g, '')).filter(l => l.length >= 10)
  const bySpace = upper.split(/[\n\r ]+/).map(l => l.trim().replace(/[^A-Z0-9<]/g, '')).filter(l => l.length >= 10)
  const lines   = bySpace.length > byNL.length ? bySpace : byNL
  if (lines.length === 0) return null

  for (const pfx of ['ICCOL', 'IDCOL', 'IC<COL', 'ID<COL']) {
    const i = lines.findIndex(l => l.startsWith(pfx))
    if (i >= 0 && i + 2 < lines.length) {
      const r = parseMrzLines(lines[i], lines[i + 1].padEnd(30, '<'), lines[i + 2])
      if (r) return r
    }
  }

  // Numeric data line: YYMMDD + check digit + sex (M/F/0) — allow it to be the first line (>= 0)
  const l2i = lines.findIndex(l => /^\d{7}[MF0]/.test(l))
  if (l2i >= 0 && l2i + 1 < lines.length) {
    const r = parseMrzLines(l2i > 0 ? lines[l2i - 1] : '', lines[l2i].padEnd(30, '<'), lines[l2i + 1])
    if (r) return r
  }

  // Name line (contains '<<') — needs at least one preceding line for the data line
  const l3i = lines.findIndex(l => l.includes('<<'))
  if (l3i >= 1) {
    const r = parseMrzLines(l3i >= 2 ? lines[l3i - 2] : '', lines[l3i - 1].padEnd(30, '<'), lines[l3i])
    if (r) return r
  }
  return null
}

function parseMrzRegex(text: string): Cedula | null {
  // Fix C0L → COL before everything
  const fixed = text.replace(/C0L/g, 'COL')
  const up = fixed.toUpperCase().replace(/[^A-Z0-9<\n\r ]/g, ' ')

  // Cedula: digits after COL (regex /COL(\d{5,12})/)
  const m1 = up.match(/COL(\d{5,12})/)
  if (!m1) return null
  const cedula = m1[1]

  // Split by newline or space to find individual segments
  const lines = up.split(/[\n\r ]+/).filter(l => l.length >= 10)

  // Birth date (first 6 chars) and sex (pos 7) from the line that contains COL
  let fechaNacimiento: string | undefined, edad: number | undefined
  let sexo: 'M' | 'F' | undefined
  for (const line of lines) {
    if (!line.includes('COL')) continue
    const num = line.slice(0, 8).replace(/O/g, '0').replace(/I/g, '1')
    const yy = parseInt(num.slice(0, 2))
    const mm = parseInt(num.slice(2, 4))
    const dd = parseInt(num.slice(4, 6))
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      const fy = yy > 30 ? 1900 + yy : 2000 + yy
      fechaNacimiento = `${fy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
      edad = calcEdad(fechaNacimiento)
    }
    const sc = num[7]
    sexo = sc === 'M' ? 'M' : sc === 'F' ? 'F' : undefined
    break
  }

  // Names from the line with '<<': split by '<<', clean '<' → space
  let apellidos = '', nombres = ''
  for (const line of lines) {
    const di = line.indexOf('<<')
    if (di < 0) continue
    apellidos = cleanMrzName(line.slice(0, di))
    nombres   = cleanMrzName(line.slice(di + 2))
    break
  }
  // Fallback: regex match anywhere in combined text
  if (!apellidos) {
    const m3 = up.match(/([A-Z]{2}[A-Z<]+)<<([A-Z<]*)/)
    if (m3) { apellidos = cleanMrzName(m3[1]); nombres = cleanMrzName(m3[2]) }
  }

  return { cedula, apellidos, nombres, sexo, fechaNacimiento, edad, modo: 'MRZ' }
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

// ─── Component ────────────────────────────────────────────────────────────────

const FIELD = 'w-full bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500 transition'

export default function ScannerPage() {
  const { id: eventoId } = useParams<{ id: string }>()
  const router = useRouter()

  const videoRef  = useRef<HTMLVideoElement>(null)
  const inputRef  = useRef<HTMLInputElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workerRef  = useRef<any>(null)
  const workerReady = useRef(false)
  const toastTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [cameraOn,    setCameraOn]    = useState(false)
  const [flashAvail,  setFlashAvail]  = useState(false)
  const [flashOn,     setFlashOn]     = useState(false)
  const [processing,  setProcessing]  = useState(false)
  const [scanState,   setScanState]   = useState<'idle' | 'ok' | 'fail'>('idle')
  const [tooDark,     setTooDark]     = useState(false)
  const [ocrFails,    setOcrFails]    = useState(0)
  const [tReady,      setTReady]      = useState(false)

  const [toast,         setToast]         = useState<{ color: string; msg: string } | null>(null)
  const [confirmForm,   setConfirmForm]   = useState<ConfirmForm | null>(null)
  const [confirmSaving, setConfirmSaving] = useState(false)
  const [confirmError,  setConfirmError]  = useState('')
  const [total,         setTotal]         = useState(0)
  const [evento,        setEvento]        = useState<Evento | null>(null)
  const [showManual,    setShowManual]    = useState(false)
  const [manualForm,    setManualForm]    = useState({ cedula: '', nombres: '', apellidos: '', fechaNacimiento: '', sexo: '' as 'M'|'F'|'', rh: '' })
  const [manualSaving,  setManualSaving]  = useState(false)
  const [manualError,   setManualError]   = useState('')
  const [log,           setLog]           = useState<string[]>([])

  const addLog = useCallback((m: string) => { console.log(m); setLog(p => [...p.slice(-7), m]) }, [])

  // ── Camera preview ─────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: { ideal: 'environment' } } })
      .then(stream => {
        if (!alive) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream
        if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play().catch(() => {}) }
        const track = stream.getVideoTracks()[0]
        const caps = track.getCapabilities?.() as Record<string, unknown> | undefined
        if (caps && 'torch' in caps) setFlashAvail(true)
        setCameraOn(true)
      })
      .catch(() => {/* preview not available — still works via file input */})
    return () => { alive = false; streamRef.current?.getTracks().forEach(t => t.stop()) }
  }, [])

  // ── Light check ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!cameraOn) return
    const cv = document.createElement('canvas'); cv.width = 50; cv.height = 50
    const cx = cv.getContext('2d')!
    const id = setInterval(() => {
      const v = videoRef.current
      if (!v || v.readyState < 2) return
      cx.drawImage(v, 0, 0, 50, 50)
      const d = cx.getImageData(0, 0, 50, 50).data
      let s = 0
      for (let i = 0; i < d.length; i += 4) s += d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114
      setTooDark(s / 2500 < 35)
    }, 1800)
    return () => clearInterval(id)
  }, [cameraOn])

  // ── Tesseract ──────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const { createWorker, PSM } = await import('tesseract.js')
        const w = await createWorker('eng', 1, { logger: () => {} })
        await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<' })
        if (!alive) { await w.terminate(); return }
        workerRef.current = w; workerReady.current = true; setTReady(true)
      } catch { /* unavailable */ }
    })()
    return () => { alive = false; workerRef.current?.terminate?.(); if (toastTimer.current) clearTimeout(toastTimer.current) }
  }, [])

  // ── Firebase ───────────────────────────────────────────────────────────────
  useEffect(() => { if (!eventoId) return; return onSnapshot(collection(db, 'eventos', eventoId, 'asistencias'), s => setTotal(s.size)) }, [eventoId])
  useEffect(() => { if (!eventoId) return; getDoc(doc(db, 'eventos', eventoId)).then(s => { if (s.exists()) setEvento({ id: s.id, ...s.data() } as Evento) }) }, [eventoId])

  // ── Toast ──────────────────────────────────────────────────────────────────
  const showToast = useCallback((color: string, msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ color, msg })
    toastTimer.current = setTimeout(() => setToast(null), 3200)
  }, [])

  // ── Flash ──────────────────────────────────────────────────────────────────
  const toggleFlash = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    try { const n = !flashOn; await track.applyConstraints({ advanced: [{ torch: n } as MediaTrackConstraintSet] }); setFlashOn(n) } catch { /* unsupported */ }
  }, [flashOn])

  // ── Process image ──────────────────────────────────────────────────────────
  const processImage = useCallback(async (file: File) => {
    setProcessing(true); setScanState('idle'); setLog([])
    try {
      const url = URL.createObjectURL(file)
      const img = new Image(); img.src = url
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('img')) })
      URL.revokeObjectURL(url)

      const MAX = 2000, scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight))
      const cW = Math.round(img.naturalWidth * scale), cH = Math.round(img.naturalHeight * scale)
      const canvas = document.createElement('canvas'); canvas.width = cW; canvas.height = cH
      canvas.getContext('2d')!.drawImage(img, 0, 0, cW, cH)
      const base64 = canvas.toDataURL('image/jpeg', 0.92).split(',')[1]
      addLog(`foto ${img.naturalWidth}×${img.naturalHeight} → ${cW}×${cH}`)

      let detected: Cedula | null = null
      let rawText: string | undefined

      // ── API ──────────────────────────────────────────────────────────────
      try {
        const res = await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageBase64: base64 }) })
        const data = await res.json() as { success: boolean; text?: string; parsed?: { cedula: string; apellido1: string; apellido2: string; nombre1: string; nombre2: string; sexo: string; anioNac: string; mesNac: string; diaNac: string; rh: string }; error?: string; logs?: string[] }
        for (const l of data.logs ?? []) addLog(l)
        if (data.success && data.text) {
          rawText = data.text
          if (data.parsed?.cedula) {
            const p = data.parsed
            detected = {
              cedula:    p.cedula,
              nombres:   cleanName([p.nombre1, p.nombre2].filter(Boolean).join(' ')),
              apellidos: cleanName([p.apellido1, p.apellido2].filter(Boolean).join(' ')),
              sexo:      p.sexo === 'M' || p.sexo === 'F' ? p.sexo as 'M'|'F' : undefined,
              rh:        p.rh || undefined,
              modo:      'PDF417',
              ...buildFecha(p.anioNac, p.mesNac, p.diaNac) ?? {},
            }
            addLog(`✓ PDF417 srv: ${p.cedula} ${p.apellido1}`)
          } else {
            addLog(`txt: ${data.text.replace(/\x00/g, '□').slice(0, 80)}`)
            addLog(debugPdf417Positions(data.text))
            const r1 = parsePdf417Binario(data.text)
            const r2 = r1 ? null : parsePdf417NullSplit(data.text)
            const r3 = (r1||r2) ? null : parsePdf417Legacy(data.text)
            detected = r1 ?? r2 ?? r3 ?? parseMrzText(data.text) ?? parseMrzRegex(data.text)
            addLog(`parse: bin=${r1?'✓':'✗'} null=${r2?'✓':'✗'} leg=${r3?'✓':'✗'} → ${detected?detected.cedula:'nada'}`)
          }
        } else { addLog(`api fail: ${data.error ?? ''}`) }
      } catch (e) { addLog(`api err: ${String(e).slice(0, 60)}`) }

      // ── Tesseract fallback ────────────────────────────────────────────────
      if (!detected && workerReady.current && workerRef.current) {
        try {
          const sy = Math.floor(cH * 0.5), sh = Math.floor(cH * 0.5)
          const ct = document.createElement('canvas'); ct.width = cW; ct.height = sh
          const cx = ct.getContext('2d')!
          cx.filter = 'contrast(2.5) brightness(1.3) grayscale(1)'
          cx.drawImage(canvas, 0, sy, cW, sh, 0, 0, cW, sh)
          cx.filter = 'none'
          const { data: { text } } = await workerRef.current.recognize(ct)
          addLog(`ocr: ${text.trim().slice(0, 60)}`)
          detected = parseMrzText(text) ?? parseMrzRegex(text)
          if (detected) { addLog(`✓ OCR: ${detected.cedula}`); setOcrFails(0) }
          else {
            const nf = ocrFails + 1; setOcrFails(nf)
            addLog(`ocr fail ${nf}/2`)
            if (nf >= 2) {
              setOcrFails(0); setScanState('fail'); setProcessing(false)
              setConfirmForm({ cedula: text.match(/\d{6,12}/)?.[0] ?? '', nombres: '', apellidos: '', sexo: '', fechaNacimiento: '', rh: '', modo: 'MRZ', rawText: text.trim().slice(0, 300) })
              return
            }
          }
        } catch (e) { addLog(`ocr err: ${String(e).slice(0, 50)}`) }
      }

      // ── Result ────────────────────────────────────────────────────────────
      if (!detected || detected.cedula.length < 5) {
        setScanState('fail')
        if (rawText) {
          setConfirmForm({ cedula: rawText.match(/\d{6,12}/)?.[0] ?? '', nombres: '', apellidos: '', sexo: '', fechaNacimiento: '', rh: '', modo: 'PDF417', rawText: rawText.replace(/\x00/g, '').slice(0, 200) })
        } else {
          showToast('#ef4444', '❌ No se detectó. Intenta de nuevo')
        }
        setProcessing(false); return
      }

      const dup = await checkDuplicado(eventoId, detected.cedula)
      if (dup) { setScanState('fail'); showToast('#f59e0b', `⚠️ Ya registrado: ${detected.apellidos}`); setProcessing(false); return }

      setScanState('ok')
      setConfirmForm({ cedula: detected.cedula, nombres: detected.nombres, apellidos: detected.apellidos, sexo: detected.sexo ?? '', fechaNacimiento: detected.fechaNacimiento ?? '', rh: detected.rh ?? '', modo: detected.modo })
      setProcessing(false)
    } catch (e) {
      addLog(`fatal: ${String(e).slice(0, 80)}`); setScanState('fail'); showToast('#ef4444', '❌ Error procesando imagen'); setProcessing(false)
    }
  }, [eventoId, showToast, addLog, ocrFails])

  // ── File input change ──────────────────────────────────────────────────────
  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return; e.target.value = ''; await processImage(file)
  }, [processImage])

  // ── Capture button ─────────────────────────────────────────────────────────
  const handleCapture = useCallback(() => {
    if (processing) return; setScanState('idle'); inputRef.current?.click()
  }, [processing])

  // ── Confirm save ───────────────────────────────────────────────────────────
  const handleConfirm = async () => {
    if (!confirmForm) return; setConfirmSaving(true); setConfirmError('')
    try {
      const edad = confirmForm.fechaNacimiento ? calcEdad(confirmForm.fechaNacimiento) : 0
      await registrarAsistencia(eventoId, { cedula: confirmForm.cedula, nombres: confirmForm.nombres, apellidos: confirmForm.apellidos, fechaNacimiento: confirmForm.fechaNacimiento, edad, sexo: (confirmForm.sexo || undefined) as 'M'|'F'|undefined, rh: confirmForm.rh, modo: confirmForm.modo })
      showToast('#22c55e', `✅ ${confirmForm.apellidos} ${confirmForm.nombres}`)
      setConfirmForm(null); setLog([])
    } catch (e: unknown) { setConfirmError((e as { message?: string }).message ?? 'Error al guardar') }
    finally { setConfirmSaving(false) }
  }

  // ── Manual save ────────────────────────────────────────────────────────────
  const handleManual = async (e: React.FormEvent) => {
    e.preventDefault(); const { cedula, nombres, apellidos, fechaNacimiento, sexo, rh } = manualForm
    if (!cedula || !nombres || !apellidos || !fechaNacimiento || !sexo) return
    setManualSaving(true); setManualError('')
    try {
      if (await checkDuplicado(eventoId, cedula.trim())) { setManualError('Cédula ya registrada'); return }
      await registrarAsistencia(eventoId, { cedula: cedula.trim(), nombres: capitalize(nombres.trim()), apellidos: capitalize(apellidos.trim()), fechaNacimiento, edad: calcEdad(fechaNacimiento), sexo: sexo as 'M'|'F', rh: rh.trim(), modo: 'MANUAL' })
      showToast('#22c55e', `✅ ${capitalize(apellidos.trim())} ${capitalize(nombres.trim())}`)
      setShowManual(false); setManualForm({ cedula: '', nombres: '', apellidos: '', fechaNacimiento: '', sexo: '', rh: '' })
    } catch (e: unknown) { setManualError((e as { message?: string }).message ?? 'Error') }
    finally { setManualSaving(false) }
  }

  const frameColor = scanState === 'ok' ? '#4ade80' : scanState === 'fail' ? '#f87171' : '#22c55e'

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', zIndex: 50, overflow: 'hidden', display: 'flex', flexDirection: 'column', userSelect: 'none' }}>

      <style>{`
        @keyframes scan {
          0%   { transform: translateY(0px); opacity: 1; }
          90%  { opacity: 1; }
          100% { transform: translateY(280px); opacity: 0; }
        }
        @keyframes corner-pulse {
          0%   { opacity: 0.7; }
          100% { opacity: 1; }
        }
        @keyframes sweep {
          0%   { transform: translateY(-100%); }
          100% { transform: translateY(200%); }
        }
        @keyframes fadein {
          from { opacity: 0; transform: translateY(16px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes slideup {
          from { transform: translateY(100%); }
          to   { transform: translateY(0); }
        }
        .scan-line { animation: scan 2s linear infinite; }
        .corner    { animation: corner-pulse 1s ease-in-out infinite alternate; }
        .sweep     { animation: sweep 1.4s ease-in-out infinite; }
        .fadein    { animation: fadein 0.25s ease; }
        .slideup   { animation: slideup 0.28s cubic-bezier(0.32,0.72,0,1); }
      `}</style>

      {/* ── Hidden file input ──────────────────────────────────────────── */}
      <input ref={inputRef} type="file" accept="image/*" capture="environment"
        style={{ display: 'none' }} onChange={handleFileChange} />

      {/* ── Video preview ─────────────────────────────────────────────── */}
      <video ref={videoRef} autoPlay playsInline muted
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: cameraOn ? 1 : 0 }} />

      {/* ── Background when no camera ─────────────────────────────────── */}
      {!cameraOn && (
        <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at center, #0a0a0a 0%, #000 100%)' }}>
          <div style={{ position: 'absolute', inset: 0, backgroundImage: 'linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />
        </div>
      )}

      {/* ── Top bar ───────────────────────────────────────────────────── */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 20, background: 'linear-gradient(to bottom, rgba(0,0,0,0.88) 0%, transparent 100%)', padding: '44px 16px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={() => router.back()}
          style={{ width: 38, height: 38, borderRadius: '50%', background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff', fontSize: 22, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          ‹
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ color: '#fff', fontWeight: 600, fontSize: 14, margin: 0, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{evento?.nombre ?? '…'}</p>
          <p style={{ color: '#4ade80', fontWeight: 700, fontSize: 15, margin: 0 }}>{total} asistente{total !== 1 ? 's' : ''}</p>
        </div>
        <div style={{ fontSize: 10, padding: '3px 8px', borderRadius: 20, fontWeight: 700, background: tReady ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.08)', color: tReady ? '#4ade80' : '#71717a' }}>
          OCR {tReady ? '✓' : '…'}
        </div>
      </div>

      {/* ── Scanner frame ─────────────────────────────────────────────── */}
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingTop: 90, paddingBottom: 190 }}>

        {/* outer dark mask */}
        <div style={{ position: 'relative', width: '88%', maxWidth: 380, aspectRatio: '85/54' }}>
          <div style={{ position: 'absolute', inset: 0, borderRadius: 8, pointerEvents: 'none', boxShadow: '0 0 0 100vmax rgba(0,0,0,0.58)' }} />

          {/* scan line */}
          {!processing && (
            <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: 8 }}>
              <div className="scan-line" style={{ position: 'absolute', left: '6%', right: '6%', height: 2, top: 0, background: 'linear-gradient(90deg, transparent, #ef4444 25%, #ff5555 50%, #ef4444 75%, transparent)', boxShadow: '0 0 10px 3px rgba(239,68,68,0.6)' }} />
            </div>
          )}

          {/* processing overlay */}
          {processing && (
            <div style={{ position: 'absolute', inset: 0, borderRadius: 8, background: 'rgba(0,0,0,0.55)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, overflow: 'hidden' }}>
              <div className="sweep" style={{ position: 'absolute', left: 0, right: 0, height: '50%', background: 'linear-gradient(180deg, transparent, rgba(34,197,94,0.12), transparent)' }} />
              <div style={{ width: 40, height: 40, border: '3px solid rgba(34,197,94,0.25)', borderTopColor: '#22c55e', borderRadius: '50%', animation: 'spin 0.8s linear infinite', zIndex: 1 }} />
              <p style={{ color: '#4ade80', fontSize: 13, fontWeight: 600, letterSpacing: '0.03em', zIndex: 1 }}>Leyendo cédula…</p>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          )}

          {/* Corner brackets — top-left */}
          <div className="corner" style={{ position: 'absolute', top: 0, left: 0, width: 38, height: 38, borderTop: `4px solid ${frameColor}`, borderLeft: `4px solid ${frameColor}`, borderRadius: '3px 0 0 0', filter: `drop-shadow(0 0 6px ${frameColor}99)` }} />
          {/* top-right */}
          <div className="corner" style={{ position: 'absolute', top: 0, right: 0, width: 38, height: 38, borderTop: `4px solid ${frameColor}`, borderRight: `4px solid ${frameColor}`, borderRadius: '0 3px 0 0', filter: `drop-shadow(0 0 6px ${frameColor}99)`, animationDelay: '0.25s' }} />
          {/* bottom-left */}
          <div className="corner" style={{ position: 'absolute', bottom: 0, left: 0, width: 38, height: 38, borderBottom: `4px solid ${frameColor}`, borderLeft: `4px solid ${frameColor}`, borderRadius: '0 0 0 3px', filter: `drop-shadow(0 0 6px ${frameColor}99)`, animationDelay: '0.5s' }} />
          {/* bottom-right */}
          <div className="corner" style={{ position: 'absolute', bottom: 0, right: 0, width: 38, height: 38, borderBottom: `4px solid ${frameColor}`, borderRight: `4px solid ${frameColor}`, borderRadius: '0 0 3px 0', filter: `drop-shadow(0 0 6px ${frameColor}99)`, animationDelay: '0.75s' }} />
        </div>
      </div>

      {/* ── Bottom bar ────────────────────────────────────────────────── */}
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 20, background: 'linear-gradient(to top, rgba(0,0,0,0.95) 55%, transparent 100%)', paddingBottom: 'env(safe-area-inset-bottom, 24px)', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>

        {/* low-light warning */}
        {tooDark && <p style={{ color: '#fbbf24', fontSize: 11, fontWeight: 600, marginBottom: 4, animation: 'fadein 0.3s ease' }}>💡 Necesitas más luz</p>}

        {/* hint text */}
        <p style={{ color: '#a1a1aa', fontSize: 12, textAlign: 'center', margin: '0 0 6px', padding: '0 24px' }}>
          {cameraOn ? 'Encuadra el reverso de la cédula dentro del marco' : 'Toca Capturar para fotografiar el reverso de la cédula'}
        </p>
        <p style={{ color: '#52525b', fontSize: 10, margin: '0 0 18px' }}>Mantén la cédula horizontal y bien iluminada</p>

        {/* buttons row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '0 40px', marginBottom: 28 }}>

          {/* Flash */}
          {flashAvail ? (
            <button onClick={toggleFlash} disabled={processing}
              style={{ width: 54, height: 54, borderRadius: '50%', border: 'none', cursor: 'pointer', fontSize: 22, background: flashOn ? '#facc15' : 'rgba(255,255,255,0.1)', color: flashOn ? '#000' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.2s' }}>
              ⚡
            </button>
          ) : <div style={{ width: 54, height: 54 }} />}

          {/* Capture */}
          <button onClick={handleCapture} disabled={processing}
            style={{ width: 78, height: 78, borderRadius: '50%', border: '4px solid rgba(74,222,128,0.45)', background: processing ? '#16a34a' : '#22c55e', cursor: processing ? 'default' : 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, boxShadow: '0 0 24px rgba(34,197,94,0.4)', transition: 'all 0.15s', opacity: processing ? 0.7 : 1 }}>
            {processing
              ? <div style={{ width: 28, height: 28, border: '3px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
              : <>
                  <span style={{ fontSize: 26, lineHeight: 1 }}>📸</span>
                  <span style={{ color: '#fff', fontSize: 9, fontWeight: 700, letterSpacing: '0.05em' }}>CAPTURAR</span>
                </>}
          </button>

          {/* Manual */}
          <button onClick={() => setShowManual(true)} disabled={!!confirmForm}
            style={{ width: 54, height: 54, borderRadius: '50%', border: 'none', background: 'rgba(255,255,255,0.1)', color: '#fff', fontSize: 22, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: confirmForm ? 0.4 : 1 }}>
            ✏️
          </button>
        </div>

        {/* debug log */}
        {log.length > 0 && (
          <div style={{ width: '100%', padding: '0 12px 8px', maxHeight: 64, overflowY: 'auto' }}>
            {log.map((l, i) => <p key={i} style={{ color: 'rgba(253,224,71,0.65)', fontSize: 8, fontFamily: 'monospace', margin: '1px 0', wordBreak: 'break-all' }}>{l}</p>)}
          </div>
        )}
      </div>

      {/* ── Toast ─────────────────────────────────────────────────────── */}
      {toast && (
        <div className="fadein" style={{ position: 'absolute', left: 16, right: 16, top: 100, zIndex: 60 }}>
          <div style={{ background: toast.color, borderRadius: 16, padding: '14px 20px', textAlign: 'center', color: '#fff', fontWeight: 600, fontSize: 14, boxShadow: `0 8px 32px ${toast.color}55` }}>
            {toast.msg}
          </div>
        </div>
      )}

      {/* ── Confirm modal ─────────────────────────────────────────────── */}
      {confirmForm && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 50, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.78)' }} onClick={() => { setConfirmForm(null); setConfirmError('') }} />
          <div className="slideup" style={{ position: 'relative', width: '100%', maxWidth: 480, background: '#111', borderRadius: '24px 24px 0 0', maxHeight: '92dvh', overflowY: 'auto', borderTop: '1px solid #27272a' }}>

            {/* drag handle */}
            <div style={{ width: 36, height: 4, background: '#3f3f46', borderRadius: 2, margin: '12px auto 0' }} />

            {/* header */}
            <div style={{ padding: '16px 20px 12px', background: confirmForm.rawText ? 'rgba(245,158,11,0.08)' : 'rgba(34,197,94,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 40, height: 40, borderRadius: '50%', background: confirmForm.rawText ? 'rgba(245,158,11,0.15)' : 'rgba(34,197,94,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>
                  {confirmForm.rawText ? '⚠️' : '🪪'}
                </div>
                <div>
                  <p style={{ color: '#fff', fontWeight: 600, fontSize: 15, margin: 0 }}>{confirmForm.rawText ? 'Completar datos' : 'Cédula detectada'}</p>
                  <p style={{ color: '#71717a', fontSize: 11, margin: 0 }}>Verifica antes de registrar</p>
                </div>
              </div>
              <span style={{ fontSize: 10, padding: '3px 9px', borderRadius: 20, fontWeight: 700, background: confirmForm.modo === 'PDF417' ? 'rgba(59,130,246,0.15)' : 'rgba(168,85,247,0.15)', color: confirmForm.modo === 'PDF417' ? '#93c5fd' : '#d8b4fe' }}>
                {confirmForm.modo}
              </span>
            </div>

            <div style={{ padding: '16px 20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>

              {/* raw text */}
              {confirmForm.rawText && (
                <div>
                  <p style={{ color: '#71717a', fontSize: 10, margin: '0 0 6px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Texto detectado</p>
                  <div style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 10, padding: '8px 10px', color: 'rgba(253,191,74,0.8)', fontSize: 9, fontFamily: 'monospace', wordBreak: 'break-all', maxHeight: 72, overflowY: 'auto' }}>
                    {confirmForm.rawText}
                  </div>
                </div>
              )}

              {/* cedula */}
              <div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#71717a', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}><span>🪪</span> Número de cédula</label>
                <input value={confirmForm.cedula} onChange={e => setConfirmForm(f => f ? { ...f, cedula: e.target.value } : f)} inputMode="numeric" className={FIELD} />
              </div>

              {/* nombres / apellidos */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#71717a', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}><span>👤</span> Nombres</label>
                  <input value={confirmForm.nombres} onChange={e => setConfirmForm(f => f ? { ...f, nombres: e.target.value } : f)} className={FIELD} />
                </div>
                <div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#71717a', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}><span>👥</span> Apellidos</label>
                  <input value={confirmForm.apellidos} onChange={e => setConfirmForm(f => f ? { ...f, apellidos: e.target.value } : f)} className={FIELD} />
                </div>
              </div>

              {/* fecha / edad */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#71717a', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}><span>📅</span> Nacimiento</label>
                  <input type="date" value={confirmForm.fechaNacimiento} onChange={e => setConfirmForm(f => f ? { ...f, fechaNacimiento: e.target.value } : f)} style={{ colorScheme: 'dark' }} className={FIELD} />
                </div>
                <div>
                  <label style={{ color: '#71717a', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 6 }}>Edad</label>
                  <div className={FIELD} style={{ display: 'flex', alignItems: 'center' }}>
                    {confirmForm.fechaNacimiento
                      ? <><span style={{ fontSize: 24, fontWeight: 700, color: '#fff' }}>{calcEdad(confirmForm.fechaNacimiento)}</span><span style={{ color: '#71717a', fontSize: 12, marginLeft: 4 }}>años</span></>
                      : <span style={{ color: '#3f3f46' }}>—</span>}
                  </div>
                </div>
              </div>

              {/* sexo / rh */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#71717a', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}><span>⚧</span> Sexo</label>
                  <select value={confirmForm.sexo} onChange={e => setConfirmForm(f => f ? { ...f, sexo: e.target.value as 'M'|'F'|'' } : f)} style={{ colorScheme: 'dark' }} className={FIELD}>
                    <option value="">—</option><option value="M">Masculino</option><option value="F">Femenino</option>
                  </select>
                </div>
                <div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#71717a', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}><span>🩸</span> RH</label>
                  <input value={confirmForm.rh} onChange={e => setConfirmForm(f => f ? { ...f, rh: e.target.value } : f)} placeholder="O+" className={FIELD} />
                </div>
              </div>

              {confirmError && <p style={{ color: '#f87171', fontSize: 12, background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 10, padding: '8px 12px', margin: 0 }}>{confirmError}</p>}

              <div style={{ display: 'flex', gap: 10, paddingTop: 4 }}>
                <button onClick={() => { setConfirmForm(null); setConfirmError('') }}
                  style={{ flex: 1, padding: '14px 0', borderRadius: 14, border: '1px solid #27272a', background: 'transparent', color: '#71717a', fontSize: 14, cursor: 'pointer', fontWeight: 500 }}>
                  Cancelar
                </button>
                <button onClick={handleConfirm} disabled={confirmSaving}
                  style={{ flex: 2, padding: '14px 0', borderRadius: 14, border: 'none', background: confirmSaving ? '#15803d' : '#16a34a', color: '#fff', fontSize: 14, fontWeight: 700, cursor: confirmSaving ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, boxShadow: '0 4px 16px rgba(22,163,74,0.35)', opacity: confirmSaving ? 0.7 : 1 }}>
                  {confirmSaving ? <><div style={{ width: 16, height: 16, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} /> Guardando…</> : '✅ Confirmar registro'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Manual modal ──────────────────────────────────────────────── */}
      {showManual && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 50, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.75)' }} onClick={() => { setShowManual(false); setManualError('') }} />
          <div className="slideup" style={{ position: 'relative', width: '100%', maxWidth: 480, background: '#111', borderRadius: '24px 24px 0 0', borderTop: '1px solid #27272a', maxHeight: '90dvh', overflowY: 'auto' }}>
            <div style={{ width: 36, height: 4, background: '#3f3f46', borderRadius: 2, margin: '12px auto 0' }} />
            <div style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h2 style={{ color: '#fff', fontSize: 16, fontWeight: 600, margin: 0 }}>✏️ Registrar manualmente</h2>
              <button onClick={() => { setShowManual(false); setManualError('') }}
                style={{ width: 30, height: 30, borderRadius: 8, border: 'none', background: 'rgba(255,255,255,0.08)', color: '#71717a', cursor: 'pointer', fontSize: 14 }}>✕</button>
            </div>
            <form onSubmit={handleManual} style={{ padding: '0 20px 28px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ display: 'block', color: '#71717a', fontSize: 11, marginBottom: 6 }}>🪪 Número de cédula *</label>
                <input required inputMode="numeric" value={manualForm.cedula} onChange={e => setManualForm(f => ({ ...f, cedula: e.target.value }))} placeholder="1234567890" className={FIELD} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={{ display: 'block', color: '#71717a', fontSize: 11, marginBottom: 6 }}>👤 Nombres *</label>
                  <input required value={manualForm.nombres} onChange={e => setManualForm(f => ({ ...f, nombres: e.target.value }))} placeholder="Juan" className={FIELD} />
                </div>
                <div>
                  <label style={{ display: 'block', color: '#71717a', fontSize: 11, marginBottom: 6 }}>👥 Apellidos *</label>
                  <input required value={manualForm.apellidos} onChange={e => setManualForm(f => ({ ...f, apellidos: e.target.value }))} placeholder="García" className={FIELD} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={{ display: 'block', color: '#71717a', fontSize: 11, marginBottom: 6 }}>📅 Nacimiento *</label>
                  <input required type="date" value={manualForm.fechaNacimiento} onChange={e => setManualForm(f => ({ ...f, fechaNacimiento: e.target.value }))} style={{ colorScheme: 'dark' }} className={FIELD} />
                </div>
                <div>
                  <label style={{ display: 'block', color: '#71717a', fontSize: 11, marginBottom: 6 }}>⚧ Sexo *</label>
                  <select required value={manualForm.sexo} onChange={e => setManualForm(f => ({ ...f, sexo: e.target.value as 'M'|'F'|'' }))} style={{ colorScheme: 'dark' }} className={FIELD}>
                    <option value="">—</option><option value="M">Masculino</option><option value="F">Femenino</option>
                  </select>
                </div>
              </div>
              {manualForm.fechaNacimiento && <p style={{ color: '#52525b', fontSize: 11, margin: 0 }}>Edad: <strong style={{ color: '#fff' }}>{calcEdad(manualForm.fechaNacimiento)} años</strong></p>}
              <div>
                <label style={{ display: 'block', color: '#71717a', fontSize: 11, marginBottom: 6 }}>🩸 RH (opcional)</label>
                <input value={manualForm.rh} onChange={e => setManualForm(f => ({ ...f, rh: e.target.value }))} placeholder="O+" className={FIELD} />
              </div>
              {manualError && <p style={{ color: '#f87171', fontSize: 12, background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 10, padding: '8px 12px', margin: 0 }}>{manualError}</p>}
              <div style={{ display: 'flex', gap: 10, paddingTop: 4 }}>
                <button type="button" onClick={() => { setShowManual(false); setManualError('') }}
                  style={{ flex: 1, padding: '13px 0', borderRadius: 14, border: '1px solid #27272a', background: 'transparent', color: '#71717a', fontSize: 13, cursor: 'pointer' }}>Cancelar</button>
                <button type="submit" disabled={manualSaving}
                  style={{ flex: 2, padding: '13px 0', borderRadius: 14, border: 'none', background: '#16a34a', color: '#fff', fontSize: 13, fontWeight: 700, cursor: manualSaving ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: manualSaving ? 0.7 : 1 }}>
                  {manualSaving ? <><div style={{ width: 14, height: 14, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />Guardando…</> : 'Registrar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
