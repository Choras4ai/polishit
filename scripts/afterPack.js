const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Arch } = require('builder-util');

// Build and sign the selection helper; final bundle signing runs in scripts/sign.js.
exports.default = async function (context) {
  // Copy shared backend dependencies after packaging. Declaring src as an
  // extraResources source makes electron-builder remove these same files from
  // app.asar, breaking the desktop's ordinary relative require() calls.
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  for (const relative of ['ai/presets.js', 'commercial/model-timeouts.js', 'commercial/credit-policy.js', 'commercial/profit-policy.js']) {
    const destination = path.join(resources, 'src', relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(context.packager.projectDir, 'src', relative), destination);
  }
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  // Accessibility must be queried by a helper that belongs to the signed app
  // bundle. A helper compiled later into ~/Library/Application Support gets a
  // different TCC identity, so macOS can show the app as authorised while the
  // selection probe still sees `trusted: false`.
  const probeSource = path.join(context.packager.projectDir, 'scripts', 'selection_probe.swift');
  const probePath = path.join(appPath, 'Contents', 'Resources', 'runshi-selection-probe');
  const architecture = context.arch === Arch.arm64 ? 'arm64' : context.arch === Arch.x64 ? 'x86_64' : null;
  if (!architecture) throw new Error('Selection probe requires an explicit arm64 or x64 build.');
  execFileSync('/usr/bin/lipo', [
    path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'native', 'bin', 'runshi_selection.node'),
    '-verify_arch', architecture]);
  console.log(`[afterPack] Building bundled selection probe: ${probePath}`);
  execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-target', `${architecture}-apple-macosx12.0`, probeSource, '-o', probePath], {
    stdio: 'inherit',
  });
  fs.chmodSync(probePath, 0o755);
  execFileSync('/usr/bin/codesign', ['--force', '-s', '-', probePath], {
    stdio: 'inherit',
  });

  // The full app is signed by scripts/sign.js after Electron has finished
  // rewriting all nested framework metadata. Signing here would be invalidated
  // by Electron's own framework afterPack hook.
};
