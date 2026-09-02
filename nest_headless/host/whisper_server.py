#!/usr/bin/env python3
"""Tiny local transcription server for nest_headless (Whisper via Apple MLX).

Speaks the same shape as whisper.cpp's `whisper-server`: POST /inference with a
multipart "file" field holding a 16 kHz mono 16-bit WAV, replies {"text": ...}.
Audio is decoded in memory and never written to disk. Loopback only.

  WHISPER_MODEL   HF repo or local path (default mlx-community/whisper-large-v3-turbo)
  PORT            default 8178
"""
import cgi, io, json, os, struct, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import mlx_whisper

MODEL = os.environ.get('WHISPER_MODEL', 'mlx-community/whisper-large-v3-turbo')
PORT = int(os.environ.get('PORT', '8178'))
BIND = os.environ.get('BIND', '127.0.0.1')          # 0.0.0.0 to serve the LAN (HA Assist, phones)
TOKEN = os.environ.get('WHISPER_TOKEN', '').strip()  # when set, /inference from anywhere but loopback needs Authorization: Bearer <token>
if not TOKEN and os.environ.get('WHISPER_TOKEN_FILE'):
    try:
        TOKEN = open(os.environ['WHISPER_TOKEN_FILE']).read().strip()
    except OSError:
        TOKEN = ''


def wav_to_float32(data: bytes) -> np.ndarray:
    if len(data) < 44 or data[:4] != b'RIFF':
        raise ValueError('not a RIFF wav')
    # walk chunks to find fmt/data (the add-on writes a plain 44-byte header)
    pos, fmt, pcm = 12, None, None
    while pos + 8 <= len(data):
        cid, size = data[pos:pos + 4], struct.unpack('<I', data[pos + 4:pos + 8])[0]
        body = data[pos + 8:pos + 8 + size]
        if cid == b'fmt ':
            fmt = struct.unpack('<HHIIHH', body[:16])
        elif cid == b'data':
            pcm = body
        pos += 8 + size + (size & 1)
    if fmt is None or pcm is None:
        raise ValueError('wav missing fmt/data')
    channels, rate, bits = fmt[1], fmt[2], fmt[5]
    if bits != 16:
        raise ValueError(f'unsupported bits {bits}')
    x = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768.0
    if channels > 1:
        x = x.reshape(-1, channels).mean(axis=1)
    if rate != 16000:
        # linear resample; the add-on always sends 16 kHz so this is a fallback
        n = int(len(x) * 16000 / rate)
        x = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)
    return x


class H(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quiet; one line per request below
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ('/', '/health'):
            return self._json(200, {'ok': True, 'model': MODEL})
        self._json(404, {'error': 'not found'})

    def do_POST(self):
        if not self.path.startswith('/inference'):
            return self._json(404, {'error': 'not found'})
        if TOKEN and self.client_address[0] not in ('127.0.0.1', '::1'):
            auth = self.headers.get('Authorization', '')
            if auth != f'Bearer {TOKEN}':
                return self._json(401, {'error': 'unauthorized'})
        try:
            ctype, pdict = cgi.parse_header(self.headers.get('Content-Type', ''))
            if ctype != 'multipart/form-data':
                return self._json(400, {'error': 'multipart/form-data expected'})
            pdict['boundary'] = pdict['boundary'].encode()
            pdict['CONTENT-LENGTH'] = int(self.headers.get('Content-Length', '0'))
            form = cgi.parse_multipart(self.rfile, pdict)
            wav = form.get('file', [b''])[0]
            audio = wav_to_float32(wav)
            t0 = time.time()
            r = mlx_whisper.transcribe(audio, path_or_hf_repo=MODEL, language='en', task='transcribe',
                                       temperature=0.0, condition_on_previous_text=False, fp16=True,
                                       no_speech_threshold=0.6)
            text = (r.get('text') or '').strip()
            ms = int((time.time() - t0) * 1000)
            sys.stdout.write(f'{time.strftime("%H:%M:%S")} {len(audio)/16000:.1f}s -> {ms} ms: {text!r}\n'); sys.stdout.flush()
            self._json(200, {'text': text, 'engine': 'mlx-whisper', 'model': MODEL, 'ms': ms})
        except Exception as e:  # noqa: BLE001
            self._json(500, {'error': str(e)})


if __name__ == '__main__':
    # warm the model once so the first real utterance is not slow
    t0 = time.time()
    mlx_whisper.transcribe(np.zeros(16000, dtype=np.float32), path_or_hf_repo=MODEL, language='en', fp16=True)
    sys.stdout.write(f'model {MODEL} ready in {time.time()-t0:.1f}s; listening on {BIND}:{PORT} (token {"on" if TOKEN else "off"})\n'); sys.stdout.flush()
    ThreadingHTTPServer((BIND, PORT), H).serve_forever()
