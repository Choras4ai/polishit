'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const target = process.argv[2] || 'current';
const hostPlatform = os.platform();
const hostArch = os.arch();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.status !== 0) {
    process.exitCode = result.status || 1;
    throw new Error(`${command} ${args.join(' ')} failed`);
  }
}

function installServerDeps(platform = hostPlatform, arch = hostArch) {
  const env = { ...process.env };
  if (platform && platform !== 'host') env.npm_config_platform = platform;
  if (arch && arch !== 'host') env.npm_config_arch = arch;
  const nodeModulesPath = path.join(__dirname, '..', 'server', 'node_modules');
  fs.rmSync(nodeModulesPath, { recursive: true, force: true });
  console.log(`[build] installing server dependencies for ${platform || hostPlatform}/${arch || hostArch}`);
  run('npm', ['--prefix', 'server', 'ci', '--omit=dev'], { env });
}

function restoreHostDeps() {
  installServerDeps(hostPlatform, hostArch);
}

function buildMac() {
  restoreHostDeps();
  run(process.execPath, ['scripts/build-native.js']);
  run('npx', ['electron-builder', '--mac']);
}

function buildWin() {
  installServerDeps('win32', 'x64');
  try {
    run('npx', ['electron-builder', '--win']);
  } finally {
    restoreHostDeps();
  }
}

try {
  if (target === 'mac') {
    buildMac();
  } else if (target === 'win') {
    buildWin();
  } else if (target === 'all') {
    buildMac();
    buildWin();
  } else {
    restoreHostDeps();
    run(process.execPath, ['scripts/build-native.js']);
    run('npx', ['electron-builder']);
  }
} catch (err) {
  console.error(`[build] ${err.message}`);
  process.exit(process.exitCode || 1);
}
