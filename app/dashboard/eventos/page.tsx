'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  AlertCircle, Calendar, MapPin, Plus, Search, Trash2, Users,
} from 'lucide-react'
import {
  collection, onSnapshot, orderBy, query, Timestamp,
} from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { crearEvento, eliminarEvento, getTotalAsistencias, generarTokenAcceso } from '../../lib/firestore'
import { useAuth } from '../../context/AuthContext'
import { Modal } from '../../components/ui/Modal'
import { Spinner } from '../../components/ui/Spinner'
import type { Evento } from '../../lib/types'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'

function toDate(v: unknown): Date {
  if (v instanceof Timestamp) return v.toDate()
  if (v instanceof Date) return v
  if (v && typeof v === 'object' && 'seconds' in v)
    return new Date((v as { seconds: number }).seconds * 1000)
  return new Date()
}

const FIELD =
  'w-full bg-[#111113] border border-[#27272a] rounded-xl px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition'

export default function EventosPage() {
  const { profile, user } = useAuth()
  const isAdmin = profile?.rol === 'admin' || user?.email === 'admin@cedulascan.com'

  const [eventos, setEventos] = useState<(Evento & { total: number })[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ nombre: '', descripcion: '', lugar: '', fecha: '' })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Real-time eventos listener
  useEffect(() => {
    const q = query(collection(db, 'eventos'), orderBy('fecha', 'desc'))
    const unsub = onSnapshot(
      q,
      async snap => {
        try {
          const evs = snap.docs.map(d => ({ id: d.id, ...d.data() } as Evento))
          const withTotal = await Promise.all(
            evs.map(async ev => ({ ...ev, total: await getTotalAsistencias(ev.id!) })),
          )
          setEventos(withTotal)
          setError(null)
        } catch {
          setError('Error al cargar eventos')
        } finally {
          setLoading(false)
        }
      },
      err => {
        setError(`Firestore: ${err.code} — ${err.message}`)
        setLoading(false)
      },
    )
    return () => unsub()
  }, [])

  const filtered = eventos.filter(ev =>
    ev.nombre.toLowerCase().includes(search.toLowerCase()) ||
    ev.lugar?.toLowerCase().includes(search.toLowerCase()),
  )

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!profile) return
    setSaving(true)
    setSaveError(null)
    try {
      const [y, m, d] = form.fecha.split('-').map(Number)
      await crearEvento(
        { nombre: form.nombre, descripcion: form.descripcion, lugar: form.lugar, fecha: new Date(y, m - 1, d) },
        profile.id,
      )
      setShowCreate(false)
      setForm({ nombre: '', descripcion: '', lugar: '', fecha: '' })
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string }
      setSaveError(`${e.code ?? 'Error'}: ${e.message ?? ''}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    setDeleting(true)
    try {
      await eliminarEvento(id)
      setConfirmDel(null)
    } catch (err: unknown) {
      const e = err as { message?: string }
      setError(`No se pudo eliminar: ${e.message ?? ''}`)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="px-4 lg:px-8 py-6 max-w-5xl w-full mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">Eventos</h1>
          <p className="text-zinc-500 text-sm mt-0.5">
            {eventos.length} evento{eventos.length !== 1 ? 's' : ''}
          </p>
        </div>
        {isAdmin && (
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-4 py-2.5 rounded-xl transition active:scale-95"
          >
            <Plus size={16} /> Nuevo Evento
          </button>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 mb-5 text-sm text-red-400">
          <AlertCircle size={15} className="shrink-0" />
          {error}
        </div>
      )}

      {/* Search */}
      <div className="relative mb-5">
        <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar evento o lugar…"
          className={`${FIELD} pl-10`}
        />
      </div>

      {/* Events grid */}
      {loading ? (
        <div className="flex justify-center py-24">
          <Spinner size="lg" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-24 text-zinc-600">
          <Calendar size={48} className="mx-auto mb-3 opacity-30" />
          <p className="text-base">{search ? 'Sin resultados' : 'No hay eventos aún'}</p>
          {isAdmin && !search && (
            <p className="text-sm mt-1">
              Crea el primer evento con el botón{' '}
              <span className="text-blue-400">+ Nuevo Evento</span>
            </p>
          )}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map(ev => (
            <div
              key={ev.id}
              className="bg-[#111113] border border-[#27272a] rounded-2xl p-5 flex flex-col hover:border-zinc-600 transition"
            >
              {/* Header */}
              <div className="flex items-start justify-between gap-2 mb-2">
                <h3 className="font-semibold text-white leading-snug flex-1">{ev.nombre}</h3>
                <span
                  className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full mt-0.5 ${
                    ev.activo
                      ? 'bg-emerald-500/15 text-emerald-400'
                      : 'bg-zinc-700/60 text-zinc-500'
                  }`}
                >
                  {ev.activo ? 'Activo' : 'Inactivo'}
                </span>
              </div>

              {/* Meta */}
              <div className="space-y-1 mb-3">
                <p className="flex items-center gap-1.5 text-zinc-500 text-xs">
                  <Calendar size={12} />
                  {format(toDate(ev.fecha), "d 'de' MMMM yyyy", { locale: es })}
                </p>
                {ev.lugar && (
                  <p className="flex items-center gap-1.5 text-zinc-500 text-xs truncate">
                    <MapPin size={12} />
                    {ev.lugar}
                  </p>
                )}
                {ev.descripcion && (
                  <p className="text-zinc-600 text-xs line-clamp-2 pt-1">{ev.descripcion}</p>
                )}
              </div>

              {/* Count + actions */}
              <div className="mt-auto">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-1.5 text-zinc-400 text-sm">
                    <Users size={14} />
                    <span className="font-bold text-white text-base">{ev.total}</span>
                    <span className="text-xs">asistentes</span>
                  </div>
                  {isAdmin && (
                    <button
                      onClick={() => setConfirmDel(ev.id!)}
                      className="p-1.5 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-400/10 transition"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>

                <div className="flex gap-2">
                  <Link
                    href={`/dashboard/eventos/${ev.id}/scanner`}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition active:scale-95"
                  >
                    📷 Escanear
                  </Link>
                  <Link
                    href={`/dashboard/eventos/${ev.id}`}
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

      {/* Create modal */}
      <Modal open={showCreate} onClose={() => { setShowCreate(false); setSaveError(null) }} title="Nuevo evento">
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Nombre *</label>
            <input
              required
              value={form.nombre}
              onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))}
              placeholder="Festival de verano 2025"
              className={FIELD}
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Fecha *</label>
            <input
              required
              type="date"
              value={form.fecha}
              onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))}
              className={`${FIELD} [color-scheme:dark]`}
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Lugar *</label>
            <input
              required
              value={form.lugar}
              onChange={e => setForm(f => ({ ...f, lugar: e.target.value }))}
              placeholder="Parque central, Bogotá"
              className={FIELD}
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">
              Descripción <span className="text-zinc-600">(opcional)</span>
            </label>
            <textarea
              rows={2}
              value={form.descripcion}
              onChange={e => setForm(f => ({ ...f, descripcion: e.target.value }))}
              placeholder="Descripción del evento…"
              className={`${FIELD} resize-none`}
            />
          </div>

          {saveError && (
            <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">
              <AlertCircle size={13} />
              {saveError}
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={() => { setShowCreate(false); setSaveError(null) }}
              className="flex-1 py-2.5 rounded-xl border border-[#27272a] text-zinc-400 text-sm hover:bg-white/5 transition"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-500 disabled:opacity-60 transition flex items-center justify-center gap-2"
            >
              {saving ? <><Spinner size="sm" /> Guardando…</> : 'Crear evento'}
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
            <p className="text-zinc-400 text-sm mb-5">
              Se eliminarán el evento y <strong className="text-white">todas</strong> sus
              asistencias registradas. Esta acción no se puede deshacer.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmDel(null)}
                className="flex-1 py-2.5 rounded-xl border border-[#27272a] text-zinc-400 text-sm hover:bg-white/5 transition"
              >
                Cancelar
              </button>
              <button
                onClick={() => handleDelete(confirmDel)}
                disabled={deleting}
                className="flex-1 py-2.5 rounded-xl bg-red-600 text-white text-sm font-semibold hover:bg-red-500 disabled:opacity-60 transition flex items-center justify-center gap-2"
              >
                {deleting ? <><Spinner size="sm" /> Eliminando…</> : 'Eliminar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
