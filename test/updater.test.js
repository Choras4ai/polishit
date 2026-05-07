'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  compareVersions,
  normalizeVersion,
  parseGitHubRepository,
  parseManifestUrl,
  trimReleaseNotes,
} = require('../src/updater');

test('normalizeVersion removes leading v', () => {
  assert.equal(normalizeVersion('v1.5.0'), '1.5.0');
  assert.equal(normalizeVersion('1.5.1'), '1.5.1');
});

test('compareVersions sorts semantic versions correctly', () => {
  assert.equal(compareVersions('1.5.1', '1.5.0') > 0, true);
  assert.equal(compareVersions('1.5.0', '1.5.0'), 0);
  assert.equal(compareVersions('1.4.9', '1.5.0') < 0, true);
  assert.equal(compareVersions('1.5.0', '1.5.0-beta.1') > 0, true);
});

test('parseGitHubRepository reads owner and repo from package metadata', () => {
  const parsed = parseGitHubRepository({
    repository: {
      type: 'git',
      url: 'https://github.com/nicecho/runshi.git',
    },
  });

  assert.deepEqual(parsed, { owner: 'nicecho', repo: 'runshi' });
});

test('parseManifestUrl derives version.json from homepage', () => {
  const parsed = parseManifestUrl({
    homepage: 'https://nicecho.github.io/runshi/',
  });

  assert.equal(parsed, 'https://nicecho.github.io/runshi/version.json');
});

test('trimReleaseNotes keeps the first non-empty lines only', () => {
  const result = trimReleaseNotes(`

  ## 更新内容

  - 修复浮窗定位
  - 增加版本检查

  - 优化设置页
  - 调整会员状态
  - 清理旧逻辑
  - 第七行
  - 第八行
  `);

  assert.match(result, /修复浮窗定位/);
  assert.equal(result.includes('第八行'), false);
});
