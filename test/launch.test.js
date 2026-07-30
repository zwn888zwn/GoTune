'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { launchTargetIdentity, withProfilerBuildFlags } = require('../out/launch');

test('adds profiler flags without mutating a launch configuration', () => {
  const configuration = { name: 'Server', type: 'go', buildFlags: '-race' };
  const result = withProfilerBuildFlags(configuration, ['-overlay=/tmp/overlay.json']);

  assert.equal(result.buildFlags, '-race -overlay=/tmp/overlay.json');
  assert.equal(configuration.buildFlags, '-race');
});

test('preserves array build flags used by generated configurations', () => {
  const result = withProfilerBuildFlags(
    { name: 'Server', buildFlags: ['-tags=dev'] },
    ['-overlay=/tmp/overlay.json', '-tags=netgo']
  );

  assert.deepEqual(result.buildFlags, [
    '-tags=dev',
    '-overlay=/tmp/overlay.json',
    '-tags=netgo'
  ]);
});

test('builds a stable launch target identity', () => {
  assert.equal(
    launchTargetIdentity('/workspace/server', 'VPN Server'),
    'launch:/workspace/server:VPN Server'
  );
});
