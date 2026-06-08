'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Calendar, Shield } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'

export function BottomNav() {
  const pathname = usePathname()
  const { profile } = useAuth()

  const items = [
    { href: '/dashboard/eventos', label: 'Eventos', icon: Calendar },
    ...(profile?.rol === 'admin'
      ? [{ href: '/dashboard/admin', label: 'Admin', icon: Shield }]
      : []),
  ]

  return (
    <nav className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-[#111113] border-t border-[#27272a] flex">
      {items.map(({ href, label, icon: Icon }) => {
        const active = pathname.startsWith(href)
        return (
          <Link
            key={href}
            href={href}
            className={`flex-1 flex flex-col items-center gap-1 py-3 text-xs font-medium transition ${
              active ? 'text-blue-400' : 'text-zinc-500'
            }`}
          >
            <Icon size={20} />
            {label}
          </Link>
        )
      })}
    </nav>
  )
}
