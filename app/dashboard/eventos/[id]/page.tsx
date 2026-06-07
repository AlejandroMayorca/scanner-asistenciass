'use client'

import { useEffect, useState, useMemo } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  ArrowLeft, Download, FileJson, Search, Users, Clock,
  TrendingUp, Link as LinkIcon, ChevronLeft, ChevronRight,
} from 'lucide-react'
import { getEvento, getAsistentes } from '../../../lib/firestore'
import { exportToExcel, exportToJson } from '../../../lib/export'
import { calcStats, formatHora } from '../../../lib/stats'
import { useAuth } from '../../../context/AuthContext'
import { HourlyChart } from '../../../components/charts/HourlyChart'
import { AgeChart } from '../../../components/charts/AgeChart'
import { Badge } from '../../../components/ui/Badge'
import { Spinner } from '../../../components/ui/Spinner'
import { DashboardHeader } from '../../../components/layout/DashboardHeader'
import type { Evento, Asistente } from '../../../lib/types'
import { Timestamp } from 'firebase/firestore'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'

const PAGE_SIZE = 20

const AGE_GROUPS = [
  { key: '14-17', label: '14 – 17 años', color: 'bg-amber-500' },
  { key: '18-25', label: '18 – 25 años', color: 'bg-blue-500' },
  { key: '26-35', label: '26 – 35 años', color: 'bg-violet-500' },
  { key: '36-50', label: '36 – 50 años', color: 'bg-cyan-500' },
  { key: '51+',   label: '51 + años',    color: 'bg-emerald-500' },
  { key: 'N/A',   label: 'Sin dato',     color: 'bg-zinc-600' },
]

function AgeGroupTable({ gruposEdad, total }: { gruposEdad: Record<string, number>; total: number }) {
  const conDato = Object.entries(gruposEdad)
    .filter(([k]) => k !== 'N/A')
    .reduce((s, [, v]) => s + v, 0)

  return (
    <div className="mt-5 space-y-2">
      {AGE_GROUPS.map(({ key, label, color }) => {
        const count = gruposEdad[key] ?? 0
        const pct   = conDato > 0 && key !== 'N/A' ? Math.round((count / conDato) * 100) : 0
        return (
          <div key={key} className="flex items-center gap-3">
            <span className="w-24 shrink-0 text-xs text-zinc-400">{label}</span>
            <div className="flex-1 h-2 bg-[#27272a] rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${color} transition-all`}
                style={{ width: key === 'N/A' ? '0%' : `${pct}%` }}
              />
            </div>
            <span className="w-8 text-right text-xs font-semibold text-white">{count}</span>
            <span className="w-9 text-right text-xs text-zinc-500">
              {key !== 'N/A' ? `${pct}%` : ''}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function toDate(v: unknown): Date {
  if (v instanceof Timestamp) return v.toDate()
  if (v instanceof Date) return v
  if (v && typeof v === 'object' && 'seconds' in v) return new Date((v as {seconds:number}).seconds * 1000)
  return new Date()
}

export default function EventoDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const { profile } = useAuth()
  const [evento, setEvento] = useState<Evento | null>(null)
  const [asistentes, setAsistentes] = useState<Asistente[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [tab, setTab] = useState<'asistentes' | 'stats'>('asistentes')

  useEffect(() => {
    (async () => {
      const [ev, asis] = await Promise.all([getEvento(id), getAsistentes(id)])
      setEvento(ev); setAsistentes(asis); setLoading(false)
    })()
  }, [id])

  const stats = useMemo(() => calcStats(asistentes), [asistentes])

  const filtered = useMemo(() =>
    asistentes.filter(a => {
      const q = search.toLowerCase()
      return a.numeroCedula.includes(q) || a.apellidos.toLowerCase().includes(q) || a.nombres.toLowerCase().includes(q)
    }),
    [asistentes, search]
  )

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const copyLink = () => {
    navigator.clipboard.writeText(`${window.location.origin}/evento/${id}`)
      .then(() => alert('Link del scanner copiado'))
  }

  if (loading) return (
    <div className="flex h-dvh items-center justify-center"><Spinner size="lg" /></div>
  )
  if (!evento) return (
    <div className="flex h-dvh items-center justify-center text-zinc-500">Evento no encontrado</div>
  )

  return (
    <>
      <DashboardHeader title={evento.nombre} />
      <div className="px-4 lg:px-8 py-6 max-w-6xl w-full mx-auto">
        {/* Breadcrumb */}
        <button onClick={() => router.back()} className="flex items-center gap-1.5 text-zinc-500 hover:text-white text-sm mb-5 transition">
          <ArrowLeft size={16} /> Volver a eventos
        </button>

        {/* Event header */}
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="text-xl font-bold text-white">{evento.nombre}</h1>
            <p className="text-zinc-500 text-sm mt-0.5">{format(toDate(evento.fecha), "d 'de' MMMM yyyy", { locale: es })}</p>
            {evento.descripcion && <p className="text-zinc-400 text-sm mt-1">{evento.descripcion}</p>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={copyLink} className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[#27272a] text-zinc-400 hover:text-blue-400 hover:border-blue-500/50 text-sm transition">
              <LinkIcon size={14} /> Link scanner
            </button>
          </div>
        </div>

        {/* Quick stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          {[
            { label: 'Total', value: stats.total, icon: Users, color: 'text-blue-400' },
            { label: 'Masculinos', value: `${stats.masculinos} (${stats.pctMasculino}%)`, icon: Users, color: 'text-sky-400' },
            { label: 'Femeninos', value: `${stats.femeninos} (${stats.pctFemenino}%)`, icon: Users, color: 'text-pink-400' },
            { label: 'Hora pico', value: stats.total > 0 ? formatHora(stats.horaPico) : '—', icon: Clock, color: 'text-amber-400' },
          ].map(s => {
            const Icon = s.icon
            return (
              <div key={s.label} className="bg-[#111113] border border-[#27272a] rounded-2xl p-4">
                <div className={`${s.color} mb-2`}><Icon size={18} /></div>
                <p className="text-xl font-bold text-white">{s.value}</p>
                <p className="text-zinc-500 text-xs mt-0.5">{s.label}</p>
              </div>
            )
          })}
        </div>

        {stats.edadPromedio !== null && (
          <div className="flex items-center gap-2 mb-6 px-4 py-3 bg-[#111113] border border-[#27272a] rounded-xl text-sm text-zinc-400">
            <TrendingUp size={15} className="text-emerald-400" />
            Edad promedio: <span className="text-white font-semibold">{stats.edadPromedio} años</span>
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b border-[#27272a] mb-5">
          {(['asistentes', 'stats'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm font-medium capitalize border-b-2 transition -mb-px
                ${tab === t ? 'border-blue-500 text-blue-400' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}
            >
              {t === 'stats' ? 'Estadísticas' : 'Asistentes'}
            </button>
          ))}
        </div>

        {tab === 'stats' ? (
          <div className="space-y-5">
            <div className="bg-[#111113] border border-[#27272a] rounded-2xl p-5">
              <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
                <TrendingUp size={16} className="text-blue-400" /> Ingresos por hora
              </h3>
              {stats.total > 0 ? <HourlyChart hourly={stats.hourly} horaPico={stats.horaPico} /> : <p className="text-zinc-600 text-sm py-8 text-center">Sin datos aún</p>}
            </div>
            <div className="bg-[#111113] border border-[#27272a] rounded-2xl p-5">
              <h3 className="text-sm font-semibold text-white mb-4">Distribución de edades</h3>
              {stats.total > 0 ? (
                <>
                  <AgeChart gruposEdad={stats.gruposEdad} />
                  <AgeGroupTable gruposEdad={stats.gruposEdad} total={stats.total} />
                </>
              ) : (
                <p className="text-zinc-600 text-sm py-8 text-center">Sin datos aún</p>
              )}
            </div>
          </div>
        ) : (
          <>
            {/* Search + export */}
            <div className="flex items-center gap-3 mb-4">
              <div className="relative flex-1">
                <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input
                  value={search}
                  onChange={e => { setSearch(e.target.value); setPage(1) }}
                  placeholder="Buscar por nombre o cédula…"
                  className="w-full bg-[#111113] border border-[#27272a] rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition"
                />
              </div>
              {profile?.rol === 'admin' && asistentes.length > 0 && (
                <div className="flex gap-2">
                  <button
                    onClick={() => exportToExcel(asistentes, evento.nombre)}
                    className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl border border-[#27272a] text-zinc-400 hover:text-emerald-400 hover:border-emerald-500/50 text-sm transition"
                    title="Exportar Excel"
                  >
                    <Download size={15} /> <span className="hidden sm:inline">Excel</span>
                  </button>
                  <button
                    onClick={() => exportToJson(asistentes, evento)}
                    className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl border border-[#27272a] text-zinc-400 hover:text-amber-400 hover:border-amber-500/50 text-sm transition"
                    title="Backup JSON"
                  >
                    <FileJson size={15} /> <span className="hidden sm:inline">JSON</span>
                  </button>
                </div>
              )}
            </div>

            {/* Table */}
            <div className="bg-[#111113] border border-[#27272a] rounded-2xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#27272a] text-zinc-500 text-xs">
                      <th className="text-left px-4 py-3 font-medium">#</th>
                      <th className="text-left px-4 py-3 font-medium">Cédula</th>
                      <th className="text-left px-4 py-3 font-medium">Apellidos y Nombres</th>
                      <th className="text-left px-4 py-3 font-medium hidden md:table-cell">Sexo</th>
                      <th className="text-left px-4 py-3 font-medium hidden md:table-cell">Edad</th>
                      <th className="text-left px-4 py-3 font-medium hidden lg:table-cell">Hora</th>
                      <th className="text-left px-4 py-3 font-medium hidden lg:table-cell">Tipo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginated.length === 0 ? (
                      <tr><td colSpan={7} className="text-center py-12 text-zinc-600">Sin resultados</td></tr>
                    ) : paginated.map((a, i) => (
                      <tr key={a.id} className="border-b border-[#1a1a1d] hover:bg-white/[0.02] transition">
                        <td className="px-4 py-3 text-zinc-600 font-mono text-xs">{(page - 1) * PAGE_SIZE + i + 1}</td>
                        <td className="px-4 py-3 font-mono text-blue-400 text-xs">{a.numeroCedula}</td>
                        <td className="px-4 py-3">
                          <p className="text-white font-medium">{a.apellidos}</p>
                          <p className="text-zinc-400 text-xs">{a.nombres}</p>
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell text-zinc-400">{a.sexo ?? '—'}</td>
                        <td className="px-4 py-3 hidden md:table-cell text-zinc-400">{a.edad ?? '—'}</td>
                        <td className="px-4 py-3 hidden lg:table-cell text-zinc-500 text-xs">{format(toDate(a.horaIngreso), 'HH:mm:ss')}</td>
                        <td className="px-4 py-3 hidden lg:table-cell">
                          <Badge variant={a.tipoCedula} label={a.tipoCedula === 'nueva' ? 'Nueva' : 'Vieja'} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between px-4 py-3 border-t border-[#27272a]">
                  <p className="text-xs text-zinc-500">{filtered.length} resultados · Página {page} de {totalPages}</p>
                  <div className="flex gap-1">
                    <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="p-1.5 rounded-lg text-zinc-500 hover:text-white hover:bg-white/10 disabled:opacity-30 transition">
                      <ChevronLeft size={16} />
                    </button>
                    <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="p-1.5 rounded-lg text-zinc-500 hover:text-white hover:bg-white/10 disabled:opacity-30 transition">
                      <ChevronRight size={16} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  )
}
