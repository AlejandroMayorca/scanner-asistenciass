'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import { BrowserMultiFormatReader } from '@zxing/browser'
import { BarcodeFormat, DecodeHintType } from '@zxing/library'
import {
  collection, getDocs, addDoc, query, where,
  serverTimestamp, doc, getDoc, Timestamp,
} from 'firebase/firestore'
import { db } from '../../../../lib/firebase'
import type { Evento } from '../../../../lib/types'

// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── PDF417 Parser ─────────────────────────────────────────────────────────────
// Colombian cédula vieja: fields separated by \x1E (ASCII 30, Record Separator)
// Order: [0]=apellidos [1]=nombres [2]=sexo [3]=cedula [4]=rh ...

const RS = '\x1e'

function cleanName(s: string) {
  return s.replace(/[^A-Za-zÁÉÍÓÚáéíóúÑñ\s]/g, '').trim()
}

function parsePdf417(raw: string): Cedula | null {
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
  // Fallback: semicolon / newline delimiters (older barcode variants)
  for (const sep of [';', '\n', '|']) {
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

// ── MRZ Parser ────────────────────────────────────────────────────────────────
// Colombian cédula nueva TD1 MRZ (3 lines × 30 chars):
//   Line 1: IDCOL + doc_number(9) + check + optional(15)
//   Line 2: DOB(6) + check + sex(1) + expiry(6) + check + COL + optional + check
//   Line 3: APELLIDOS<<NOMBRES padded to 30

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
    l.startsWith('IDCOL') || l.startsWith('ID<COL') ||
    l.startsWith('1DCOL') || l.startsWith('IDCO'),
  )
  if (l1i < 0 || l1i + 2 >= lines.length) return null

  const l1 = lines[l1i].padEnd(30, '<')
  const l2 = (lines[l1i + 1] ?? '').padEnd(30, '<')
  const l3 = (lines[l1i + 2] ?? '').padEnd(30, '<')

  // Document number: line 1 positions 5–13
  const cedula = l1.slice(5, 14).replace(/</g, '').replace(/\D/g, '')
  if (cedula.length < 6) return null

  const dob   = parseDob(l2.slice(0, 6))
  const sc    = l2[7]
  const sexo: 'M' | 'F' | undefined = sc === 'M' ? 'M' : sc === 'F' ? 'F' : undefined

  // Names: line 3
  const nameField = l3.replace(/<+$/, '')
  const sepI      = nameField.indexOf('<<')
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

// ── Firestore helpers ─────────────────────────────────────────────────────────

async function checkDuplicado(eventoId: string, cedula: string): Promise<boolean> {
  const snap = await getDocs(
    query(collection(db, 'eventos', eventoId, 'asistencias'), where('cedula', '==', cedula)),
  )
  return !snap.empty
}

async function guardarAsistencia(eventoId: string, c: Cedula): Promise<void> {
  await addDoc(collection(db, 'eventos', eventoId, 'asistencias'), {
    cedula:           c.cedula,
    nombres:          c.nombres,
    apellidos:        c.apellidos,
    sexo:             c.sexo ?? null,
    fechaNacimiento:  c.fechaNacimiento ?? null,
    edad:             c.edad ?? null,
    rh:               c.rh ?? null,
    modo:             c.modo,
    fechaHora:        serverTimestamp(),
    eventoId,
  })
}

async function getTotal(eventoId: string): Promise<number> {
  const snap = await getDocs(collection(db, 'eventos', eventoId, 'asistencias'))
  return snap.size
}

function toDate(v: unknown): Date {
  if (v instanceof Timestamp) return v.toDate()
  if (v instanceof Date) return v
  return new Date()
}

// ── ZXing hints (PDF417 only) ─────────────────────────────────────────────────

const PDF417_HINTS = new Map<DecodeHintType, unknown>([
  [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.PDF_417]],
  [DecodeHintType.TRY_HARDER, true],
])

// ── Component ─────────────────────────────────────────────────────────────────

export default function ScannerPage() {
  const { id: eventoId } = useParams<{ id: string }>()

  // DOM refs
  const videoRef  = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Resources
  const trackRef     = useRef<MediaStreamTrack | null>(null)
  const readerRef    = useRef<BrowserMultiFormatReader | null>(null)
  const tesseractRef = useRef<import('tesseract.js').Worker | null>(null)

  // Scan-loop control (all via refs to avoid stale closures in RAF)
  const rafRef        = useRef<number>(0)
  const activeRef     = useRef(false)
  const processingRef = useRef(false)
  const modeRef       = useRef<'PDF417' | 'MRZ'>('PDF417')
  const mrzReadyRef   = useRef(false)
  const mrzBusyRef    = useRef(false)
  const autoSwitchRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastMrzMsRef  = useRef(0)

  // Stable callback ref — always points to the latest handleDetected
  const onDetectedRef = useRef<((c: Cedula) => void) | null>(null)

  // UI state
  const [mode,     setMode]     = useState<'PDF417' | 'MRZ'>('PDF417')
  const [torchOn,  setTorchOn]  = useState(false)
  const [hasTorch, setHasTorch] = useState(false)
  const [mrzReady, setMrzReady] = useState(false)
  const [saving,   setSaving]   = useState(false)
  const [banner,   setBanner]   = useState<{ type: 'ok' | 'dup'; msg: string } | null>(null)
  const [lastReg,  setLastReg]  = useState('')
  const [evento,   setEvento]   = useState<Evento | null>(null)
  const [total,    setTotal]    = useState(0)
  const [camError, setCamError] = useState<string | null>(null)

  // Sync mutable refs with state so the scan loop sees them
  useEffect(() => { modeRef.current    = mode    }, [mode])
  useEffect(() => { mrzReadyRef.current = mrzReady }, [mrzReady])

  // ── Auto-switch helper ─────────────────────────────────────────────────────

  const scheduleAutoSwitch = useCallback(() => {
    if (autoSwitchRef.current) clearTimeout(autoSwitchRef.current)
    autoSwitchRef.current = setTimeout(() => {
      if (!processingRef.current) {
        modeRef.current = 'MRZ'
        setMode('MRZ')
      }
    }, 2000)
  }, [])

  // ── handleDetected ────────────────────────────────────────────────────────

  const handleDetected = useCallback(async (c: Cedula) => {
    if (processingRef.current || !activeRef.current) return
    processingRef.current = true
    activeRef.current = false
    if (autoSwitchRef.current) { clearTimeout(autoSwitchRef.current); autoSwitchRef.current = null }
    setSaving(true)

    try {
      const dup = await checkDuplicado(eventoId, c.cedula)
      if (dup) {
        setBanner({ type: 'dup', msg: `⚠️ Ya registrado: ${c.apellidos}` })
      } else {
        await guardarAsistencia(eventoId, c)
        const t = await getTotal(eventoId)
        setTotal(t)
        setLastReg(`${c.apellidos} ${c.nombres}`)
        setBanner({ type: 'ok', msg: `✅ Registrado: ${c.nombres} ${c.apellidos}` })
      }
    } catch {
      setBanner({ type: 'dup', msg: '⚠️ Error al guardar' })
    } finally {
      setSaving(false)
      setTimeout(() => {
        setBanner(null)
        processingRef.current = false
        modeRef.current = 'PDF417'
        setMode('PDF417')
        activeRef.current = true
        scheduleAutoSwitch()
      }, 2000)
    }
  }, [eventoId, scheduleAutoSwitch])

  // Keep the ref in sync so the scan loop can call it
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
    return () => { alive = false; tesseractRef.current?.terminate() }
  }, [])

  // ── Camera + scan loop ────────────────────────────────────────────────────

  useEffect(() => {
    let alive = true
    let rafId = 0

    ;(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width:  { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        })
        if (!alive) { stream.getTracks().forEach(t => t.stop()); return }

        const track = stream.getVideoTracks()[0]
        trackRef.current = track
        const caps = track.getCapabilities?.() as Record<string, unknown> | undefined
        if (caps?.torch) setHasTorch(true)

        const video  = videoRef.current!
        video.srcObject = stream
        await video.play()

        const reader = new BrowserMultiFormatReader(PDF417_HINTS)
        readerRef.current = reader
        const canvas = canvasRef.current!
        const ctx    = canvas.getContext('2d', { willReadFrequently: true })!

        activeRef.current = true
        scheduleAutoSwitch()

        const loop = () => {
          if (!alive) return
          rafId = requestAnimationFrame(loop)

          if (processingRef.current || !activeRef.current) return
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
            } catch { /* NotFoundException — expected on every empty frame */ }
            finally {
              // Reset internal MultiFormatReader state for next frame
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ;(reader as any).reader?.reset?.()
            }
            return
          }

          if (m === 'MRZ' && mrzReadyRef.current && !mrzBusyRef.current) {
            const now = performance.now()
            if (now - lastMrzMsRef.current >= 1500) {
              lastMrzMsRef.current = now
              mrzBusyRef.current = true
              // Crop bottom 35% where MRZ is located on the card
              const cropY = Math.floor(canvas.height * 0.65)
              const crop  = document.createElement('canvas')
              crop.width  = canvas.width
              crop.height = canvas.height - cropY
              crop.getContext('2d')!.drawImage(
                canvas, 0, cropY, canvas.width, crop.height,
                0, 0, canvas.width, crop.height,
              )
              tesseractRef.current!.recognize(crop)
                .then(({ data: { text } }) => {
                  const parsed = parseMrz(text)
                  if (parsed) onDetectedRef.current?.(parsed)
                })
                .catch(() => {})
                .finally(() => { mrzBusyRef.current = false })
            }
          }
        }

        rafId = requestAnimationFrame(loop)
      } catch {
        if (alive) setCamError('No se pudo acceder a la cámara')
      }
    })()

    return () => {
      alive = false
      cancelAnimationFrame(rafId)
      trackRef.current?.stop()
      if (autoSwitchRef.current) clearTimeout(autoSwitchRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Fetch evento data ─────────────────────────────────────────────────────

  useEffect(() => {
    if (!eventoId) return
    getDoc(doc(db, 'eventos', eventoId))
      .then(snap => { if (snap.exists()) setEvento({ id: snap.id, ...snap.data() } as Evento) })
    getTotal(eventoId).then(setTotal)
  }, [eventoId])

  // ── Mode switching (manual) ───────────────────────────────────────────────

  const switchMode = useCallback((newMode: 'PDF417' | 'MRZ') => {
    if (processingRef.current) return
    if (autoSwitchRef.current) { clearTimeout(autoSwitchRef.current); autoSwitchRef.current = null }
    modeRef.current = newMode
    setMode(newMode)
    if (newMode === 'PDF417') scheduleAutoSwitch()
  }, [scheduleAutoSwitch])

  // ── Torch toggle ──────────────────────────────────────────────────────────

  const toggleTorch = useCallback(async () => {
    if (!trackRef.current) return
    const next = !torchOn
    try {
      await trackRef.current.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] })
      setTorchOn(next)
    } catch { /* device doesn't support torch */ }
  }, [torchOn])

  // ── Render ────────────────────────────────────────────────────────────────

  if (camError) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center z-50 p-6">
        <div className="bg-[#18181b] border border-[#27272a] rounded-2xl p-6 text-center max-w-xs w-full">
          <p className="text-4xl mb-3">📷</p>
          <p className="text-white font-semibold mb-1">Sin acceso a la cámara</p>
          <p className="text-zinc-400 text-sm">{camError}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-black z-50 overflow-hidden select-none">
      {/* Live camera video */}
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-cover"
        autoPlay
        playsInline
        muted
      />
      {/* Hidden canvas for frame capture */}
      <canvas ref={canvasRef} className="hidden" />

      {/* ── Cutout overlay ──────────────────────────────────────────────── */}
      <div className="absolute inset-0 pointer-events-none">
        {/*
          Box-shadow trick: the div itself is the transparent cutout area;
          the massive box-shadow darkens everything outside it.
        */}
        <div
          style={{
            position:  'absolute',
            top:       '50%',
            left:      '50%',
            transform: 'translate(-50%, -62%)',
            width:     'min(88vw, 380px)',
            height:    'min(56vw, 240px)',
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.62)',
            borderRadius: 10,
            border:    '1.5px solid rgba(255,255,255,0.22)',
          }}
        >
          {/* Corner markers */}
          {(
            [
              'top-0 left-0 border-t-2 border-l-2 rounded-tl',
              'top-0 right-0 border-t-2 border-r-2 rounded-tr',
              'bottom-0 left-0 border-b-2 border-l-2 rounded-bl',
              'bottom-0 right-0 border-b-2 border-r-2 rounded-br',
            ] as const
          ).map((cls, i) => (
            <div key={i} className={`absolute w-6 h-6 border-white ${cls}`} />
          ))}
        </div>

        {/* Mode hint below the cutout */}
        <p
          className="absolute w-full text-center text-white/60 text-xs px-8"
          style={{
            top:       '50%',
            transform: `translateY(calc(-62% + min(29vw, 125px) + 14px))`,
          }}
        >
          {mode === 'PDF417'
            ? 'Cédula VIEJA — apunta al FRENTE (código de barras PDF417)'
            : 'Cédula NUEVA — apunta al REVERSO (zona MRZ con >><<<)'}
        </p>
      </div>

      {/* ── Top bar ────────────────────────────────────────────────────────── */}
      <div className="absolute top-0 inset-x-0 z-10 flex items-start justify-between px-4 pt-10 pb-4">
        {/* Event info */}
        <div className="bg-black/55 backdrop-blur-md rounded-2xl px-3 py-2 max-w-[55vw]">
          <p className="text-white font-semibold text-sm leading-tight truncate">
            {evento?.nombre ?? '…'}
          </p>
          <p className="text-zinc-400 text-xs mt-0.5">
            {total} registrado{total !== 1 ? 's' : ''}
          </p>
        </div>

        {/* Status + torch */}
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full ${mrzReady ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`}
            title={mrzReady ? 'OCR listo' : 'Cargando OCR…'}
          />
          {hasTorch && (
            <button
              onClick={toggleTorch}
              className={`w-11 h-11 rounded-full backdrop-blur-md flex items-center justify-center text-lg transition-all active:scale-90 ${
                torchOn ? 'bg-yellow-400/90 text-black' : 'bg-black/55 text-white'
              }`}
              aria-label="Linterna"
            >
              ⚡
            </button>
          )}
        </div>
      </div>

      {/* ── Bottom bar ─────────────────────────────────────────────────────── */}
      <div className="absolute bottom-0 inset-x-0 z-10 px-4 pt-6 pb-8 bg-gradient-to-t from-black/80 via-black/40 to-transparent">
        {/* Mode buttons + flash */}
        <div className="flex gap-2 mb-3">
          <button
            onClick={() => switchMode('PDF417')}
            className={`flex-1 py-3.5 rounded-2xl text-sm font-semibold transition-all active:scale-95 ${
              mode === 'PDF417'
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/40'
                : 'bg-white/10 text-white/70 hover:bg-white/15'
            }`}
          >
            Frente (PDF417)
          </button>
          <button
            onClick={() => switchMode('MRZ')}
            className={`flex-1 py-3.5 rounded-2xl text-sm font-semibold transition-all active:scale-95 ${
              mode === 'MRZ'
                ? 'bg-purple-600 text-white shadow-lg shadow-purple-600/40'
                : 'bg-white/10 text-white/70 hover:bg-white/15'
            }`}
          >
            Reverso (MRZ)
          </button>
          {hasTorch && (
            <button
              onClick={toggleTorch}
              className={`w-14 py-3.5 rounded-2xl text-base font-bold transition-all active:scale-95 ${
                torchOn ? 'bg-yellow-400 text-black' : 'bg-white/10 text-white/70'
              }`}
              aria-label="Flash"
            >
              ⚡
            </button>
          )}
        </div>

        {/* Last registered */}
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

      {/* ── Result banner ─────────────────────────────────────────────────── */}
      {banner && (
        <div className="absolute inset-x-5 z-30" style={{ top: '50%', transform: 'translateY(-50%)' }}>
          <div
            className={`rounded-2xl px-6 py-5 text-center shadow-2xl ${
              banner.type === 'ok'
                ? 'bg-emerald-600 text-white'
                : 'bg-amber-500 text-white'
            }`}
          >
            <p className="font-bold text-lg leading-snug">{banner.msg}</p>
          </div>
        </div>
      )}
    </div>
  )
}
