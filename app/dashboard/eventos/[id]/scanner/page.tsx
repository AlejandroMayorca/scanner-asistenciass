'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { BrowserMultiFormatReader } from '@zxing/browser'
import { BarcodeFormat, DecodeHintType } from '@zxing/library'
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
}

type ToastState = { color: 'red' | 'yellow' | 'green'; msg: string } | null

// ─── ZXing hints ──────────────────────────────────────────────────────────────

const HINTS = new Map<DecodeHintType, unknown>([
  [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.PDF_417, BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX]],
  [DecodeHintType.TRY_HARDER, true],
])

// ─── PDF417 parser ─────────────────────────────────────────────────────────────
// [0]=apellidos [1]=nombres [2]=sexo [3]=cedula [4]=rh [5]=fechaNac(YYYYMMDD)

const RS = '\x1e'

function parseFechaPdf(raw: string): { fechaNacimiento: string; edad: number } | null {
  const c = raw.replace(/\D/g, '')
  if (c.length !== 8) return null
  const y = c.slice(0, 4), mo = c.slice(4, 6), d = c.slice(6, 8)
  if (parseInt(y) < 1900 || parseInt(y) > new Date().getFullYear()) return null
  const fechaNacimiento = `${y}-${mo}-${d}`
  return { fechaNacimiento, edad: calcEdad(fechaNacimiento) }
}

function cleanName(s: string): string {
  return capitalize(s.replace(/[^A-Za-zÁÉÍÓÚáéíóúÑñ\s]/g, '').trim())
}

function parsePdf417(raw: string): Cedula | null {
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
  for (const sep of [';', '\n']) {
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
// L2: YYMMDD+sexo(pos7)+...+COL+cédula<...
// L3: APELLIDOS<<NOMBRES

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

// ─── MRZ regex fallback ───────────────────────────────────────────────────────

function parseMrzRegex(text: string): Cedula | null {
  const up = text.toUpperCase().replace(/[^A-Z0-9<\n\r]/g, ' ')

  // Cedula: preferir patrón COL (línea 2) — más fiable que ICCOL
  let cedula = ''
  const m1 = up.match(/COL(\d{6,12})[< \n\r]/)
  if (m1) cedula = m1[1]
  if (!cedula) {
    const m2 = up.match(/ICCOL(\d{8,12})/)
    if (m2) cedula = m2[1]
  }
  if (cedula.length < 5) return null

  // Nombres: patrón APELLIDOS<<NOMBRES
  let apellidos = '', nombres = ''
  const m3 = up.match(/([A-Z][A-Z< ]+)<<([A-Z][A-Z< ]*)/)
  if (m3) {
    apellidos = cleanMrzName(m3[1])
    nombres   = cleanMrzName(m3[2])
  }

  return { cedula, apellidos, nombres, modo: 'MRZ' }
}

function parseBarcode(raw: string): Cedula | null {
  if (!raw || raw.length < 5) return null
  if (raw.includes(RS)) return parsePdf417(raw)
  const up = raw.toUpperCase()
  if (up.includes('ICCOL') || up.includes('IDCOL') || raw.includes('<<')) return parseMrzText(raw)
  return parsePdf417(raw)
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ScannerPage() {
  const { id: eventoId } = useParams<{ id: string }>()
  const router = useRouter()

  const videoRef   = useRef<HTMLVideoElement>(null)
  const streamRef  = useRef<MediaStream | null>(null)
  const trackRef   = useRef<MediaStreamTrack | null>(null)
  const readerRef  = useRef<BrowserMultiFormatReader | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tWorkerRef = useRef<any>(null)
  const tReadyRef  = useRef(false)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [camError,      setCamError]      = useState<string | null>(null)
  const [hasTorch,      setHasTorch]      = useState(false)
  const [torchOn,       setTorchOn]       = useState(false)
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
  const [failCount,    setFailCount]    = useState(0)
  const [countdown,    setCountdown]    = useState(false)
  const [debugLog,     setDebugLog]     = useState<string[]>([])

  // ── Debug log helper ──────────────────────────────────────────────────────

  const addLog = useCallback((msg: string) => {
    console.log(msg)
    setDebugLog(prev => [...prev.slice(-7), msg])
  }, [])

  // ── Camera + Tesseract init ────────────────────────────────────────────────

  useEffect(() => {
    let alive = true
    readerRef.current = new BrowserMultiFormatReader(HINTS)

    const initCamera = async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            focusMode: 'continuous', advanced: [{ focusMode: 'continuous' }],
          } as any,
        })
        if (!alive) { s.getTracks().forEach(t => t.stop()); return }
        streamRef.current = s
        if (videoRef.current) videoRef.current.srcObject = s
        const track = s.getVideoTracks()[0]
        if (track) {
          trackRef.current = track
          try {
            const caps = track.getCapabilities?.()
            if (caps && 'torch' in caps) setHasTorch(true)
          } catch { /* ignore */ }
        }
      } catch {
        if (alive) setCamError('No se pudo acceder a la cámara. Verifica los permisos.')
      }
    }

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
      } catch { /* ZXing only */ }
    }

    initCamera()
    initTesseract()

    return () => {
      alive = false
      streamRef.current?.getTracks().forEach(t => t.stop())
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

  // ── Toast helper ──────────────────────────────────────────────────────────

  const showToast = useCallback((color: 'red' | 'yellow' | 'green', msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ color, msg })
    toastTimer.current = setTimeout(() => setToast(null), 2500)
  }, [])

  // ── Focus ──────────────────────────────────────────────────────────────────

  const handleFocus = useCallback(async (e?: React.MouseEvent<HTMLElement>) => {
    const track = trackRef.current
    if (!track) return
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adv: any = { focusMode: 'single-shot' }
      if (e && videoRef.current) {
        const rect = videoRef.current.getBoundingClientRect()
        adv.focusPointOfInterest = {
          x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
          y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
        }
      }
      await track.applyConstraints({ advanced: [adv] })
      addLog('[Focus] single-shot OK')
    } catch {
      addLog('[Focus] no soportado')
    }
  }, [addLog])

  // ── Capture & process ─────────────────────────────────────────────────────

  const handleCapture = useCallback(async () => {
    const video = videoRef.current
    if (!video || processing || countdown || confirmForm) return
    if (!video.videoWidth || !video.videoHeight) return

    // 800ms autofocus delay
    setCountdown(true)
    await new Promise(r => setTimeout(r, 800))
    setCountdown(false)

    setProcessing(true)
    setDebugLog([])
    try {
      // High-res canvas (2x) for better barcode readability
      const W = video.videoWidth, H = video.videoHeight
      const base = document.createElement('canvas')
      base.width  = W * 2
      base.height = H * 2
      const bCtx = base.getContext('2d')!
      bCtx.scale(2, 2)
      bCtx.drawImage(video, 0, 0)
      bCtx.setTransform(1, 0, 0, 1, 0, 0)

      // Helper: create derived canvas with optional filter and crop
      const makeCanvas = (
        filter: string,
        crop?: { sy: number; sh: number },
      ): HTMLCanvasElement => {
        const c   = document.createElement('canvas')
        const src = base
        c.width   = src.width
        c.height  = crop ? crop.sh : src.height
        const cx  = c.getContext('2d')!
        cx.filter = filter || 'none'
        if (crop) cx.drawImage(src, 0, crop.sy, src.width, crop.sh, 0, 0, src.width, crop.sh)
        else      cx.drawImage(src, 0, 0)
        cx.filter = 'none'
        return c
      }

      // Helper: decode via img element (better iOS compatibility than decodeFromCanvas)
      const decodeImg = (canvas: HTMLCanvasElement): Promise<string | null> =>
        new Promise(resolve => {
          const img = new Image()
          img.onload = async () => {
            try {
              const res = await readerRef.current!.decodeFromImageElement(img)
              resolve(res.getText())
            } catch { resolve(null) }
          }
          img.onerror = () => resolve(null)
          img.src = canvas.toDataURL('image/png')
        })

      // 4 ZXing attempts with different filters
      const attempts = [
        { label: 'original',         canvas: makeCanvas('none') },
        { label: 'contraste alto',   canvas: makeCanvas('contrast(2) brightness(1.2) grayscale(1)') },
        { label: 'invertido',        canvas: makeCanvas('invert(1) contrast(2)') },
        { label: 'mitad inferior',   canvas: makeCanvas('none', { sy: base.height / 2, sh: base.height / 2 }) },
      ]

      let zxingResult: Cedula | null = null
      for (const { label, canvas } of attempts) {
        const text = await decodeImg(canvas)
        if (text) {
          addLog(`[ZXing ${label}] "${text.slice(0, 70)}"`)
          const parsed = parseBarcode(text)
          if (parsed) { zxingResult = parsed; break }
          addLog(`[ZXing ${label}] texto inválido`)
        } else {
          addLog(`[ZXing ${label}] sin detección`)
        }
      }

      // Tesseract on bottom 60% (MRZ zone)
      let tesseractResult: Cedula | null = null
      if (!zxingResult) {
        if (tReadyRef.current && tWorkerRef.current) {
          try {
            const sy   = Math.floor(base.height * 0.4)
            const sh   = Math.floor(base.height * 0.6)
            const crop = makeCanvas('none', { sy, sh })
            const { data: { text } } = await tWorkerRef.current.recognize(crop)
            addLog(`[Tesseract] "${text.trim().replace(/\n/g, ' ').slice(0, 100)}"`)

            // Try structured MRZ parse
            tesseractResult = parseMrzText(text)
            if (tesseractResult) {
              addLog(`[Tesseract MRZ] cédula=${tesseractResult.cedula}`)
            } else {
              // Regex fallback
              tesseractResult = parseMrzRegex(text)
              if (tesseractResult) {
                addLog(`[Tesseract regex] cédula=${tesseractResult.cedula}`)
              } else {
                addLog('[Tesseract] sin resultado')
              }
            }
          } catch (err) {
            addLog(`[Tesseract] error: ${String(err).slice(0, 60)}`)
          }
        } else {
          addLog('[Tesseract] no inicializado')
        }
      }

      const detected = zxingResult ?? tesseractResult

      if (!detected || detected.cedula.length < 5) {
        setFailCount(c => c + 1)
        showToast('red', '❌ No se detectó. Intenta de nuevo')
        return
      }

      const dup = await checkDuplicado(eventoId, detected.cedula)
      if (dup) {
        showToast('yellow', `⚠️ Ya registrado: ${detected.apellidos} ${detected.nombres}`)
        return
      }

      setFailCount(0)
      setConfirmForm({
        cedula:          detected.cedula,
        nombres:         detected.nombres,
        apellidos:       detected.apellidos,
        sexo:            detected.sexo ?? '',
        fechaNacimiento: detected.fechaNacimiento ?? '',
        rh:              detected.rh ?? '',
        modo:            detected.modo,
      })
    } finally {
      setProcessing(false)
    }
  }, [processing, countdown, confirmForm, eventoId, showToast, addLog])

  // ── Torch ──────────────────────────────────────────────────────────────────

  const toggleTorch = useCallback(async () => {
    const track = trackRef.current
    if (!track) return
    const next = !torchOn
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await track.applyConstraints({ advanced: [{ torch: next } as any] })
      setTorchOn(next)
    } catch { setHasTorch(false) }
  }, [torchOn])

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
      setConfirmError('')
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

  // ── Camera error screen ────────────────────────────────────────────────────

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

  const FIELD = 'w-full bg-[#111113] border border-[#27272a] rounded-xl px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition'

  return (
    <div className="fixed inset-0 bg-black z-50 overflow-hidden select-none">

      {/* Camera preview — tap to focus */}
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-cover"
        autoPlay playsInline muted
        onClick={handleFocus}
      />

      {/* Vignette */}
      <div className="absolute inset-0 pointer-events-none"
        style={{ background: 'radial-gradient(ellipse at center, transparent 38%, rgba(0,0,0,0.72) 100%)' }} />

      {/* Card guide window — also focusable */}
      <div className="absolute inset-0 flex items-center justify-center"
        style={{ paddingBottom: '10vh' }}
        onClick={handleFocus}>
        <div style={{
          width: 'min(88vw, 380px)', height: 'min(56vw, 240px)',
          border: '1.5px solid rgba(255,255,255,0.38)',
          borderRadius: 10,
          boxShadow: '0 0 0 9999px rgba(0,0,0,0.52)',
          position: 'relative',
        }}>
          {(['tl','tr','bl','br'] as const).map(c => (
            <div key={c} className={`absolute w-7 h-7 border-white border-2 ${
              c === 'tl' ? 'top-0 left-0 rounded-tl border-r-0 border-b-0' :
              c === 'tr' ? 'top-0 right-0 rounded-tr border-l-0 border-b-0' :
              c === 'bl' ? 'bottom-0 left-0 rounded-bl border-r-0 border-t-0' :
                           'bottom-0 right-0 rounded-br border-l-0 border-t-0'
            }`} />
          ))}
        </div>
      </div>

      {/* Hint below window */}
      <div className="absolute inset-x-0 flex justify-center pointer-events-none"
        style={{ top: '50%', marginTop: 'calc(min(28vw, 120px) - 9vh + 14px)' }}>
        <p className="text-white/45 text-xs tracking-wide">Apunta al reverso · toca para enfocar</p>
      </div>

      {/* On-screen debug log */}
      {debugLog.length > 0 && (
        <div
          className="absolute inset-x-3 z-10 pointer-events-none"
          style={{ top: '50%', marginTop: 'calc(min(28vw, 120px) - 9vh + 32px)' }}
        >
          <div className="bg-black/70 rounded-xl px-2 py-1.5 space-y-0.5">
            {debugLog.map((line, i) => (
              <p key={i} className="text-yellow-300 text-[9px] font-mono leading-tight truncate">{line}</p>
            ))}
          </div>
        </div>
      )}

      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <div className="absolute top-0 inset-x-0 z-10 flex items-start justify-between px-4 pt-10 pb-4">
        <div className="flex items-start gap-2">
          <button
            onClick={() => router.back()}
            className="w-10 h-10 rounded-full bg-black/60 backdrop-blur-md flex items-center justify-center text-white shrink-0 text-lg"
          >‹</button>
          <div className="bg-black/60 backdrop-blur-md rounded-2xl px-3 py-2 max-w-[55vw]">
            <p className="text-white font-semibold text-sm leading-tight truncate">{evento?.nombre ?? '…'}</p>
            <p className="text-zinc-400 text-xs mt-0.5">{total} registrado{total !== 1 ? 's' : ''}</p>
          </div>
        </div>
      </div>

      {/* ── Bottom bar ──────────────────────────────────────────────────── */}
      <div className="absolute bottom-0 inset-x-0 z-10 px-4 pt-3 pb-10">
        {/* Retry panel after 2 consecutive failures */}
        {failCount >= 2 && !processing && !countdown && !confirmForm && (
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => { setFailCount(0); handleCapture() }}
              className="flex-1 py-4 rounded-2xl bg-white/10 backdrop-blur-md text-white font-semibold text-sm active:scale-95 transition-all"
            >
              📷 Reintentar
            </button>
            <button
              onClick={() => setShowManual(true)}
              className="flex-1 py-4 rounded-2xl bg-emerald-600 text-white font-semibold text-sm active:scale-95 transition-all"
            >
              ✏️ Ingresar manualmente
            </button>
          </div>
        )}

        <div className="flex items-center gap-2">
          {/* Capture */}
          <button
            onClick={handleCapture}
            disabled={processing || countdown || !!confirmForm}
            className="flex-1 h-16 rounded-2xl bg-white text-black font-bold text-lg flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-50 shadow-xl"
          >
            {countdown ? (
              <span className="text-sm font-semibold">Capturando en 1…</span>
            ) : processing ? (
              <>
                <div className="w-5 h-5 border-2 border-black/20 border-t-black rounded-full animate-spin" />
                <span className="text-sm font-semibold">Procesando…</span>
              </>
            ) : '📸 Capturar'}
          </button>

          {/* Focus */}
          <button
            onClick={() => handleFocus()}
            className="w-12 h-16 rounded-2xl bg-black/60 backdrop-blur-md flex items-center justify-center text-base text-white/70 active:scale-90 transition-all"
            title="Enfocar"
          >🔍</button>

          {/* Flash */}
          <button
            onClick={hasTorch ? toggleTorch : undefined}
            className={`w-12 h-16 rounded-2xl flex items-center justify-center text-xl active:scale-90 transition-all ${
              torchOn ? 'bg-yellow-400 text-black' : 'bg-black/60 backdrop-blur-md text-white/70'
            } ${!hasTorch ? 'opacity-30 pointer-events-none' : ''}`}
          >⚡</button>

          {/* Manual */}
          <button
            onClick={() => setShowManual(true)}
            className="w-12 h-16 rounded-2xl bg-black/60 backdrop-blur-md flex items-center justify-center text-xl text-white/70 active:scale-90 transition-all"
          >✏️</button>
        </div>
      </div>

      {/* ── Processing / countdown overlay ───────────────────────────────── */}
      {(processing || countdown) && (
        <div className="absolute inset-0 z-20 bg-black/45 flex flex-col items-center justify-center gap-3 pointer-events-none">
          {countdown ? (
            <p className="text-white font-bold text-3xl tracking-wide drop-shadow-lg">Capturando en 1…</p>
          ) : (
            <>
              <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin" />
              <p className="text-white font-semibold text-sm tracking-wide">Procesando…</p>
            </>
          )}
        </div>
      )}

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
          <div className="absolute inset-0 bg-black/80"
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
