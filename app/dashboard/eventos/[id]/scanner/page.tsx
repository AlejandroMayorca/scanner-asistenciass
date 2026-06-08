'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { BrowserMultiFormatReader } from '@zxing/browser'
import { BarcodeFormat, DecodeHintType } from '@zxing/library'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '../../../../lib/firebase'
import { registrarAsistencia, checkDuplicado, getTotalAsistencias } from '../../../../lib/firestore'
import type { Evento } from '../../../../lib/types'

// ── Utilities ─────────────────────────────────────────────────────────────────

function capitalize(s: string): string {
  if (!s) return ''
  return s.toLowerCase().replace(/\b[a-záéíóúñ]/gi, c => c.toUpperCase())
}

function cleanMrzName(s: string): string {
  return capitalize(s.replace(/[^A-Za-z\s]/g, '').trim())
}

function calcEdad(fechaNacimiento: string): number {
  const [y, m, d] = fechaNacimiento.split('-').map(Number)
  const hoy = new Date()
  let edad = hoy.getFullYear() - y
  if (hoy.getMonth() + 1 < m || (hoy.getMonth() + 1 === m && hoy.getDate() < d)) edad--
  return Math.max(0, edad)
}

// ── Cedula result ─────────────────────────────────────────────────────────────

interface Cedula {
  cedula: string
  nombres: string
  apellidos: string
  sexo?: 'M' | 'F'
  fechaNacimiento?: string // YYYY-MM-DD
  edad?: number
  rh?: string
  modo: 'PDF417' | 'MRZ'
}

// ── PDF417 parser ─────────────────────────────────────────────────────────────
// Cédula vieja — reverso — campos separados por \x1E (ASCII 30)
// [0]=apellidos  [1]=nombres  [2]=sexo  [3]=cedula  [4]=rh  [5]=fechaNac(YYYYMMDD)

const RS = '\x1e'

function parseFechaPdf(raw: string): { fechaNacimiento: string; edad: number } | null {
  // Accepts YYYYMMDD or YYYY-MM-DD or YYYY/MM/DD
  const m = raw.replace(/\D/g, '')
  if (m.length !== 8) return null
  const y = m.slice(0, 4), mo = m.slice(4, 6), d = m.slice(6, 8)
  const y4 = parseInt(y)
  if (y4 < 1900 || y4 > new Date().getFullYear()) return null
  const fechaNacimiento = `${y}-${mo}-${d}`
  return { fechaNacimiento, edad: calcEdad(fechaNacimiento) }
}

function cleanNamePdf(s: string): string {
  return capitalize(s.replace(/[^A-Za-zÁÉÍÓÚáéíóúÑñ\s]/g, '').trim())
}

function parsePdf417(raw: string): Cedula | null {
  if (!raw || raw.length < 5) return null

  // ── Primary: \x1E separator ──────────────────────────────────────────────
  if (raw.includes(RS)) {
    const f = raw.split(RS).map(s => s.trim())
    if (f.length >= 4) {
      const apellidos = cleanNamePdf(f[0])
      const nombres   = cleanNamePdf(f[1])
      const sexo      = /^[MF]$/i.test(f[2] ?? '') ? (f[2].toUpperCase() as 'M' | 'F') : undefined
      const cedula    = (f[3] ?? '').replace(/\D/g, '').slice(0, 12)
      const rh        = f[4]?.trim() || undefined
      const fnac      = f[5] ? parseFechaPdf(f[5]) : null
      if (cedula.length >= 5 && apellidos) {
        return { cedula, nombres, apellidos, sexo, rh, modo: 'PDF417', ...(fnac ?? {}) }
      }
    }
  }

  // ── Fallback: ; | \n separators ──────────────────────────────────────────
  for (const sep of [';', '|', '\n']) {
    if (!raw.includes(sep)) continue
    const fields = raw.split(sep).map(s => s.trim()).filter(Boolean)
    const ci = fields.findIndex(f => /^\d{6,12}$/.test(f))
    if (ci >= 2) {
      const apellidos = cleanNamePdf(fields[ci - 2])
      const nombres   = cleanNamePdf(fields[ci - 1])
      const cedula    = fields[ci]
      const sexo      = fields.find(f => /^[MF]$/i.test(f))?.toUpperCase() as 'M' | 'F' | undefined
      const rh        = fields.find(f => /^[ABO][+-]$/i.test(f))
      const fnacStr   = fields.find(f => /^\d{8}$/.test(f) && f !== cedula)
      const fnac      = fnacStr ? parseFechaPdf(fnacStr) : null
      if (apellidos && cedula) {
        return { cedula, nombres, apellidos, sexo, rh, modo: 'PDF417', ...(fnac ?? {}) }
      }
    }
  }

  return null
}

// ── MRZ parser ────────────────────────────────────────────────────────────────
// Cédula nueva — reverso — formato ICCOL (TD1 Colombia)
//
// Línea 1: ICCOL + cédula(9) + checkDigit + ...  total 30 chars
// Línea 2: YYMMDD + checkDigit + sexo(M/F) + fechaExp(6) + checkDigit + COL + ...  total 30 chars
// Línea 3: APELLIDO1<APELLIDO2<<NOMBRE1<NOMBRE2<<  total 30 chars
//
// Ejemplo real:
//   ICCOL023442784819001<<<<<<<<
//   0503291M3306149COL1077721837<6
//   MAYORCA<SOTO<<ALEJANDRO<<<<<

function parseDobMrz(yymmdd: string): { fechaNacimiento: string; edad: number } | null {
  if (!/^\d{6}$/.test(yymmdd)) return null
  const yy = parseInt(yymmdd.slice(0, 2))
  const mm = parseInt(yymmdd.slice(2, 4))
  const dd = parseInt(yymmdd.slice(4, 6))
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null
  const now = new Date()
  // Two-digit year: > current year → 1900s, else 2000s
  const fullYear = (2000 + yy) > now.getFullYear() ? 1900 + yy : 2000 + yy
  let edad = now.getFullYear() - fullYear
  if (now.getMonth() + 1 < mm || (now.getMonth() + 1 === mm && now.getDate() < dd)) edad--
  return {
    fechaNacimiento: `${fullYear}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`,
    edad: Math.max(0, edad),
  }
}

function parseMrzLines(l1: string, l2: string, l3: string): Cedula | null {
  // ── Cédula: line 1, positions 5–13 (9 chars) ─────────────────────────────
  const cedula = l1.slice(5, 14).replace(/</g, '')
  if (cedula.length < 5 || !/^\d+$/.test(cedula)) return null

  // ── Date of birth: line 2, positions 0–5 ─────────────────────────────────
  const dob  = parseDobMrz(l2.slice(0, 6))

  // ── Sex: line 2, position 7 ───────────────────────────────────────────────
  const sc   = l2[7] ?? ''
  const sexo: 'M' | 'F' | undefined = sc === 'M' ? 'M' : sc === 'F' ? 'F' : undefined

  // ── Names: line 3 — APELLIDOS<<NOMBRES ────────────────────────────────────
  const nameRaw = l3.replace(/<+$/, '')
  const sepIdx  = nameRaw.indexOf('<<')
  let apellidos = '', nombres = ''
  if (sepIdx >= 0) {
    apellidos = cleanMrzName(nameRaw.slice(0, sepIdx).replace(/<+/g, ' '))
    nombres   = cleanMrzName(nameRaw.slice(sepIdx + 2).replace(/<+/g, ' '))
  } else {
    apellidos = cleanMrzName(nameRaw.replace(/<+/g, ' '))
  }

  if (!apellidos && !cedula) return null

  return {
    cedula,
    nombres,
    apellidos,
    sexo,
    modo: 'MRZ',
    ...(dob ?? {}),
  }
}

function parseMrz(ocrText: string): Cedula | null {
  if (!ocrText || ocrText.length < 20) return null

  // Normalize: uppercase, keep only A-Z, 0-9, < and spaces
  const raw   = ocrText.toUpperCase()
  const lines = raw
    .split('\n')
    .map(l => l.trim().replace(/[^A-Z0-9<]/g, ''))
    .filter(l => l.length >= 15)

  if (lines.length === 0) return null

  // ── Strategy 1: find line 1 by ICCOL / IDCOL prefix ─────────────────────
  const l1Candidates = ['ICCOL', 'IDCOL', 'IC<COL', 'ID<COL', 'ICCOL']
  for (const prefix of l1Candidates) {
    const l1i = lines.findIndex(l => l.startsWith(prefix))
    if (l1i >= 0 && l1i + 2 < lines.length) {
      const result = parseMrzLines(
        lines[l1i].padEnd(30, '<'),
        lines[l1i + 1].padEnd(30, '<'),
        lines[l1i + 2].padEnd(30, '<'),
      )
      if (result) return result
    }
  }

  // ── Strategy 2: find line 2 by date+sex pattern ───────────────────────────
  // Pattern: 6 digits + any digit + M or F
  const l2i = lines.findIndex(l => /^\d{7}[MF]/.test(l))
  if (l2i > 0 && l2i + 1 < lines.length) {
    const result = parseMrzLines(
      lines[l2i - 1].padEnd(30, '<'),
      lines[l2i].padEnd(30, '<'),
      lines[l2i + 1].padEnd(30, '<'),
    )
    if (result) return result
  }

  // ── Strategy 3: find line 3 by << pattern ────────────────────────────────
  const l3i = lines.findIndex(l => l.includes('<<'))
  if (l3i >= 2) {
    const result = parseMrzLines(
      lines[l3i - 2].padEnd(30, '<'),
      lines[l3i - 1].padEnd(30, '<'),
      lines[l3i].padEnd(30, '<'),
    )
    if (result) return result
  }
  // l3 might be the first line with <<
  if (l3i >= 0 && l3i - 2 < 0) {
    // Try with partial context — just parse names from line 3
    const l3 = lines[l3i].padEnd(30, '<')
    const l2 = l3i > 0 ? lines[l3i - 1].padEnd(30, '<') : '<'.repeat(30)
    const l1 = l3i > 1 ? lines[l3i - 2].padEnd(30, '<') : '<'.repeat(30)
    const result = parseMrzLines(l1, l2, l3)
    if (result) return result
  }

  return null
}

// ── Confirm form ──────────────────────────────────────────────────────────────

interface ConfirmForm {
  cedula: string
  nombres: string
  apellidos: string
  sexo: 'M' | 'F' | ''
  fechaNacimiento: string
  rh: string
  modo: 'PDF417' | 'MRZ'
}

// ── ZXing hints ───────────────────────────────────────────────────────────────

const PDF417_HINTS = new Map<DecodeHintType, unknown>([
  [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.PDF_417]],
  [DecodeHintType.TRY_HARDER, true],
])

// ── Component ─────────────────────────────────────────────────────────────────

type BannerState = { type: 'ok' | 'dup' | 'err'; msg: string }

export default function ScannerPage() {
  const { id: eventoId } = useParams<{ id: string }>()
  const router = useRouter()

  // DOM
  const videoRef  = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Resources
  const trackRef     = useRef<MediaStreamTrack | null>(null)
  const readerRef    = useRef<BrowserMultiFormatReader | null>(null)
  const tesseractRef = useRef<import('tesseract.js').Worker | null>(null)

  // Scan control
  const activeRef     = useRef(false)  // camera ready and not paused
  const processingRef = useRef(false)  // registering a cedula right now
  const mrzBusyRef    = useRef(false)  // Tesseract is running
  const mrzReadyRef   = useRef(false)  // Tesseract worker loaded
  const onDetectedRef = useRef<((c: Cedula) => void) | null>(null)
  const pdfTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null)
  const mrzTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null)

  // UI state
  const [mode,       setMode]       = useState<'PDF417' | 'MRZ'>('PDF417')
  const [torchOn,    setTorchOn]    = useState(false)
  const [hasTorch,   setHasTorch]   = useState(false)
  const [mrzReady,   setMrzReady]   = useState(false)
  const [confirmForm,   setConfirmForm]   = useState<ConfirmForm | null>(null)
  const [confirmSaving, setConfirmSaving] = useState(false)
  const [confirmError,  setConfirmError]  = useState('')
  const [banner,        setBanner]        = useState<BannerState | null>(null)
  const [lastReg,    setLastReg]    = useState('')
  const [total,      setTotal]      = useState(0)
  const [evento,     setEvento]     = useState<Evento | null>(null)
  const [camError,   setCamError]   = useState<string | null>(null)
  const [showManual, setShowManual] = useState(false)
  const [manualForm, setManualForm] = useState({
    cedula: '', nombres: '', apellidos: '',
    fechaNacimiento: '', sexo: '' as 'M' | 'F' | '', rh: '',
  })
  const [manualSaving, setManualSaving] = useState(false)
  const [manualError,  setManualError]  = useState('')

  // Keep mrzReadyRef in sync
  useEffect(() => { mrzReadyRef.current = mrzReady }, [mrzReady])

  // ── handleDetected ────────────────────────────────────────────────────────

  const handleDetected = useCallback((c: Cedula) => {
    if (processingRef.current || !activeRef.current) return
    processingRef.current = true
    activeRef.current = false
    setConfirmForm({
      cedula:          c.cedula,
      nombres:         c.nombres,
      apellidos:       c.apellidos,
      sexo:            c.sexo ?? '',
      fechaNacimiento: c.fechaNacimiento ?? '',
      rh:              c.rh ?? '',
      modo:            c.modo,
    })
  }, [])

  useEffect(() => { onDetectedRef.current = handleDetected }, [handleDetected])

  const handleConfirm = async () => {
    if (!confirmForm) return
    setConfirmSaving(true)
    setConfirmError('')
    try {
      const dup = await checkDuplicado(eventoId, confirmForm.cedula)
      if (dup) {
        setConfirmError(`⚠️ ${confirmForm.apellidos} ${confirmForm.nombres} ya está registrado`)
        return
      }
      const edad = confirmForm.fechaNacimiento ? calcEdad(confirmForm.fechaNacimiento) : 0
      await registrarAsistencia(eventoId, {
        cedula:          confirmForm.cedula,
        nombres:         confirmForm.nombres,
        apellidos:       confirmForm.apellidos,
        sexo:            (confirmForm.sexo || undefined) as 'M' | 'F' | undefined,
        fechaNacimiento: confirmForm.fechaNacimiento,
        edad,
        rh:              confirmForm.rh,
        modo:            confirmForm.modo,
      })
      const t = await getTotalAsistencias(eventoId)
      setTotal(t)
      setLastReg(`${confirmForm.apellidos} ${confirmForm.nombres}`)
      setBanner({
        type: 'ok',
        msg:  `✅ ${confirmForm.apellidos} ${confirmForm.nombres}${edad ? ` — ${edad} años` : ''}`,
      })
      setConfirmForm(null)
      setTimeout(() => {
        setBanner(null)
        processingRef.current = false
        activeRef.current = true
      }, 3000)
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string }
      setConfirmError(`Error (${e.code ?? '?'}): ${e.message ?? ''}`)
    } finally {
      setConfirmSaving(false)
    }
  }

  const handleCancelConfirm = () => {
    setConfirmForm(null)
    setConfirmError('')
    processingRef.current = false
    activeRef.current = true
  }

  // ── Tesseract init ────────────────────────────────────────────────────────

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const { createWorker } = await import('tesseract.js')
        const w = await createWorker('eng', 1, { logger: () => {} })
        await w.setParameters({
          // Include '<' — it's the MRZ filler and field separator
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<' as any,
          // PSM 6: uniform block of text — best for MRZ
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tessedit_pageseg_mode: '6' as any,
        })
        if (alive) { tesseractRef.current = w; setMrzReady(true) }
      } catch { /* Tesseract failed to load — OCR will be unavailable */ }
    })()
    return () => {
      alive = false
      tesseractRef.current?.terminate()
    }
  }, [])

  // ── Camera + parallel scan intervals ─────────────────────────────────────
  // Both PDF417 and MRZ always run simultaneously.
  // The first one to detect a valid cedula wins (processingRef prevents double-fire).

  useEffect(() => {
    let alive = true

    ;(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        })
        if (!alive) { stream.getTracks().forEach(t => t.stop()); return }

        const track = stream.getVideoTracks()[0]
        trackRef.current = track

        // Torch support detection
        const caps = track.getCapabilities?.() as Record<string, unknown> | undefined
        if (caps && 'torch' in caps) {
          setHasTorch(true)
        } else {
          try {
            await track.applyConstraints({ advanced: [{ torch: false } as MediaTrackConstraintSet] })
            setHasTorch(true)
          } catch { /* torch not supported */ }
        }

        const video = videoRef.current!
        video.srcObject = stream
        await video.play()

        const reader = new BrowserMultiFormatReader(PDF417_HINTS)
        readerRef.current = reader

        const canvas = canvasRef.current!
        const ctx    = canvas.getContext('2d', { willReadFrequently: true })!

        activeRef.current = true

        // Draws current video frame to shared canvas. Returns true if video is ready.
        const drawFrame = (): boolean => {
          if (!alive) return false
          if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) return false
          canvas.width  = video.videoWidth
          canvas.height = video.videoHeight
          ctx.drawImage(video, 0, 0)
          return true
        }

        // ── PDF417 interval: 400ms ──────────────────────────────────────────
        pdfTimerRef.current = setInterval(() => {
          if (!alive || processingRef.current || !activeRef.current) return
          if (!drawFrame()) return
          try {
            const result = reader.decodeFromCanvas(canvas)
            const parsed = parsePdf417(result.getText())
            if (parsed) onDetectedRef.current?.(parsed)
          } catch {
            // ZXing throws NotFoundException on every frame without a barcode — expected
          } finally {
            // Reset ZXing internal state to avoid stale decode artifacts
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(reader as any).reader?.reset?.()
          }
        }, 400)

        // ── MRZ (Tesseract) interval: 1000ms ────────────────────────────────
        // Processes full frame — MRZ may be anywhere in the camera view.
        mrzTimerRef.current = setInterval(async () => {
          if (!alive || processingRef.current || !activeRef.current) return
          if (!tesseractRef.current || !mrzReadyRef.current) return
          if (mrzBusyRef.current) return  // previous OCR still running
          if (!drawFrame()) return

          mrzBusyRef.current = true
          try {
            // Tesseract captures the canvas pixel data immediately on call,
            // so subsequent PDF417 redraws don't affect this recognition.
            const { data: { text } } = await tesseractRef.current.recognize(canvas)
            const parsed = parseMrz(text)
            if (parsed) onDetectedRef.current?.(parsed)
          } catch {
            // OCR error — ignore
          } finally {
            mrzBusyRef.current = false
          }
        }, 1000)

      } catch {
        if (alive) setCamError('No se pudo acceder a la cámara. Verifica los permisos.')
      }
    })()

    return () => {
      alive = false
      if (pdfTimerRef.current) clearInterval(pdfTimerRef.current)
      if (mrzTimerRef.current) clearInterval(mrzTimerRef.current)
      trackRef.current?.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Evento data ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (!eventoId) return
    getDoc(doc(db, 'eventos', eventoId)).then(snap => {
      if (snap.exists()) setEvento({ id: snap.id, ...snap.data() } as Evento)
    })
    getTotalAsistencias(eventoId).then(setTotal)
  }, [eventoId])

  // ── Torch toggle ──────────────────────────────────────────────────────────

  const toggleTorch = useCallback(async () => {
    if (!trackRef.current) return
    const next = !torchOn
    try {
      await trackRef.current.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] })
      setTorchOn(next)
    } catch { /* silently ignore */ }
  }, [torchOn])

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
      const edad = calcEdad(fechaNacimiento)
      await registrarAsistencia(eventoId, {
        cedula:          cedula.trim(),
        nombres:         capitalize(nombres.trim()),
        apellidos:       capitalize(apellidos.trim()),
        fechaNacimiento,
        edad,
        sexo:            sexo as 'M' | 'F',
        rh:              rh.trim() || undefined,
        modo:            'MANUAL',
      })
      const t = await getTotalAsistencias(eventoId)
      setTotal(t)
      const nombre = `${capitalize(apellidos.trim())} ${capitalize(nombres.trim())}`
      setLastReg(nombre)
      setShowManual(false)
      setManualForm({ cedula: '', nombres: '', apellidos: '', fechaNacimiento: '', sexo: '', rh: '' })
      setBanner({ type: 'ok', msg: `✅ ${nombre} — ${edad} años` })
      setTimeout(() => setBanner(null), 3000)
    } catch (err: unknown) {
      setManualError((err as { message?: string }).message ?? 'Error al guardar')
    } finally {
      setManualSaving(false)
    }
  }

  // ── Camera error ──────────────────────────────────────────────────────────

  if (camError) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center z-50 p-6">
        <div className="bg-[#18181b] border border-[#27272a] rounded-2xl p-6 text-center max-w-xs w-full">
          <p className="text-4xl mb-3">📷</p>
          <p className="text-white font-semibold mb-2">Sin acceso a la cámara</p>
          <p className="text-zinc-400 text-sm mb-5">{camError}</p>
          <button onClick={() => router.back()}
            className="w-full py-2.5 rounded-xl bg-white/10 text-white text-sm hover:bg-white/15 transition">
            ← Volver
          </button>
        </div>
      </div>
    )
  }

  const FIELD_M = 'w-full bg-[#111113] border border-[#27272a] rounded-xl px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition'

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 bg-black z-50 overflow-hidden select-none">
      {/* Live camera */}
      <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover" autoPlay playsInline muted />

      {/* Canvas (hidden — used for frame capture) */}
      <canvas ref={canvasRef} className="hidden" />

      {/* ── Scan window ─────────────────────────────────────────────────── */}
      <div className="absolute inset-0 pointer-events-none">
        <div
          style={{
            position:  'absolute',
            top: '50%', left: '50%',
            transform: 'translate(-50%, -60%)',
            width:     'min(88vw, 380px)',
            height:    'min(56vw, 240px)',
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.65)',
            borderRadius: 10,
            border: '1.5px solid rgba(255,255,255,0.28)',
          }}
        >
          {(['top-0 left-0 border-t-2 border-l-2 rounded-tl',
             'top-0 right-0 border-t-2 border-r-2 rounded-tr',
             'bottom-0 left-0 border-b-2 border-l-2 rounded-bl',
             'bottom-0 right-0 border-b-2 border-r-2 rounded-br'] as const)
            .map((cls, i) => (
              <div key={i} className={`absolute w-7 h-7 border-white ${cls}`} />
            ))}
        </div>

        {/* Mode hint */}
        <p
          className="absolute w-full text-center text-white/55 text-xs px-8"
          style={{ top: '50%', transform: 'translateY(calc(-60% + min(29vw, 125px) + 14px))' }}
        >
          {mode === 'PDF417'
            ? 'Cédula VIEJA — apunta al reverso (código de barras)'
            : 'Cédula NUEVA — apunta al reverso (zona >>><<<)'}
        </p>
      </div>

      {/* ── Top bar ───────────────────────────────────────────────────────── */}
      <div className="absolute top-0 inset-x-0 z-10 flex items-start justify-between px-4 pt-10 pb-4">
        {/* Back + event info */}
        <div className="flex items-start gap-2">
          <button
            onClick={() => router.back()}
            className="w-10 h-10 rounded-full bg-black/60 backdrop-blur-md flex items-center justify-center text-white shrink-0 text-lg"
          >
            ‹
          </button>
          <div className="bg-black/60 backdrop-blur-md rounded-2xl px-3 py-2 max-w-[55vw]">
            <p className="text-white font-semibold text-sm leading-tight truncate">{evento?.nombre ?? '…'}</p>
            <p className="text-zinc-400 text-xs mt-0.5">{total} registrado{total !== 1 ? 's' : ''}</p>
          </div>
        </div>

        {/* OCR indicator + torch */}
        <div className="flex items-center gap-2 mt-1">
          <div
            className={`w-2 h-2 rounded-full ${mrzReady ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`}
            title={mrzReady ? 'OCR listo' : 'Cargando OCR…'}
          />
          <button
            onClick={toggleTorch}
            className={`w-11 h-11 rounded-full backdrop-blur-md flex items-center justify-center text-xl transition-all active:scale-90 ${
              torchOn ? 'bg-yellow-400/90 text-black' : 'bg-black/60 text-white'
            } ${!hasTorch ? 'opacity-40 pointer-events-none' : ''}`}
            title={hasTorch ? 'Linterna' : 'Linterna (no disponible)'}
          >
            ⚡
          </button>
        </div>
      </div>

      {/* ── Bottom bar ────────────────────────────────────────────────────── */}
      <div className="absolute bottom-0 inset-x-0 z-10 px-4 pt-4 pb-8 bg-gradient-to-t from-black/85 via-black/40 to-transparent">
        <div className="flex gap-2 mb-3">
          {/* Mode: Frente (PDF417) */}
          <button
            onClick={() => setMode('PDF417')}
            className={`flex-1 py-3.5 rounded-2xl text-sm font-semibold transition-all active:scale-95 ${
              mode === 'PDF417'
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/40'
                : 'bg-white/10 text-white/70'
            }`}
          >
            Vieja (PDF417)
          </button>

          {/* Mode: Reverso (MRZ) */}
          <button
            onClick={() => setMode('MRZ')}
            className={`flex-1 py-3.5 rounded-2xl text-sm font-semibold transition-all active:scale-95 ${
              mode === 'MRZ'
                ? 'bg-purple-600 text-white shadow-lg shadow-purple-600/40'
                : 'bg-white/10 text-white/70'
            }`}
          >
            Nueva (MRZ)
          </button>

          {/* Flash */}
          <button
            onClick={toggleTorch}
            className={`w-14 py-3.5 rounded-2xl text-base font-bold transition-all active:scale-95 ${
              torchOn ? 'bg-yellow-400 text-black' : 'bg-white/10 text-white/70'
            }`}
            title="Flash"
          >
            ⚡
          </button>

          {/* Manual entry */}
          <button
            onClick={() => setShowManual(true)}
            className="w-14 py-3.5 rounded-2xl text-base bg-white/10 text-white/70 hover:bg-white/15 transition-all active:scale-95"
            title="Registrar manualmente"
          >
            ✏️
          </button>
        </div>

        {/* Both modes always active indicator */}
        <p className="text-center text-white/35 text-[11px] mb-1">
          PDF417 + OCR activos simultáneamente
        </p>

        {lastReg && (
          <p className="text-center text-zinc-400 text-xs truncate">
            Último: <span className="text-white/90">{lastReg}</span>
          </p>
        )}
      </div>

      {/* ── Result banner ──────────────────────────────────────────────────── */}
      {banner && (
        <div className="absolute inset-x-5 z-30" style={{ top: '50%', transform: 'translateY(-50%)' }}>
          <div
            className={`rounded-2xl px-6 py-5 text-center shadow-2xl ${
              banner.type === 'ok'  ? 'bg-emerald-600 text-white' :
              banner.type === 'dup' ? 'bg-amber-500 text-white'   :
                                      'bg-red-600 text-white'
            }`}
          >
            <p className="font-bold text-lg leading-snug">{banner.msg}</p>
          </div>
        </div>
      )}

      {/* ── Confirmation modal ─────────────────────────────────────────────── */}
      {confirmForm && !banner && (
        <div className="absolute inset-0 z-40 flex items-end sm:items-center justify-center">
          <div className="absolute inset-0 bg-black/85" />
          <div className="relative w-full max-w-md bg-[#18181b] border border-[#27272a] rounded-t-3xl sm:rounded-2xl p-6 max-h-[92dvh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold text-white text-base">Confirmar registro</h2>
              <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                confirmForm.modo === 'PDF417' ? 'bg-blue-500/20 text-blue-400' : 'bg-purple-500/20 text-purple-400'
              }`}>{confirmForm.modo}</span>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Número de cédula</label>
                <input
                  value={confirmForm.cedula}
                  onChange={e => setConfirmForm(f => f ? { ...f, cedula: e.target.value } : f)}
                  className={FIELD_M}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Nombres</label>
                  <input
                    value={confirmForm.nombres}
                    onChange={e => setConfirmForm(f => f ? { ...f, nombres: e.target.value } : f)}
                    className={FIELD_M}
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Apellidos</label>
                  <input
                    value={confirmForm.apellidos}
                    onChange={e => setConfirmForm(f => f ? { ...f, apellidos: e.target.value } : f)}
                    className={FIELD_M}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Fecha nacimiento</label>
                  <input
                    type="date"
                    value={confirmForm.fechaNacimiento}
                    onChange={e => setConfirmForm(f => f ? { ...f, fechaNacimiento: e.target.value } : f)}
                    className={`${FIELD_M} [color-scheme:dark]`}
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Sexo</label>
                  <select
                    value={confirmForm.sexo}
                    onChange={e => setConfirmForm(f => f ? { ...f, sexo: e.target.value as 'M' | 'F' | '' } : f)}
                    className={`${FIELD_M} [color-scheme:dark]`}
                  >
                    <option value="">—</option>
                    <option value="M">Masculino</option>
                    <option value="F">Femenino</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">RH (opcional)</label>
                <input
                  value={confirmForm.rh}
                  onChange={e => setConfirmForm(f => f ? { ...f, rh: e.target.value } : f)}
                  placeholder="O+"
                  className={FIELD_M}
                />
              </div>

              {confirmError && (
                <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">
                  {confirmError}
                </p>
              )}

              <div className="flex gap-3 pt-1">
                <button
                  onClick={handleCancelConfirm}
                  className="flex-1 py-3 rounded-xl border border-[#27272a] text-zinc-400 text-sm hover:bg-white/5 transition"
                >
                  ❌ Cancelar
                </button>
                <button
                  onClick={handleConfirm}
                  disabled={confirmSaving}
                  className="flex-1 py-3 rounded-xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-500 disabled:opacity-60 transition flex items-center justify-center gap-2"
                >
                  {confirmSaving
                    ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Guardando…</>
                    : '✅ Confirmar'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Manual modal ───────────────────────────────────────────────────── */}
      {showManual && (
        <div className="absolute inset-0 z-40 flex items-end sm:items-center justify-center">
          <div className="absolute inset-0 bg-black/70" onClick={() => setShowManual(false)} />
          <div className="relative w-full max-w-md bg-[#18181b] border border-[#27272a] rounded-t-3xl sm:rounded-2xl p-6 max-h-[90dvh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-semibold text-white text-base">Registrar manualmente</h2>
              <button
                onClick={() => { setShowManual(false); setManualError('') }}
                className="w-8 h-8 rounded-lg bg-white/10 text-zinc-400 hover:text-white flex items-center justify-center transition"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleManual} className="space-y-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Número de cédula *</label>
                <input
                  required inputMode="numeric"
                  value={manualForm.cedula}
                  onChange={e => setManualForm(f => ({ ...f, cedula: e.target.value }))}
                  placeholder="1234567890"
                  className={FIELD_M}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Nombres *</label>
                  <input
                    required
                    value={manualForm.nombres}
                    onChange={e => setManualForm(f => ({ ...f, nombres: e.target.value }))}
                    placeholder="Juan"
                    className={FIELD_M}
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Apellidos *</label>
                  <input
                    required
                    value={manualForm.apellidos}
                    onChange={e => setManualForm(f => ({ ...f, apellidos: e.target.value }))}
                    placeholder="García"
                    className={FIELD_M}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Fecha nacimiento *</label>
                  <input
                    required type="date"
                    value={manualForm.fechaNacimiento}
                    onChange={e => setManualForm(f => ({ ...f, fechaNacimiento: e.target.value }))}
                    className={`${FIELD_M} [color-scheme:dark]`}
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Sexo *</label>
                  <select
                    required
                    value={manualForm.sexo}
                    onChange={e => setManualForm(f => ({ ...f, sexo: e.target.value as 'M' | 'F' | '' }))}
                    className={`${FIELD_M} [color-scheme:dark]`}
                  >
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
                <input
                  value={manualForm.rh}
                  onChange={e => setManualForm(f => ({ ...f, rh: e.target.value }))}
                  placeholder="O+"
                  className={FIELD_M}
                />
              </div>

              {manualError && (
                <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">
                  {manualError}
                </p>
              )}

              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => { setShowManual(false); setManualError('') }}
                  className="flex-1 py-3 rounded-xl border border-[#27272a] text-zinc-400 text-sm hover:bg-white/5 transition"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={manualSaving}
                  className="flex-1 py-3 rounded-xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-500 disabled:opacity-60 transition flex items-center justify-center gap-2"
                >
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
