'use client'

import dynamic from 'next/dynamic'
import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { Calendar, Users, AlertCircle } from 'lucide-react'
import { getEvento, getTotalAsistentes } from '../../lib/firestore'
import { Spinner } from '../../components/ui/Spinner'
import type { Evento } from '../../lib/types'
import { Timestamp } from 'firebase/firestore'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'

const CedulaScanner = dynamic(
  () => import('../../components/scanner/CedulaScanner').then(m => ({ default: m.CedulaScanner })),
  { ssr: false, loading: () => (
    <div className="flex h-dvh items-center justify-center bg-black">
      <div className="text-center">
        <div className="w-10 h-10 rounded-full border-2 border-white/20 border-t-white mx-auto mb-3" style={{ animation: 'spin 0.8s linear infinite' }} />
        <p className="text-white/50 text-sm">Iniciando cámara…</p>
      </div>
    </div>
  )}
)

function toDate(v: unknown): Date {
  if (v instanceof Timestamp) return v.toDate()
  if (v instanceof Date) return v
  return new Date()
}

export default function EventoScannerPage() {
  const { id } = useParams<{ id: string }>()
  const [evento, setEvento] = useState<Evento | null>(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [started, setStarted] = useState(false)

  const refreshTotal = useCallback(async () => {
    const t = await getTotalAsistentes(id)
    setTotal(t)
  }, [id])

  useEffect(() => {
    (async () => {
      const ev = await getEvento(id)
      if (!ev) { setNotFound(true); setLoading(false); return }
      setEvento(ev)
      setTotal(await getTotalAsistentes(id))
      setLoading(false)
    })()
  }, [id])

  if (loading) return (
    <div className="flex h-dvh items-center justify-center bg-[#09090b]">
      <Spinner size="lg" />
    </div>
  )

  if (notFound) return (
    <div className="flex h-dvh items-center justify-center bg-[#09090b] p-6">
      <div className="text-center">
        <AlertCircle size={48} className="mx-auto mb-3 text-red-400 opacity-60" />
        <p className="text-white font-semibold">Evento no encontrado</p>
        <p className="text-zinc-500 text-sm mt-1">Verifica el link del evento</p>
      </div>
    </div>
  )

  if (!started) return (
    <div className="min-h-dvh bg-[#09090b] flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-xs text-center animate-fadeIn">
        <div className="w-16 h-16 rounded-2xl bg-blue-600 flex items-center justify-center mx-auto mb-5 shadow-lg shadow-blue-600/30">
          <Calendar size={32} className="text-white" />
        </div>
        <h1 className="text-xl font-bold text-white mb-1">{evento?.nombre}</h1>
        <p className="text-zinc-500 text-sm mb-1">
          {format(toDate(evento?.fecha), "d 'de' MMMM yyyy", { locale: es })}
        </p>
        {evento?.descripcion && (
          <p className="text-zinc-400 text-sm mb-4">{evento.descripcion}</p>
        )}
        <div className="flex items-center justify-center gap-2 text-zinc-400 text-sm mb-8">
          <Users size={16} />
          <span><span className="text-white font-semibold">{total}</span> registrado{total !== 1 ? 's' : ''} hoy</span>
        </div>
        <button
          onClick={() => setStarted(true)}
          className="w-full py-4 rounded-2xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-base transition shadow-lg shadow-blue-600/30 active:scale-95"
        >
          Iniciar scanner
        </button>
        <p className="text-zinc-600 text-xs mt-4">Se solicitará acceso a la cámara</p>
      </div>
    </div>
  )

  return (
    <div className="relative">
      {/* Event badge on top of scanner */}
      <div className="absolute top-0 inset-x-0 z-20 pointer-events-none">
        <div className="flex items-center justify-center pt-16 pb-2">
          <div className="bg-black/60 backdrop-blur rounded-full px-4 py-1.5 flex items-center gap-2">
            <span className="text-white font-medium text-sm truncate max-w-[160px]">{evento?.nombre}</span>
            <span className="text-zinc-400 text-xs">·</span>
            <Users size={12} className="text-zinc-400" />
            <span className="text-zinc-300 text-xs font-semibold">{total}</span>
          </div>
        </div>
      </div>
      <CedulaScanner eventId={id} onRegistered={refreshTotal} />
    </div>
  )
}
