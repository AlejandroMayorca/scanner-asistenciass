const variants = {
  admin:    'bg-blue-500/15 text-blue-400 border border-blue-500/30',
  ayudante: 'bg-purple-500/15 text-purple-400 border border-purple-500/30',
  activo:   'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30',
  inactivo: 'bg-red-500/15 text-red-400 border border-red-500/30',
  nueva:    'bg-sky-500/15 text-sky-400 border border-sky-500/30',
  vieja:    'bg-amber-500/15 text-amber-400 border border-amber-500/30',
}

export function Badge({ variant, label }: { variant: keyof typeof variants; label: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${variants[variant]}`}>
      {label}
    </span>
  )
}
