'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Calendar, BarChart2, Users } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'

const items = [
  { href: '/dashboard/eventos',      label: 'Eventos',      icon: Calendar  },
  { href: '/dashboard/estadisticas', label: 'Estadísticas', icon: BarChart2 },
  { href: '/dashboard/usuarios',     label: 'Usuarios',     icon: Users, adminOnly: true },
]

export function BottomNav() {
  const pathname = usePathname()
  const { profile } = useAuth()

  return (
    <nav className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-[#111113] border-t border-[#27272a] flex">
      {items.map(item => {
        if (item.adminOnly && profile?.rol !== 'admin') return null
        const active = pathname.startsWith(item.href)
        const Icon = item.icon
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex-1 flex flex-col items-center gap-1 py-3 text-xs font-medium transition
              ${active ? 'text-blue-400' : 'text-zinc-500'}`}
          >
            <Icon size={20} />
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
