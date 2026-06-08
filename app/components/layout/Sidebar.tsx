'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Calendar, LogOut, ScanLine, Shield } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'

export function Sidebar() {
  const pathname = usePathname()
  const { profile, signOut } = useAuth()
  const router = useRouter()

  const navItems = [
    { href: '/dashboard/eventos', label: 'Eventos', icon: Calendar },
    ...(profile?.rol === 'admin'
      ? [{ href: '/dashboard/admin', label: 'Admin', icon: Shield }]
      : []),
  ]

  const handleLogout = async () => {
    await signOut()
    router.push('/login')
  }

  return (
    <aside className="hidden lg:flex flex-col w-60 shrink-0 bg-[#111113] border-r border-[#27272a] h-screen sticky top-0">
      <div className="flex items-center gap-2.5 px-5 py-5 border-b border-[#27272a]">
        <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
          <ScanLine size={16} className="text-white" />
        </div>
        <span className="font-bold text-white tracking-tight">CedulaScan</span>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                active
                  ? 'bg-blue-600/20 text-blue-400'
                  : 'text-zinc-400 hover:text-white hover:bg-white/5'
              }`}
            >
              <Icon size={18} />
              {label}
            </Link>
          )
        })}
      </nav>

      <div className="px-3 py-4 border-t border-[#27272a] space-y-1">
        <div className="px-3 py-2.5 rounded-lg bg-white/5">
          <div className="flex items-center gap-2 mb-0.5">
            <Shield
              size={14}
              className={profile?.rol === 'admin' ? 'text-blue-400' : 'text-purple-400'}
            />
            <span className="text-xs font-semibold capitalize text-zinc-300">{profile?.rol}</span>
          </div>
          <p className="text-xs text-zinc-500 truncate">{profile?.email}</p>
        </div>
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-zinc-400 hover:text-red-400 hover:bg-red-400/10 transition"
        >
          <LogOut size={18} />
          Cerrar sesión
        </button>
      </div>
    </aside>
  )
}
