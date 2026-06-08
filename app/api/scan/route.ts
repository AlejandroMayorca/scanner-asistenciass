import { NextRequest, NextResponse } from 'next/server'
import { readBarcodes } from 'zxing-wasm/reader'

export const runtime = 'nodejs'
export const maxDuration = 30

export async function POST(req: NextRequest) {
  const logs: string[] = []

  try {
    const body = await req.json().catch(() => null)
    if (!body?.imageBase64) {
      return NextResponse.json({ success: false, error: 'imageBase64 requerido', logs })
    }

    const buffer = Buffer.from(body.imageBase64 as string, 'base64')
    logs.push(`[srv] buffer ${Math.round(buffer.length / 1024)}kb`)

    // Attempt 1: buffer directo (JPEG/PNG bytes → zxing-wasm los decodifica)
    {
      const results = await readBarcodes(buffer, {
        formats: ['PDF417', 'QRCode', 'DataMatrix'],
        tryHarder: true,
      })
      const valid = results.filter(r => r.isValid)
      if (valid.length > 0) {
        const text = valid[0].text
        const vis = (s: string) => s.replace(/\x00/g, '□')
        logs.push(`[srv] OK buffer len=${text.length}`)
        logs.push(`[srv] txt: "${vis(text)}"`)
        logs.push(`[srv] p0-20:"${vis(text.substring(0,20))}"`)
        logs.push(`[srv] p48-58:"${vis(text.substring(48,58))}"`)
        logs.push(`[srv] p58-80:"${vis(text.substring(58,80))}"`)
        logs.push(`[srv] p104-127:"${vis(text.substring(104,127))}"`)
        logs.push(`[srv] p127-150:"${vis(text.substring(127,150))}"`)
        logs.push(`[srv] p151-160:"${vis(text.substring(151,160))}"`)
        logs.push(`[srv] p166-168:"${vis(text.substring(166,168))}"`)
        return NextResponse.json({ success: true, text, raw: text, logs })
      }
      logs.push(`[srv] buffer: sin detección (${results[0]?.error ?? 'sin error'})`)
    }

    // Attempt 2: preprocesar con jimp (alto contraste) → volver a JPEG → reintentar
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const jimpModule: any = await import('jimp')
      const Jimp = jimpModule.default ?? jimpModule.Jimp
      const img = await Jimp.read(buffer)

      // alta contraste
      const buf2: Buffer = await img.clone().contrast(0.7).brightness(0.1)
        .getBufferAsync('image/jpeg')
      const r2 = await readBarcodes(buf2, {
        formats: ['PDF417', 'QRCode', 'DataMatrix'],
        tryHarder: true,
      })
      const v2 = r2.filter(r => r.isValid)
      if (v2.length > 0) {
        const text = v2[0].text
        logs.push(`[srv] OK contraste: "${text}"`)
        return NextResponse.json({ success: true, text, raw: text, logs })
      }
      logs.push(`[srv] contraste: sin detección`)

      // recorte inferior 40%
      const H = img.bitmap.height as number
      const W = img.bitmap.width as number
      const sy = Math.floor(H * 0.60), sh = Math.floor(H * 0.40)
      const buf3: Buffer = await img.clone().crop(0, sy, W, sh)
        .getBufferAsync('image/jpeg')
      const r3 = await readBarcodes(buf3, {
        formats: ['PDF417', 'QRCode', 'DataMatrix'],
        tryHarder: true,
      })
      const v3 = r3.filter(r => r.isValid)
      if (v3.length > 0) {
        const text = v3[0].text
        logs.push(`[srv] OK inferior: "${text}"`)
        return NextResponse.json({ success: true, text, raw: text, logs })
      }
      logs.push(`[srv] inferior: sin detección`)

      // recorte inferior 40% + contraste
      const buf4: Buffer = await img.clone().contrast(0.8).brightness(0.15).crop(0, sy, W, sh)
        .getBufferAsync('image/jpeg')
      const r4 = await readBarcodes(buf4, {
        formats: ['PDF417', 'QRCode', 'DataMatrix'],
        tryHarder: true,
      })
      const v4 = r4.filter(r => r.isValid)
      if (v4.length > 0) {
        const text = v4[0].text
        logs.push(`[srv] OK inf+contraste: "${text}"`)
        return NextResponse.json({ success: true, text, raw: text, logs })
      }
      logs.push(`[srv] inf+contraste: sin detección`)
    } catch (jimpErr) {
      logs.push(`[srv] jimp no disponible: ${String(jimpErr).slice(0, 80)}`)
    }

    logs.push('[srv] todos los intentos fallaron')
    return NextResponse.json({ success: false, error: 'No se detectó código de barras', logs })

  } catch (error) {
    const msg = String(error)
    logs.push(`[srv] excepción: ${msg.slice(0, 150)}`)
    return NextResponse.json({ success: false, error: msg, logs })
  }
}
