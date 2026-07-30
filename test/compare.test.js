'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { compareProfiles } = require('../out/compare');

function session(name, total, hotspots) {
  return {
    id: name,
    name,
    source: name,
    importedAt: 0,
    sampleType: 'cpu',
    sampleUnit: 'nanoseconds',
    total,
    hotspots: hotspots.map(([functionName, cumulative]) => ({
      id: functionName,
      name: functionName,
      flat: cumulative,
      cumulative,
      location: { file: '/workspace/main.go', line: 10 }
    })),
    callTree: [],
    lineMetrics: []
  };
}

test('compares matching, new, and removed hotspots', () => {
  const result = compareProfiles(
    session('before', 100, [['main.hot', 80], ['main.removed', 20]]),
    session('after', 80, [['main.hot', 50], ['main.new', 30]])
  );

  assert.equal(result.totalDelta, -20);
  assert.equal(result.totalDeltaPercent, -20);
  assert.equal(result.warnings.length, 2);
  assert.deepEqual(
    result.entries.map((entry) => [entry.name, entry.before, entry.after, entry.delta]),
    [
      ['main.hot', 80, 50, -30],
      ['main.new', 0, 30, 30],
      ['main.removed', 20, 0, -20]
    ]
  );
});

test('rejects profiles with different sample semantics', () => {
  const before = session('before', 100, []);
  const after = { ...session('after', 100, []), sampleType: 'alloc_space', sampleUnit: 'bytes' };
  assert.throws(() => compareProfiles(before, after), /Cannot compare/);
});

test('rejects CPU profiles captured for different durations', () => {
  const before = { ...session('before', 100, []), target: 'example/app', captureDurationMs: 10_000 };
  const after = { ...session('after', 100, []), target: 'example/app', captureDurationMs: 30_000 };
  assert.throws(() => compareProfiles(before, after), /capture durations/);
});

test('rejects raw cumulative allocation comparisons', () => {
  const before = { ...session('before', 100, []), sampleType: 'alloc_space', sampleUnit: 'bytes' };
  const after = { ...session('after', 100, []), sampleType: 'alloc_space', sampleUnit: 'bytes' };
  assert.throws(() => compareProfiles(before, after), /not a reliable before\/after benchmark/);
});

test('allows equal-duration allocation delta profiles from the same scenario', () => {
  const metadata = {
    sampleType: 'alloc_space',
    sampleUnit: 'bytes',
    captureMode: 'delta',
    captureDurationMs: 10_000,
    target: 'example/app',
    scenarioId: 'load-test'
  };
  const before = { ...session('before', 100, [['main.hot', 80]]), ...metadata };
  const after = { ...session('after', 70, [['main.hot', 50]]), ...metadata };

  assert.equal(compareProfiles(before, after).entries[0].delta, -30);
});
