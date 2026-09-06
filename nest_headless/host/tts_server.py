#!/usr/bin/env python3
"""House Voice: local neural text-to-speech for nest_headless / Hearth (Kokoro-82M on Apple MLX).

  GET  /health            {"ok": true, "model": ..., "voices": [...]}   (open)
  GET  /voices            {"voices": [...], "default": ...}            (open)
  POST /speak             JSON {"text": "...", "voice": "bf_emma", "speed": 1.0}
                          -> 200 audio/wav, 24 kHz mono 16-bit
                          bearer token required off-loopback when a token is set

  KOKORO_MODEL   HF repo (default mlx-community/Kokoro-82M-bf16)
  TTS_VOICE      default voice (bf_emma)
  TTS_VOICES     comma-separated voice ids offered (default: the British set)
  BIND / PORT    default 127.0.0.1 / 8179
  TTS_TOKEN or TTS_TOKEN_FILE
Audio is synthesised in memory and never written to disk.
"""
import io, json, os, struct, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

# Cap and clear the MLX buffer cache (see whisper_server.py): a worker's cache
# grows without bound on varying input lengths.
try:
    import mlx.core as _mx
    _mx.set_cache_limit(int(os.environ.get('MLX_CACHE_LIMIT_MB', '256')) * 1024 * 1024)
    _clear_cache = _mx.clear_cache
except Exception:  # noqa: BLE001
    _clear_cache = lambda: None  # noqa: E731
from mlx_audio.tts.utils import load_model

MODEL = os.environ.get('KOKORO_MODEL', 'mlx-community/Kokoro-82M-bf16')
DEFAULT_VOICE = os.environ.get('TTS_VOICE', 'bf_emma')
VOICES = [v for v in os.environ.get('TTS_VOICES', 'bf_alice,bf_emma,bf_isabella,bf_lily,bm_daniel,bm_fable,bm_george,bm_lewis').split(',') if v]
BIND = os.environ.get('BIND', '127.0.0.1')
PORT = int(os.environ.get('PORT', '8179'))
MAX_CHARS = int(os.environ.get('TTS_MAX_CHARS', '1000'))
TOKEN = os.environ.get('TTS_TOKEN', '').strip()
if not TOKEN and os.environ.get('TTS_TOKEN_FILE'):
    try:
        TOKEN = open(os.environ['TTS_TOKEN_FILE']).read().strip()
    except OSError:
        TOKEN = ''

model = None
lock = threading.Lock()   # the MLX graph is not re-entrant; one synthesis at a time


def lang_for(voice: str) -> str:
    return 'b' if voice.startswith('b') else 'a'   # Kokoro: a = American English, b = British English


def synth(text: str, voice: str, speed: float) -> tuple[bytes, int]:
    with lock:
        parts = []
        sr = 24000
        for seg in model.generate(text=text, voice=voice, speed=speed, lang_code=lang_for(voice)):
            parts.append(np.asarray(seg.audio, dtype=np.float32))
            sr = int(getattr(seg, 'sample_rate', sr) or sr)
    audio = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
    pcm = (np.clip(audio, -1, 1) * 32767).astype('<i2').tobytes()
    hdr = b'RIFF' + struct.pack('<I', 36 + len(pcm)) + b'WAVE' + b'fmt ' + struct.pack('<IHHIIHH', 16, 1, 1, sr, sr * 2, 2, 16) + b'data' + struct.pack('<I', len(pcm))
    return hdr + pcm, sr


_synth_impl = synth
def synth(text, voice, speed):
    try:
        return _synth_impl(text, voice, speed)
    finally:
        _clear_cache()


class H(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
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
            return self._json(200, {'ok': True, 'model': MODEL, 'voices': VOICES, 'default': DEFAULT_VOICE})
        if self.path == '/voices':
            return self._json(200, {'voices': VOICES, 'default': DEFAULT_VOICE})
        self._json(404, {'error': 'not found'})

    def do_POST(self):
        if not self.path.startswith('/speak'):
            return self._json(404, {'error': 'not found'})
        if TOKEN and self.client_address[0] not in ('127.0.0.1', '::1'):
            if self.headers.get('Authorization', '') != f'Bearer {TOKEN}':
                return self._json(401, {'error': 'unauthorized'})
        try:
            n = int(self.headers.get('Content-Length', '0'))
            body = json.loads(self.rfile.read(n) or b'{}')
            text = str(body.get('text', '')).strip()
            if not text:
                return self._json(400, {'error': 'empty text'})
            if len(text) > MAX_CHARS:
                return self._json(400, {'error': f'text longer than {MAX_CHARS} characters'})
            # A voice may be several names separated by commas: Kokoro stores each
            # voice as a style vector and the pipeline averages them, so a blend
            # costs nothing at all - same model, same speed, same memory - and
            # gives a voice the house does not otherwise have.
            voice = str(body.get('voice') or DEFAULT_VOICE)
            parts = [v.strip() for v in voice.split(',') if v.strip()]
            if not parts or any(v not in VOICES for v in parts):
                return self._json(400, {'error': 'unknown voice', 'voices': VOICES,
                                        'note': 'a blend may be given as "bf_emma,bf_alice"'})
            voice = ','.join(parts)
            speed = float(body.get('speed') or 1.0)
            speed = max(0.5, min(2.0, speed))
            t0 = time.time()
            wav, sr = synth(text, voice, speed)
            ms = int((time.time() - t0) * 1000)
            sys.stdout.write(f'{time.strftime("%H:%M:%S")} {voice} {len(text)} chars -> {len(wav)//2/sr:.1f}s audio in {ms} ms\n'); sys.stdout.flush()
            self.send_response(200)
            self.send_header('Content-Type', 'audio/wav')
            self.send_header('Content-Length', str(len(wav)))
            self.send_header('X-Synth-Ms', str(ms))
            self.end_headers()
            self.wfile.write(wav)
        except Exception as e:  # noqa: BLE001
            self._json(500, {'error': str(e)})


if __name__ == '__main__':
    t0 = time.time()
    model = load_model(MODEL)
    synth('Ready.', DEFAULT_VOICE, 1.0)   # warm the graph so the first real sentence is quick
    sys.stdout.write(f'model {MODEL} ready in {time.time()-t0:.1f}s; listening on {BIND}:{PORT} (token {"on" if TOKEN else "off"}); default voice {DEFAULT_VOICE}\n'); sys.stdout.flush()
    ThreadingHTTPServer((BIND, PORT), H).serve_forever()
