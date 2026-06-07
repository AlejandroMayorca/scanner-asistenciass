'use client'

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'

interface Props { gruposEdad: Record<string, number> }

const COLORS = ['#f59e0b', '#3b82f6', '#8b5cf6', '#06b6d4', '#10b981', '#71717a']
const GROUPS = ['14-17', '18-25', '26-35', '36-50', '51+', 'N/A']

export function AgeChart({ gruposEdad }: Props) {
  const data = GROUPS.map((g, i) => ({ grupo: g, count: gruposEdad[g] ?? 0, color: COLORS[i] }))

  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={data} barCategoryGap="35%">
        <XAxis dataKey="grupo" tick={{ fill: '#71717a', fontSize: 11 }} tickLine={false} axisLine={false} />
        <YAxis tick={{ fill: '#71717a', fontSize: 10 }} tickLine={false} axisLine={false} allowDecimals={false} width={28} />
        <Tooltip
          contentStyle={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 8, fontSize: 12 }}
          formatter={(v) => [`${v ?? 0} personas`]}
          cursor={{ fill: 'rgba(255,255,255,0.04)' }}
        />
        <Bar dataKey="count" radius={[4, 4, 0, 0]}>
          {data.map((d, i) => <Cell key={i} fill={d.color} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
