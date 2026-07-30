'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { analyzeMemoryTrend } = require('../out/memoryTrend');

function heap(name, total, values) {
  return {
    id: name,
    name,
    source: name,
    importedAt: 0,
    sampleType: 'inuse_space',
    sampleUnit: 'bytes',
    total,
    hotspots: Object.entries(values).map(([functionName, flat], index) => ({
      id: String(index),
      name: functionName,
      flat,
      cumulative: flat,
      location: { file: `/workspace/${index}.go`, line: 10 }
    })),
    callTree: [],
    lineMetrics: []
  };
}

test('separates persistent memory growth from fluctuating allocations', () => {
  const trend = analyzeMemoryTrend([
    heap('baseline', 100, { 'app.leak': 10, 'app.cache': 30 }),
    heap('round1', 140, { 'app.leak': 30, 'app.cache': 20 }),
    heap('round2', 180, { 'app.leak': 60, 'app.cache': 40 })
  ]);

  assert.equal(trend.totalGrowth, 80);
  assert.equal(trend.entries[0].name, 'app.leak');
  assert.equal(trend.entries[0].growth, 50);
  assert.equal(trend.entries[0].consistentlyGrowing, true);
  assert.equal(
    trend.entries.find((entry) => entry.name === 'app.cache').consistentlyGrowing,
    false
  );
});
