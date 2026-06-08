import { NextRequest, NextResponse } from 'next/server'
import { readBarcodes } from 'zxing-wasm/reader'

export const runtime = 'nodejs'
export const maxDuration = 30

// ─── Parsed result ────────────────────────────────────────────────────────────

export interface ParsedCedula {
  cedula:    string
  apellido1: string
  apellido2: string
  nombre1:   string
  nombre2:   string
  sexo:      string
  anioNac:   string
  mesNac:    string
  diaNac:    string
  rh:        string
}

// ─── Approach A: ColombianIdCardPdf417Decoder null-byte split ─────────────────
// Puerto exacto de colombian_pdf417_decoder.py  (Python latin-1 ≡ Node latin1)

function decodePdf417NullSplit(raw: Uint8Array): ParsedCedula | null {
  const buf = Buffer.from(raw)
  if (!buf.includes(Buffer.from('PubDSK_', 'ascii'))) return null

  const str        = buf.toString('latin1')
  const normalized = str.replace(/\x00{2,}/g, '\x00')
  let   sp         = normalized.split('\x00')
  if (sp.length < 3) return null

  let docNumber: string, lastName: string
  if (sp[2].length > 8) {
    docNumber = sp[2].substring(10, 18)
    lastName  = sp[2].substring(18)
  } else {
    sp        = sp.slice(1)
    docNumber = sp[2]?.substring(0, 10) ?? ''
    lastName  = sp[2]?.substring(10)    ?? ''
  }
  if (sp.length < 7) return null

  let middleName = sp[5] ?? ''
  if (middleName.endsWith('-') || middleName.endsWith('+')) {
    middleName = ''
    sp = [...sp.slice(0, 5), 'x', ...sp.slice(5)]
  }

  const ds    = sp[6] ?? ''
  const clean = (s: string) => s.replace(/\x00/g, '').trim()

  const cedula = clean(docNumber).replace(/^0+/, '')
  if (!/^\d{5,12}$/.test(cedula)) return null

  return {
    cedula,
    apellido1: clean(lastName),
    apellido2: clean(sp[3] ?? ''),
    nombre1:   clean(sp[4] ?? ''),
    nombre2:   clean(middleName),
    sexo:      clean(ds.length > 1  ? ds[1]              : ''),
    anioNac:   clean(ds.length >= 6  ? ds.substring(2, 6)  : ''),
    mesNac:    clean(ds.length >= 8  ? ds.substring(6, 8)  : ''),
    diaNac:    clean(ds.length >= 10 ? ds.substring(8, 10) : ''),
    rh:        clean(ds.length >= 18 ? ds.substring(16, 18): ''),
  }
}

// ─── Approach B: fixed byte positions ─────────────────────────────────────────
// Posiciones en bytes sobre la cadena latin-1 del PDF417 binario:
//   48–58  cédula        81–104 apellido2     151–152 sexo
//   58–80  apellido1    104–127 nombre1       152–156 año nac
//                       127–150 nombre2       156–158 mes  158–160 día
//                                             166–168 RH

function decodePdf417Fixed(raw: Uint8Array): ParsedCedula | null {
  if (raw.length < 170) return null
  const str   = Buffer.from(raw).toString('latin1')
  const clean = (s: string) => s.replace(/\x00/g, '').trim()

  const cedula = clean(str.substring(48, 58)).replace(/^0+/, '')
  if (!/^\d{5,12}$/.test(cedula)) return null

  const apellido1 = clean(str.substring(58,  80))
  const apellido2 = clean(str.substring(81,  104))
  const nombre1   = clean(str.substring(104, 127))
  const nombre2   = clean(str.substring(127, 150))
  if (!apellido1 && !nombre1) return null

  return {
    cedula,
    apellido1, apellido2,
    nombre1,   nombre2,
    sexo:    clean(str.substring(151, 152)),
    anioNac: clean(str.substring(152, 156)),
    mesNac:  clean(str.substring(156, 158)),
    diaNac:  clean(str.substring(158, 160)),
    rh:      clean(str.substring(166, 168)),
  }
}

// ─── Combined parser: try both approaches ─────────────────────────────────────

function parsePdf417(raw: Uint8Array, logs: string[]): ParsedCedula | null {
  const a = decodePdf417NullSplit(raw)
  if (a) { logs.push(`[parse] null-split OK: ${a.cedula} ${a.apellido1}`); return a }

  const b = decodePdf417Fixed(raw)
  if (b) { logs.push(`[parse] fixed-pos OK: ${b.cedula} ${b.apellido1}`); return b }

  logs.push('[parse] ambos métodos fallaron')
  return null
}

// ─── ZXing decode ─────────────────────────────────────────────────────────────

async function decodeBuffer(
  buf: Buffer,
  label: string,
  logs: string[],
): Promise<{ text: string; parsed: ParsedCedula | null } | null> {
  const results = await readBarcodes(buf, {
    formats:   ['PDF417', 'QRCode', 'DataMatrix'],
    tryHarder: true,
  })
  const valid = results.filter(r => r.isValid)
  if (valid.length === 0) {
    logs.push(`[zxing] ${label}: sin detección`)
    return null
  }

  const r   = valid[0]
  const vis = (s: string) => s.replace(/\x00/g, '□')
  logs.push(`[zxing] ${label} OK: bytes=${r.bytes?.length ?? 0} text="${vis(r.text).slice(0, 60)}"`)

  // Use raw bytes (no charset conversion) — equivalent to Python latin-1
  const rawBytes: Uint8Array = (r.bytes?.length ? r.bytes : null)
    ?? new Uint8Array(Buffer.from(r.text, 'latin1'))

  const parsed = parsePdf417(rawBytes, logs)
  return { text: r.text, parsed }
}

// ─── POST /api/scan ───────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const logs: string[] = []

  try {
    const body = await req.json().catch(() => null)
    if (!body?.imageBase64) {
      return NextResponse.json({ success: false, error: 'imageBase64 requerido', logs })
    }

    const buffer = Buffer.from(body.imageBase64 as string, 'base64')
    logs.push(`[srv] buffer ${Math.round(buffer.length / 1024)}kb`)

    // Attempt 1 — imagen original
    {
      const r = await decodeBuffer(buffer, 'original', logs)
      if (r) return NextResponse.json({ success: true, ...r, logs })
    }

    // Attempts 2-4 — variantes con jimp
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const jimpModule: any = await import('jimp')
      const Jimp = jimpModule.default ?? jimpModule.Jimp
      const img  = await Jimp.read(buffer)
      const W    = img.bitmap.width  as number
      const H    = img.bitmap.height as number
      const sy   = Math.floor(H * 0.55)
      const sh   = Math.floor(H * 0.45)

      const variants: Array<[string, Promise<Buffer>]> = [
        ['contraste',     img.clone().contrast(0.7).brightness(0.1).getBufferAsync('image/jpeg')],
        ['inferior',      img.clone().crop(0, sy, W, sh).getBufferAsync('image/jpeg')],
        ['inf+contraste', img.clone().contrast(0.8).brightness(0.15).crop(0, sy, W, sh).getBufferAsync('image/jpeg')],
      ]

      for (const [label, bufPromise] of variants) {
        const r = await decodeBuffer(await bufPromise, label, logs)
        if (r) return NextResponse.json({ success: true, ...r, logs })
      }
    } catch (jimpErr) {
      logs.push(`[jimp] ${String(jimpErr).slice(0, 80)}`)
    }

    logs.push('[srv] todos los intentos fallaron')
    return NextResponse.json({ success: false, error: 'No se detectó código de barras', logs })

  } catch (error) {
    const msg = String(error)
    logs.push(`[srv] excepción: ${msg.slice(0, 150)}`)
    return NextResponse.json({ success: false, error: msg, logs })
  }
}
