'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const diskq = require('../diskq');

// os.tmpdir() can point at a directory that does not exist (sandboxed shells);
// fall back to a scratch dir beside the tests and remove it afterwards.
const scratch = path.join(__dirname, '.tmp');
const base = (() => { try { fs.mkdirSync(os.tmpdir(), { recursive: true }); return os.tmpdir(); } catch (e) { fs.mkdirSync(scratch, { recursive: true }); return scratch; } })();
// Remove only what this file made. It used to rm the whole of `.tmp`, which is
// shared with every other test file that falls back to it - and `node --test`
// runs files in PARALLEL, so finishing first deleted another file's temp dirs
// out from under it mid-run. That showed up as a suite whose collected-test
// count varied between runs (86 and 89 on the same commit) with no failures,
// which is the worst shape for a signal to be in.
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(base, 'diskq-')); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

test('serial runs ops in order per key and isolates failures', async () => {
  const seen = [];
  const p1 = diskq.serial('k', async () => { await new Promise((r) => setTimeout(r, 30)); seen.push(1); });
  const p2 = diskq.serial('k', async () => { throw new Error('boom'); });
  const p3 = diskq.serial('k', async () => { seen.push(3); });
  await p1; await assert.rejects(p2); await p3;
  assert.deepStrictEqual(seen, [1, 3]);
});

test('writeAtomic writes the newest buffer queued for a file, once', async () => {
  const dir = tmp(), f = path.join(dir, 'a.jpg');
  const p1 = diskq.writeAtomic(f, Buffer.from('one'));
  const p2 = diskq.writeAtomic(f, Buffer.from('two'));
  const p3 = diskq.writeAtomic(f, Buffer.from('three'));
  await Promise.all([p1, p2, p3]);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'three');
  assert.ok(!fs.existsSync(f + '.tmp'));
  await diskq.writeAtomic(f, Buffer.from('four'));
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'four');
});

test('writeAtomic creates missing parent directories', async () => {
  const f = path.join(tmp(), 'deep', 'er', 'x.json');
  await diskq.writeAtomic(f, Buffer.from('{}'));
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '{}');
});

test('DirIndex retires files by age before it caps by count', async () => {
  const dir = tmp();
  const ix = new diskq.DirIndex(dir);
  const day = 86400000, now = Date.now();
  const stamp = (t) => new Date(t).toISOString().replace(/[:.]/g, '-') + '.jpg';
  const ageOf = (n) => { const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(n); return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : null; };
  for (const t of [now - 40 * day, now - 10 * day, now - 2 * day]) await ix.put(stamp(t), Buffer.from('x'));
  await ix.put('notes.txt', Buffer.from('n'));   // unstamped: never aged out
  await ix.put(stamp(now), Buffer.from('x'), { maxAgeMs: 30 * day, ageOf });
  const left = fs.readdirSync(dir).sort();
  assert.strictEqual(left.length, 4, `expected the 40-day-old file gone, got ${left.join(',')}`);
  assert.ok(!left.includes(stamp(now - 40 * day)));
  assert.ok(left.includes(stamp(now - 10 * day)) && left.includes('notes.txt'));
});

test('DirIndex caps the directory from an in-memory listing', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '2026-01.jpg'), 'pre');   // present before the index is built
  const ix = new diskq.DirIndex(dir);
  for (const n of ['2026-02', '2026-03', '2026-04', '2026-05']) await ix.put(n + '.jpg', Buffer.from('x'), { max: 4, dropN: 2 });
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['2026-03.jpg', '2026-04.jpg', '2026-05.jpg']);
  await ix.put('2026-05_a.jpg', Buffer.from('y'));
  assert.deepStrictEqual(ix.names, ['2026-03.jpg', '2026-04.jpg', '2026-05.jpg', '2026-05_a.jpg']);
  await ix.put('notes.txt', Buffer.from('z'));
  assert.ok(!ix.names.includes('notes.txt'));
});

test('writeAtomic falls back to an in-place write when the share locks the destination', async () => {
  const dir = tmp(), f = path.join(dir, 'locked.jpg');
  fs.writeFileSync(f, 'stale');
  const fsp = require('fs/promises');
  const realRename = fsp.rename;
  fsp.rename = async () => { const e = new Error('resource busy'); e.code = 'EBUSY'; throw e; };
  try {
    await diskq.writeAtomic(f, Buffer.from('fresh'));
  } finally { fsp.rename = realRename; }
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'fresh', 'the new frame lands anyway');
  assert.ok(!fs.existsSync(f + '.tmp'), 'and the temp file is cleaned up');
});

test('writeAtomic still surfaces a rename failure that is not a lock', async () => {
  const dir = tmp(), f = path.join(dir, 'other.jpg');
  const fsp = require('fs/promises');
  const realRename = fsp.rename;
  fsp.rename = async () => { const e = new Error('no space'); e.code = 'ENOSPC'; throw e; };
  try {
    await assert.rejects(diskq.writeAtomic(f, Buffer.from('x')), /no space/);
  } finally { fsp.rename = realRename; }
});
