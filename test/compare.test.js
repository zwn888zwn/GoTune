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
