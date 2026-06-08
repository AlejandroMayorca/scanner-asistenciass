#!/usr/bin/env python3
"""
Parser para PDF417 de cédula colombiana.
Puerto exacto de ColombianIdCardPdf417Decoder.decode() de:
  https://github.com/Eitol/colombian_cedula_reader (src/barcode/colombian_pdf417_decoder.py)

Sin dependencias externas — solo stdlib.
Entrada : bytes raw del PDF417 como string hexadecimal en stdin
Salida  : JSON en stdout
"""
import sys
import re
import json

CODING = 'latin-1'


def strip_null(s: str) -> str:
    return s.split('\x00')[0]


def decode_pdf417(data: bytes) -> dict:
    # Validación: el marcador PubDSK_ debe estar presente
    if b'PubDSK_' not in data:
        return {'error': 'PubDSK_ no encontrado — no es cédula colombiana PDF417'}

    # Normalizar: múltiples nulos consecutivos → un solo nulo (igual que el script Python original)
    data = re.sub(b'\x00{2,}', b'\x00', data)
    sp = data.split(b'\x00')

    try:
        # sp[2] = fingercard[:8] + reservado[8:10] + docnum[10:18] + apellido1[18:]
        # Caso especial cuando sp[2] es muy corto (lectura truncada, Windows)
        if len(sp) > 2 and len(sp[2]) > 8:
            finger_card = sp[2].decode(CODING)[:8]
            doc_number  = sp[2].decode(CODING)[10:18]
            last_name   = sp[2].decode(CODING)[18:]
        else:
            sp = sp[1:]   # desplazar igual que el original
            finger_card = ''
            doc_number  = sp[2].decode(CODING)[:10]
            last_name   = sp[2].decode(CODING)[10:]

        second_last_name = sp[3].decode(CODING) if len(sp) > 3 else ''
        first_name       = sp[4].decode(CODING) if len(sp) > 4 else ''
        middle_name      = sp[5].decode(CODING) if len(sp) > 5 else ''

        # Si el segundo nombre termina en '+' o '-', es un artefacto del tipo de sangre
        # → vaciarlo e insertar dummy (igual que el original)
        if middle_name.endswith('-') or middle_name.endswith('+'):
            middle_name = ''
            sp.insert(5, b'x')

        ds = sp[6].decode(CODING) if len(sp) > 6 else ''

        gender     = ds[1]     if len(ds) > 1  else ''
        year       = ds[2:6]   if len(ds) >= 6  else ''
        month      = ds[6:8]   if len(ds) >= 8  else ''
        day        = ds[8:10]  if len(ds) >= 10 else ''
        blood_type = ds[16:18] if len(ds) >= 18 else ''

        def clean(s: str) -> str:
            return s.replace('\x00', '').strip()

        doc_number       = clean(doc_number).lstrip('0')
        last_name        = clean(last_name)
        second_last_name = clean(second_last_name)
        first_name       = clean(first_name)
        middle_name      = clean(middle_name)
        blood_type       = clean(blood_type)

        # Construir fecha YYYY-MM-DD
        fecha = ''
        if year and month and day:
            try:
                fecha = f'{int(year):04d}-{int(month):02d}-{int(day):02d}'
            except ValueError:
                fecha = f'{year}-{month.zfill(2)}-{day.zfill(2)}'

        return {
            'cedula':          doc_number,
            'apellido1':       last_name,
            'apellido2':       second_last_name,
            'nombre1':         first_name,
            'nombre2':         middle_name,
            'sexo':            gender,
            'fechaNacimiento': fecha,
            'rh':              blood_type,
        }

    except Exception as e:
        return {'error': f'Error al parsear segmentos: {str(e)}'}


if __name__ == '__main__':
    try:
        hex_input = sys.stdin.buffer.read().decode('ascii').strip()
        if not hex_input:
            print(json.dumps({'error': 'entrada vacía'}))
            sys.exit(1)
        raw = bytes.fromhex(hex_input)
        result = decode_pdf417(raw)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)
