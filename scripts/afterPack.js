const { execSync } = require('child_process');
const path = require('path');

/**
 * electron-builder afterPack hook
 * 对 macOS 构建产物进行 ad-hoc 签名（codesign -s -），
 * 使 Gatekeeper 提示从"已损坏"降级为"无法验证开发者"，
 * 用户可通过"右键 → 打开"绕过，无需终端命令。
 */
exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  console.log(`[afterPack] Ad-hoc signing: ${appPath}`);
  execSync(
    `codesign --force --deep -s - "${appPath}"`,
    { stdio: 'inherit' }
  );
  console.log('[afterPack] Ad-hoc signing done.');
};
