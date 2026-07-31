'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  addCaptureToInvestigation,
  addFindingsToInvestigation,
  createInvestigation,
  evidenceKind,
  findingsFromComparison,
  findingsFromGoroutines,
  findingsFromMemoryTrend,
  problemForSampleType,
  rankFindings
} = require('../out/investigation');

function session(sampleType = 'cpu') {
  return {
    id: `${sampleType}-capture`,
    name: sampleType,
    source: '/tmp/profile',
    importedAt: 1,
    sampleType,
    sampleUnit: sampleType === 'cpu' ? 'nanoseconds' : 'bytes',
    total: 100,
    target: 'example/app',
    hotspots: [{
      id: '1',
      name: 'main.work',
      flat: 60,
      cumulative: 80,
      location: { file: '/workspace/main.go', line: 10 }
    }],
    callTree: [],
    lineMetrics: []
  };
}

test('creates an investigation and turns capture insights into findings', () => {
  const investigation = createInvestigation('cpu', undefined, 100);
  const updated = addCaptureToInvestigation(investigation, session(), 200);

  assert.equal(updated.target, 'example/app');
  assert.deepEqual(updated.captureIds, ['cpu-capture']);
  assert.equal(updated.findings[0].kind, 'cpu');
  assert.equal(updated.findings[0].functionName, 'main.work');
  assert.equal(updated.updatedAt, 200);
});

test('replaces findings when the same capture is attached again', () => {
  const investigation = createInvestigation('cpu', 'example/app', 100);
  const once = addCaptureToInvestigation(investigation, session(), 200);
  const twice = addCaptureToInvestigation(once, session(), 300);

  assert.equal(twice.captureIds.length, 1);
  assert.equal(twice.findings.length, once.findings.length);
});

test('maps profile metrics to evidence and problem kinds', () => {
  assert.equal(evidenceKind('alloc_space'), 'allocation');
  assert.equal(evidenceKind('inuse_space'), 'live-memory');
  assert.equal(evidenceKind('delay'), 'blocking');
  assert.equal(evidenceKind('goroutine'), 'goroutine');
  assert.equal(problemForSampleType('cpu'), 'cpu');
  assert.equal(problemForSampleType('alloc_objects'), 'allocations');
});

test('creates source findings from persistent memory growth', () => {
  const findings = findingsFromMemoryTrend('investigation', {
    sessions: [],
    totals: [100, 150, 200],
    totalGrowth: 100,
    entries: [{
      key: 'main.leak',
      name: 'main.leak',
      values: [10, 30, 60],
      growth: 50,
      consistentlyGrowing: true,
      location: { file: '/workspace/main.go', line: 12 }
    }]
  }, 500);

  assert.equal(findings[0].severity, 'suspicious');
  assert.equal(findings[0].location.line, 12);
  assert.match(findings[0].detail, /50 B growth/);
});

test('creates a suspicious source finding from stable blocked goroutines', () => {
  const findings = findingsFromGoroutines('investigation', {
    capturedAt: 1,
    total: 8,
    stateCount: 1,
    suspiciousCount: 8,
    totalDelta: 2,
    groups: [{
      signature: 'chan send',
      state: 'chan send',
      count: 8,
      countDelta: 2,
      topFunction: 'main.submit',
      frames: [{ functionName: 'main.submit', file: '/workspace/main.go', line: 20 }],
      representative: '',
      stableCaptures: 3,
      severity: 'suspicious',
      explanation: 'The same stack remained blocked.'
    }]
  }, 600);

  assert.equal(findings[0].severity, 'suspicious');
  assert.equal(findings[0].location.line, 20);
  const investigation = createInvestigation('blocking', 'example/app', 100);
  const updated = addFindingsToInvestigation(investigation, findings, 'goroutine-', 700);
  assert.equal(updated.findings.length, 1);
});

test('maps goroutine findings to a workspace frame instead of runtime internals', () => {
  const findings = findingsFromGoroutines('investigation', {
    capturedAt: 1,
    total: 2,
    stateCount: 1,
    suspiciousCount: 2,
    totalDelta: 0,
    totalGrowth: 0,
    groups: [{
      signature: 'blocked',
      state: 'chan send',
      count: 2,
      countDelta: 0,
      countGrowth: 0,
      topFunction: 'runtime.chansend',
      frames: [
        { functionName: 'runtime.chansend', file: '/go/src/runtime/chan.go', line: 20 },
        { functionName: 'main.Submit', file: '/workspace/queue.go', line: 42 }
      ],
      representative: 'stack',
      stableCaptures: 3,
      severity: 'suspicious',
      explanation: 'stable'
    }]
  }, 2, (file) => file.startsWith('/workspace/'));

  assert.deepEqual(findings[0].location, { file: '/workspace/queue.go', line: 42 });
});

test('turns before-after profile changes into verification findings', () => {
  const findings = findingsFromComparison('investigation', {
    baseline: session('cpu'),
    current: { ...session('cpu'), id: 'after', name: 'after' },
    totalDelta: -20,
    totalDeltaPercent: -20,
    warnings: [],
    entries: [{
      key: 'main.work',
      name: 'main.work',
      before: 80,
      after: 50,
      delta: -30,
      deltaPercent: -37.5,
      location: { file: '/workspace/main.go', line: 10 }
    }]
  }, 800);

  assert.equal(findings[0].severity, 'verified');
  assert.match(findings[0].title, /Improved/);
});

test('ranks the optimization target and actionable source findings first', () => {
  const base = {
    investigationId: 'investigation',
    kind: 'cpu',
    detail: 'detail',
    createdAt: 1
  };
  const ranked = rankFindings([
    { ...base, id: 'info', severity: 'info', title: 'Info' },
    {
      ...base,
      id: 'watch',
      severity: 'watch',
      title: 'Watch',
      location: { file: '/workspace/main.go', line: 10 }
    },
    { ...base, id: 'target', severity: 'info', title: 'Target' }
  ], 'target');

  assert.deepEqual(ranked.map((finding) => finding.id), ['target', 'watch', 'info']);
});
