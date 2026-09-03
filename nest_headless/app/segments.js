// Speech segments from a microphone's 250 ms chunks, for the transcript wake
// path (wake_by_transcript). The small spotter mis-hears some utterances
// outright (a loud, close "Hey Claude" decoded as "I glob"), while the full
// recogniser gets them right; so every speech segment can be transcribed and
// judged on its text instead. This tracker only finds the segments: a run of
// chunks above the noise floor, with a short pre-roll, closed by a gap of
// relative quiet, capped in length. What happens to a segment is decided by
// the caller from its transcript; a segment nobody addressed to the house is
// dropped there without being kept, logged or sent.
'use strict';

const CHUNK_MS = 250;
const DEFAULTS = {
  preChunks: 2,          // audio kept before the onset
  startChunks: 2,        // consecutive chunks above the floor that open a segment
  minVoicedChunks: 3,    // shorter runs (a cough, a clank) are dropped
  gapChunks: 3,          // consecutive quiet chunks that close it
  maxChunks: 60,         // hard stop (15 s)
  floorMin: 0.006, floorMax: 0.015, floorMul: 3,   // as the wake-word capture: 3x the quietest tenth, clamped
  relQuiet: 0.18,        // once speaking, quiet is relative to the running peak
  history: 40,           // chunks of RMS history for the floor (10 s)
};

class SegmentTracker {
  constructor(opts = {}) { this.o = { ...DEFAULTS, ...opts }; this.rmsHist = []; this.reset(); }
  reset() { this.active = null; this.pre = []; this.run = 0; }
  floor() {
    const s = [...this.rmsHist].sort((a, b) => a - b);
    const q = s[Math.floor(s.length * 0.1)] || this.o.floorMin;
    return Math.min(this.o.floorMax, Math.max(this.o.floorMin, q * this.o.floorMul));
  }
  // chunk: Float32Array (16 kHz), rms: its RMS. Returns a finished segment
  // {chunks, floor, startedMs, voicedMs, peak} or null.
  feed(chunk, rms, now = Date.now()) {
    this.rmsHist.push(rms); if (this.rmsHist.length > this.o.history) this.rmsHist.shift();
    if (!this.active) {
      this.pre.push(chunk); if (this.pre.length > this.o.preChunks + this.o.startChunks) this.pre.shift();
      const floor = this.floor();
      this.run = rms > floor ? this.run + 1 : 0;
      if (this.run >= this.o.startChunks) {
        this.active = { chunks: [...this.pre], floor, startedMs: now - this.pre.length * CHUNK_MS, peak: rms, voiced: this.run, quiet: 0 };
        this.pre = []; this.run = 0;
      }
      return null;
    }
    const a = this.active;
    a.chunks.push(chunk); a.peak = Math.max(a.peak, rms);
    const quietBelow = Math.max(a.floor, this.o.relQuiet * a.peak);
    if (rms > quietBelow) { a.voiced++; a.quiet = 0; } else a.quiet++;
    if (a.quiet < this.o.gapChunks && a.chunks.length < this.o.maxChunks) return null;
    this.active = null;
    if (a.voiced < this.o.minVoicedChunks) return null;
    return { chunks: a.chunks, floor: a.floor, startedMs: a.startedMs, voicedMs: a.voiced * CHUNK_MS, peak: a.peak };
  }
}

module.exports = { SegmentTracker, CHUNK_MS, DEFAULTS };
