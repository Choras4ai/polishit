'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../package.json');

test('macOS package contains the unpacked native selection module and final signer', () => {
  assert.ok(pkg.build.files.includes('native/bin/*.node'));
  assert.ok(pkg.build.asarUnpack.includes('native/bin/*.node'));
  assert.equal(pkg.build.mac.sign, './scripts/sign.js');
  assert.equal(pkg.build.mac.identity, '-');
  assert.ok(fs.existsSync(path.resolve(__dirname, '..', pkg.build.mac.sign)));
});

test('embedded backend ships shared source dependencies outside app.asar', () => {
  assert.ok(!pkg.build.extraResources.some(entry => entry.from === 'src'), 'extraResources must not exclude desktop modules from ASAR');
  const hook = fs.readFileSync(path.resolve(__dirname, '../scripts/afterPack.js'), 'utf8');
  assert.ok(pkg.build.extraResources.some(entry => entry.from === 'server/node_modules' && entry.to === 'server/node_modules'));
  for (const required of ['ai/presets.js', 'commercial/model-timeouts.js', 'commercial/credit-policy.js', 'commercial/profit-policy.js']) {
    assert.ok(hook.includes(required), required);
  }
});

test('afterPack copies backend modules without removing desktop source files', async () => {
  const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'runshi-pack-test-'));
  const root = path.resolve(__dirname, '..');
  try {
    const staging = path.join(temporary, 'staging');
    fs.mkdirSync(staging);
    fs.cpSync(path.join(root, 'src'), path.join(staging, 'src'), { recursive: true });
    for (const file of ['main.js', 'preload.js']) fs.copyFileSync(path.join(root, file), path.join(staging, file));
    fs.mkdirSync(path.join(temporary, 'resources'));
    const archive = path.join(temporary, 'resources/app.asar');
    const asar = require('@electron/asar');
    await asar.createPackage(staging, archive);
    await require('../scripts/afterPack').default({
      electronPlatformName: 'win32', appOutDir: temporary,
      packager: { projectDir: root },
    });
    for (const relative of ['ai/presets.js', 'commercial/model-timeouts.js', 'commercial/credit-policy.js', 'commercial/profit-policy.js']) {
      assert.deepEqual(fs.readFileSync(path.join(temporary, 'resources/src', relative)), fs.readFileSync(path.join(root, 'src', relative)));
    }
    fs.writeFileSync(path.join(staging, 'src/config.js'), 'le.exports = ProxyProvider;\n' + fs.readFileSync(path.join(root, 'src/config.js'), 'utf8'));
    asar.uncache(archive);
    await asar.createPackage(staging, archive);
    asar.uncache(archive);
    await assert.rejects(require('../scripts/afterPack').default({ electronPlatformName: 'win32', appOutDir: temporary, packager: { projectDir: root } }), /Packaged source differs.*config.js/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
