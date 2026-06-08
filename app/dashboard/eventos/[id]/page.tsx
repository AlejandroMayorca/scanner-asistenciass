'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft, BarChart2, Camera, Check, ClipboardList, Copy, FileSpreadsheet,
  Link2, MapPin, Pencil, Trash2, Users,
} from 'lucide-react'
import { getEvento, getAsistencias, getTotalAsistencias, registrarAsistencia, checkDuplicado, eliminarAsistencia, generarTokenAcceso, toDate } from '../../../lib/firestore'
import { exportarExcel } from '../../../lib/export'
import { Spinner } from '../../../components/ui/Spinner'
import type { Evento, Asistencia } from '../../../lib/types'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'

// ── Helpers ───────────────────────────────────────────────────────────────────

function calcEdad(fechaNacimiento: string): number {
  const [y, m, d] = fechaNacimiento.split('-').map(Number)
  const hoy = new Date()
  let edad = hoy.getFullYear() - y
  if (hoy.getMonth() + 1 < m || (hoy.getMonth() + 1 === m && hoy.getDate() < d)) edad--
  return Math.max(0, edad)
}

const FIELD =
  'w-full bg-[#0a0a0a] border border-[#27272a] rounded-xl px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition'

const PAGE_SIZE = 25

// ── Stats helpers ─────────────────────────────────────────────────────────────

function calcStats(asistencias: Asistencia[]) {
  const total = asistencias.length
  const hombres = asistencias.filter(a => a.sexo === 'M').length
  const mujeres = asistencias.filter(a => a.sexo === 'F').length
  const conEdad = asistencias.filter(a => a.edad != null)
  const edadProm =
    conEdad.length > 0
      ? Math.round(conEdad.reduce((s, a) => s + (a.edad ?? 0), 0) / conEdad.length)
      : null

  const grupos: Record<string, number> = { '0-17': 0, '18-25': 0, '26-35': 0, '36-50': 0, '51+': 0, 'N/A': 0 }
  for (const a of asistencias) {
    const e = a.edad ?? null
    if (e === null) grupos['N/A']++
    else if (e <= 17) grupos['0-17']++
    else if (e <= 25) grupos['18-25']++
    else if (e <= 35) grupos['26-35']++
    else if (e <= 50) grupos['36-50']++
    else grupos['51+']++
  }

  const hourly = Array(24).fill(0) as number[]
  for (const a of asistencias) {
    hourly[toDate(a.fechaHora).getHours()]++
  }
  const horaPico = hourly.indexOf(Math.max(...hourly))

  return { total, hombres, mujeres, edadProm, grupos, hourly, horaPico }
}

// ── Tab: Registrar ─────────────────────────────────────────────────────────────

function RegistrarTab({ eventoId, evento, onRegistered }: { eventoId: string; evento: Evento | null; onRegistered: () => void }) {
  const [localToken, setLocalToken] = useState<string | undefined>()
  const [copied, setCopied] = useState(false)
  const [generatingToken, setGeneratingToken] = useState(false)
  const token = localToken ?? evento?.tokenAcceso ?? undefined

  const handleCopyLink = async () => {
    if (!token) return
    const link = `${window.location.origin}/evento/${token}/scanner`
    try { await navigator.clipboard.writeText(link) } catch { /* ignore */ }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleGenerarToken = async () => {
    setGeneratingToken(true)
    try { setLocalToken(await generarTokenAcceso(eventoId)) } finally { setGeneratingToken(false) }
  }

  const [form, setForm] = useState({
    cedula: '', nombres: '', apellidos: '', fechaNacimiento: '',
    sexo: '' as 'M' | 'F' | '', rh: '',
  })
  const [saving, setSaving] = useState(false)
  const [banner, setBanner] = useState<{ type: 'ok' | 'dup' | 'err'; msg: string } | null>(null)

  const showBanner = (type: 'ok' | 'dup' | 'err', msg: string) => {
    setBanner({ type, msg })
    setTimeout(() => setBanner(null), 4000)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.cedula || !form.nombres || !form.apellidos || !form.fechaNacimiento || !form.sexo) return
    setSaving(true)
    try {
      const dup = await checkDuplicado(eventoId, form.cedula.trim())
      if (dup) {
        showBanner('dup', `⚠️ ${form.apellidos} ${form.nombres} ya está registrado`)
        return
      }
      const edad = calcEdad(form.fechaNacimiento)
      await registrarAsistencia(eventoId, {
        cedula: form.cedula.trim(),
        nombres: form.nombres.trim(),
        apellidos: form.apellidos.trim(),
        fechaNacimiento: form.fechaNacimiento,
        edad,
        sexo: form.sexo as 'M' | 'F',
        rh: form.rh.trim() || undefined,
        modo: 'MANUAL',
      })
      showBanner('ok', `✅ ${form.apellidos} ${form.nombres} — ${edad} años`)
      setForm({ cedula: '', nombres: '', apellidos: '', fechaNacimiento: '', sexo: '', rh: '' })
      onRegistered()
    } catch (err: unknown) {
      showBanner('err', `Error: ${(err as { message?: string }).message ?? 'desconocido'}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-xl">
      {/* Operator link */}
      <div className="bg-[#111113] border border-[#27272a] rounded-2xl p-4 mb-4">
        <p className="text-xs text-zinc-400 mb-2.5 font-medium flex items-center gap-1.5">
          <Link2 size={12} /> Link de operador
        </p>
        {token ? (
          <div className="flex gap-2">
            <code className="flex-1 text-xs bg-[#0a0a0a] rounded-xl px-3 py-2.5 text-blue-400 truncate font-mono border border-[#27272a]">
              {`${typeof window !== 'undefined' ? window.location.origin : ''}/evento/${token}/scanner`}
            </code>
            <button
              onClick={handleCopyLink}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold shrink-0 transition active:scale-95 ${
                copied
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                  : 'bg-white/5 text-zinc-400 hover:text-white border border-[#27272a]'
              }`}
            >
              {copied ? <><Check size={13} /> Copiado</> : <><Copy size={13} /> Copiar</>}
            </button>
          </div>
        ) : (
          <button
            onClick={handleGenerarToken}
            disabled={generatingToken}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-[#27272a] text-zinc-400 hover:text-white text-xs font-semibold transition active:scale-95 disabled:opacity-60"
          >
            {generatingToken ? <><Spinner size="sm" /> Generando…</> : <><Link2 size={13} /> Generar link de operador</>}
          </button>
        )}
      </div>

      <Link
        href={`/dashboard/eventos/${eventoId}/scanner`}
        className="flex items-center justify-center gap-3 w-full py-4 rounded-2xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-base transition active:scale-95 mb-6 shadow-lg shadow-blue-600/25"
      >
        <Camera size={20} /> Abrir Escáner de Cédulas
      </Link>

      <div className="flex items-center gap-3 mb-6">
        <div className="flex-1 h-px bg-[#27272a]" />
        <span className="text-zinc-600 text-xs">o registrar manualmente</span>
        <div className="flex-1 h-px bg-[#27272a]" />
      </div>

      {banner && (
        <div
          className={`flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium mb-5 ${
            banner.type === 'ok'
              ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-400'
              : banner.type === 'dup'
              ? 'bg-amber-500/15 border border-amber-500/30 text-amber-400'
              : 'bg-red-500/15 border border-red-500/30 text-red-400'
          }`}
        >
          {banner.msg}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs text-zinc-400 mb-1.5">Número de cédula *</label>
          <input
            required
            value={form.cedula}
            onChange={e => setForm(f => ({ ...f, cedula: e.target.value }))}
            placeholder="1234567890"
            inputMode="numeric"
            className={FIELD}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Nombres *</label>
            <input
              required
              value={form.nombres}
              onChange={e => setForm(f => ({ ...f, nombres: e.target.value }))}
              placeholder="Juan Carlos"
              className={FIELD}
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Apellidos *</label>
            <input
              required
              value={form.apellidos}
              onChange={e => setForm(f => ({ ...f, apellidos: e.target.value }))}
              placeholder="García López"
              className={FIELD}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Fecha de nacimiento *</label>
            <input
              required
              type="date"
              value={form.fechaNacimiento}
              onChange={e => setForm(f => ({ ...f, fechaNacimiento: e.target.value }))}
              className={`${FIELD} [color-scheme:dark]`}
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Sexo *</label>
            <select
              required
              value={form.sexo}
              onChange={e => setForm(f => ({ ...f, sexo: e.target.value as 'M' | 'F' | '' }))}
              className={`${FIELD} [color-scheme:dark]`}
            >
              <option value="">Seleccionar</option>
              <option value="M">Masculino</option>
              <option value="F">Femenino</option>
            </select>
          </div>
        </div>

        {form.fechaNacimiento && (
          <p className="text-zinc-500 text-xs -mt-2">
            Edad calculada:{' '}
            <span className="text-white font-semibold">{calcEdad(form.fechaNacimiento)} años</span>
          </p>
        )}

        <div>
          <label className="block text-xs text-zinc-400 mb-1.5">
            RH <span className="text-zinc-600">(opcional)</span>
          </label>
          <input
            value={form.rh}
            onChange={e => setForm(f => ({ ...f, rh: e.target.value }))}
            placeholder="O+"
            className={FIELD}
          />
        </div>

        <button
          type="submit"
          disabled={saving}
          className="w-full py-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white font-semibold text-sm transition active:scale-95 flex items-center justify-center gap-2 mt-2"
        >
          {saving ? <><Spinner size="sm" /> Guardando…</> : <><Pencil size={16} /> Registrar manualmente</>}
        </button>
      </form>
    </div>
  )
}

// ── Tab: Asistentes ───────────────────────────────────────────────────────────

function AsistentesTab({ eventoId, evento }: { eventoId: string; evento: Evento | null }) {
  const [asistencias, setAsistencias] = useState<Asistencia[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [exporting, setExporting] = useState(false)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = () => getAsistencias(eventoId).then(a => { setAsistencias(a); setLoading(false) })

  useEffect(() => { load() }, [eventoId]) // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(
    () =>
      asistencias.filter(a => {
        const q = search.toLowerCase()
        return (
          a.cedula.includes(q) ||
          a.apellidos.toLowerCase().includes(q) ||
          a.nombres.toLowerCase().includes(q)
        )
      }),
    [asistencias, search],
  )

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const handleExport = async () => {
    if (!evento) return
    setExporting(true)
    try { await exportarExcel(asistencias, evento) } finally { setExporting(false) }
  }

  const handleDelete = async () => {
    if (!confirmDel) return
    setDeleting(true)
    try {
      await eliminarAsistencia(eventoId, confirmDel)
      setConfirmDel(null)
      load()
    } finally {
      setDeleting(false)
    }
  }

  if (loading) return <div className="flex justify-center py-16"><Spinner size="lg" /></div>

  return (
    <div>
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="relative flex-1">
          <ClipboardList size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
            placeholder="Buscar por cédula, nombre o apellido…"
            className="w-full bg-[#111113] border border-[#27272a] rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition"
          />
        </div>
        <button
          onClick={handleExport}
          disabled={exporting || asistencias.length === 0}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-semibold transition active:scale-95 shrink-0"
        >
          {exporting ? <Spinner size="sm" /> : <FileSpreadsheet size={16} />}
          Exportar Excel
        </button>
      </div>

      <p className="text-zinc-500 text-xs mb-3">
        {filtered.length} registro{filtered.length !== 1 ? 's' : ''}
        {search && ` para "${search}"`}
      </p>

      <div className="bg-[#111113] border border-[#27272a] rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#27272a] text-zinc-500 text-xs">
                <th className="text-left px-4 py-3 font-medium">#</th>
                <th className="text-left px-4 py-3 font-medium">Cédula</th>
                <th className="text-left px-4 py-3 font-medium">Apellidos y Nombres</th>
                <th className="text-left px-4 py-3 font-medium hidden sm:table-cell">Edad</th>
                <th className="text-left px-4 py-3 font-medium hidden sm:table-cell">Sexo</th>
                <th className="text-left px-4 py-3 font-medium hidden md:table-cell">RH</th>
                <th className="text-left px-4 py-3 font-medium hidden md:table-cell">Hora</th>
                <th className="text-left px-4 py-3 font-medium hidden lg:table-cell">Modo</th>
                <th className="text-left px-4 py-3 font-medium hidden xl:table-cell">Registrado por</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {paginated.length === 0 ? (
                <tr>
                  <td colSpan={10} className="text-center py-14 text-zinc-600">
                    {search ? 'Sin resultados' : 'Sin asistencias registradas'}
                  </td>
                </tr>
              ) : (
                paginated.map((a, i) => (
                  <tr key={a.id} className="border-b border-[#1a1a1d] last:border-0 hover:bg-white/[0.02] transition">
                    <td className="px-4 py-3 text-zinc-600 font-mono text-xs">{(page - 1) * PAGE_SIZE + i + 1}</td>
                    <td className="px-4 py-3 font-mono text-blue-400 text-xs whitespace-nowrap">{a.cedula}</td>
                    <td className="px-4 py-3">
                      <p className="text-white font-medium leading-tight">{a.apellidos}</p>
                      <p className="text-zinc-400 text-xs">{a.nombres}</p>
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell text-zinc-300 text-xs">
                      {a.edad != null ? `${a.edad} años` : '—'}
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell text-zinc-300 text-xs">
                      {a.sexo === 'M' ? '♂ M' : a.sexo === 'F' ? '♀ F' : '—'}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell text-zinc-500 text-xs">{a.rh || '—'}</td>
                    <td className="px-4 py-3 hidden md:table-cell text-zinc-500 text-xs whitespace-nowrap">
                      {format(toDate(a.fechaHora), 'HH:mm:ss')}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                        a.modo === 'PDF417' ? 'bg-blue-500/20 text-blue-400'
                        : a.modo === 'MRZ' ? 'bg-purple-500/20 text-purple-400'
                        : 'bg-zinc-700 text-zinc-400'
                      }`}>
                        {a.modo}
                      </span>
                    </td>
                    <td className="px-4 py-3 hidden xl:table-cell text-zinc-500 text-xs truncate max-w-[120px]">
                      {a.registradoPor || '—'}
                    </td>
                    <td className="px-2 py-3">
                      <button
                        onClick={() => setConfirmDel(a.id!)}
                        className="p-1.5 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-400/10 transition"
                        title="Eliminar registro"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-[#27272a] text-xs text-zinc-500">
            <span>Página {page} de {totalPages}</span>
            <div className="flex gap-2">
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-40 transition">
                ‹ Anterior
              </button>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-40 transition">
                Siguiente ›
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Confirm delete dialog */}
      {confirmDel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70" onClick={() => setConfirmDel(null)} />
          <div className="relative bg-[#18181b] border border-[#27272a] rounded-2xl p-6 max-w-xs w-full">
            <p className="font-semibold text-white mb-2">¿Eliminar este registro?</p>
            <p className="text-zinc-400 text-sm mb-5">Esta acción no se puede deshacer.</p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmDel(null)}
                className="flex-1 py-2.5 rounded-xl border border-[#27272a] text-zinc-400 text-sm hover:bg-white/5 transition">
                No
              </button>
              <button onClick={handleDelete} disabled={deleting}
                className="flex-1 py-2.5 rounded-xl bg-red-600 text-white text-sm font-semibold hover:bg-red-500 disabled:opacity-60 transition flex items-center justify-center gap-2">
                {deleting ? <><Spinner size="sm" /> Eliminando…</> : 'Sí, eliminar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tab: Estadísticas ─────────────────────────────────────────────────────────

const AGE_CFG = [
  { key: '0-17',  label: '0 – 17',  color: 'bg-amber-500' },
  { key: '18-25', label: '18 – 25', color: 'bg-blue-500' },
  { key: '26-35', label: '26 – 35', color: 'bg-violet-500' },
  { key: '36-50', label: '36 – 50', color: 'bg-cyan-500' },
  { key: '51+',   label: '51+',     color: 'bg-emerald-500' },
  { key: 'N/A',   label: 'Sin dato', color: 'bg-zinc-600' },
]

function EstadisticasTab({ eventoId }: { eventoId: string }) {
  const [asistencias, setAsistencias] = useState<Asistencia[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getAsistencias(eventoId).then(a => { setAsistencias(a); setLoading(false) })
  }, [eventoId])

  const stats = useMemo(() => calcStats(asistencias), [asistencias])

  if (loading) return <div className="flex justify-center py-16"><Spinner size="lg" /></div>

  const pctH = stats.total > 0 ? Math.round((stats.hombres / stats.total) * 100) : 0
  const pctM = stats.total > 0 ? Math.round((stats.mujeres / stats.total) * 100) : 0
  const conDato = stats.total - (stats.grupos['N/A'] ?? 0)
  const maxHourly = Math.max(...stats.hourly, 1)

  return (
    <div className="space-y-5">
      {/* Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'Total asistentes', value: stats.total, color: 'text-blue-400', bg: 'bg-blue-500/10' },
          { label: `Hombres (${pctH}%)`, value: stats.hombres, color: 'text-sky-400', bg: 'bg-sky-500/10' },
          { label: `Mujeres (${pctM}%)`, value: stats.mujeres, color: 'text-pink-400', bg: 'bg-pink-500/10' },
          { label: 'Edad promedio', value: stats.edadProm != null ? `${stats.edadProm} años` : '—', color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
        ].map(c => (
          <div key={c.label} className={`${c.bg} border border-white/5 rounded-2xl p-5`}>
            <p className={`text-3xl font-bold ${c.color}`}>{c.value}</p>
            <p className="text-zinc-400 text-xs mt-1">{c.label}</p>
          </div>
        ))}
      </div>

      {/* Gender bar */}
      {(stats.hombres > 0 || stats.mujeres > 0) && (
        <div className="bg-[#111113] border border-[#27272a] rounded-2xl p-5">
          <h3 className="text-sm font-semibold text-white mb-3">Distribución por género</h3>
          <div className="flex h-4 rounded-full overflow-hidden bg-[#27272a]">
            <div className="bg-sky-500 transition-all" style={{ width: `${pctH}%` }} />
            <div className="bg-pink-500 transition-all" style={{ width: `${pctM}%` }} />
          </div>
          <div className="flex gap-4 mt-2 text-xs text-zinc-400">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-sky-500 inline-block" /> Masculino {pctH}% ({stats.hombres})</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-pink-500 inline-block" /> Femenino {pctM}% ({stats.mujeres})</span>
          </div>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-5">
        {/* Age */}
        <div className="bg-[#111113] border border-[#27272a] rounded-2xl p-5">
          <h3 className="text-sm font-semibold text-white mb-4">Distribución de edades</h3>
          <div className="space-y-3">
            {AGE_CFG.map(({ key, label, color }) => {
              const count = stats.grupos[key] ?? 0
              const pct = conDato > 0 && key !== 'N/A' ? Math.round((count / conDato) * 100) : 0
              return (
                <div key={key} className="flex items-center gap-3">
                  <span className="w-16 shrink-0 text-xs text-zinc-400">{label}</span>
                  <div className="flex-1 h-2.5 bg-[#27272a] rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${color} transition-all duration-500`}
                      style={{ width: key === 'N/A' ? '0%' : `${pct}%` }} />
                  </div>
                  <span className="w-6 text-right text-xs font-bold text-white">{count}</span>
                  <span className="w-8 text-right text-xs text-zinc-500">{key !== 'N/A' ? `${pct}%` : ''}</span>
                </div>
              )
            })}
          </div>
        </div>

        {/* Hourly */}
        <div className="bg-[#111113] border border-[#27272a] rounded-2xl p-5">
          <h3 className="text-sm font-semibold text-white mb-1">Ingresos por hora</h3>
          {stats.total > 0 && (
            <p className="text-xs text-zinc-500 mb-4">
              Hora pico:{' '}
              <span className="text-white font-semibold">
                {String(stats.horaPico).padStart(2, '0')}:00
              </span>{' '}
              ({stats.hourly[stats.horaPico]} ingresos)
            </p>
          )}
          <div className="flex items-end gap-0.5 h-28">
            {stats.hourly.map((count, h) => (
              <div key={h} className="flex-1 flex flex-col items-center">
                <div
                  className={`w-full rounded-sm transition-all duration-500 ${
                    h === stats.horaPico && count > 0 ? 'bg-blue-500' : 'bg-[#27272a]'
                  }`}
                  style={{ height: `${(count / maxHourly) * 100}%`, minHeight: count > 0 ? 2 : 0 }}
                />
              </div>
            ))}
          </div>
          <div className="flex justify-between text-[10px] text-zinc-600 mt-1.5">
            <span>00h</span><span>06h</span><span>12h</span><span>18h</span><span>23h</span>
          </div>
        </div>
      </div>

      {stats.total === 0 && (
        <div className="text-center py-12 text-zinc-600">
          <BarChart2 size={40} className="mx-auto mb-2 opacity-30" />
          <p>Sin datos aún. Registra asistentes para ver estadísticas.</p>
        </div>
      )}
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

type Tab = 'registrar' | 'asistentes' | 'estadisticas'

export default function EventoDetailPage() {
  const { id: eventoId } = useParams<{ id: string }>()
  const [evento, setEvento] = useState<Evento | null>(null)
  const [total, setTotal] = useState(0)
  const [tab, setTab] = useState<Tab>('registrar')

  useEffect(() => {
    if (!eventoId) return
    getEvento(eventoId).then(ev => setEvento(ev))
    getTotalAsistencias(eventoId).then(setTotal)
  }, [eventoId])

  const refreshTotal = () => getTotalAsistencias(eventoId).then(setTotal)

  const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'registrar',    label: 'Registrar',    icon: <Camera size={15} /> },
    { id: 'asistentes',   label: 'Asistentes',   icon: <Users size={15} /> },
    { id: 'estadisticas', label: 'Estadísticas', icon: <BarChart2 size={15} /> },
  ]

  return (
    <div className="min-h-dvh flex flex-col">
      {/* Header */}
      <div className="px-4 lg:px-8 pt-6 pb-0 max-w-5xl w-full mx-auto">
        <div className="flex items-start gap-3 mb-4">
          <Link href="/dashboard/eventos"
            className="p-2 rounded-lg text-zinc-500 hover:text-white hover:bg-white/5 transition mt-0.5">
            <ArrowLeft size={18} />
          </Link>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold text-white leading-tight truncate">
              {evento?.nombre ?? '…'}
            </h1>
            <div className="flex items-center gap-3 mt-1 text-xs text-zinc-500 flex-wrap">
              {evento?.lugar && (
                <span className="flex items-center gap-1"><MapPin size={11} />{evento.lugar}</span>
              )}
              {evento?.fecha && (
                <span>📅 {format(toDate(evento.fecha), "d 'de' MMMM yyyy", { locale: es })}</span>
              )}
              <span className="flex items-center gap-1">
                <Users size={11} />
                <strong className="text-white">{total}</strong> asistentes
              </span>
            </div>
          </div>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-[#27272a]">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition whitespace-nowrap ${
                tab === t.id
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-zinc-500 hover:text-zinc-300'
              }`}>
              {t.icon} {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="px-4 lg:px-8 py-6 max-w-5xl w-full mx-auto flex-1">
        {tab === 'registrar'    && <RegistrarTab eventoId={eventoId} evento={evento} onRegistered={refreshTotal} />}
        {tab === 'asistentes'   && <AsistentesTab eventoId={eventoId} evento={evento} />}
        {tab === 'estadisticas' && <EstadisticasTab eventoId={eventoId} />}
      </div>
    </div>
  )
}
