'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildProfileUrl } = require('../out/profileUrl');

test('builds profile URLs from server roots and pprof roots', () => {
  assert.equal(
    buildProfileUrl('http://127.0.0.1:6060', 'profile?seconds=10'),
    'http://127.0.0.1:6060/debug/pprof/profile?seconds=10'
  );
  assert.equal(
    buildProfileUrl('http://127.0.0.1:6060/debug/pprof/', 'heap'),
    'http://127.0.0.1:6060/debug/pprof/heap'
  );
});

test('preserves direct profile URLs', () => {
  assert.equal(
    buildProfileUrl('http://127.0.0.1:6060/debug/pprof/allocs?gc=1', ''),
    'http://127.0.0.1:6060/debug/pprof/allocs?gc=1'
  );
});

test('preserves authentication query parameters when adding an endpoint', () => {
  assert.equal(
    buildProfileUrl('http://127.0.0.1:6060/debug/pprof/?token=secret', 'profile?seconds=15'),
    'http://127.0.0.1:6060/debug/pprof/profile?token=secret&seconds=15'
  );
});

test('builds the protected GoTune runtime metrics endpoint', () => {
  assert.equal(
    buildProfileUrl('http://127.0.0.1:6060/debug/pprof/?token=secret', '../gotune/runtime'),
    'http://127.0.0.1:6060/debug/gotune/runtime?token=secret'
  );
});
