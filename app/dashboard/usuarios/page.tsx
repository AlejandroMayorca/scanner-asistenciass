'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { UserPlus, Shield, User, Check, X } from 'lucide-react'
import { createUserWithEmailAndPassword } from 'firebase/auth'
import { initializeApp, getApps } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getUsuarios, updateUsuario, setUsuarioPerfil } from '../../lib/firestore'
import { firebaseConfig } from '../../lib/firebase'
import { useAuth } from '../../context/AuthContext'
import { Modal } from '../../components/ui/Modal'
import { Badge } from '../../components/ui/Badge'
import { Spinner } from '../../components/ui/Spinner'
import { DashboardHeader } from '../../components/layout/DashboardHeader'
import type { UserProfile } from '../../lib/types'

// Secondary app instance for creating users without affecting current session
function getSecondaryAuth() {
  const sec = getApps().find(a => a.name === 'secondary') ?? initializeApp(firebaseConfig, 'secondary')
  return getAuth(sec)
}

export default function UsuariosPage() {
  const { profile } = useAuth()
  const router = useRouter()
  const [usuarios, setUsuarios] = useState<UserProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState({ email: '', nombre: '', password: '', rol: 'ayudante' as 'admin' | 'ayudante' })
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  useEffect(() => {
    if (!loading && profile?.rol !== 'admin') router.replace('/dashboard/eventos')
  }, [loading, profile, router])

  const load = async () => {
    setLoading(true)
    setUsuarios(await getUsuarios())
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.email || !form.nombre || !form.password) { setFormError('Completa todos los campos'); return }
    if (form.password.length < 6) { setFormError('La contraseña debe tener al menos 6 caracteres'); return }
    setSaving(true); setFormError('')
    try {
      const secAuth = getSecondaryAuth()
      const cred = await createUserWithEmailAndPassword(secAuth, form.email.trim(), form.password)
      await setUsuarioPerfil(cred.user.uid, { email: form.email.trim(), nombre: form.nombre.trim(), rol: form.rol, activo: true })
      await secAuth.signOut()
      setShowModal(false)
      setForm({ email: '', nombre: '', password: '', rol: 'ayudante' })
      load()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : ''
      setFormError(msg.includes('email-already-in-use') ? 'Ese correo ya está registrado' : 'Error al crear usuario')
    } finally { setSaving(false) }
  }

  const toggleActivo = async (u: UserProfile) => {
    await updateUsuario(u.id, { activo: !u.activo })
    load()
  }

  const changeRol = async (u: UserProfile, rol: 'admin' | 'ayudante') => {
    await updateUsuario(u.id, { rol })
    load()
  }

  if (loading) return <div className="flex h-dvh items-center justify-center"><Spinner size="lg" /></div>
  if (profile?.rol !== 'admin') return null

  return (
    <>
      <DashboardHeader title="Usuarios" />
      <div className="px-4 lg:px-8 py-6 max-w-4xl w-full mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-white">Gestión de usuarios</h1>
            <p className="text-zinc-500 text-sm mt-0.5">{usuarios.length} usuario{usuarios.length !== 1 ? 's' : ''} en el sistema</p>
          </div>
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2.5 rounded-xl transition"
          >
            <UserPlus size={16} /> Nuevo usuario
          </button>
        </div>

        <div className="bg-[#111113] border border-[#27272a] rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#27272a] text-zinc-500 text-xs">
                <th className="text-left px-5 py-3 font-medium">Usuario</th>
                <th className="text-left px-5 py-3 font-medium hidden sm:table-cell">Correo</th>
                <th className="text-left px-5 py-3 font-medium">Rol</th>
                <th className="text-left px-5 py-3 font-medium">Estado</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {usuarios.map(u => (
                <tr key={u.id} className="border-b border-[#1a1a1d] hover:bg-white/[0.02] transition">
                  <td className="px-5 py-4">
                    <p className="text-white font-medium">{u.nombre}</p>
                    <p className="text-zinc-500 text-xs sm:hidden">{u.email}</p>
                  </td>
                  <td className="px-5 py-4 hidden sm:table-cell text-zinc-400">{u.email}</td>
                  <td className="px-5 py-4">
                    {u.id === profile.id ? (
                      <Badge variant={u.rol} label={u.rol} />
                    ) : (
                      <select
                        value={u.rol}
                        onChange={e => changeRol(u, e.target.value as 'admin' | 'ayudante')}
                        className="bg-transparent text-xs border border-[#27272a] rounded-lg px-2 py-1 text-zinc-400 focus:outline-none [color-scheme:dark]"
                      >
                        <option value="admin">admin</option>
                        <option value="ayudante">ayudante</option>
                      </select>
                    )}
                  </td>
                  <td className="px-5 py-4">
                    <Badge variant={u.activo ? 'activo' : 'inactivo'} label={u.activo ? 'Activo' : 'Inactivo'} />
                  </td>
                  <td className="px-5 py-4 text-right">
                    {u.id !== profile.id && (
                      <button
                        onClick={() => toggleActivo(u)}
                        className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition
                          ${u.activo ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20' : 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'}`}
                      >
                        {u.activo ? <><X size={12} /> Desactivar</> : <><Check size={12} /> Activar</>}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {usuarios.length === 0 && (
                <tr><td colSpan={5} className="text-center py-12 text-zinc-600">No hay usuarios registrados</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={showModal} onClose={() => setShowModal(false)} title="Crear nuevo usuario">
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Nombre completo *</label>
            <input required value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} placeholder="Juan Pérez" className="w-full bg-[#111113] border border-[#27272a] rounded-xl px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition" />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Correo electrónico *</label>
            <input required type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="correo@ejemplo.com" className="w-full bg-[#111113] border border-[#27272a] rounded-xl px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition" />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Contraseña *</label>
            <input required type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder="Mínimo 6 caracteres" className="w-full bg-[#111113] border border-[#27272a] rounded-xl px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition" />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Rol</label>
            <div className="grid grid-cols-2 gap-2">
              {(['admin', 'ayudante'] as const).map(r => (
                <button key={r} type="button" onClick={() => setForm(f => ({ ...f, rol: r }))}
                  className={`flex items-center gap-2 px-3 py-3 rounded-xl border text-sm font-medium transition
                    ${form.rol === r ? 'border-blue-500 bg-blue-500/15 text-blue-400' : 'border-[#27272a] bg-[#111113] text-zinc-400 hover:border-zinc-600'}`}
                >
                  {r === 'admin' ? <Shield size={15} /> : <User size={15} />}
                  <span className="capitalize">{r}</span>
                </button>
              ))}
            </div>
          </div>
          {formError && <p className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{formError}</p>}
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={() => setShowModal(false)} className="flex-1 py-2.5 rounded-xl border border-[#27272a] text-zinc-400 text-sm hover:bg-white/5 transition">Cancelar</button>
            <button type="submit" disabled={saving} className="flex-1 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-500 transition disabled:opacity-60 flex items-center justify-center gap-2">
              {saving ? <><Spinner size="sm" /> Creando…</> : 'Crear usuario'}
            </button>
          </div>
        </form>
      </Modal>
    </>
  )
}
