'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ScanLine, Shield, User, Eye, EyeOff, AlertCircle } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { Spinner } from '../components/ui/Spinner'

type Rol = 'admin' | 'ayudante'

export default function LoginPage() {
  const { signIn, user, loading } = useAuth()
  const router = useRouter()
  const [rol, setRol] = useState<Rol>('admin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!loading && user) router.replace('/dashboard/eventos')
  }, [loading, user, router])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email || !password) { setError('Completa todos los campos'); return }
    setBusy(true); setError('')
    try {
      const profile = await signIn(email.trim(), password)
      if (profile.rol !== rol) {
        setError(`Tu cuenta es de tipo "${profile.rol}". Selecciona el rol correcto e intenta de nuevo.`)
        setBusy(false); return
      }
      router.replace('/dashboard/eventos')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al iniciar sesión'
      setError(msg.includes('invalid-credential') || msg.includes('wrong-password') || msg.includes('user-not-found')
        ? 'Email o contraseña incorrectos'
        : msg)
    } finally { setBusy(false) }
  }

  if (loading) return (
    <div className="flex h-dvh items-center justify-center bg-[#09090b]">
      <Spinner size="lg" />
    </div>
  )

  return (
    <div className="min-h-dvh bg-[#09090b] flex flex-col items-center justify-center p-4">
      {/* Background glow */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -left-40 w-96 h-96 bg-blue-600/10 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -right-40 w-96 h-96 bg-purple-600/10 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-sm animate-fadeIn">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-600 mb-4 shadow-lg shadow-blue-600/30">
            <ScanLine size={28} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">CedulaScan</h1>
          <p className="text-zinc-500 text-sm mt-1">Control de acceso a eventos</p>
        </div>

        {/* Card */}
        <div className="bg-[#111113] border border-[#27272a] rounded-2xl p-6 shadow-2xl">
          <h2 className="text-base font-semibold text-white mb-5">Iniciar sesión</h2>

          {/* Role selector */}
          <div className="grid grid-cols-2 gap-2 mb-5">
            {(['admin', 'ayudante'] as Rol[]).map(r => (
              <button
                key={r}
                type="button"
                onClick={() => setRol(r)}
                className={`flex items-center gap-2 px-3 py-3 rounded-xl border text-sm font-medium transition-all
                  ${rol === r
                    ? 'border-blue-500 bg-blue-500/15 text-blue-400'
                    : 'border-[#27272a] bg-[#18181b] text-zinc-400 hover:border-zinc-600'}`}
              >
                {r === 'admin' ? <Shield size={16} /> : <User size={16} />}
                <span className="capitalize">{r}</span>
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Email */}
            <div>
              <label className="block text-xs text-zinc-400 mb-1.5 font-medium">Correo electrónico</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="correo@ejemplo.com"
                autoComplete="email"
                className="w-full bg-[#18181b] border border-[#27272a] rounded-xl px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition"
              />
            </div>

            {/* Password */}
            <div>
              <label className="block text-xs text-zinc-400 mb-1.5 font-medium">Contraseña</label>
              <div className="relative">
                <input
                  type={showPass ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  className="w-full bg-[#18181b] border border-[#27272a] rounded-xl px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPass(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                >
                  {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {/* Error */}
            {error && (
              <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-3 text-red-400 text-sm">
                <AlertCircle size={16} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm transition disabled:opacity-60 flex items-center justify-center gap-2 mt-2"
            >
              {busy ? <><Spinner size="sm" /> Verificando…</> : 'Ingresar'}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-zinc-600 mt-6">
          CedulaScan · Sistema de registro de asistentes
        </p>
      </div>
    </div>
  )
}
