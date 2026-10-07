'use strict';
const { spawn } = require('node:child_process');
function launchWindowsInstaller(filePath, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const installer = spawnProcess(filePath, ['/S', '--updated', '--force-run'], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    installer.once('error', reject);
    installer.once('spawn', () => { installer.unref(); resolve(); });
  });
}
module.exports = { launchWindowsInstaller };
