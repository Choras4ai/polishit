'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { minimatch } = require('minimatch');

const ROOT = path.join(__dirname, '..');
const SERVER_ENTRY = path.join(ROOT, 'server', 'index.js');
const PACKAGE_JSON = path.join(ROOT, 'package.json');

const { assertPaymentProviderAllowed } = require('../server/commercial/payments');

function routeSource(source, method, route) {
  const marker = `app.${method}('${route}'`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${method.toUpperCase()} ${route} route must exist`);

  const nextRoute = source.indexOf('\n  app.', start + marker.length);
  return source.slice(start, nextRoute === -1 ? source.length : nextRoute);
}

function matchesFilteredPath(relativePath, filters) {
  const patterns = Array.isArray(filters) ? filters : [];
  const options = { dot: true, nocase: false };
  const positivePatterns = patterns.filter((pattern) => (
    typeof pattern === 'string' && !pattern.startsWith('!')
  ));
  const negativePatterns = patterns.filter((pattern) => (
    typeof pattern === 'string' && pattern.startsWith('!')
  ));

  const included = positivePatterns.length === 0
    || positivePatterns.some((pattern) => minimatch(relativePath, pattern, options));
  const excluded = negativePatterns.some((pattern) => (
    minimatch(relativePath, pattern.slice(1), options)
  ));
  return included && !excluded;
}

test('manual payment cannot bypass online payment mode', () => {
  assert.throws(
    () => assertPaymentProviderAllowed(
      { paymentMode: 'online' },
      'manual',
      ['wechatpay'],
    ),
    (err) => err?.status === 403,
  );

  assert.doesNotThrow(() => assertPaymentProviderAllowed(
    { paymentMode: 'manual' },
    'manual',
    [],
  ));
});

test('online payment requires online mode and a ready provider', () => {
  assert.throws(
    () => assertPaymentProviderAllowed(
      { paymentMode: 'manual' },
      'wechatpay',
      ['wechatpay'],
    ),
    (err) => err?.status === 403,
  );

  assert.throws(
    () => assertPaymentProviderAllowed(
      { paymentMode: 'online' },
      'wechatpay',
      [],
    ),
    (err) => err?.status === 503,
  );

  assert.doesNotThrow(() => assertPaymentProviderAllowed(
    { paymentMode: 'online' },
    'wechatpay',
    ['wechatpay'],
  ));
});

test('both membership endpoints enforce the centralized provider policy', () => {
  const source = fs.readFileSync(SERVER_ENTRY, 'utf8');
  const subscribeRoute = routeSource(source, 'post', '/api/membership/subscribe');
  const createOrderRoute = routeSource(source, 'post', '/api/pay/create-order');

  assert.match(
    subscribeRoute,
    /assertPaymentProviderAllowed\s*\(\s*config\s*,\s*['"]manual['"]/,
    'direct membership subscription must enforce manual-mode policy',
  );
  assert.match(
    createOrderRoute,
    /assertPaymentProviderAllowed\s*\(\s*config\s*,\s*provider\b/,
    'order creation must validate the user-supplied provider',
  );

  const policyCheck = createOrderRoute.indexOf('assertPaymentProviderAllowed');
  const manualBranch = createOrderRoute.indexOf("if (provider === 'manual')");
  assert.ok(
    policyCheck !== -1 && manualBranch !== -1 && policyCheck < manualBranch,
    'provider policy must run before the manual fulfillment branch',
  );
  assert.doesNotMatch(
    `${subscribeRoute}\n${createOrderRoute}`,
    /isLoopbackIp|req\.ip/,
    'loopback requests must not bypass payment authorization',
  );
});

test('electron-builder excludes server payment keys and dotenv files', () => {
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  const build = packageJson.build || {};
  const extraResources = Array.isArray(build.extraResources) ? build.extraResources : [];
  const serverResource = extraResources.find((entry) => (
    entry
    && typeof entry === 'object'
    && path.normalize(String(entry.from || '')) === 'server'
  ));

  assert.ok(serverResource, 'server extraResources entry must use an auditable filter');
  assert.ok(
    matchesFilteredPath('index.js', serverResource.filter),
    'normal server runtime files must still be packaged',
  );

  const secretPaths = [
    'keys/apiclient_key.pem',
    'keys/wechatpay_pub_key.pem',
    'keys/private.key',
    '.env',
    '.env.production',
    'certificates/private.pem',
    'certificates/private.p12',
    'certificates/private.pfx',
  ];
  for (const secretPath of secretPaths) {
    assert.equal(
      matchesFilteredPath(secretPath, serverResource.filter),
      false,
      `${secretPath} must not be copied into app resources`,
    );
  }

  const appFiles = Array.isArray(build.files) ? build.files : [];
  assert.equal(
    matchesFilteredPath('server/keys/apiclient_key.pem', appFiles),
    false,
    'the main app files list must not re-include server payment keys',
  );
});
