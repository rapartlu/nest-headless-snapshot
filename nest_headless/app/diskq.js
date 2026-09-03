// Disk I/O that never blocks the event loop. The www/ and archive directories
// may live on a network share (a Mac running against the NAS over SMB): a
// sync readdir of a 2000-file archive there took 2.6 s and a 250 KB write
// 70-180 ms, and every one of them stalled the audio path and the status
// route (#17). Everything here goes through fs.promises, serialised per key,
// and directory listings are read once and then kept in memory.
'use strict';

const fsp = require('fs/promises');
const path = require('path');

const chains = new Map();
// Run op after every earlier op queued under the same key (a file or a dir).
// Resolves/rejects with op's own result; a failure never blocks the chain.
function serial(key, op) {
  const prev = chains.get(key) || Promise.resolve();
  const p = prev.then(op);
  const tail = p.catch(() => {}).then(() => { if (chains.get(key) === tail) chains.delete(key); });
  chains.set(key, tail);
  return p;
}

// Atomic write (tmp + rename), serialised per file, latest-wins: a write
// queued behind an in-flight one for the same file takes whichever buffer is
// newest when it starts, so a slow share never builds a backlog of stale frames.
const queued = new Map();
function writeAtomic(file, buf) {
  const q = queued.get(file);
  if (q) { q.buf = buf; return q.promise; }
  const entry = { buf };
  entry.promise = serial(file, async () => {
    queued.delete(file);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file + '.tmp', entry.buf);
    await fsp.rename(file + '.tmp', file);
  });
  queued.set(file, entry);
  return entry.promise;
}

// A directory whose listing (files with ext) is read once and then maintained
// in memory; writes and pruning run one at a time per directory.
class DirIndex {
  constructor(dir, ext = '.jpg') { this.dir = dir; this.ext = ext; this.names = null; }
  async load() {
    if (this.names) return this.names;
    await fsp.mkdir(this.dir, { recursive: true });
    this.names = (await fsp.readdir(this.dir)).filter((f) => f.endsWith(this.ext)).sort();
    return this.names;
  }
  // Write name into the directory. When the listing has reached max, the
  // oldest dropN (by name: ISO stamps sort chronologically) are unlinked first.
  put(name, buf, { max = Infinity, dropN = 0 } = {}) {
    return serial(this.dir, async () => {
      const names = await this.load();
      if (names.length >= max && dropN > 0) {
        for (const old of names.splice(0, dropN)) await fsp.unlink(path.join(this.dir, old)).catch(() => {});
      }
      await fsp.writeFile(path.join(this.dir, name), buf);
      if (name.endsWith(this.ext) && !names.includes(name)) { names.push(name); names.sort(); }
    });
  }
}

module.exports = { serial, writeAtomic, DirIndex };
