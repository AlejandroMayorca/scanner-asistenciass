import { NextRequest, NextResponse } from 'next/server'
import {
  BarcodeFormat,
  DecodeHintType,
  MultiFormatReader,
  RGBLuminanceSource,
  BinaryBitmap,
  HybridBinarizer,
} from '@zxing/library'

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface JimpBitmap {
  data: Buffer
  width: number
  height: number
}

function toLuminances(bitmap: JimpBitmap): Uint8ClampedArray {
  const { data, width: w, height: h } = bitmap
  const lum = new Uint8ClampedArray(w * h)
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2]
    lum[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
  }
  return lum
}

const HINTS = new Map<DecodeHintType, unknown>([
  [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.PDF_417, BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX]],
  [DecodeHintType.TRY_HARDER, true],
])

function tryDecode(lum: Uint8ClampedArray, w: number, h: number): string | null {
  try {
    const source = new RGBLuminanceSource(lum, w, h)
    const bitmap = new BinaryBitmap(new HybridBinarizer(source))
    const reader = new MultiFormatReader()
    reader.setHints(HINTS)
    return reader.decode(bitmap).getText()
  } catch {
    return null
  }
}

// ─── POST /api/scan ───────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const logs: string[] = []

  try {
    const body = await req.json().catch(() => null)
    if (!body?.imageBase64) {
      return NextResponse.json({ success: false, error: 'imageBase64 requerido' })
    }

    const buffer = Buffer.from(body.imageBase64 as string, 'base64')
    logs.push(`[srv] buffer ${Math.round(buffer.length / 1024)}kb`)

    // Dynamic import — Jimp is ESM in CI but CJS in local
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jimpModule: any = await import('jimp')
    const Jimp = jimpModule.default ?? jimpModule.Jimp
    const base = await Jimp.read(buffer)
    const W = base.bitmap.width as number
    const H = base.bitmap.height as number
    logs.push(`[srv] imagen ${W}×${H}`)

    // Attempt 1: original image
    {
      const lum = toLuminances(base.bitmap as JimpBitmap)
      const text = tryDecode(lum, W, H)
      if (text) {
        logs.push(`[srv] OK original: "${text.slice(0, 60)}"`)
        return NextResponse.json({ success: true, text, attempt: 'original', logs })
      }
      logs.push('[srv] original: sin detección')
    }

    // Attempt 2: high contrast + brightness
    {
      const img2 = base.clone().contrast(0.6).brightness(0.1)
      const lum  = toLuminances(img2.bitmap as JimpBitmap)
      const text = tryDecode(lum, W, H)
      if (text) {
        logs.push(`[srv] OK contraste: "${text.slice(0, 60)}"`)
        return NextResponse.json({ success: true, text, attempt: 'contraste', logs })
      }
      logs.push('[srv] contraste: sin detección')
    }

    // Attempt 3: bottom 40% crop (PDF417 zone of cédula vieja)
    {
      const sy   = Math.floor(H * 0.60)
      const sh   = Math.floor(H * 0.40)
      const img3 = base.clone().crop(0, sy, W, sh)
      const lum  = toLuminances(img3.bitmap as JimpBitmap)
      const text = tryDecode(lum, W, sh)
      if (text) {
        logs.push(`[srv] OK inferior: "${text.slice(0, 60)}"`)
        return NextResponse.json({ success: true, text, attempt: 'inferior', logs })
      }
      logs.push('[srv] inferior: sin detección')
    }

    // Attempt 4: bottom 40% + high contrast
    {
      const sy   = Math.floor(H * 0.60)
      const sh   = Math.floor(H * 0.40)
      const img4 = base.clone().contrast(0.8).brightness(0.15).crop(0, sy, W, sh)
      const lum  = toLuminances(img4.bitmap as JimpBitmap)
      const text = tryDecode(lum, W, sh)
      if (text) {
        logs.push(`[srv] OK inf+contraste: "${text.slice(0, 60)}"`)
        return NextResponse.json({ success: true, text, attempt: 'inf+contraste', logs })
      }
      logs.push('[srv] inf+contraste: sin detección')
    }

    // Attempt 5: inverted image (some PDF417s scan better inverted)
    {
      const img5 = base.clone().invert()
      const lum  = toLuminances(img5.bitmap as JimpBitmap)
      const text = tryDecode(lum, W, H)
      if (text) {
        logs.push(`[srv] OK invertido: "${text.slice(0, 60)}"`)
        return NextResponse.json({ success: true, text, attempt: 'invertido', logs })
      }
      logs.push('[srv] invertido: sin detección')
    }

    logs.push('[srv] todos los intentos fallaron')
    return NextResponse.json({ success: false, error: 'No se detectó código de barras', logs })

  } catch (error) {
    const msg = String(error)
    logs.push(`[srv] excepción: ${msg.slice(0, 100)}`)
    return NextResponse.json({ success: false, error: msg, logs })
  }
}
