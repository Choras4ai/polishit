'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CircuitBreaker } = require('../server/middleware/circuit-breaker');

test('half-open state allows only one probe at a time', () => {
  const breaker = new CircuitBreaker({
    windowSize: 1,
    failureThreshold: 0,
    latencyThreshold: 10_000,
    openDurationMs: 0,
  });

  breaker.recordFailure(25);

  const firstProbe = breaker.canRequest();
  assert.equal(firstProbe.allowed, true);
  assert.equal(firstProbe.state, 'half_open');

  const secondProbe = breaker.canRequest();
  assert.equal(secondProbe.allowed, false);
  assert.equal(secondProbe.state, 'half_open');

  breaker.recordSuccess(20);

  const afterRecovery = breaker.canRequest();
  assert.equal(afterRecovery.allowed, true);
  assert.equal(afterRecovery.state, 'closed');
});

test('failed probe reopens breaker and clears in-flight flag', () => {
  const breaker = new CircuitBreaker({
    windowSize: 1,
    failureThreshold: 0,
    latencyThreshold: 10_000,
    openDurationMs: 0,
  });

  breaker.recordFailure(25);
  assert.equal(breaker.canRequest().allowed, true);
  breaker.recordFailure(30);

  const status = breaker.getStatus();
  assert.equal(status.state, 'open');
  assert.equal(status.probeInFlight, false);
});
