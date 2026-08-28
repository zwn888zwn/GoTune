'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createTraceSummary } = require('../out/traceSummary');

test('summarizes trace delay and keeps the true top aggregate path', () => {
  const session = {
    id: 'sync',
    name: 'sync',
    source: 'trace:sync',
    importedAt: 1,
    sampleType: 'delay',
    sampleUnit: 'nanoseconds',
    total: 4_000_000_000,
    hotspots: [
      { id: 'runtime', name: 'runtime.gopark', flat: 0, cumulative: 4_000_000_000 },
      {
        id: 'app',
        name: 'main.wait',
        flat: 0,
        cumulative: 3_000_000_000,
        location: { file: '/workspace/main.go', line: 12 }
      }
    ],
    callTree: [],
    lineMetrics: []
  };
  const summary = createTraceSummary(1000, [{ kind: 'sync', session }]);

  assert.equal(summary.captureDurationMs, 1000);
  assert.equal(summary.entries[0].total, 4_000_000_000);
  assert.equal(summary.entries[0].top.name, 'runtime.gopark');
  assert.equal(summary.entries[0].top.percent, 100);
});
