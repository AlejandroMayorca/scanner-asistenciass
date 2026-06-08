'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { BrowserMultiFormatReader } from '@zxing/browser'
import { BarcodeFormat, DecodeHintType } from '@zxing/library'
import { doc, getDoc, Timestamp } from 'firebase/firestore'
import { db } from '../../../../lib/firebase'
import { registrarAsistencia, checkDuplicado, getTotalAsistencias } from '../../../../lib/firestore'
import type { Evento } from '../../../../lib/types'

// ── Parsed cedula ─────────────────────────────────────────────────────────────

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

// ── PDF417 parser (cédula vieja) ──────────────────────────────────────────────
// Fields separated by \x1E (Record Separator):
//   [0]=apellidos  [1]=nombres  [2]=sexo  [3]=cedula  [4]=rh

const RS = '\x1e'

function cleanName(s: string) {
  return s.replace(/[^A-Za-zÁÉÍÓÚáéíóúÑñ\s]/g, '').trim()
}

function parsePdf417(raw: string): Cedula | null {
  // Primary: \x1E separator
  if (raw.includes(RS)) {
    const f = raw.split(RS)
    if (f.length >= 4) {
      const apellidos = cleanName(f[0])
      const nombres   = cleanName(f[1])
      const sexo      = /^[MF]$/.test(f[2]?.trim()) ? (f[2].trim() as 'M' | 'F') : undefined
      const cedula    = f[3]?.replace(/\D/g, '').slice(0, 12) ?? ''
      const rh        = f[4]?.trim() || undefined
      if (cedula.length >= 6 && apellidos) {
        return { cedula, nombres, apellidos, sexo, rh, modo: 'PDF417' }
      }
    }
  }
  // Fallback: ; | \n separators
  for (const sep of [';', '|', '\n']) {
    const fields = raw.split(sep).map(s => s.trim()).filter(Boolean)
    const ci = fields.findIndex(f => /^\d{6,12}$/.test(f))
    if (ci >= 2) {
      const apellidos = cleanName(fields[ci - 2])
      const nombres   = cleanName(fields[ci - 1])
      const cedula    = fields[ci]
      const sexo      = fields.find(f => /^[MF]$/.test(f)) as 'M' | 'F' | undefined
      if (apellidos) return { cedula, nombres, apellidos, sexo, modo: 'PDF417' }
    }
  }
  return null
}

// ── MRZ parser (cédula nueva TD1) ────────────────────────────────────────────
// Line 1: IDCOL + doc_number(5-13) + check...
// Line 2: YYMMDD(0-5) + check + sexo(7) + ...
// Line 3: APELLIDOS<<NOMBRES

function parseDob(yymmdd: string): { fechaNacimiento: string; edad: number } | null {
  if (!/^\d{6}$/.test(yymmdd)) return null
  const yy = parseInt(yymmdd.slice(0, 2))
  const mm = parseInt(yymmdd.slice(2, 4))
  const dd = parseInt(yymmdd.slice(4, 6))
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null
  const now = new Date()
  const fullYear = (2000 + yy) > now.getFullYear() ? 1900 + yy : 2000 + yy
  let edad = now.getFullYear() - fullYear
  if (now.getMonth() + 1 < mm || (now.getMonth() + 1 === mm && now.getDate() < dd)) edad--
  return {
    fechaNacimiento: `${fullYear}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`,
    edad: Math.max(0, edad),
  }
}

function parseMrz(ocrText: string): Cedula | null {
  const lines = ocrText
    .split('\n')
    .map(l => l.trim().toUpperCase().replace(/[^A-Z0-9<]/g, ''))
    .filter(l => l.length >= 28)

  const l1i = lines.findIndex(l =>
    l.startsWith('IDCOL') || l.startsWith('ID<COL') || l.startsWith('1DCOL') || l.startsWith('IDCO'),
  )
  if (l1i < 0 || l1i + 2 >= lines.length) return null

  const l1 = lines[l1i].padEnd(30, '<')
  const l2 = (lines[l1i + 1] ?? '').padEnd(30, '<')
  const l3 = (lines[l1i + 2] ?? '').padEnd(30, '<')

  const cedula = l1.slice(5, 14).replace(/</g, '').replace(/\D/g, '')
  if (cedula.length < 6) return null

  const dob  = parseDob(l2.slice(0, 6))
  const sc   = l2[7]
  const sexo: 'M' | 'F' | undefined = sc === 'M' ? 'M' : sc === 'F' ? 'F' : undefined

  const nameField = l3.replace(/<+$/, '')
  const sepI = nameField.indexOf('<<')
  let apellidos = '', nombres = ''
  if (sepI >= 0) {
    apellidos = nameField.slice(0, sepI).replace(/<+/g, ' ').trim()
    nombres   = nameField.slice(sepI + 2).replace(/<+/g, ' ').trim()
  } else {
    apellidos = nameField.replace(/<+/g, ' ').trim()
  }

  if (!apellidos) return null
  return { cedula, nombres, apellidos, sexo, modo: 'MRZ', ...(dob ?? {}) }
}

// ── ZXing hints ───────────────────────────────────────────────────────────────

const PDF417_HINTS = new Map<DecodeHintType, unknown>([
  [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.PDF_417]],
  [DecodeHintType.TRY_HARDER, true],
])

// ── Component ─────────────────────────────────────────────────────────────────

type ScanMode = 'PDF417' | 'MRZ'
type BannerType = 'ok' | 'dup' | 'err'

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

  // Scan state (refs to avoid stale closures in intervals)
  const activeRef     = useRef(false)
  const processingRef = useRef(false)
  const modeRef       = useRef<ScanMode>('PDF417')
  const mrzReadyRef   = useRef(false)
  const lastMrzRef    = useRef(0)
  const onDetectedRef = useRef<((c: Cedula) => void) | null>(null)
  const intervalRef   = useRef<ReturnType<typeof setInterval> | null>(null)

  // UI state
  const [mode,      setMode]      = useState<ScanMode>('PDF417')
  const [torchOn,   setTorchOn]   = useState(false)
  const [hasTorch,  setHasTorch]  = useState(false)
  const [mrzReady,  setMrzReady]  = useState(false)
  const [saving,    setSaving]    = useState(false)
  const [banner,    setBanner]    = useState<{ type: BannerType; msg: string } | null>(null)
  const [lastReg,   setLastReg]   = useState('')
  const [total,     setTotal]     = useState(0)
  const [evento,    setEvento]    = useState<Evento | null>(null)
  const [camError,  setCamError]  = useState<string | null>(null)
  const [showManual, setShowManual] = useState(false)
  const [manualForm, setManualForm] = useState({
    cedula: '', nombres: '', apellidos: '', fechaNacimiento: '', sexo: '' as 'M' | 'F' | '', rh: '',
  })
  const [manualSaving, setManualSaving] = useState(false)
  const [manualError,  setManualError]  = useState('')

  // Keep mode ref in sync
  useEffect(() => { modeRef.current = mode }, [mode])
  useEffect(() => { mrzReadyRef.current = mrzReady }, [mrzReady])

  // ── Detected handler ─────────────────────────────────────────────────────

  const handleDetected = useCallback(async (c: Cedula) => {
    if (processingRef.current || !activeRef.current) return
    processingRef.current = true
    activeRef.current = false
    setSaving(true)

    try {
      const dup = await checkDuplicado(eventoId, c.cedula)
      if (dup) {
        setBanner({ type: 'dup', msg: `⚠️ Ya registrado: ${c.apellidos} ${c.nombres}` })
      } else {
        await registrarAsistencia(eventoId, {
          cedula:          c.cedula,
          nombres:         c.nombres,
          apellidos:       c.apellidos,
          sexo:            c.sexo,
          fechaNacimiento: c.fechaNacimiento,
          edad:            c.edad,
          rh:              c.rh,
          modo:            c.modo,
        })
        const t = await getTotalAsistencias(eventoId)
        setTotal(t)
        setLastReg(`${c.apellidos} ${c.nombres}`)
        setBanner({ type: 'ok', msg: `✅ ${c.apellidos} ${c.nombres}${c.edad ? ` — ${c.edad} años` : ''}` })
      }
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string }
      setBanner({ type: 'err', msg: `Error (${e.code ?? '?'}): ${e.message ?? ''}` })
    } finally {
      setSaving(false)
      setTimeout(() => {
        setBanner(null)
        processingRef.current = false
        activeRef.current = true
      }, 3000)
    }
  }, [eventoId])

  useEffect(() => { onDetectedRef.current = handleDetected }, [handleDetected])

  // ── Tesseract init ────────────────────────────────────────────────────────

  useEffect(() => {
    let alive = true
    ;(async () => {
      const { createWorker } = await import('tesseract.js')
      const w = await createWorker('eng', 1, { logger: () => {} })
      await w.setParameters({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<' as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tessedit_pageseg_mode: '6' as any,
      })
      if (alive) { tesseractRef.current = w; setMrzReady(true) }
    })()
    return () => {
      alive = false
      tesseractRef.current?.terminate()
    }
  }, [])

  // ── Camera + scan interval ────────────────────────────────────────────────

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

        // Detect torch capability
        const caps = track.getCapabilities?.() as Record<string, unknown> | undefined
        if (caps && 'torch' in caps) {
          setHasTorch(true)
        } else {
          // Try applying torch to detect support
          try {
            await track.applyConstraints({ advanced: [{ torch: false } as MediaTrackConstraintSet] })
            setHasTorch(true)
          } catch { /* no torch */ }
        }

        const video = videoRef.current!
        video.srcObject = stream
        await video.play()

        const reader = new BrowserMultiFormatReader(PDF417_HINTS)
        readerRef.current = reader

        const canvas = canvasRef.current!
        const ctx    = canvas.getContext('2d', { willReadFrequently: true })!

        activeRef.current = true

        // Single interval at 400ms; MRZ only fires every 3 ticks (≈1200ms)
        intervalRef.current = setInterval(async () => {
          if (!alive || processingRef.current || !activeRef.current) return
          if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) return

          canvas.width  = video.videoWidth
          canvas.height = video.videoHeight
          ctx.drawImage(video, 0, 0)

          const m = modeRef.current

          if (m === 'PDF417') {
            try {
              const result = reader.decodeFromCanvas(canvas)
              const parsed = parsePdf417(result.getText())
              if (parsed) onDetectedRef.current?.(parsed)
            } catch { /* NotFoundException on empty frames */ } finally {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ;(reader as any).reader?.reset?.()
            }
            return
          }

          // MRZ: throttle to 1200ms
          if (m === 'MRZ' && mrzReadyRef.current) {
            const now = Date.now()
            if (now - lastMrzRef.current < 1200) return
            lastMrzRef.current = now

            // Crop bottom 40% (MRZ zone on the back of the card)
            const cropY = Math.floor(canvas.height * 0.60)
            const crop  = document.createElement('canvas')
            crop.width  = canvas.width
            crop.height = canvas.height - cropY
            crop.getContext('2d')!.drawImage(
              canvas, 0, cropY, canvas.width, crop.height,
              0, 0, canvas.width, crop.height,
            )

            try {
              const { data: { text } } = await tesseractRef.current!.recognize(crop)
              const parsed = parseMrz(text)
              if (parsed) onDetectedRef.current?.(parsed)
            } catch { /* OCR errors */ }
          }
        }, 400)

      } catch {
        if (alive) setCamError('No se pudo acceder a la cámara. Verifica los permisos.')
      }
    })()

    return () => {
      alive = false
      if (intervalRef.current) clearInterval(intervalRef.current)
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
    } catch { /* silently ignore if not supported */ }
  }, [torchOn])

  // ── Manual save ───────────────────────────────────────────────────────────

  const calcEdad = (fn: string) => {
    const [y, m, d] = fn.split('-').map(Number)
    const hoy = new Date()
    let edad = hoy.getFullYear() - y
    if (hoy.getMonth() + 1 < m || (hoy.getMonth() + 1 === m && hoy.getDate() < d)) edad--
    return Math.max(0, edad)
  }

  const handleManual = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!manualForm.cedula || !manualForm.nombres || !manualForm.apellidos ||
        !manualForm.fechaNacimiento || !manualForm.sexo) return
    setManualSaving(true)
    setManualError('')
    try {
      const dup = await checkDuplicado(eventoId, manualForm.cedula.trim())
      if (dup) { setManualError('Esta cédula ya está registrada en el evento'); return }
      const edad = calcEdad(manualForm.fechaNacimiento)
      await registrarAsistencia(eventoId, {
        cedula:          manualForm.cedula.trim(),
        nombres:         manualForm.nombres.trim(),
        apellidos:       manualForm.apellidos.trim(),
        fechaNacimiento: manualForm.fechaNacimiento,
        edad,
        sexo:            manualForm.sexo as 'M' | 'F',
        rh:              manualForm.rh.trim() || undefined,
        modo:            'MANUAL',
      })
      const t = await getTotalAsistencias(eventoId)
      setTotal(t)
      setLastReg(`${manualForm.apellidos} ${manualForm.nombres}`)
      setShowManual(false)
      setManualForm({ cedula: '', nombres: '', apellidos: '', fechaNacimiento: '', sexo: '', rh: '' })
      setBanner({ type: 'ok', msg: `✅ ${manualForm.apellidos} ${manualForm.nombres} — ${edad} años` })
      setTimeout(() => setBanner(null), 3000)
    } catch (err: unknown) {
      setManualError((err as { message?: string }).message ?? 'Error al guardar')
    } finally {
      setManualSaving(false)
    }
  }

  // ── Camera error screen ───────────────────────────────────────────────────

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
      {/* Camera video */}
      <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover" autoPlay playsInline muted />

      {/* Hidden canvas */}
      <canvas ref={canvasRef} className="hidden" />

      {/* ── Scan window overlay ─────────────────────────────────────────── */}
      <div className="absolute inset-0 pointer-events-none">
        <div
          style={{
            position:  'absolute',
            top:       '50%',
            left:      '50%',
            transform: 'translate(-50%, -60%)',
            width:     'min(88vw, 380px)',
            height:    'min(56vw, 240px)',
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.65)',
            borderRadius: 10,
            border:    '1.5px solid rgba(255,255,255,0.25)',
          }}
        >
          {/* Corner marks */}
          {(['top-0 left-0 border-t-2 border-l-2 rounded-tl',
             'top-0 right-0 border-t-2 border-r-2 rounded-tr',
             'bottom-0 left-0 border-b-2 border-l-2 rounded-bl',
             'bottom-0 right-0 border-b-2 border-r-2 rounded-br'] as const)
            .map((cls, i) => (
              <div key={i} className={`absolute w-6 h-6 border-white ${cls}`} />
            ))}
        </div>
        {/* Hint under window */}
        <p
          className="absolute w-full text-center text-white/55 text-xs px-8"
          style={{ top: '50%', transform: 'translateY(calc(-60% + min(29vw, 125px) + 12px))' }}
        >
          {mode === 'PDF417'
            ? 'Cédula VIEJA — apunta al FRENTE (código de barras)'
            : 'Cédula NUEVA — apunta al REVERSO (zona >>><<<)'}
        </p>
      </div>

      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <div className="absolute top-0 inset-x-0 z-10 flex items-start justify-between px-4 pt-10 pb-4">
        {/* Back + event info */}
        <div className="flex items-start gap-2">
          <button onClick={() => router.back()}
            className="w-10 h-10 rounded-full bg-black/55 backdrop-blur-md flex items-center justify-center text-white shrink-0">
            ←
          </button>
          <div className="bg-black/55 backdrop-blur-md rounded-2xl px-3 py-2 max-w-[55vw]">
            <p className="text-white font-semibold text-sm leading-tight truncate">{evento?.nombre ?? '…'}</p>
            <p className="text-zinc-400 text-xs mt-0.5">
              {total} registrado{total !== 1 ? 's' : ''}
            </p>
          </div>
        </div>

        {/* Right: OCR indicator + torch */}
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full mt-4 ${mrzReady ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`}
            title={mrzReady ? 'OCR listo' : 'Cargando OCR…'}
          />
          {/* Always show torch button — attempt toggle, fail silently */}
          <button
            onClick={toggleTorch}
            className={`w-11 h-11 rounded-full backdrop-blur-md flex items-center justify-center text-xl transition-all active:scale-90 ${
              torchOn ? 'bg-yellow-400/90 text-black' : 'bg-black/55 text-white'
            } ${!hasTorch ? 'opacity-40' : ''}`}
            title={hasTorch ? 'Linterna' : 'Linterna (no soportada)'}
          >
            ⚡
          </button>
        </div>
      </div>

      {/* ── Bottom bar ───────────────────────────────────────────────────── */}
      <div className="absolute bottom-0 inset-x-0 z-10 px-4 pt-4 pb-8 bg-gradient-to-t from-black/85 via-black/40 to-transparent">
        {/* Mode + flash + manual */}
        <div className="flex gap-2 mb-3">
          <button
            onClick={() => setMode('PDF417')}
            className={`flex-1 py-3.5 rounded-2xl text-sm font-semibold transition-all active:scale-95 ${
              mode === 'PDF417'
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/40'
                : 'bg-white/10 text-white/70 hover:bg-white/15'
            }`}
          >
            Frente
          </button>
          <button
            onClick={() => setMode('MRZ')}
            className={`flex-1 py-3.5 rounded-2xl text-sm font-semibold transition-all active:scale-95 ${
              mode === 'MRZ'
                ? 'bg-purple-600 text-white shadow-lg shadow-purple-600/40'
                : 'bg-white/10 text-white/70 hover:bg-white/15'
            }`}
          >
            Reverso
          </button>
          <button
            onClick={toggleTorch}
            className={`w-14 py-3.5 rounded-2xl text-base font-bold transition-all active:scale-95 ${
              torchOn ? 'bg-yellow-400 text-black' : 'bg-white/10 text-white/70'
            }`}
            title="Flash"
          >
            ⚡
          </button>
          <button
            onClick={() => setShowManual(true)}
            className="w-14 py-3.5 rounded-2xl text-base bg-white/10 text-white/70 hover:bg-white/15 transition-all active:scale-95"
            title="Registrar manualmente"
          >
            ✏️
          </button>
        </div>

        {lastReg && (
          <p className="text-center text-zinc-400 text-xs truncate">
            Último: <span className="text-white/90">{lastReg}</span>
          </p>
        )}
      </div>

      {/* ── Saving spinner ────────────────────────────────────────────────── */}
      {saving && (
        <div className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none">
          <div className="w-14 h-14 rounded-full border-2 border-white/20 border-t-white animate-spin" />
        </div>
      )}

      {/* ── Banner ────────────────────────────────────────────────────────── */}
      {banner && (
        <div className="absolute inset-x-5 z-30" style={{ top: '50%', transform: 'translateY(-50%)' }}>
          <div
            className={`rounded-2xl px-6 py-5 text-center shadow-2xl ${
              banner.type === 'ok'
                ? 'bg-emerald-600 text-white'
                : banner.type === 'dup'
                ? 'bg-amber-500 text-white'
                : 'bg-red-600 text-white'
            }`}
          >
            <p className="font-bold text-lg leading-snug">{banner.msg}</p>
          </div>
        </div>
      )}

      {/* ── Manual modal ──────────────────────────────────────────────────── */}
      {showManual && (
        <div className="absolute inset-0 z-40 flex items-end sm:items-center justify-center">
          <div className="absolute inset-0 bg-black/70" onClick={() => setShowManual(false)} />
          <div className="relative w-full max-w-md bg-[#18181b] border border-[#27272a] rounded-t-3xl sm:rounded-2xl p-6 max-h-[90dvh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-semibold text-white text-base">Registrar manualmente</h2>
              <button onClick={() => setShowManual(false)}
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
                  placeholder="1234567890" className={FIELD_M} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Nombres *</label>
                  <input required value={manualForm.nombres}
                    onChange={e => setManualForm(f => ({ ...f, nombres: e.target.value }))}
                    placeholder="Juan" className={FIELD_M} />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Apellidos *</label>
                  <input required value={manualForm.apellidos}
                    onChange={e => setManualForm(f => ({ ...f, apellidos: e.target.value }))}
                    placeholder="García" className={FIELD_M} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Fecha nacimiento *</label>
                  <input required type="date"
                    value={manualForm.fechaNacimiento}
                    onChange={e => setManualForm(f => ({ ...f, fechaNacimiento: e.target.value }))}
                    className={`${FIELD_M} [color-scheme:dark]`} />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Sexo *</label>
                  <select required value={manualForm.sexo}
                    onChange={e => setManualForm(f => ({ ...f, sexo: e.target.value as 'M' | 'F' | '' }))}
                    className={`${FIELD_M} [color-scheme:dark]`}>
                    <option value="">Seleccionar</option>
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
                  placeholder="O+" className={FIELD_M} />
              </div>

              {manualError && (
                <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">
                  {manualError}
                </p>
              )}

              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setShowManual(false)}
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
