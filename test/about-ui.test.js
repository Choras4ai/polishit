'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

test('about page introduces NEO LAB and opens its website through the shared link', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/renderer/settings/index.html'), 'utf8');
  const script = fs.readFileSync(path.join(ROOT, 'src/renderer/settings/script.js'), 'utf8');

  assert.match(html, /三步完成一次可靠润色/);
  assert.match(html, /波江座人工智能实验室/);
  assert.match(html, /href="https:\/\/www\.runshi\.top\/lab\/"/);
  assert.match(script, /openExternal\(e\.currentTarget\.href\)/);
  assert.doesNotMatch(`${html}\n${script}`, /xiaohongshu|小红书/i);
  assert.doesNotMatch(html, /about-demo-popup|about-demo-toolbar/);
});
