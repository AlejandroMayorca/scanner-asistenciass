'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Calendar, Plus, Search, Users, Trash2, Link as LinkIcon } from 'lucide-react'
import { getEventos, crearEvento, deleteEvento, getTotalAsistentes } from '../../lib/firestore'
import { useAuth } from '../../context/AuthContext'
import { Modal } from '../../components/ui/Modal'
import { Spinner } from '../../components/ui/Spinner'
import { DashboardHeader } from '../../components/layout/DashboardHeader'
import type { Evento } from '../../lib/types'
import { Timestamp } from 'firebase/firestore'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'

function toDate(v: unknown): Date {
  if (v instanceof Timestamp) return v.toDate()
  if (v instanceof Date) return v
  return new Date()
}

export default function EventosPage() {
  const { profile } = useAuth()
  const [eventos, setEventos] = useState<(Evento & { totalAsistentes: number })[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState({ nombre: '', lugar: '', descripcion: '', fecha: '' })
  const [saving, setSaving] = useState(false)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    const evs = await getEventos()
    const withTotal = await Promise.all(
      evs.map(async e => ({ ...e, totalAsistentes: await getTotalAsistentes(e.id!) }))
    )
    setEventos(withTotal)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const filtered = eventos.filter(e =>
    e.nombre.toLowerCase().includes(search.toLowerCase()) ||
    e.descripcion?.toLowerCase().includes(search.toLowerCase())
  )

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.nombre || !form.fecha || !form.lugar || !profile) return
    setSaving(true)
    await crearEvento({ nombre: form.nombre, descripcion: form.descripcion, lugar: form.lugar, fecha: new Date(form.fecha) }, profile.id)
    setSaving(false)
    setShowModal(false)
    setForm({ nombre: '', lugar: '', descripcion: '', fecha: '' })
    load()
  }

  const handleDelete = async (id: string) => {
    await deleteEvento(id)
    setConfirmDel(null)
    load()
  }

  const copyLink = (id: string) => {
    navigator.clipboard.writeText(`${window.location.origin}/evento/${id}`)
      .then(() => alert('¡Link copiado al portapapeles!'))
  }

  return (
    <>
      <DashboardHeader title="Eventos" />
      <div className="px-4 lg:px-8 py-6 max-w-6xl w-full mx-auto">
        {/* Page header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-white">Eventos</h1>
            <p className="text-zinc-500 text-sm mt-0.5">{eventos.length} evento{eventos.length !== 1 ? 's' : ''} registrado{eventos.length !== 1 ? 's' : ''}</p>
          </div>
          {profile?.rol === 'admin' && (
            <button
              onClick={() => setShowModal(true)}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2.5 rounded-xl transition"
            >
              <Plus size={16} /> Crear evento
            </button>
          )}
        </div>

        {/* Search */}
        <div className="relative mb-5">
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar evento…"
            className="w-full bg-[#111113] border border-[#27272a] rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition"
          />
        </div>

        {loading ? (
          <div className="flex justify-center py-20"><Spinner size="lg" /></div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20 text-zinc-600">
            <Calendar size={48} className="mx-auto mb-3 opacity-30" />
            <p>{search ? 'Sin resultados para tu búsqueda' : 'No hay eventos aún'}</p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map(ev => (
              <div key={ev.id} className="bg-[#111113] border border-[#27272a] rounded-2xl p-5 hover:border-zinc-600 transition flex flex-col">
                {/* Card header */}
                <div className="flex items-start justify-between gap-2 mb-1">
                  <h3 className="font-semibold text-white truncate flex-1">{ev.nombre}</h3>
                  <div className={`w-2.5 h-2.5 rounded-full shrink-0 mt-1.5 ${ev.activo ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
                </div>

                {/* Date + location */}
                <p className="text-zinc-500 text-xs mb-1">
                  {format(toDate(ev.fecha), "d MMM yyyy", { locale: es })}
                  {ev.lugar && <span className="text-zinc-600"> · {ev.lugar}</span>}
                </p>

                {/* Description */}
                {ev.descripcion && (
                  <p className="text-zinc-400 text-xs line-clamp-2 mb-3">{ev.descripcion}</p>
                )}

                <div className="mt-auto">
                  {/* Attendees count + utility icons */}
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-1.5 text-zinc-400 text-sm">
                      <Users size={14} />
                      <span className="font-semibold text-white">{ev.totalAsistentes}</span>
                      <span className="text-xs">asistentes</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <button onClick={() => copyLink(ev.id!)} title="Copiar link scanner" className="p-1.5 rounded-lg text-zinc-500 hover:text-blue-400 hover:bg-blue-400/10 transition">
                        <LinkIcon size={14} />
                      </button>
                      {profile?.rol === 'admin' && (
                        <button onClick={() => setConfirmDel(ev.id!)} className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-400/10 transition">
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Primary action buttons */}
                  <div className="flex gap-2">
                    <Link
                      href={`/dashboard/eventos/${ev.id}/scanner`}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition active:scale-95"
                    >
                      📷 Escanear
                    </Link>
                    <Link
                      href={`/dashboard/eventos/${ev.id}/estadisticas`}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-white/8 hover:bg-white/12 text-zinc-300 text-xs font-semibold border border-[#27272a] hover:border-zinc-500 transition active:scale-95"
                    >
                      📊 Ver registros
                    </Link>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create modal */}
      <Modal open={showModal} onClose={() => setShowModal(false)} title="Nuevo evento">
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Nombre del evento *</label>
            <input
              required value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))}
              placeholder="Festival de verano 2025"
              className="w-full bg-[#111113] border border-[#27272a] rounded-xl px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition"
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs text-zinc-400 mb-1.5">Fecha *</label>
              <input
                required type="date" value={form.fecha} onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))}
                className="w-full bg-[#111113] border border-[#27272a] rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-blue-500 transition [color-scheme:dark]"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Lugar *</label>
            <input
              required value={form.lugar} onChange={e => setForm(f => ({ ...f, lugar: e.target.value }))}
              placeholder="Parque principal, Bogotá"
              className="w-full bg-[#111113] border border-[#27272a] rounded-xl px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Descripción <span className="text-zinc-600">(opcional)</span></label>
            <textarea
              value={form.descripcion} onChange={e => setForm(f => ({ ...f, descripcion: e.target.value }))}
              rows={2} placeholder="Descripción del evento…"
              className="w-full bg-[#111113] border border-[#27272a] rounded-xl px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition resize-none"
            />
          </div>
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={() => { setShowModal(false); setForm({ nombre: '', lugar: '', descripcion: '', fecha: '' }) }} className="flex-1 py-2.5 rounded-xl border border-[#27272a] text-zinc-400 text-sm hover:bg-white/5 transition">
              Cancelar
            </button>
            <button type="submit" disabled={saving} className="flex-1 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-500 transition disabled:opacity-60 flex items-center justify-center gap-2">
              {saving ? <><Spinner size="sm" /> Creando…</> : 'Crear evento'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Confirm delete */}
      {confirmDel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70" onClick={() => setConfirmDel(null)} />
          <div className="relative bg-[#18181b] border border-[#27272a] rounded-2xl p-6 max-w-xs w-full">
            <p className="font-semibold text-white mb-2">¿Eliminar evento?</p>
            <p className="text-zinc-400 text-sm mb-5">Esta acción no se puede deshacer. Los asistentes registrados se mantendrán.</p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmDel(null)} className="flex-1 py-2.5 rounded-xl border border-[#27272a] text-zinc-400 text-sm hover:bg-white/5 transition">Cancelar</button>
              <button onClick={() => handleDelete(confirmDel)} className="flex-1 py-2.5 rounded-xl bg-red-600 text-white text-sm font-semibold hover:bg-red-500 transition">Eliminar</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
