'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertCircle, CheckCircle, ClipboardList, Copy, Download, Eye,
  Shield, Trash2, Upload, UserPlus, Users, X,
} from 'lucide-react'
import { createUserWithEmailAndPassword, getAuth } from 'firebase/auth'
import { initializeApp, getApps } from 'firebase/app'
import { Timestamp } from 'firebase/firestore'
import { firebaseConfig } from '../../lib/firebase'
import {
  getUsuarios, setUsuarioPerfil, updateUsuario,
  getEventos, eliminarEvento, getTotalAsistencias,
  getFullBackup, restaurarBackup,
  getOperadores, setOperador, updateOperador, getAsistenciasByOperador,
} from '../../lib/firestore'
import type { BackupData } from '../../lib/firestore'
import { exportarJson } from '../../lib/export'
import { useAuth } from '../../context/AuthContext'
import { Modal } from '../../components/ui/Modal'
import { Spinner } from '../../components/ui/Spinner'
import type { UserProfile, Evento, OperadorPerfil, Asistencia } from '../../lib/types'
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

type AdminTab = 'usuarios' | 'operadores' | 'eventos' | 'backup'

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
    { id: 'usuarios',   label: '👤 Usuarios'   },
    { id: 'operadores', label: '🧑‍💼 Operadores' },
    { id: 'eventos',    label: '📅 Eventos'    },
    { id: 'backup',     label: '💾 Backup'     },
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
        {tab === 'usuarios'   && <UsuariosTab />}
        {tab === 'operadores' && <OperadoresTab />}
        {tab === 'eventos'    && <EventosAdminTab />}
        {tab === 'backup'     && <BackupTab />}
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

// ── Operadores tab ────────────────────────────────────────────────────────────

function OperadoresTab() {
  const { user } = useAuth()
  const [operadores, setOperadores]     = useState<OperadorPerfil[]>([])
  const [loading, setLoading]           = useState(true)
  const [showCreate, setShowCreate]     = useState(false)
  const [creating, setCreating]         = useState(false)
  const [createError, setCreateError]   = useState('')
  const [showCreds, setShowCreds]       = useState<{ email: string; password: string } | null>(null)
  const [viewRecs, setViewRecs]         = useState<OperadorPerfil | null>(null)
  const [confirmDel, setConfirmDel]     = useState<OperadorPerfil | null>(null)
  const [copiedCred, setCopiedCred]     = useState(false)
  const [form, setForm] = useState({ nombre: '', apellido: '', email: '', password: '' })

  const load = useCallback(async () => {
    setLoading(true)
    setOperadores(await getOperadores())
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (form.password.length < 6) { setCreateError('La contraseña debe tener mínimo 6 caracteres'); return }
    setCreating(true); setCreateError('')
    try {
      const secAuth = getSecondaryAuth()
      const cred = await createUserWithEmailAndPassword(secAuth, form.email.trim(), form.password)
      await setOperador(cred.user.uid, {
        email:      form.email.trim(),
        nombre:     form.nombre.trim(),
        apellido:   form.apellido.trim(),
        activo:     true,
        creadoPor:  user?.email ?? '',
      })
      await secAuth.signOut()
      setShowCreds({ email: form.email.trim(), password: form.password })
      setForm({ nombre: '', apellido: '', email: '', password: '' })
      load()
    } catch (err: unknown) {
      const msg = (err as Error).message ?? ''
      setCreateError(
        msg.includes('email-already-in-use') ? 'El email ya está registrado' :
        msg.includes('invalid-email') ? 'Email inválido' : msg || 'Error al crear operador',
      )
    } finally {
      setCreating(false)
    }
  }

  const copyCredText = (email: string, password: string) => {
    navigator.clipboard.writeText(`Email: ${email}\nContraseña: ${password}`).catch(() => {})
    setCopiedCred(true)
    setTimeout(() => setCopiedCred(false), 2000)
  }

  const toggleActivo = async (op: OperadorPerfil) => {
    await updateOperador(op.uid, { activo: !op.activo })
    load()
  }

  const handleDeactivate = async () => {
    if (!confirmDel) return
    await updateOperador(confirmDel.uid, { activo: false })
    setConfirmDel(null)
    load()
  }

  return (
    <>
      <div className="flex items-center justify-between mb-5">
        <p className="text-zinc-500 text-sm">{operadores.length} operador{operadores.length !== 1 ? 'es' : ''}</p>
        <button onClick={() => { setShowCreate(true); setShowCreds(null); setCreateError('') }}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-4 py-2.5 rounded-xl transition active:scale-95">
          <UserPlus size={16} /> Crear operador
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Spinner size="lg" /></div>
      ) : (
        <div className="space-y-2">
          {operadores.length === 0 && (
            <p className="text-center py-12 text-zinc-600">No hay operadores. Crea el primero.</p>
          )}
          {operadores.map(op => (
            <div key={op.uid} className="bg-[#111113] border border-[#27272a] rounded-xl px-4 py-3.5 flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-[#27272a] flex items-center justify-center shrink-0">
                <Users size={16} className="text-zinc-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-white text-sm font-medium truncate">{op.nombre} {op.apellido}</p>
                <p className="text-zinc-500 text-xs mt-0.5 truncate">
                  {op.email} · {op.ultimoAcceso
                    ? `Último acceso ${format(toDate(op.ultimoAcceso), "d MMM yyyy HH:mm", { locale: es })}`
                    : 'Sin accesos'}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                  op.activo ? 'bg-emerald-500/20 text-emerald-400' : 'bg-zinc-700 text-zinc-500'
                }`}>
                  {op.activo ? 'Activo' : 'Inactivo'}
                </span>
                <button onClick={() => setViewRecs(op)}
                  className="p-1.5 rounded-lg text-zinc-500 hover:text-blue-400 hover:bg-blue-400/10 transition" title="Ver registros">
                  <Eye size={14} />
                </button>
                <button onClick={() => toggleActivo(op)}
                  className={`text-xs px-2 py-1 rounded-lg font-medium transition ${
                    op.activo
                      ? 'bg-emerald-500/15 text-emerald-400 hover:bg-red-500/15 hover:text-red-400'
                      : 'bg-zinc-700/50 text-zinc-500 hover:bg-emerald-500/15 hover:text-emerald-400'
                  }`}>
                  {op.activo ? 'Desactivar' : 'Activar'}
                </button>
                {op.activo && (
                  <button onClick={() => setConfirmDel(op)}
                    className="p-1.5 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-400/10 transition" title="Eliminar">
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create modal */}
      <Modal open={showCreate} onClose={() => { setShowCreate(false); setShowCreds(null); setCreateError('') }} title="Nuevo operador">
        {showCreds ? (
          <div className="space-y-4">
            <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4">
              <p className="text-emerald-400 font-semibold text-sm mb-3">✅ Operador creado exitosamente</p>
              <p className="text-xs text-zinc-400 mb-1">Comparte estas credenciales con el operador:</p>
              <div className="bg-[#0a0a0a] rounded-lg p-3 font-mono text-xs space-y-1">
                <p><span className="text-zinc-500">Email:</span> <span className="text-white">{showCreds.email}</span></p>
                <p><span className="text-zinc-500">Contraseña:</span> <span className="text-white">{showCreds.password}</span></p>
              </div>
            </div>
            <button onClick={() => copyCredText(showCreds.email, showCreds.password)}
              className="flex items-center gap-2 w-full justify-center px-4 py-2.5 rounded-xl border border-[#27272a] text-sm text-zinc-400 hover:text-white hover:bg-white/5 transition">
              {copiedCred ? <><CheckCircle size={14} className="text-emerald-400" /> Copiado</> : <><Copy size={14} /> Copiar credenciales</>}
            </button>
            <button onClick={() => { setShowCreds(null); setShowCreate(false) }}
              className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition">
              Cerrar
            </button>
          </div>
        ) : (
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Nombre *</label>
                <input required value={form.nombre}
                  onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))}
                  placeholder="Juan" className={FIELD} />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Apellido *</label>
                <input required value={form.apellido}
                  onChange={e => setForm(f => ({ ...f, apellido: e.target.value }))}
                  placeholder="García" className={FIELD} />
              </div>
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">Email *</label>
              <input required type="email" value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                placeholder="operador@ejemplo.com" className={FIELD} />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">Contraseña *</label>
              <input required type="password" value={form.password}
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                placeholder="Mínimo 6 caracteres" className={FIELD} />
            </div>
            {createError && (
              <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">
                <AlertCircle size={13} />{createError}
              </div>
            )}
            <div className="flex gap-3 pt-1">
              <button type="button" onClick={() => { setShowCreate(false); setCreateError('') }}
                className="flex-1 py-2.5 rounded-xl border border-[#27272a] text-zinc-400 text-sm hover:bg-white/5 transition">
                Cancelar
              </button>
              <button type="submit" disabled={creating}
                className="flex-1 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-500 disabled:opacity-60 transition flex items-center justify-center gap-2">
                {creating ? <><Spinner size="sm" /> Creando…</> : 'Crear operador'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* Deactivate confirm */}
      {confirmDel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70" onClick={() => setConfirmDel(null)} />
          <div className="relative bg-[#18181b] border border-[#27272a] rounded-2xl p-6 max-w-xs w-full">
            <p className="font-semibold text-white mb-2">¿Eliminar operador?</p>
            <p className="text-zinc-400 text-sm mb-1">
              <strong className="text-white">{confirmDel.nombre} {confirmDel.apellido}</strong> será desactivado.
            </p>
            <p className="text-zinc-500 text-xs mb-5">Sus registros se conservan. Puedes reactivarlo después.</p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmDel(null)}
                className="flex-1 py-2.5 rounded-xl border border-[#27272a] text-zinc-400 text-sm hover:bg-white/5 transition">
                Cancelar
              </button>
              <button onClick={handleDeactivate}
                className="flex-1 py-2.5 rounded-xl bg-red-600 text-white text-sm font-semibold hover:bg-red-500 transition">
                Desactivar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Records panel */}
      {viewRecs && <OperadorRegistrosPanel operador={viewRecs} onClose={() => setViewRecs(null)} />}
    </>
  )
}

// ── Operador records panel ─────────────────────────────────────────────────────

function OperadorRegistrosPanel({ operador, onClose }: { operador: OperadorPerfil; onClose: () => void }) {
  const [asistencias, setAsistencias] = useState<(Asistencia & { eventoId: string })[]>([])
  const [eventoNames, setEventoNames] = useState<Record<string, string>>({})
  const [loading, setLoading]         = useState(true)
  const [loadError, setLoadError]     = useState('')
  const [filterEvento, setFilterEvento] = useState('')

  useEffect(() => {
    Promise.all([
      getAsistenciasByOperador(operador.uid),
      getEventos(),
    ]).then(([asis, evs]) => {
      setAsistencias(asis)
      setEventoNames(Object.fromEntries(evs.map(e => [e.id!, e.nombre])))
      setLoading(false)
    }).catch(err => {
      setLoadError(err instanceof Error ? err.message : 'Error al cargar registros')
      setLoading(false)
    })
  }, [operador.uid])

  const eventoOptions = [...new Set(asistencias.map(a => a.eventoId))].filter(Boolean)

  const filtered = filterEvento
    ? asistencias.filter(a => a.eventoId === filterEvento)
    : asistencias

  const isIncompleto = (a: Asistencia) => !a.nombres?.trim() || !a.apellidos?.trim() || !a.cedula?.trim()

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#09090b]">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 lg:px-8 py-4 border-b border-[#27272a] shrink-0">
        <button onClick={onClose}
          className="p-2 rounded-lg text-zinc-500 hover:text-white hover:bg-white/5 transition">
          <X size={18} />
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="text-white font-semibold text-base">
            <ClipboardList size={15} className="inline mr-1.5 text-blue-400" />
            Registros de {operador.nombre} {operador.apellido}
          </h2>
          <p className="text-zinc-500 text-xs">{filtered.length} registro{filtered.length !== 1 ? 's' : ''}{filterEvento ? ' en este evento' : ' en total'}</p>
        </div>
        {eventoOptions.length > 1 && (
          <select value={filterEvento} onChange={e => setFilterEvento(e.target.value)}
            className="bg-[#111113] border border-[#27272a] rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 [color-scheme:dark]">
            <option value="">Todos los eventos</option>
            {eventoOptions.map(id => (
              <option key={id} value={id}>{eventoNames[id] || id}</option>
            ))}
          </select>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto px-4 lg:px-8 py-4">
        {loading ? (
          <div className="flex justify-center py-16"><Spinner size="lg" /></div>
        ) : loadError ? (
          <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 text-sm text-amber-400 max-w-lg">
            <AlertCircle size={15} className="shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold mb-1">Error al cargar registros</p>
              <p className="text-xs opacity-80">{loadError}</p>
              <p className="text-xs opacity-60 mt-1">Es posible que necesites crear un índice en la consola de Firebase para esta consulta.</p>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-zinc-600">
            <ClipboardList size={36} className="mx-auto mb-2 opacity-30" />
            <p>Este operador no tiene registros aún.</p>
          </div>
        ) : (
          <div className="bg-[#111113] border border-[#27272a] rounded-2xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#27272a] text-zinc-500 text-xs">
                    <th className="text-left px-4 py-3 font-medium">Evento</th>
                    <th className="text-left px-4 py-3 font-medium">Asistente</th>
                    <th className="text-left px-4 py-3 font-medium">Cédula</th>
                    <th className="text-left px-4 py-3 font-medium hidden sm:table-cell">Fecha/hora</th>
                    <th className="text-left px-4 py-3 font-medium hidden md:table-cell">Modo</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(a => {
                    const incompleto = isIncompleto(a)
                    return (
                      <tr key={a.id} className="border-b border-[#1a1a1d] last:border-0 hover:bg-white/[0.02]">
                        <td className="px-4 py-3 text-zinc-400 text-xs max-w-[120px] truncate">
                          {eventoNames[a.eventoId] || a.eventoId || '—'}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div>
                              <p className={`font-medium leading-tight text-xs ${incompleto ? 'text-zinc-500' : 'text-white'}`}>
                                {a.apellidos || '—'} {a.nombres || '—'}
                              </p>
                            </div>
                            {incompleto && (
                              <span className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/20">
                                INCOMPLETO
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-blue-400 text-xs whitespace-nowrap">{a.cedula || '—'}</td>
                        <td className="px-4 py-3 hidden sm:table-cell text-zinc-500 text-xs whitespace-nowrap">
                          {format(toDate(a.fechaHora), "d MMM yyyy HH:mm", { locale: es })}
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell">
                          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                            a.modo === 'PDF417' ? 'bg-blue-500/20 text-blue-400'
                            : a.modo === 'MRZ'   ? 'bg-purple-500/20 text-purple-400'
                            : 'bg-zinc-700 text-zinc-400'
                          }`}>{a.modo}</span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
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
  const [downloading, setDownloading] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [progress, setProgress] = useState<string[]>([])
  const [restoreResult, setRestoreResult] = useState<{ eventos: number; asistencias: number } | null>(null)
  const [restoreError, setRestoreError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const handleBackup = async () => {
    setDownloading(true)
    try {
      const data = await getFullBackup()
      exportarJson(data)
    } finally {
      setDownloading(false)
    }
  }

  const handleRestoreFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async ev => {
      setRestoreResult(null)
      setRestoreError('')
      setProgress([])
      try {
        const data = JSON.parse(ev.target?.result as string) as BackupData
        if (!data.eventos || !Array.isArray(data.eventos)) throw new Error('Formato de backup inválido')
        setRestoring(true)
        const result = await restaurarBackup(data, msg => setProgress(p => [...p, msg]))
        setRestoreResult(result)
      } catch (err: unknown) {
        setRestoreError((err as Error).message ?? 'Error al restaurar')
      } finally {
        setRestoring(false)
        if (fileRef.current) fileRef.current.value = ''
      }
    }
    reader.readAsText(file)
  }

  return (
    <div className="max-w-md space-y-4">
      {/* Download */}
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
          disabled={downloading}
          className="flex items-center gap-2 px-5 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white text-sm font-semibold transition active:scale-95"
        >
          {downloading ? <><Spinner size="sm" /> Generando backup…</> : <><Download size={16} /> Descargar Backup JSON</>}
        </button>
      </div>

      {/* Restore */}
      <div className="bg-[#111113] border border-[#27272a] rounded-2xl p-6 space-y-4">
        <div>
          <h3 className="font-semibold text-white mb-1">Restaurar desde backup</h3>
          <p className="text-zinc-400 text-sm">
            Importa un archivo JSON de backup para restaurar eventos y asistencias (usa merge, no sobreescribe datos existentes con otro ID).
          </p>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          onChange={handleRestoreFile}
          className="hidden"
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={restoring}
          className="flex items-center gap-2 px-5 py-3 rounded-xl bg-zinc-700 hover:bg-zinc-600 disabled:opacity-60 text-white text-sm font-semibold transition active:scale-95"
        >
          {restoring ? <><Spinner size="sm" /> Restaurando…</> : <><Upload size={16} /> Seleccionar archivo JSON</>}
        </button>

        {progress.length > 0 && (
          <div className="bg-[#0a0a0a] border border-[#27272a] rounded-xl p-3 max-h-36 overflow-y-auto space-y-0.5">
            {progress.map((msg, i) => (
              <p key={i} className="text-xs text-zinc-400 font-mono">{msg}</p>
            ))}
          </div>
        )}

        {restoreResult && (
          <div className="flex items-start gap-2 bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-4 py-3 text-sm text-emerald-400">
            <CheckCircle size={15} className="mt-0.5 shrink-0" />
            <span>Restauración completa: <strong>{restoreResult.eventos}</strong> evento{restoreResult.eventos !== 1 ? 's' : ''} y <strong>{restoreResult.asistencias}</strong> asistencia{restoreResult.asistencias !== 1 ? 's' : ''} importadas.</span>
          </div>
        )}

        {restoreError && (
          <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-sm text-red-400">
            <AlertCircle size={14} /> {restoreError}
          </div>
        )}
      </div>

      <p className="text-zinc-600 text-xs">
        Solo los administradores pueden gestionar backups. Los archivos incluyen datos personales —
        manéjalos con cuidado.
      </p>
    </div>
  )
}
