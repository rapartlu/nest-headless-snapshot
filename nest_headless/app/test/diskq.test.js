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
const tmp = () => fs.mkdtempSync(path.join(base, 'diskq-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

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
