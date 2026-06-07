'use client'

export function ScannerOverlay({ hint, scanning }: { hint: string; scanning: boolean }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
      {/* Darkened frame */}
      <div
        className="relative rounded-xl border-2 border-white/30"
        style={{ width: '88%', aspectRatio: '85.6/54', boxShadow: '0 0 0 9999px rgba(0,0,0,0.65)' }}
      >
        {/* Scan line */}
        {scanning && (
          <div className="absolute inset-x-0 scan-line" style={{ position: 'absolute', left: 0, right: 0 }}>
            <div className="h-0.5 bg-blue-400/80 blur-sm" />
          </div>
        )}
        {/* Corners */}
        {(['tl','tr','bl','br'] as const).map(c => {
          const t = c.startsWith('t'), l = c.endsWith('l')
          return (
            <div
              key={c}
              className="absolute w-8 h-8 border-blue-400"
              style={{
                top: t ? -1 : 'auto', bottom: t ? 'auto' : -1,
                left: l ? -1 : 'auto', right: l ? 'auto' : -1,
                borderTopWidth: t ? 3 : 0, borderBottomWidth: t ? 0 : 3,
                borderLeftWidth: l ? 3 : 0, borderRightWidth: l ? 0 : 3,
                borderRadius: `${t&&l?6:0}px ${t&&!l?6:0}px ${!t&&!l?6:0}px ${!t&&l?6:0}px`,
              }}
            />
          )
        })}
      </div>
      <p className="mt-5 text-white/80 text-sm text-center px-6 drop-shadow max-w-xs">{hint}</p>
    </div>
  )
}
