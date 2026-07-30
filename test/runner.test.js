'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAgentSource } = require('../out/agent');
const {
  isProcessTreeAlive,
  shouldCreateProcessGroup,
  signalProcessTree
} = require('../out/processTree');
const { traceViewerUrl } = require('../out/traceViewer');

test('generates an isolated token-protected pprof agent', () => {
  const source = createAgentSource('test-token');
  assert.match(source, /net\.Listen\("tcp", "127\.0\.0\.1:0"\)/);
  assert.match(source, /http\.NewServeMux\(\)/);
  assert.match(source, /r\.URL\.Query\(\)\.Get\("token"\) != token/);
  assert.match(source, /GOTUNE_PPROF=http:\/\/"/);
  assert.match(source, /\/debug\/gotune\/runtime/);
  assert.match(source, /runtime\.ReadMemStats/);
  assert.doesNotMatch(source, /DefaultServeMux/);
});

test('optionally enables mutex and block sampling', () => {
  const source = createAgentSource('test-token', true);
  assert.match(source, /runtime\.SetBlockProfileRate\(1\)/);
  assert.match(source, /runtime\.SetMutexProfileFraction\(1\)/);
});

test('runs Unix targets in a process group and signals the whole group', () => {
  const signals = [];
  const childSignals = [];
  const child = {
    pid: 4321,
    exitCode: null,
    signalCode: null,
    kill(signal) {
      childSignals.push(signal);
      return true;
    }
  };
  const killProcess = (pid, signal) => {
    signals.push([pid, signal]);
    return true;
  };

  assert.equal(shouldCreateProcessGroup('darwin'), true);
  assert.equal(signalProcessTree(child, 'SIGTERM', 'darwin', killProcess), true);
  assert.equal(isProcessTreeAlive(child, 'darwin', killProcess), true);
  assert.deepEqual(signals, [[-4321, 'SIGTERM'], [-4321, 0]]);
  assert.deepEqual(childSignals, []);
});

test('falls back to the direct child when a Unix process group no longer exists', () => {
  const childSignals = [];
  const child = {
    pid: 4321,
    exitCode: null,
    signalCode: null,
    kill(signal) {
      childSignals.push(signal);
      return true;
    }
  };
  const missingGroup = () => {
    const error = new Error('missing');
    error.code = 'ESRCH';
    throw error;
  };

  assert.equal(signalProcessTree(child, 'SIGTERM', 'darwin', missingGroup), true);
  assert.deepEqual(childSignals, ['SIGTERM']);
});

test('finds the localhost URL printed by go tool trace', () => {
  assert.equal(
    traceViewerUrl('Trace viewer is listening on http://127.0.0.1:41827\n'),
    'http://127.0.0.1:41827'
  );
});
