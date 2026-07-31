'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  profileRuntimeMetrics,
  runtimeMetricsBetween
} = require('../out/scenarioRuntimeMetrics');

test('derives allocation rate, heap change, and GC costs for a scenario run', () => {
  const metrics = runtimeMetricsBetween(
    {
      timestamp: 1000,
      heapAlloc: 100,
      heapObjects: 10,
      totalAlloc: 1000,
      numGC: 2,
      pauseTotalNs: 50,
      goroutines: 4
    },
    {
      timestamp: 3000,
      heapAlloc: 160,
      heapObjects: 14,
      totalAlloc: 1400,
      numGC: 5,
      pauseTotalNs: 90,
      goroutines: 4
    }
  );

  assert.equal(metrics.runtime_alloc_bytes, 400);
  assert.equal(metrics.runtime_alloc_rate_bytes_per_s, 200);
  assert.equal(metrics.heap_alloc_change_bytes, 60);
  assert.equal(metrics.gc_cycles, 3);
  assert.equal(metrics.gc_pause_ns, 40);
});

test('extracts comparable pprof totals by evidence semantics', () => {
  const base = {
    id: 'id',
    name: 'capture',
    importedAt: 1,
    sampleUnit: 'nanoseconds',
    target: 'target',
    hotspots: [],
    callTree: [],
    lineMetrics: []
  };
  const metrics = profileRuntimeMetrics([
    { ...base, source: '/debug/pprof/profile', sampleType: 'cpu', total: 20 },
    { ...base, source: '/debug/pprof/allocs', sampleType: 'alloc_space', total: 30 },
    { ...base, source: '/debug/pprof/allocs', sampleType: 'alloc_objects', total: 4 },
    { ...base, source: '/debug/pprof/mutex', sampleType: 'delay', total: 50 },
    { ...base, source: '/debug/pprof/block', sampleType: 'delay', total: 60 }
  ]);

  assert.deepEqual(metrics, {
    cpu_sample_ns: 20,
    alloc_bytes: 30,
    alloc_objects: 4,
    mutex_wait_ns: 50,
    block_wait_ns: 60
  });
});
