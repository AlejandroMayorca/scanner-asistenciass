'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  AlertCircle, Archive, Calendar, Camera, ChevronRight,
  ClipboardList, Download, FileJson, Link as LinkIcon,
  Plus, Search, Settings, Shield, Trash2, User, UserPlus, Users,
} from 'lucide-react'
import {
  collection, onSnapshot, orderBy, query, where,
  Timestamp, addDoc, serverTimestamp,
} from 'firebase/firestore'
import {
  createUserWithEmailAndPassword, getAuth,
} from 'firebase/auth'
import { initializeApp, getApps } from 'firebase/app'
import { db, firebaseConfig } from '../lib/firebase'
import { deleteEvento, getTotalAsistentes, getAsistentes, getUsuarios, setUsuarioPerfil, updateUsuario } from '../lib/firestore'
import { exportToExcel, exportToJson } from '../lib/export'
import { useAuth } from '../context/AuthContext'
import { Modal } from '../components/ui/Modal'
import { Spinner } from '../components/ui/Spinner'
import { DashboardHeader } from '../components/layout/DashboardHeader'
import type { Evento, Asistente, UserProfile } from '../lib/types'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'

// ── Helpers ───────────────────────────────────────────────────────────────────

function toDate(v: unknown): Date {
  if (v instanceof Timestamp) return v.toDate()
  if (v instanceof Date) return v
  if (v && typeof v === 'object' && 'seconds' in v) return new Date((v as { seconds: number }).seconds * 1000)
  return new Date()
}

function parseLocalDate(yyyy_mm_dd: string): Date {
  // Avoid UTC shift: "2025-06-12" → local midnight, not UTC midnight
  const [y, m, d] = yyyy_mm_dd.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function getSecondaryAuth() {
  const sec = getApps().find(a => a.name === 'secondary') ?? initializeApp(firebaseConfig, 'secondary')
  return getAuth(sec)
}

const FIELD = 'w-full bg-[#111113] border border-[#27272a] rounded-xl px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition'

// ── Tab definitions ───────────────────────────────────────────────────────────

const TABS = [
  { id: 'eventos',   label: 'Eventos',   Icon: Calendar },
  { id: 'registrar', label: 'Registrar', Icon: Camera },
  { id: 'registros', label: 'Registros', Icon: ClipboardList },
  { id: 'backup',    label: 'Backup',    Icon: Archive },
  { id: 'admin',     label: 'Admin',     Icon: Settings },
] as const
type TabId = typeof TABS[number]['id']

// ── ❶ Eventos tab ─────────────────────────────────────────────────────────────

function EventosTab() {
  const { profile } = useAuth()
  const [eventos, setEventos] = useState<(Evento & { totalAsistentes: number })[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState({ nombre: '', lugar: '', descripcion: '', fecha: '' })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)

  useEffect(() => {
    const q = query(collection(db, 'eventos'), orderBy('fecha', 'desc'))
    const unsub = onSnapshot(q,
      async (snap) => {
        try {
          const evs = snap.docs.map(d => ({ id: d.id, ...d.data() } as Evento))
          const withTotal = await Promise.all(
            evs.map(async e => ({ ...e, totalAsistentes: await getTotalAsistentes(e.id!) }))
          )
          setEventos(withTotal)
          setError(null)
        } catch { setError('Error al procesar eventos') }
        finally { setLoading(false) }
      },
      (err) => { setError(`Firestore: ${err.code} — ${err.message}`); setLoading(false) },
    )
    return () => unsub()
  }, [])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.nombre || !form.fecha || !form.lugar || !profile) return
    setSaving(true); setSaveError(null)
    try {
      await addDoc(collection(db, 'eventos'), {
        nombre: form.nombre.trim(),
        descripcion: form.descripcion.trim(),
        lugar: form.lugar.trim(),
        fecha: Timestamp.fromDate(parseLocalDate(form.fecha)),
        creadoPor: profile.id,
        activo: true,
        creadoEn: serverTimestamp(),
        createdAt: serverTimestamp(),
      })
      setShowModal(false)
      setForm({ nombre: '', lugar: '', descripcion: '', fecha: '' })
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string }
      setSaveError(`Error al guardar (${e.code ?? 'desconocido'}): ${e.message ?? ''}`)
    } finally { setSaving(false) }
  }

  const handleDelete = async (id: string) => {
    try { await deleteEvento(id); setConfirmDel(null) }
    catch (err: unknown) {
      const e = err as { code?: string; message?: string }
      setError(`No se pudo eliminar (${e.code ?? 'error'}): ${e.message ?? ''}`)
    }
  }

  const filtered = eventos.filter(ev =>
    ev.nombre.toLowerCase().includes(search.toLowerCase()) ||
    ev.descripcion?.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <>
      {/* Header row */}
      <div className="flex items-center justify-between mb-5">
        <p className="text-zinc-500 text-sm">{eventos.length} evento{eventos.length !== 1 ? 's' : ''}</p>
        <button onClick={() => setShowModal(true)}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2.5 rounded-xl transition active:scale-95">
          <Plus size={16} /> Nuevo Evento
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 mb-4 text-sm text-red-400">
          <AlertCircle size={15} className="shrink-0 mt-0.5" />{error}
        </div>
      )}

      <div className="relative mb-5">
        <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar evento…"
          className={`${FIELD} pl-10`} />
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><Spinner size="lg" /></div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20 text-zinc-600">
          <Calendar size={48} className="mx-auto mb-3 opacity-30" />
          <p>{search ? 'Sin resultados' : 'No hay eventos aún'}</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map(ev => (
            <div key={ev.id} className="bg-[#111113] border border-[#27272a] rounded-2xl p-5 flex flex-col hover:border-zinc-600 transition">
              <div className="flex items-start justify-between gap-2 mb-1">
                <h3 className="font-semibold text-white truncate flex-1">{ev.nombre}</h3>
                <div className={`w-2.5 h-2.5 rounded-full shrink-0 mt-1.5 ${ev.activo ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
              </div>
              <p className="text-zinc-500 text-xs mb-1">
                {format(toDate(ev.fecha), "d MMM yyyy", { locale: es })}
                {ev.lugar && <span className="text-zinc-600"> · {ev.lugar}</span>}
              </p>
              {ev.descripcion && <p className="text-zinc-400 text-xs line-clamp-2 mb-3">{ev.descripcion}</p>}
              <div className="mt-auto">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-1.5 text-zinc-400 text-sm">
                    <Users size={14} />
                    <span className="font-semibold text-white">{ev.totalAsistentes}</span>
                    <span className="text-xs">asistentes</span>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => navigator.clipboard.writeText(`${window.location.origin}/evento/${ev.id}`).then(() => alert('Link copiado'))}
                      className="p-1.5 rounded-lg text-zinc-500 hover:text-blue-400 hover:bg-blue-400/10 transition">
                      <LinkIcon size={14} />
                    </button>
                    {profile?.rol === 'admin' && (
                      <button onClick={() => setConfirmDel(ev.id!)}
                        className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-400/10 transition">
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Link href={`/dashboard/eventos/${ev.id}/scanner`}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition active:scale-95">
                    📷 Escanear
                  </Link>
                  <Link href={`/dashboard/eventos/${ev.id}`}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-white/8 hover:bg-white/12 text-zinc-300 text-xs font-semibold border border-[#27272a] hover:border-zinc-500 transition active:scale-95">
                    📊 Ver registros
                  </Link>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create modal */}
      <Modal open={showModal} onClose={() => { setShowModal(false); setSaveError(null) }} title="Nuevo evento">
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Nombre *</label>
            <input required value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))}
              placeholder="Festival de verano 2025" className={FIELD} />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Fecha *</label>
            <input required type="date" value={form.fecha} onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))}
              className={`${FIELD} [color-scheme:dark]`} />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Lugar *</label>
            <input required value={form.lugar} onChange={e => setForm(f => ({ ...f, lugar: e.target.value }))}
              placeholder="Parque principal, Bogotá" className={FIELD} />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Descripción <span className="text-zinc-600">(opcional)</span></label>
            <textarea value={form.descripcion} onChange={e => setForm(f => ({ ...f, descripcion: e.target.value }))}
              rows={2} placeholder="Descripción del evento…"
              className={`${FIELD} resize-none`} />
          </div>
          {saveError && (
            <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">
              <AlertCircle size={13} className="shrink-0 mt-0.5" />{saveError}
            </div>
          )}
          <div className="flex gap-3 pt-1">
            <button type="button"
              onClick={() => { setShowModal(false); setSaveError(null); setForm({ nombre: '', lugar: '', descripcion: '', fecha: '' }) }}
              className="flex-1 py-2.5 rounded-xl border border-[#27272a] text-zinc-400 text-sm hover:bg-white/5 transition">
              Cancelar
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-500 transition disabled:opacity-60 flex items-center justify-center gap-2">
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
            <p className="text-zinc-400 text-sm mb-5">Esta acción no se puede deshacer.</p>
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

// ── ❷ Registrar tab ───────────────────────────────────────────────────────────

function RegistrarTab() {
  const router = useRouter()
  const [eventos, setEventos] = useState<Evento[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const q = query(collection(db, 'eventos'), where('activo', '==', true), orderBy('fecha', 'desc'))
    const unsub = onSnapshot(q, (snap) => {
      const evs = snap.docs.map(d => ({ id: d.id, ...d.data() } as Evento))
      setEventos(evs)
      if (evs.length > 0 && !selectedId) setSelectedId(evs[0].id!)
      setLoading(false)
    })
    return () => unsub()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div className="flex justify-center py-20"><Spinner size="lg" /></div>

  if (eventos.length === 0) return (
    <div className="text-center py-20 text-zinc-600">
      <Camera size={48} className="mx-auto mb-3 opacity-30" />
      <p>No hay eventos activos.</p>
      <p className="text-sm mt-1">Crea uno en la pestaña <strong className="text-zinc-400">Eventos</strong>.</p>
    </div>
  )

  return (
    <div className="max-w-md mx-auto py-8 space-y-6">
      <div>
        <label className="block text-xs text-zinc-400 mb-2">Selecciona el evento</label>
        <select value={selectedId} onChange={e => setSelectedId(e.target.value)}
          className={`${FIELD} [color-scheme:dark]`}>
          {eventos.map(ev => (
            <option key={ev.id} value={ev.id!}>
              {ev.nombre} — {format(toDate(ev.fecha), "d MMM yyyy", { locale: es })}
            </option>
          ))}
        </select>
      </div>

      <div className="bg-[#111113] border border-[#27272a] rounded-2xl p-5 text-center space-y-2">
        <p className="text-zinc-400 text-sm">Cédula nueva: apunta al <strong className="text-white">reverso</strong> (zona MRZ)</p>
        <p className="text-zinc-400 text-sm">Cédula vieja: apunta al <strong className="text-white">frente</strong> (código PDF417)</p>
        <p className="text-zinc-500 text-xs mt-1">La linterna (⚡) se activa automáticamente si el dispositivo la soporta.</p>
      </div>

      <button
        disabled={!selectedId}
        onClick={() => router.push(`/dashboard/eventos/${selectedId}/scanner`)}
        className="w-full py-4 rounded-2xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-bold text-base transition active:scale-95 flex items-center justify-center gap-3 shadow-lg shadow-blue-600/30"
      >
        <Camera size={22} /> Escanear cédula
      </button>

      <p className="text-zinc-600 text-xs text-center">
        Se solicitará acceso a la cámara del dispositivo. El escáner incluye botón de linterna (⚡).
      </p>
    </div>
  )
}

// ── ❸ Registros tab ───────────────────────────────────────────────────────────

function RegistrosTab() {
  const [eventos, setEventos] = useState<Evento[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [asistentes, setAsistentes] = useState<Asistente[]>([])
  const [loadingEvs, setLoadingEvs] = useState(true)
  const [loadingAsis, setLoadingAsis] = useState(false)
  const [search, setSearch] = useState('')

  useEffect(() => {
    const q = query(collection(db, 'eventos'), orderBy('fecha', 'desc'))
    const unsub = onSnapshot(q, (snap) => {
      const evs = snap.docs.map(d => ({ id: d.id, ...d.data() } as Evento))
      setEventos(evs)
      if (evs.length > 0 && !selectedId) setSelectedId(evs[0].id!)
      setLoadingEvs(false)
    })
    return () => unsub()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedId) return
    setLoadingAsis(true)
    getAsistentes(selectedId).then(a => { setAsistentes(a); setLoadingAsis(false) })
  }, [selectedId])

  const filtered = asistentes.filter(a => {
    const q = search.toLowerCase()
    return a.numeroCedula.includes(q) || a.apellidos.toLowerCase().includes(q) || a.nombres.toLowerCase().includes(q)
  })

  if (loadingEvs) return <div className="flex justify-center py-20"><Spinner size="lg" /></div>
  if (eventos.length === 0) return (
    <div className="text-center py-20 text-zinc-600">
      <ClipboardList size={48} className="mx-auto mb-3 opacity-30" />
      <p>No hay eventos. Crea uno en la pestaña Eventos.</p>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3">
        <select value={selectedId} onChange={e => setSelectedId(e.target.value)}
          className={`${FIELD} flex-1 [color-scheme:dark]`}>
          {eventos.map(ev => <option key={ev.id} value={ev.id!}>{ev.nombre}</option>)}
        </select>
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar…"
            className={`${FIELD} pl-10`} />
        </div>
      </div>

      <p className="text-zinc-500 text-sm">
        {filtered.length} registro{filtered.length !== 1 ? 's' : ''}
        {search && ` para "${search}"`}
      </p>

      {loadingAsis ? (
        <div className="flex justify-center py-10"><Spinner size="lg" /></div>
      ) : (
        <div className="bg-[#111113] border border-[#27272a] rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#27272a] text-zinc-500 text-xs">
                  <th className="text-left px-4 py-3">#</th>
                  <th className="text-left px-4 py-3">Cédula</th>
                  <th className="text-left px-4 py-3">Nombre</th>
                  <th className="text-left px-4 py-3 hidden sm:table-cell">Sexo / Edad</th>
                  <th className="text-left px-4 py-3 hidden md:table-cell">Hora</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={5} className="text-center py-12 text-zinc-600">Sin registros</td></tr>
                ) : filtered.slice(0, 100).map((a, i) => (
                  <tr key={a.id} className="border-b border-[#1a1a1d] hover:bg-white/[0.02] transition">
                    <td className="px-4 py-3 text-zinc-600 font-mono text-xs">{i + 1}</td>
                    <td className="px-4 py-3 font-mono text-blue-400 text-xs">{a.numeroCedula}</td>
                    <td className="px-4 py-3">
                      <p className="text-white font-medium leading-tight">{a.apellidos}</p>
                      <p className="text-zinc-400 text-xs">{a.nombres}</p>
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell text-zinc-400 text-xs">
                      {a.sexo ?? '—'} {a.edad ? `· ${a.edad} años` : ''}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell text-zinc-500 text-xs">
                      {format(toDate(a.horaIngreso), 'HH:mm:ss')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length > 100 && (
            <div className="px-4 py-3 border-t border-[#27272a] text-xs text-zinc-500">
              Mostrando 100 de {filtered.length}. Ve a{' '}
              <Link href={`/dashboard/eventos/${selectedId}`} className="text-blue-400 hover:underline">
                la página del evento
              </Link>{' '}
              para ver todos con paginación y exportación.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── ❹ Backup tab ──────────────────────────────────────────────────────────────

function BackupTab() {
  const { profile } = useAuth()
  const [eventos, setEventos] = useState<Evento[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    const q = query(collection(db, 'eventos'), orderBy('fecha', 'desc'))
    const unsub = onSnapshot(q, (snap) => {
      const evs = snap.docs.map(d => ({ id: d.id, ...d.data() } as Evento))
      setEventos(evs)
      if (evs.length > 0 && !selectedId) setSelectedId(evs[0].id!)
      setLoading(false)
    })
    return () => unsub()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleExport = async (type: 'excel' | 'json') => {
    if (!selectedId) return
    setExporting(true)
    try {
      const evento = eventos.find(e => e.id === selectedId)!
      const asis = await getAsistentes(selectedId)
      if (type === 'excel') await exportToExcel(asis, evento.nombre)
      else exportToJson(asis, evento)
    } finally { setExporting(false) }
  }

  if (loading) return <div className="flex justify-center py-20"><Spinner size="lg" /></div>
  if (eventos.length === 0) return (
    <div className="text-center py-20 text-zinc-600">
      <Archive size={48} className="mx-auto mb-3 opacity-30" />
      <p>No hay eventos para exportar.</p>
    </div>
  )

  if (profile?.rol !== 'admin') return (
    <div className="text-center py-20 text-zinc-600">
      <Shield size={48} className="mx-auto mb-3 opacity-30" />
      <p>Solo los administradores pueden exportar datos.</p>
    </div>
  )

  return (
    <div className="max-w-md mx-auto py-8 space-y-6">
      <div>
        <label className="block text-xs text-zinc-400 mb-2">Evento a exportar</label>
        <select value={selectedId} onChange={e => setSelectedId(e.target.value)}
          className={`${FIELD} [color-scheme:dark]`}>
          {eventos.map(ev => <option key={ev.id} value={ev.id!}>{ev.nombre}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <button disabled={exporting} onClick={() => handleExport('excel')}
          className="flex items-center justify-center gap-2 py-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold transition disabled:opacity-50">
          <Download size={16} /> Excel
        </button>
        <button disabled={exporting} onClick={() => handleExport('json')}
          className="flex items-center justify-center gap-2 py-3.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-sm font-semibold transition disabled:opacity-50">
          <FileJson size={16} /> JSON
        </button>
      </div>
      {exporting && (
        <div className="flex items-center justify-center gap-2 text-zinc-400 text-sm">
          <Spinner size="sm" /> Generando archivo…
        </div>
      )}
      <p className="text-zinc-600 text-xs text-center">
        Excel: tabla de asistentes · JSON: backup completo con metadatos del evento
      </p>
    </div>
  )
}

// ── ❺ Admin tab ───────────────────────────────────────────────────────────────

function AdminTab() {
  const { profile } = useAuth()
  const [usuarios, setUsuarios] = useState<UserProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState({ email: '', nombre: '', password: '', rol: 'ayudante' as 'admin' | 'ayudante' })
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setUsuarios(await getUsuarios()); setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  if (profile?.rol !== 'admin') return (
    <div className="text-center py-20 text-zinc-600">
      <Shield size={48} className="mx-auto mb-3 opacity-30" />
      <p>Solo los administradores pueden gestionar usuarios.</p>
    </div>
  )

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.email || !form.nombre || !form.password) { setFormError('Completa todos los campos'); return }
    if (form.password.length < 6) { setFormError('La contraseña debe tener mínimo 6 caracteres'); return }
    setSaving(true); setFormError('')
    try {
      const secAuth = getSecondaryAuth()
      const cred = await createUserWithEmailAndPassword(secAuth, form.email.trim(), form.password)
      await setUsuarioPerfil(cred.user.uid, { email: form.email.trim(), nombre: form.nombre.trim(), rol: form.rol, activo: true })
      await secAuth.signOut()
      setShowModal(false); setForm({ email: '', nombre: '', password: '', rol: 'ayudante' }); load()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : ''
      setFormError(msg.includes('email-already-in-use') ? 'El email ya está registrado' : msg || 'Error al crear usuario')
    } finally { setSaving(false) }
  }

  const toggleActivo = async (u: UserProfile) => {
    await updateUsuario(u.id, { activo: !u.activo }); load()
  }

  return (
    <>
      <div className="flex items-center justify-between mb-5">
        <p className="text-zinc-500 text-sm">{usuarios.length} usuario{usuarios.length !== 1 ? 's' : ''}</p>
        <button onClick={() => setShowModal(true)}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2.5 rounded-xl transition active:scale-95">
          <UserPlus size={16} /> Nuevo usuario
        </button>
      </div>

      {loading ? <div className="flex justify-center py-20"><Spinner size="lg" /></div> : (
        <div className="space-y-2">
          {usuarios.map(u => (
            <div key={u.id} className="bg-[#111113] border border-[#27272a] rounded-xl px-4 py-3 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-full bg-[#27272a] flex items-center justify-center shrink-0">
                  {u.rol === 'admin' ? <Shield size={16} className="text-blue-400" /> : <User size={16} className="text-zinc-400" />}
                </div>
                <div className="min-w-0">
                  <p className="text-white text-sm font-medium truncate">{u.nombre}</p>
                  <p className="text-zinc-500 text-xs truncate">{u.email}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`text-xs px-2 py-0.5 rounded-full ${u.rol === 'admin' ? 'bg-blue-500/20 text-blue-400' : 'bg-zinc-700 text-zinc-400'}`}>
                  {u.rol}
                </span>
                <button onClick={() => toggleActivo(u)}
                  className={`w-8 h-8 rounded-lg flex items-center justify-center transition ${u.activo ? 'text-emerald-400 hover:bg-emerald-400/10' : 'text-zinc-600 hover:bg-white/5'}`}
                  title={u.activo ? 'Desactivar' : 'Activar'}>
                  {u.activo ? <ChevronRight size={16} /> : <ChevronRight size={16} className="rotate-180" />}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={showModal} onClose={() => { setShowModal(false); setFormError('') }} title="Nuevo usuario">
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Nombre *</label>
            <input required value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))}
              placeholder="Juan Pérez" className={FIELD} />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Email *</label>
            <input required type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              placeholder="juan@ejemplo.com" className={FIELD} />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Contraseña *</label>
            <input required type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              placeholder="Mínimo 6 caracteres" className={FIELD} />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Rol</label>
            <select value={form.rol} onChange={e => setForm(f => ({ ...f, rol: e.target.value as 'admin' | 'ayudante' }))}
              className={`${FIELD} [color-scheme:dark]`}>
              <option value="ayudante">Ayudante</option>
              <option value="admin">Administrador</option>
            </select>
          </div>
          {formError && (
            <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">
              <AlertCircle size={13} className="shrink-0" />{formError}
            </div>
          )}
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={() => { setShowModal(false); setFormError('') }}
              className="flex-1 py-2.5 rounded-xl border border-[#27272a] text-zinc-400 text-sm hover:bg-white/5 transition">
              Cancelar
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-500 transition disabled:opacity-60 flex items-center justify-center gap-2">
              {saving ? <><Spinner size="sm" /> Creando…</> : 'Crear usuario'}
            </button>
          </div>
        </form>
      </Modal>
    </>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [tab, setTab] = useState<TabId>('eventos')

  return (
    <>
      <DashboardHeader title="Panel de control" />

      {/* Tab bar */}
      <div className="border-b border-[#27272a] sticky top-0 bg-[#09090b] z-10">
        <div className="flex overflow-x-auto scrollbar-hide px-4 lg:px-8 max-w-6xl mx-auto">
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-2 px-4 py-3.5 text-sm font-medium border-b-2 whitespace-nowrap transition -mb-px
                ${tab === id
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-zinc-500 hover:text-zinc-300 hover:border-zinc-600'}`}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="px-4 lg:px-8 py-6 max-w-6xl w-full mx-auto">
        {tab === 'eventos'   && <EventosTab />}
        {tab === 'registrar' && <RegistrarTab />}
        {tab === 'registros' && <RegistrosTab />}
        {tab === 'backup'    && <BackupTab />}
        {tab === 'admin'     && <AdminTab />}
      </div>
    </>
  )
}
