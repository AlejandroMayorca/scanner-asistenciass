'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HTMLCanvasElementLuminanceSource,
  HybridBinarizer,
  MultiFormatReader,
} from '@zxing/library'
import { NotFoundException } from '@zxing/library'
import { parsePdf417 } from '../lib/pdf417Parser'
import { parseMrz } from '../lib/mrzParser'
import type { CedulaData } from '../lib/types'
import ScannerOverlay from './ScannerOverlay'
import ResultPanel from './ResultPanel'

const PDF417_HINTS = new Map<DecodeHintType, unknown>([
  [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.PDF_417]],
  [DecodeHintType.TRY_HARDER, true],
])

export default function CedulaScanner() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const readerRef = useRef<MultiFormatReader | null>(null)
  const tesseractWorkerRef = useRef<import('tesseract.js').Worker | null>(null)
  const scanningRef = useRef(true)
  const mrzBusyRef = useRef(false)
  const frameCountRef = useRef(0)

  const [result, setResult] = useState<CedulaData | null>(null)
  const [torchOn, setTorchOn] = useState(false)
  const [hasTorch, setHasTorch] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState('Coloca el REVERSO de la cédula dentro del recuadro')
  const [mrzReady, setMrzReady] = useState(false)

  // Init Tesseract worker once
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { createWorker } = await import('tesseract.js')
      const worker = await createWorker('eng', 1, {
        logger: () => {},
      })
      await worker.setParameters({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<' as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tessedit_pageseg_mode: '6' as any,
      })
      if (!cancelled) {
        tesseractWorkerRef.current = worker
        setMrzReady(true)
      }
    })()
    return () => {
      cancelled = true
      tesseractWorkerRef.current?.terminate()
    }
  }, [])

  // Start camera
  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        })
        if (!active) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream

        const track = stream.getVideoTracks()[0]
        const caps = track.getCapabilities?.() as Record<string, unknown> | undefined
        if (caps?.torch) setHasTorch(true)

        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }
      } catch {
        setError('No se pudo acceder a la cámara. Asegúrate de dar permiso.')
      }
    })()
    return () => {
      active = false
      streamRef.current?.getTracks().forEach(t => t.stop())
    }
  }, [])

  // ZXing reader instance
  useEffect(() => {
    const r = new MultiFormatReader()
    r.setHints(PDF417_HINTS)
    readerRef.current = r
  }, [])

  const handleResult = useCallback((data: CedulaData) => {
    if (!scanningRef.current) return
    scanningRef.current = false
    setResult(data)
  }, [])

  // Scanning loop
  useEffect(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return

    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return

    let rafId: number

    const tryZxing = (): boolean => {
      if (!readerRef.current) return false
      try {
        const lumSource = new HTMLCanvasElementLuminanceSource(canvas)
        const bitmap = new BinaryBitmap(new HybridBinarizer(lumSource))
        const res = readerRef.current.decodeWithState(bitmap)
        const cedula = parsePdf417(res.getText())
        if (cedula) { handleResult(cedula); return true }
      } catch (e) {
        if (!(e instanceof NotFoundException)) console.warn(e)
      } finally {
        readerRef.current?.reset()
      }
      return false
    }

    const tryMrz = async () => {
      if (mrzBusyRef.current || !tesseractWorkerRef.current) return
      mrzBusyRef.current = true
      try {
        // Crop to bottom 30% of canvas (where MRZ lives)
        const mrzCanvas = document.createElement('canvas')
        const cropY = Math.floor(canvas.height * 0.65)
        mrzCanvas.width = canvas.width
        mrzCanvas.height = canvas.height - cropY
        const mrzCtx = mrzCanvas.getContext('2d')!
        mrzCtx.drawImage(canvas, 0, cropY, canvas.width, mrzCanvas.height, 0, 0, canvas.width, mrzCanvas.height)

        const { data: { text } } = await tesseractWorkerRef.current.recognize(mrzCanvas)
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
        const cedula = parseMrz(lines)
        if (cedula) handleResult(cedula)
      } catch { /* ignore */ } finally {
        mrzBusyRef.current = false
      }
    }

    const loop = () => {
      if (!scanningRef.current) return

      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        ctx.drawImage(video, 0, 0)

        const frame = frameCountRef.current++

        // ZXing every frame (fast, synchronous)
        const found = tryZxing()

        // Tesseract every 15 frames when MRZ worker is ready
        if (!found && mrzReady && frame % 15 === 0) {
          tryMrz()
          setHint(frame % 30 === 0
            ? 'Cédula nueva: enfoca las dos líneas MRZ del reverso'
            : 'Cédula antigua: enfoca el código de barras del reverso')
        }
      }

      rafId = requestAnimationFrame(loop)
    }

    scanningRef.current = true
    frameCountRef.current = 0
    rafId = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mrzReady, handleResult])

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    const next = !torchOn
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] })
      setTorchOn(next)
    } catch { /* device doesn't support torch */ }
  }, [torchOn])

  const resetScanner = useCallback(() => {
    scanningRef.current = true
    mrzBusyRef.current = false
    frameCountRef.current = 0
    setResult(null)
    setHint('Coloca el REVERSO de la cédula dentro del recuadro')
  }, [])

  if (error) {
    return (
      <div className="flex h-dvh items-center justify-center bg-black p-6">
        <div className="rounded-2xl bg-white p-6 text-center max-w-sm">
          <p className="text-4xl mb-3">📷</p>
          <p className="font-semibold text-slate-800 mb-2">Sin acceso a la cámara</p>
          <p className="text-sm text-slate-500">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="relative w-full h-dvh bg-black overflow-hidden">
      {/* Camera feed */}
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-cover"
        autoPlay
        playsInline
        muted
      />

      {/* Hidden canvas for frame processing */}
      <canvas ref={canvasRef} className="hidden" />

      {/* Overlay with guide rect */}
      {!result && <ScannerOverlay hint={hint} />}

      {/* Top bar */}
      <div className="absolute top-0 inset-x-0 flex items-center justify-between px-4 pt-safe pt-4">
        <div className="rounded-full bg-black/40 px-3 py-1.5">
          <span className="text-white text-xs font-medium">
            {mrzReady ? '✓ MRZ + PDF417' : '⟳ Cargando MRZ…'}
          </span>
        </div>

        {hasTorch && (
          <button
            onClick={toggleTorch}
            className="w-11 h-11 rounded-full bg-black/40 flex items-center justify-center text-xl transition active:scale-90"
            aria-label="Linterna"
          >
            {torchOn ? '🔦' : '⚡'}
          </button>
        )}
      </div>

      {/* Result panel */}
      {result && <ResultPanel data={result} onScanAgain={resetScanner} />}
    </div>
  )
}
