import { redirect } from 'next/navigation'

export default async function PublicEventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  redirect(`/evento/${id}/scanner`)
}
