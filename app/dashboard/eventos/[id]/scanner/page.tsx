'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { doc, getDoc, onSnapshot, collection } from 'firebase/firestore'
import { db } from '../../../../lib/firebase'
import { registrarAsistencia, checkDuplicado, registrarLog } from '../../../../lib/firestore'
import { useAuth } from '../../../../context/AuthContext'
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

type ScanMode = 'PDF417' | 'MRZ'
type Screen   = 'select' | 'scan'

interface Cedula {
  cedula: string; nombres: string; apellidos: string
  sexo?: 'M' | 'F'; fechaNacimiento?: string; edad?: number; rh?: string
  modo: 'PDF417' | 'MRZ'
}

interface ConfirmForm {
  cedula: string; nombres: string; apellidos: string
  sexo: 'M'|'F'|''; fechaNacimiento: string; rh: string
  modo: 'PDF417'|'MRZ'|'MANUAL'; rawText?: string
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
  const apellido1 = cleanName(clean(raw.substring(58,  80)))
  const apellido2 = cleanName(clean(raw.substring(81,  104)))
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
    sexo:      sexoChar === 'M' || sexoChar === 'F' ? sexoChar as 'M'|'F' : undefined,
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
    const ap2 = cleanName((segs[i+1] ?? '').replace(/\x00/g, '').trim())
    const nm1 = cleanName((segs[i+2] ?? '').replace(/\x00/g, '').trim())
    let   nm2 = cleanName((segs[i+3] ?? '').replace(/\x00/g, '').trim())
    const ds  = segs[i+4] ?? ''
    if (!ap1 && !nm1) continue
    if (/[-+]$/.test(nm2)) nm2 = ''
    const sexoChar = ds[1]
    const rh       = ds.substring(16, 18).replace(/\x00/g, '').trim()
    return {
      cedula:    rawDoc,
      nombres:   [nm1, nm2].filter(Boolean).join(' '),
      apellidos: [ap1, ap2].filter(Boolean).join(' '),
      sexo:      sexoChar === 'M' || sexoChar === 'F' ? sexoChar as 'M'|'F' : undefined,
      rh:        rh || undefined,
      modo:      'PDF417',
      ...buildFecha(ds.substring(2,6), ds.substring(6,8), ds.substring(8,10)) ?? {},
    }
  }
  return null
}

const RS = '\x1e'

function parseFechaPdf(raw: string): { fechaNacimiento: string; edad: number } | null {
  const c = raw.replace(/\D/g, '')
  if (c.length !== 8) return null
  return buildFecha(c.slice(0,4), c.slice(4,6), c.slice(6,8))
}

function parsePdf417Legacy(raw: string): Cedula | null {
  if (!raw || raw.length < 10) return null
  if (raw.includes(RS)) {
    const f = raw.split(RS).map(s => s.trim())
    if (f.length >= 4) {
      const cedula = (f[3] ?? '').replace(/\D/g, '').slice(0, 12)
      if (cedula.length < 5) return null
      return {
        cedula, apellidos: cleanName(f[0]), nombres: cleanName(f[1]),
        sexo: /^[MF]$/i.test(f[2]??'') ? f[2].toUpperCase() as 'M'|'F' : undefined,
        rh: f[4]?.trim() || undefined, modo: 'PDF417',
        ...(f[5] ? parseFechaPdf(f[5])??{} : {}),
      }
    }
  }
  for (const sep of [';','|',',','\n']) {
    if (!raw.includes(sep)) continue
    const fields = raw.split(sep).map(s => s.trim()).filter(Boolean)
    const ci = fields.findIndex(f => /^\d{6,12}$/.test(f))
    if (ci >= 2) {
      const cedula = fields[ci], apellidos = cleanName(fields[ci-2]), nombres = cleanName(fields[ci-1])
      const sexo = fields.find(f => /^[MF]$/i.test(f))?.toUpperCase() as 'M'|'F'|undefined
      const rh = fields.find(f => /^[ABO][+-]$/i.test(f))
      const fnacStr = fields.find(f => /^\d{8}$/.test(f) && f !== cedula)
      if (apellidos && cedula) return { cedula, nombres, apellidos, sexo, rh, modo: 'PDF417', ...(fnacStr ? parseFechaPdf(fnacStr)??{} : {}) }
    }
  }
  return null
}

// ─── MRZ parsers ──────────────────────────────────────────────────────────────

function cleanMrzName(s: string): string {
  return capitalize(s.replace(/<+/g, ' ').replace(/[^A-Za-z\s]/g, '').trim())
}

function correctMrzOcr(text: string): string {
  const fixed = text.replace(/C0L/g, 'COL')
  return fixed.split('\n').map(line => {
    const t = line.trim()
    if (t.length >= 20 && /[0-9<]{8,}/.test(t) && !/ {2,}/.test(t) && !/[A-Z]{4,}/.test(t.replace(/COL/g,'')))
      return t.replace(/O/g, '0').replace(/I/g, '1')
    return line
  }).join('\n')
}

function parseMrzLines(_l1: string, l2: string, l3: string): Cedula | null {
  const l2up   = l2.toUpperCase().replace(/C0L/g, 'COL')
  const colIdx = l2up.indexOf('COL')
  if (colIdx < 0) return null
  const numBefore = l2up.slice(0, colIdx).replace(/O/g,'0').replace(/I/g,'1')
  const numAfter  = l2up.slice(colIdx+3).replace(/O/g,'0').replace(/I/g,'1')
  const yy = parseInt(numBefore.slice(0,2)), mm = parseInt(numBefore.slice(2,4)), dd = parseInt(numBefore.slice(4,6))
  const sc = numBefore[7]
  const sexo: 'M'|'F'|undefined = sc==='M' ? 'M' : sc==='F' ? 'F' : undefined
  const cedula = numAfter.match(/^(\d{5,12})/)?.[1] ?? ''
  if (cedula.length < 5) return null
  let fechaNacimiento: string|undefined, edad: number|undefined
  if (mm>=1 && mm<=12 && dd>=1 && dd<=31) {
    const fy = yy>30 ? 1900+yy : 2000+yy
    fechaNacimiento = `${fy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`
    edad = calcEdad(fechaNacimiento)
  }
  const nameRaw = l3.toUpperCase().replace(/<+$/,'')
  const dblIdx  = nameRaw.indexOf('<<')
  const apellidos = dblIdx>=0 ? cleanMrzName(nameRaw.slice(0,dblIdx)) : cleanMrzName(nameRaw)
  const nombres   = dblIdx>=0 ? cleanMrzName(nameRaw.slice(dblIdx+2)) : ''
  return { cedula, nombres, apellidos, sexo, fechaNacimiento, edad, modo: 'MRZ' }
}

function parseMrzText(raw: string): Cedula | null {
  const corrected = correctMrzOcr(raw.replace(/C0L/g,'COL'))
  const upper = corrected.toUpperCase()
  const byNL    = upper.split(/[\n\r]+/).map(l => l.trim().replace(/[^A-Z0-9<]/g,'')).filter(l => l.length>=10)
  const bySpace = upper.split(/[\n\r ]+/).map(l => l.trim().replace(/[^A-Z0-9<]/g,'')).filter(l => l.length>=10)
  const lines   = bySpace.length > byNL.length ? bySpace : byNL
  if (lines.length === 0) return null
  for (const pfx of ['ICCOL','IDCOL','IC<COL','ID<COL']) {
    const i = lines.findIndex(l => l.startsWith(pfx))
    if (i>=0 && i+2<lines.length) { const r=parseMrzLines(lines[i],lines[i+1].padEnd(30,'<'),lines[i+2]); if(r) return r }
  }
  const l2i = lines.findIndex(l => /^\d{7}[MF0]/.test(l))
  if (l2i>=0 && l2i+1<lines.length) { const r=parseMrzLines(l2i>0?lines[l2i-1]:'',lines[l2i].padEnd(30,'<'),lines[l2i+1]); if(r) return r }
  const l3i = lines.findIndex(l => l.includes('<<'))
  if (l3i>=1) { const r=parseMrzLines(l3i>=2?lines[l3i-2]:'',lines[l3i-1].padEnd(30,'<'),lines[l3i]); if(r) return r }
  return null
}

function parseMrzRegex(text: string): Cedula | null {
  const fixed = text.replace(/C0L/g,'COL')
  const up = fixed.toUpperCase().replace(/[^A-Z0-9<\n\r ]/g,' ')
  const m1 = up.match(/COL(\d{5,12})/)
  if (!m1) return null
  const cedula = m1[1]
  const lines = up.split(/[\n\r ]+/).filter(l => l.length>=10)
  let fechaNacimiento: string|undefined, edad: number|undefined, sexo: 'M'|'F'|undefined
  for (const line of lines) {
    if (!line.includes('COL')) continue
    const num = line.slice(0,8).replace(/O/g,'0').replace(/I/g,'1')
    const yy=parseInt(num.slice(0,2)), mm=parseInt(num.slice(2,4)), dd=parseInt(num.slice(4,6))
    if (mm>=1&&mm<=12&&dd>=1&&dd<=31) {
      const fy=yy>30?1900+yy:2000+yy
      fechaNacimiento=`${fy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;edad=calcEdad(fechaNacimiento)
    }
    const sc=num[7]; sexo=sc==='M'?'M':sc==='F'?'F':undefined; break
  }
  let apellidos='', nombres=''
  for (const line of lines) {
    const di=line.indexOf('<<'); if(di<0) continue
    apellidos=cleanMrzName(line.slice(0,di)); nombres=cleanMrzName(line.slice(di+2)); break
  }
  if (!apellidos) { const m3=up.match(/([A-Z]{2}[A-Z<]+)<<([A-Z<]*)/); if(m3){apellidos=cleanMrzName(m3[1]);nombres=cleanMrzName(m3[2])} }
  return { cedula, apellidos, nombres, sexo, fechaNacimiento, edad, modo: 'MRZ' }
}

export function debugPdf417Positions(raw: string): string {
  const vis = (s: string) => s.replace(/\x00/g,'□')
  return [`len=${raw.length}`,`p48-58:"${vis(raw.substring(48,58))}"`,`p58-80:"${vis(raw.substring(58,80))}"`,`nulls=${(raw.match(/\x00/g)??[]).length}`,`segs=${raw.replace(/\x00{2,}/g,'\x00').split('\x00').length}`].join(' | ')
}

// ─── Component ────────────────────────────────────────────────────────────────

const FIELD = 'w-full bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500 transition'

export default function ScannerPage() {
  const { id: eventoId } = useParams<{ id: string }>()
  const router = useRouter()
  const { user, displayName } = useAuth()

  // Screen state
  const [screen,   setScreen]   = useState<Screen>('select')
  const [scanMode, setScanMode] = useState<ScanMode>('PDF417')

  // Camera
  const videoRef  = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [cameraOn,   setCameraOn]   = useState(false)
  const [cameraErr,  setCameraErr]  = useState('')
  const [flashAvail, setFlashAvail] = useState(false)
  const [flashOn,    setFlashOn]    = useState(false)

  // OCR (Tesseract — only for MRZ mode)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workerRef   = useRef<any>(null)
  const workerReady = useRef(false)
  const [tReady, setTReady] = useState(false)

  // Processing
  const [processing,  setProcessing]  = useState(false)
  const [scanState,   setScanState]   = useState<'idle'|'ok'|'fail'>('idle')
  const [tooDark,     setTooDark]     = useState(false)
  const [ocrFails,    setOcrFails]    = useState(0)
  const [log,         setLog]         = useState<string[]>([])

  // App state
  const toastTimer = useRef<ReturnType<typeof setTimeout>|null>(null)
  const [toast,         setToast]         = useState<{color:string;msg:string}|null>(null)
  const [confirmForm,   setConfirmForm]   = useState<ConfirmForm|null>(null)
  const [confirmSaving, setConfirmSaving] = useState(false)
  const [confirmError,  setConfirmError]  = useState('')
  const [total,         setTotal]         = useState(0)
  const [evento,        setEvento]        = useState<Evento|null>(null)
  const [showManual,    setShowManual]    = useState(false)
  const [manualForm,    setManualForm]    = useState({ cedula:'', nombres:'', apellidos:'', fechaNacimiento:'', sexo:'' as 'M'|'F'|'', rh:'' })
  const [manualSaving,  setManualSaving]  = useState(false)
  const [manualError,   setManualError]   = useState('')

  const addLog = useCallback((m: string) => { console.log(m); setLog(p => [...p.slice(-6), m]) }, [])

  // ── Camera: start when entering scan screen ────────────────────────────────
  useEffect(() => {
    if (screen !== 'scan') return
    let alive = true
    setCameraOn(false); setCameraErr('')

    navigator.mediaDevices?.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    })
      .then(stream => {
        if (!alive) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream
        if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play().catch(() => {}) }
        const track = stream.getVideoTracks()[0]
        const caps  = track.getCapabilities?.() as Record<string,unknown>|undefined
        if (caps && 'torch' in caps) setFlashAvail(true)
        setCameraOn(true)
      })
      .catch(err => {
        if (alive) setCameraErr(err instanceof Error ? err.message : 'Sin acceso a cámara')
      })

    return () => {
      alive = false
      streamRef.current?.getTracks().forEach(t => t.stop())
      streamRef.current = null
      setCameraOn(false)
      setFlashAvail(false)
      setFlashOn(false)
    }
  }, [screen])

  // ── Ambient light check ────────────────────────────────────────────────────
  useEffect(() => {
    if (!cameraOn) return
    const cv = document.createElement('canvas'); cv.width=50; cv.height=50
    const cx = cv.getContext('2d')!
    const id = setInterval(() => {
      const v = videoRef.current
      if (!v || v.readyState < 2) return
      cx.drawImage(v, 0, 0, 50, 50)
      const d = cx.getImageData(0,0,50,50).data
      let s = 0; for (let i=0; i<d.length; i+=4) s += d[i]*0.299+d[i+1]*0.587+d[i+2]*0.114
      setTooDark(s/2500 < 35)
    }, 1800)
    return () => clearInterval(id)
  }, [cameraOn])

  // ── Tesseract (only when in MRZ mode) ─────────────────────────────────────
  useEffect(() => {
    if (scanMode !== 'MRZ') return
    let alive = true
    ;(async () => {
      if (workerReady.current) return
      try {
        const { createWorker, PSM } = await import('tesseract.js')
        const w = await createWorker('eng', 1, { logger: ()=>{} })
        await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<' })
        if (!alive) { await w.terminate(); return }
        workerRef.current = w; workerReady.current = true; setTReady(true)
      } catch { /* unavailable */ }
    })()
    return () => { alive = false }
  }, [scanMode])

  // ── Cleanup Tesseract on unmount ───────────────────────────────────────────
  useEffect(() => {
    return () => {
      workerRef.current?.terminate?.()
      if (toastTimer.current) clearTimeout(toastTimer.current)
    }
  }, [])

  // ── Firebase ───────────────────────────────────────────────────────────────
  useEffect(() => { if (!eventoId) return; return onSnapshot(collection(db,'eventos',eventoId,'asistencias'), s => setTotal(s.size)) }, [eventoId])
  useEffect(() => { if (!eventoId) return; getDoc(doc(db,'eventos',eventoId)).then(s => { if(s.exists()) setEvento({id:s.id,...s.data()} as Evento) }) }, [eventoId])

  // ── Toast ──────────────────────────────────────────────────────────────────
  const showToast = useCallback((color: string, msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({color, msg})
    toastTimer.current = setTimeout(() => setToast(null), 3200)
  }, [])

  // ── Flash ──────────────────────────────────────────────────────────────────
  const toggleFlash = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    try { const n=!flashOn; await track.applyConstraints({advanced:[{torch:n} as MediaTrackConstraintSet]}); setFlashOn(n) } catch { /* unsupported */ }
  }, [flashOn])

  // ── Core: process canvas ───────────────────────────────────────────────────
  const processCanvas = useCallback(async (canvas: HTMLCanvasElement) => {
    const base64 = canvas.toDataURL('image/jpeg', 0.93).split(',')[1]
    addLog(`foto ${canvas.width}×${canvas.height} | ${Math.round(base64.length/1024)}kb`)

    let detected: Cedula|null = null
    let rawText: string|undefined

    // ── API call ─────────────────────────────────────────────────────────────
    try {
      addLog('→ /api/scan…')
      const res = await fetch('/api/scan', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({imageBase64:base64}) })
      const data = await res.json() as { success:boolean; text?:string; parsed?:{cedula:string;apellido1:string;apellido2:string;nombre1:string;nombre2:string;sexo:string;anioNac:string;mesNac:string;diaNac:string;rh:string}; error?:string; logs?:string[] }
      for (const l of data.logs??[]) addLog(l)

      if (data.success && data.text) {
        rawText = data.text
        if (data.parsed?.cedula) {
          const p = data.parsed
          detected = {
            cedula:    p.cedula,
            nombres:   cleanName([p.nombre1,p.nombre2].filter(Boolean).join(' ')),
            apellidos: cleanName([p.apellido1,p.apellido2].filter(Boolean).join(' ')),
            sexo:      p.sexo==='M'||p.sexo==='F' ? p.sexo as 'M'|'F' : undefined,
            rh:        p.rh||undefined,
            modo:      'PDF417',
            ...buildFecha(p.anioNac,p.mesNac,p.diaNac)??{},
          }
          addLog(`✓ srv: ${p.cedula} ${p.apellido1}`)
        } else {
          addLog(`txt: ${data.text.replace(/\x00/g,'□').slice(0,80)}`)
          addLog(debugPdf417Positions(data.text))
          const r1=parsePdf417Binario(data.text), r2=r1?null:parsePdf417NullSplit(data.text), r3=(r1||r2)?null:parsePdf417Legacy(data.text)
          detected = r1??r2??r3??parseMrzText(data.text)??parseMrzRegex(data.text)
          addLog(`bin=${r1?'✓':'✗'} null=${r2?'✓':'✗'} leg=${r3?'✓':'✗'} → ${detected?detected.cedula:'nada'}`)
        }
      } else { addLog(`api: ${data.error??'sin barcode'}`) }
    } catch(e) { addLog(`api err: ${String(e).slice(0,60)}`) }

    // ── Tesseract MRZ fallback (only in MRZ mode) ─────────────────────────────
    if (!detected && scanMode==='MRZ' && workerReady.current && workerRef.current) {
      try {
        const sy=Math.floor(canvas.height*0.5), sh=Math.floor(canvas.height*0.5)
        const ct=document.createElement('canvas'); ct.width=canvas.width; ct.height=sh
        const cx=ct.getContext('2d')!
        cx.filter='contrast(2.5) brightness(1.3) grayscale(1)'
        cx.drawImage(canvas,0,sy,canvas.width,sh,0,0,canvas.width,sh)
        cx.filter='none'
        const {data:{text}} = await workerRef.current.recognize(ct)
        addLog(`ocr: ${text.trim().slice(0,60)}`)
        detected = parseMrzText(text)??parseMrzRegex(text)
        if (detected) { addLog(`✓ ocr: ${detected.cedula}`); setOcrFails(0) }
        else {
          const nf=ocrFails+1; setOcrFails(nf); addLog(`ocr fallo ${nf}/2`)
          if (nf>=2) {
            setOcrFails(0); setScanState('fail'); setProcessing(false)
            setConfirmForm({cedula:text.match(/\d{6,12}/)?.[0]??'',nombres:'',apellidos:'',sexo:'',fechaNacimiento:'',rh:'',modo:'MRZ',rawText:text.trim().slice(0,300)})
            return
          }
        }
      } catch(e) { addLog(`ocr err: ${String(e).slice(0,50)}`) }
    }

    // ── Result ────────────────────────────────────────────────────────────────
    if (!detected || detected.cedula.length<5) {
      setScanState('fail')
      if (rawText) {
        setConfirmForm({cedula:rawText.match(/\d{6,12}/)?.[0]??'',nombres:'',apellidos:'',sexo:'',fechaNacimiento:'',rh:'',modo:scanMode,rawText:rawText.replace(/\x00/g,'').slice(0,200)})
      } else {
        showToast('#ef4444','❌ No se detectó. Intenta de nuevo')
      }
      setProcessing(false); return
    }

    const dup = await checkDuplicado(eventoId, detected.cedula)
    if (dup) { setScanState('fail'); showToast('#f59e0b',`⚠️ Ya registrado: ${detected.apellidos}`); setProcessing(false); return }

    setScanState('ok')
    setConfirmForm({cedula:detected.cedula,nombres:detected.nombres,apellidos:detected.apellidos,sexo:detected.sexo??'',fechaNacimiento:detected.fechaNacimiento??'',rh:detected.rh??'',modo:detected.modo})
    setProcessing(false)
  }, [eventoId, scanMode, showToast, addLog, ocrFails])

  // ── Capture: draw from live video into canvas ──────────────────────────────
  const handleCapture = useCallback(async () => {
    if (processing) return
    const v = videoRef.current
    if (!v || !v.videoWidth) { showToast('#ef4444','❌ Cámara no lista'); return }
    setProcessing(true); setScanState('idle'); setLog([])
    const canvas = document.createElement('canvas')
    canvas.width = v.videoWidth; canvas.height = v.videoHeight
    canvas.getContext('2d')!.drawImage(v, 0, 0)
    await processCanvas(canvas)
  }, [processing, processCanvas, showToast])

  // ── Confirm save ───────────────────────────────────────────────────────────
  const handleConfirm = async () => {
    if (!confirmForm) return
    setConfirmSaving(true); setConfirmError('')
    try {
      const edad = confirmForm.fechaNacimiento ? calcEdad(confirmForm.fechaNacimiento) : 0
      const asistenciaId = await registrarAsistencia(eventoId, { cedula:confirmForm.cedula, nombres:confirmForm.nombres, apellidos:confirmForm.apellidos, fechaNacimiento:confirmForm.fechaNacimiento, edad, sexo:(confirmForm.sexo||undefined) as 'M'|'F'|undefined, rh:confirmForm.rh, modo:confirmForm.modo, registradoPor:displayName, operadorUid:user?.uid??'' })
      registrarLog({ tipo:'REGISTRO', eventoId, eventoNombre:evento?.nombre??'', asistenciaId, cedula:confirmForm.cedula, nombreAsistente:`${confirmForm.apellidos} ${confirmForm.nombres}`.trim(), operadorUid:user?.uid??'', operadorNombre:displayName, operadorEmail:user?.email??'', detalles:`Modo: ${confirmForm.modo}`, ip:'' })
      showToast('#22c55e',`✅ ${confirmForm.apellidos} ${confirmForm.nombres}`)
      setConfirmForm(null); setLog([])
    } catch(e:unknown) { setConfirmError((e as {message?:string}).message??'Error al guardar') }
    finally { setConfirmSaving(false) }
  }

  // ── Manual save ────────────────────────────────────────────────────────────
  const handleManual = async (e: React.FormEvent) => {
    e.preventDefault()
    const {cedula,nombres,apellidos,fechaNacimiento,sexo,rh} = manualForm
    if (!cedula||!nombres||!apellidos||!fechaNacimiento||!sexo) return
    setManualSaving(true); setManualError('')
    try {
      if (await checkDuplicado(eventoId,cedula.trim())) { setManualError('Cédula ya registrada'); return }
      const asistenciaId = await registrarAsistencia(eventoId,{cedula:cedula.trim(),nombres:capitalize(nombres.trim()),apellidos:capitalize(apellidos.trim()),fechaNacimiento,edad:calcEdad(fechaNacimiento),sexo:sexo as 'M'|'F',rh:rh.trim(),modo:'MANUAL',registradoPor:displayName,operadorUid:user?.uid??''})
      registrarLog({ tipo:'REGISTRO', eventoId, eventoNombre:evento?.nombre??'', asistenciaId, cedula:cedula.trim(), nombreAsistente:`${capitalize(apellidos.trim())} ${capitalize(nombres.trim())}`.trim(), operadorUid:user?.uid??'', operadorNombre:displayName, operadorEmail:user?.email??'', detalles:'Modo: MANUAL', ip:'' })
      showToast('#22c55e',`✅ ${capitalize(apellidos.trim())} ${capitalize(nombres.trim())}`)
      setShowManual(false); setManualForm({cedula:'',nombres:'',apellidos:'',fechaNacimiento:'',sexo:'',rh:''})
    } catch(e:unknown) { setManualError((e as {message?:string}).message??'Error') }
    finally { setManualSaving(false) }
  }

  const frameColor = scanState==='ok' ? '#4ade80' : scanState==='fail' ? '#f87171' : '#22c55e'

  // ── SELECT SCREEN ──────────────────────────────────────────────────────────
  if (screen === 'select') {
    return (
      <div style={{position:'fixed',inset:0,background:'#000',zIndex:50,display:'flex',flexDirection:'column',userSelect:'none'}}>
        <style>{`@keyframes fadein{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}.fadein{animation:fadein 0.3s ease}`}</style>

        {/* top bar */}
        <div style={{background:'linear-gradient(to bottom,rgba(0,0,0,0.9),transparent)',padding:'44px 16px 20px',display:'flex',alignItems:'center',gap:12}}>
          <button onClick={()=>router.back()} style={{width:38,height:38,borderRadius:'50%',background:'rgba(255,255,255,0.1)',border:'none',color:'#fff',fontSize:22,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>‹</button>
          <div style={{flex:1,minWidth:0}}>
            <p style={{color:'#fff',fontWeight:600,fontSize:14,margin:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{evento?.nombre??'…'}</p>
            <p style={{color:'#4ade80',fontWeight:700,fontSize:15,margin:0}}>{total} asistente{total!==1?'s':''}</p>
          </div>
          {displayName && (
            <div style={{background:'rgba(255,255,255,0.06)',border:'1px solid #27272a',borderRadius:10,padding:'3px 10px',flexShrink:0}}>
              <p style={{color:'#a1a1aa',fontSize:9,margin:0}}>Operador</p>
              <p style={{color:'#fff',fontSize:11,fontWeight:600,margin:0,maxWidth:80,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{displayName}</p>
            </div>
          )}
        </div>

        {/* center content */}
        <div className="fadein" style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'0 24px',gap:20}}>
          <div style={{textAlign:'center',marginBottom:8}}>
            <p style={{color:'#a1a1aa',fontSize:13,margin:0}}>Selecciona el tipo de cédula a escanear</p>
          </div>

          {/* PDF417 button */}
          <button onClick={()=>{setScanMode('PDF417');setScreen('scan')}}
            style={{width:'100%',maxWidth:360,background:'linear-gradient(135deg,#1d4ed8,#2563eb)',border:'2px solid rgba(96,165,250,0.3)',borderRadius:20,padding:'22px 24px',cursor:'pointer',textAlign:'left',display:'flex',gap:16,alignItems:'flex-start',boxShadow:'0 8px 32px rgba(37,99,235,0.3)',transition:'transform 0.15s',userSelect:'none'}}
            onTouchStart={e=>(e.currentTarget.style.transform='scale(0.97)')}
            onTouchEnd={e=>(e.currentTarget.style.transform='scale(1)')}>
            <div style={{fontSize:36,lineHeight:1,flexShrink:0}}>📷</div>
            <div>
              <p style={{color:'#fff',fontWeight:700,fontSize:17,margin:'0 0 4px'}}>Cédula VIEJA</p>
              <p style={{color:'#93c5fd',fontSize:12,margin:'0 0 8px',lineHeight:1.4}}>Emitida antes de 2016 · código de barras PDF417 en el reverso</p>
              <span style={{background:'rgba(96,165,250,0.2)',color:'#93c5fd',fontSize:10,fontWeight:700,padding:'3px 8px',borderRadius:20}}>PDF417</span>
            </div>
          </button>

          {/* MRZ button */}
          <button onClick={()=>{setScanMode('MRZ');setScreen('scan')}}
            style={{width:'100%',maxWidth:360,background:'linear-gradient(135deg,#14532d,#16a34a)',border:'2px solid rgba(74,222,128,0.3)',borderRadius:20,padding:'22px 24px',cursor:'pointer',textAlign:'left',display:'flex',gap:16,alignItems:'flex-start',boxShadow:'0 8px 32px rgba(22,163,74,0.3)',transition:'transform 0.15s',userSelect:'none'}}
            onTouchStart={e=>(e.currentTarget.style.transform='scale(0.97)')}
            onTouchEnd={e=>(e.currentTarget.style.transform='scale(1)')}>
            <div style={{fontSize:36,lineHeight:1,flexShrink:0}}>📷</div>
            <div>
              <p style={{color:'#fff',fontWeight:700,fontSize:17,margin:'0 0 4px'}}>Cédula NUEVA</p>
              <p style={{color:'#86efac',fontSize:12,margin:'0 0 8px',lineHeight:1.4}}>Emitida desde 2016 · franja MRZ (código de barras) en el frente</p>
              <span style={{background:'rgba(74,222,128,0.2)',color:'#86efac',fontSize:10,fontWeight:700,padding:'3px 8px',borderRadius:20}}>MRZ</span>
            </div>
          </button>

          {/* manual entry */}
          <button onClick={()=>{setShowManual(true)}} style={{marginTop:8,color:'#71717a',fontSize:13,background:'none',border:'none',cursor:'pointer',textDecoration:'underline'}}>
            ✏️ Registrar manualmente sin escanear
          </button>
        </div>

        {/* manual modal (same as scanner) */}
        {showManual && (
          <div style={{position:'absolute',inset:0,zIndex:60,display:'flex',alignItems:'flex-end',justifyContent:'center'}}>
            <div style={{position:'absolute',inset:0,background:'rgba(0,0,0,0.75)'}} onClick={()=>{setShowManual(false);setManualError('')}}/>
            <div style={{position:'relative',width:'100%',maxWidth:480,background:'#111',borderRadius:'24px 24px 0 0',borderTop:'1px solid #27272a',maxHeight:'90dvh',overflowY:'auto'}}>
              <div style={{width:36,height:4,background:'#3f3f46',borderRadius:2,margin:'12px auto 0'}}/>
              <div style={{padding:'16px 20px',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                <h2 style={{color:'#fff',fontSize:16,fontWeight:600,margin:0}}>✏️ Registrar manualmente</h2>
                <button onClick={()=>{setShowManual(false);setManualError('')}} style={{width:30,height:30,borderRadius:8,border:'none',background:'rgba(255,255,255,0.08)',color:'#71717a',cursor:'pointer',fontSize:14}}>✕</button>
              </div>
              <form onSubmit={handleManual} style={{padding:'0 20px 28px',display:'flex',flexDirection:'column',gap:12}}>
                <div><label style={{display:'block',color:'#71717a',fontSize:11,marginBottom:6}}>🪪 Cédula *</label><input required inputMode="numeric" value={manualForm.cedula} onChange={e=>setManualForm(f=>({...f,cedula:e.target.value}))} placeholder="1234567890" className={FIELD}/></div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                  <div><label style={{display:'block',color:'#71717a',fontSize:11,marginBottom:6}}>👤 Nombres *</label><input required value={manualForm.nombres} onChange={e=>setManualForm(f=>({...f,nombres:e.target.value}))} placeholder="Juan" className={FIELD}/></div>
                  <div><label style={{display:'block',color:'#71717a',fontSize:11,marginBottom:6}}>👥 Apellidos *</label><input required value={manualForm.apellidos} onChange={e=>setManualForm(f=>({...f,apellidos:e.target.value}))} placeholder="García" className={FIELD}/></div>
                </div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                  <div><label style={{display:'block',color:'#71717a',fontSize:11,marginBottom:6}}>📅 Nacimiento *</label><input required type="date" value={manualForm.fechaNacimiento} onChange={e=>setManualForm(f=>({...f,fechaNacimiento:e.target.value}))} style={{colorScheme:'dark'}} className={FIELD}/></div>
                  <div><label style={{display:'block',color:'#71717a',fontSize:11,marginBottom:6}}>⚧ Sexo *</label><select required value={manualForm.sexo} onChange={e=>setManualForm(f=>({...f,sexo:e.target.value as 'M'|'F'|''}))} style={{colorScheme:'dark'}} className={FIELD}><option value="">—</option><option value="M">Masculino</option><option value="F">Femenino</option></select></div>
                </div>
                {manualForm.fechaNacimiento && <p style={{color:'#52525b',fontSize:11,margin:0}}>Edad: <strong style={{color:'#fff'}}>{calcEdad(manualForm.fechaNacimiento)} años</strong></p>}
                <div><label style={{display:'block',color:'#71717a',fontSize:11,marginBottom:6}}>🩸 RH</label><input value={manualForm.rh} onChange={e=>setManualForm(f=>({...f,rh:e.target.value}))} placeholder="O+" className={FIELD}/></div>
                {manualError && <p style={{color:'#f87171',fontSize:12,background:'rgba(248,113,113,0.08)',border:'1px solid rgba(248,113,113,0.25)',borderRadius:10,padding:'8px 12px',margin:0}}>{manualError}</p>}
                <div style={{display:'flex',gap:10,paddingTop:4}}>
                  <button type="button" onClick={()=>{setShowManual(false);setManualError('')}} style={{flex:1,padding:'13px 0',borderRadius:14,border:'1px solid #27272a',background:'transparent',color:'#71717a',fontSize:13,cursor:'pointer'}}>Cancelar</button>
                  <button type="submit" disabled={manualSaving} style={{flex:2,padding:'13px 0',borderRadius:14,border:'none',background:'#16a34a',color:'#fff',fontSize:13,fontWeight:700,cursor:manualSaving?'default':'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:8,opacity:manualSaving?0.7:1}}>
                    {manualSaving?<><div style={{width:14,height:14,border:'2px solid rgba(255,255,255,0.3)',borderTopColor:'#fff',borderRadius:'50%',animation:'spin 0.7s linear infinite'}}/>Guardando…</>:'Registrar'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── SCAN SCREEN ────────────────────────────────────────────────────────────
  return (
    <div style={{position:'fixed',inset:0,background:'#000',zIndex:50,overflow:'hidden',display:'flex',flexDirection:'column',userSelect:'none'}}>
      <style>{`
        @keyframes scan { 0%{transform:translateY(0px);opacity:1} 90%{opacity:1} 100%{transform:translateY(280px);opacity:0} }
        @keyframes corner-pulse { 0%{opacity:0.7} 100%{opacity:1} }
        @keyframes sweep { 0%{transform:translateY(-100%)} 100%{transform:translateY(200%)} }
        @keyframes fadein { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
        @keyframes slideup { from{transform:translateY(100%)} to{transform:translateY(0)} }
        @keyframes spin { to{transform:rotate(360deg)} }
        .scan-line { animation:scan 2s linear infinite; }
        .corner    { animation:corner-pulse 1s ease-in-out infinite alternate; }
        .sweep     { animation:sweep 1.4s ease-in-out infinite; }
        .fadein    { animation:fadein 0.25s ease; }
        .slideup   { animation:slideup 0.28s cubic-bezier(0.32,0.72,0,1); }
        .spin      { animation:spin 0.7s linear infinite; }
      `}</style>

      {/* live video */}
      <video ref={videoRef} autoPlay playsInline muted
        style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover',opacity:cameraOn?1:0}}/>

      {/* no-camera fallback */}
      {!cameraOn && (
        <div style={{position:'absolute',inset:0,background:'radial-gradient(ellipse at center,#0d0d0d,#000)',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:12}}>
          {cameraErr
            ? <><div style={{fontSize:40}}>🚫</div><p style={{color:'#ef4444',fontSize:13,textAlign:'center',maxWidth:260,padding:'0 16px'}}>{cameraErr}</p></>
            : <div className="spin" style={{width:32,height:32,border:'3px solid rgba(34,197,94,0.2)',borderTopColor:'#22c55e',borderRadius:'50%'}}/>}
        </div>
      )}

      {/* ── Top bar ───────────────────────────────────────────────────── */}
      <div style={{position:'absolute',top:0,left:0,right:0,zIndex:20,background:'linear-gradient(to bottom,rgba(0,0,0,0.88),transparent)',padding:'44px 16px 20px',display:'flex',alignItems:'center',gap:10}}>
        <button onClick={()=>{setScreen('select');setLog([]);setScanState('idle')}} style={{width:38,height:38,borderRadius:'50%',background:'rgba(255,255,255,0.1)',border:'none',color:'#fff',fontSize:22,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>‹</button>
        <div style={{flex:1,minWidth:0}}>
          <p style={{color:'#fff',fontWeight:600,fontSize:13,margin:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{evento?.nombre??'…'}</p>
          <p style={{color:'#4ade80',fontWeight:700,fontSize:14,margin:0}}>{total} asistente{total!==1?'s':''}{displayName&&<span style={{color:'#71717a',fontWeight:400,fontSize:11}}> · {displayName}</span>}</p>
        </div>
        {/* mode badge + change */}
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <span style={{fontSize:10,padding:'4px 10px',borderRadius:20,fontWeight:700,background:scanMode==='PDF417'?'rgba(59,130,246,0.25)':'rgba(34,197,94,0.25)',color:scanMode==='PDF417'?'#93c5fd':'#86efac'}}>
            {scanMode}
          </span>
          <button onClick={()=>{setScreen('select');setLog([]);setScanState('idle')}} style={{fontSize:10,padding:'4px 10px',borderRadius:20,fontWeight:600,background:'rgba(255,255,255,0.1)',border:'none',color:'#a1a1aa',cursor:'pointer'}}>
            cambiar
          </button>
          {scanMode==='MRZ' && (
            <div style={{fontSize:10,padding:'3px 8px',borderRadius:20,fontWeight:700,background:tReady?'rgba(34,197,94,0.15)':'rgba(255,255,255,0.08)',color:tReady?'#4ade80':'#71717a'}}>
              OCR {tReady?'✓':'…'}
            </div>
          )}
        </div>
      </div>

      {/* ── Scanner frame ─────────────────────────────────────────────── */}
      <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',paddingTop:90,paddingBottom:190}}>
        <div style={{position:'relative',width:'88%',maxWidth:380,aspectRatio:'85/54'}}>
          {/* vignette */}
          <div style={{position:'absolute',inset:0,borderRadius:8,pointerEvents:'none',boxShadow:'0 0 0 100vmax rgba(0,0,0,0.55)'}}/>
          {/* scan line */}
          {!processing && (
            <div style={{position:'absolute',inset:0,overflow:'hidden',borderRadius:8}}>
              <div className="scan-line" style={{position:'absolute',left:'6%',right:'6%',height:2,top:0,background:'linear-gradient(90deg,transparent,#ef4444 25%,#ff5555 50%,#ef4444 75%,transparent)',boxShadow:'0 0 10px 3px rgba(239,68,68,0.55)'}}/>
            </div>
          )}
          {/* processing */}
          {processing && (
            <div style={{position:'absolute',inset:0,borderRadius:8,background:'rgba(0,0,0,0.55)',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:12,overflow:'hidden'}}>
              <div className="sweep" style={{position:'absolute',left:0,right:0,height:'50%',background:'linear-gradient(180deg,transparent,rgba(34,197,94,0.12),transparent)'}}/>
              <div className="spin" style={{width:40,height:40,border:'3px solid rgba(34,197,94,0.25)',borderTopColor:'#22c55e',borderRadius:'50%',zIndex:1}}/>
              <p style={{color:'#4ade80',fontSize:13,fontWeight:600,zIndex:1}}>Leyendo cédula…</p>
            </div>
          )}
          {/* corners */}
          {([
            {top:0,left:0,borderTop:`4px solid ${frameColor}`,borderLeft:`4px solid ${frameColor}`,borderRadius:'3px 0 0 0',delay:'0s'},
            {top:0,right:0,borderTop:`4px solid ${frameColor}`,borderRight:`4px solid ${frameColor}`,borderRadius:'0 3px 0 0',delay:'0.25s'},
            {bottom:0,left:0,borderBottom:`4px solid ${frameColor}`,borderLeft:`4px solid ${frameColor}`,borderRadius:'0 0 0 3px',delay:'0.5s'},
            {bottom:0,right:0,borderBottom:`4px solid ${frameColor}`,borderRight:`4px solid ${frameColor}`,borderRadius:'0 0 3px 0',delay:'0.75s'},
          ] as const).map((c,i) => (
            <div key={i} className="corner" style={{position:'absolute',width:38,height:38,filter:`drop-shadow(0 0 6px ${frameColor}99)`,animationDelay:c.delay,...c as React.CSSProperties}}/>
          ))}
        </div>
      </div>

      {/* ── Instruction ───────────────────────────────────────────────── */}
      <div style={{position:'absolute',top:'58%',left:0,right:0,textAlign:'center',zIndex:10}}>
        <p style={{color:'rgba(255,255,255,0.6)',fontSize:11,margin:0,padding:'0 24px'}}>
          {scanMode==='PDF417'
            ? 'Enfoca el REVERSO de la cédula dentro del marco'
            : 'Enfoca la parte inferior del FRENTE de la cédula'}
        </p>
      </div>

      {/* ── Bottom bar ────────────────────────────────────────────────── */}
      <div style={{position:'absolute',bottom:0,left:0,right:0,zIndex:20,background:'linear-gradient(to top,rgba(0,0,0,0.95) 55%,transparent)',paddingBottom:'env(safe-area-inset-bottom,24px)',display:'flex',flexDirection:'column',alignItems:'center'}}>
        {tooDark && <p style={{color:'#fbbf24',fontSize:11,fontWeight:600,marginBottom:4}}>💡 Necesitas más luz</p>}
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',width:'100%',padding:'12px 40px 28px'}}>
          {/* flash */}
          {flashAvail
            ? <button onClick={toggleFlash} disabled={processing} style={{width:54,height:54,borderRadius:'50%',border:'none',cursor:'pointer',fontSize:22,background:flashOn?'#facc15':'rgba(255,255,255,0.1)',color:flashOn?'#000':'#fff',display:'flex',alignItems:'center',justifyContent:'center',transition:'all 0.2s'}}>⚡</button>
            : <div style={{width:54,height:54}}/>}

          {/* CAPTURAR */}
          <button onClick={handleCapture} disabled={processing||!cameraOn}
            style={{width:82,height:82,borderRadius:'50%',border:'4px solid rgba(74,222,128,0.45)',background:processing?'#15803d':'#16a34a',cursor:(processing||!cameraOn)?'default':'pointer',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:2,boxShadow:'0 0 28px rgba(34,197,94,0.45)',transition:'all 0.15s',opacity:(processing||!cameraOn)?0.65:1}}>
            {processing
              ? <div className="spin" style={{width:28,height:28,border:'3px solid rgba(255,255,255,0.3)',borderTopColor:'#fff',borderRadius:'50%'}}/>
              : <><span style={{fontSize:26,lineHeight:1}}>📸</span><span style={{color:'#fff',fontSize:9,fontWeight:700,letterSpacing:'0.05em'}}>CAPTURAR</span></>}
          </button>

          {/* manual */}
          <button onClick={()=>setShowManual(true)} style={{width:54,height:54,borderRadius:'50%',border:'none',background:'rgba(255,255,255,0.1)',color:'#fff',fontSize:22,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center'}}>✏️</button>
        </div>

        {/* debug log */}
        {log.length>0 && (
          <div style={{width:'100%',padding:'0 12px 8px',maxHeight:56,overflowY:'auto'}}>
            {log.map((l,i)=><p key={i} style={{color:'rgba(253,224,71,0.6)',fontSize:8,fontFamily:'monospace',margin:'1px 0',wordBreak:'break-all'}}>{l}</p>)}
          </div>
        )}
      </div>

      {/* ── Toast ─────────────────────────────────────────────────────── */}
      {toast && (
        <div className="fadein" style={{position:'absolute',left:16,right:16,top:100,zIndex:60}}>
          <div style={{background:toast.color,borderRadius:16,padding:'14px 20px',textAlign:'center',color:'#fff',fontWeight:600,fontSize:14,boxShadow:`0 8px 32px ${toast.color}55`}}>{toast.msg}</div>
        </div>
      )}

      {/* ── Confirm modal ─────────────────────────────────────────────── */}
      {confirmForm && (
        <div style={{position:'absolute',inset:0,zIndex:50,display:'flex',alignItems:'flex-end',justifyContent:'center'}}>
          <div style={{position:'absolute',inset:0,background:'rgba(0,0,0,0.78)'}} onClick={()=>{setConfirmForm(null);setConfirmError('')}}/>
          <div className="slideup" style={{position:'relative',width:'100%',maxWidth:480,background:'#111',borderRadius:'24px 24px 0 0',maxHeight:'92dvh',overflowY:'auto',borderTop:'1px solid #27272a'}}>
            <div style={{width:36,height:4,background:'#3f3f46',borderRadius:2,margin:'12px auto 0'}}/>
            <div style={{padding:'16px 20px 12px',background:confirmForm.rawText?'rgba(245,158,11,0.08)':'rgba(34,197,94,0.08)',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
              <div style={{display:'flex',alignItems:'center',gap:12}}>
                <div style={{width:40,height:40,borderRadius:'50%',background:confirmForm.rawText?'rgba(245,158,11,0.15)':'rgba(34,197,94,0.15)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:20}}>{confirmForm.rawText?'⚠️':'🪪'}</div>
                <div>
                  <p style={{color:'#fff',fontWeight:600,fontSize:15,margin:0}}>{confirmForm.rawText?'Completar datos':'Cédula detectada'}</p>
                  <p style={{color:'#71717a',fontSize:11,margin:0}}>Verifica antes de registrar</p>
                </div>
              </div>
              <span style={{fontSize:10,padding:'3px 9px',borderRadius:20,fontWeight:700,background:confirmForm.modo==='PDF417'?'rgba(59,130,246,0.15)':'rgba(168,85,247,0.15)',color:confirmForm.modo==='PDF417'?'#93c5fd':'#d8b4fe'}}>{confirmForm.modo}</span>
            </div>
            <div style={{padding:'16px 20px 24px',display:'flex',flexDirection:'column',gap:14}}>
              {confirmForm.rawText && (
                <div>
                  <p style={{color:'#71717a',fontSize:10,margin:'0 0 6px',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em'}}>Texto detectado</p>
                  <div style={{background:'rgba(0,0,0,0.5)',border:'1px solid rgba(245,158,11,0.2)',borderRadius:10,padding:'8px 10px',color:'rgba(253,191,74,0.8)',fontSize:9,fontFamily:'monospace',wordBreak:'break-all',maxHeight:72,overflowY:'auto'}}>{confirmForm.rawText}</div>
                </div>
              )}
              <div><label style={{display:'flex',alignItems:'center',gap:6,color:'#71717a',fontSize:10,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:6}}><span>🪪</span> Cédula</label><input value={confirmForm.cedula} onChange={e=>setConfirmForm(f=>f?{...f,cedula:e.target.value}:f)} inputMode="numeric" className={FIELD}/></div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                <div><label style={{display:'flex',alignItems:'center',gap:5,color:'#71717a',fontSize:10,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:6}}><span>👤</span> Nombres</label><input value={confirmForm.nombres} onChange={e=>setConfirmForm(f=>f?{...f,nombres:e.target.value}:f)} className={FIELD}/></div>
                <div><label style={{display:'flex',alignItems:'center',gap:5,color:'#71717a',fontSize:10,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:6}}><span>👥</span> Apellidos</label><input value={confirmForm.apellidos} onChange={e=>setConfirmForm(f=>f?{...f,apellidos:e.target.value}:f)} className={FIELD}/></div>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                <div><label style={{display:'flex',alignItems:'center',gap:5,color:'#71717a',fontSize:10,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:6}}><span>📅</span> Nacimiento</label><input type="date" value={confirmForm.fechaNacimiento} onChange={e=>setConfirmForm(f=>f?{...f,fechaNacimiento:e.target.value}:f)} style={{colorScheme:'dark'}} className={FIELD}/></div>
                <div><label style={{color:'#71717a',fontSize:10,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em',display:'block',marginBottom:6}}>Edad</label><div className={FIELD} style={{display:'flex',alignItems:'center'}}>{confirmForm.fechaNacimiento?<><span style={{fontSize:24,fontWeight:700,color:'#fff'}}>{calcEdad(confirmForm.fechaNacimiento)}</span><span style={{color:'#71717a',fontSize:12,marginLeft:4}}>años</span></>:<span style={{color:'#3f3f46'}}>—</span>}</div></div>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                <div><label style={{display:'flex',alignItems:'center',gap:5,color:'#71717a',fontSize:10,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:6}}><span>⚧</span> Sexo</label><select value={confirmForm.sexo} onChange={e=>setConfirmForm(f=>f?{...f,sexo:e.target.value as 'M'|'F'|''}:f)} style={{colorScheme:'dark'}} className={FIELD}><option value="">—</option><option value="M">Masculino</option><option value="F">Femenino</option></select></div>
                <div><label style={{display:'flex',alignItems:'center',gap:5,color:'#71717a',fontSize:10,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:6}}><span>🩸</span> RH</label><input value={confirmForm.rh} onChange={e=>setConfirmForm(f=>f?{...f,rh:e.target.value}:f)} placeholder="O+" className={FIELD}/></div>
              </div>
              {confirmError && <p style={{color:'#f87171',fontSize:12,background:'rgba(248,113,113,0.08)',border:'1px solid rgba(248,113,113,0.25)',borderRadius:10,padding:'8px 12px',margin:0}}>{confirmError}</p>}
              <div style={{display:'flex',gap:10,paddingTop:4}}>
                <button onClick={()=>{setConfirmForm(null);setConfirmError('')}} style={{flex:1,padding:'14px 0',borderRadius:14,border:'1px solid #27272a',background:'transparent',color:'#71717a',fontSize:14,cursor:'pointer',fontWeight:500}}>Cancelar</button>
                <button onClick={handleConfirm} disabled={confirmSaving} style={{flex:2,padding:'14px 0',borderRadius:14,border:'none',background:confirmSaving?'#15803d':'#16a34a',color:'#fff',fontSize:14,fontWeight:700,cursor:confirmSaving?'default':'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:8,boxShadow:'0 4px 16px rgba(22,163,74,0.35)',opacity:confirmSaving?0.7:1}}>
                  {confirmSaving?<><div className="spin" style={{width:16,height:16,border:'2px solid rgba(255,255,255,0.3)',borderTopColor:'#fff',borderRadius:'50%'}}/>Guardando…</>:'✅ Confirmar registro'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Manual modal ──────────────────────────────────────────────── */}
      {showManual && (
        <div style={{position:'absolute',inset:0,zIndex:50,display:'flex',alignItems:'flex-end',justifyContent:'center'}}>
          <div style={{position:'absolute',inset:0,background:'rgba(0,0,0,0.75)'}} onClick={()=>{setShowManual(false);setManualError('')}}/>
          <div className="slideup" style={{position:'relative',width:'100%',maxWidth:480,background:'#111',borderRadius:'24px 24px 0 0',borderTop:'1px solid #27272a',maxHeight:'90dvh',overflowY:'auto'}}>
            <div style={{width:36,height:4,background:'#3f3f46',borderRadius:2,margin:'12px auto 0'}}/>
            <div style={{padding:'16px 20px',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
              <h2 style={{color:'#fff',fontSize:16,fontWeight:600,margin:0}}>✏️ Registrar manualmente</h2>
              <button onClick={()=>{setShowManual(false);setManualError('')}} style={{width:30,height:30,borderRadius:8,border:'none',background:'rgba(255,255,255,0.08)',color:'#71717a',cursor:'pointer',fontSize:14}}>✕</button>
            </div>
            <form onSubmit={handleManual} style={{padding:'0 20px 28px',display:'flex',flexDirection:'column',gap:12}}>
              <div><label style={{display:'block',color:'#71717a',fontSize:11,marginBottom:6}}>🪪 Cédula *</label><input required inputMode="numeric" value={manualForm.cedula} onChange={e=>setManualForm(f=>({...f,cedula:e.target.value}))} placeholder="1234567890" className={FIELD}/></div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                <div><label style={{display:'block',color:'#71717a',fontSize:11,marginBottom:6}}>👤 Nombres *</label><input required value={manualForm.nombres} onChange={e=>setManualForm(f=>({...f,nombres:e.target.value}))} placeholder="Juan" className={FIELD}/></div>
                <div><label style={{display:'block',color:'#71717a',fontSize:11,marginBottom:6}}>👥 Apellidos *</label><input required value={manualForm.apellidos} onChange={e=>setManualForm(f=>({...f,apellidos:e.target.value}))} placeholder="García" className={FIELD}/></div>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                <div><label style={{display:'block',color:'#71717a',fontSize:11,marginBottom:6}}>📅 Nacimiento *</label><input required type="date" value={manualForm.fechaNacimiento} onChange={e=>setManualForm(f=>({...f,fechaNacimiento:e.target.value}))} style={{colorScheme:'dark'}} className={FIELD}/></div>
                <div><label style={{display:'block',color:'#71717a',fontSize:11,marginBottom:6}}>⚧ Sexo *</label><select required value={manualForm.sexo} onChange={e=>setManualForm(f=>({...f,sexo:e.target.value as 'M'|'F'|''}))} style={{colorScheme:'dark'}} className={FIELD}><option value="">—</option><option value="M">Masculino</option><option value="F">Femenino</option></select></div>
              </div>
              {manualForm.fechaNacimiento && <p style={{color:'#52525b',fontSize:11,margin:0}}>Edad: <strong style={{color:'#fff'}}>{calcEdad(manualForm.fechaNacimiento)} años</strong></p>}
              <div><label style={{display:'block',color:'#71717a',fontSize:11,marginBottom:6}}>🩸 RH</label><input value={manualForm.rh} onChange={e=>setManualForm(f=>({...f,rh:e.target.value}))} placeholder="O+" className={FIELD}/></div>
              {manualError && <p style={{color:'#f87171',fontSize:12,background:'rgba(248,113,113,0.08)',border:'1px solid rgba(248,113,113,0.25)',borderRadius:10,padding:'8px 12px',margin:0}}>{manualError}</p>}
              <div style={{display:'flex',gap:10,paddingTop:4}}>
                <button type="button" onClick={()=>{setShowManual(false);setManualError('')}} style={{flex:1,padding:'13px 0',borderRadius:14,border:'1px solid #27272a',background:'transparent',color:'#71717a',fontSize:13,cursor:'pointer'}}>Cancelar</button>
                <button type="submit" disabled={manualSaving} style={{flex:2,padding:'13px 0',borderRadius:14,border:'none',background:'#16a34a',color:'#fff',fontSize:13,fontWeight:700,cursor:manualSaving?'default':'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:8,opacity:manualSaving?0.7:1}}>
                  {manualSaving?<><div className="spin" style={{width:14,height:14,border:'2px solid rgba(255,255,255,0.3)',borderTopColor:'#fff',borderRadius:'50%'}}/>Guardando…</>:'Registrar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
