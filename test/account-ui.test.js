'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'src/renderer/settings/index.html'), 'utf8');
const script = fs.readFileSync(path.join(ROOT, 'src/renderer/settings/script.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src/renderer/settings/style.css'), 'utf8');

test('account console keeps the daily reward and plans shortcut contract', () => {
  assert.match(html, /class="account-console"/);
  assert.match(html, /每个自然日可领取 1 积分，次日自动刷新/);
  assert.match(html, /id="btnJumpToPlans"/);
  assert.match(html, /id="plansSection"/);
  assert.match(script, /plans\.scrollIntoView/);
  assert.match(script, /plans-section-highlight/);
});

test('model picker is responsive and fully keyboard operable', () => {
  assert.match(css, /\.model-picker-list\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,/);
  assert.match(css, /@media \(max-width:\s*680px\)[\s\S]*\.model-picker-list\s*\{\s*grid-template-columns:\s*1fr/);
  assert.match(css, /\.model-row:focus-visible/);
  assert.match(script, /setAttribute\('role', 'button'\)/);
  assert.match(script, /setAttribute\('aria-disabled'/);
  assert.match(script, /setAttribute\('aria-pressed'/);
  assert.match(script, /row\.addEventListener\('keydown'/);
  assert.match(script, /event\.key !== 'Enter' && event\.key !== ' '/);
});
