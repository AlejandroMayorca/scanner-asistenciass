'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertCircle, Download, Shield, Trash2, UserPlus, Users,
} from 'lucide-react'
import { createUserWithEmailAndPassword, getAuth } from 'firebase/auth'
import { initializeApp, getApps } from 'firebase/app'
import { Timestamp } from 'firebase/firestore'
import { firebaseConfig } from '../../lib/firebase'
import {
  getUsuarios, setUsuarioPerfil, updateUsuario,
  getEventos, eliminarEvento, getTotalAsistencias,
  getFullBackup,
} from '../../lib/firestore'
import { exportarJson } from '../../lib/export'
import { useAuth } from '../../context/AuthContext'
import { Modal } from '../../components/ui/Modal'
import { Spinner } from '../../components/ui/Spinner'
import type { UserProfile, Evento } from '../../lib/types'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'

function toDate(v: unknown): Date {
  if (v instanceof Timestamp) return v.toDate()
  if (v instanceof Date) return v
  if (v && typeof v === 'object' && 'seconds' in v)
    return new Date((v as { seconds: number }).seconds * 1000)
  return new Date()
}

function getSecondaryAuth() {
  const sec = getApps().find(a => a.name === 'secondary') ?? initializeApp(firebaseConfig, 'secondary')
  return getAuth(sec)
}

const FIELD =
  'w-full bg-[#111113] border border-[#27272a] rounded-xl px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition'

type AdminTab = 'usuarios' | 'eventos' | 'backup'

export default function AdminPage() {
  const { profile, user } = useAuth()
  const router = useRouter()
  const [tab, setTab] = useState<AdminTab>('usuarios')

  const isAdmin = profile?.rol === 'admin' || user?.email === 'admin@cedulascan.com'

  // Redirect non-admins
  useEffect(() => {
    if (profile && !isAdmin) router.replace('/dashboard/eventos')
  }, [profile, isAdmin, router])

  if (!profile || !isAdmin) {
    return (
      <div className="flex items-center justify-center h-dvh text-zinc-600">
        <Shield size={40} className="opacity-30" />
      </div>
    )
  }

  const TABS: { id: AdminTab; label: string }[] = [
    { id: 'usuarios', label: '👤 Usuarios' },
    { id: 'eventos',  label: '📅 Eventos'  },
    { id: 'backup',   label: '💾 Backup'   },
  ]

  return (
    <div className="min-h-dvh flex flex-col">
      {/* Header */}
      <div className="px-4 lg:px-8 pt-6 pb-0 max-w-4xl w-full mx-auto">
        <div className="mb-4">
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Shield size={20} className="text-blue-400" /> Panel de administración
          </h1>
          <p className="text-zinc-500 text-sm mt-0.5">Gestión de usuarios, eventos y backups</p>
        </div>

        <div className="flex border-b border-[#27272a]">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-5 py-3 text-sm font-medium border-b-2 -mb-px transition whitespace-nowrap ${
                tab === t.id
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-zinc-500 hover:text-zinc-300'
              }`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 lg:px-8 py-6 max-w-4xl w-full mx-auto flex-1">
        {tab === 'usuarios' && <UsuariosTab />}
        {tab === 'eventos'  && <EventosAdminTab />}
        {tab === 'backup'   && <BackupTab />}
      </div>
    </div>
  )
}

// ── Usuarios tab ──────────────────────────────────────────────────────────────

function UsuariosTab() {
  const [usuarios, setUsuarios] = useState<UserProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ email: '', password: '', rol: 'ayudante' as 'admin' | 'ayudante' })
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setUsuarios(await getUsuarios())
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (form.password.length < 6) { setFormError('La contraseña debe tener mínimo 6 caracteres'); return }
    setSaving(true)
    setFormError('')
    try {
      const secAuth = getSecondaryAuth()
      const cred = await createUserWithEmailAndPassword(secAuth, form.email.trim(), form.password)
      await setUsuarioPerfil(cred.user.uid, { email: form.email.trim(), rol: form.rol, activo: true })
      await secAuth.signOut()
      setShowCreate(false)
      setForm({ email: '', password: '', rol: 'ayudante' })
      load()
    } catch (err: unknown) {
      const msg = (err as Error).message ?? ''
      setFormError(
        msg.includes('email-already-in-use') ? 'El email ya está registrado' :
        msg.includes('invalid-email') ? 'Email inválido' : msg || 'Error al crear usuario',
      )
    } finally {
      setSaving(false)
    }
  }

  const toggleActivo = async (u: UserProfile) => {
    await updateUsuario(u.id, { activo: !u.activo })
    load()
  }

  return (
    <>
      <div className="flex items-center justify-between mb-5">
        <p className="text-zinc-500 text-sm">{usuarios.length} usuario{usuarios.length !== 1 ? 's' : ''}</p>
        <button onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-4 py-2.5 rounded-xl transition active:scale-95">
          <UserPlus size={16} /> Nuevo ayudante
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Spinner size="lg" /></div>
      ) : (
        <div className="space-y-2">
          {usuarios.map(u => (
            <div key={u.id} className="bg-[#111113] border border-[#27272a] rounded-xl px-4 py-3.5 flex items-center gap-4">
              <div className="w-9 h-9 rounded-full bg-[#27272a] flex items-center justify-center shrink-0">
                <Users size={16} className="text-zinc-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-white text-sm font-medium truncate">{u.email}</p>
                <p className="text-zinc-500 text-xs mt-0.5">
                  {u.rol} · Creado {format(toDate(u.creadoEn), "d MMM yyyy", { locale: es })}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                  u.rol === 'admin' ? 'bg-blue-500/20 text-blue-400' : 'bg-zinc-700 text-zinc-400'
                }`}>
                  {u.rol}
                </span>
                <button onClick={() => toggleActivo(u)}
                  className={`text-xs px-2 py-1 rounded-lg font-medium transition ${
                    u.activo
                      ? 'bg-emerald-500/15 text-emerald-400 hover:bg-red-500/15 hover:text-red-400'
                      : 'bg-zinc-700/50 text-zinc-500 hover:bg-emerald-500/15 hover:text-emerald-400'
                  }`}>
                  {u.activo ? 'Activo' : 'Inactivo'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={showCreate} onClose={() => { setShowCreate(false); setFormError('') }} title="Nuevo usuario">
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Email *</label>
            <input required type="email" value={form.email}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              placeholder="usuario@ejemplo.com" className={FIELD} />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Contraseña *</label>
            <input required type="password" value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              placeholder="Mínimo 6 caracteres" className={FIELD} />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Rol</label>
            <select value={form.rol}
              onChange={e => setForm(f => ({ ...f, rol: e.target.value as 'admin' | 'ayudante' }))}
              className={`${FIELD} [color-scheme:dark]`}>
              <option value="ayudante">Ayudante</option>
              <option value="admin">Administrador</option>
            </select>
          </div>
          {formError && (
            <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">
              <AlertCircle size={13} />{formError}
            </div>
          )}
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={() => { setShowCreate(false); setFormError('') }}
              className="flex-1 py-2.5 rounded-xl border border-[#27272a] text-zinc-400 text-sm hover:bg-white/5 transition">
              Cancelar
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-500 disabled:opacity-60 transition flex items-center justify-center gap-2">
              {saving ? <><Spinner size="sm" /> Creando…</> : 'Crear usuario'}
            </button>
          </div>
        </form>
      </Modal>
    </>
  )
}

// ── Eventos admin tab ─────────────────────────────────────────────────────────

function EventosAdminTab() {
  const [eventos, setEventos] = useState<(Evento & { total: number })[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const evs = await getEventos()
    const withTotal = await Promise.all(
      evs.map(async ev => ({ ...ev, total: await getTotalAsistencias(ev.id!) })),
    )
    setEventos(withTotal)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const handleDelete = async (id: string) => {
    setDeleting(true)
    try {
      await eliminarEvento(id)
      setConfirmDel(null)
      load()
    } catch (err: unknown) {
      setError((err as { message?: string }).message ?? 'Error al eliminar')
    } finally {
      setDeleting(false)
    }
  }

  if (loading) return <div className="flex justify-center py-16"><Spinner size="lg" /></div>

  return (
    <>
      {error && (
        <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 mb-4 text-sm text-red-400">
          <AlertCircle size={14} />{error}
        </div>
      )}
      <div className="space-y-2">
        {eventos.map(ev => (
          <div key={ev.id} className="bg-[#111113] border border-[#27272a] rounded-xl px-4 py-3.5 flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-white text-sm font-medium truncate">{ev.nombre}</p>
              <p className="text-zinc-500 text-xs mt-0.5">
                {format(toDate(ev.fecha), "d MMM yyyy", { locale: es })}
                {ev.lugar && ` · ${ev.lugar}`}
                {' · '}<span className="text-white">{ev.total}</span> asistentes
              </p>
            </div>
            <button onClick={() => setConfirmDel(ev.id!)}
              className="p-2 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-400/10 transition shrink-0">
              <Trash2 size={16} />
            </button>
          </div>
        ))}
        {eventos.length === 0 && (
          <p className="text-center py-12 text-zinc-600">No hay eventos</p>
        )}
      </div>

      {confirmDel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70" onClick={() => setConfirmDel(null)} />
          <div className="relative bg-[#18181b] border border-[#27272a] rounded-2xl p-6 max-w-xs w-full">
            <p className="font-semibold text-white mb-2">¿Eliminar evento?</p>
            <p className="text-zinc-400 text-sm mb-5">Se eliminarán el evento y <strong className="text-white">todas</strong> sus asistencias. No se puede deshacer.</p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmDel(null)}
                className="flex-1 py-2.5 rounded-xl border border-[#27272a] text-zinc-400 text-sm hover:bg-white/5 transition">
                Cancelar
              </button>
              <button onClick={() => handleDelete(confirmDel)} disabled={deleting}
                className="flex-1 py-2.5 rounded-xl bg-red-600 text-white text-sm font-semibold hover:bg-red-500 disabled:opacity-60 transition flex items-center justify-center gap-2">
                {deleting ? <><Spinner size="sm" /> Eliminando…</> : 'Eliminar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ── Backup tab ────────────────────────────────────────────────────────────────

function BackupTab() {
  const [loading, setLoading] = useState(false)

  const handleBackup = async () => {
    setLoading(true)
    try {
      const data = await getFullBackup()
      exportarJson(data)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-md">
      <div className="bg-[#111113] border border-[#27272a] rounded-2xl p-6 space-y-4">
        <div>
          <h3 className="font-semibold text-white mb-1">Backup completo JSON</h3>
          <p className="text-zinc-400 text-sm">
            Descarga todos los eventos y sus asistencias como un archivo JSON. Incluye metadatos
            del evento, lista completa de asistentes con todos los campos, y marca de tiempo de exportación.
          </p>
        </div>
        <button
          onClick={handleBackup}
          disabled={loading}
          className="flex items-center gap-2 px-5 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white text-sm font-semibold transition active:scale-95"
        >
          {loading ? <><Spinner size="sm" /> Generando backup…</> : <><Download size={16} /> Descargar Backup JSON</>}
        </button>
      </div>

      <p className="text-zinc-600 text-xs mt-4">
        Solo los administradores pueden descargar backups. El archivo incluye datos personales —
        manéjalo con cuidado.
      </p>
    </div>
  )
}
