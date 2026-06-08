import { NextRequest, NextResponse } from 'next/server'
import { readBarcodes } from 'zxing-wasm/reader'

export const runtime = 'nodejs'
export const maxDuration = 30

// ─── TypeScript port of ColombianIdCardPdf417Decoder.decode() ─────────────────
//
// Fuente original: colombian-cedula-reader/src/barcode/colombian_pdf417_decoder.py
// Traducción exacta — misma lógica, mismo orden de pasos, mismos edge cases.
//
// Clave de encoding: Python usa latin-1 (byte N → codepoint N).
// En Node.js, Buffer.toString('latin1') hace lo mismo: cada byte → mismo char.
// Por eso usamos result.bytes (Uint8Array sin conversión de charset) y no result.text.

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

function decodePdf417Bytes(raw: Uint8Array): ParsedCedula | null {
  // Paso 1 — validar marcador PubDSK_ (exactamente como en el original Python)
  const buf = Buffer.from(raw)
  if (!buf.includes(Buffer.from('PubDSK_', 'ascii'))) return null

  // Paso 2 — decodificar como latin-1: byte N → char con codepoint N
  // Equivale a: self.data.decode('latin-1') en Python
  const str = buf.toString('latin1')

  // Paso 3 — normalizar: múltiples nulos consecutivos → un solo nulo
  // Equivale a: re.sub(b'(\x00){2,}', b'\x00', data) en Python
  const normalized = str.replace(/\x00{2,}/g, '\x00')

  // Paso 4 — dividir por nulo
  // Equivale a: sp = data.split(b'\x00') en Python
  let sp = normalized.split('\x00')

  if (sp.length < 3) return null

  // Paso 5 — extraer fingercard, docnum y apellido1 de sp[2]
  // Python: if len(sp[2]) > 8: ... else: sp = sp[1:]
  let docNumber: string
  let lastName:  string

  if (sp[2].length > 8) {
    // sp[2][0:8]  = fingercard
    // sp[2][8:10] = reservado
    // sp[2][10:18] = docnum
    // sp[2][18:]   = apellido1
    docNumber = sp[2].substring(10, 18)
    lastName  = sp[2].substring(18)
  } else {
    // Caso truncado (Windows): desplazar igual que el original
    sp = sp.slice(1)
    docNumber = sp[2].substring(0, 10)
    lastName  = sp[2].substring(10)
  }

  if (sp.length < 7) return null

  // Paso 6 — apellido2, nombre1, nombre2
  const secLastName = sp[3] ?? ''
  const firstName   = sp[4] ?? ''
  let   middleName  = sp[5] ?? ''

  // Paso 7 — artefacto: si nombre2 termina en '+' o '-' es separador del RH
  // Python: if middle_name.endswith("-") or middle_name.endswith("+"): middle_name=''; sp.insert(5, b'x')
  if (middleName.endsWith('-') || middleName.endsWith('+')) {
    middleName = ''
    sp = [...sp.slice(0, 5), 'x', ...sp.slice(5)]
  }

  // Paso 8 — segmento de fechas/sexo/rh (sp[6])
  const ds = sp[6] ?? ''

  // Python: gender=ds[1], year=ds[2:6], month=ds[6:8], day=ds[8:10], blood=ds[16:18]
  const gender    = ds.length > 1  ? ds[1]              : ''
  const year      = ds.length >= 6  ? ds.substring(2, 6)  : ''
  const month     = ds.length >= 8  ? ds.substring(6, 8)  : ''
  const day       = ds.length >= 10 ? ds.substring(8, 10) : ''
  const bloodType = ds.length >= 18 ? ds.substring(16, 18): ''

  // Paso 9 — limpiar: quitar nulos y espacios; quitar ceros a la izquierda del doc
  const clean = (s: string) => s.replace(/\x00/g, '').trim()

  return {
    cedula:    clean(docNumber).replace(/^0+/, ''),
    apellido1: clean(lastName),
    apellido2: clean(secLastName),
    nombre1:   clean(firstName),
    nombre2:   clean(middleName),
    sexo:      clean(gender),
    anioNac:   clean(year),
    mesNac:    clean(month),
    diaNac:    clean(day),
    rh:        clean(bloodType),
  }
}

// ─── ZXing decode + parse ─────────────────────────────────────────────────────

async function decodeBuffer(
  buf: Buffer,
  label: string,
  logs: string[],
): Promise<{ text: string; parsed: ParsedCedula | null } | null> {
  const results = await readBarcodes(buf, {
    formats: ['PDF417', 'QRCode', 'DataMatrix'],
    tryHarder: true,
  })
  const valid = results.filter(r => r.isValid)
  if (valid.length === 0) {
    logs.push(`[srv] ${label}: sin detección`)
    return null
  }

  const r   = valid[0]
  const vis = (s: string) => s.replace(/\x00/g, '□')
  logs.push(`[srv] ${label} OK: bytes=${r.bytes?.length ?? 0} text="${vis(r.text)}"`)

  // Usar result.bytes (Uint8Array, sin conversión de charset) como fuente primaria.
  // Fallback a Buffer.from(text, 'latin1') si bytes no está disponible.
  const rawBytes: Uint8Array = (r.bytes?.length ? r.bytes : null)
    ?? new Uint8Array(Buffer.from(r.text, 'latin1'))

  const parsed = decodePdf417Bytes(rawBytes)
  if (parsed) {
    logs.push(`[parse] OK: cedula=${parsed.cedula} ${parsed.apellido1} ${parsed.nombre1}`)
  } else {
    logs.push(`[parse] PubDSK_ no encontrado o segmentos insuficientes`)
  }

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

    // Attempt 1: imagen original sin modificar
    {
      const r = await decodeBuffer(buffer, 'original', logs)
      if (r) return NextResponse.json({ success: true, ...r, logs })
    }

    // Attempts 2-4: preprocesar con jimp
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const jimpModule: any = await import('jimp')
      const Jimp = jimpModule.default ?? jimpModule.Jimp
      const img  = await Jimp.read(buffer)
      const W    = img.bitmap.width  as number
      const H    = img.bitmap.height as number
      const sy   = Math.floor(H * 0.60)
      const sh   = Math.floor(H * 0.40)

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
