// config.yaml is the manifest anyone reads to learn what is deployed; ADDON_VERSION
// is what the running process reports. They drifted five releases apart before this
// test existed (config.yaml sat at 1.25.1 while the code shipped 1.30.0).
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

test('config.yaml version matches ADDON_VERSION', () => {
  const root = path.join(__dirname, '..', '..');
  const manifest = fs.readFileSync(path.join(root, 'config.yaml'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'app', 'server.js'), 'utf8');

  const inManifest = manifest.match(/^version:\s*"([^"]+)"/m);
  const inCode = server.match(/^const ADDON_VERSION = '([^']+)'/m);

  assert.ok(inManifest, 'config.yaml has no version:');
  assert.ok(inCode, 'server.js has no ADDON_VERSION');
  assert.strictEqual(
    inManifest[1],
    inCode[1],
    `config.yaml says ${inManifest[1]} but ADDON_VERSION is ${inCode[1]} - bump both`,
  );
});
