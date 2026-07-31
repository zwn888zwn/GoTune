'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { collectFunctionEvidence, findFunctionHotspot } = require('../out/functionEvidence');

const fn = {
  name: 'work',
  file: '/workspace/main.go',
  startLine: 8,
  endLine: 18
};

function session(id, sampleType, self, cumulative) {
  return {
    id,
    name: id,
    source: `/tmp/${id}`,
    importedAt: 1,
    sampleType,
    sampleUnit: sampleType === 'cpu' ? 'nanoseconds' : 'bytes',
    total: 100,
    hotspots: [{
      id: 'work-id',
      name: 'main.work',
      flat: self,
      cumulative,
      location: { file: '/workspace/main.go', line: 10 }
    }],
    callTree: [{
      id: 'caller-id',
      name: 'main.caller',
      value: cumulative,
      location: { file: '/workspace/main.go', line: 20 },
      children: [{
        id: 'work-id',
        name: 'main.work',
        value: cumulative,
        location: { file: '/workspace/main.go', line: 10 },
        children: [{
          id: 'callee-id',
          name: 'main.callee',
          value: cumulative / 2,
          location: { file: '/workspace/helper.go', line: 4 },
          children: []
        }]
      }]
    }],
    lineMetrics: []
  };
}

test('combines CPU and allocation evidence for the current function', () => {
  const report = collectFunctionEvidence(fn, [
    session('cpu-current', 'cpu', 20, 50),
    session('alloc-current', 'alloc_space', 30, 70)
  ]);

  assert.deepEqual(report.availableKinds, ['cpu', 'allocation']);
  assert.equal(report.items[0].selfPercent, 20);
  assert.equal(report.items[0].primaryCaller.name, 'main.caller');
  assert.equal(report.items[0].primaryCallees[0].name, 'main.callee');
  assert.equal(report.items[1].cumulative, 70);
});

test('calculates a matching baseline delta', () => {
  const baseline = session('cpu-before', 'cpu', 20, 60);
  const current = session('cpu-after', 'cpu', 10, 40);
  const report = collectFunctionEvidence(fn, [current, baseline], baseline.id);

  assert.equal(report.items[0].baselineDelta, -20);
  assert.ok(Math.abs(report.items[0].baselineDeltaPercent - (-100 / 3)) < 1e-9);
  assert.equal(report.items[1].baselineDelta, undefined);
});

test('selects the matching metric from investigation baselines', () => {
  const cpuBaseline = session('cpu-before', 'cpu', 20, 60);
  const allocBaseline = session('alloc-before', 'alloc_space', 10, 50);
  const allocCurrent = session('alloc-after', 'alloc_space', 10, 25);
  allocBaseline.captureMode = 'delta';
  allocCurrent.captureMode = 'delta';
  const report = collectFunctionEvidence(
    fn,
    [allocCurrent, cpuBaseline, allocBaseline],
    [cpuBaseline.id, allocBaseline.id]
  );

  assert.equal(report.items[0].baselineDelta, -25);
});

test('falls back to the Go symbol name when source paths are unavailable', () => {
  const profile = session('cpu', 'cpu', 10, 20);
  profile.hotspots[0].location = undefined;

  assert.equal(findFunctionHotspot(fn, profile).name, 'main.work');
});

test('combines source findings such as goroutine growth with profile evidence', () => {
  const report = collectFunctionEvidence(
    fn,
    [session('cpu', 'cpu', 10, 20)],
    undefined,
    {},
    [{
      id: 'goroutine-growth',
      investigationId: 'investigation',
      kind: 'goroutine',
      severity: 'suspicious',
      title: '12 goroutines stay in chan send',
      detail: 'The same stack remained for three captures.',
      functionName: 'main.work',
      location: { file: '/workspace/main.go', line: 12 },
      createdAt: 2
    }]
  );

  assert.deepEqual(report.availableKinds, ['cpu', 'goroutine']);
  assert.equal(report.findings[0].id, 'goroutine-growth');
});
