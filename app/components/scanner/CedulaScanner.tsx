'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BarcodeFormat, BinaryBitmap, DecodeHintType,
  HTMLCanvasElementLuminanceSource, HybridBinarizer,
  MultiFormatReader, NotFoundException,
} from '@zxing/library'
import { parsePdf417 } from '../../lib/pdf417Parser'
import { parseMrz } from '../../lib/mrzParser'
import { checkYaRegistrado, registrarAsistente } from '../../lib/firestore'
import type { CedulaData } from '../../lib/types'
import { ScannerOverlay } from './ScannerOverlay'
import { Zap, ZapOff, CheckCircle, AlertCircle, X } from 'lucide-react'
import { Spinner } from '../ui/Spinner'

const HINTS = new Map<DecodeHintType, unknown>([
  [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.PDF_417]],
  [DecodeHintType.TRY_HARDER, true],
])

type Phase = 'scanning' | 'confirming' | 'saving' | 'success' | 'duplicate'

interface Props {
  eventId: string
  onRegistered?: () => void
}

export function CedulaScanner({ eventId, onRegistered }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const readerRef = useRef(new MultiFormatReader())
  const tesseractRef = useRef<import('tesseract.js').Worker | null>(null)
  const scanningRef = useRef(true)
  const mlkitBusy = useRef(false)
  const frameCount = useRef(0)

  const [phase, setPhase] = useState<Phase>('scanning')
  const [cedula, setCedula] = useState<CedulaData | null>(null)
  const [torchOn, setTorchOn] = useState(false)
  const [hasTorch, setHasTorch] = useState(false)
  const [mrzReady, setMrzReady] = useState(false)
  const [hint, setHint] = useState('Apunta al REVERSO de la cédula')
  const [error, setError] = useState<string | null>(null)

  // Init ZXing hints once
  useEffect(() => {
    readerRef.current.setHints(HINTS)
  }, [])

  // Init Tesseract
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

  // Camera
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        })
        if (!alive) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream
        const track = stream.getVideoTracks()[0]
        if ((track.getCapabilities?.() as Record<string, unknown>)?.torch) setHasTorch(true)
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play() }
      } catch { setError('No se pudo acceder a la cámara') }
    })()
    return () => { alive = false; streamRef.current?.getTracks().forEach(t => t.stop()) }
  }, [])

  const handleFound = useCallback((data: CedulaData) => {
    if (!scanningRef.current) return
    scanningRef.current = false
    setCedula(data)
    setPhase('confirming')
  }, [])

  // Scan loop
  useEffect(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    let rafId: number

    const tryZxing = (): boolean => {
      try {
        const src = new HTMLCanvasElementLuminanceSource(canvas)
        const res = readerRef.current.decodeWithState(new BinaryBitmap(new HybridBinarizer(src)))
        const data = parsePdf417(res.getText())
        if (data) { handleFound(data); return true }
      } catch (e) { if (!(e instanceof NotFoundException)) console.warn(e) }
      finally { readerRef.current.reset() }
      return false
    }

    const tryMrz = async () => {
      if (mlkitBusy.current || !tesseractRef.current) return
      mlkitBusy.current = true
      try {
        const crop = document.createElement('canvas')
        const cropY = Math.floor(canvas.height * 0.65)
        crop.width = canvas.width; crop.height = canvas.height - cropY
        crop.getContext('2d')!.drawImage(canvas, 0, cropY, canvas.width, crop.height, 0, 0, canvas.width, crop.height)
        const { data: { text } } = await tesseractRef.current.recognize(crop)
        const data = parseMrz(text.split('\n').map(l => l.trim()).filter(Boolean))
        if (data) handleFound(data)
      } catch { /* ignore */ } finally { mlkitBusy.current = false }
    }

    const loop = () => {
      if (!scanningRef.current) return
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        canvas.width = video.videoWidth; canvas.height = video.videoHeight
        ctx.drawImage(video, 0, 0)
        const n = frameCount.current++
        if (!tryZxing() && mrzReady && n % 15 === 0) {
          tryMrz()
          setHint(n % 30 === 0 ? 'Cédula nueva: enfoca las líneas MRZ del reverso' : 'Cédula antigua: enfoca el código de barras')
        }
      }
      rafId = requestAnimationFrame(loop)
    }
    scanningRef.current = true
    rafId = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafId)
  }, [mrzReady, handleFound])

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    const next = !torchOn
    try { await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] }); setTorchOn(next) }
    catch { /* no flash */ }
  }, [torchOn])

  const reset = useCallback(() => {
    setCedula(null); setPhase('scanning')
    scanningRef.current = true; mlkitBusy.current = false; frameCount.current = 0
    setHint('Apunta al REVERSO de la cédula')
  }, [])

  const confirmar = async () => {
    if (!cedula) return
    setPhase('saving')
    try {
      const dup = await checkYaRegistrado(eventId, cedula.numeroCedula)
      if (dup) { setPhase('duplicate'); return }
      await registrarAsistente({
        eventId,
        numeroCedula: cedula.numeroCedula,
        nombres: cedula.nombres,
        apellidos: cedula.apellidos,
        sexo: cedula.sexo,
        edad: cedula.edad,
        fechaNacimiento: cedula.fechaNacimiento,
        horaIngreso: new Date(),
        tipoCedula: cedula.tipo,
      })
      setPhase('success')
      onRegistered?.()
      setTimeout(reset, 2200)
    } catch { setPhase('confirming') }
  }

  if (error) {
    return (
      <div className="flex h-dvh items-center justify-center bg-[#09090b] p-6">
        <div className="bg-[#18181b] border border-[#27272a] rounded-2xl p-6 text-center max-w-sm">
          <AlertCircle className="mx-auto mb-3 text-red-400" size={40} />
          <p className="font-semibold text-white mb-1">Sin acceso a la cámara</p>
          <p className="text-sm text-zinc-400">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="relative w-full h-dvh bg-black overflow-hidden">
      <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover" autoPlay playsInline muted />
      <canvas ref={canvasRef} className="hidden" />

      {phase === 'scanning' && <ScannerOverlay hint={hint} scanning={true} />}

      {/* Top bar */}
      <div className="absolute top-0 inset-x-0 flex items-center justify-between px-4 pt-4 pb-2 z-10">
        <div className="rounded-full bg-black/50 backdrop-blur px-3 py-1.5 flex items-center gap-1.5">
          <div className={`w-1.5 h-1.5 rounded-full ${mrzReady ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`} />
          <span className="text-white/80 text-xs">{mrzReady ? 'MRZ + PDF417' : 'Cargando MRZ…'}</span>
        </div>
        {hasTorch && (
          <button onClick={toggleTorch} className="w-11 h-11 rounded-full bg-black/50 backdrop-blur flex items-center justify-center text-white transition active:scale-90">
            {torchOn ? <Zap size={20} className="text-yellow-400" /> : <ZapOff size={20} />}
          </button>
        )}
      </div>

      {/* Confirmation / result overlay */}
      {(phase === 'confirming' || phase === 'saving' || phase === 'success' || phase === 'duplicate') && cedula && (
        <div className="absolute inset-0 flex items-end justify-center p-4 z-20 bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-[#18181b] border border-[#27272a] rounded-2xl p-5 animate-slideUp">
            {phase === 'success' ? (
              <div className="text-center py-4">
                <CheckCircle className="mx-auto mb-3 text-emerald-400" size={48} />
                <p className="text-lg font-bold text-white">{cedula.apellidos}</p>
                <p className="text-zinc-400">{cedula.nombres}</p>
                <p className="text-blue-400 font-mono mt-1">{cedula.numeroCedula}</p>
                <p className="text-emerald-400 text-sm mt-3 font-medium">✓ Registro exitoso</p>
              </div>
            ) : phase === 'duplicate' ? (
              <div className="text-center py-4">
                <AlertCircle className="mx-auto mb-3 text-amber-400" size={40} />
                <p className="font-semibold text-white mb-1">Ya registrado</p>
                <p className="text-zinc-400 text-sm">{cedula.apellidos} {cedula.nombres}</p>
                <p className="text-zinc-500 text-sm font-mono">{cedula.numeroCedula}</p>
                <button onClick={reset} className="mt-4 w-full py-2.5 rounded-xl bg-white/10 text-white text-sm font-medium hover:bg-white/15 transition">
                  Escanear otra
                </button>
              </div>
            ) : (
              <>
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <p className="text-xs text-zinc-500 mb-0.5">Cédula {cedula.tipo}</p>
                    <p className="text-lg font-bold text-white">{cedula.apellidos}</p>
                    <p className="text-zinc-300">{cedula.nombres}</p>
                    <p className="text-blue-400 font-mono text-sm mt-1">{cedula.numeroCedula}</p>
                  </div>
                  <button onClick={reset} className="p-1 text-zinc-500 hover:text-white">
                    <X size={20} />
                  </button>
                </div>
                {(cedula.edad || cedula.sexo) && (
                  <div className="flex gap-2 mb-4">
                    {cedula.sexo && <span className="px-2 py-1 rounded-md bg-white/5 text-xs text-zinc-400">{cedula.sexo === 'M' ? '♂ Masculino' : '♀ Femenino'}</span>}
                    {cedula.edad && <span className="px-2 py-1 rounded-md bg-white/5 text-xs text-zinc-400">{cedula.edad} años</span>}
                  </div>
                )}
                <div className="flex gap-3">
                  <button onClick={reset} className="flex-1 py-2.5 rounded-xl border border-[#27272a] text-zinc-400 text-sm font-medium hover:bg-white/5 transition">
                    Cancelar
                  </button>
                  <button onClick={confirmar} disabled={phase === 'saving'} className="flex-1 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-500 transition disabled:opacity-50 flex items-center justify-center gap-2">
                    {phase === 'saving' ? <><Spinner size="sm" /> Guardando…</> : 'Confirmar ingreso'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
