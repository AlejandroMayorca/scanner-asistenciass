import { redirect } from 'next/navigation'

// Redirects to the event detail page which has both the registros table and stats charts.
export default function EstadisticasRedirectPage({ params }: { params: { id: string } }) {
  redirect(`/dashboard/eventos/${params.id}`)
}
