const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');

GlobalFonts.registerFromPath('/Library/Fonts/PingFangSC-Regular.ttf', 'PingFang SC');

// Low-saturation dark green, slightly higher brightness
const COLOR = '#4A7C6B';

function makeAppIcon(size, filename) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);

  // Rounded rect background
  const r = size * 0.22;
  const m = size * 0.02;
  ctx.beginPath();
  ctx.roundRect(m, m, size - 2*m, size - 2*m, r);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();

  // Character
  const fontSize = size * 0.58;
  ctx.font = fontSize + 'px "PingFang SC"';
  ctx.fillStyle = COLOR;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('\u6DA6', size/2, size/2 + size*0.02);

  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(path.join(__dirname, '..', 'assets', filename), buf);
  console.log('Created', filename, buf.length, 'bytes');
}

function makeTrayIcon(size, filename) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);

  const fontSize = size * 0.85;
  ctx.font = '600 ' + fontSize + 'px "PingFang SC"';
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('\u6DA6', size/2, size/2 + size*0.04);

  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(path.join(__dirname, '..', 'assets', filename), buf);
  console.log('Created', filename, buf.length, 'bytes');
}

makeAppIcon(512, 'icon-512.png');
makeAppIcon(1024, 'icon-1024.png');
makeAppIcon(256, 'icon-256.png');
makeAppIcon(128, 'icon-128.png');
makeTrayIcon(16, 'tray-iconTemplate.png');
makeTrayIcon(32, 'tray-iconTemplate@2x.png');
makeTrayIcon(22, 'tray-icon.png');
console.log('All icons generated!');
