'use client'

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { formatHora } from '../../lib/stats'

interface Props { hourly: number[]; horaPico: number }

export function HourlyChart({ hourly, horaPico }: Props) {
  const data = hourly.map((count, h) => ({ hora: `${String(h).padStart(2, '0')}h`, count, h }))
  const max = Math.max(...hourly, 1)

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} barCategoryGap="30%">
        <XAxis
          dataKey="hora"
          tick={{ fill: '#71717a', fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          interval={2}
        />
        <YAxis
          tick={{ fill: '#71717a', fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
          width={28}
        />
        <Tooltip
          contentStyle={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 8, fontSize: 12 }}
          labelStyle={{ color: '#a1a1aa' }}
          formatter={(v) => [`${v ?? 0} ingresos`, formatHora(hourly.indexOf(Number(v ?? 0)))]}

          cursor={{ fill: 'rgba(255,255,255,0.04)' }}
        />
        <Bar dataKey="count" radius={[4, 4, 0, 0]}>
          {data.map(d => (
            <Cell
              key={d.h}
              fill={d.h === horaPico && max > 0 ? '#3b82f6' : '#27272a'}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
