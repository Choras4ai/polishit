'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (os.platform() !== 'darwin') process.exit(0);

const projectRoot = path.join(__dirname, '..');
const nodeGyp = path.join(projectRoot, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
const electronVersion = require(path.join(projectRoot, 'node_modules', 'electron', 'package.json')).version;
const result = spawnSync(process.execPath, [
  nodeGyp,
  'rebuild',
  `--target=${electronVersion}`,
  `--arch=${process.env.npm_config_arch || process.arch}`,
  '--dist-url=https://electronjs.org/headers',
], {
  cwd: projectRoot,
  stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status || 1);

const source = path.join(projectRoot, 'build', 'Release', 'runshi_selection.node');
const destinationDir = path.join(projectRoot, 'native', 'bin');
const destination = path.join(destinationDir, 'runshi_selection.node');
fs.mkdirSync(destinationDir, { recursive: true });
fs.copyFileSync(source, destination);
console.log(`[native] built ${destination}`);
