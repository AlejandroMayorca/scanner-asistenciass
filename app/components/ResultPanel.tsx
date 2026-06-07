'use client'

import type { CedulaData } from '../lib/types'

interface Props {
  data: CedulaData
  onScanAgain: () => void
}

export default function ResultPanel({ data, onScanAgain }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 px-4 pb-6">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center gap-2">
          <span className="text-2xl">{data.tipo === 'nueva' ? '🪪' : '📋'}</span>
          <div>
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">
              Cédula {data.tipo === 'nueva' ? 'Nueva (MRZ)' : 'Antigua (PDF417)'}
            </p>
            <p className="text-base font-bold text-slate-800">Datos extraídos</p>
          </div>
        </div>

        <div className="space-y-3">
          <Field label="Apellidos" value={data.apellidos} />
          <Field label="Nombres" value={data.nombres} />
          <Field label="Número de cédula" value={data.numeroCedula} highlight />
        </div>

        <button
          onClick={onScanAgain}
          className="mt-6 w-full rounded-xl bg-blue-600 py-3 text-white font-semibold text-sm hover:bg-blue-700 active:scale-95 transition"
        >
          Escanear otra cédula
        </button>
      </div>
    </div>
  )
}

function Field({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-lg bg-slate-50 px-4 py-3">
      <p className="text-xs text-slate-400 mb-0.5">{label}</p>
      <p className={`font-semibold ${highlight ? 'text-blue-700 text-lg' : 'text-slate-800 text-sm'}`}>
        {value || <span className="text-slate-300 italic">—</span>}
      </p>
    </div>
  )
}
