const fs = require('fs');
const os = require('os');
const path = require('path');
const { signAsync } = require('@electron/osx-sign');

/**
 * electron-builder custom macOS signer.
 *
 * This runs after Electron has finished modifying helper apps/frameworks, so
 * the resulting ad-hoc signature remains internally consistent. The explicit
 * designated requirement also gives macOS Accessibility a stable identity
 * across local rebuilds.
 */
exports.default = async function signMacApp(options) {
  const appPath = options.app;
  console.log(`[sign] Ad-hoc signing final app: ${appPath}`);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runshi-sign-'));
  const requirementPath = path.join(tempDir, 'requirements.txt');
  fs.writeFileSync(
    requirementPath,
    'designated => identifier "com.runshi.app"',
    'utf8'
  );

  try {
    await signAsync({
      app: appPath,
      platform: 'darwin',
      type: 'distribution',
      identity: '-',
      identityValidation: false,
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
      strictVerify: false,
      optionsForFile(filePath) {
        return {
          hardenedRuntime: false,
          requirements: filePath === appPath ? requirementPath : undefined,
        };
      },
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log('[sign] Ad-hoc signing done.');
};
