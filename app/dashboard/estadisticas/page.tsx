'use client'

import { useEffect, useState, useMemo } from 'react'
import { Users, TrendingUp, Clock, Calendar } from 'lucide-react'
import { getDocs, collection, query, orderBy } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { calcStats, formatHora } from '../../lib/stats'
import { HourlyChart } from '../../components/charts/HourlyChart'
import { AgeChart } from '../../components/charts/AgeChart'
import { Spinner } from '../../components/ui/Spinner'
import { DashboardHeader } from '../../components/layout/DashboardHeader'
import type { Asistente } from '../../lib/types'
import { Timestamp } from 'firebase/firestore'

export default function EstadisticasPage() {
  const [asistentes, setAsistentes] = useState<Asistente[]>([])
  const [loading, setLoading] = useState(true)
  const [eventoFiltro, setEventoFiltro] = useState<string>('todos')
  const [eventos, setEventos] = useState<{ id: string; nombre: string }[]>([])

  useEffect(() => {
    (async () => {
      const [asisSnap, evSnap] = await Promise.all([
        getDocs(query(collection(db, 'asistentes'), orderBy('horaIngreso', 'asc'))),
        getDocs(query(collection(db, 'eventos'), orderBy('fecha', 'desc'))),
      ])
      setAsistentes(asisSnap.docs.map(d => ({ id: d.id, ...d.data() } as Asistente)))
      setEventos(evSnap.docs.map(d => ({ id: d.id, nombre: d.data().nombre as string })))
      setLoading(false)
    })()
  }, [])

  const filtered = useMemo(() =>
    eventoFiltro === 'todos' ? asistentes : asistentes.filter(a => a.eventId === eventoFiltro),
    [asistentes, eventoFiltro]
  )

  const stats = useMemo(() => calcStats(filtered), [filtered])

  if (loading) return <div className="flex h-dvh items-center justify-center"><Spinner size="lg" /></div>

  const cards = [
    { label: 'Total asistentes', value: stats.total, icon: Users, color: 'text-blue-400', bg: 'bg-blue-500/10' },
    { label: '% Masculino', value: `${stats.pctMasculino}%`, icon: Users, color: 'text-sky-400', bg: 'bg-sky-500/10' },
    { label: '% Femenino', value: `${stats.pctFemenino}%`, icon: Users, color: 'text-pink-400', bg: 'bg-pink-500/10' },
    { label: 'Edad promedio', value: stats.edadPromedio != null ? `${stats.edadPromedio} años` : '—', icon: TrendingUp, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
    { label: 'Hora pico', value: stats.total > 0 ? formatHora(stats.horaPico) : '—', icon: Clock, color: 'text-amber-400', bg: 'bg-amber-500/10' },
    { label: 'Eventos', value: eventos.length, icon: Calendar, color: 'text-purple-400', bg: 'bg-purple-500/10' },
  ]

  return (
    <>
      <DashboardHeader title="Estadísticas" />
      <div className="px-4 lg:px-8 py-6 max-w-6xl w-full mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-white">Estadísticas globales</h1>
            <p className="text-zinc-500 text-sm mt-0.5">Resumen de todos los eventos</p>
          </div>
          {/* Event filter */}
          <select
            value={eventoFiltro}
            onChange={e => setEventoFiltro(e.target.value)}
            className="bg-[#111113] border border-[#27272a] rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition [color-scheme:dark]"
          >
            <option value="todos">Todos los eventos</option>
            {eventos.map(e => <option key={e.id} value={e.id}>{e.nombre}</option>)}
          </select>
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
          {cards.map(c => {
            const Icon = c.icon
            return (
              <div key={c.label} className="bg-[#111113] border border-[#27272a] rounded-2xl p-5">
                <div className={`inline-flex p-2 rounded-xl ${c.bg} mb-3`}>
                  <Icon size={20} className={c.color} />
                </div>
                <p className="text-2xl font-bold text-white">{c.value}</p>
                <p className="text-zinc-500 text-xs mt-0.5">{c.label}</p>
              </div>
            )
          })}
        </div>

        {/* Gender bar */}
        {(stats.masculinos > 0 || stats.femeninos > 0) && (
          <div className="bg-[#111113] border border-[#27272a] rounded-2xl p-5 mb-5">
            <h3 className="text-sm font-semibold text-white mb-3">Distribución por género</h3>
            <div className="flex rounded-full overflow-hidden h-3 bg-[#27272a]">
              <div className="bg-sky-500 transition-all" style={{ width: `${stats.pctMasculino}%` }} />
              <div className="bg-pink-500 transition-all" style={{ width: `${stats.pctFemenino}%` }} />
              <div className="bg-zinc-700 flex-1" />
            </div>
            <div className="flex gap-4 mt-2 text-xs text-zinc-400">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-sky-500 inline-block" /> Masculino {stats.pctMasculino}%</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-pink-500 inline-block" /> Femenino {stats.pctFemenino}%</span>
              {stats.sinSexo > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-zinc-700 inline-block" /> N/A {stats.sinSexo}</span>}
            </div>
          </div>
        )}

        {/* Charts */}
        <div className="grid lg:grid-cols-2 gap-5">
          <div className="bg-[#111113] border border-[#27272a] rounded-2xl p-5">
            <h3 className="text-sm font-semibold text-white mb-4">Ingresos por hora del día</h3>
            {stats.total > 0 ? <HourlyChart hourly={stats.hourly} horaPico={stats.horaPico} /> : <p className="text-zinc-600 text-sm py-10 text-center">Sin datos</p>}
          </div>
          <div className="bg-[#111113] border border-[#27272a] rounded-2xl p-5">
            <h3 className="text-sm font-semibold text-white mb-4">Distribución de edades</h3>
            {stats.total > 0 ? <AgeChart gruposEdad={stats.gruposEdad} /> : <p className="text-zinc-600 text-sm py-10 text-center">Sin datos</p>}
          </div>
        </div>
      </div>
    </>
  )
}
