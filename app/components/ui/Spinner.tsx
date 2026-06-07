export function Spinner({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const s = { sm: 'w-4 h-4 border-2', md: 'w-7 h-7 border-2', lg: 'w-10 h-10 border-3' }[size]
  return (
    <div
      className={`${s} rounded-full border-white/20 border-t-white animate-spin`}
      style={{ animation: 'spin 0.8s linear infinite' }}
    />
  )
}
