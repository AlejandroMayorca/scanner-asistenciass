'use client'

interface Props {
  hint: string
}

export default function ScannerOverlay({ hint }: Props) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
      {/* Darkened frame using box-shadow trick */}
      <div
        className="relative rounded-lg border-2 border-white"
        style={{
          width: '88%',
          aspectRatio: '85.6 / 54',
          boxShadow: '0 0 0 9999px rgba(0,0,0,0.62)',
        }}
      >
        {/* Corner brackets */}
        <Corner pos="top-left" />
        <Corner pos="top-right" />
        <Corner pos="bottom-left" />
        <Corner pos="bottom-right" />
      </div>

      <p className="mt-6 text-white text-sm text-center px-4 drop-shadow">
        {hint}
      </p>
    </div>
  )
}

function Corner({ pos }: { pos: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' }) {
  const base = 'absolute w-7 h-7 border-green-400'
  const styles: Record<string, string> = {
    'top-left':     'top-0 left-0 border-t-4 border-l-4 rounded-tl-md',
    'top-right':    'top-0 right-0 border-t-4 border-r-4 rounded-tr-md',
    'bottom-left':  'bottom-0 left-0 border-b-4 border-l-4 rounded-bl-md',
    'bottom-right': 'bottom-0 right-0 border-b-4 border-r-4 rounded-br-md',
  }
  return <div className={`${base} ${styles[pos]}`} />
}
