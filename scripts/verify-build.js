'use strict';
// Run after npm run build:all. Verifies the actual artifacts, not stale filenames.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const digest = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const result = { version: pkg.version, verifiedAt: new Date().toISOString(), artifacts: [], packages: [] };
for (const [platform, resourcePath, artifactName] of [
  ['mac-arm64', 'dist/mac-arm64/润石 PoliShit.app/Contents/Resources', `润石 PoliShit-${pkg.version}-arm64.dmg`],
  ['win-x64', 'dist/win-unpacked/resources', `润石 PoliShit Setup ${pkg.version}.exe`],
]) {
  const resources = path.join(root, resourcePath);
  const archive = path.join(resources, 'app.asar');
  assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).version, pkg.version);
  const archiveEntries = asar.listPackage(archive);
  const forbiddenArchiveEntries = archiveEntries.filter(entry => /^\.env(?:\.|$)/.test(path.basename(entry)) || /\.(pem|p12|pfx|db|sqlite3?)$/i.test(entry));
  assert.deepEqual(forbiddenArchiveEntries, [], `${platform}: private ASAR filenames`);
  const checks = [];
  for (const relative of ['main.js', 'preload.js', 'src/config.js', 'src/ai/pipeline.js', 'src/ai/provider-factory.js', 'src/selection-watcher.js', 'src/commercial/client.js', 'src/ai/presets.js', 'src/ai/openai-provider.js', 'src/commercial/model-timeouts.js', 'src/commercial/credit-policy.js', 'src/commercial/profit-policy.js', 'src/capture.js', 'src/review-state.js', 'src/source-review.js', 'src/windows-review-helper.js', 'src/macos-selection-helper.js', 'src/renderer/source-review/preload.js', 'src/renderer/source-review/index.html', 'src/renderer/source-review/style.css', 'src/renderer/source-review/script.js', 'src/renderer/settings/script.js', 'src/renderer/settings/index.html', 'src/renderer/result/script.js', 'src/updater/index.js', 'src/updater/download.js', 'src/updater/windows-installer.js']) {
    assert.equal(digest(asar.extractFile(archive, relative)), digest(fs.readFileSync(path.join(root, relative))), `${platform}: stale ${relative}`);
    checks.push(relative);
  }
  const windowsScript = 'scripts/windows_review.ps1';
  assert.equal(digest(fs.readFileSync(path.join(resources, 'app.asar.unpacked', windowsScript))), digest(fs.readFileSync(path.join(root, windowsScript))), `${platform}: missing/stale unpacked Word helper`);
  checks.push(windowsScript);
  if (platform === 'mac-arm64') {
    const native = 'native/bin/runshi_selection.node';
    // Final bundle signing changes Mach-O signature bytes. Compare disposable
    // unsigned copies so signed code is checked without touching either original.
    const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'runshi-native-verify-'));
    try {
      const copies = [path.join(resources, 'app.asar.unpacked', native), path.join(root, native)].map((source, i) => {
        const copy = path.join(temp, String(i) + '.node'); fs.copyFileSync(source, copy);
        execFileSync('/usr/bin/codesign', ['--remove-signature', copy]);
        const bytes = fs.readFileSync(copy);
        assert.equal(bytes.readUInt32LE(0), 0xfeedfacf, 'expected 64-bit Mach-O');
        // Removing a larger signature leaves __LINKEDIT's reserved virtual
        // size enlarged. Normalize only that allocation field, not code/data.
        let offset = 32;
        for (let i = 0; i < bytes.readUInt32LE(16); i++) {
          const command = bytes.readUInt32LE(offset), length = bytes.readUInt32LE(offset + 4);
          assert(length >= 8 && offset + length <= bytes.length);
          if (command === 0x19 && bytes.toString('ascii', offset + 8, offset + 24).replace(/\0/g, '') === '__LINKEDIT') bytes.fill(0, offset + 32, offset + 40);
          offset += length;
        }
        return bytes;
      });
      assert.equal(digest(copies[0]), digest(copies[1]), 'stale macOS AX helper code');
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
    checks.push(native);
  }
  for (const relative of ['server/index.js', 'server/db.js', 'server/services/auth-service.js', 'server/services/quota-service.js', 'server/services/chat-request.js', 'server/services/upstream-service.js', 'server/commercial/models.js', 'server/commercial/account-service.js', 'server/admin.js', 'src/ai/presets.js', 'src/commercial/model-timeouts.js', 'src/commercial/credit-policy.js', 'src/commercial/profit-policy.js']) {
    assert.equal(digest(fs.readFileSync(path.join(resources, relative))), digest(fs.readFileSync(path.join(root, relative))), `${platform}: stale/missing ${relative}`);
    checks.push(relative);
  }
  const sqlite = path.join(resources, 'server/node_modules/sqlite3/build/Release/node_sqlite3.node');
  const architecture = execFileSync('/usr/bin/file', ['-b', sqlite], { encoding: 'utf8' }).trim();
  assert.match(architecture, platform === 'mac-arm64' ? /Mach-O.*arm64/ : /PE32\+.*x86-64/);
  const forbidden = [];
  function inspect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) inspect(file);
      else if (entry.isFile() && (/^\.env(?:\.|$)/.test(entry.name) || /\.(pem|p12|pfx|db|sqlite3?)$/i.test(entry.name))) forbidden.push(path.relative(resources, file));
    }
  }
  inspect(resources); assert.deepEqual(forbidden, [], `${platform}: private resource files`);
  let signature = 'Authenticode not verified on this host';
  if (platform === 'mac-arm64') {
    const appPath = path.resolve(resources, '../..');
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
    const plistVersion = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(appPath, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
    assert.equal(plistVersion, pkg.version); signature = 'ad-hoc codesign deep/strict passed; not notarized';
  }
  const artifact = path.join(root, 'dist', artifactName);
  result.artifacts.push({ platform, path: artifact, bytes: fs.statSync(artifact).size, sha256: digest(fs.readFileSync(artifact)) });
  result.packages.push({ platform, embeddedVersion: pkg.version, sourceChecks: checks, sqliteArchitecture: architecture, signature, privateResourceFiles: forbidden, privateArchiveFilenames: forbiddenArchiveEntries });
}
const output = path.join(root, 'dist', `audit-${pkg.version}.json`);
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ ok: true, output, artifacts: result.artifacts }));
