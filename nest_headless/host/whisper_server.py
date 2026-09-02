#!/usr/bin/env python3
"""Tiny local transcription server for nest_headless (Whisper via Apple MLX).

Speaks the same shape as whisper.cpp's `whisper-server`: POST /inference with a
multipart "file" field holding a 16 kHz mono 16-bit WAV, replies {"text": ...}.
Audio is decoded in memory and never written to disk. Loopback only.

  WHISPER_MODEL   HF repo or local path (default mlx-community/whisper-large-v3-turbo)
  PORT            default 8178
"""
import cgi, io, json, os, queue, struct, sys, threading, time
import multiprocessing as mp
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
try:
    import mlx_whisper
except ImportError:  # parakeet-only installs
    mlx_whisper = None
single_backend = None

ENGINE = os.environ.get('STT_ENGINE', 'mlx-whisper')    # mlx-whisper | parakeet-mlx
MODEL = os.environ.get('WHISPER_MODEL', 'mlx-community/parakeet-tdt-0.6b-v3' if ENGINE == 'parakeet-mlx' else 'mlx-community/whisper-large-v3-turbo')
WORKERS = int(os.environ.get('WHISPER_WORKERS', '2'))   # model copies on the GPU; ~1.6 GB each; requests use whichever is free
transcribe_lock = threading.Lock()   # fallback when WORKERS <= 1: MLX graphs are not re-entrant
pool = queue.Queue()                 # idle worker connections


def make_backend(engine, model):
    """Returns transcribe(audio_float32_16k) -> text for the chosen engine."""
    import numpy as _np
    if engine == 'parakeet-mlx':
        import mlx.core as _mx
        from parakeet_mlx import from_pretrained
        m = from_pretrained(model)
        from parakeet_mlx.audio import get_logmel
        def run(audio):
            # in-memory path (transcribe() wants a file): log-mel from the 16 kHz float array, then generate
            res = m.generate(get_logmel(_mx.array(audio), m.preprocessor_config))
            r = res[0] if isinstance(res, list) else res
            return (r.text or '').strip()
        run(_np.zeros(16000, dtype=_np.float32))
        return run
    import mlx_whisper as _mw
    def run(audio):
        r = _mw.transcribe(audio, path_or_hf_repo=model, language='en', task='transcribe',
                           temperature=0.0, condition_on_previous_text=False, fp16=True, no_speech_threshold=0.6)
        return (r.get('text') or '').strip()
    run(_np.zeros(16000, dtype=_np.float32))
    return run


def worker_main(conn, model, engine='mlx-whisper'):
    """One model copy in its own process: warm, then loop transcribing what the parent sends."""
    run = make_backend(engine, model)
    conn.send(('ready', os.getpid()))
    while True:
        audio = conn.recv()
        if audio is None:
            break
        try:
            conn.send(('ok', run(audio)))
        except Exception as e:  # noqa: BLE001
            conn.send(('err', str(e)))


def transcribe(audio):
    if WORKERS < 1:   # in-process (not thread-safe for MLX: only for debugging)
        with transcribe_lock:
            return single_backend(audio)
    conn = pool.get()          # blocks only when every worker is busy
    try:
        conn.send(audio)
        status, payload = conn.recv()
    finally:
        pool.put(conn)
    if status != 'ok':
        raise RuntimeError(payload)
    return payload
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
            return self._json(200, {'ok': True, 'engine': ENGINE, 'model': MODEL, 'workers': WORKERS})
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
            text = transcribe(audio)
            ms = int((time.time() - t0) * 1000)
            sys.stdout.write(f'{time.strftime("%H:%M:%S")} {len(audio)/16000:.1f}s -> {ms} ms: {text!r}\n'); sys.stdout.flush()
            self._json(200, {'text': text, 'engine': ENGINE, 'model': MODEL, 'ms': ms})
        except Exception as e:  # noqa: BLE001
            self._json(500, {'error': str(e)})


if __name__ == '__main__':
    t0 = time.time()
    if WORKERS >= 1:   # always worker processes: MLX streams are bound to the thread that created them
        ctx = mp.get_context('spawn')
        procs = []
        for _ in range(WORKERS):
            parent, child = ctx.Pipe()
            p = ctx.Process(target=worker_main, args=(child, MODEL, ENGINE), daemon=True)
            p.start(); procs.append((parent, p))
        for parent, p in procs:
            st, pid = parent.recv()
            pool.put(parent)
        sys.stdout.write(f'{WORKERS} model workers ready in {time.time()-t0:.1f}s; listening on {BIND}:{PORT} (token {"on" if TOKEN else "off"})\n'); sys.stdout.flush()
    else:
        single_backend = make_backend(ENGINE, MODEL)   # warms the model so the first real utterance is not slow
        sys.stdout.write(f'model {MODEL} ready in {time.time()-t0:.1f}s; listening on {BIND}:{PORT} (token {"on" if TOKEN else "off"})\n'); sys.stdout.flush()
    ThreadingHTTPServer((BIND, PORT), H).serve_forever()
