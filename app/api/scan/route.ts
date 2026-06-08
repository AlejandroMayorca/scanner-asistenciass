import { NextRequest, NextResponse } from 'next/server'
import { readBarcodes } from 'zxing-wasm/reader'
import { spawn } from 'child_process'
import { join } from 'path'

export const runtime = 'nodejs'
export const maxDuration = 30

// ─── Parsed result from Python ────────────────────────────────────────────────

export interface ParsedCedula {
  cedula: string
  apellido1: string
  apellido2: string
  nombre1: string
  nombre2: string
  sexo: string
  fechaNacimiento: string   // YYYY-MM-DD
  rh: string
}

// ─── Call scripts/cedula_parser.py ───────────────────────────────────────────
// Puerto exacto de ColombianIdCardPdf417Decoder.decode() sin dependencias externas.
// Recibe los bytes del PDF417 como hex en stdin, retorna JSON.

async function runPythonParser(rawBytes: Uint8Array, logs: string[]): Promise<ParsedCedula | null> {
  const scriptPath = join(process.cwd(), 'scripts', 'cedula_parser.py')
  const hexInput   = Buffer.from(rawBytes).toString('hex')
  logs.push(`[py] ${rawBytes.length}B → hex ${hexInput.length}chars`)

  const tryCmd = (cmd: string): Promise<ParsedCedula | null> =>
    new Promise((resolve) => {
      const proc = spawn(cmd, [scriptPath], { timeout: 8000 })
      let stdout = ''

      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
      proc.stderr.on('data', (d: Buffer) => {
        const line = d.toString().trim()
        if (line) logs.push(`[py stderr] ${line.slice(0, 100)}`)
      })
      proc.stdin.write(hexInput)
      proc.stdin.end()

      proc.on('close', (code) => {
        if (code === 0 && stdout.trim()) {
          try {
            const parsed = JSON.parse(stdout.trim()) as { error?: string } & Partial<ParsedCedula>
            if (parsed.error) {
              logs.push(`[py] ${parsed.error}`)
              resolve(null)
            } else {
              logs.push(`[py] OK cedula=${parsed.cedula} ${parsed.apellido1} ${parsed.nombre1}`)
              resolve(parsed as ParsedCedula)
            }
          } catch {
            logs.push('[py] JSON inválido')
            resolve(null)
          }
        } else {
          if (code !== null) logs.push(`[py] ${cmd} exit=${code}`)
          resolve(null)
        }
      })
      proc.on('error', (e) => {
        logs.push(`[py] no encontrado: ${e.message.slice(0, 60)}`)
        resolve(null)
      })
    })

  // Intenta python3 primero, luego python
  return (await tryCmd('python3')) ?? (await tryCmd('python'))
}

// ─── ZXing decode + Python parse ─────────────────────────────────────────────

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

  const r     = valid[0]
  const bytes = r.bytes?.length ? r.bytes : null
  const vis   = (s: string) => s.replace(/\x00/g, '□')
  logs.push(`[srv] ${label} OK: bytes=${bytes?.length ?? 0} text="${vis(r.text)}"`)

  // bytes es el payload binario raw (sin conversión de charset) — es lo que necesita el parser
  // text es el mismo payload decodificado como UTF-8 (puede tener caracteres corrompidos para latin-1)
  const rawBytes: Uint8Array = bytes ?? new Uint8Array(Buffer.from(r.text, 'binary'))
  const parsed = await runPythonParser(rawBytes, logs)

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

    // Attempts 2-4: preprocesar con jimp y reintentar
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const jimpModule: any = await import('jimp')
      const Jimp  = jimpModule.default ?? jimpModule.Jimp
      const img   = await Jimp.read(buffer)
      const W     = img.bitmap.width  as number
      const H     = img.bitmap.height as number
      const sy    = Math.floor(H * 0.60)
      const sh    = Math.floor(H * 0.40)

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
