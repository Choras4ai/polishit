'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CommercialClient = require('../src/commercial/client');

function fixture() {
  const data = {
    'commercial.enabled': true, 'commercial.backendUrl': 'https://fixture.test',
    'commercial.preferredSource': 'hosted', 'commercial.authToken': 'fixture-token',
    'commercial.account': { loggedIn: true, userId: 'fixture-user', preferredSource: 'hosted' },
  };
  const config = { get: key => data[key], set: (key, value) => { data[key] = value; } };
  return { data, client: new CommercialClient(config) };
}

test('saving the request source returns the current preference and reopening preserves it', async () => {
  const { data, client } = fixture();
  const saved = await client.saveSettings({ preferredSource: 'direct' });
  assert.equal(data['commercial.preferredSource'], 'direct');
  assert.equal(saved.preferredSource, 'direct');
  assert.equal((await client.getStatus()).preferredSource, 'direct');
  assert.equal((await client.saveSettings({ preferredSource: 'hosted' })).preferredSource, 'hosted');
});

test('logout account defaults cannot change the request source selected in settings', async () => {
  const { client } = fixture();
  client._clearSession();
  const status = await client.getStatus();
  assert.equal(status.loggedIn, false);
  assert.equal(status.preferredSource, 'hosted');
});

test('status refresh preserves the locally selected source over stale server/account metadata', async () => {
  const { data, client } = fixture();
  data['commercial.preferredSource'] = 'direct';
  client._request = async endpoint => endpoint === '/api/auth/me'
    ? { user: { loggedIn: true, userId: 'fixture-user', preferredSource: 'hosted' } }
    : { plans: [] };
  const status = await client.getStatus({ refresh: true });
  assert.equal(status.preferredSource, 'direct');
  assert.equal((await client.getStatus()).preferredSource, 'direct');
});

test('expired sessions keep the selected source while reporting logged out', async () => {
  const { client } = fixture();
  client._request = async () => { throw Object.assign(new Error('fixture expired'), { status: 401 }); };
  const status = await client.getStatus({ refresh: true });
  assert.equal(status.loggedIn, false);
  assert.equal(status.preferredSource, 'hosted');
});

test('source changes while a profile refresh is pending remain authoritative after it resolves', async () => {
  const { client } = fixture();
  let resolveProfile;
  client._request = endpoint => endpoint === '/api/auth/me'
    ? new Promise(resolve => { resolveProfile = resolve; })
    : Promise.resolve({ plans: [] });
  const refreshing = client.getStatus({ refresh: true });
  await client.saveSettings({ preferredSource: 'direct' });
  resolveProfile({ user: { loggedIn: true, userId: 'fixture-user', preferredSource: 'hosted' } });
  assert.equal((await refreshing).preferredSource, 'direct');
  assert.equal((await client.getStatus()).preferredSource, 'direct');
});

test('cached account metadata cannot report a logged-in session without a token', async () => {
  const { data, client } = fixture();
  data['commercial.authToken'] = '';
  assert.equal((await client.getStatus()).loggedIn, false);
});

test('an expired pending refresh cannot restore the request source from before a settings change', async () => {
  const { client } = fixture();
  let rejectProfile;
  client._request = endpoint => endpoint === '/api/auth/me'
    ? new Promise((_resolve, reject) => { rejectProfile = reject; })
    : Promise.resolve({ plans: [] });
  const refreshing = client.getStatus({ refresh: true });
  await client.saveSettings({ preferredSource: 'direct' });
  rejectProfile(Object.assign(new Error('fixture expired'), { status: 401 }));
  const status = await refreshing;
  assert.equal(status.loggedIn, false);
  assert.equal(status.preferredSource, 'direct');
  assert.equal((await client.getStatus()).preferredSource, 'direct');
});
