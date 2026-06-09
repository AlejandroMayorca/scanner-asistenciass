'use client'

import { LogOut, ScanLine } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { useRouter } from 'next/navigation'

export function DashboardHeader({ title }: { title?: string }) {
  const { profile, signOut } = useAuth()
  const router = useRouter()

  return (
    <header className="lg:hidden sticky top-0 z-30 bg-[#09090b]/90 backdrop-blur border-b border-[#2a2a2e] flex items-center justify-between px-4 py-3">
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center">
          <ScanLine size={14} className="text-white" />
        </div>
        <span className="font-bold text-sm text-white">{title ?? 'CedulaScan'}</span>
      </div>
      <button
        onClick={async () => { await signOut(); router.push('/login') }}
        className="p-2 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-red-400/10 transition"
      >
        <LogOut size={18} />
      </button>
    </header>
  )
}
