'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'integrations');
const output = path.join(source, 'dist');
const sharedFiles = ['taskpane.css', 'taskpane-layout.css', 'diff.js', 'taskpane.js'];

function resetDirectory(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
}

function copy(from, to) {
  fs.copyFileSync(path.join(source, from), path.join(output, to));
}

resetDirectory(output);
copy('install.html', 'index.html');
copy('install.css', 'install.css');
for (const host of ['word', 'wps']) {
  fs.mkdirSync(path.join(output, host), { recursive: true });
  for (const file of sharedFiles) copy(`shared/${file}`, `${host}/${file}`);
}

const sharedHtml = fs.readFileSync(path.join(source, 'shared/taskpane.html'), 'utf8');
const officeScript = '<script src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js"></script>';
fs.writeFileSync(
  path.join(output, 'word/taskpane.html'),
  sharedHtml.replace('<script src="diff.js"></script>', `${officeScript}<script src="diff.js"></script>`),
);
fs.writeFileSync(path.join(output, 'wps/taskpane.html'), sharedHtml);

for (const file of ['adapter.js', 'manifest.xml']) copy(`word/${file}`, `word/${file}`);
for (const file of ['adapter.js', 'main.js', 'ribbon.xml', 'manifest.xml']) copy(`wps/${file}`, `wps/${file}`);

for (const target of ['icon-32.png', 'icon-64.png']) {
  const candidates = [target, 'icon-128.png', 'icon-256.png'].map((name) => path.join(root, 'assets', name));
  const candidate = candidates.find((file) => fs.existsSync(file));
  if (candidate) fs.copyFileSync(candidate, path.join(output, 'wps', target));
}

const packageDirectory = path.join(output, 'packages');
fs.mkdirSync(packageDirectory, { recursive: true });
const wpsArchive = path.join(packageDirectory, 'runshi-wps-addin-source.zip');
const zipResult = spawnSync('zip', ['-qr', wpsArchive, '.'], {
  cwd: path.join(output, 'wps'),
  encoding: 'utf8',
});
if (zipResult.status !== 0) {
  console.warn('Skipped WPS source archive because the zip command is unavailable.');
}

console.log(`Built Word and WPS add-ins in ${output}`);
