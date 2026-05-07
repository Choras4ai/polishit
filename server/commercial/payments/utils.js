'use strict';

const fs = require('fs');
const path = require('path');

function readConfigText(rootDir, inlineValue, filePath) {
  if (inlineValue) {
    return String(inlineValue).replace(/\\n/g, '\n').trim();
  }
  if (!filePath) return '';
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath);
  if (!fs.existsSync(resolved)) return '';
  return fs.readFileSync(resolved, 'utf8').trim();
}

module.exports = {
  readConfigText,
};
